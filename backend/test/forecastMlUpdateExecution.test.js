'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../src/models/ForecastMlUpdateExecution');
const D = require('../src/services/forecastMlUpdateExecutionDomain');
const { createForecastMlUpdateExecutionService, productionRepository } = require('../src/services/forecastMlUpdateExecutionService');
const scope = { businessId: 'tenant-A', scenarioId: 'scenario-A' };
const manual = { ...scope, triggerSource: 'MANUAL', manualRequestKey: 'manual-1' };
const github = { ...scope, triggerSource: 'SCHEDULED', github: { repository: 'owner/repo', runId: '123', runAttempt: 1 } };
const get = (row, extra = {}) => ({ businessId: row.businessId, scenarioId: row.scenarioId,
  executionId: row.executionId, expectedVersion: row.writeVersion, ...extra });
const nested = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => nested(row, key) === value);

// Offline contract repository. Uses actual Mongoose validation and actual index
// definitions; emulates unique insertion/CAS, not a real Mongo query planner.
function fixture() {
  const rows = [], counts = { reads: 0, writes: 0 }, filters = [];
  const uniqueIndexes = Model.schema.indexes().filter(([, options]) => options.unique);
  const repository = {
    async find(filter) { counts.reads++; filters.push(filter); return structuredClone(rows.find(row => matches(row, filter)) || null); },
    async insert(row) {
      await new Model(row).validate();
      for (const [keys, options] of uniqueIndexes) {
        const partial = options.partialFilterExpression;
        if (partial && !Object.keys(partial).every(key => typeof nested(row, key) === 'string')) continue;
        if (rows.some(other => Object.keys(keys).every(key => nested(row, key) === nested(other, key)))) {
          throw Object.assign(new Error('duplicate'), { code: 11000 });
        }
      }
      counts.writes++; rows.push(structuredClone(row)); return structuredClone(row);
    },
    async replace(filterScope, executionId, version, values) {
      filters.push({ ...filterScope, executionId, writeVersion: version });
      const index = rows.findIndex(row => matches(row, { ...filterScope, executionId, writeVersion: version }));
      if (index < 0) return null;
      const next = { ...structuredClone(rows[index]), writeVersion: version + 1 };
      for (const [key, value] of Object.entries(values)) {
        if (key.startsWith('github.')) { next.github ||= {}; next.github[key.slice(7)] = value; }
        else next[key] = structuredClone(value);
      }
      await new Model(next).validate();
      // Simulate an atomic CAS even when validation yielded to another caller.
      if (rows[index].writeVersion !== version) return null;
      rows[index] = next; counts.writes++; return structuredClone(next);
    },
  };
  const service = createForecastMlUpdateExecutionService({ repository, clock: () => new Date('2026-10-17T18:00:00Z') });
  return { service, repository, rows, counts, filters };
}

const running = async (f, input = manual) => f.service.startExecution(get(await f.service.createExecution(input)));
const outcome = (horizonDays, resultStatus = 'EVALUATED_NO_PROMOTION') => ({ horizonDays, resultStatus,
  activeVersionBefore: 1, activeVersionAfter: resultStatus === 'PROMOTED' ? 2 : 1,
  candidateVersion: 2, candidateStatus: resultStatus === 'PROMOTED' ? 'ACTIVE' : 'REJECTED',
  promotionDecision: resultStatus === 'PROMOTED' ? 'PROMOTED' : 'NOT_PROMOTED',
  promotionReason: resultStatus === 'PROMOTED' ? 'PROMOTED' : 'POLICY_FAILED', policyVersion: D.POLICY_VERSION });
async function pair(f, row, statuses) {
  for (const [index, h] of [7, 14].entries()) row = await f.service.recordHorizonResult(get(row, { result: outcome(h, statuses[index]) }));
  return row;
}

for (const [label, input] of [['manual', manual], ['scheduled', github],
  ['CLI', { ...scope, triggerSource: 'CLI', cliInvocationKey: 'cli-1' }]]) {
  test(`creates ${label} execution with opaque id, policy 107 and only 7/14`, async () => {
    const f = fixture(), row = await f.service.createExecution(input);
    assert.match(row.executionId, /^[a-f0-9-]{36}$/);
    assert.equal(row.status, 'REQUESTED'); assert.equal(row.requiredOrigins, 107);
    assert.deepEqual(row.perHorizon.map(h => h.horizonDays), [7, 14]);
    assert.equal(row.impact.status, 'NOT_APPLICABLE');
    assert.equal(f.rows.length, 1); assert.ok(!('_id' in row));
  });
  test(`${label} repeated create is idempotent`, async () => {
    const f = fixture(); const first = await f.service.createExecution(input);
    const next = await f.service.createExecution(input);
    assert.equal(first.executionId, next.executionId); assert.equal(f.counts.writes, 1);
  });
}

