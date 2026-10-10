const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWebhookRequest, createWebhookSecurity } = require('../lib/webhook-security');
const secret = 'synthetic-node-red-webhook-secret-123456';
const alertId = '123456789012345678901234';
const payload = (eventType = 'inventory.alert.opened') => ({ eventId: `${alertId}:${eventType}`, eventType,
  occurredAt: '2026-10-10T12:00:00.000Z', data: { alertId, source: 'stock_alert_rule',
    product: { sku: 'SYNTHETIC', name: 'Synthetic product' }, condition: { operator: '<=', threshold: 3 },
    previousStock: 4, newStock: 3, status: eventType.endsWith('opened') ? 'OPEN' : 'RESOLVED' } });
test('inventory OPEN and RESOLVED require secret and coherent strict snapshots', () => {
  for (const type of ['inventory.alert.opened', 'inventory.alert.resolved']) {
    const request = { headers: { 'X-Webhook-Secret': secret }, payload: payload(type) };
    assert.equal(validateWebhookRequest(request, secret).ok, true);
    assert.equal(validateWebhookRequest({ ...request, headers: {} }, secret).statusCode, 401);
    for (const change of [p => { p.data.status = 'WRONG'; }, p => { p.occurredAt = 'bad'; },
      p => { p.data.businessId = 'foreign'; }, p => { p.eventId = 'invented'; }, p => { p.data.newStock = -1; }]) {
      const invalid = payload(type); change(invalid);
      assert.equal(validateWebhookRequest({ ...request, payload: invalid }, secret).statusCode, 400);
    }
  }
});
test('durable receipt callback is required before 200; duplicates are acknowledged without effects', async () => {
  let accepted = false, calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://backend.example/api/internal/inventory-alert-dispatch/receipt');
    assert.equal(options.headers['X-Internal-Secret'], secret);
    calls++; const duplicate = accepted; accepted = true;
    return { ok: true, status: 200, json: async () => ({ success: true, eventId: payload().eventId, duplicate }) };
  };
  const security = createWebhookSecurity(secret);
  const message = () => ({ req: { headers: { 'x-webhook-secret': secret } }, payload: payload() });
  const first = await security.receiveInventoryAlert(message(), 'https://backend.example/api', fetchImpl);
  const duplicate = await security.receiveInventoryAlert(message(), 'https://backend.example/api', fetchImpl);
  assert.equal(first.statusCode, 200); assert.equal(first.payload.duplicate, false);
  assert.equal(duplicate.payload.duplicate, true); assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(first.payload), /secret|businessId|chatId/);
  const rejected = message(); rejected.req.headers = {};
  assert.equal((await security.receiveInventoryAlert(rejected, 'https://backend.example/api', fetchImpl)).statusCode, 401);
  assert.equal(calls, 2);
});
test('unknown/spoofed event and unavailable backend cannot receive successful ACK', async () => {
  const security = createWebhookSecurity(secret), message = { req: { headers: { 'x-webhook-secret': secret } }, payload: payload() };
  const result = await security.receiveInventoryAlert(message, 'https://backend.example/api', async () => ({
    ok: false, status: 400, json: async () => ({ success: false }) }));
  assert.equal(result.statusCode, 400);
  const failed = await security.receiveInventoryAlert(message, 'https://backend.example/api', async () => { throw Error('private'); });
  assert.equal(failed.statusCode, 503); assert.doesNotMatch(JSON.stringify(failed.payload), /private/);
  const limited = await security.receiveInventoryAlert(message, 'https://backend.example/api', async () => ({
    ok: false, status: 429, json: async () => ({ success: false }) }));
  assert.equal(limited.statusCode, 429);
  assert.equal(validateWebhookRequest({ headers: message.req.headers, payload: payload('inventory.alert.unknown') }, secret).statusCode, 400);
});
