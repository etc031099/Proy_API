'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config/v3Operational');
const coordinator = require('../src/services/forecastMlUpdateCoordinator');
const { createCloudWorker } = require('../src/services/forecastCloudWorker');
const { createForecastManualUpdateService, createWorkflowDispatcher } = require('../src/services/forecastManualUpdateService');
const { createExecutionHistory, executionIdentityFromEnv } = require('../src/services/forecastExecutionHistory');
const { createForecastRidgeTrainingWorker } = require('../src/services/forecastRidgeTrainingWorker');
const registryModule = require('../src/services/forecastModelRegistryService');
const { verifyExecutionIndexes, provisionExecutionIndexes } = require('../src/services/forecastExecutionIndexes');
const { fixture } = require('./helpers/forecastExecutionFixture');
const NOW = new Date('2026-10-17T18:00:00Z');
const scope = { businessId: config.businessId, scenarioId: config.scenarioId };
const gh = { triggerSource: 'SCHEDULED', github: { repository: 'owner/repo', runId: '123', runAttempt: 1 } };
const invocation = { triggerSource: 'CLI', cliInvocationKey: 'stable-cli-invocation' };
const featureHash = '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5';
const policyHash = '522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3';

function state(horizonDays) {
  return { ...scope, horizonDays, status: 'PENDING', latestDataVersion: 84n, lastProcessedDataVersion: 83n,
    initialMatureOrigin: coordinator.matureOrigin('2026-10-15', horizonDays),
    latestMatureOrigin: coordinator.matureOrigin('2026-10-16', horizonDays),
    lastTrainedMatureOrigin: coordinator.matureOrigin('2026-10-15', horizonDays),
    observationsClosedThrough: '2026-10-16', lastDirtyAt: new Date('2026-10-17T15:00:00Z'),
    nextEligibleAt: new Date('2026-10-17T15:15:00Z'), lastAttemptAt: null, historicalCorrectionVersion: null, fencingToken: 0 };
}
function harness({ empty = false, decision = 'REJECTED', failHorizon = null, historyFailure = false, race = false } = {}) {
  const f = fixture(), states = empty ? [] : [state(7), state(14)], jobs = [], active = { 7: 1, 14: 1 };
  const generations = { 7: 1, 14: 1 }, session = { fixture: true }, calls = { fits: 0, promotions: 0, claims: 0 };
  async function transaction(fn) {
    const before = structuredClone({ executions: f.rows, jobs, states, active, generations });
    try { return await fn(session); }
    catch (error) {
      f.rows.splice(0, f.rows.length, ...before.executions); jobs.splice(0, jobs.length, ...before.jobs);
      states.splice(0, states.length, ...before.states); Object.assign(active, before.active); Object.assign(generations, before.generations);
      throw error;
    }
  }
  const chain = read => ({ session() { return this; }, select() { return this; }, lean: async () => structuredClone(read()) });
  const pointerModel = { findOne: key => chain(() => ({ activeModelVersion: active[key.horizonDays], generation: generations[key.horizonDays] })) };
  const registry = { getActiveModelMetadata: async key => ({ modelVersion: active[key.horizonDays], trainedDataVersion: '83' }),
    createCandidateMetadata: async input => transaction(async s => {
      await input.onCreated(s, { modelVersion: 2 }); return { modelVersion: 2 };
    }),
    promoteCandidate: async input => transaction(async s => {
      if (generations[input.horizonDays] !== input.expectedGeneration) throw Object.assign(new Error(), { code: 'CONFLICT' });
      active[input.horizonDays] = input.modelVersion; generations[input.horizonDays]++;
      await input.onPromoted(s); calls.promotions++;
    }),
    rejectCandidate: async input => transaction(async s => input.onTransition(s)),
    markCandidateFailed: async input => transaction(async s => input.onTransition(s)),
  };
  const jobModel = {
    findOneAndUpdate: (filter, change) => chain(() => {
      let row = jobs.find(j => j.trainingKey === filter.trainingKey && j.horizonDays === filter.horizonDays);
      if (!row) { row = { _id: `job-${filter.horizonDays}`, ...change.$setOnInsert }; jobs.push(row); }
      Object.assign(row, change.$set); return row;
    }),
    updateOne: (filter, change) => ({ exec: async () => {
      const row = jobs.find(j => j._id === filter._id); if (row) Object.assign(row, change.$set);
      return { matchedCount: row ? 1 : 0 };
    } }),
    findById: id => chain(() => jobs.find(j => j._id === id)),
  };
  const update = { ...coordinator,
    claimEligibleUpdate: async input => {
      calls.claims++; const row = states.find(s => s.horizonDays === input.horizonDays);
      if (!row) return null;
      Object.assign(row, { status: 'CLAIMED', leaseUntil: new Date(NOW.getTime() + 300000), leaseOwner: input.leaseOwner });
      return { ...scope, horizonDays: input.horizonDays, inputDataVersion: '84', observationsClosedThrough: '2026-10-16',
        latestMatureOrigin: coordinator.matureOrigin('2026-10-16', input.horizonDays), fencingToken: 1, leaseOwner: input.leaseOwner };
    },
    exportOperationalChanges: async input => { await input.onPage([]); return { complete: true }; },
    ackUpdate: async input => transaction(async s => {
      await input.onFinish(s); const row = states.find(value => value.horizonDays === input.horizonDays);
      Object.assign(row, { status: 'IDLE', manualPending: false, lastProcessedDataVersion: 84n,
        lastTrainedMatureOrigin: row.latestMatureOrigin }); return true;
    }),
    failUpdate: async input => { const row = states.find(value => value.horizonDays === input.horizonDays); row.status = 'PENDING'; row.manualPending = false; return true; },
    completeManualEvaluation: async input => { const row = states.find(value => value.horizonDays === input.horizonDays); row.manualPending = false; },
  };
  const service = historyFailure ? { ...f.service, withSession: s => {
    const bound = f.service.withSession(s);
    return { ...bound, recordHorizonResult: async input => {
      if (input.result.resultStatus === 'PROMOTED') throw new Error('private-db-secret');
      return bound.recordHorizonResult(input);
    } };
  } } : f.service;
  // Existing transaction seam, no database, subprocess, model fit or cloud call.
  const original = registryModule.inBoundedTransaction;
  registryModule.inBoundedTransaction = transaction;
  const worker = createForecastRidgeTrainingWorker({ registry, update, pointerModel, jobModel,
    executionHistory: service, clock: () => NOW, log: () => {},
    stateModel: { updateOne: () => ({ exec: async () => ({ matchedCount: 1 }) }) },
    beforePromotion: race ? async () => { active[7] = 3; generations[7] = 3; } : undefined,
    runTraining: async input => {
      calls.fits++;
      if (input.horizonDays === failHorizon) throw new Error('mongodb://secret/password');
      const selected = typeof decision === 'object' ? decision[input.horizonDays] : decision;
      const status = selected === 'INSUFFICIENT' ? 'INSUFFICIENT_EVALUATION_HISTORY' : selected;
      return { evaluationStatus: status, featureHash, promotionPolicyHash: policyHash, trainedDataVersion: '84',
        sourceDatasetHash: 'a'.repeat(64), promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
        checks: { policyHash, status, protocol: { status: 'READY', requiredOrigins: 107, availableOrigins: 107,
          observationsClosedThrough: input.observationsClosedThrough, horizonDays: input.horizonDays, foldLengths: [31, 30, 46] },
        checks: { safe: status === 'PASS' }, reasons: status === 'PASS' ? [] : ['NO_IMPROVEMENT'], catastrophicVeto: [] },
        artifact: status === 'INSUFFICIENT_EVALUATION_HISTORY' ? undefined : { modelVersion: null,
          ...scope, horizonDays: input.horizonDays, featureHash }, parityMaxAbsoluteError: 0 };
    } });
  registryModule.inBoundedTransaction = original;
  const readState = async h => structuredClone(states.find(s => s.horizonDays === h) || null);
  const preflight = async () => ({ dataVersion: '84', activeModels: [7, 14].map(horizonDays => ({ horizonDays,
    modelVersion: active[horizonDays], trainedDataVersion: '83' })),
  promotionReadiness: Object.fromEntries([7, 14].map(h => [h, { status: 'READY', availableOrigins: 107, requiredOrigins: 107 }])) });
  const cycle = (identity = gh, override = {}) => {
    const history = createExecutionHistory({ service: f.service, scope, identity, readState, registry, update, clock: () => NOW });
    const runner = createCloudWorker({ preflight, readState, update, executionHistory: history, clock: () => NOW,
      completeManualEvaluation: update.completeManualEvaluation, runEligible: worker.runEligible, ...override });
    return { runner, history };
  };
  const manualRepo = { history: f.service, read: async () => ({ dataVersion: '84', states,
    active: [7, 14].map(horizonDays => ({ horizonDays, modelVersion: active[horizonDays], trainedDataVersion: '83', labelClosedThrough: '2026-10-15' })) }),
  transaction: async (_scope, fn) => transaction(async () => fn({ ...await manualRepo.read(), history: f.service,
    put: async row => { const i = states.findIndex(s => s.horizonDays === row.horizonDays); states[i] = row; } })),
  recordDispatch: async () => {} };
  return { ...f, states, jobs, active, calls, cycle, manualRepo, update };
}