test('20 concurrent duplicate creates recover the unique-index winner', async () => {
  const f = fixture(), rows = await Promise.all(Array.from({ length: 20 }, () => f.service.createExecution(manual)));
  assert.equal(new Set(rows.map(row => row.executionId)).size, 1);
  assert.equal(f.rows.length, 1); assert.equal(f.counts.writes, 1);
});

test('GitHub attempt 2 retains attempt 1 and its horizon outcomes on the same execution', async () => {
  const f = fixture(); let row = await running(f, github);
  row = await pair(f, row, ['PROMOTED', 'EVALUATED_NO_PROMOTION']);
  row = await f.service.markPartial(get(row, { reasonCode: 'PARTIAL_HORIZON_RESULT' }));
  const oldAttempt = structuredClone(row.attempts[0]);
  const second = await f.service.createExecution({ ...github, github: { ...github.github, runAttempt: 2 } });
  assert.equal(second.executionId, row.executionId); assert.equal(f.rows.length, 1);
  assert.deepEqual(second.attempts[0], oldAttempt);
  assert.deepEqual(second.attempts.map(a => a.runAttempt), [1, 2]);
  assert.equal(second.status, 'REQUESTED');
  assert.equal((await f.service.createExecution(github)).github.runAttempt, 2);
  assert.equal((await f.service.createExecution({ ...github, github: { ...github.github, runAttempt: 2 } })).attempts.length, 2);
});

test('a new GitHub attempt cannot overlap an unfinished attempt', async () => {
  const f = fixture(); await running(f, github);
  await assert.rejects(f.service.createExecution({ ...github, github: { ...github.github, runAttempt: 2 } }),
    { code: 'PREVIOUS_ATTEMPT_NOT_FINISHED' });
});

test('concurrent registration of the same GitHub retry remains idempotent', async () => {
  const f = fixture();
  let row = await running(f, github);
  row = await f.service.markInterrupted(get(row));
  const retries = await Promise.all(Array.from({ length: 5 }, () => f.service.createExecution({
    ...github, github: { ...github.github, runAttempt: 2 } })));
  assert.ok(retries.every(retry => retry.executionId === row.executionId && retry.attempts.length === 2));
  assert.equal(f.rows.length, 1);
});

test('GitHub lookup is tenant/scenario scoped, with independent identical run IDs allowed', async () => {
  const f = fixture(); await f.service.createExecution(github);
  for (const other of [{ businessId: 'tenant-B' }, { scenarioId: 'scenario-B' }]) {
    const input = { ...scope, ...other, repository: 'owner/repo', runId: '123' };
    assert.equal(await f.service.findExecutionByGithubRun(input), null);
    const created = await f.service.createExecution({ ...github, ...other });
    assert.equal((await f.service.findExecutionByGithubRun(input)).executionId, created.executionId);
  }
});

test('earlier attempt keeps evaluation revision and impact metadata when a retry starts', async () => {
  const f = fixture(); let row = await running(f, github);
  row = await pair(f, row, ['PROMOTED', 'PROMOTED']);
  row = await f.service.markPromoted(get(row, { data: { dataVersionEvaluated: '9007199254740993', observationsClosedThrough: '2026-10-16' } }));
  row = await f.service.setImpactStatus(get(row, { status: 'NOT_CAPTURED', reasonCode: 'IMPACT_NOT_CAPTURED' }));
  row = await f.service.createExecution({ ...github, github: { ...github.github, runAttempt: 2 } });
  assert.equal(row.attempts[0].dataVersionEvaluated, '9007199254740993');
  assert.equal(row.attempts[0].impact.status, 'NOT_CAPTURED');
  assert.equal(row.impact.status, 'NOT_APPLICABLE');
});

