'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const diagnostics = require('../src/automations/actionDiagnostics');
const { createActionService, hashArgs } = require('../src/automations/execution');
const { createActionRepository } = require('../src/automations/repository');
const { createAgentActionHandler } = require('../src/controllers/agentActionsController');
const { createActionContext, ActionError, randomUUID } = require('../src/automations/contracts');

function fixture(t, { execute, auditFailure = false, abortFailure = false, commitFailure = null, commitClearsTransaction = false, loggerFailure = false } = {}) {
  const logs = [], sessions = [];
  t.mock.method(console, 'error', value => { logs.push(JSON.parse(value)); if (loggerFailure) throw Error('logger unavailable'); });
  let tick = 0;
  t.mock.method(performance, 'now', () => tick);
  const id = randomUUID(), conversationId = randomUUID();
  const req = { businessId: 'A', user: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'A', isActive: true, role: 'user' } };
  const context = createActionContext(req, { conversationId });
  const args = { products: [{ productId: 'bbbbbbbbbbbbbbbbbbbbbbbb', quantity: 1 }], currency: 'PEN' };
  let row = { pendingActionId: id, actionSkillId: 'create_sale', validatedArgs: args, argsHash: hashArgs(args),
    status: 'PENDING', expiresAt: new Date(Date.now() + 600000), createdAt: new Date(), requiresConfirmation: true,
    preview: { fields: {} }, summary: 'Synthetic' };
  const model = { findOne() { let session;
    return { session(value) { session = value; return this; }, maxTimeMS() { return this; },
      then(resolve, reject) {
        const doc = { ...structuredClone(session.row), toObject() { return Object.fromEntries(Object.entries(this).filter(([, v]) => typeof v !== 'function')); },
          async save() { session.row = structuredClone(this.toObject()); } };
        return Promise.resolve(doc).then(resolve, reject);
      } };
  } };
  const repository = createActionRepository({ pendingModel: model,
    conversationModel: { exists: () => ({ maxTimeMS: async () => true }) },
    startSession: async () => {
      const session = { row: structuredClone(row), active: false, startTransaction() { this.active = true; }, inTransaction() { return this.active; },
        async commitTransaction() { if (commitFailure && sessions.length === 1) {
          if (commitClearsTransaction) this.active = false;
          throw commitFailure;
        }
          row = this.row; this.active = false; },
        async abortTransaction() { if (abortFailure) throw Error('private abort payload'); this.active = false; },
        async endSession() {} };
      sessions.push(session); return session;
    }, audit: async (_row, _context, status) => { if (auditFailure && status === 'EXECUTED') throw Error('private customer stack'); } });
  const service = createActionService({ repository, executors: { create_sale: { execute: async () => {
    if (execute) await execute(ms => { tick += ms; });
    return { id: 'cccccccccccccccccccccccc' };
  } } } });
  return { logs, id, context, service, req: { ...req, params: { id }, body: { conversationId } },
    confirm: () => service.confirmPendingAction(context, id), state: () => row, sessions };
}
const privateError = extra => Object.assign(new Error('token=secret payload args price customer stack mongodb://private'), extra);

test('deadline logs once, with unchanged 10s budget, original phase, fallback timing and confirmed rollback', async t => {
  const f = fixture(t, { execute: async advance => {
    await diagnostics.exchangeRate(true, async () => { advance(8000); return { source: 'fallback', rate: 3.7 }; });
    await diagnostics.observe('STOCK_UPDATE', 'MONGO', async () => advance(3230));
  } });
  await assert.rejects(f.confirm(), { code: 'ACTION_EXECUTION_FAILED' });
  assert.equal(f.logs.length, 1);
  const log = f.logs[0];
  assert.equal(log.event, 'agent_action_execution_failed'); assert.equal(log.actionId, f.id);
  assert.equal(log.failureCategory, 'EXECUTION_DEADLINE'); assert.equal(log.executionPhase, 'EXECUTION_BUDGET_CHECK');
  assert.equal(log.timeoutMs, 10000); assert.equal(log.budgetElapsedMs, 11230); assert.equal(log.executorDurationMs, 11230);
  assert.equal(log.durationMs, 11230); assert.equal(log.phaseDurationsMs.STOCK_UPDATE, 3230);
  assert.deepEqual(log.exchangeRate, { called: true, durationMs: 8000, fallbackUsed: true, respondedSuccessfully: false });
  assert.equal(log.rollbackStatus, 'CONFIRMED'); assert.equal(f.state().status, 'FAILED');
  await assert.rejects(f.confirm(), { code: 'ACTION_CONFLICT' }); assert.equal(f.logs.length, 1);
});

for (const [error, category] of [
  [privateError({ name: 'MongoServerError', code: 8000 }), 'MONGO_ERROR'],
  [privateError({ name: 'MongoServerError', code: 50 }), 'MONGO_TIMEOUT'],
  [privateError({ name: 'ValidationError' }), 'MODEL_VALIDATION'],
  [privateError({ name: 'Error', code: 'private-secret-code' }), 'INTERNAL_ERROR']
]) test(`original ${category} is sanitized before normalization and failure audit`, async t => {
  const f = fixture(t, { execute: () => diagnostics.observe('TRANSACTION_PERSIST', 'MONGO', () => { throw error; }) });
  await assert.rejects(f.confirm(), { code: 'ACTION_EXECUTION_FAILED' });
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0].failureCategory, category);
  assert.equal(f.logs[0].executionPhase, 'TRANSACTION_PERSIST'); assert.equal(f.logs[0].rollbackStatus, 'CONFIRMED');
  assert.equal(f.logs[0].mongoCode, [8000, 50].includes(error.code) ? error.code : null);
  assert.doesNotMatch(JSON.stringify(f.logs), /token|payload|args|price|customer|stack|secret|mongodb:\/\//i);
});

