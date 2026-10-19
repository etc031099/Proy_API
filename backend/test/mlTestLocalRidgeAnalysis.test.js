'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createMlTestLocalRidgeAnalysis } = require('../src/services/mlTestLocalRidgeAnalysis');
const config = require('../src/config/v3Operational');
const fence = require('../src/services/mlTestFence');
const update = require('../src/services/forecastMlUpdateCoordinator');

const user = { _id: 'local-admin', role: 'admin', isActive: true, businessId: config.businessId };
const cycleId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-10-19T16:00:00.000Z');

function makeHarness({ workerResult = { status: 'NO_PENDING_WORK', trained: false, candidateCreated: false },
  state = null, activeAfter = { modelVersion: 1, trainedDataVersion: '83', dataCutoff: '2026-10-15' },
  controlOverrides = {}, envOverrides = {}, clientOverrides = {}, dbOverrides = {} } = {}) {
  const control = { businessId: config.businessId, state: 'TEST_ACTIVE',
    resetEpoch: mongoose.mongo.BSON.Long.fromString('5'), testCycleId: cycleId,
    activeCheckpointId: '22222222-2222-4222-8222-222222222222', ...controlOverrides };
  const reads = [];
  const client = { options: { hosts: [{ host: 'localhost', port: 27017 }], replicaSet: 'rs0', ...clientOverrides } };
  const db = { databaseName: 'inventory_billing', client,
    admin: () => ({ command: async () => ({ setName: 'rs0', isWritablePrimary: true,
      me: 'localhost:27017', hosts: ['localhost:27017'] }) }),
    collection: name => ({ findOne: async (filter, options) => {
      reads.push({ name, filter, options });
      if (name === 'mltestcontrols') return control;
      if (name === 'mltestcheckpoints') return control.activeCheckpointId === filter.checkpointId
        ? { status: 'READY' } : null;
      return null;
    } }), ...dbOverrides };
  const env = { NODE_ENV: 'test', ML_TEST_LOCAL_ENABLED: 'true',
    MONGODB_URI: 'mongodb://localhost:27017/inventory_billing?replicaSet=rs0',
    ML_TEST_LOCAL_EXPECTED_DATABASE: 'inventory_billing', MONGODB_REPLICA_SET: 'rs0', ...envOverrides };
  const calls = [];
  let activeReads = 0;
  const registry = { getActiveModelMetadata: async () => {
    activeReads += 1;
    return activeReads === 1 ? { modelVersion: 1, trainedDataVersion: 83n, dataCutoff: '2026-10-15' } : activeAfter;
  } };
  const service = createMlTestLocalRidgeAnalysis({ client, db, env, registry, now: () => now,
    workerFactory: () => ({ runEligible: async args => { calls.push({ args, epoch: fence.current() }); return workerResult; } }),
    State: { findOne: () => ({ lean: async () => state }) } });
  return { service, calls, reads, control, client, db, env };
}

function pendingState(reason) {
  const closedThrough = update.watermark(now);
  const mature = update.matureOrigin(closedThrough, 7);
  const previousMatureDate = new Date(`${mature}T00:00:00.000Z`);
  previousMatureDate.setUTCDate(previousMatureDate.getUTCDate() - 1);
  const row = { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays: 7,
    status: 'PENDING', latestDataVersion: '173', lastProcessedDataVersion: '83',
    observationsClosedThrough: closedThrough, initialMatureOrigin: mature, latestMatureOrigin: mature,
    lastTrainedMatureOrigin: reason === 'NOT_MATURE' ? mature : previousMatureDate.toISOString().slice(0, 10),
    lastDirtyAt: new Date(+now - 60 * 60_000), nextEligibleAt: new Date(+now - 30 * 60_000), lastAttemptAt: null };
  if (reason === 'DEBOUNCE_NOT_ELAPSED') row.nextEligibleAt = new Date(+now + 60_000);
  if (reason === 'COOLDOWN_ACTIVE') row.lastAttemptAt = new Date(+now - 60 * 60_000);
  return row;
}

test('accepts only 7d/14d and refuses to enter the worker for 1d', async () => {
  const { service, calls } = makeHarness();
  for (const horizonDays of [1, 8, '7']) await assert.rejects(service.execute({ user, horizonDays }), { code: 'ML_TEST_HORIZON_INVALID' });
  assert.equal(calls.length, 0);
});

test('fails closed for production, disabled/absent local flag, and Atlas URI', async () => {
  for (const envOverrides of [
    { NODE_ENV: 'production' }, { ML_TEST_LOCAL_ENABLED: 'false' },
    { ML_TEST_LOCAL_ENABLED: undefined },
    { MONGODB_URI: 'mongodb+srv://user:password@cluster.mongodb.net/inventory_billing?retryWrites=true' }
  ]) {
    const { service, calls } = makeHarness({ envOverrides });
    await assert.rejects(service.execute({ user, horizonDays: 7 }));
    assert.equal(calls.length, 0);
  }
});