test('a horizon cannot move backwards or contradict promotion', async () => {
  const f = fixture(); let row = await running(f);
  row = await f.service.recordHorizonResult(get(row, { result: { horizonDays: 7, resultStatus: 'RUNNING' } }));
  await assert.rejects(f.service.recordHorizonResult(get(row, { result: { horizonDays: 7, resultStatus: 'REQUESTED' } })),
    { code: 'INVALID_HORIZON_TRANSITION' });
  await assert.rejects(f.service.recordHorizonResult(get(row, { result: { ...outcome(7), promotionDecision: 'PROMOTED' } })),
    { code: 'INVALID_PROMOTION_RESULT' });
});

test('attempt count is bounded and earlier attempts are never silently discarded', async () => {
  const f = fixture(); let row = await f.service.createExecution(github);
  for (let attempt = 1; attempt <= D.MAX_ATTEMPTS; attempt++) {
    row = await f.service.markInterrupted(get(row, { reasonCode: 'EXECUTION_INTERRUPTED' }));
    if (attempt < D.MAX_ATTEMPTS) row = await f.service.createExecution({ ...github, github: { ...github.github, runAttempt: attempt + 1 } });
  }
  await assert.rejects(f.service.registerGithubAttempt(get(row, { runAttempt: D.MAX_ATTEMPTS + 1 })),
    { code: 'EXECUTION_ATTEMPT_LIMIT' });
  assert.equal(f.rows[0].attempts.length, D.MAX_ATTEMPTS);
});

for (const changedScope of [{ businessId: 'tenant-B' }, { scenarioId: 'scenario-B' }]) {
  test(`read, identity lookup and updates isolate ${Object.keys(changedScope)[0]}`, async () => {
    const f = fixture(), row = await f.service.createExecution(manual);
    assert.equal(await f.service.getExecution({ ...get(row), ...changedScope }), null);
    assert.equal(await f.service.findExecutionByManualRequest({ ...scope, ...changedScope, manualRequestKey: 'manual-1' }), null);
    await assert.rejects(f.service.startExecution({ ...get(row), ...changedScope }), { code: 'EXECUTION_NOT_FOUND' });
    assert.equal(f.counts.writes, 1);
    const separate = await f.service.createExecution({ ...manual, ...changedScope });
    assert.notEqual(separate.executionId, row.executionId);
  });
}

test('every operation requires explicit business and scenario scope', async () => {
  const f = fixture();
  await assert.rejects(f.service.getExecution({ executionId: 'x' }), { code: 'INVALID_EXECUTION_IDENTITY' });
  await assert.rejects(f.service.findExecutionByGithubRun({ businessId: 'A', repository: 'x/y', runId: '1' }),
    { code: 'INVALID_EXECUTION_IDENTITY' });
});

test('large revision strings are preserved and numeric revision coercion is rejected', async () => {
  const f = fixture(), revision = '9007199254740993';
  let row = await f.service.createExecution({ ...manual, dataVersionBefore: revision });
  row = await f.service.startExecution(get(row, { data: { dataVersionEvaluated: '9223372036854775807' } }));
  assert.equal(row.dataVersionBefore, revision);
  assert.equal(row.dataVersionEvaluated, '9223372036854775807');
  await assert.rejects(f.service.createExecution({ ...manual, manualRequestKey: 'bad', dataVersionBefore: Number(revision) }),
    { code: 'INVALID_EXECUTION_DOCUMENT' });
});

test('schema rejects horizon 1, duplicate horizons and policy weakening', async () => {
  const f = fixture(), row = await f.service.createExecution(manual);
  for (const fields of [{ perHorizon: [{ horizonDays: 1, resultStatus: 'RUNNING' }] },
    { perHorizon: [{ horizonDays: 7, resultStatus: 'RUNNING' }, { horizonDays: 7, resultStatus: 'RUNNING' }] },
    { requiredOrigins: 1 }, { perHorizon: [{ horizonDays: 7, resultStatus: 'RUNNING', requiredOrigins: 1 }, row.perHorizon[1]] }]) {
    await assert.rejects(new Model({ ...row, ...fields }).validate());
  }
  const active = await f.service.startExecution(get(row));
  await assert.rejects(f.service.recordHorizonResult(get(active, { result: { horizonDays: 1, resultStatus: 'RUNNING' } })),
    { code: 'INVALID_EXECUTION_HORIZON' });
});