test('external exception records only the dependency category; successful HTTP rate is measured', async t => {
  const f = fixture(t, { execute: async advance => {
    await diagnostics.exchangeRate(true, async () => { advance(12); return { source: 'ExchangeRate-API', rate: 3.7 }; });
    await diagnostics.exchangeRate(true, async () => { advance(8); throw privateError({ name: 'AbortError' }); });
  } });
  await assert.rejects(f.confirm(), { code: 'ACTION_EXECUTION_FAILED' });
  assert.equal(f.logs[0].failureCategory, 'EXTERNAL_DEPENDENCY'); assert.equal(f.logs[0].dependency, 'EXCHANGE_RATE');
  assert.equal(f.logs[0].executionPhase, 'EXCHANGE_RATE'); assert.equal(f.logs[0].exchangeRate.durationMs, 20);
  assert.equal(f.logs[0].exchangeRate.respondedSuccessfully, false);
  assert.doesNotMatch(JSON.stringify(f.logs), /token|payload|args|price|customer|stack|secret/i);
});

test('audit phase remains the original failure and failed rollback is not reported as confirmed', async t => {
  const f = fixture(t, { auditFailure: true, abortFailure: true });
  await assert.rejects(f.confirm(), { code: 'ACTION_EXECUTION_FAILED' });
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0].executionPhase, 'AUDIT'); assert.equal(f.logs[0].rollbackStatus, 'FAILED');
});

for (const cleared of [false, true]) test(`commit failure preserves phase and reports ${cleared ? 'uncertain' : 'confirmed'} rollback`, async t => {
  const f = fixture(t, { commitFailure: privateError({ name: 'MongoServerError', code: 8000 }), commitClearsTransaction: cleared });
  await assert.rejects(f.confirm(), { code: 'ACTION_EXECUTION_FAILED' });
  assert.equal(f.logs[0].executionPhase, 'COMMIT');
  assert.equal(f.logs[0].rollbackStatus, cleared ? 'UNCERTAIN' : 'CONFIRMED');
});

for (const kind of [112, 251, 'TransientTransactionError', 'UnknownTransactionCommitResult']) test(`Mongo ${kind} preserves conflict mapping without an execution-failed log`, async t => {
  const f = fixture(t, { execute: () => { throw privateError({ name: 'MongoServerError',
    ...(typeof kind === 'number' ? { code: kind } : { hasErrorLabel: label => label === kind }) }); } });
  await assert.rejects(f.confirm(), { code: 'ACTION_CONFLICT' }); assert.equal(f.logs.length, 0); assert.equal(f.state().status, 'PENDING');
});

for (const ms of [10000, 10001]) test(`execution budget still uses strict greater-than at ${ms}ms`, async t => {
  const f = fixture(t, { execute: advance => advance(ms) });
  if (ms === 10000) { assert.equal((await f.confirm()).status, 'EXECUTED'); assert.equal(f.logs.length, 0); }
  else { await assert.rejects(f.confirm(), { code: 'ACTION_EXECUTION_FAILED' }); assert.equal(f.logs[0].failureCategory, 'EXECUTION_DEADLINE'); }
});

test('public HTTP body remains exactly 98 bytes and logging failure cannot change it', async t => {
  const f = fixture(t, { loggerFailure: true, execute: () => { throw privateError({}); } });
  let status, body;
  const res = { set() {}, status(value) { status = value; return this; }, json(value) { body = value; } };
  await createAgentActionHandler({ enabled: true, service: f.service, decision: 'confirm' })(f.req, res);
  assert.equal(status, 503);
  assert.deepEqual(body, { success: false, code: 'ACTION_EXECUTION_FAILED', message: 'No fue posible ejecutar la acción.' });
  assert.equal(Buffer.byteLength(JSON.stringify(body)), 98); assert.equal(f.logs.length, 1);
});

test('successful execution/repeated confirmation emits no failure log and reuses committed result', async t => {
  const f = fixture(t); const first = await f.confirm();
  assert.equal(first.status, 'EXECUTED'); assert.deepEqual((await f.confirm()).result, first.result); assert.equal(f.logs.length, 0);
});

test('enums reject untrusted phase/dependency strings and external errors never enter public responses', async t => {
  const logs = []; t.mock.method(console, 'error', value => logs.push(JSON.parse(value)));
  await assert.rejects(diagnostics.run(randomUUID(), async () => {
    diagnostics.phase('customer secret', 'token'); throw new ActionError('ACTION_EXECUTION_FAILED');
  }), { code: 'ACTION_EXECUTION_FAILED' });
  assert.equal(logs[0].executionPhase, 'ACTION_LOAD'); assert.equal(logs[0].dependency, 'MONGO');
  assert.doesNotMatch(JSON.stringify(logs), /customer|secret|token/);
});

test('parallel attempts keep failure phases and timings isolated', async t => {
  const logs = []; t.mock.method(console, 'error', value => logs.push(JSON.parse(value)));
  const ids = [randomUUID(), randomUUID()];
  await Promise.allSettled(ids.map((id, index) => diagnostics.run(id, () => diagnostics.observe(
    index ? 'AUDIT' : 'STOCK_UPDATE', 'MONGO', async () => {
      await new Promise(resolve => setImmediate(resolve)); throw privateError({});
    }))));
  assert.equal(logs.length, 2);
  assert.equal(logs.find(log => log.actionId === ids[0]).executionPhase, 'STOCK_UPDATE');
  assert.equal(logs.find(log => log.actionId === ids[1]).executionPhase, 'AUDIT');
  assert.notEqual(logs[0].attemptId, logs[1].attemptId);
});