test('manual request creates REQUESTED once, sends only opaque correlation and preserves DEFERRED', async () => {
  const f = harness(); let dispatched;
  const api = createForecastManualUpdateService({ repository: f.manualRepo, clock: () => NOW,
    dispatch: async input => { dispatched = input; return 'DEFERRED'; } });
  await api.request({ user: { businessId: scope.businessId }, body: {}, query: {} });
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].status, 'DEFERRED');
  assert.deepEqual(dispatched, { manualRequestKey: f.rows[0].manualRequestKey });
  await api.request({ user: { businessId: scope.businessId }, body: {}, query: {} });
  assert.equal(f.rows.length, 1);
});

test('an audit read failure after commit cannot turn a durable accepted request into POST failure', async () => {
  const f = harness();
  f.manualRepo.history = { ...f.service, findExecutionByManualRequest: async () => { throw new Error('private outage'); } };
  const api = createForecastManualUpdateService({ repository: f.manualRepo, clock: () => NOW, dispatch: async () => 'DEFERRED' });
  const response = await api.request({ user: { businessId: scope.businessId }, body: {}, query: {} });
  assert.equal(response.requestStatus, 'REQUEST_ACCEPTED'); assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].status, 'REQUESTED'); assert.ok(f.states.every(s => s.manualPending));
});

