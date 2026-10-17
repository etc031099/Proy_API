'use strict';

const { randomUUID } = require('node:crypto');
const config = require('../config/v3Operational');
const coordinator = require('./forecastMlUpdateCoordinator');
const { describePending } = require('./forecastCloudWorker');
const HORIZONS = [7, 14];
const MANUAL_INTERVAL_MS = 60_000;
const fail = (code, httpStatus) => { throw Object.assign(new Error(code), { code, httpStatus }); };

// Fixed GitHub host/workflow/ref: neither the client nor a database row supplies
// a URL, branch, token or arbitrary workflow input. No raw response/error logging.
function createWorkflowDispatcher({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async ({ manualRequestKey } = {}) => {
    if (manualRequestKey && (typeof manualRequestKey !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(manualRequestKey))) return 'DEFERRED';
    const token = env.FORECAST_GITHUB_ACTIONS_TOKEN;
    const repository = env.FORECAST_GITHUB_REPOSITORY;
    if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) return 'DEFERRED';
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/forecast-ridge-auto-update.yml/dispatches`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
        body: JSON.stringify({ ref: 'main', inputs: { mode: 'run',
          ...(manualRequestKey ? { manualRequestKey } : {}) } }),
      });
      // Current API returns 200; 204 supports the previous API behavior.
      await response.body?.cancel();
      return [200, 204].includes(response.status) ? 'DISPATCHED' : 'DEFERRED';
    } catch { return 'DEFERRED'; }
  };
}

function productionRepository() {
  const mongoose = require('mongoose');
  const { ForecastMlUpdateState: State, V3OperationalRevision: Revision,
    ForecastModelRegistry: Registry, ForecastModelArtifact: Artifact } = require('../models');
  const executions = require('./forecastMlUpdateExecutionService').createForecastMlUpdateExecutionService();
  const read = async (scope, session) => {
    const query = modelQuery => session ? modelQuery.session(session) : modelQuery;
    const revision = await query(Revision.findById(scope.businessId)).setOptions({ useBigInt64: true }).lean();
    if (!revision || revision.bootstrapStatus !== 'VERIFIED') fail('ML_REVISION_UNAVAILABLE', 503);
    const states = await query(State.find(scope)).setOptions({ useBigInt64: true }).lean();
    const active = [];
    for (const horizonDays of HORIZONS) {
      const pointer = await query(Registry.findOne({ ...scope, horizonDays })).lean();
      const artifact = pointer?.activeArtifactId ? await query(Artifact.findOne({ ...scope, horizonDays,
        _id: pointer.activeArtifactId, modelVersion: pointer.activeModelVersion, status: 'ACTIVE' }))
        .select('horizonDays modelVersion trainedDataVersion labelClosedThrough').lean() : null;
      if (artifact) active.push(artifact);
    }
    return { dataVersion: String(revision.revision), states, active };
  };
  return {
    read,
    async transaction(scope, callback) {
      await require('./forecastExecutionIndexes').verifyExecutionIndexes();
      // Unique scope index plus snapshot transaction coalesce concurrent callers,
      // including separate backend replicas. Retry a racing first-row insert.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const session = await mongoose.startSession();
        try {
          return await session.withTransaction(async () => callback({
            ...await read(scope, session),
            history: executions.withSession(session),
            put: async row => {
              const { _id, createdAt, updatedAt, ...fields } = row;
              await State.updateOne({ ...scope, horizonDays: row.horizonDays }, { $set: fields },
                { session, upsert: true, runValidators: true, setDefaultsOnInsert: true });
            },
          }), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        } catch (error) {
          if (error.code !== 11000 || attempt === 1) throw error;
        } finally { await session.endSession(); }
      }
    },
    async recordDispatch(scope, requestKey, status) {
      await State.updateMany({ ...scope, manualRequestKey: requestKey },
        { $set: { manualDispatchStatus: status } }, { runValidators: true });
    },
    history: executions,
  };
}

function initialState(scope, horizonDays, snapshot, now) {
  const active = snapshot.active.find(row => row.horizonDays === horizonDays);
  if (!active) fail('ACTIVE_MODEL_REQUIRED', 409);
  const closed = coordinator.watermark(now);
  const origin = coordinator.matureOrigin(active.labelClosedThrough, horizonDays);
  return { ...scope, horizonDays, status: 'IDLE', pendingSince: now,
    latestDataVersion: BigInt(snapshot.dataVersion), lastProcessedDataVersion: BigInt(active.trainedDataVersion),
    eventCount: 0, lastDirtyAt: now, observationsClosedThrough: closed,
    initialMatureOrigin: origin, lastTrainedMatureOrigin: origin,
    latestMatureOrigin: coordinator.matureOrigin(closed, horizonDays),
    nextEligibleAt: now, triggerReason: 'MANUAL_EVALUATION', fencingToken: 0,
    historicalCorrectionVersion: null, lastAttemptAt: null };
}

const RESULT_CODES = Object.freeze({ NO_PENDING_WORK: 'LAST_RESULT_NO_PENDING',
  NO_PROMOTION_INSUFFICIENT_HISTORY: 'LAST_RESULT_INSUFFICIENT_HISTORY',
  REJECTED: 'LAST_RESULT_REJECTED', PROMOTED: 'LAST_RESULT_PROMOTED', FAILED: 'LAST_RESULT_FAILED' });
const EVALUATION_CODES = new Set([...Object.keys(RESULT_CODES), 'DEBOUNCE_NOT_ELAPSED',
  'NOT_MATURE', 'COOLDOWN_ACTIVE', 'PREVIOUS_FAILURE_NOT_RETRYABLE']);
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;

function createForecastManualUpdateService({ repository, dispatch, history, clock = () => new Date() } = {}) {
  const repo = repository || productionRepository();
  const dispatchWorkflow = dispatch || createWorkflowDispatcher();
  const scopeFor = req => {
    if (!req.user?.businessId) fail('AUTH_REQUIRED', 401);
    // V3 is deliberately one approved scenario; no cross-tenant fallback.
    if (req.user.businessId !== config.businessId) fail('ML_SCOPE_UNAVAILABLE', 403);
    if (Object.keys(req.body || {}).length || Object.keys(req.query || {}).length) fail('ML_REQUEST_FIELDS_NOT_ALLOWED', 400);
    return { businessId: req.user.businessId, scenarioId: config.scenarioId };
  };

  async function request(req) {
    const scope = scopeFor(req), now = clock();
    const result = await repo.transaction(scope, async snapshot => {
      const states = HORIZONS.map(h => snapshot.states.find(row => row.horizonDays === h)
        || initialState(scope, h, snapshot, now));
      const running = states.some(row => row.status === 'CLAIMED' && row.leaseUntil > now);
      if (running) return { requestStatus: 'RUNNING', dispatch: 'NOT_REQUESTED', send: false };
      const existing = states.find(row => row.manualPending);
      if (!existing && states.some(row => row.lastManualRequestAt && now - row.lastManualRequestAt < MANUAL_INTERVAL_MS)) {
        fail('ML_UPDATE_RATE_LIMITED', 429);
      }
      const requestKey = existing?.manualRequestKey || randomUUID();
      // Retry failed/unconfigured dispatch at most once/minute without creating
      // another durable request. A successful dispatch is never re-fired by clicks.
      const send = !existing || (existing.manualDispatchStatus !== 'DISPATCHED'
        && (!existing.lastManualDispatchAt || now - existing.lastManualDispatchAt >= MANUAL_INTERVAL_MS));
      for (const row of states) {
        if (existing && row.manualRequestKey === requestKey && row.manualPending && !send) continue;
        // Repair/complete a partially evaluated pair as a new coalesced request
        // only when a dispatch retry is necessary; never overwrite worker leases.
        if (existing && !send) continue;
        row.manualPending = true;
        row.manualRequestKey = requestKey;
        row.lastTriggerSource = 'MANUAL';
        row.lastManualRequestAt = existing?.lastManualRequestAt || now;
        row.lastManualDispatchAt = now;
        row.manualDispatchStatus = 'RESERVED';
        await snapshot.put(row);
      }
      const audit = snapshot.history || history;
      if (audit) await audit.createExecution({ ...scope, triggerSource: 'MANUAL', manualRequestKey: requestKey,
        requestedAt: existing?.lastManualRequestAt || now, dataVersionBefore: snapshot.dataVersion, pendingBefore: true });
      return { requestStatus: existing ? 'ALREADY_PENDING' : 'REQUEST_ACCEPTED',
        dispatch: send ? 'RESERVED' : existing.manualDispatchStatus || 'DEFERRED', requestKey, send };
    });
    let dispatchStatus = result.dispatch;
    if (result.send) {
      try { dispatchStatus = await dispatchWorkflow({ manualRequestKey: result.requestKey }); } catch { dispatchStatus = 'DEFERRED'; }
      if (!['DISPATCHED', 'DEFERRED'].includes(dispatchStatus)) dispatchStatus = 'DEFERRED';
      // The durable request was committed BEFORE the network call. A metadata
      // write failure must not turn acceptance into an ambiguous POST failure.
      try { await repo.recordDispatch(scope, result.requestKey, dispatchStatus); }
      catch { dispatchStatus = 'DEFERRED'; }
    }
    if (dispatchStatus === 'DEFERRED' && result.requestKey) {
      const audit = history || repo.history;
      if (audit) {
        try {
          const row = await audit.findExecutionByManualRequest({ ...scope, manualRequestKey: result.requestKey });
          if (row && ['REQUESTED', 'PENDING'].includes(row.status)) await audit.markDeferred({ ...scope,
            executionId: row.executionId, expectedVersion: row.writeVersion, reasonCode: 'DISPATCH_DEFERRED' });
        } catch { /* Acceptance is already committed; keep its existing audit row. */ }
      }
    }
    return { requestStatus: result.requestStatus, trigger: 'MANUAL',
      pending: true, horizons: HORIZONS, dispatchStatus,
      messageCode: result.requestStatus === 'REQUEST_ACCEPTED' ? 'ML_UPDATE_REQUESTED' : result.requestStatus };
  }

  async function status(req) {
    const scope = scopeFor(req), now = clock(), snapshot = await repo.read(scope);
    return { dataVersion: snapshot.dataVersion, closedThrough: coordinator.watermark(now), horizons: HORIZONS.map(h => {
      const row = snapshot.states.find(item => item.horizonDays === h);
      const active = snapshot.active.find(item => item.horizonDays === h);
      const pending = describePending(row, h, coordinator, now);
      const running = pending.eligibility === 'LEASE_ACTIVE';
      const last = row?.lastManualEvaluatedAt && (!row.lastAttemptAt || row.lastManualEvaluatedAt >= row.lastAttemptAt)
        ? row.lastManualResult : row?.lastFailureAt && (!row.lastSuccessAt || row.lastFailureAt > row.lastSuccessAt)
          ? 'FAILED' : row?.lastOutcome;
      return { horizonDays: h, activeModelVersion: active?.modelVersion ?? null,
        trainedDataVersion: active?.trainedDataVersion ?? null,
        pending: pending.pending, currentlyRunning: running,
        trigger: row?.manualPending ? 'MANUAL' : row?.lastTriggerSource || 'AUTO',
        lastRequestAt: iso(row?.lastManualRequestAt), lastAttemptAt: iso(row?.lastAttemptAt),
        lastEvaluatedAt: iso(row?.lastManualEvaluatedAt), lastResult: RESULT_CODES[last] || (last ? 'NOT_ELIGIBLE_YET' : null),
        lastEvaluationReason: EVALUATION_CODES.has(last) ? last : null,
        eligibility: pending.eligibility, nextEligibleAt: iso(row?.nextEligibleAt),
        requestStatus: running ? 'RUNNING' : row?.manualPending ? 'ALREADY_PENDING'
          : pending.pending ? 'NOT_ELIGIBLE_YET' : RESULT_CODES[last] || 'LAST_RESULT_NO_PENDING',
        dispatchStatus: row?.manualDispatchStatus || null,
        // No Python/training in this API. Exact readiness remains worker-owned.
        availableOrigins: null, requiredOrigins: 107 };
    }) };
  }
  return { request, status };
}

module.exports = { createForecastManualUpdateService, createWorkflowDispatcher,
  productionRepository, initialState, MANUAL_INTERVAL_MS };
