const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createWebhookSecurity } = require('../lib/webhook-security');
const flows = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../flows.json'), 'utf8'));
const fn = new Function('msg', 'global', 'env', 'node', flows.find(row => row.id === 'fn_hook').func);
const secret = 'synthetic-channel-test-secret';
const eventId = '507f1f77bcf86cd799439011:inventory.alert.opened';
test('channel transport posts only eventId to protected backend; no fixed credentials or destination', async () => {
  for (const type of ['opened', 'resolved']) {
    const id = eventId.replace('opened', type);
    const result = await createWebhookSecurity(secret).processInventoryAlertChannels(id, 'https://backend.example/api', async (url, options) => {
      assert.equal(url, 'https://backend.example/api/internal/inventory-alert-dispatch/channels/process');
      assert.deepEqual(JSON.parse(options.body), { eventId: id });
      assert.equal(options.headers['X-Internal-Secret'], secret); assert.equal(options.redirect, 'error');
      assert.ok(options.signal); return { ok: true, json: async () => ({ success: true, status: 'DELIVERED' }) };
    });
    assert.deepEqual(result, { success: true });
  }
});
test('channel transport errors are safe and do not retry in a loop', async () => {
  let calls = 0;
  assert.deepEqual(await createWebhookSecurity(secret).processInventoryAlertChannels(eventId, 'https://backend.example/api', async () => {
    calls++; throw Error('token-in-raw-url');
  }), { success: false });
  assert.equal(calls, 1);
  assert.deepEqual(await createWebhookSecurity(secret).processInventoryAlertChannels('invalid', 'https://backend.example/api'), { success: false });
  assert.deepEqual(await createWebhookSecurity(secret).processInventoryAlertChannels(eventId, 'http://external.example/api'), { success: false });
});
test('OPEN/RESOLVED/duplicate ACK finishes before channel kickoff and stays successful on Telegram failure', async () => {
  for (const type of ['opened', 'resolved']) for (const duplicate of [false, true]) {
    const response = new EventEmitter(), sent = [], calls = [], warnings = [];
    const security = {
      routeMessage() { assert.fail('Never use legacy commands'); },
      receiveInventoryAlert: async () => ({ statusCode: 200, payload: { success: true, eventId, duplicate } }),
      processInventoryAlertChannels: async id => { calls.push(id); return { success: false }; }
    };
    fn({ payload: { eventType: `inventory.alert.${type}` }, res: { _res: response } }, { get: () => security },
      { get: () => 'https://backend.example/api' }, { send: msg => sent.push(msg), done() {}, warn: value => warnings.push(value) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent[0][1].statusCode, 200); assert.equal(calls.length, 0);
    response.emit('finish'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1); assert.equal(sent.length, 1); assert.equal(sent[0][1].payload.success, true);
    assert.equal(warnings.length, 1); assert.doesNotMatch(warnings[0], /token|businessId|chatId/);
  }
});
test('rejected receipt never kicks off channel delivery', async () => {
  const response = new EventEmitter(); let calls = 0;
  const security = { routeMessage() {}, receiveInventoryAlert: async () => ({ statusCode: 503, payload: { success: false } }),
    processInventoryAlertChannels: async () => { calls++; } };
  fn({ payload: { eventType: 'inventory.alert.opened' }, res: response }, { get: () => security }, { get: () => '' }, { send() {}, done() {} });
  await new Promise(resolve => setImmediate(resolve)); response.emit('finish'); assert.equal(calls, 0);
});
