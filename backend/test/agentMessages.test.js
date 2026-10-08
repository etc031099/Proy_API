const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const createAgentRoutes = require('../src/routes/agent');
const { logAgentDiagnostic, logAgentProviderDiagnostic } = require('../src/controllers/agentMessagesController');
const conversationId = '11111111-1111-4111-8111-111111111111';
const fakeAuth = (req, res, next) => { req.user = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'TENANT-A', role: 'user', isActive: true }; next(); };
const access = (req, res, next) => { req.businessId = req.user.businessId; next(); };
const response = { requestId: '22222222-2222-4222-8222-222222222222', conversationId, answer: 'Resultado seguro', intent: 'low_stock', agent: 'operations', participants: [],
  actions: [], evidence: [], usage: { totalLlmCalls: 0, totalSkillCalls: 1, totalTokens: 0 },
  requiresClarification: false, clarificationQuestion: null, latencyMs: 15 };
async function setup(t, options = {}) {
  const runtime = options.orchestrator || { handle: async () => response };
  const app = express(); app.use(express.json());
  app.use('/api/agent', createAgentRoutes({ enabled: true, authenticateMiddleware: fakeAuth, businessAccessMiddleware: access,
    orchestrator: runtime, historyService: { send: (req, input) => runtime.handle(req, input) }, ...options }));
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return body => fetch(`http://127.0.0.1:${server.address().port}/api/agent/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}
test('messages requires real authentication', async t => {
  const post = await setup(t, { authenticateMiddleware: undefined });
  assert.equal((await post({ message: 'stock bajo' })).status, 401);
});
test('messages rejects denied business access', async t => {
  const post = await setup(t, { businessAccessMiddleware: (req, res) => res.sendStatus(403) });
  assert.equal((await post({ message: 'stock bajo' })).status, 403);
});
test('messages feature disabled does not invoke orchestrator', async t => {
  const post = await setup(t, { enabled: false, orchestrator: { handle() { assert.fail('must not run'); } } });
  assert.equal((await post({ message: 'stock bajo' })).status, 404);
});
test('messages trims, reuses conversation and derives tenant only from authenticated request', async t => {
  const post = await setup(t, { orchestrator: { async handle(req, input) {
    assert.equal(req.user.businessId, 'TENANT-A'); assert.equal(req.businessId, 'TENANT-A');
    assert.deepEqual(input, { message: 'stock bajo', conversationId });
    return { ...response, systemPrompt: 'private', apiKey: 'private' };
  } } });
  const res = await post({ message: ' stock bajo ', conversationId });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { success: true, data: response });
});
for (const [name, body] of [ ['missing', {}], ['empty', { message: ' ' }], ['short', { message: '?' }],
  ['not string', { message: 123 }], ['too long', { message: 'x'.repeat(2001) }], ['invalid conversation', { message: 'hi', conversationId: 'bad' }],
  ...['businessId', 'userId', 'agent', 'model', 'skills', 'apiKey', 'systemPrompt', 'role', 'tenant', 'tokenBudgets'].map(key => [key, { message: 'hello', [key]: 'forbidden' }]) ]) {
  test(`messages rejects ${name}`, async t => {
    const post = await setup(t, { orchestrator: { handle() { assert.fail('must not run'); } } });
    assert.equal((await post(body)).status, 400);
  });
}
test('clarification is normal success preserving conversationId', async t => {
  const post = await setup(t, { orchestrator: { async handle() { return { ...response, requiresClarification: true,
    clarificationQuestion: '¿Qué SKU?', code: 'AGENT_CLARIFICATION_REQUIRED' }; } } });
  const res = await post({ message: 'su stock' }); assert.equal(res.status, 200);
  const { data } = await res.json(); assert.equal(data.conversationId, conversationId); assert.equal(data.requiresClarification, true);
});
for (const [code, status] of [['AGENT_PROVIDER_FAILED', 503], ['AGENT_SKILL_FAILED', 503], ['AGENT_BUDGET_EXCEEDED', 429], ['AGENT_INTERNAL_ERROR', 500]]) {
  test(`messages maps ${code} without leaking errors`, async t => {
    const post = await setup(t, { orchestrator: { async handle() { throw Object.assign(new Error('secret/raw provider/stack'), { code }); } } });
    const res = await post({ message: 'hello' }); assert.equal(res.status, status);
    const data = await res.json(); assert.equal(data.code, code); assert.ok(!JSON.stringify(data).includes('secret')); assert.equal(data.stack, undefined);
  });
}
test('messages maps returned runtime failure and unknown thrown errors safely', async t => {
  const post = await setup(t, { orchestrator: { async handle() { return { code: 'AGENT_PROVIDER_FAILED', answer: 'secret' }; } } });
  assert.equal((await post({ message: 'hello' })).status, 503);
  const unknown = await setup(t, { orchestrator: { async handle() { throw new Error('secret'); } } });
  const res = await unknown({ message: 'hello' }); assert.equal(res.status, 500); assert.ok(!(await res.text()).includes('secret'));
});
test('internal diagnostic logger emits only allowlisted failure metadata', () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    logAgentDiagnostic({ type: 'error', requestId: '22222222-2222-4222-8222-222222222222',
      conversationId, agentRunId: '33333333-3333-4333-8333-333333333333',
      skillCallId: '44444444-4444-4444-8444-444444444444', agentId: 'analyst',
      skillId: 'get_replenishment_candidates', code: 'ML_SERVICE_UNAVAILABLE',
      internalCause: 'ML_SERVICE_UNAVAILABLE', skillDurationMs: 12, mlCallDurationMs: 10,
      timeoutMs: 10000, secret: 'must-not-log', payload: { password: 'never' } });
  } finally { console.error = original; }
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], '[AgentSkillDiagnostic]');
  assert.equal(logged[0][1].includes('ML_SERVICE_UNAVAILABLE'), true);
  assert.equal(logged[0][1].includes('must-not-log'), false);
  assert.equal(logged[0][1].includes('password'), false);
});
test('provider diagnostic logger emits safe Gemini metadata and excludes request/response contents', () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    logAgentProviderDiagnostic({ type: 'error', requestId: '22222222-2222-4222-8222-222222222222', conversationId,
      agentRunId: '33333333-3333-4333-8333-333333333333', agentId: 'analyst', model: 'gemini-3.8-flash',
      publicCode: 'AGENT_PROVIDER_FAILED', internalCause: 'GEMINI_PERMISSION_DENIED', providerStatus: 403,
      providerCode: 'PERMISSION_DENIED', finishReason: null, llmDurationMs: 90, timeoutMs: 15000,
      llmCallsBeforeFailure: 0, usageAvailable: false, metricsComplete: false, responseKind: 'unknown',
      candidateCount: 0, hasText: false, hasFunctionCall: false, hasUsageMetadata: false,
      prompt: 'do not log', output: 'do not log', headers: { Authorization: 'secret' }, apiKey: 'secret' });
    logAgentProviderDiagnostic({ type: 'error', internalCause: 'ML_SERVICE_UNAVAILABLE', secret: 'must not log' });
  } finally { console.error = original; }
  assert.equal(logged.length, 1); assert.equal(logged[0][0], '[AgentProviderDiagnostic]');
  const value = JSON.parse(logged[0][1]);
  assert.equal(value.publicCode, 'AGENT_PROVIDER_FAILED'); assert.equal(value.internalCause, 'GEMINI_PERMISSION_DENIED');
  assert.equal(value.providerStatus, 403); assert.equal(value.responseKind, 'unknown');
  const serialized = JSON.stringify(logged);
  for (const forbidden of ['do not log', 'Authorization', 'secret', 'headers', 'apiKey']) assert.equal(serialized.includes(forbidden), false);
});
test('provider diagnostic log distinguishes transient first failure from successful retry', () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  const base = { type: 'provider_attempt', requestId: '22222222-2222-4222-8222-222222222222', conversationId,
    agentRunId: '33333333-3333-4333-8333-333333333333', agentId: 'analyst', model: 'gemini-3.8-flash',
    timeoutMs: 15000, llmCallsBeforeFailure: 0, usageAvailable: false, metricsComplete: false };
  try {
    logAgentProviderDiagnostic({ ...base, providerAttempt: 1, providerAttempts: 1, status: 'FAILED',
      publicCode: null, internalCause: 'GEMINI_UNAVAILABLE', providerStatus: 503, providerCode: 'UNAVAILABLE',
      retryReason: 'GEMINI_UNAVAILABLE', retryScheduled: true, durationMs: 80, retryDelayMs: 1000,
      responseKind: 'empty', candidateCount: 0, hasText: false, hasFunctionCall: false, hasUsageMetadata: false });
    logAgentProviderDiagnostic({ ...base, providerAttempt: 2, providerAttempts: 2, status: 'SUCCEEDED',
      retryReason: 'GEMINI_UNAVAILABLE', retryScheduled: false, durationMs: 170,
      firstAttemptDurationMs: 80, retryDelayMs: 1000, secondAttemptDurationMs: 170, totalProviderDurationMs: 1250,
      responseKind: 'structured', candidateCount: 1, hasText: true, hasFunctionCall: false, hasUsageMetadata: true,
      output: 'must-not-log', prompt: 'must-not-log' });
    logAgentProviderDiagnostic({ ...base, providerAttempt: 1, providerAttempts: 1, status: 'SUCCEEDED' });
  } finally { console.error = original; }
  assert.equal(logged.length, 2);
  const first = JSON.parse(logged[0][1]); const second = JSON.parse(logged[1][1]);
  assert.equal(first.providerAttempt, 1); assert.equal(first.providerStatus, 503); assert.equal(first.retryScheduled, true);
  assert.equal(second.providerAttempt, 2); assert.equal(second.status, 'SUCCEEDED');
  assert.equal(second.retryDelayMs, 1000); assert.equal(second.totalProviderDurationMs, 1250);
  const serialized = JSON.stringify(logged);
  assert.equal(serialized.includes('must-not-log'), false);
});
test('messages limits requests per authenticated user to 20 per minute', async t => {
  let calls = 0;
  const post = await setup(t, { orchestrator: { async handle() { calls++; return response; } } });
  for (let i = 0; i < 20; i++) assert.equal((await post({ message: 'hello' })).status, 200);
  assert.equal((await post({ message: 'hello' })).status, 429); assert.equal(calls, 20);
});
