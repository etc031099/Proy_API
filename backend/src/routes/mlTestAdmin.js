'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { authenticate, authorize } = require('../middleware/auth');
const { createMlTestAdminExecutor } = require('../services/mlTestAdminExecutor');
const { createMlTestLocalRidgeAnalysis } = require('../services/mlTestLocalRidgeAnalysis');
const { createMlTestActivity } = require('../services/mlTestActivity');

const SAFE_CODE = /^(?:CHECKPOINT|RESTORE|ML_TEST|STALE_TEST|STALE_FENCING|TEST)_[A-Z_]+$/;
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, httpStatus: status }); };
const executorFor = (env = process.env) => createMlTestAdminExecutor({
  client: mongoose.connection.getClient(), db: mongoose.connection.db, target: 'LOCAL', env
});
const localAnalyzerFor = (env = process.env) => createMlTestLocalRidgeAnalysis({
  client: mongoose.connection.getClient(), db: mongoose.connection.db, env
});
const activityFor = (env = process.env) => createMlTestActivity({
  client: mongoose.connection.getClient(), db: mongoose.connection.db, env
});

function createMlTestAdminRoutes({ authenticateMiddleware = authenticate, adminMiddleware = authorize('admin'),
  getExecutor = executorFor, getLocalAnalyzer = localAnalyzerFor, getActivity = activityFor } = {}) {
  const router = express.Router();
  router.use(authenticateMiddleware, adminMiddleware);

  const respondError = (res, error) => {
    const code = SAFE_CODE.test(error?.code || '') ? error.code : 'ML_TEST_OPERATION_FAILED';
    return res.status([400, 401, 403, 409, 413, 423, 503].includes(error?.httpStatus) ? error.httpStatus : 503)
      .set('Cache-Control', 'no-store').json({ success: false, code, message: 'La operación administrativa de prueba no pudo completarse.' });
  };
  const emptyBody = req => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) fail('ML_TEST_REQUEST_INVALID', 400);
    if (Object.keys(req.query || {}).length) fail('ML_TEST_REQUEST_INVALID', 400);
  };
  const safeStatus = value => ({ state: value.state, resetEpoch: value.resetEpoch,
    testCycleId: value.testCycleId, maintenance: value.maintenance,
    quiescence: value.quiescence || null,
    checkpointId: value.activeCheckpointId || value.lastCheckpointId || null,
    activeCheckpointId: value.activeCheckpointId || null, lastCheckpointId: value.lastCheckpointId || null,
    lastAbortedCheckpointId: value.lastAbortedCheckpointId || null, lastAbortedAt: value.lastAbortedAt || null,
    checkpoint: value.checkpoint || null, restoreId: value.restoreId || null,
    restoreFinish: value.restoreFinish === true, restoreLeaseUntil: value.restoreLeaseUntil || null,
    finalizedAt: value.finalizedAt || null, failureCode: value.failureCode || value.checkpoint?.failureCode || null,
    cloudRestoreEnabled: value.cloudRestoreEnabled === true });

  router.get('/status', async (req, res) => {
    try {
      if (Object.keys(req.query || {}).length) fail('ML_TEST_REQUEST_INVALID', 400);
      const result = await getExecutor().execute(req, 'STATUS');
      return res.set('Cache-Control', 'no-store').json({ success: true, data: safeStatus(result) });
    } catch (error) { return respondError(res, error); }
  });

  router.get('/activity', async (req, res) => {
    try {
      const data = await getActivity().execute({ user: req.user, query: req.query });
      return res.set('Cache-Control', 'no-store').json({ success: true, data });
    } catch (error) { return respondError(res, error); }
  });

  router.post('/analyze', async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
          || Object.keys(req.body).length !== 1 || ![7, 14].includes(req.body.horizonDays)
          || Object.keys(req.query || {}).length) fail('ML_TEST_REQUEST_INVALID', 400);
      const data = await getLocalAnalyzer().execute({ user: req.user, horizonDays: req.body.horizonDays });
      return res.set('Cache-Control', 'no-store').json({ success: true, data });
    } catch (error) { return respondError(res, error); }
  });

  router.post('/checkpoint', async (req, res) => {
    try {
      emptyBody(req);
      const executor = getExecutor();
      const result = await executor.execute(req, 'CREATE');
      const status = await executor.execute({ ...req, body: {}, query: {} }, 'STATUS');
      return res.status(201).set('Cache-Control', 'no-store').json({ success: true, data: {
        ...safeStatus(status), checkpointId: result.checkpointId, status: result.status,
        dataVersion: result.dataVersion || status.checkpoint?.dataVersion || null, totalDocuments: result.totalDocuments,
        totalBytes: result.totalBytes, totalChunks: result.totalChunks,
        readDurationMs: result.readDurationMs
      } });
    } catch (error) { return respondError(res, error); }
  });

  router.post('/restore', async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1 || !['continue', 'finish'].includes(body.mode)
          || Object.keys(req.query || {}).length) fail('ML_TEST_REQUEST_INVALID', 400);
      const executor = getExecutor();
      const current = await executor.execute({ ...req, body: {}, query: {} }, 'STATUS');
      const finalizedRetry = body.mode === 'finish' && current.state === 'NO_TEST'
        && current.restoreFinish === true && current.finalizedAt && current.lastCheckpointId && current.restoreId;
      const checkpointId = current.activeCheckpointId || (finalizedRetry ? current.lastCheckpointId : null);
      if (!checkpointId || (!['TEST_ACTIVE', 'RESTORING', 'FAILED'].includes(current.state) && !finalizedRetry)) fail('RESTORE_CONTROL_BUSY');
      const resuming = ['RESTORING', 'FAILED'].includes(current.state);
      if (resuming && !current.restoreId) fail('RESTORE_CONTROL_MISMATCH');
      if (resuming && body.mode === 'finish' && current.restoreFinish !== true) fail('ML_TEST_RESUME_CONTINUE_FIRST');
      const restoreId = resuming ? current.restoreId : randomUUID();
      const action = finalizedRetry ? 'RECOVER_AND_FINISH' : resuming
        ? (current.restoreFinish ? 'RECOVER_AND_FINISH' : 'RESTORE')
        : (body.mode === 'finish' ? 'RESTORE_AND_FINISH' : 'RESTORE');
      const result = await executor.execute({ ...req, body: { checkpointId, restoreId, branch: 'NORMAL' }, query: {} }, action);
      const status = await executor.execute({ ...req, body: {}, query: {} }, 'STATUS');
      // Observability only: a failed read must never turn a successful restore
      // into a reported restore failure. Finish cannot use GET /activity,
      // which deliberately requires TEST_ACTIVE.
      let activityAfterRestore;
      try { activityAfterRestore = await getActivity().verifyRestored({ user: req.user }); }
      catch { activityAfterRestore = { status: 'UNAVAILABLE' }; }
      return res.set('Cache-Control', 'no-store').json({ success: true, data: {
        ...safeStatus(status), status: result.status, restoreId: result.restoreId || restoreId,
        resetEpoch: result.resetEpoch, dataVersion: result.dataVersion,
        totalDocuments: result.totalDocuments, totalBytes: result.totalBytes,
        idempotent: result.idempotent === true, activityAfterRestore
      } });
    } catch (error) { return respondError(res, error); }
  });
  router.post('/recover-failed-checkpoint', async (req, res) => {
    try {
      emptyBody(req);
      const executor = getExecutor();
      const result = await executor.execute(req, 'ABORT_FAILED_CHECKPOINT');
      const status = await executor.execute({ ...req, body: {}, query: {} }, 'STATUS');
      return res.set('Cache-Control', 'no-store').json({ success: true, data: {
        ...safeStatus(status), status: result.status, abortedCheckpointId: result.abortedCheckpointId,
        resetEpoch: result.resetEpoch, idempotent: result.idempotent === true
      } });
    } catch (error) { return respondError(res, error); }
  });
  router.get('/checkpoint-storage', async (req, res) => {
    try {
      if (Object.keys(req.query || {}).length) fail('ML_TEST_REQUEST_INVALID', 400);
      const result = await getExecutor().execute({ ...req, body: {}, query: {} }, 'STORAGE');
      return res.set('Cache-Control', 'no-store').json({ success: true, data: result });
    } catch (error) { return respondError(res, error); }
  });
  router.post('/recover-stale-checkpoint', async (req, res) => {
    try {
      emptyBody(req);
      const executor = getExecutor();
      const result = await executor.execute(req, 'ABORT_STALE_CHECKPOINT');
      const status = await executor.execute({ ...req, body: {}, query: {} }, 'STATUS');
      return res.set('Cache-Control', 'no-store').json({ success: true, data: {
        ...safeStatus(status), status: result.status, abortedCheckpointId: result.abortedCheckpointId,
        resetEpoch: result.resetEpoch, idempotent: result.idempotent === true
      } });
    } catch (error) { return respondError(res, error); }
  });
  router.post('/purge-failed-checkpoint-payloads', async (req, res) => {
    try {
      emptyBody(req);
      const result = await getExecutor().execute(req, 'PURGE_FAILED_CHECKPOINT_PAYLOADS');
      return res.set('Cache-Control', 'no-store').json({ success: true, data: result });
    } catch (error) { return respondError(res, error); }
  });
  return router;
}

module.exports = { createMlTestAdminRoutes, executorFor, localAnalyzerFor, activityFor };
