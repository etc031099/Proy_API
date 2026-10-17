'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const config = require('../src/config/v3Operational');
const update = require('../src/services/forecastMlUpdateCoordinator');
const { createCloudWorker } = require('../src/services/forecastCloudWorker');
const { createForecastManualUpdateService, createWorkflowDispatcher } = require('../src/services/forecastManualUpdateService');
const { createForecastMlUpdateRoutes } = require('../src/routes/forecastMlUpdate');
const { authenticate, checkBusinessAccess } = require('../src/middleware/auth');
const mongoose = require('mongoose');
const { ForecastMlUpdateState: State } = require('../src/models');
const NOW = new Date('2026-10-17T17:00:00Z');
const request = body => ({ user: { businessId: config.businessId, _id: 'fixture-user' }, body: body || {}, query: {} });

// Transactional offline repository: snapshot/rollback and serialized commits.
// No Mongo connection, token, GitHub API or training is used by these tests.
function fixture() {
  let snapshot = { dataVersion: '83', states: [], active: [7, 14].map(horizonDays => ({ horizonDays,
    modelVersion: 1, trainedDataVersion: '83', labelClosedThrough: '2026-10-16' })) };
  let lock = Promise.resolve(), now = new Date(NOW), dispatches = 0, dispatchStatus = 'DISPATCHED';
  const events = [];
  const scopes = [];
  const repository = {
    read: async scope => { scopes.push(scope); return structuredClone(snapshot); },
    readPendingSignals: async (scope, horizonDays, processedRevision) => {
      scopes.push(scope);
      const pending = events.filter(event => event.businessId === scope.businessId
        && event.scenarioId === scope.scenarioId && event.horizonDays === horizonDays
        && (processedRevision == null || BigInt(event.dataVersion) > BigInt(processedRevision)));
      return { count: pending.length, types: [...new Set(pending.map(event => event.eventType))],
        firstAt: pending.map(event => event.occurredAt).sort()[0] || null,
        lastAt: pending.map(event => event.occurredAt).sort().at(-1) || null,
        latestRevision: pending.length ? pending.map(event => BigInt(event.dataVersion)).reduce((a, b) => a > b ? a : b).toString() : null };
    },
    transaction: (scope, fn) => {
      scopes.push(scope);
      const job = lock.then(async () => {
        const local = structuredClone(snapshot);
        const result = await fn({ ...local, put: async row => {
          const index = local.states.findIndex(item => item.horizonDays === row.horizonDays);
          if (index < 0) local.states.push(row); else local.states[index] = row;
        } });
        snapshot = local;
        return result;
      });
      lock = job.catch(() => {});
      return job;
    },
    recordDispatch: async (scope, key, status) => {
      for (const row of snapshot.states) if (row.manualRequestKey === key) row.manualDispatchStatus = status;
    },
  };
  const service = createForecastManualUpdateService({ repository, clock: () => now,
    dispatch: async () => { dispatches += 1; return dispatchStatus; } });
  return { service, repository, scopes, get snapshot() { return snapshot; },
    events,
    get dispatches() { return dispatches; }, setDispatch: value => { dispatchStatus = value; },
    advance: ms => { now = new Date(now.getTime() + ms); } };
}

test('authenticated manual request durably marks only 7/14; status keeps ACTIVE v1', async () => {
  const f = fixture();
  const accepted = await f.service.request(request());
  assert.equal(accepted.requestStatus, 'REQUEST_ACCEPTED');
  assert.equal(accepted.dispatchStatus, 'DISPATCHED');
  assert.deepEqual(f.snapshot.states.map(row => row.horizonDays), [7, 14]);
  assert.ok(f.snapshot.states.every(row => row.manualPending && row.lastTriggerSource === 'MANUAL'));
  const status = await f.service.status(request());
  assert.equal(status.dataVersion, '83');
  assert.equal(status.closedThrough, '2026-10-16');
  for (const row of status.horizons) {
    assert.equal(row.pending, true);
    assert.equal(row.trigger, 'MANUAL');
    assert.equal(row.activeModelVersion, 1);
    assert.equal(row.trainedDataVersion, '83');
    assert.equal(row.requiredOrigins, 107);
    assert.equal(row.availableOrigins, null);
  }
  assert.doesNotMatch(JSON.stringify(status), /artifact|manualRequestKey|_id|hash/i);
  assert.ok(f.scopes.every(scope => scope.businessId === config.businessId && scope.scenarioId === config.scenarioId));
});