test('valid pending/deferred/running/terminal transitions are timestamped', async () => {
  const f = fixture(); let row = await f.service.createExecution(manual);
  row = await f.service.markPending(get(row)); row = await f.service.markDeferred(get(row));
  row = await f.service.startExecution(get(row)); row = await f.service.markNotEligible(get(row, {
    reasonCode: 'NOT_MATURE', data: { availableOrigins: 0, requiredOrigins: 107, pendingAfter: true,
      observationsClosedThrough: '2026-10-16', eligibility: 'NOT_MATURE' } }));
  assert.equal(row.status, 'NOT_ELIGIBLE'); assert.ok(row.startedAt); assert.ok(row.finishedAt);
  assert.equal(row.availableOrigins, 0); assert.equal(row.requiredOrigins, 107);
});

test('invalid transitions and restarting terminal execution without a new attempt are rejected', async () => {
  const f = fixture(), row = await f.service.createExecution(manual);
  await assert.rejects(f.service.markPromoted(get(row)), { code: 'INVALID_EXECUTION_TRANSITION' });
  const ended = await f.service.markInterrupted(get(row));
  await assert.rejects(f.service.startExecution(get(ended)), { code: 'INVALID_EXECUTION_TRANSITION' });
});

test('both no-promotion horizon outcomes persist without falsely claiming a new active version', async () => {
  const f = fixture(); let row = await pair(f, await running(f), ['EVALUATED_NO_PROMOTION', 'EVALUATED_NO_PROMOTION']);
  row = await f.service.markNoPromotion(get(row, { reasonCode: 'POLICY_FAILED' }));
  assert.equal(row.status, 'EVALUATED_NO_PROMOTION');
  assert.deepEqual(row.perHorizon.map(h => h.activeVersionAfter), [1, 1]);
});

test('promotion requires actual per-horizon evidence and impact metadata remains independent', async () => {
  const f = fixture(); let row = await running(f);
  await assert.rejects(f.service.markPromoted(get(row)), { code: 'HORIZON_RESULTS_REQUIRED' });
  row = await pair(f, row, ['PROMOTED', 'PROMOTED']);
  row = await f.service.markPromoted(get(row, { reasonCode: 'PROMOTED' }));
  for (const status of ['PENDING', 'COMPLETE', 'PARTIAL', 'NOT_CAPTURED']) {
    row = await f.service.setImpactStatus(get(row, { status, reasonCode: 'IMPACT_NOT_CAPTURED' }));
    assert.equal(row.status, 'PROMOTED');
    assert.deepEqual(row.perHorizon.map(h => [h.activeVersionBefore, h.activeVersionAfter]), [[1, 2], [1, 2]]);
  }
});

test('partial horizon result is retained and cannot be mislabeled global failure', async () => {
  const f = fixture(); let row = await pair(f, await running(f), ['PROMOTED', 'EVALUATED_NO_PROMOTION']);
  await assert.rejects(f.service.markFailed(get(row)), { code: 'PROMOTION_RESULT_MUST_BE_PRESERVED' });
  row = await f.service.markPartial(get(row));
  assert.equal(row.status, 'PARTIAL'); assert.equal(row.perHorizon[0].activeVersionAfter, 2);
  assert.equal(row.perHorizon[1].activeVersionAfter, 1);
});

test('no pending work is a recorded review, not an invented training or promotion', async () => {
  const f = fixture(); const row = await f.service.markNoPendingWork(get(await running(f), {
    reasonCode: 'NO_PENDING_WORK', data: { pendingBefore: false, pendingAfter: false } }));
  assert.equal(row.status, 'NO_PENDING_WORK'); assert.match(row.message, /revisó/);
  assert.ok(row.perHorizon.every(h => h.candidateVersion === null && h.trainingJobReference === null));
});

test('unsafe messages, unknown reason strings and extra sensitive fields are not persisted', async () => {
  const f = fixture(), secret = 'mongodb+srv://private:password@host/db JWT token secret';
  let row = await f.service.createExecution({ ...manual, message: secret, reasonCode: secret });
  assert.equal(row.reasonCode, 'UNKNOWN_REASON');
  row = await f.service.startExecution(get(row));
  row = await f.service.markFailed(get(row, { reasonCode: secret, message: secret }));
  assert.doesNotMatch(JSON.stringify(f.rows), /mongodb|password|JWT|token secret/);
  await assert.rejects(f.service.createExecution({ ...manual, token: secret }), { code: 'INVALID_EXECUTION_FIELDS' });
  assert.throws(() => new Model({ ...row, artifactData: secret }), { name: 'StrictModeError' });
});

