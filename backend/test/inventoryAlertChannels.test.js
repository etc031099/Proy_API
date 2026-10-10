const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const mongoose = require('mongoose');
const { createInventoryAlertChannels, destinationKey, messageFor } = require('../src/services/inventoryAlertChannels');
const { createInventoryAlertDispatchRoutes } = require('../src/routes/inventoryAlertDispatch');
const { createInventoryAlertDispatcher } = require('../src/services/inventoryAlertOutbox');
const Connection = require('../src/models/TelegramConnection');
const Delivery = require('../src/models/InventoryAlertChannelDelivery');
const eventFor = (businessId = 'A', type = 'opened') => ({
  eventId: `507f1f77bcf86cd799439011:inventory.alert.${type}`, businessId,
  eventType: `inventory.alert.${type}`, productId: new mongoose.Types.ObjectId(), status: 'DELIVERED', receivedAt: new Date(),
  payload: { data: { product: { sku: 'SKU-1', name: 'Producto sintético' }, previousStock: 4, newStock: 3, condition: { operator: '<=', threshold: 3 } } }
});
const fixture = ({ type, connection } = {}) => {
  let now = new Date('2026-10-10T12:00:00Z');
  const event = eventFor('A', type), rows = [], sends = [], scopes = [];
  const connectionA = connection === undefined ? { businessId: 'A', chatId: '123456', enabled: true, stockRuleAlertsEnabled: true, stockRuleResolvedAlertsEnabled: true } : connection;
  const repo = {
    event: async id => id === event.eventId ? event : null,
    connection: async business => { scopes.push(business); return business === 'A' ? connectionA : { chatId: '999999' }; },
    ensure: async (e, c) => {
      if (!rows.some(r => r.destinationKey === destinationKey(c))) rows.push({ _id: rows.length, eventId: e.eventId,
        businessId: e.businessId, destinationKey: destinationKey(c), status: 'PENDING', attempts: 0, nextAttemptAt: now });
    },
    claim: async (e, at, token) => {
      const row = rows.find(r => r.businessId === e.businessId && (['PENDING', 'FAILED'].includes(r.status) && r.nextAttemptAt && r.nextAttemptAt <= at
        || r.status === 'IN_FLIGHT' && r.leaseUntil <= at));
      if (!row) return null;
      Object.assign(row, { status: 'IN_FLIGHT', leaseToken: token, leaseUntil: new Date(at.getTime() + 30000), attempts: row.attempts + 1 });
      return { ...row };
    },
    finish: async (row, token, update) => {
      const stored = rows.find(r => r._id === row._id && r.leaseToken === token);
      if (stored) Object.assign(stored, update, { leaseToken: null });
    },
    pending: async () => rows
  };
  let failure;
  const service = createInventoryAlertChannels({ repo, clock: () => now, send: async (chat, message) => {
    sends.push({ chat, message }); if (failure) throw failure;
  } });
  return { event, rows, sends, scopes, repo, service,
    fail: category => { failure = category ? { category, message: 'secret raw provider error' } : null; },
    advance: ms => { now = new Date(now.getTime() + ms); } };
};