test('status counts only unprocessed signals per authenticated scenario and horizon', async () => {
  const f = fixture();
  await f.service.request(request());
  for (const row of f.snapshot.states) Object.assign(row, { lastProcessedDataVersion: 81n,
    latestDataVersion: 84n, eventCount: 900, nextEligibleAt: new Date(NOW.getTime() + 60_000) });
  f.events.push(
    { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays: 7,
      eventType: 'SALE_COMPLETED', dataVersion: '81', occurredAt: '2026-10-17T15:00:00.000Z' },
    { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays: 7,
      eventType: 'SALE_COMPLETED', dataVersion: '82', occurredAt: '2026-10-17T16:00:00.000Z' },
    { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays: 7,
      eventType: 'PRODUCT_UPDATED', dataVersion: '84', occurredAt: '2026-10-17T16:30:00.000Z' },
    { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays: 14,
      eventType: 'SALE_CANCELLED', dataVersion: '82', occurredAt: '2026-10-17T16:10:00.000Z' },
    { businessId: 'foreign-business', scenarioId: config.scenarioId, horizonDays: 7,
      eventType: 'SALE_COMPLETED', dataVersion: '99', occurredAt: '2026-10-17T16:20:00.000Z' },
    { businessId: config.businessId, scenarioId: 'foreign-scenario', horizonDays: 14,
      eventType: 'SALE_COMPLETED', dataVersion: '99', occurredAt: '2026-10-17T16:25:00.000Z' },
  );
  const result = await f.service.status(request());
  const [seven, fourteen] = result.horizons;
  assert.equal(seven.readiness.pendingSignalCount, 2);
  assert.deepEqual(seven.readiness.pendingSignalTypes, ['PRODUCT_UPDATED', 'SALE_COMPLETED']);
  assert.equal(seven.readiness.processedRevision, '81');
  assert.equal(seven.readiness.latestPendingRevision, '84');
  assert.equal(seven.readiness.firstPendingSignalAt, '2026-10-17T16:00:00.000Z');
  assert.equal(seven.readiness.lastPendingSignalAt, '2026-10-17T16:30:00.000Z');
  assert.equal(seven.readiness.status, 'WAITING_DEBOUNCE');
  assert.equal(fourteen.readiness.pendingSignalCount, 1);
  assert.deepEqual(fourteen.readiness.pendingSignalTypes, ['SALE_CANCELLED']);
  assert.equal(fourteen.readiness.status, 'WAITING_DEBOUNCE');
  assert.equal(seven.requiredOrigins, 107);
  assert.equal(seven.availableOrigins, null);
  assert.equal(seven.readiness.availableOriginsActual, null);
  assert.equal(result.horizons.some(row => row.horizonDays === 1), false);
  assert.ok(f.scopes.every(scope => scope.businessId === config.businessId && scope.scenarioId === config.scenarioId));
});

test('readiness codes remain distinct and eligibility does not imply promotion approval', async () => {
  const { preparationStatus } = require('../src/services/forecastManualUpdateService');
  const forEligibility = eligibility => ({ eligibility });
  assert.equal(preparationStatus({ pending: forEligibility('NO_PENDING_WORK'), signalCount: 0 }), 'NO_CHANGES');
  assert.equal(preparationStatus({ pending: forEligibility('NOT_MATURE'), signalCount: 1 }), 'WAITING_MATURITY');
  assert.equal(preparationStatus({ pending: forEligibility('DEBOUNCE_NOT_ELAPSED'), signalCount: 1 }), 'WAITING_DEBOUNCE');
  assert.equal(preparationStatus({ pending: forEligibility('COOLDOWN_ACTIVE'), signalCount: 1 }), 'WAITING_COOLDOWN');
  assert.equal(preparationStatus({ pending: forEligibility('ELIGIBLE'), signalCount: 1 }), 'READY_FOR_WORKER_REVIEW');
  assert.equal(preparationStatus({ pending: forEligibility('LEASE_ACTIVE'), signalCount: 0 }), 'WORKER_ACTIVE');
  assert.equal(preparationStatus({ pending: forEligibility('PREVIOUS_FAILURE_NOT_RETRYABLE'), signalCount: 0 }), 'UNKNOWN');
});

test('10 concurrent clicks coalesce, including an in-flight RESERVED dispatch', async () => {
  const f = fixture();
  const replies = await Promise.all(Array.from({ length: 10 }, () => f.service.request(request())));
  assert.equal(replies.filter(reply => reply.requestStatus === 'REQUEST_ACCEPTED').length, 1);
  assert.equal(replies.filter(reply => reply.requestStatus === 'ALREADY_PENDING').length, 9);
  assert.equal(f.dispatches, 1);
  assert.equal(f.snapshot.states.length, 2);
  assert.equal(new Set(f.snapshot.states.map(row => row.manualRequestKey)).size, 1);
});