for (const source of ['MANUAL', 'SCHEDULED']) test(`${source} processes the existing manual execution without losing request origin`, async () => {
  const f = harness();
  const api = createForecastManualUpdateService({ repository: f.manualRepo, clock: () => NOW, dispatch: async () => 'DISPATCHED' });
  await api.request({ user: { businessId: scope.businessId }, body: {}, query: {} });
  const id = f.rows[0].executionId, key = f.rows[0].manualRequestKey;
  await f.cycle({ ...gh, triggerSource: source, ...(source === 'MANUAL' ? { manualRequestKey: key } : {}) }).runner.run('RUN');
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].executionId, id);
  assert.equal(f.rows[0].requestSource, 'MANUAL'); assert.equal(f.rows[0].triggerSource, source);
  assert.equal(f.rows[0].manualRequestKey, key);
});

test('schedule with no pending work records an explanatory terminal review without training', async () => {
  const f = harness({ empty: true }); await f.cycle().runner.run('RUN');
  assert.equal(f.rows[0].status, 'NO_PENDING_WORK'); assert.equal(f.calls.fits, 0);
  assert.equal(f.rows[0].impact.status, 'NOT_APPLICABLE'); assert.equal(f.rows[0].requiredOrigins, 107);
});

for (const mode of ['CHECK', 'STATUS']) test(`${mode} never creates history or claims`, async () => {
  const f = harness(); await f.cycle().runner.run(mode);
  assert.equal(f.rows.length, 0); assert.equal(f.calls.claims, 0);
});

