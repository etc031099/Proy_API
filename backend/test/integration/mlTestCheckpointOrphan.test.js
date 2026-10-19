'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MongoClient, BSON } = require('mongoose').mongo;
const S = require('../../src/services/mlTestCheckpointService');
const L = require('../../src/services/mlTestCheckpointLifecycle');
const A = require('../../src/services/mlTestAdminExecutor');
const M = require('../../src/services/mlTestCheckpointManifest');
const config = require('../../src/config/v3Operational');
const scope = M.authorizedScope();
const req = { user: { _id: 'session-local-admin', businessId: scope.businessId, role: 'admin', isActive: true }, body: {}, query: {} };
async function fixture(work) {
  const uri = new URL(process.env.MONGODB_TEST_URI); uri.pathname = `/ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`;
  const client = await new MongoClient(uri.href, { monitorCommands: true, serverSelectionTimeoutMS: 4000 }).connect(), db = client.db();
  try {
    S.assertLocalTarget(client, db); await S.provisionLocal(client, db);
    for (const { collection } of M.COLLECTIONS) await db.createCollection(collection);
    const admin = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION', auditDenied: () => {} });
    await db.collection('products').insertOne({ businessId: scope.businessId, sku: 'TEST-SKU', stock: 12 });
    const checkpointId = randomUUID(), created = Date.now() - 500000;
    const cp = { ...scope, checkpointId, status: 'CREATING', readyAt: null, captureProtocolVersion: S.CAPTURE_PROTOCOL,
      capturedAt: new Date(created), updatedAt: new Date(created), createdAt: new Date(created),
      ...L.ownership(created, 240000), totalBytes: 3, totalChunks: 1, hashes: { manifest: 'preserved' } };
    await db.collection('mltestcheckpoints').insertOne(cp);
    await db.collection('mltestcheckpointchunks').insertOne({ checkpointId, collection: 'products', chunkIndex: 0, payload: Buffer.from('abc'), byteCount: 3 });
    const control = { businessId: scope.businessId, state: 'CHECKPOINT_CREATING', activeCheckpointId: checkpointId,
      testCycleId: randomUUID(), resetEpoch: BSON.Long.fromNumber(5), updatedAt: new Date(created), activeWriterIds: [] };
    await db.collection('mltestcontrols').insertOne(control);
    await work({ client, db, admin, cp, control });
  } finally { S.assertLocalTarget(client, db); await db.dropDatabase(); await client.close(); }
}
test('active captures cannot abort; orphan CAS recovers once, keeps metadata/audit and fences late writers', async () => fixture(async ({ client, db, admin, cp, control }) => {
  const cps = db.collection('mltestcheckpoints'), controls = db.collection('mltestcontrols');
  await cps.updateOne({ checkpointId: cp.checkpointId }, { $set: { captureHeartbeatAt: new Date() } });
  await assert.rejects(admin.execute(req, 'ABORT_STALE_CHECKPOINT'), { code: 'CHECKPOINT_CAPTURE_NOT_STALE' });
  await cps.updateOne({ checkpointId: cp.checkpointId }, { $set: { captureHeartbeatAt: cp.captureHeartbeatAt } });
  await controls.updateOne({ businessId: scope.businessId }, { $set: { activeWriterIds: ['writer'] } });
  await assert.rejects(admin.execute(req, 'ABORT_STALE_CHECKPOINT'), { code: 'CHECKPOINT_RECOVERY_WRITERS_PRESENT' });
  await controls.updateOne({ businessId: scope.businessId }, { $set: { activeWriterIds: [] } });
  const attempts = await Promise.allSettled([admin.execute(req, 'ABORT_STALE_CHECKPOINT'), admin.execute(req, 'ABORT_STALE_CHECKPOINT')]);
  assert.equal(attempts.filter(row => row.status === 'fulfilled' && !row.value.idempotent).length, 1);
  const state = await admin.execute(req, 'STATUS');
  assert.equal(state.state, 'NO_TEST'); assert.equal(state.resetEpoch, '6'); assert.equal(state.maintenance, false);
  assert.equal(state.activeCheckpointId, null); assert.equal(state.quiescence.writersPaused, false); assert.equal(state.quiescence.activeWriterCount, 0);
  const saved = await cps.findOne({ checkpointId: cp.checkpointId });
  assert.equal(saved.failureCode, 'CHECKPOINT_STALE_ABORTED'); assert.equal(saved.status, 'FAILED');
  assert.deepEqual(saved.hashes, cp.hashes); assert(saved.abandonedAt);
  const replay = await admin.execute(req, 'ABORT_STALE_CHECKPOINT'); assert.equal(replay.idempotent, true); assert.equal(replay.resetEpoch, '6');
  assert.equal(await db.collection('mltestadminaudits').countDocuments({ action: 'ABORT_STALE_CHECKPOINT', result: 'SUCCEEDED', idempotent: false }), 1);
  await assert.rejects(L.writeChunk({ client, db, control, checkpoint: cp, collection: 'products', chunk: {
    chunkIndex: 1, payload: Buffer.from('late'), byteCount: 4 }, timeoutMS: 5000 }), { code: 'CHECKPOINT_CAPTURE_OWNERSHIP_LOST' });
  assert.equal(await db.collection('mltestcheckpointchunks').countDocuments({ checkpointId: cp.checkpointId }), 1);
  assert.equal((await db.collection('products').findOne({ sku: 'TEST-SKU' })).stock, 12);
}));
test('legacy CREATING uses hard 300s + 120s grace; no stale inference from a finished HTTP response', async () => fixture(async ({ db, admin, cp }) => {
  await db.collection('mltestcheckpoints').updateOne({ checkpointId: cp.checkpointId }, { $unset: {
    captureOwnershipVersion: '', captureOwnerNonce: '', captureDeadlineAt: '', captureHeartbeatAt: '', captureLeaseUntil: '', capturePhase: '' } });
  const result = await admin.execute(req, 'ABORT_STALE_CHECKPOINT'); assert.equal(result.status, 'STALE_CHECKPOINT_ABORTED');
}));
test('storage report is read-only; purge removes only never-READY unreferenced payload, preserving hashes and audit', async () => fixture(async ({ client, db, admin, cp }) => {
  await admin.execute(req, 'ABORT_STALE_CHECKPOINT');
  const cps = db.collection('mltestcheckpoints'), chunks = db.collection('mltestcheckpointchunks');
  const blocked = [];
  for (const fields of [{ status: 'READY', readyAt: new Date() }, { status: 'FAILED', readyAt: new Date() },
    { status: 'FAILED', readyAt: null, restoreId: randomUUID() }]) {
    const checkpointId = randomUUID(); blocked.push(checkpointId);
    await cps.insertOne({ ...cp, ...fields, _id: new BSON.ObjectId(), checkpointId });
    await chunks.insertOne({ checkpointId, collection: 'products', chunkIndex: 0, payload: Buffer.from('keep'), byteCount: 4 });
  }
  const referenced = randomUUID(); blocked.push(referenced);
  await cps.insertOne({ ...cp, _id: new BSON.ObjectId(), status: 'FAILED', checkpointId: referenced });
  await chunks.insertOne({ checkpointId: referenced, collection: 'products', chunkIndex: 0, payload: Buffer.from('keep'), byteCount: 4 });
  await db.collection('mltestbrancharchives').insertOne({ ...scope, checkpointId: referenced, restoreId: randomUUID() });
  const last = randomUUID(); blocked.push(last);
  await cps.insertOne({ ...cp, _id: new BSON.ObjectId(), status: 'FAILED', checkpointId: last });
  await chunks.insertOne({ checkpointId: last, collection: 'products', chunkIndex: 0, payload: Buffer.from('keep'), byteCount: 4 });
  await db.collection('mltestcontrols').updateOne({ businessId: scope.businessId }, { $set: { lastCheckpointId: last } });
  const commands = []; const listener = row => commands.push(row.commandName); client.on('commandStarted', listener);
  const report = await admin.execute(req, 'STORAGE'); client.off('commandStarted', listener);
  assert.equal(report.writes, 0); assert.equal(report.reclaimablePayloadBytes, 3);
  assert.equal(report.byStatus.READY.checkpointCount, 1);
  assert(report.checkpoints.every(row => row.metadataBsonBytes > 0));
  assert.equal(report.checkpoints.find(row => row.checkpointId === cp.checkpointId).purgeEligible, true);
  assert(!commands.some(name => ['insert', 'update', 'delete', 'create', 'createIndexes', 'findAndModify'].includes(name)));
  const assertSanitized = value => {
    if (!value || typeof value !== 'object') return;
    assert.equal(Buffer.isBuffer(value), false);
    for (const [key, child] of Object.entries(value)) {
      assert(!['payload', 'captureOwnerNonce', 'hashes', 'actor'].includes(key));
      assertSanitized(child);
    }
  };
  assertSanitized(report); // payloadBytes is an aggregate, payload itself must never escape.
  const result = await admin.execute(req, 'PURGE_FAILED_CHECKPOINT_PAYLOADS');
  assert.equal(result.deletedChunks, 1); assert.equal(result.reclaimedBytes, 3);
  for (const checkpointId of blocked) assert.equal(await chunks.countDocuments({ checkpointId }), 1);
  const preserved = await cps.findOne({ checkpointId: cp.checkpointId });
  assert.deepEqual(preserved.hashes, cp.hashes); assert(preserved.abandonedAt); assert(preserved.payloadPurge.completedAt);
  assert.equal(preserved.payloadPurge.reclaimedBytes, 3);
  const replay = await admin.execute(req, 'PURGE_FAILED_CHECKPOINT_PAYLOADS');
  assert.equal(replay.deletedChunks, 0); assert.equal(replay.reclaimedBytes, 0); assert.equal(replay.idempotent, true);
  assert.equal(await db.collection('mltestadminaudits').countDocuments({ action: 'PURGE_FAILED_CHECKPOINT_PAYLOADS', result: 'SUCCEEDED' }), 2);
  assert.equal((await db.collection('products').findOne({ sku: 'TEST-SKU' })).stock, 12);
}));