test('dispatch failure preserves request; retry is limited and coalesced', async () => {
  const f = fixture(); f.setDispatch('DEFERRED');
  assert.equal((await f.service.request(request())).dispatchStatus, 'DEFERRED');
  assert.ok(f.snapshot.states.every(row => row.manualPending));
  const original = f.snapshot.states[0].manualRequestKey;
  await f.service.request(request()); assert.equal(f.dispatches, 1);
  f.advance(60_001); f.setDispatch('DISPATCHED');
  assert.equal((await f.service.request(request())).requestStatus, 'ALREADY_PENDING');
  assert.equal(f.dispatches, 2);
  assert.ok(f.snapshot.states.every(row => row.manualRequestKey === original));
});

test('scope/session and empty request contract cannot be overridden by the client', async () => {
  const f = fixture();
  await assert.rejects(f.service.request({}), { code: 'AUTH_REQUIRED' });
  await assert.rejects(f.service.request({ ...request(), user: { businessId: 'another-business' } }), { code: 'ML_SCOPE_UNAVAILABLE' });
  for (const body of [{ businessId: config.businessId }, { scenarioId: config.scenarioId },
    { horizonDays: 1 }, { force: true }, { requiredOrigins: 0 }]) {
    await assert.rejects(f.service.request(request(body)), { code: 'ML_REQUEST_FIELDS_NOT_ALLOWED' });
  }
  await assert.rejects(f.service.status({ ...request(), query: { businessId: config.businessId } }), { code: 'ML_REQUEST_FIELDS_NOT_ALLOWED' });
  assert.equal(f.snapshot.states.length, 0);
});

test('manual preserves operational debounce/cooldown/maturity; skips are consumed only in RUN', async () => {
  const f = fixture(); await f.service.request(request());
  f.snapshot.states[0].nextEligibleAt = new Date(NOW.getTime() + 900000);
  f.snapshot.states[0].latestDataVersion = 84n;
  f.snapshot.states[0].latestMatureOrigin = '2026-10-09';
  const fields = ['nextEligibleAt', 'latestDataVersion', 'lastAttemptAt', 'historicalCorrectionVersion'];
  const before = structuredClone(f.snapshot.states[0]);
  let jobs = 0, completions = 0;
  const worker = createCloudWorker({ update, clock: () => NOW,
    preflight: async () => ({ dataVersion: '83', activeModels: f.snapshot.active,
      promotionReadiness: Object.fromEntries([7, 14].map(h => [h, {
        status: 'NO_PROMOTION_INSUFFICIENT_HISTORY', availableOrigins: 0, requiredOrigins: 107 }])) }),
    readState: async h => f.snapshot.states.find(row => row.horizonDays === h),
    runEligible: async () => { jobs += 1; assert.fail('manual must not force training'); },
    completeManualEvaluation: async input => {
      completions += 1;
      const row = f.snapshot.states.find(item => item.horizonDays === input.horizonDays);
      assert.equal(row.manualRequestKey, input.manualRequestKey);
      row.manualPending = false; row.lastManualEvaluatedAt = NOW; row.lastManualResult = input.result;
    },
  });
  await worker.run('STATUS'); assert.equal(completions, 0);
  const report = await worker.run('RUN');
  assert.deepEqual(report.horizons.map(row => row.result), ['DEBOUNCE_NOT_ELAPSED', 'NO_PENDING_WORK']);
  assert.equal(completions, 2); assert.equal(jobs, 0);
  for (const field of fields) assert.deepEqual(f.snapshot.states[0][field], before[field]);
  assert.equal(report.writesMayHaveOccurred, true);
  assert.equal((await f.service.status(request())).horizons[1].lastResult, 'LAST_RESULT_NO_PENDING');
  await assert.rejects(f.service.request(request()), { code: 'ML_UPDATE_RATE_LIMITED' });
});

test('live fenced attempt returns RUNNING without dispatch or lease mutation', async () => {
  const f = fixture(); await f.service.request(request());
  Object.assign(f.snapshot.states[0], { status: 'CLAIMED', leaseUntil: new Date(NOW.getTime() + 60000), leaseOwner: 'worker' });
  const before = structuredClone(f.snapshot.states);
  assert.equal((await f.service.request(request())).requestStatus, 'RUNNING');
  assert.equal(f.dispatches, 1);
  assert.deepEqual(f.snapshot.states, before);
  assert.equal((await f.service.status(request())).horizons[0].currentlyRunning, true);
});

