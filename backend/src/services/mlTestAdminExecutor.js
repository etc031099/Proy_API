'use strict';
// Internal authenticated-session contract. No destructive HTTP route is added.
const { randomUUID } = require('node:crypto');
const A = require('./mlTestAccess');
const S = require('./mlTestCheckpointService');
const R = require('./mlTestRestoreService');
const F = require('./mlTestFence');
const T = require('./mlTestTargetAuthorization');
const fail = (code, httpStatus = 409) => { throw Object.assign(new Error(code), { code, httpStatus }); };
const cloudFlagEnabled = T.cloudFlagEnabled;
const ACTIONS = new Set(['CREATE', 'STATUS', 'RESTORE', 'RESTORE_AND_FINISH', 'RECOVER_AND_FINISH']);
const AUDIT = 'mltestadminaudits'; // Intentionally outside the restore allowlist.
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
    if (['CREATE', 'STATUS'].includes(action) && Object.keys(body).length) fail('ML_TEST_REQUEST_INVALID', 400);
    if (!['CREATE', 'STATUS'].includes(action) && (!/^[a-f0-9-]{36}$/.test(body.checkpointId || '')
        || !/^[a-f0-9-]{36}$/.test(body.restoreId || '') || !['NORMAL', 'OUTLIER', 'SHIFT'].includes(body.branch))) fail('ML_TEST_REQUEST_INVALID', 400);
    let authorization;
    if (target === 'CLOUD') authorization = T.authorizeCloudTarget({ client, db, user: req.user, env, certificationId });
    else if (target !== 'LOCAL_CERTIFICATION') fail('ML_TEST_TARGET_INVALID', 400);
    S.assertExecutionTarget(client, db, authorization);
    if (action === 'STATUS') {
      const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { promoteLongs: false });
      const token = F.tokenOf(control);
      return { state: token.state, resetEpoch: token.resetEpoch, testCycleId: token.testCycleId,
        maintenance: !['NO_TEST', 'TEST_ACTIVE'].includes(token.state), cloudRestoreEnabled: T.authorized(client, db, authorization),
        activeCheckpointId: control?.activeCheckpointId || null, lastCheckpointId: control?.lastCheckpointId || null,
        restoreId: control?.restoreId || null, restoreFinish: control?.restoreFinish === true,
        restoreLeaseUntil: control?.restoreLeaseUntil || null, finalizedAt: control?.finalizedAt || null,
        failureCode: /^(?:CHECKPOINT|RESTORE|ML_TEST|STALE_TEST|TEST)_[A-Z_]+$/.test(control?.failureCode || '') ? control.failureCode : null };
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
      if (action === 'CREATE') result = await S.captureLocalCheckpoint({ client, db, scope,
        localWritersPaused: writersPaused === true, createdBy: String(req.user._id), authorization });
      else {
        if (!body.checkpointId || !body.restoreId || !body.branch) fail('ML_TEST_REQUEST_INVALID', 400);
        if (action === 'RECOVER_AND_FINISH') {
          const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
          if (!['FAILED', 'RESTORING'].includes(control?.state) || control.restoreId !== body.restoreId) fail('ML_TEST_SAME_RESTORE_REQUIRED');
          if (!control.restoreFinish) fail('ML_TEST_RESUME_CONTINUE_FIRST');
          // A failed capture has no certified source to restore: remain blocked.
        }
        result = await R.restoreLocalCheckpoint({ client, db, scope, ...body, finish: action !== 'RESTORE', authorization });
      }
      const after = await F.capture(db);
      await db.collection(AUDIT).updateOne({ actionId }, { $set: { result: 'SUCCEEDED', completedAt: new Date(),
        checkpointId: result.checkpointId || body.checkpointId || null, testCycleId: after.testCycleId, epoch: after.resetEpoch } },
      { writeConcern: { w: 'majority' } });
      return { ...result, cloudRestoreEnabled: T.authorized(client, db, authorization) };
    } catch (error) {
      const code = /^(?:CHECKPOINT|RESTORE|ML_TEST|STALE_TEST)_[A-Z_]+$/.test(error.code || '') ? error.code : 'ML_TEST_OPERATION_FAILED';
      const failed = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { promoteLongs: false });
      await db.collection(AUDIT).updateOne({ actionId }, { $set: { result: 'FAILED', failureCode: code, completedAt: new Date(),
        ...(failed ? { epoch: String(failed.resetEpoch), testCycleId: failed.testCycleId,
          checkpointId: body.checkpointId || failed.activeCheckpointId || failed.lastCheckpointId || null } : {}) } },
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
module.exports = { createMlTestAdminExecutor, cloudFlagEnabled, provisionLocalAudit, AUDIT };
