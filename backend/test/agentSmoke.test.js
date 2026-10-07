const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const createAgentRoutes = require('../src/routes/agent');

const TEST_USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const fakeAuth = (req, res, next) => { req.user = { _id: TEST_USER_ID, isActive: true, businessId: 'SYNTHETIC', role: 'user' }; next(); };
const fakeBusinessAccess = (req, res, next) => { req.businessId = req.user.businessId; next(); };
const createServer = (router, t) => new Promise((resolve, reject) => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', router);
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
  t.after(() => new Promise(done => server.close(done)));
});
const postSmoke = (server, { authorization, body } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/agent/smoke`, {
  method: 'POST',
  headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const success = (overrides = {}) => ({ model: 'gemini-3.8-flash', text: 'OK', latencyMs: 137,
  usage: { usageAvailable: true, inputTokens: 22, outputTokens: 2, thoughtTokens: 0,
    cachedInputTokens: 0, toolUseTokens: 0, totalTokens: 24 }, ...overrides });
const protectedRouter = options => createAgentRoutes({
  authenticateMiddleware: fakeAuth,
  businessAccessMiddleware: fakeBusinessAccess,
  ...options
});

test('agent smoke rejects unauthenticated requests before reaching the provider', async t => {
  let calls = 0;
  const router = createAgentRoutes({ enabled: true, providerFactory: () => ({ async generate() { calls++; return success(); } }) });
  const server = await createServer(router, t);
  const response = await postSmoke(server);
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('agent disabled returns 404 to authenticated users without calling Gemini', async t => {
  let calls = 0;
  const server = await createServer(protectedRouter({ enabled: false, providerFactory: () => ({ async generate() { calls++; } }) }), t);
  const response = await postSmoke(server, { authorization: 'Bearer synthetic-token' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'AGENT_DISABLED');
  assert.equal(calls, 0);
});

test('smoke uses only its fixed prompt and returns the safe provider usage projection', async t => {
  let captured;
  const providerFactory = () => ({ async generate(input) { captured = input; return success(); } });
  const server = await createServer(protectedRouter({ enabled: true, providerFactory }), t);
  const response = await postSmoke(server, { authorization: 'Bearer synthetic-token', body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(captured, { agentId: 'coordinator',
    systemInstruction: 'Responde exactamente con la palabra OK. No uses herramientas ni solicites datos.',
    messages: [{ role: 'user', text: 'Responde únicamente: OK' }] });
  assert.deepEqual(await response.json(), { success: true, model: 'gemini-3.8-flash', output: 'OK',
    usage: { inputTokens: 22, outputTokens: 2, thoughtTokens: 0, cachedInputTokens: 0, toolUseTokens: 0,
      totalTokens: 24, usageAvailable: true, metricsComplete: true }, latencyMs: 137 });
});

test('smoke rejects caller prompt/model/key/tool/tenant overrides and never calls Gemini', async t => {
  let calls = 0;
  const server = await createServer(protectedRouter({ enabled: true, providerFactory: () => ({ async generate() { calls++; return success(); } }) }), t);
  const response = await postSmoke(server, { authorization: 'Bearer synthetic-token', body: {
    prompt: 'Caller prompt', model: 'other-model', apiKey: 'must-not-echo', tools: ['anything'], businessId: 'TENANT-X'
  } });
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.equal(body.includes('must-not-echo'), false);
  assert.equal(calls, 0);
});

test('smoke sanitizes every Gemini error category and never serializes provider internals', async t => {
  const cases = [
    ['GEMINI_AUTHENTICATION_FAILED', 502], ['GEMINI_PERMISSION_DENIED', 502], ['GEMINI_MODEL_NOT_FOUND', 502],
    ['GEMINI_RATE_LIMITED', 503], ['GEMINI_TIMEOUT', 504], ['GEMINI_NETWORK_ERROR', 503], ['GEMINI_UNAVAILABLE', 503]
  ];
  for (const [code, status] of cases) {
    const providerFactory = () => ({ async generate() { const error = new Error('raw secret and provider payload'); error.code = code; throw error; } });
    const server = await createServer(protectedRouter({ enabled: true, providerFactory }), t);
    const response = await postSmoke(server, { authorization: 'Bearer synthetic-token' });
    assert.equal(response.status, status);
    const body = await response.text();
    assert.equal(body.includes('raw secret'), false);
    assert.equal(body.includes('provider payload'), false);
    assert.equal(body.includes(code), true);
  }
});

test('authenticated smoke endpoint has a three-per-minute user limiter', async t => {
  const server = await createServer(protectedRouter({ enabled: true, providerFactory: () => ({ async generate() { return success(); } }) }), t);
  for (let i = 0; i < 3; i++) assert.equal((await postSmoke(server, { authorization: 'Bearer synthetic-token' })).status, 200);
  const fourth = await postSmoke(server, { authorization: 'Bearer synthetic-token' });
  assert.equal(fourth.status, 429);
});
