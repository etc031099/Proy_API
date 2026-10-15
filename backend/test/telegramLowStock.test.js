const test = require('node:test');
const assert = require('node:assert/strict');
const TelegramConnection = require('../src/models/TelegramConnection');
const { notifyLowStock } = require('../src/services/telegramService');

const productAt = (stock, overrides = {}) => ({
  name: 'Pan francés paquete 4 unidades',
  sku: 'PAN-FRE-001',
  stock,
  minStockLevel: 3,
  reorderPoint: 8,
  ...overrides
});

const response = (status = 200, result = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ ok: status >= 200 && status < 300, error_code: status, result })
});

const mockTelegram = (t, { connection = { chatId: 'synthetic-chat', save: async () => {} }, sendResponse = response() } = {}) => {
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token-only';
  const calls = { lookups: [], requests: [], saves: 0 };
  t.after(() => {
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
  });
  t.mock.method(TelegramConnection, 'findOne', async (filter) => {
    calls.lookups.push(filter);
    return connection && { ...connection, save: async () => { calls.saves += 1; } };
  });
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.requests.push({ url, options, body: JSON.parse(options.body) });
    return sendResponse;
  });
  return calls;
};

test('no alert unless persisted stock crosses into the configured minimum range', async (t) => {
  const calls = mockTelegram(t);
  await notifyLowStock('tenant-a', productAt(4), 5);
  await notifyLowStock('tenant-a', productAt(2), 3);
  assert.equal(calls.lookups.length, 0);
  assert.equal(calls.requests.length, 0);
});

test('minimum crossing includes equality and uses minStockLevel rather than reorderPoint', async (t) => {
  const calls = mockTelegram(t);
  await notifyLowStock('tenant-a', productAt(3), 4);
  assert.equal(calls.requests.length, 1);
  assert.match(calls.requests[0].body.text, /Stock actual: 3 unidades/);
  assert.match(calls.requests[0].body.text, /Mínimo configurado: 3 unidades/);
  assert.doesNotMatch(calls.requests[0].body.text, /8/);
});

test('continued low-stock movements do not emit another threshold notification', async (t) => {
  const calls = mockTelegram(t);
  await notifyLowStock('tenant-a', productAt(3), 4);
  await notifyLowStock('tenant-a', productAt(2), 3);
  await notifyLowStock('tenant-a', productAt(1), 2);
  assert.equal(calls.requests.length, 1);
});

test('recovery above minimum rearms a later downward crossing', async (t) => {
  const calls = mockTelegram(t);
  await notifyLowStock('tenant-a', productAt(3), 4);
  await notifyLowStock('tenant-a', productAt(5), 3);
  await notifyLowStock('tenant-a', productAt(3), 5);
  assert.equal(calls.requests.length, 2);
});

test('zero stock uses an exhausted label and singular counts remain grammatical', async (t) => {
  const calls = mockTelegram(t);
  await notifyLowStock('tenant-a', productAt(0, { minStockLevel: 1 }), 2);
  const text = calls.requests[0].body.text;
  assert.match(text, /Producto agotado/);
  assert.match(text, /Stock actual: 0 unidades/);
  assert.match(text, /Mínimo configurado: 1 unidad/);
  assert.doesNotMatch(text, /LOW STOCK|English|Action:/);
});

test('lookup is tenant-scoped and requires enabled low-stock preference plus a linked chat', async (t) => {
  const calls = mockTelegram(t);
  await notifyLowStock('tenant-a', productAt(2), 4);
  assert.deepEqual(calls.lookups[0], {
    businessId: 'tenant-a', enabled: true, lowStockAlertsEnabled: true,
    chatId: { $exists: true, $ne: null }
  });
  assert.equal(calls.requests[0].body.chat_id, 'synthetic-chat');
});

test('missing connection or opted-out connection causes no Telegram send', async (t) => {
  const calls = mockTelegram(t, { connection: null });
  await notifyLowStock('tenant-a', productAt(2), 4);
  assert.equal(calls.lookups.length, 1);
  assert.equal(calls.requests.length, 0);
  assert.equal(calls.saves, 0);
});

test('message is compact Spanish and contains only human product and stock facts', async (t) => {
  const calls = mockTelegram(t);
  await notifyLowStock('tenant-a', productAt(2), 4);
  const { body, options, url } = calls.requests[0];
  assert.match(body.text, /Pan francés paquete 4 unidades/);
  assert.match(body.text, /SKU: PAN-FRE-001/);
  assert.doesNotMatch(body.text, /businessId|tenant-a|productId|ObjectId|token|English|Minimum stock/);
  assert.equal(body.disable_web_page_preview, true);
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal);
  assert.match(url, /sendMessage$/);
  assert.equal(calls.saves, 1);
});

test('missing bot token is a safe non-retryable configuration failure', async (t) => {
  const calls = mockTelegram(t);
  delete process.env.TELEGRAM_BOT_TOKEN;
  await assert.rejects(notifyLowStock('tenant-a', productAt(2), 4), (error) => {
    assert.equal(error.category, 'CONFIGURATION');
    assert.equal(error.retryable, false);
    assert.equal(error.message, 'Telegram request failed');
    return true;
  });
  assert.equal(calls.requests.length, 0);
  assert.equal(calls.saves, 0);
});

test('Telegram transport failure is sanitized, attempted once and leaves alert timestamp unchanged', async (t) => {
  const calls = mockTelegram(t, { sendResponse: response(429, { description: 'synthetic provider detail' }) });
  await assert.rejects(notifyLowStock('tenant-a', productAt(2), 4), (error) => {
    assert.equal(error.category, 'RATE_LIMIT');
    assert.equal(error.retryable, true);
    assert.equal(error.message, 'Telegram request failed');
    return true;
  });
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.saves, 0);
});
