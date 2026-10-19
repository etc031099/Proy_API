'use strict';
const { randomUUID } = require('node:crypto');
const S = require('./mlTestCheckpointService');
const M = require('./mlTestCheckpointManifest');
const { neverReady, AUDIT } = require('./mlTestFailedCheckpointRecovery');
const Lifecycle = require('./mlTestCheckpointLifecycle');
const { LIMITS } = require('./mlTestOperationBudget');
const REPORT_LIMIT = 200;
async function eligibility(db, scope, checkpoint, control, session) {
  if (!neverReady(checkpoint) || checkpoint.restoreId != null) return 'CHECKPOINT_PURGE_NOT_FAILED_CAPTURE';
  if (checkpoint.captureOwnershipVersion !== Lifecycle.PROTOCOL
      && (!(checkpoint.capturedAt instanceof Date) || Date.now() < checkpoint.capturedAt.getTime()
        + LIMITS.maxCloudCaptureMs + Lifecycle.STALE_GRACE_MS)) return 'CHECKPOINT_PURGE_LEGACY_GRACE';
  if (!control || control.state !== 'NO_TEST' || control.restoreLeaseUntil != null || control.restoreOwnerNonce != null
      || control.restoreHeartbeatNonce != null) return 'CHECKPOINT_PURGE_CONTROL_BUSY';
  if ([control.activeCheckpointId, control.lastCheckpointId].includes(checkpoint.checkpointId)) return 'CHECKPOINT_PURGE_REFERENCED';
  if (await db.collection('mltestbrancharchives').findOne({ ...scope, checkpointId: checkpoint.checkpointId },
    { session, projection: { _id: 1 } })) return 'CHECKPOINT_PURGE_REFERENCED';
  return null;
}
async function collectionSize(db, name) {
  try {
    const row = await db.command({ collStats: name, scale: 1 });
    return { logicalBytes: row.size, allocatedBytes: row.storageSize, indexBytes: row.totalIndexSize, statsAvailable: true };
  } catch { return { statsAvailable: false }; }
}
async function reportStorage(db, scope) {
  scope = M.authorizedScope(scope);
  const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { promoteLongs: false });
  const rows = await db.collection('mltestcheckpoints').find(scope, { projection: {
    checkpointId: 1, businessId: 1, scenarioId: 1, status: 1, readyAt: 1, captureProtocolVersion: 1,
    dataVersion: 1, 'hashes.manifest': 1, collectionManifest: { $slice: 1 }, totalBytes: 1, totalChunks: 1,
    createdAt: 1, capturedAt: 1, captureOwnershipVersion: 1, restoreId: 1, payloadPurge: 1 } }).sort({ createdAt: -1 }).limit(REPORT_LIMIT + 1).toArray();
  const truncated = rows.length > REPORT_LIMIT; rows.length = Math.min(rows.length, REPORT_LIMIT);
  const totals = await db.collection('mltestcheckpointchunks').aggregate([
    { $match: { checkpointId: { $in: rows.map(row => row.checkpointId) } } },
    { $group: { _id: '$checkpointId', chunkCount: { $sum: 1 },
      totalChunkBytes: { $sum: { $binarySize: '$payload' } }, totalBsonBytes: { $sum: { $bsonSize: '$$ROOT' } } } }
  ], { maxTimeMS: 10000 }).toArray();
  const byId = new Map(totals.map(row => [row._id, row]));
  const metadata = await db.collection('mltestcheckpoints').aggregate([
    { $match: { ...scope, checkpointId: { $in: rows.map(row => row.checkpointId) } } },
    { $project: { _id: 0, checkpointId: 1, metadataBsonBytes: { $bsonSize: '$$ROOT' } } }
  ], { maxTimeMS: 10000 }).toArray();
  const metadataById = new Map(metadata.map(row => [row.checkpointId, row.metadataBsonBytes]));
  const checkpoints = [];
  for (const row of rows) {
    const reason = await eligibility(db, scope, row, control);
    const bytes = byId.get(row.checkpointId);
    checkpoints.push({ checkpointId: row.checkpointId, status: row.status, chunkCount: bytes?.chunkCount || 0,
      totalChunkBytes: bytes?.totalChunkBytes || 0, totalBsonBytes: bytes?.totalBsonBytes || 0,
      metadataBsonBytes: metadataById.get(row.checkpointId) || 0,
      restorable: row.status === 'READY' && !row.payloadPurge,
      purgeEligible: reason === null, purgeReasonCode: reason });
  }
  const byStatus = {};
  for (const row of checkpoints) {
    if (!['CREATING', 'READY', 'FAILED'].includes(row.status)) continue;
    const group = byStatus[row.status] ||= { checkpointCount: 0, chunkCount: 0, payloadBytes: 0, metadataBytes: 0 };
    group.checkpointCount++; group.chunkCount += row.chunkCount;
    group.payloadBytes += row.totalChunkBytes; group.metadataBytes += row.metadataBsonBytes;
  }
  return { mode: 'READ_ONLY', writes: 0, truncated, reportLimit: REPORT_LIMIT, byStatus,
    restorableVerification: 'METADATA_ONLY_HASHES_NOT_RECHECKED',
    collections: { mltestcheckpointchunks: await collectionSize(db, 'mltestcheckpointchunks'),
      mltestcheckpoints: await collectionSize(db, 'mltestcheckpoints') }, checkpoints,
    reclaimablePayloadBytes: checkpoints.filter(row => row.purgeEligible).reduce((sum, row) => sum + row.totalChunkBytes, 0) };
}
async function purgeFailedPayloads({ client, db, scope, authorization, actionId, actor }) {
  S.assertExecutionTarget(client, db, authorization); scope = M.authorizedScope(scope);
  if (!/^[a-f0-9-]{36}$/i.test(actionId || '') || typeof actor !== 'string' || !actor || actor.length > 160) M.fail('CHECKPOINT_RECOVERY_AUDIT_REQUIRED');
  const audits = db.collection(AUDIT), checkpoints = db.collection('mltestcheckpoints');
  const audit = await audits.findOne({ actionId, actor, ...scope, action: 'PURGE_FAILED_CHECKPOINT_PAYLOADS', result: 'STARTED' });
  if (!audit) M.fail('CHECKPOINT_RECOVERY_AUDIT_REQUIRED');
  const candidates = await checkpoints.find({ ...scope, status: 'FAILED', readyAt: null },
    { projection: { checkpointId: 1 } }).limit(REPORT_LIMIT + 1).toArray();
  if (candidates.length > REPORT_LIMIT) M.fail('CHECKPOINT_PURGE_REPORT_LIMIT');
  let deletedChunks = 0, reclaimedBytes = 0;
  const deadlineAt = Date.now() + 60000;
  const results = [];
  for (const candidate of candidates) {
    let done = false, skipped = null, count = 0, bytes = 0;
    // One short transaction per <=4 MiB chunk: never a 100 MB delete transaction.
    // Each commit atomically removes payload and records the exact reclaimed bytes.
    for (let iteration = 0; !done && iteration <= 128; iteration++) {
      if (Date.now() >= deadlineAt) M.fail('CHECKPOINT_PURGE_TIME_BUDGET');
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          done = false; skipped = null;
          const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { session, promoteLongs: false });
          const row = await checkpoints.findOne({ ...scope, checkpointId: candidate.checkpointId }, { session });
          const reason = row ? await eligibility(db, scope, row, control, session) : 'CHECKPOINT_PURGE_NOT_FAILED_CAPTURE';
          if (reason) { skipped = reason; done = true; return; }
          const fenced = await db.collection('mltestcontrols').updateOne({ businessId: scope.businessId,
            state: 'NO_TEST', resetEpoch: control.resetEpoch, activeCheckpointId: control.activeCheckpointId ?? null,
            lastCheckpointId: control.lastCheckpointId ?? null }, { $set: { captureFenceNonce: randomUUID() } }, { session });
          if (fenced.matchedCount !== 1) M.fail('CHECKPOINT_PURGE_CONFLICT');
          const chunk = await db.collection('mltestcheckpointchunks').findOne({ checkpointId: row.checkpointId }, { session });
          if (!chunk) {
            await checkpoints.updateOne({ checkpointId: row.checkpointId, ...scope, status: 'FAILED', readyAt: null },
              { $set: { 'payloadPurge.completedAt': new Date(), 'payloadPurge.lastActionId': actionId } }, { session });
            done = true; return;
          }
          if (iteration === 128) M.fail('CHECKPOINT_PURGE_CHUNK_LIMIT');
          const size = M.bytesOf(chunk.payload).length;
          if (size > M.TARGET_BYTES) M.fail('CHECKPOINT_PURGE_CHUNK_INVALID');
          const removed = await db.collection('mltestcheckpointchunks').deleteOne({ _id: chunk._id, checkpointId: row.checkpointId }, { session });
          if (removed.deletedCount !== 1) M.fail('CHECKPOINT_PURGE_CONFLICT');
          await checkpoints.updateOne({ checkpointId: row.checkpointId, ...scope, status: 'FAILED', readyAt: null }, {
            $inc: { 'payloadPurge.deletedChunks': 1, 'payloadPurge.reclaimedBytes': size },
            $set: { 'payloadPurge.lastActionId': actionId, 'payloadPurge.lastPurgedAt': new Date(), 'payloadPurge.actor': actor }
          }, { session });
          const recorded = await audits.updateOne({ actionId, result: 'STARTED' }, {
            $inc: { deletedChunks: 1, reclaimedBytes: size }, $set: { checkpointId: row.checkpointId },
            $addToSet: { checkpointIds: row.checkpointId }
          }, { session });
          if (recorded.matchedCount !== 1) M.fail('CHECKPOINT_RECOVERY_AUDIT_REQUIRED');
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5000, timeoutMS: 15000 });
      } finally { await session.endSession(); }
    }
    const receipt = await checkpoints.findOne({ ...scope, checkpointId: candidate.checkpointId }, { projection: { payloadPurge: 1 } });
    // Totals for this invocation come from its transactional audit, never an
    // in-memory counter that could double count a retried transaction.
    count = receipt?.payloadPurge?.deletedChunks || 0; bytes = receipt?.payloadPurge?.reclaimedBytes || 0;
    results.push({ checkpointId: candidate.checkpointId, skippedReasonCode: skipped,
      cumulativeDeletedChunks: count, cumulativeReclaimedBytes: bytes });
  }
  const recorded = await audits.findOne({ actionId }, { projection: { deletedChunks: 1, reclaimedBytes: 1 } });
  deletedChunks = recorded?.deletedChunks || 0; reclaimedBytes = recorded?.reclaimedBytes || 0;
  await audits.updateOne({ actionId, result: 'STARTED' }, { $set: { result: 'SUCCEEDED', completedAt: new Date() } }, { writeConcern: { w: 'majority' } });
  return { status: 'CHECKPOINT_PAYLOADS_PURGED', deletedChunks, reclaimedBytes, checkpoints: results, idempotent: deletedChunks === 0 };
}
module.exports = { REPORT_LIMIT, eligibility, reportStorage, purgeFailedPayloads };