test('CLI run uses explicit stable identity, persists once, and a repeated run is read-only', async () => {
  const f = harness({ empty: true }); await f.cycle(invocation).runner.run('RUN');
  const writes = f.counts.writes;
  await f.cycle(invocation).runner.run('RUN'); assert.equal(f.rows.length, 1); assert.equal(f.counts.writes, writes);
});

test('CLI resumes a recorded interruption on the same identity and preserves its earlier attempt', async () => {
  const f = harness({ empty: true }), first = f.cycle(invocation);
  await first.history.begin(); await first.history.interrupt();
  await f.cycle(invocation).runner.run('RUN');
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].status, 'NO_PENDING_WORK');
  assert.equal(f.rows[0].attempts[0].status, 'INTERRUPTED'); assert.equal(f.rows[0].attempts.length, 2);
});

test('CLI can consume an existing manual request without a second execution', async () => {
  const f = harness();
  const api = createForecastManualUpdateService({ repository: f.manualRepo, clock: () => NOW, dispatch: async () => 'DEFERRED' });
  await api.request({ user: { businessId: scope.businessId }, body: {}, query: {} });
  await f.cycle(invocation).runner.run('RUN');
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].requestSource, 'MANUAL');
  assert.equal(f.rows[0].triggerSource, 'CLI');
  await f.cycle(invocation).runner.run('RUN'); assert.equal(f.rows.length, 1);
});

test('operator workflow_dispatch can consume a manual request while preserving its real CLI origin', async () => {
  const f = harness();
  const api = createForecastManualUpdateService({ repository: f.manualRepo, clock: () => NOW, dispatch: async () => 'DEFERRED' });
  await api.request({ user: { businessId: scope.businessId }, body: {}, query: {} });
  await f.cycle({ ...gh, triggerSource: 'CLI', cliInvocationKey: 'github-123' }).runner.run('RUN');
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].requestSource, 'MANUAL');
  assert.equal(f.rows[0].triggerSource, 'CLI'); assert.equal(f.rows[0].github.runId, '123');
});

test('a stale run cannot close a newer GitHub attempt', async () => {
  const f = harness({ empty: true }), first = f.cycle(); await first.history.begin();
  const second = f.cycle({ ...gh, github: { ...gh.github, runAttempt: 2 } });
  await second.history.begin();
  await assert.rejects(first.history.interrupt(), { code: 'EXECUTION_CONFLICT' });
  assert.equal(f.rows[0].status, 'RUNNING'); assert.equal(f.rows[0].github.runAttempt, 2);
  await second.history.interrupt();
});

test('a higher GitHub attempt cannot bypass a live coordinator lease', async () => {
  const f = harness(), first = f.cycle(); await first.history.begin();
  f.states[0].status = 'CLAIMED'; f.states[0].leaseUntil = new Date(NOW.getTime() + 300000);
  await assert.rejects(f.cycle({ ...gh, github: { ...gh.github, runAttempt: 2 } }).history.begin(), { code: 'LEASE_ACTIVE' });
  assert.equal(f.rows[0].github.runAttempt, 1);
});

test('unknown origins stay null rather than being synthesized', async () => {
  const f = harness({ empty: true }), cycle = f.cycle(); await cycle.history.begin();
  await cycle.history.preflight({ dataVersion: '84' });
  for (const horizonDays of [7, 14]) await cycle.history.horizon({ horizonDays, activeModelVersionAtPreflight: 1,
    result: 'NO_PENDING_WORK', eligibility: 'NO_PENDING_WORK' });
  await cycle.history.finish(); assert.ok(f.rows[0].perHorizon.every(h => h.availableOrigins === null && h.requiredOrigins === 107));
});