test('channel defaults are opt-in and durable dedupe index has event/channel/destination', () => {
  const legacy = new Connection({ businessId: 'A' });
  assert.equal(legacy.stockRuleAlertsEnabled, false); assert.equal(legacy.stockRuleResolvedAlertsEnabled, false);
  assert.equal(legacy.lowStockAlertsEnabled, true);
  assert.ok(Delivery.schema.indexes().some(([keys, options]) => options.unique
    && keys.eventId === 1 && keys.channel === 1 && keys.destinationKey === 1));
});
test('OPEN and opted-in RESOLVED send compact persisted facts to the event tenant only', async () => {
  for (const type of ['opened', 'resolved']) {
    const f = fixture({ type });
    assert.equal((await f.service.process(f.event.eventId)).status, 'DELIVERED');
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].chat, '123456');
    assert.match(f.sends[0].message, /Regla de stock personalizada/);
    assert.match(f.sends[0].message, /Stock: 4 → 3/); assert.match(f.sends[0].message, /stock <= 3/);
    assert.doesNotMatch(f.sends[0].message, /507f|businessId|ruleId|token/);
    assert.ok(f.scopes.every(scope => scope === 'A'));
  }
});
test('disabled, missing and separate false preferences skip permanently without sends', async () => {
  for (const [connection, type, reason] of [
    [null, 'opened', 'telegram_not_configured'],
    [{ chatId: '123', enabled: false }, 'opened', 'telegram_disabled'],
    [{ chatId: '123', enabled: true, lowStockAlertsEnabled: true }, 'opened', 'preference_disabled'],
    [{ chatId: '123', enabled: true, stockRuleAlertsEnabled: true }, 'resolved', 'preference_disabled']
  ]) {
    const f = fixture({ connection, type }); await f.service.process(f.event.eventId); await f.service.process(f.event.eventId);
    assert.equal(f.rows[0].status, 'SKIPPED'); assert.equal(f.rows[0].skipReason, reason);
    assert.equal(f.rows[0].nextAttemptAt, null); assert.equal(f.sends.length, 0);
  }
});
test('duplicate and concurrent deliveries claim once; expired lease supports recovery', async () => {
  const f = fixture(); await Promise.all([f.service.process(f.event.eventId), f.service.process(f.event.eventId)]);
  await f.service.process(f.event.eventId); assert.equal(f.sends.length, 1); assert.equal(f.rows.length, 1);
  const recovery = fixture(); await recovery.repo.ensure(recovery.event, { chatId: '123456' });
  await recovery.repo.claim(recovery.event, new Date('2026-10-10T12:00:00Z'), 'crashed-worker');
  assert.equal((await recovery.service.processPendingEvent(recovery.event.eventId)).status, 'UNCHANGED');
  recovery.advance(30001); await recovery.service.run(); assert.equal(recovery.sends.length, 1);
});
test('channel retry backoff and terminal errors are safe, bounded and durable', async () => {
  for (const category of ['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'UNAVAILABLE']) {
    const f = fixture(); f.fail(category); await f.service.process(f.event.eventId);
    assert.equal(f.rows[0].status, 'FAILED'); assert.equal(f.rows[0].lastErrorCategory, category);
    assert.equal(f.rows[0].nextAttemptAt.toISOString(), '2026-10-10T12:00:30.000Z');
    await f.service.process(f.event.eventId); assert.equal(f.sends.length, 1);
    f.advance(30000); f.fail(null); await f.service.run(); assert.equal(f.rows[0].status, 'DELIVERED');
  }
  for (const category of ['AUTH', 'FORBIDDEN', 'INVALID_CHAT', 'CONFIGURATION']) {
    const f = fixture(); f.fail(category); await f.service.process(f.event.eventId);
    assert.equal(f.rows[0].nextAttemptAt, null); f.advance(9999999); await f.service.run(); assert.equal(f.sends.length, 1);
  }
  const exhausted = fixture(); exhausted.fail('NETWORK');
  for (let i = 0; i < 6; i++) { await exhausted.service.process(exhausted.event.eventId); exhausted.advance(900000); }
  assert.equal(exhausted.sends.length, 5); assert.equal(exhausted.rows[0].nextAttemptAt, null);
});
test('unsupported events and destination changes never authorize a send', async () => {
  const unsupported = fixture(); unsupported.event.eventType = 'unknown';
  await unsupported.service.process(unsupported.event.eventId);
  assert.equal(unsupported.rows[0].skipReason, 'unsupported_event'); assert.equal(unsupported.sends.length, 0);
  const changed = fixture(); await changed.repo.ensure(changed.event, { chatId: 'another-destination' });
  await changed.service.processPendingEvent(changed.event.eventId);
  assert.equal(changed.rows[0].skipReason, 'destination_changed'); assert.equal(changed.sends.length, 0);
});
test('no send precedes outbox DELIVERED; dispatcher channel failure never undoes ACK', async () => {
  const f = fixture(); f.event.status = 'IN_FLIGHT'; await f.service.process(f.event.eventId);
  assert.equal(f.rows[0].status, 'PENDING'); assert.equal(f.sends.length, 0);
  f.event.status = 'DELIVERED'; await f.service.processPendingEvent(f.event.eventId); assert.equal(f.sends.length, 1);
  let claimed = false, status;
  const dispatcher = createInventoryAlertDispatcher({ repo: { claim: async () => {
    if (claimed) return null; claimed = true; return { eventId: f.event.eventId, attempts: 1, payload: {} };
  }, finish: async (row, token, update) => { status = update.status; } }, deliver: async () => ({ delivered: true }),
  afterDelivered: async () => { assert.equal(status, 'DELIVERED'); throw Error('channel unavailable'); } });
  assert.equal((await dispatcher.run()).delivered, 1); assert.equal(status, 'DELIVERED');
});
test('channel endpoint is protected, event-only, tenant derived, and failures sanitized', async () => {
  const secret = 'synthetic-webhook-secret-at-least-32-characters'; let ids = [];
  const app = express(); app.use(express.json()); app.use(createInventoryAlertDispatchRoutes({
    config: () => ({ NODE_RED_WEBHOOK_SECRET: secret, INVENTORY_ALERT_DISPATCH_SECRET: `${secret}-dispatch` }),
    channels: { process: async id => { ids.push(id); if (id === 'fail') throw Error('raw-secret'); return { status: 'DELIVERED' }; } }
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = (body, auth = true) => fetch(`http://127.0.0.1:${server.address().port}/channels/process`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Internal-Secret': secret } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ eventId: eventFor().eventId }, false)).status, 401);
    for (const extra of ['businessId', 'chatId', 'token', 'payload']) assert.equal((await post({ eventId: eventFor().eventId, [extra]: 'B' })).status, 400);
    assert.equal((await post({ eventId: eventFor().eventId })).status, 200); assert.equal(ids.length, 1);
    const bad = await post({ eventId: 'fail' }); assert.equal(bad.status, 503); assert.doesNotMatch(await bad.text(), /raw-secret|stack/);
    assert.equal(await fixture().service.process('unknown'), null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('Telegram transport classifies real status shape and never preserves raw secrets', async t => {
  const previous = process.env.TELEGRAM_BOT_TOKEN; process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token-only';
  const { sendMessage } = require('../src/services/telegramService');
  let status = 200, network;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    if (network) throw Object.assign(new Error('raw-secret-url'), { name: network });
    return { ok: status === 200, status, json: async () => ({ ok: status === 200, error_code: status, description: 'secret-body', result: {} }) };
  });
  try {
    for (const [code, category, retryable] of [[401, 'AUTH', false], [403, 'FORBIDDEN', false], [400, 'INVALID_CHAT', false], [429, 'RATE_LIMIT', true], [503, 'UNAVAILABLE', true]]) {
      status = code; await assert.rejects(sendMessage('synthetic-chat', 'fictional'), error => {
        assert.equal(error.category, category); assert.equal(error.retryable, retryable);
        assert.doesNotMatch(error.message, /secret|body|url/); return true;
      });
    }
    network = 'AbortError'; await assert.rejects(sendMessage('synthetic-chat', 'fictional'), { category: 'TIMEOUT' });
    network = 'TypeError'; await assert.rejects(sendMessage('synthetic-chat', 'fictional'), { category: 'NETWORK' });
    delete process.env.TELEGRAM_BOT_TOKEN; await assert.rejects(sendMessage('synthetic-chat', 'fictional'), { category: 'CONFIGURATION' });
  } finally { if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previous; }
});

test('Telegram observability is tenant scoped, bounded and 0 LLM/0 tokens with safe DTOs', async () => {
  const { createAgentOrchestrator } = require('../src/agents');
  const { routeDeterministically } = require('../src/agents/intentRouting');
  const { validateSkillInvocation } = require('../src/agents/skills');
  const now = new Date(); const queries = [];
  const row = { sku: 'SKU-1', eventType: 'inventory.alert.opened', status: 'DELIVERED', attempts: 1, createdAt: now,
    deliveredAt: now, destinationKey: 'hidden-destination', eventId: 'private-id', leaseToken: 'secret' };
  const model = { find(match) { queries.push(match); return { select() { return this; }, sort() { return this; }, limit(n) { assert.equal(n, 20); return this; },
    maxTimeMS() { return this; }, lean() { return this; }, exec: async () => match.businessId === 'A' ? [row] : [] }; },
  countDocuments(match) { return { maxTimeMS() { return this; }, exec: async () => match.businessId === 'A' ? 1 : 0 }; } };
  const orchestrator = createAgentOrchestrator({ dependencies: { models: { InventoryAlertChannelDelivery: model } },
    provider: { generateStructured() { assert.fail('No LLM'); }, generateWithTools() { assert.fail('No LLM'); } } });
  const req = { user: { _id: new mongoose.Types.ObjectId(), businessId: 'A', isActive: true, role: 'user' } };
  for (const message of ['¿Se envió por Telegram la alerta de SKU-1?', '¿Qué notificaciones Telegram están pendientes?', '¿Qué notificaciones Telegram fallaron?']) {
    const result = await orchestrator.handle(req, { message });
    assert.equal(result.actions[0].skillId, 'list_inventory_alert_channel_deliveries');
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalTokens, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-id|hidden-destination|leaseToken|secret/);
  }
  assert.ok(queries.every(match => match.businessId === 'A'));
  assert.ok(queries.some(match => match.status === 'FAILED' && match.nextAttemptAt === null));
  const b = await orchestrator.handle({ user: { ...req.user, businessId: 'B' } }, { message: '¿Qué notificaciones Telegram están pendientes?' });
  assert.equal(b.evidence[0].recordCount, 0);
  assert.equal(routeDeterministically('¿Qué alertas de stock tengo configuradas?', {}, now).intent, 'stock_alert_rules');
  const context = require('../src/agents').createAgentRequestContext(req);
  assert.throws(() => validateSkillInvocation({ agentId: 'operations', context, skillId: 'list_inventory_alert_channel_deliveries', args: { businessId: 'B' } }), { code: 'AGENT_INVALID_SKILL_ARGS' });
});