for (const reason of ['NOT_MATURE', 'COOLDOWN_ACTIVE']) {
  test(`manual cannot bypass ${reason}`, async () => {
    const f = fixture(); await f.service.request(request());
    const row = f.snapshot.states[0];
    row.latestDataVersion = 84n;
    row.nextEligibleAt = new Date(NOW.getTime() - 1);
    if (reason === 'COOLDOWN_ACTIVE') {
      row.lastTrainedMatureOrigin = '2026-10-08';
      row.lastAttemptAt = new Date(NOW.getTime() - 3600000);
    }
    assert.equal((await f.service.status(request())).horizons[0].eligibility, reason);
    assert.equal(update.eligible(row, NOW), false);
    assert.equal(row.historicalCorrectionVersion, null);
  });
}

for (const [lastOutcome, expected] of Object.entries({ PROMOTED: 'LAST_RESULT_PROMOTED',
  REJECTED: 'LAST_RESULT_REJECTED', NO_PROMOTION_INSUFFICIENT_HISTORY: 'LAST_RESULT_INSUFFICIENT_HISTORY' })) {
  test(`status reports ${lastOutcome} without dropping ACTIVE`, async () => {
    const f = fixture(); await f.service.request(request());
    for (const row of f.snapshot.states) Object.assign(row, { manualPending: false,
      lastOutcome, lastAttemptAt: NOW, lastSuccessAt: NOW });
    const result = await f.service.status(request());
    assert.ok(result.horizons.every(row => row.lastResult === expected && row.activeModelVersion === 1));
  });
}

test('failed and generally ineligible results remain distinct', async () => {
  const f = fixture(); await f.service.request(request());
  Object.assign(f.snapshot.states[0], { lastFailureAt: NOW, manualPending: false });
  Object.assign(f.snapshot.states[1], { manualPending: false, lastManualEvaluatedAt: NOW, lastManualResult: 'NOT_MATURE' });
  assert.deepEqual((await f.service.status(request())).horizons.map(row => row.lastResult),
    ['LAST_RESULT_FAILED', 'NOT_ELIGIBLE_YET']);
});

test('coordinator closes only the requested non-running manual evaluation', async t => {
  const original = State.updateOne;
  t.after(() => { State.updateOne = original; });
  State.updateOne = async (filter, mutation) => {
    assert.deepEqual(filter, { businessId: config.businessId, scenarioId: config.scenarioId,
      horizonDays: 7, manualPending: true, manualRequestKey: 'request-one', status: { $ne: 'CLAIMED' } });
    assert.deepEqual(Object.keys(mutation.$set).sort(), ['lastManualEvaluatedAt', 'lastManualResult', 'manualPending']);
    assert.equal(mutation.$set.manualPending, false);
    return { modifiedCount: 1 };
  };
  assert.equal(await update.completeManualEvaluation({ businessId: config.businessId,
    scenarioId: config.scenarioId, horizonDays: 7, manualRequestKey: 'request-one', result: 'NOT_MATURE', now: NOW }), true);
  await assert.rejects(update.completeManualEvaluation({ result: 'PROMOTED' }), /Invalid manual evaluation result/);
});

for (const mode of ['ACK', 'FAIL', 'NEWER_REQUEST']) {
  test(`fenced ${mode} consumes only the captured manual request and preserves ACTIVE`, async t => {
    const f = fixture(); await f.service.request(request());
    const row = f.snapshot.states[0];
    Object.assign(row, { status: 'CLAIMED', leaseOwner: 'fixture', fencingToken: 1,
      leaseUntil: new Date(NOW.getTime() + 60000), claimedDataVersion: 83n,
      claimedMatureOrigin: row.latestMatureOrigin, claimedCorrectionVersion: null,
      claimedManualRequestKey: row.manualRequestKey, save: async () => {} });
    if (mode === 'NEWER_REQUEST') row.manualRequestKey = 'newer-request';
    const originalFind = State.findOne, originalSession = mongoose.startSession;
    t.after(() => { State.findOne = originalFind; mongoose.startSession = originalSession; });
    State.findOne = filter => {
      assert.equal(filter.fencingToken, 1); assert.equal(filter.status, 'CLAIMED');
      return { session: () => ({ setOptions: async () => row }) };
    };
    let commits = 0;
    mongoose.startSession = async () => ({ startTransaction() {}, commitTransaction: async () => { commits += 1; },
      inTransaction: () => true, abortTransaction: async () => {}, endSession: async () => {} });
    const input = { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays: 7,
      leaseOwner: 'fixture', fencingToken: 1, inputDataVersion: '83',
      processedMatureOrigin: row.claimedMatureOrigin, now: NOW };
    if (mode === 'FAIL') await update.failUpdate({ ...input, failureCode: 'TRAINING_FAILED' });
    else await update.ackUpdate({ ...input, outcome: 'NO_PROMOTION_INSUFFICIENT_HISTORY' });
    assert.equal(commits, 1);
    assert.equal(row.manualPending, mode === 'NEWER_REQUEST');
    assert.equal(row.lastManualResult, mode === 'NEWER_REQUEST' ? undefined
      : mode === 'FAIL' ? 'FAILED' : 'NO_PROMOTION_INSUFFICIENT_HISTORY');
    assert.equal(row.claimedManualRequestKey, null);
    assert.ok(f.snapshot.active.every(item => item.modelVersion === 1));
  });
}