test('storage failure while marking FAILED preserves the original failure and leaves a recoverable fenced orphan', async () => fixture(async ({ client, db, admin }) => {
  await admin.execute(req, 'ABORT_STALE_CHECKPOINT');
  const logs = [], wrapped = Object.create(db), original = db.collection.bind(db);
  wrapped.collection = name => {
    const collection = original(name);
    if (name === 'mltestcheckpointchunks') collection.insertOne = async () => { throw Object.assign(new Error('SECRET_QUOTA_DETAILS'), { code: 8000 }); };
    if (name === 'mltestcheckpoints') {
      const updateOne = collection.updateOne.bind(collection);
      collection.updateOne = async (filter, update, options) => {
        if (update.$set?.status === 'FAILED') throw Object.assign(new Error('SECRET_QUOTA_DETAILS'), { code: 8000 });
        return updateOne(filter, update, options);
      };
    }
    return collection;
  };
  await assert.rejects(S.captureOperationalCheckpoint({ client, db: wrapped, scope,
    logDiagnostic: row => logs.push(row), logProgress: () => {} }), { code: 8000 });
  const state = await admin.execute(req, 'STATUS');
  assert.equal(state.state, 'CHECKPOINT_CREATING'); assert.equal(state.maintenance, true);
  assert.equal(state.checkpoint.status, 'CREATING'); assert.equal(state.checkpoint.capture.staleCandidate, false);
  assert(logs.some(row => row.code === 'CHECKPOINT_FAILURE_PERSISTENCE_FAILED'));
  assert(!JSON.stringify(logs).includes('SECRET'));
  await assert.rejects(admin.execute(req, 'ABORT_STALE_CHECKPOINT'), { code: 'CHECKPOINT_CAPTURE_NOT_STALE' });
}));

