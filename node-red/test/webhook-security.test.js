const test = require('node:test');
const assert = require('node:assert/strict');

const {
  constantTimeEqual,
  createDashboardIoMiddleware,
  createHttpNodeMiddleware,
  createWebhookSecurity,
  validateWebhookRequest
} = require('../lib/webhook-security');

const SECRET = 'test-only-node-red-webhook-secret-123456789';

const request = (overrides = {}) => ({
  headers: { 'x-webhook-secret': SECRET },
  payload: {
    event: 'transaction.created',
    data: { transactionId: 'test-transaction' }
  },
  ...overrides
});

test('missing webhook secret returns 401 before payload validation', () => {
  const result = validateWebhookRequest({ headers: {}, payload: null }, SECRET);

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.code, 'WEBHOOK_UNAUTHORIZED');
});

test('incorrect webhook secret returns the same 401 response', () => {
  const result = validateWebhookRequest(
    request({ headers: { 'x-webhook-secret': 'incorrect' } }),
    SECRET
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.code, 'WEBHOOK_UNAUTHORIZED');
});

test('constant-time comparison handles different lengths without throwing', () => {
  assert.doesNotThrow(() => constantTimeEqual('x', SECRET));
  assert.equal(constantTimeEqual('x', SECRET), false);
  assert.equal(constantTimeEqual(SECRET, SECRET), true);
});

test('correct secret accepts each supported event', () => {
  const cases = [
    ['transaction.created', { transactionId: 'transaction-id' }],
    ['product.low_stock', { productId: 'product-id' }],
    ['telegram.command', { chatId: '-123456789', text: '/stock arroz' }]
  ];

  for (const [event, data] of cases) {
    const result = validateWebhookRequest(request({ payload: { event, data } }), SECRET);
    assert.equal(result.ok, true, event);
    assert.equal(result.event, event);
  }
});

test('rejected requests cannot reach login, business queries or Telegram effects', () => {
  const security = createWebhookSecurity(SECRET);
  const message = request({ headers: {}, req: { headers: {} } });
  const routed = security.routeMessage(message);
  const effects = { login: 0, query: 0, telegram: 0 };

  if (routed[0]) {
    effects.login += 1;
    effects.query += 1;
    effects.telegram += 1;
  }

  assert.equal(routed[0], null);
  assert.equal(routed[1].statusCode, 401);
  assert.deepEqual(effects, { login: 0, query: 0, telegram: 0 });
});

test('arbitrary chatId without a secret is rejected at authentication first', () => {
  const result = validateWebhookRequest({
    headers: {},
    payload: {
      event: 'telegram.command',
      data: { chatId: 'attacker-controlled', text: '/deudas' }
    }
  }, SECRET);

  assert.equal(result.statusCode, 401);
  assert.equal(result.code, 'WEBHOOK_UNAUTHORIZED');
});

test('authenticated unknown events are rejected without routing', () => {
  const security = createWebhookSecurity(SECRET);
  const routed = security.routeMessage(request({
    req: { headers: { 'x-webhook-secret': SECRET } },
    payload: { event: 'admin.dump_everything', data: {} }
  }));

  assert.equal(routed[0], null);
  assert.equal(routed[1].statusCode, 400);
  assert.equal(routed[1].payload.code, 'UNSUPPORTED_WEBHOOK_EVENT');
});

test('authenticated invalid Telegram chatId and commands are rejected', () => {
  for (const data of [
    { chatId: 'not-a-chat', text: '/stock' },
    { chatId: [], text: '/stock' },
    { chatId: '12345', text: '' },
    { chatId: '12345', text: {} },
    { chatId: '12345', text: '/admin dump' },
    { chatId: '12345', text: 'consulta inesperada' }
  ]) {
    const result = validateWebhookRequest(request({
      payload: { event: 'telegram.command', data }
    }), SECRET);

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
  }
});

test('only documented Telegram commands and buttons reach downstream effects', () => {
  for (const text of ['/stock arroz', '/ventas', '/deudas', '/ayuda', '📦 Stock bajo', '❓ Ayuda']) {
    const result = validateWebhookRequest(request({
      payload: { event: 'telegram.command', data: { chatId: '12345', text } }
    }), SECRET);

    assert.equal(result.ok, true, text);
    assert.equal(result.data.text, text);
  }
});

test('private HTTP endpoints require Basic auth while /webhook uses its own auth', () => {
  const middleware = createHttpNodeMiddleware({
    username: 'dashboard-user',
    password: 'dashboard-password',
    protectPrivateEndpoints: true
  });
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  middleware({ path: '/webhook', headers: {} }, {}, next);
  assert.equal(nextCalls, 1);

  const rejected = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; }
  };
  middleware({ path: '/ui', headers: {} }, rejected, next);
  assert.equal(rejected.statusCode, 401);
  assert.equal(nextCalls, 1);

  const authorization = Buffer.from('dashboard-user:dashboard-password').toString('base64');
  middleware(
    { path: '/ui', headers: { authorization: `Basic ${authorization}` } },
    {},
    next
  );
  assert.equal(nextCalls, 2);
});

test('dashboard websocket rejects missing Basic auth and accepts valid credentials', () => {
  const middleware = createDashboardIoMiddleware({
    username: 'dashboard-user',
    password: 'dashboard-password',
    protectPrivateEndpoints: true
  });
  let rejectedError;
  middleware({ request: { headers: {} } }, (error) => { rejectedError = error; });
  assert.equal(rejectedError.data.code, 'DASHBOARD_UNAUTHORIZED');

  const authorization = Buffer.from('dashboard-user:dashboard-password').toString('base64');
  let acceptedError = 'not-called';
  middleware(
    { request: { headers: { authorization: `Basic ${authorization}` } } },
    (error) => { acceptedError = error; }
  );
  assert.equal(acceptedError, undefined);
});
