'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BSON } = require('mongoose').mongo;
const S = require('../src/services/mlTestCheckpointService');
const F = require('../src/services/mlTestFence');
const T = require('../src/services/mlTestTargetAuthorization');
const A = require('../src/services/mlTestAdminExecutor');
const config = require('../src/config/v3Operational');
const admin = { _id: 'real-session-admin-fixture', role: 'admin', isActive: true, businessId: config.businessId };
const req = { user: admin, body: {}, query: {} };
function cloudTarget() {
  const client = { options: { srvHost: 'fixture.mongodb.net' } };
  const db = { databaseName: 'demo_test', client };
  const env = { ML_TEST_CLOUD_RESTORE_ENABLED: 'true',
    FORECAST_CLOUD_MONGO_URI: 'mongodb+srv://fixture:fixture@fixture.mongodb.net/demo_test',
    FORECAST_CLOUD_EXPECTED_DATABASE: db.databaseName, FORECAST_CLOUD_EXPECTED_BUSINESS_ID: config.businessId,
    FORECAST_CLOUD_EXPECTED_SCENARIO_ID: config.scenarioId };
  const authorization = T.authorizeCloudTarget({ client, db, env, user: admin, certificationId: T.CERTIFICATION });
  return { client, db, env, authorization };
}

test('cloud capture cannot use localWritersPaused even with a valid target capability', async () => {
  const target = cloudTarget();
  target.db.collection = () => assert.fail('must reject before database access');
  for (const localWritersPaused of [false, true]) await assert.rejects(S.captureLocalCheckpoint({
    ...target, scope: config, localWritersPaused
  }), { code: 'CHECKPOINT_LOCAL_QUIESCENCE_REQUIRED' });
});

test('cloud executor delegates CREATE to operative capture and audits the resulting epoch', async () => {
  const target = cloudTarget(), audits = [];
  let control = { state: 'NO_TEST', resetEpoch: BSON.Long.ZERO, testCycleId: null };
  target.db.createCollection = async () => {};
  target.db.collection = name => ({
    createIndex: async () => {},
    findOne: async () => name === 'mltestcontrols' ? control : null,
    insertOne: async row => { audits.push({ ...row }); },
    updateOne: async (filter, change) => { Object.assign(audits.find(row => row.actionId === filter.actionId), change.$set); }
  });
  const original = S.captureOperationalCheckpoint;
  S.captureOperationalCheckpoint = async options => {
    assert.equal(options.db, target.db); assert.equal(options.localWritersPaused, false);
    control = { ...control, state: 'TEST_ACTIVE', resetEpoch: BSON.Long.ONE, testCycleId: 'cycle-fixture' };
    return { status: 'READY', checkpointId: 'checkpoint-fixture' };
  };
  try {
    const executor = A.createMlTestAdminExecutor({ ...target, certificationId: T.CERTIFICATION });
    assert.equal((await executor.execute(req, 'CREATE')).status, 'READY');
    assert.equal(audits.length, 1); assert.equal(audits[0].result, 'SUCCEEDED');
    assert.equal(audits[0].epoch, '1'); assert.equal(audits[0].actor, admin._id);
    assert.equal(audits[0].testCycleId, 'cycle-fixture');
  } finally { S.captureOperationalCheckpoint = original; }
});

test('writer drain is bounded and rejects changed ownership instead of assuming a pause', async () => {
  const control = { state: 'CHECKPOINT_CREATING', activeCheckpointId: 'id', resetEpoch: BSON.Long.ONE,
    testCycleId: 'cycle', activeWriterIds: ['writer'] };
  const db = { collection: () => ({ findOne: async () => control }) };
  await assert.rejects(F.drainWriters(db, control, { timeoutMs: 0 }), { code: 'CHECKPOINT_WRITER_DRAIN_TIMEOUT' });
  await assert.rejects(F.drainWriters(db, { ...control, activeCheckpointId: 'other' }), { code: 'CHECKPOINT_CONTROL_CONFLICT' });
  control.activeWriterIds = [];
  await F.drainWriters(db, control);
});

test('HTTP writer waits for finish; an aborted response retains a fail-closed durable blocker', async () => {
  const row = { state: 'NO_TEST', resetEpoch: BSON.Long.ZERO, testCycleId: null, activeWriterIds: [] };
  const db = { collection: () => ({ findOne: async () => row, updateOne: async (_filter, update) => {
    if (update.$addToSet) row.activeWriterIds.push(update.$addToSet.activeWriterIds);
    if (update.$pull) row.activeWriterIds = row.activeWriterIds.filter(id => id !== update.$pull.activeWriterIds);
    return { matchedCount: 1 };
  } }) };
  for (const event of ['finish', 'close']) {
    const response = new EventEmitter(); response.writableFinished = event === 'finish';
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const writer = F.withWriter(db, () => F.untilResponseFinished(response, entered));
    await started; assert.equal(row.activeWriterIds.length, 1);
    response.emit(event); await writer;
    assert.equal(row.activeWriterIds.length, event === 'finish' ? 0 : 1);
  }
});

test('checkpoint wins between writer read and admission CAS; the stale writer never runs (offline)', async () => {
  let control = { state: 'NO_TEST', resetEpoch: BSON.Long.ZERO, testCycleId: null };
  let entered, unblock, writerRan = false;
  const reachedAdmission = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const db = { collection: name => {
    assert.equal(name, 'mltestcontrols');
    return {
      findOne: async () => ({ ...control }),
      updateOne: async (filter, update) => {
        assert(update.$addToSet?.activeWriterIds);
        assert.equal(filter.state, 'NO_TEST'); assert.equal(String(filter.resetEpoch), '0'); assert.equal(filter.testCycleId, null);
        entered(); await gate;
        return { matchedCount: filter.state === control.state && String(filter.resetEpoch) === String(control.resetEpoch)
          && filter.testCycleId === control.testCycleId ? 1 : 0 };
      }
    };
  } };
  const writer = F.withWriter(db, () => { writerRan = true; }).then(
    () => ({ code: 'UNEXPECTED_SUCCESS' }), error => ({ code: error.code }));
  await reachedAdmission;
  // Emulate the competing atomic control transition AFTER the writer read,
  // before Mongo applies its conditional admission update.
  control = { state: 'CHECKPOINT_CREATING', resetEpoch: BSON.Long.ONE, testCycleId: 'new-cycle' };
  unblock(); assert.equal((await writer).code, 'TEST_RESTORE_BLOCKED'); assert.equal(writerRan, false);
});
