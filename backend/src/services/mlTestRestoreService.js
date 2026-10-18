'use strict';
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const S = require('./mlTestCheckpointService');
const M = require('./mlTestCheckpointManifest');
const { LIMITS, budget } = require('./mlTestOperationBudget');
const { Long } = M.BSON;
const ORDER = Object.freeze(['historicalscenarios', 'minimarketv3records', 'contacts', 'products',
  'transactions', 'inventorymovements', 'creditpayments', 'v3operationalchanges', 'v3operationalrevisions',
  'forecastmodelartifacts', 'forecastmodelregistries', 'forecasttrainingjobs', 'forecastmlupdateexecutions',
  'forecastmlupdateevents', 'forecastmlupdatestates', 'stockalertrules', 'inventoryalerts',
  'inventoryalertoutboxevents', 'inventoryalertchanneldeliveries', 'pendingactions', 'actionaudits',
  'actiondomainevents', 'automationruns']);
const ARCHIVE = 'mltestbrancharchives';
const safeFailure = error => /^(CHECKPOINT_[A-Z_]+|RESTORE_[A-Z_]+|STALE_TEST_EPOCH)$/.test(String(error?.code || ''))
  ? error.code : 'RESTORE_OPERATION_FAILED';
async function transact(client, work) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 5000 });
  } finally { await session.endSession(); }
}
async function* documents(db, checkpointId, collection) {
  const cursor = db.collection('mltestcheckpointchunks').find({ checkpointId, collection }).sort({ chunkIndex: 1 });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of cursor) {
      pending = Buffer.concat([pending, M.bytesOf(chunk.payload)]);
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
        const size = pending.readInt32LE(0);
        if (size < 5 || size > M.MAX_BSON_BYTES) M.fail('CHECKPOINT_BSON_INVALID');
        const raw = pending.subarray(0, size);
        const doc = M.BSON.deserialize(raw, { promoteValues: false, bsonRegExp: true });
        // Fail BEFORE replacement if the driver cannot reproduce these BSON
        // bytes exactly (including BSON type and field ordering).
        if (!M.BSON.serialize(doc).equals(raw)) M.fail('RESTORE_BSON_ROUNDTRIP_UNSUPPORTED');
        yield doc;
        pending = pending.subarray(size);
      }
    }
    if (pending.length) M.fail('CHECKPOINT_BSON_TRUNCATED');
  } finally { await cursor.close(); }
}
async function validateBeforeRestore(client, db, checkpointId, scope) {
  const checkpoint = await db.collection('mltestcheckpoints').findOne({ checkpointId, ...scope }, { promoteLongs: false });
  if (!checkpoint || checkpoint.status !== 'READY') M.fail('RESTORE_READY_CHECKPOINT_REQUIRED');
  await S.verifyLocalCheckpoint({ client, db, checkpointId, scope });
  for (const collection of ORDER) for await (const doc of documents(db, checkpointId, collection)) {
    const filter = M.scopeFilter(collection, scope);
    if (Object.entries(filter).some(([key, value]) => !isDeepStrictEqual(doc[key], value))) M.fail('CHECKPOINT_SCOPE_INVALID');
  }
  return checkpoint;
}
async function verifyRestored(client, db, checkpoint, scope) {
  const actual = await S.scanSource({ client, db, scope, elapsedLimitMs: LIMITS.verificationMs });
  for (const collection of ORDER) {
    if (actual.documentCounts[collection] !== checkpoint.documentCounts[collection]
        || actual.byteCounts[collection] !== checkpoint.byteCounts[collection]
        || actual.hashes[collection] !== checkpoint.hashes[collection]) M.fail('RESTORE_SOURCE_HASH_MISMATCH');
  }
  if (actual.dataVersion !== checkpoint.dataVersion) M.fail('RESTORE_REVISION_MISMATCH');
  return { dataVersion: actual.dataVersion, totalDocuments: actual.totalDocuments, totalBytes: actual.totalBytes };
}
async function restoreLocalCheckpoint({ client, db, checkpointId, restoreId, branch, scope,
  afterCollection, invalidateCaches = async () => {} }) {
  S.assertLocalTarget(client, db); scope = M.authorizedScope(scope);
  const checkBudget = budget(LIMITS.restoreMs);
  if (!/^[a-f0-9-]{36}$/.test(restoreId || '') || !['NORMAL', 'OUTLIER', 'SHIFT'].includes(branch)) M.fail('RESTORE_REQUEST_INVALID');
  const checkpoint = await validateBeforeRestore(client, db, checkpointId, scope);
  // This additional namespace is outside the restore allowlist. DDL is local-only.
  try { await db.createCollection(ARCHIVE); } catch (error) { if (error.code !== 48) throw error; }
  await db.collection(ARCHIVE).createIndex({ businessId: 1, restoreId: 1 }, { unique: true, name: 'ml_test_branch_restore_uq' });
  const controls = db.collection('mltestcontrols');
  const initial = await controls.findOne({ businessId: scope.businessId }, { promoteLongs: false });
  if (!initial || initial.activeCheckpointId !== checkpointId) M.fail('RESTORE_CONTROL_MISMATCH');
  const archived = await db.collection(ARCHIVE).findOne({ ...scope, restoreId });
  if (archived && (archived.branch !== branch || archived.checkpointId !== checkpointId)) M.fail('RESTORE_IDENTITY_CONFLICT');
  if (!Long.isLong(initial.resetEpoch) || initial.resetEpoch.compare(Long.ZERO) < 0) M.fail('RESTORE_EPOCH_INVALID');
  if (initial.restoreId === restoreId && initial.state === 'TEST_ACTIVE' && initial.restoreCompletedAt) {
    try {
      const verified = await verifyRestored(client, db, checkpoint, scope);
      require('./mlTestFence').invalidateCaches();
      await invalidateCaches();
      return { status: 'TEST_ACTIVE', restoreId, resetEpoch: String(initial.resetEpoch), idempotent: true,
        cloudRestoreEnabled: false, ...verified };
    } catch (error) {
      await controls.updateOne({ businessId: scope.businessId, state: 'TEST_ACTIVE', restoreId, resetEpoch: initial.resetEpoch },
        { $set: { state: 'FAILED', restoreLeaseUntil: new Date(0), failureCode: safeFailure(error) } });
      throw error;
    }
  }
  // An interrupted attempt remains FAILED/RESTORING until an explicit resume
  // with the SAME restoreId. Ordinary calls cannot take over another owner.
  const resume = initial.restoreId === restoreId && ['FAILED', 'RESTORING'].includes(initial.state);
  if (!resume && initial.state !== 'TEST_ACTIVE') M.fail('RESTORE_CONTROL_BUSY');
  if (!resume && initial.resetEpoch.compare(Long.MAX_VALUE) >= 0) M.fail('RESTORE_EPOCH_EXHAUSTED');
  let control;
  const ownerNonce = randomUUID();
  try {
    control = await transact(client, async session => {
      const changed = await controls.findOneAndUpdate({ businessId: scope.businessId,
        activeCheckpointId: checkpointId, state: initial.state, resetEpoch: initial.resetEpoch,
        restoreId: initial.restoreId ?? null,
        // Resume is explicit after process interruption; a live owner cannot
        // be preempted before its bounded lease expires.
        ...(resume ? { restoreLeaseUntil: { $lte: new Date() } } : {}) },
      { $set: { state: 'RESTORING', restoreId, restoreOwnerNonce: ownerNonce,
        restoreLeaseUntil: new Date(Date.now() + 60000), restoreCompletedAt: null, failureCode: null, updatedAt: new Date() },
      ...(!resume ? { $inc: { resetEpoch: Long.ONE } } : {}) },
      { session, returnDocument: 'after', promoteLongs: false });
      if (!changed) M.fail('RESTORE_CONTROL_BUSY');
      if (!resume) {
        const revision = await db.collection('v3operationalrevisions').findOne({ _id: scope.businessId }, { session, promoteLongs: false });
        const models = await db.collection('forecastmodelartifacts').find({ ...scope, status: 'ACTIVE' },
          { session, projection: { _id: 0, horizonDays: 1, modelVersion: 1, artifactHash: 1 } }).toArray();
        const executions = await db.collection('forecastmlupdateexecutions').find(scope,
          { session, projection: { _id: 0, executionId: 1 } }).limit(1001).toArray();
        if (executions.length > 1000) M.fail('RESTORE_ARCHIVE_LIMIT_EXCEEDED');
        const documentCountDelta = {};
        for (const collection of ORDER) documentCountDelta[collection] = {
          checkpoint: checkpoint.documentCounts[collection],
          branch: await db.collection(collection).countDocuments(M.scopeFilter(collection, scope), { session })
        };
        await db.collection(ARCHIVE).insertOne({ ...scope, checkpointId, restoreId, testCycleId: initial.testCycleId,
          branch, epoch: initial.resetEpoch, createdAt: new Date(), dataVersionBefore: checkpoint.dataVersion,
          dataVersionAfter: String(revision?.revision ?? 0), modelBefore: checkpoint.activeModels,
          modelAfter: models, executionIds: executions.map(row => row.executionId).filter(Boolean),
          summary: { checkpointDocuments: Object.values(checkpoint.documentCounts).reduce((a, b) => a + b, 0),
            kind: 'DOCUMENT_REPLACEMENT_NO_COMPENSATION', documentCountDelta } }, { session });
      }
      return changed;
    });
    // Validate again under exclusive control before deleting the first source row.
    await validateBeforeRestore(client, db, checkpointId, scope);
    for (const collection of ORDER) {
      checkBudget();
      await transact(client, async session => {
        const locked = await controls.updateOne({ businessId: scope.businessId, state: 'RESTORING',
          restoreId, resetEpoch: control.resetEpoch, restoreOwnerNonce: ownerNonce },
        { $set: { restoreHeartbeatNonce: randomUUID(), restoreLeaseUntil: new Date(Date.now() + 60000) } }, { session });
        if (locked.matchedCount !== 1) M.fail('STALE_TEST_EPOCH');
        await db.collection(collection).deleteMany(M.scopeFilter(collection, scope), { session });
        let batch = [], bytes = 0;
        for await (const doc of documents(db, checkpointId, collection)) {
          checkBudget();
          batch.push(doc); bytes += M.BSON.calculateObjectSize(doc);
          if (bytes >= M.TARGET_BYTES || batch.length >= 100) {
            await db.collection(collection).insertMany(batch, { session, ordered: true }); batch = []; bytes = 0;
          }
        }
        if (batch.length) await db.collection(collection).insertMany(batch, { session, ordered: true });
      });
      if (afterCollection) await afterCollection(collection);
    }
    const verified = await verifyRestored(client, db, checkpoint, scope);
    checkBudget();
    require('./mlTestFence').invalidateCaches();
    await invalidateCaches();
    const done = await controls.updateOne({ businessId: scope.businessId, state: 'RESTORING', restoreId,
      resetEpoch: control.resetEpoch, restoreOwnerNonce: ownerNonce },
    { $set: { state: 'TEST_ACTIVE', restoreCompletedAt: new Date(), restoreLeaseUntil: null, failureCode: null, updatedAt: new Date() } });
    if (done.matchedCount !== 1) M.fail('STALE_TEST_EPOCH');
    return { status: 'TEST_ACTIVE', restoreId, resetEpoch: String(control.resetEpoch), idempotent: false,
      cloudRestoreEnabled: false, ...verified };
  } catch (error) {
    if (control) await controls.updateOne({ businessId: scope.businessId, state: 'RESTORING', restoreId,
      resetEpoch: control.resetEpoch, restoreOwnerNonce: ownerNonce },
    { $set: { state: 'FAILED', failureCode: safeFailure(error), restoreLeaseUntil: new Date(0), updatedAt: new Date() } });
    throw Object.assign(new Error(safeFailure(error)), { code: safeFailure(error) });
  }
}
module.exports = { restoreLocalCheckpoint: async input => {
  try { return await restoreLocalCheckpoint(input); }
  catch (error) { const code = safeFailure(error); throw Object.assign(new Error(code), { code }); }
}, verifyRestored, ORDER, documents };