test('dispatch throwing or dispatch bookkeeping failing never loses the accepted request', async () => {
  for (const step of ['network', 'bookkeeping']) {
    const f = fixture();
    if (step === 'bookkeeping') f.repository.recordDispatch = async () => { throw Error('private'); };
    const service = createForecastManualUpdateService({ repository: f.repository, clock: () => NOW,
      dispatch: async () => { if (step === 'network') throw Error('private'); return 'DISPATCHED'; } });
    const result = await service.request(request());
    assert.equal(result.requestStatus, 'REQUEST_ACCEPTED');
    assert.equal(result.dispatchStatus, 'DEFERRED');
    assert.ok(f.snapshot.states.every(row => row.manualPending));
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('server dispatch uses fixed workflow/main, no client input and sanitized failures', async () => {
  let calls = 0;
  const env = { FORECAST_GITHUB_ACTIONS_TOKEN: 'private-secret', FORECAST_GITHUB_REPOSITORY: 'owner/repo' };
  const dispatch = createWorkflowDispatcher({ env, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/repos/owner/repo/actions/workflows/forecast-ridge-auto-update.yml/dispatches');
    assert.deepEqual(JSON.parse(options.body), { ref: 'main', inputs: { mode: 'run' } });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer private-secret');
    return { status: 200 };
  } });
  assert.equal(await dispatch(), 'DISPATCHED'); assert.equal(calls, 1);
  assert.equal(await createWorkflowDispatcher({ env: {}, fetchImpl: () => assert.fail('network') })(), 'DEFERRED');
  assert.equal(await createWorkflowDispatcher({ env, fetchImpl: async () => { throw Error('private-secret'); } })(), 'DEFERRED');
});

test('production router uses real auth first and never exposes service exception messages', async () => {
  const router = createForecastMlUpdateRoutes({ service: { request: async () => { throw Error('private-secret'); } } });
  assert.equal(router.stack[0].handle, authenticate);
  assert.equal(router.stack[1].handle, checkBusinessAccess);
  let status, body;
  const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  await authenticate({ header: () => undefined }, res, () => assert.fail('must reject'));
  assert.equal(status, 401);
  const handler = router.stack.find(layer => layer.route?.path === '/request').route.stack.at(-1).handle;
  await handler(request(), res);
  assert.equal(status, 503);
  assert.deepEqual(body, { success: false, code: 'ML_UPDATE_UNAVAILABLE' });
});

test('HTTP authentication, status, tenant rejection, error sanitization and rate limit', async t => {
  const f = fixture(), app = express(); app.use(express.json());
  const auth = (req, res, next) => {
    if (!req.headers['x-fixture-auth']) return res.status(401).json({ success: false });
    req.user = { businessId: req.headers['x-fixture-business'] || config.businessId, _id: 'fixture' }; next();
  };
  app.use('/api/intelligence/forecast/ml-update', createForecastMlUpdateRoutes({ service: f.service,
    authenticateMiddleware: auth, businessAccessMiddleware: (req, res, next) => next() }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/intelligence/forecast/ml-update`;
  const call = (suffix, options = {}) => fetch(base + suffix, options);
  assert.equal((await call('/request', { method: 'POST' })).status, 401);
  const headers = { 'x-fixture-auth': 'yes', 'Content-Type': 'application/json' };
  assert.equal((await call('/request', { method: 'POST', headers, body: '{}' })).status, 202);
  const status = await call('/status', { headers });
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await status.json()).data.horizons[0].pending, true);
  assert.equal((await call('/request', { method: 'POST', headers: { ...headers, 'x-fixture-business': 'other' }, body: '{}' })).status, 403);
  for (let i = 0; i < 9; i += 1) assert.equal((await call('/request', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await call('/request', { method: 'POST', headers, body: '{}' })).status, 429);
  assert.equal(f.dispatches, 1);
});