test('later GitHub attempt does not erase an earlier promoted pair or invent another promotion', async () => {
  const f = harness({ decision: 'PASS' }); await f.cycle().runner.run('RUN');
  await f.cycle({ ...gh, github: { ...gh.github, runAttempt: 2 } }).runner.run('RUN');
  assert.equal(f.rows[0].status, 'NO_PENDING_WORK');
  assert.ok(f.rows[0].attempts[0].perHorizon.every(h => h.resultStatus === 'PROMOTED'));
  assert.equal(f.rows[0].attempts[0].impact.status, 'PENDING'); assert.equal(f.calls.promotions, 2);
});

test('same GitHub run is idempotent and a higher attempt preserves previous results', async () => {
  const f = harness({ empty: true }); await f.cycle().runner.run('RUN');
  await f.cycle().runner.run('RUN'); assert.equal(f.rows.length, 1);
  const before = structuredClone(f.rows[0].attempts[0]);
  await f.cycle({ ...gh, github: { ...gh.github, runAttempt: 2 } }).runner.run('RUN');
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].attempts.length, 2);
  assert.deepEqual(f.rows[0].attempts[0], before);
});

test('two concurrent starts have one ownership winner', async () => {
  const f = harness({ empty: true });
  const results = await Promise.allSettled([f.cycle().history.begin(), f.cycle().history.begin()]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && !r.value.duplicate).length, 1);
  assert.equal(f.rows.length, 1);
});

test('NOT_MATURE stores known origins and does not train', async () => {
  const f = harness();
  f.states.forEach(s => { s.lastTrainedMatureOrigin = s.latestMatureOrigin; });
  await f.cycle().runner.run('RUN'); assert.equal(f.rows[0].status, 'NOT_ELIGIBLE');
  assert.ok(f.rows[0].perHorizon.every(h => h.availableOrigins === 107 && h.requiredOrigins === 107));
  assert.equal(f.calls.fits, 0);
});

for (const decision of ['PASS', 'REJECTED', 'INSUFFICIENT']) test(`real worker hooks audit ${decision} without invoking Python`, async () => {
  const f = harness({ decision }); await f.cycle().runner.run('RUN');
  const row = f.rows[0];
  assert.equal(row.status, decision === 'PASS' ? 'PROMOTED' : 'EVALUATED_NO_PROMOTION');
  assert.deepEqual(row.perHorizon.map(h => h.trainingJobReference), ['job-7', 'job-14']);
  assert.deepEqual(row.perHorizon.map(h => h.activeVersionBefore), [1, 1]);
  assert.deepEqual(row.perHorizon.map(h => h.activeVersionAfter), decision === 'PASS' ? [2, 2] : [1, 1]);
  assert.equal(row.impact.status, decision === 'PASS' ? 'PENDING' : 'NOT_APPLICABLE');
  assert.ok(row.perHorizon.every(h => h.horizonDays !== 1 && h.trainedDataVersion === '84'));
});

test('mixed promotion/non-promotion is PARTIAL with exact Registry versions', async () => {
  const f = harness({ decision: { 7: 'PASS', 14: 'REJECTED' } }); await f.cycle().runner.run('RUN');
  assert.equal(f.rows[0].status, 'PARTIAL'); assert.deepEqual(f.active, { 7: 2, 14: 1 });
  assert.equal(f.rows[0].impact.status, 'PENDING');
});

test('one technical failure and one completed horizon is PARTIAL and secrets are absent', async () => {
  const f = harness({ failHorizon: 14 }); await f.cycle().runner.run('RUN');
  assert.equal(f.rows[0].status, 'PARTIAL');
  assert.deepEqual(f.rows[0].perHorizon.map(h => h.resultStatus), ['EVALUATED_NO_PROMOTION', 'FAILED']);
  assert.doesNotMatch(JSON.stringify(f.rows), /mongodb|password|secret/);
});

