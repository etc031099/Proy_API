'use strict';
// Internal executor; HTTP callers must use the existing authenticated admin routes.
const { randomUUID } = require('node:crypto');
const A = require('./mlTestAccess');
const S = require('./mlTestCheckpointService');
const R = require('./mlTestRestoreService');
const F = require('./mlTestFence');
const T = require('./mlTestTargetAuthorization');
const Recovery = require('./mlTestFailedCheckpointRecovery');
const D = require('./mlTestCheckpointDiagnostics');
const Lifecycle = require('./mlTestCheckpointLifecycle');
const Storage = require('./mlTestCheckpointStorage');
const fail = (code, httpStatus = 409) => { throw Object.assign(new Error(code), { code, httpStatus }); };
const cloudFlagEnabled = T.cloudFlagEnabled;
const ACTIONS = new Set(['CREATE', 'STATUS', 'STORAGE', 'RESTORE', 'RESTORE_AND_FINISH', 'RECOVER_AND_FINISH',
  'ABORT_FAILED_CHECKPOINT', 'ABORT_STALE_CHECKPOINT', 'PURGE_FAILED_CHECKPOINT_PAYLOADS']);
const EMPTY_ACTIONS = new Set(['CREATE', 'STATUS', 'STORAGE', 'ABORT_FAILED_CHECKPOINT', 'ABORT_STALE_CHECKPOINT', 'PURGE_FAILED_CHECKPOINT_PAYLOADS']);
const AUDIT = Recovery.AUDIT; // Intentionally outside the restore allowlist.
async function provisionLocalAudit(client, db, authorization) {
  S.assertExecutionTarget(client, db, authorization);
  try { await db.createCollection(AUDIT); } catch (error) { if (error.code !== 48) throw error; }
  await db.collection(AUDIT).createIndex({ actionId: 1 }, { unique: true, name: 'ml_test_admin_action_uq' });
}
function createMlTestAdminExecutor({ client, db, target = 'CLOUD', env = process.env,
  writersPaused = false, certificationId, auditDenied = record => console.warn(JSON.stringify(record)) } = {}) {
  async function execute(req, action) {
    // req.user must come from the EXISTING authentication middleware, not body.
    const scope = A.authorizeAdminAction(req?.user, req?.body || {}, req?.query || {});
    if (!ACTIONS.has(action)) fail('ML_TEST_ACTION_NOT_ALLOWED');
    const body = req.body || {};
    if (Object.keys(body).some(key => !['checkpointId', 'restoreId', 'branch'].includes(key)) || Object.keys(req.query || {}).length) fail('ML_TEST_REQUEST_INVALID', 400);
    if (EMPTY_ACTIONS.has(action) && Object.keys(body).length) fail('ML_TEST_REQUEST_INVALID', 400);
    if (!EMPTY_ACTIONS.has(action) && (!/^[a-f0-9-]{36}$/.test(body.checkpointId || '')
        || !/^[a-f0-9-]{36}$/.test(body.restoreId || '') || !['NORMAL', 'OUTLIER', 'SHIFT'].includes(body.branch))) fail('ML_TEST_REQUEST_INVALID', 400);
    if (['STATUS', 'STORAGE'].includes(action)) {
      if (target === 'CLOUD') T.assertCloudStatusTarget({ client, db, env });
      else if (target === 'LOCAL') await T.assertLocalStatusTarget({ client, db, env });
      else if (target !== 'LOCAL_CERTIFICATION') fail('ML_TEST_TARGET_INVALID', 400);
      else S.assertExecutionTarget(client, db, null);
      return action === 'STORAGE' ? Storage.reportStorage(db, scope)
        : readAdminStatus(db, scope, { cloudRestoreEnabled: target === 'CLOUD'
          && T.cloudFlagEnabled(env) && certificationId === T.CERTIFICATION });
    }
    let authorization;
    if (target === 'CLOUD') authorization = T.authorizeCloudTarget({ client, db, user: req.user, env, certificationId });
    else if (target === 'LOCAL') authorization = await T.authorizeLocalTarget({ client, db, user: req.user, env });
    else if (target !== 'LOCAL_CERTIFICATION') fail('ML_TEST_TARGET_INVALID', 400);
    S.assertExecutionTarget(client, db, authorization);
    if (target === 'LOCAL' && action === 'CREATE') {
      if (!await require('./mlTestProductBaselineService').provision({ client, db, env }))
        fail('ML_TEST_BASELINE_LOCAL_TARGET_REQUIRED', 503);
    }
    // Explicit LOCAL administrative provisioning only; never Model.init/Atlas.
    await provisionLocalAudit(client, db, authorization);
    const token = await F.capture(db), actionId = randomUUID(), timestamp = new Date();
    const audit = { actionId, actor: String(req.user._id), action, ...scope,
      checkpointId: body.checkpointId || null, testCycleId: token.testCycleId,
      epoch: token.resetEpoch, timestamp, result: 'STARTED', failureCode: null };
    await db.collection(AUDIT).insertOne(audit, { writeConcern: { w: 'majority' } });
    try {
      let result;
      if (['ABORT_FAILED_CHECKPOINT', 'ABORT_STALE_CHECKPOINT'].includes(action)) {
        // Control transition, preserved receipt and SUCCEEDED audit commit
        // together. Never rewrite that success in a later non-atomic step.
        result = await Recovery.abortFailedCheckpoint({ client, db, scope, authorization, actionId, actor: String(req.user._id),
          stale: action === 'ABORT_STALE_CHECKPOINT' });
        return { ...result, cloudRestoreEnabled: T.cloudAuthorized(client, db, authorization) };
      }
      if (action === 'PURGE_FAILED_CHECKPOINT_PAYLOADS') return Storage.purgeFailedPayloads({ client, db, scope,
        authorization, actionId, actor: String(req.user._id) });
      if (action === 'CREATE') result = await (target === 'LOCAL_CERTIFICATION' ? S.captureLocalCheckpoint : S.captureOperationalCheckpoint)({ client, db, scope,
        localWritersPaused: writersPaused === true, createdBy: String(req.user._id), authorization });
      else {
        if (!body.checkpointId || !body.restoreId || !body.branch) fail('ML_TEST_REQUEST_INVALID', 400);
        if (action === 'RECOVER_AND_FINISH') {
          const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
          const finalizedReceipt = control?.state === 'NO_TEST' && control.lastCheckpointId === body.checkpointId
            && control.restoreId === body.restoreId && control.restoreFinish === true && control.finalizedAt;
          if ((!['FAILED', 'RESTORING'].includes(control?.state) && !finalizedReceipt) || control.restoreId !== body.restoreId) fail('ML_TEST_SAME_RESTORE_REQUIRED');
          if (!control.restoreFinish) fail('ML_TEST_RESUME_CONTINUE_FIRST');
          // A failed capture has no certified source to restore: remain blocked.
        }
        result = await R.restoreLocalCheckpoint({ client, db, scope, ...body, finish: action !== 'RESTORE', authorization, env });
      }
      const after = await F.capture(db);
      await db.collection(AUDIT).updateOne({ actionId }, { $set: { result: 'SUCCEEDED', completedAt: new Date(),
        checkpointId: result.checkpointId || body.checkpointId || null, testCycleId: after.testCycleId, epoch: after.resetEpoch } },
      { writeConcern: { w: 'majority' } });
      return { ...result, cloudRestoreEnabled: T.cloudAuthorized(client, db, authorization) };
    } catch (error) {
      const code = action === 'CREATE' ? S.codeOf(error)
        : /^(?:CHECKPOINT|RESTORE|ML_TEST|STALE_TEST)_[A-Z_]+$/.test(error.code || '') ? error.code : 'ML_TEST_OPERATION_FAILED';
      const failed = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { promoteLongs: false });
      await db.collection(AUDIT).updateOne({ actionId, result: 'STARTED' }, { $set: { result: 'FAILED', failureCode: code, completedAt: new Date(),
        ...(failed ? { epoch: String(failed.resetEpoch), testCycleId: failed.testCycleId,
          checkpointId: body.checkpointId || failed.activeCheckpointId || failed.lastCheckpointId
            || (['ABORT_FAILED_CHECKPOINT', 'ABORT_STALE_CHECKPOINT'].includes(action) ? failed.lastAbortedCheckpointId : null) || null } : {}) } },
        { writeConcern: { w: 'majority' } });
      fail(code, [400, 409, 423, 503].includes(error.httpStatus) ? error.httpStatus : 409);
    }
  }
  return { execute: async (req, action) => {
    try { return await execute(req, action); }
    catch (error) {
      const code = /^(?:CHECKPOINT|RESTORE|ML_TEST|STALE_TEST|TEST)_[A-Z_]+$/.test(error.code || '') ? error.code : 'ML_TEST_OPERATION_FAILED';
      const actor = String(req?.user?._id || '');
      // Authorization/flag failures cannot write to the target DB. Emit a
      // narrow server audit event instead; no request/body/error text.
      try { auditDenied({ actor: /^[A-Za-z0-9:_-]{1,160}$/.test(actor) ? actor : null,
        action: ACTIONS.has(action) ? action : 'REJECTED_ACTION', checkpointId: null, testCycleId: null,
        epoch: null, timestamp: new Date().toISOString(), result: 'FAILED', failureCode: code }); } catch { /* No unsafe fallback logging. */ }
      fail(code, [400, 401, 403, 409, 423, 503].includes(error.httpStatus) ? error.httpStatus : 503);
    }
  } };
}
async function readAdminStatus(db, scope, { cloudRestoreEnabled = false } = {}) {
  const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { promoteLongs: false });
  const token = F.tokenOf(control);
  const checkpointId = control?.activeCheckpointId || control?.lastCheckpointId || null;
  const checkpoint = checkpointId ? await db.collection('mltestcheckpoints').findOne(
    { checkpointId, businessId: scope.businessId, scenarioId: scope.scenarioId },
    { projection: { checkpointId: 1, status: 1, dataVersion: 1, capturedAt: 1, createdAt: 1,
      totalDocuments: 1, totalBytes: 1, totalChunks: 1, failureCode: 1, failureDiagnostics: 1, captureMetrics: 1,
      readyAt: 1, updatedAt: 1, captureProtocolVersion: 1, captureOwnershipVersion: 1, captureOwnerNonce: 1,
      captureDeadlineAt: 1, captureHeartbeatAt: 1, captureLeaseUntil: 1, capturePhase: 1 } }) : null;
  const safeCode = value => /^(?:CHECKPOINT|RESTORE|ML_TEST|STALE_TEST|TEST)_[A-Z_]+$/.test(value || '') ? value : null;
  const admissionClosed = !['NO_TEST', 'TEST_ACTIVE'].includes(token.state);
  const activeWriterCount = control?.activeWriterIds == null ? 0
    : Array.isArray(control.activeWriterIds) ? control.activeWriterIds.length : null;
  return { state: token.state, resetEpoch: token.resetEpoch, testCycleId: token.testCycleId,
    maintenance: admissionClosed, cloudRestoreEnabled,
    quiescence: { admissionClosed, writersPaused: admissionClosed && activeWriterCount === 0, activeWriterCount },
    activeCheckpointId: /^[a-f0-9-]{36}$/i.test(control?.activeCheckpointId || '') ? control.activeCheckpointId : null,
    lastCheckpointId: /^[a-f0-9-]{36}$/i.test(control?.lastCheckpointId || '') ? control.lastCheckpointId : null,
    lastAbortedCheckpointId: /^[a-f0-9-]{36}$/i.test(control?.lastAbortedCheckpointId || '') ? control.lastAbortedCheckpointId : null,
    lastAbortedAt: control?.lastAbortedAt || null,
    checkpoint: checkpoint ? { checkpointId: checkpoint.checkpointId, status: checkpoint.status,
      dataVersion: typeof checkpoint.dataVersion === 'string' ? checkpoint.dataVersion : null,
      createdAt: checkpoint.createdAt || checkpoint.capturedAt || null,
      progress: checkpoint.status === 'READY' ? { phase: 'VERIFIED',
        totalDocuments: Number.isSafeInteger(checkpoint.totalDocuments) ? checkpoint.totalDocuments : null,
        totalBytes: Number.isSafeInteger(checkpoint.totalBytes) ? checkpoint.totalBytes : null,
        totalChunks: Number.isSafeInteger(checkpoint.totalChunks) ? checkpoint.totalChunks : null }
        : { phase: checkpoint.status === 'CREATING' ? 'CAPTURING' : checkpoint.status },
      failureCode: safeCode(checkpoint.failureCode), failureDiagnostics: D.safeStoredFailure(checkpoint.failureDiagnostics),
      capture: { deadlineAt: checkpoint.captureDeadlineAt || null, heartbeatAt: checkpoint.captureHeartbeatAt || null,
        leaseUntil: checkpoint.captureLeaseUntil || null,
        phase: ['QUIESCENCE', 'DRAIN', 'SNAPSHOT_READ', 'CHUNK_WRITE', 'VERIFY', 'FINALIZE'].includes(checkpoint.capturePhase) ? checkpoint.capturePhase : null,
        staleCandidate: Lifecycle.staleCapture(control, checkpoint) },
      metrics: D.safeMetrics(checkpoint.captureMetrics) } : null,
    restoreId: /^[a-f0-9-]{36}$/i.test(control?.restoreId || '') ? control.restoreId : null,
    restoreFinish: control?.restoreFinish === true, restoreLeaseUntil: control?.restoreLeaseUntil || null,
    finalizedAt: control?.finalizedAt || null, failureCode: safeCode(control?.failureCode) };
}
module.exports = { createMlTestAdminExecutor, cloudFlagEnabled, provisionLocalAudit, AUDIT };