test('reads are scoped and cause no writes, training, workflow or network calls', async () => {
  const f = fixture(), row = await f.service.createExecution(github), before = f.counts.writes;
  await f.service.getExecution(get(row));
  const found = await f.service.findExecutionByGithubRun({ ...scope, repository: 'OWNER/REPO', runId: '123' });
  assert.equal(found.executionId, row.executionId); assert.equal(f.counts.writes, before);
  assert.ok(f.filters.every(filter => filter.businessId && filter.scenarioId));
  assert.equal(require('mongoose').connection.readyState, 0);
});

test('two competing starts permit only one atomic state transition', async () => {
  const f = fixture(), row = await f.service.createExecution(manual);
  const replies = await Promise.allSettled([f.service.startExecution(get(row)), f.service.startExecution(get(row))]);
  assert.equal(replies.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(replies.find(r => r.status === 'rejected').reason.code, 'EXECUTION_CONFLICT');
});

test('concurrent horizon writes detect conflict; retry merges rather than losing the other horizon', async () => {
  const f = fixture(); let row = await running(f);
  const replies = await Promise.allSettled([7, 14].map(h => f.service.recordHorizonResult(get(row, { result: outcome(h) }))));
  assert.equal(replies.filter(r => r.status === 'fulfilled').length, 1);
  row = await f.service.getExecution(get(row));
  const remaining = row.perHorizon.find(h => h.resultStatus === 'REQUESTED').horizonDays;
  row = await f.service.recordHorizonResult(get(row, { result: outcome(remaining) }));
  assert.ok(row.perHorizon.every(h => h.resultStatus === 'EVALUATED_NO_PROMOTION'));
  await assert.rejects(f.service.recordHorizonResult(get(row, { result: outcome(7, 'PROMOTED') })), { code: 'HORIZON_RESULT_FINAL' });
});

test('promotion and no-promotion facts are cross-validated', async () => {
  const f = fixture(), row = await running(f);
  await assert.rejects(f.service.recordHorizonResult(get(row, { result: { ...outcome(7, 'PROMOTED'), activeVersionAfter: 1 } })),
    { code: 'INVALID_PROMOTION_RESULT' });
  await assert.rejects(f.service.recordHorizonResult(get(row, { result: { ...outcome(7), activeVersionAfter: 2 } })),
    { code: 'INVALID_NO_PROMOTION_RESULT' });
  await assert.rejects(f.service.setImpactStatus(get(row, { status: 'COMPLETE' })), { code: 'IMPACT_REQUIRES_PROMOTION' });
});

test('unique indexes include scope, omit runAttempt, and are partial for optional identities', () => {
  const indexes = Model.schema.indexes();
  for (const name of ['manual', 'github', 'cli']) {
    const [keys, spec] = indexes.find(([, options]) => options.name === `forecast_ml_execution_${name}_uq`);
    assert.equal(keys.businessId, 1); assert.equal(keys.scenarioId, 1);
    assert.equal(spec.unique, true); assert.ok(spec.partialFilterExpression);
    assert.ok(!Object.hasOwn(keys, 'github.runAttempt'));
  }
  assert.ok(indexes.some(([keys]) => keys.requestedAt === -1 && keys.executionId === -1));
  assert.ok(!indexes.some(([, options]) => options.expireAfterSeconds !== undefined));
});

test('production adapter applies scope/version CAS and returns duplicate-key errors for service recovery', async () => {
  const captured = [];
  const query = () => ({ select() { return this; }, lean() { return this; }, exec: async () => null });
  const repo = productionRepository({ findOne: filter => { captured.push(filter); return query(); },
    findOneAndUpdate: (filter, change, options) => { captured.push({ filter, change, options }); return query(); },
    create: async () => { throw Object.assign(new Error(), { code: 11000 }); } });
  await repo.find({ ...scope, executionId: 'example' });
  await repo.replace(scope, 'example', 3, { status: 'RUNNING' });
  assert.deepEqual(captured[1].filter, { ...scope, executionId: 'example', writeVersion: 3 });
  assert.deepEqual(captured[1].change.$inc, { writeVersion: 1 });
  assert.equal(captured[1].options.runValidators, true);
  await assert.rejects(repo.insert({}), { code: 11000 });
});