test('failure writing promotion history rolls back Registry promotion in the same session', async () => {
  const f = harness({ decision: 'PASS', historyFailure: true }); await f.cycle().runner.run('RUN');
  assert.deepEqual(f.active, { 7: 1, 14: 1 }); assert.equal(f.calls.promotions, 0);
  assert.ok(f.rows[0].perHorizon.every(h => h.resultStatus === 'FAILED'));
});

test('a Registry race never turns a late version into the execution before version', async () => {
  const f = harness({ decision: 'PASS', race: true }); await f.cycle().runner.run('RUN');
  assert.equal(f.rows[0].perHorizon[0].activeVersionBefore, 1);
  assert.equal(f.rows[0].perHorizon[0].activeVersionAfter, 3);
  assert.equal(f.rows[0].perHorizon[0].resultStatus, 'FAILED');
});

test('preflight failure and interruption are recorded safely', async () => {
  const f = harness({ empty: true });
  await assert.rejects(f.cycle(gh, { preflight: async () => { throw new Error('private URI'); } }).runner.run('RUN'));
  assert.equal(f.rows[0].status, 'FAILED'); assert.doesNotMatch(JSON.stringify(f.rows), /private URI/);
  const next = f.cycle({ ...gh, github: { ...gh.github, runId: '456' } });
  await next.history.begin(); await next.history.interrupt(); assert.equal(f.rows[1].status, 'INTERRUPTED');
});

test('correlation input cannot select an arbitrary or foreign request', async () => {
  const f = harness();
  await assert.rejects(f.cycle({ ...gh, triggerSource: 'MANUAL', manualRequestKey: 'not-durable' }).runner.run('RUN'),
    { code: 'MANUAL_CORRELATION_INVALID' });
  assert.equal(f.rows.length, 0); assert.equal(f.calls.claims, 0);
});

test('identity is explicit outside GitHub and schedule identity uses trusted scope separately', () => {
  assert.throws(() => executionIdentityFromEnv({}), { code: 'CLI_INVOCATION_KEY_REQUIRED' });
  assert.deepEqual(executionIdentityFromEnv({ FORECAST_WORKER_INVOCATION_KEY: 'recoverable-1' }),
    { triggerSource: 'CLI', cliInvocationKey: 'recoverable-1' });
  const value = executionIdentityFromEnv({ GITHUB_EVENT_NAME: 'schedule', GITHUB_REPOSITORY: 'Owner/Repo',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(value.triggerSource, 'SCHEDULED'); assert.equal(value.github.runAttempt, 2);
  assert.ok(!value.businessId && !value.scenarioId);
});

test('dispatcher sends opaque correlation without tenant or commercial payload', async () => {
  let body;
  const dispatch = createWorkflowDispatcher({ env: { FORECAST_GITHUB_ACTIONS_TOKEN: 'test-secret', FORECAST_GITHUB_REPOSITORY: 'owner/repo' },
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { status: 204 }; } });
  await dispatch({ manualRequestKey: 'opaque-1' });
  assert.deepEqual(body.inputs, { mode: 'run', manualRequestKey: 'opaque-1' });
});

test('index provisioning is additive; verification alone never creates or drops', async () => {
  const Model = require('../src/models/ForecastMlUpdateExecution'), calls = [];
  const model = { schema: Model.schema, collection: { indexes: async () => Model.schema.indexes().map(([key, options]) => ({ key, ...options })) },
    createCollection: async () => calls.push('collection'), createIndexes: async () => calls.push('indexes') };
  await verifyExecutionIndexes(model); assert.deepEqual(calls, []);
  await provisionExecutionIndexes(model); assert.deepEqual(calls, ['collection', 'indexes']);
  await assert.rejects(verifyExecutionIndexes({ ...model, collection: { indexes: async () => [] } }), { code: 'ML_HISTORY_NOT_READY' });
});
