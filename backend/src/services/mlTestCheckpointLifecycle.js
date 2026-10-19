'use strict';
const { randomUUID } = require('node:crypto');
const { LIMITS } = require('./mlTestOperationBudget');
const M = require('./mlTestCheckpointManifest');
const PROTOCOL = 'CAPTURE_OWNER_V1';
const HEARTBEAT_MS = 10000;
const STALE_GRACE_MS = 120000;
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const time = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
function ownership(startedAt, budgetMs) {
  return { captureOwnershipVersion: PROTOCOL, captureOwnerNonce: randomUUID(),
    captureDeadlineAt: new Date(startedAt + budgetMs), captureHeartbeatAt: new Date(startedAt),
    captureLeaseUntil: new Date(startedAt + budgetMs), capturePhase: 'QUIESCENCE' };
}
function staleCapture(control, checkpoint, now = Date.now()) {
  if (!control || !checkpoint || control.state !== 'CHECKPOINT_CREATING' || checkpoint.status !== 'CREATING'
      || control.activeCheckpointId !== checkpoint.checkpointId || !uuid(checkpoint.checkpointId)
      || checkpoint.captureProtocolVersion !== 'SNAPSHOT_SESSION_V1'
      || !Object.hasOwn(checkpoint, 'readyAt') || checkpoint.readyAt !== null) return false;
  const created = time(checkpoint.capturedAt), updated = time(checkpoint.updatedAt), controlUpdated = time(control.updatedAt);
  if ([created, updated, controlUpdated].some(value => value === null || value > now)
      || now - Math.max(updated, controlUpdated) < STALE_GRACE_MS) return false;
  if (checkpoint.captureOwnershipVersion === PROTOCOL) {
    const deadline = time(checkpoint.captureDeadlineAt), heartbeat = time(checkpoint.captureHeartbeatAt), lease = time(checkpoint.captureLeaseUntil);
    return uuid(checkpoint.captureOwnerNonce) && deadline !== null && heartbeat !== null && lease !== null
      && deadline <= created + LIMITS.maxCloudCaptureMs && deadline >= created
      && now >= deadline + STALE_GRACE_MS && now - heartbeat >= STALE_GRACE_MS && lease <= now;
  }
  // Existing 6D/6E manifests have no owner fields. Use the hard maximum (not
  // the current environment setting) plus grace, and require every timestamp old.
  if (['captureOwnershipVersion', 'captureOwnerNonce', 'captureDeadlineAt', 'captureHeartbeatAt', 'captureLeaseUntil']
    .some(key => checkpoint[key] != null)) return false;
  return now >= created + LIMITS.maxCloudCaptureMs + STALE_GRACE_MS;
}
async function touch(db, checkpoint, phase, { session, timeoutMS = 5000, now = Date.now() } = {}) {
  const changed = await db.collection('mltestcheckpoints').updateOne({ checkpointId: checkpoint.checkpointId,
    businessId: checkpoint.businessId, scenarioId: checkpoint.scenarioId, status: 'CREATING', readyAt: null,
    captureOwnerNonce: checkpoint.captureOwnerNonce, captureDeadlineAt: { $gt: new Date(now) },
    captureLeaseUntil: { $gt: new Date(now) }, abandonedAt: null }, { $set: {
    captureHeartbeatAt: new Date(now),
    capturePhase: phase, updatedAt: new Date(now) } }, { session, timeoutMS });
  if (changed.matchedCount !== 1) M.fail('CHECKPOINT_CAPTURE_OWNERSHIP_LOST');
}
async function writeChunk({ client, db, control, checkpoint, chunk, collection, timeoutMS }) {
  const session = client.startSession();
  try {
    session.startTransaction({ writeConcern: { w: 'majority' }, maxCommitTimeMS: Math.min(5000, timeoutMS) });
    const fenced = await db.collection('mltestcontrols').updateOne({ businessId: control.businessId,
      activeCheckpointId: checkpoint.checkpointId, state: 'CHECKPOINT_CREATING', resetEpoch: control.resetEpoch,
      testCycleId: control.testCycleId }, { $set: { captureFenceNonce: randomUUID() } }, { session, timeoutMS });
    if (fenced.matchedCount !== 1) M.fail('CHECKPOINT_CAPTURE_OWNERSHIP_LOST');
    await touch(db, checkpoint, 'CHUNK_WRITE', { session, timeoutMS });
    await db.collection('mltestcheckpointchunks').insertOne({ checkpointId: checkpoint.checkpointId, collection, ...chunk }, { session, timeoutMS });
    await session.commitTransaction({ timeoutMS });
  } catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(() => {}); throw error; }
  finally { await session.endSession(); }
}
module.exports = { PROTOCOL, HEARTBEAT_MS, STALE_GRACE_MS, ownership, staleCapture, touch, writeChunk };
