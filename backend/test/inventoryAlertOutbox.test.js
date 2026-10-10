const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createInventoryAlertDispatcher, backoffMs, eventIdentity, send } = require('../src/services/inventoryAlertOutbox');
const { createInventoryAlertDispatchRoutes } = require('../src/routes/inventoryAlertDispatch');
const Event = require('../src/models/InventoryAlertOutboxEvent');
const now = new Date('2026-10-10T12:00:00Z');
const fixture = result => {
  const updates = [], row = { eventId: 'event', attempts: 1, payload: { eventId: 'event' } };
  let claimed = false;
  const repo = { async claim(date, token) { assert.equal(date, now); assert.ok(token); if (claimed) return null; claimed = true; return row; },
    async finish(given, token, update) { assert.equal(given, row); assert.ok(token); updates.push(update); } };
  return { updates, dispatcher: createInventoryAlertDispatcher({ repo, clock: () => now, deliver: async () => result }) };
};
test('stable event identity separates OPEN from RESOLVED and has a unique index', () => {
  assert.equal(eventIdentity('a', 'inventory.alert.opened'), eventIdentity('a', 'inventory.alert.opened'));
  assert.notEqual(eventIdentity('a', 'inventory.alert.opened'), eventIdentity('a', 'inventory.alert.resolved'));
  assert.ok(Event.schema.indexes().some(([keys, options]) => keys.eventId && options.unique));
  assert.equal(Event.schema.path('payload').options.immutable, true);
});
test('dispatcher acknowledges DELIVERED and clears future retry', async () => {
  const f = fixture({ delivered: true });
  assert.deepEqual(await f.dispatcher.run(), { claimed: 1, delivered: 1, retrying: 0, failed: 0 });
  assert.equal(f.updates[0].status, 'DELIVERED'); assert.equal(f.updates[0].deliveredAt, now);
  assert.equal(f.updates[0].nextAttemptAt, null);
});
test('offline Node-RED preserves pending retry with bounded backoff', async () => {
  for (const category of ['NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'UNAVAILABLE']) {
    const f = fixture({ category, retryable: true }); await f.dispatcher.run();
    assert.equal(f.updates[0].status, 'FAILED'); assert.equal(f.updates[0].lastErrorCategory, category);
    assert.equal(f.updates[0].nextAttemptAt.getTime() - now.getTime(), 30000);
  }
  assert.deepEqual([1, 2, 3, 4, 100].map(backoffMs), [30000, 120000, 300000, 900000, 900000]);
});
test('nonrecoverable auth/payload errors stop automatic retries', async () => {
  for (const category of ['AUTH', 'PAYLOAD']) {
    const f = fixture({ category, retryable: false }); const summary = await f.dispatcher.run();
    assert.equal(summary.failed, 1); assert.equal(f.updates[0].nextAttemptAt, null);
  }
});
test('dispatcher batches at most ten events even when more are available', async () => {
  let claims = 0;
  const dispatcher = createInventoryAlertDispatcher({ repo: { claim: async () => ({ attempts: ++claims, payload: {} }), finish: async () => {} },
    deliver: async () => ({ delivered: true }) });
  assert.equal((await dispatcher.run()).claimed, 10); assert.equal(claims, 10);
});
test('internal dispatcher stays disabled without a dedicated strong secret', () => {
  const { sameSecret } = require('../src/routes/inventoryAlertDispatch');
  assert.equal(sameSecret('', undefined), false);
  assert.equal(sameSecret('short', 'short'), false);
  assert.equal(sameSecret('wrong', 'synthetic-internal-dispatch-secret-12345'), false);
});
test('transport classifies HTTP errors and requires a matching receipt, without raw diagnostics', async t => {
  const oldUrl = process.env.NODE_RED_WEBHOOK_URL, oldSecret = process.env.NODE_RED_WEBHOOK_SECRET;
  process.env.NODE_RED_WEBHOOK_URL = 'https://example.invalid/webhook'; process.env.NODE_RED_WEBHOOK_SECRET = 'synthetic-test-secret';
  try {
    let status = 401, failureName;
    t.mock.method(global, 'fetch', async () => {
      if (failureName) throw Object.assign(new Error('secret-not-logged'), { name: failureName });
      return { ok: status === 200, status, json: async () => ({ success: true, eventId: 'event' }) };
    });
    for (const [code, category, retryable] of [[401, 'AUTH', false], [403, 'AUTH', false], [400, 'PAYLOAD', false], [429, 'RATE_LIMIT', true], [503, 'UNAVAILABLE', true]]) {
      status = code; assert.deepEqual(await send({ eventId: 'event' }), { category, retryable });
    }
    status = 200; assert.deepEqual(await send({ eventId: 'event' }), { delivered: true });
    assert.equal((await send({ eventId: 'wrong' })).category, 'INVALID_ACK');
    failureName = 'AbortError';
    assert.deepEqual(await send({ eventId: 'event' }), { category: 'TIMEOUT', retryable: true });
    failureName = 'Error';
    assert.deepEqual(await send({ eventId: 'event' }), { category: 'NETWORK', retryable: true });
  } finally {
    if (oldUrl === undefined) delete process.env.NODE_RED_WEBHOOK_URL; else process.env.NODE_RED_WEBHOOK_URL = oldUrl;
    if (oldSecret === undefined) delete process.env.NODE_RED_WEBHOOK_SECRET; else process.env.NODE_RED_WEBHOOK_SECRET = oldSecret;
  }
});
test('internal endpoints reject unauthenticated requests, arbitrary inputs and sanitize failures', async () => {
  const secret = 'synthetic-internal-dispatch-secret-12345'; let calls = 0;
  const app = express(); app.use(express.json());
  app.use(createInventoryAlertDispatchRoutes({ config: () => ({ INVENTORY_ALERT_DISPATCH_SECRET: secret, NODE_RED_WEBHOOK_SECRET: `${secret}-webhook` }),
    dispatcher: { run: async () => { calls++; return { claimed: 0 }; } }, receive: async () => { throw Error('private-secret'); } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = (path, body, authenticated) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Internal-Secret': secret } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/run', {}, false)).status, 401);
    assert.equal((await post('/run', { businessId: 'B' }, true)).status, 400);
    assert.equal((await post('/run', {}, true)).status, 200); assert.equal(calls, 1);
    const failure = await fetch(`http://127.0.0.1:${server.address().port}/receipt`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': `${secret}-webhook` }, body: '{}' });
    assert.equal(failure.status, 503);
    assert.doesNotMatch(await failure.text(), /private-secret|stack/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
