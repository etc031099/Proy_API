const test = require('node:test');
const assert = require('node:assert/strict');

const { notifyNodeRed } = require('../src/services/webhookService');

const originalFetch = global.fetch;
const originalWebhookUrl = process.env.NODE_RED_WEBHOOK_URL;
const originalWebhookSecret = process.env.NODE_RED_WEBHOOK_SECRET;
const originalConsoleError = console.error;

const configureWebhook = () => {
  process.env.NODE_RED_WEBHOOK_URL = 'https://node-red.example.test/webhook';
  process.env.NODE_RED_WEBHOOK_SECRET = 'test-only-webhook-secret-with-32-characters';
};

test.afterEach(() => {
  global.fetch = originalFetch;
  console.error = originalConsoleError;
  if (originalWebhookUrl === undefined) delete process.env.NODE_RED_WEBHOOK_URL;
  else process.env.NODE_RED_WEBHOOK_URL = originalWebhookUrl;
  if (originalWebhookSecret === undefined) delete process.env.NODE_RED_WEBHOOK_SECRET;
  else process.env.NODE_RED_WEBHOOK_SECRET = originalWebhookSecret;
});

for (const status of [401, 403, 500]) {
  test(`webhook delivery detects HTTP ${status} without reporting success`, async () => {
    configureWebhook();
    const logs = [];
    console.error = (...parts) => logs.push(parts.join(' '));
    global.fetch = async () => ({ ok: false, status });

    const result = await notifyNodeRed('transaction.created', { privateValue: 'not-logged' });

    assert.deepEqual(result, {
      delivered: false,
      status,
      reason: status === 401 || status === 403 ? 'authentication rejected' : 'service unavailable'
    });
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /not-logged|test-only-webhook-secret/);
  });
}

test('webhook delivery accepts HTTP 200 and sends the configured secret', async () => {
  configureWebhook();
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  };

  const result = await notifyNodeRed('product.low_stock', { productId: 'product-test-id' });

  assert.deepEqual(result, { delivered: true, status: 200 });
  assert.equal(request.options.headers['X-Webhook-Secret'], process.env.NODE_RED_WEBHOOK_SECRET);
  assert.equal(request.options.redirect, 'error');
});

test('webhook network errors are logged without leaking secrets, URLs or payloads', async () => {
  configureWebhook();
  const logs = [];
  console.error = (...parts) => logs.push(parts.join(' '));
  global.fetch = async () => {
    throw new Error(
      `${process.env.NODE_RED_WEBHOOK_URL} ${process.env.NODE_RED_WEBHOOK_SECRET} private-payload`
    );
  };

  const result = await notifyNodeRed('transaction.created', { value: 'private-payload' });

  assert.deepEqual(result, { delivered: false, reason: 'network request failed' });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /node-red\.example|test-only-webhook-secret|private-payload/);
});
