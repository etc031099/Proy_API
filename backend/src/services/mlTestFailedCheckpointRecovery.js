'use strict';
const { Long } = require('mongoose').mongo.BSON;
const S = require('./mlTestCheckpointService');
const M = require('./mlTestCheckpointManifest');
const Lifecycle = require('./mlTestCheckpointLifecycle');
const AUDIT = 'mltestadminaudits';
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
function neverReady(checkpoint) {
  if (checkpoint.status !== 'FAILED' || checkpoint.readyAt != null) return false;
  if (checkpoint.captureProtocolVersion === S.CAPTURE_PROTOCOL && Object.hasOwn(checkpoint, 'readyAt')) return true;
  // The deployed legacy failure has an incomplete initial manifest. An old
  // COMPLETE manifest without a readyAt marker is ambiguous and is refused.
  return checkpoint.dataVersion == null && checkpoint.hashes?.manifest == null
    && !checkpoint.collectionManifest?.length && checkpoint.totalBytes === 0 && checkpoint.totalChunks === 0;
}
async function abortFailedCheckpoint({ client, db, scope, authorization, actionId, actor, stale = false }) {
  S.assertExecutionTarget(client, db, authorization); scope = M.authorizedScope(scope);
  if (!uuid(actionId) || typeof actor !== 'string' || !actor || actor.length > 160) M.fail('CHECKPOINT_RECOVERY_AUDIT_REQUIRED');
  const session = client.startSession();
  const action = stale ? 'ABORT_STALE_CHECKPOINT' : 'ABORT_FAILED_CHECKPOINT';
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary',
      writeConcern: { w: 'majority' }, maxCommitTimeMS: 5000 });
    const controls = db.collection('mltestcontrols'), checkpoints = db.collection('mltestcheckpoints'), audits = db.collection(AUDIT);
    const audit = await audits.findOne({ actionId, actor, ...scope, action, result: 'STARTED' }, { session });
    if (!audit) M.fail('CHECKPOINT_RECOVERY_AUDIT_REQUIRED');
    const control = await controls.findOne({ businessId: scope.businessId }, { session, promoteLongs: false });
    if (!control) M.fail('CHECKPOINT_RECOVERY_CONTROL_REQUIRED');
    let checkpointId, epoch, idempotent = false;
    if (control.state === 'NO_TEST' && control.activeCheckpointId == null && uuid(control.lastAbortedCheckpointId)
        && control.lastAbortedEpoch === String(control.resetEpoch) && control.lastAbortedTestCycleId === control.testCycleId) {
      const receipt = await checkpoints.findOne({ checkpointId: control.lastAbortedCheckpointId, ...scope }, { session });
      const priorAudit = receipt?.abandonmentActionId ? await audits.findOne({ actionId: receipt.abandonmentActionId,
        ...scope, action: { $in: ['ABORT_FAILED_CHECKPOINT', 'ABORT_STALE_CHECKPOINT'] }, result: 'SUCCEEDED' }, { session }) : null;
      if (!receipt || !priorAudit || receipt.status !== 'FAILED' || !receipt.abandonedAt || receipt.readyAt != null
          || receipt.abandonedEpoch !== String(control.resetEpoch) || receipt.abandonedCycleId !== control.testCycleId
          || priorAudit.checkpointId !== receipt.checkpointId || priorAudit.epoch !== String(control.resetEpoch)
          || priorAudit.testCycleId !== control.testCycleId) M.fail('CHECKPOINT_RECOVERY_RECEIPT_INVALID');
      checkpointId = receipt.checkpointId; epoch = String(control.resetEpoch); idempotent = true;
    } else {
      if (control.state !== (stale ? 'CHECKPOINT_CREATING' : 'FAILED') || !uuid(control.activeCheckpointId) || !uuid(control.testCycleId)) M.fail('CHECKPOINT_RECOVERY_CONTROL_INVALID');
      if (!Long.isLong(control.resetEpoch) || control.resetEpoch.compare(Long.ZERO) < 0
          || control.resetEpoch.compare(Long.MAX_VALUE) >= 0) M.fail('CHECKPOINT_RECOVERY_EPOCH_INVALID');
      if (audit.epoch !== String(control.resetEpoch) || audit.testCycleId !== control.testCycleId) M.fail('CHECKPOINT_RECOVERY_CONFLICT');
      if (control.restoreId != null || control.restoreLeaseUntil != null || control.restoreOwnerNonce != null
          || control.restoreHeartbeatNonce != null || control.restoreFinish === true) M.fail('CHECKPOINT_RECOVERY_RESTORE_PRESENT');
      if (control.lastCheckpointId != null) M.fail('CHECKPOINT_RECOVERY_PRIOR_CHECKPOINT_PRESENT');
      if (control.activeWriterIds != null && (!Array.isArray(control.activeWriterIds) || control.activeWriterIds.length)) M.fail('CHECKPOINT_RECOVERY_WRITERS_PRESENT');
      checkpointId = control.activeCheckpointId;
      const checkpoint = await checkpoints.findOne({ checkpointId, ...scope }, { session });
      if (!checkpoint || checkpoint.abandonedAt) M.fail('CHECKPOINT_RECOVERY_NOT_FAILED_CAPTURE');
      if (stale ? !Lifecycle.staleCapture(control, checkpoint) : !neverReady(checkpoint)) {
        M.fail(stale ? 'CHECKPOINT_CAPTURE_NOT_STALE' : 'CHECKPOINT_RECOVERY_NOT_FAILED_CAPTURE');
      }
      if (await checkpoints.findOne({ ...scope, status: 'READY' }, { session, projection: { _id: 1 } })) M.fail('CHECKPOINT_RECOVERY_READY_PRESENT');
      await S.assertQuiescent(db, scope, { session });
      const now = new Date(); epoch = control.resetEpoch.add(Long.ONE).toString();
      const changed = await controls.updateOne({ businessId: scope.businessId, state: control.state,
        activeCheckpointId: checkpointId, resetEpoch: control.resetEpoch, testCycleId: control.testCycleId,
        restoreId: null, restoreLeaseUntil: null, restoreOwnerNonce: null, restoreHeartbeatNonce: null,
        restoreFinish: { $ne: true }, lastCheckpointId: null,
        $or: [{ activeWriterIds: { $exists: false } }, { activeWriterIds: { $size: 0 } }] }, {
        $set: { state: 'NO_TEST', activeCheckpointId: null, failureCode: null, updatedAt: now, epochChangedAt: now,
          lastAbortedCheckpointId: checkpointId, lastAbortedAt: now, lastAbortedEpoch: epoch,
          lastAbortedTestCycleId: control.testCycleId }, $inc: { resetEpoch: Long.ONE }
      }, { session });
      if (changed.matchedCount !== 1) M.fail('CHECKPOINT_RECOVERY_CONFLICT');
      const preserved = await checkpoints.updateOne({ checkpointId, ...scope, status: checkpoint.status, abandonedAt: null, readyAt: null,
        ...(stale ? { updatedAt: checkpoint.updatedAt } : {}) },
        { $set: { status: 'FAILED', ...(stale ? { failureCode: 'CHECKPOINT_STALE_ABORTED',
          priorFailureCode: checkpoint.failureCode || null } : {}), abandonedAt: now, abandonedBy: actor, abandonedEpoch: epoch, abandonedCycleId: control.testCycleId,
          abandonmentActionId: actionId, updatedAt: now } }, { session });
      if (preserved.matchedCount !== 1) M.fail('CHECKPOINT_RECOVERY_CONFLICT');
    }
    const recorded = await audits.updateOne({ actionId, result: 'STARTED' }, { $set: { result: 'SUCCEEDED', failureCode: null,
      checkpointId, testCycleId: control.testCycleId, epoch, idempotent, completedAt: new Date() } }, { session });
    if (recorded.matchedCount !== 1) M.fail('CHECKPOINT_RECOVERY_AUDIT_REQUIRED');
    await session.commitTransaction();
    return { state: 'NO_TEST', status: stale ? 'STALE_CHECKPOINT_ABORTED' : 'FAILED_CHECKPOINT_ABORTED', abortedCheckpointId: checkpointId, resetEpoch: epoch, idempotent };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    if (error.code === 112 || error.hasErrorLabel?.('TransientTransactionError')) M.fail('CHECKPOINT_RECOVERY_CONFLICT');
    throw error;
  } finally { await session.endSession(); }
}
module.exports = { abortFailedCheckpoint, neverReady, AUDIT };