test('requires authenticated active admin from the configured tenant and valid local DB/rs0', async () => {
  const badInputs = [
    { user: { ...user, role: 'user' } }, { user: { ...user, isActive: false } },
    { user: { ...user, businessId: 'OTHER-TENANT' } },
    { clientOverrides: { replicaSet: 'other' } },
    { envOverrides: { MONGODB_REPLICA_SET: 'other' } },
    { dbOverrides: { databaseName: 'other_database' } }
  ];
  for (const input of badInputs) {
    const { service, calls } = makeHarness(input);
    await assert.rejects(service.execute({ user: input.user || user, horizonDays: 7 }));
    assert.equal(calls.length, 0);
  }
});

test('requires TEST_ACTIVE, nonzero epoch, cycle id, and READY checkpoint', async () => {
  for (const controlOverrides of [{ state: 'NO_TEST' }, { resetEpoch: mongoose.mongo.BSON.Long.ZERO },
    { testCycleId: null }, { activeCheckpointId: null }]) {
    const { service, calls } = makeHarness({ controlOverrides });
    await assert.rejects(service.execute({ user, horizonDays: 7 }));
    assert.equal(calls.length, 0);
  }
});

test('delegates a valid horizon to the existing worker inside the captured local test epoch', async () => {
  const { service, calls, reads } = makeHarness({ workerResult: { status: 'NO_PENDING_WORK', trained: false,
    candidateCreated: false, availableOrigins: 0 } });
  const result = await service.execute({ user, horizonDays: 14 });
  assert.deepEqual(calls.map(row => row.args), [{ horizonDays: 14, leaseOwner: calls[0].args.leaseOwner }]);
  assert.equal(calls[0].epoch.state, 'TEST_ACTIVE'); assert.equal(calls[0].epoch.resetEpoch, '5');
  assert.equal(calls[0].epoch.testCycleId, cycleId);
  assert.equal(result.outcome, 'NO_PENDING_WORK'); assert.equal(result.requiredOrigins, 107);
  assert.equal(result.availableOrigins, 0); assert.equal(result.promoted, false);
  assert.equal(JSON.stringify(result).includes('mongodb://'), false);
  assert.equal(JSON.stringify(result).includes('artifactData'), false);
  assert.equal(reads.some(row => row.name === 'mltestcheckpoints'), true);
});

for (const reason of ['NOT_MATURE', 'DEBOUNCE_NOT_ELAPSED', 'COOLDOWN_ACTIVE']) {
  test(`${reason} is returned as a valid non-training result`, async () => {
    const { service, calls } = makeHarness({ workerResult: null, state: pendingState(reason) });
    const result = await service.execute({ user, horizonDays: 7 });
    assert.equal(result.outcome, reason); assert.equal(result.reasonCode, reason);
    assert.equal(result.trained, false); assert.equal(result.candidateCreated, false); assert.equal(result.promoted, false);
    assert.equal(calls.length, 1);
  });
}

test('NO_PENDING_WORK remains a valid result and does not imply training', async () => {
  const { service } = makeHarness({ workerResult: null, state: null });
  const result = await service.execute({ user, horizonDays: 14 });
  assert.equal(result.outcome, 'NO_PENDING_WORK');
  assert.equal(result.reasonCode, 'NO_PENDING_WORK');
  assert.equal(result.trained, false); assert.equal(result.candidateCreated, false); assert.equal(result.promoted, false);
});

test('promotion is true only when the worker reports PROMOTED and active registry version changed', async () => {
  const promoted = makeHarness({ workerResult: { status: 'PROMOTED', trained: true, candidateCreated: true,
    availableOrigins: 107, modelVersion: 2 }, activeAfter: { modelVersion: 2, trainedDataVersion: '174', dataCutoff: '2026-10-18' } });
  const result = await promoted.service.execute({ user, horizonDays: 7 });
  assert.equal(result.trained, true); assert.equal(result.candidateCreated, true); assert.equal(result.promoted, true);
  assert.equal(result.activeModelBefore.modelVersion, 1); assert.equal(result.activeModelAfter.modelVersion, 2);
  assert.equal(result.availableOrigins, 107);

  const unchanged = makeHarness({ workerResult: { status: 'PROMOTED', trained: false, candidateCreated: true, modelVersion: 1 } });
  assert.equal((await unchanged.service.execute({ user, horizonDays: 7 })).promoted, false);
});

test('does not leak connection strings or accept a stale epoch before worker execution', async () => {
  let controlRead = 0, workerCalls = 0;
  const harness = makeHarness({ workerResult: null });
  const originalCollection = harness.db.collection;
  harness.db.collection = name => {
    const collection = originalCollection(name);
    if (name !== 'mltestcontrols') return collection;
    return { findOne: async (...args) => {
      controlRead += 1;
      const row = await collection.findOne(...args);
      if (controlRead >= 3) return { ...row, resetEpoch: mongoose.mongo.BSON.Long.fromString('6'), testCycleId: '33333333-3333-4333-8333-333333333333' };
      return row;
    } };
  };
  const service = createMlTestLocalRidgeAnalysis({ client: harness.client, db: harness.db, env: harness.env,
    registry: { getActiveModelMetadata: async () => null }, State: { findOne: () => ({ lean: async () => null }) },
    workerFactory: () => ({ runEligible: async () => { workerCalls += 1; return null; } }) });
  await assert.rejects(service.execute({ user, horizonDays: 7 }), { code: 'STALE_TEST_EPOCH' });
  assert.equal(workerCalls, 0);
  assert.equal(JSON.stringify({ uri: harness.env.MONGODB_URI }).includes('password'), false);
});