test('purge refuses active restore/control and foreign tenant payload; concurrent cleanup counts each byte once', async () => fixture(async ({ db, admin, cp }) => {
  await admin.execute(req, 'ABORT_STALE_CHECKPOINT');
  const controls = db.collection('mltestcontrols'), cps = db.collection('mltestcheckpoints'), chunks = db.collection('mltestcheckpointchunks');
  const foreignId = randomUUID();
  await cps.insertOne({ ...cp, _id: new BSON.ObjectId(), status: 'FAILED', businessId: 'FOREIGN', checkpointId: foreignId });
  await chunks.insertOne({ checkpointId: foreignId, collection: 'products', chunkIndex: 0, payload: Buffer.from('foreign'), byteCount: 7 });
  await controls.updateOne({ businessId: scope.businessId }, { $set: { state: 'RESTORING', restoreLeaseUntil: new Date(Date.now() + 10000) } });
  const blocked = await admin.execute(req, 'PURGE_FAILED_CHECKPOINT_PAYLOADS'); assert.equal(blocked.deletedChunks, 0);
  assert.equal(await chunks.countDocuments({ checkpointId: cp.checkpointId }), 1);
  await controls.updateOne({ businessId: scope.businessId }, { $set: { state: 'NO_TEST', restoreLeaseUntil: null } });
  const results = await Promise.all([admin.execute(req, 'PURGE_FAILED_CHECKPOINT_PAYLOADS'), admin.execute(req, 'PURGE_FAILED_CHECKPOINT_PAYLOADS')]);
  assert.equal(results.reduce((sum, row) => sum + row.reclaimedBytes, 0), 3);
  assert.equal(results.reduce((sum, row) => sum + row.deletedChunks, 0), 1);
  assert.equal(await chunks.countDocuments({ checkpointId: foreignId }), 1);
  assert.equal((await cps.findOne({ checkpointId: cp.checkpointId })).payloadPurge.reclaimedBytes, 3);
}));
