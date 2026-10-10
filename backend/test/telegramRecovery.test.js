const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramRecovery, createAttemptLimiter, hash, TTL_MS } = require('../src/services/telegramRecovery');
const { createTelegramUpdateProcessor } = require('../src/services/telegramService');
const { createTelegramRecoveryHandler } = require('../src/controllers/telegramRecoveryController');

const fixture = () => {
  let now = new Date('2026-10-10T12:00:00Z');
  const state = { connections: [], challenges: [], history: [{ businessId: 'old', original: true }] }, audits = [];
  let crash = false;
  const repo = {
    async transaction(fn) { const before = structuredClone(state); try { return await fn({}); } catch (e) { Object.assign(state, before); throw e; } },
    owner: async (business, user) => business === 'V2' && user === 'user-v2',
    connection: async query => state.connections.find(row => Object.entries(query).every(([key, value]) => row[key] === value)),
    recent: async business => state.challenges.filter(row => row.destinationBusinessId === business && row.createdAt >= new Date(now.getTime() - TTL_MS)).length,
    supersede: async business => state.challenges.filter(row => row.destinationBusinessId === business && row.status === 'PENDING').forEach(row => { row.status = 'SUPERSEDED'; }),
    insert: async row => state.challenges.push({ ...row, _id: String(state.challenges.length) }),
    challenge: async digest => state.challenges.find(row => row.challengeHash === digest),
    release: async source => { delete source.chatId; delete source.connectionCodeHash; delete source.connectionCodeExpiresAt; },
    assign: async (business, chatId) => {
      if (crash) throw Object.assign(Error('private raw database error'), { code: 11000 });
      let row = state.connections.find(row => row.businessId === business);
      if (!row) { row = { businessId: business, stockRuleAlertsEnabled: false, stockRuleResolvedAlertsEnabled: false, lowStockAlertsEnabled: true }; state.connections.push(row); }
      Object.assign(row, { chatId, enabled: true }); delete row.connectionCodeHash; delete row.connectionCodeExpiresAt;
    },
    consume: async (row, source, date) => { Object.assign(row, { status: 'USED', confirmedAt: date, sourceBusinessId: source?.businessId }); }
  };
  const service = createTelegramRecovery({ repo, clock: () => now, audit: value => audits.push(value) });
  return { state, audits, service, repo, start: () => service.initiate({ businessId: 'V2', userId: 'user-v2' }),
    advance: ms => { now = new Date(now.getTime() + ms); }, crash: () => { crash = true; } };
};
test('recovery creates high entropy hashed challenge with ten minute expiry and server tenant/user', async () => {
  const f = fixture(), result = await f.start();
  assert.match(result.code, /^TRF-[A-F0-9]{16}$/); assert.equal(f.state.challenges[0].challengeHash, hash(result.code));
  assert.equal(Date.parse(result.expiresAt) - Date.parse('2026-10-10T12:00:00Z'), TTL_MS);
  assert.doesNotMatch(JSON.stringify(f.state), /TRF-|chatId/);
  await assert.rejects(f.service.initiate({ businessId: 'old', userId: 'user-v2' }), { code: 'TELEGRAM_RECOVERY_FORBIDDEN' });
});
test('no previous chat owner connects destination and preserves safe opt-in defaults', async () => {
  const f = fixture(), { code } = await f.start();
  assert.equal((await f.service.confirm(code, '123')).status, 'CONNECTED');
  assert.equal(f.state.connections[0].chatId, '123'); assert.equal(f.state.connections[0].stockRuleAlertsEnabled, false);
});
test('transfer releases only source chat/code; business preferences and all history stay in place', async () => {
  const f = fixture();
  f.state.connections.push({ _id: 'old-id', businessId: 'old', chatId: '123', enabled: true,
    lowStockAlertsEnabled: false, stockRuleAlertsEnabled: true, connectionCodeHash: 'old-code' },
  { businessId: 'V2', enabled: false, lowStockAlertsEnabled: true, stockRuleAlertsEnabled: false, stockRuleResolvedAlertsEnabled: true });
  const { code } = await f.start(); assert.equal((await f.service.confirm(code, '123')).status, 'CONNECTED');
  const [source, destination] = f.state.connections;
  assert.equal(source.chatId, undefined); assert.equal(source.connectionCodeHash, undefined); assert.equal(source.stockRuleAlertsEnabled, true);
  assert.equal(destination.chatId, '123'); assert.equal(destination.enabled, true); assert.equal(destination.stockRuleAlertsEnabled, false);
  assert.equal(destination.stockRuleResolvedAlertsEnabled, true); assert.deepEqual(f.state.history, [{ businessId: 'old', original: true }]);
  assert.deepEqual(Object.keys(f.audits[0]).sort(), ['actorUserId', 'destinationBusinessId', 'event', 'sourceBusinessId', 'timestamp']);
  assert.equal(f.audits[0].sourceBusinessId, 'old'); assert.doesNotMatch(JSON.stringify(f.audits), /TRF-|chatId|old-code/);
});
test('invalid and expired challenges do not mutate connections', async () => {
  const f = fixture(), { code } = await f.start();
  assert.equal((await f.service.confirm('TRF-0000000000000000', '123')).status, 'INVALID');
  f.advance(TTL_MS); assert.equal((await f.service.confirm(code, '123')).status, 'EXPIRED'); assert.equal(f.state.connections.length, 0);
});
test('used challenge cannot transfer again to a different chat or emit another audit', async () => {
  const f = fixture(), { code } = await f.start(); await f.service.confirm(code, '123');
  assert.equal((await f.service.confirm(code, '456')).status, 'USED'); assert.equal(f.state.connections[0].chatId, '123'); assert.equal(f.audits.length, 1);
});
test('destination that already owns incoming chat is idempotent; another chat blocks without changes', async () => {
  const f = fixture(), { code } = await f.start(); f.state.connections.push({ businessId: 'V2', chatId: '123' });
  assert.equal((await f.service.confirm(code, '123')).status, 'ALREADY_CONNECTED'); assert.equal(f.state.connections.length, 1);
  const g = fixture(), challenge = await g.start(); g.state.connections.push({ businessId: 'V2', chatId: '456' });
  assert.equal((await g.service.confirm(challenge.code, '123')).status, 'DESTINATION_CONNECTED'); assert.equal(g.state.challenges[0].status, 'PENDING');
  await assert.rejects(g.start(), { code: 'TELEGRAM_DESTINATION_CONNECTED' });
});
test('duplicate key after release rolls back source/destination/challenge and creates no audit', async () => {
  const f = fixture(); f.state.connections.push({ businessId: 'old', chatId: '123' }); const { code } = await f.start(); f.crash();
  assert.equal((await f.service.confirm(code, '123')).status, 'CONFLICT'); assert.equal(f.state.connections[0].chatId, '123');
  assert.equal(f.state.connections.length, 1); assert.equal(f.state.challenges[0].status, 'PENDING'); assert.equal(f.audits.length, 0);
});
test('new challenge supersedes previous one and generation has durable per-business limit', async () => {
  const f = fixture(), first = await f.start(), second = await f.start();
  assert.equal((await f.service.confirm(first.code, '123')).status, 'INVALID');
  assert.equal(f.state.challenges[1].challengeHash, hash(second.code)); await f.start();
  await assert.rejects(f.start(), { code: 'TELEGRAM_RECOVERY_RATE_LIMITED' });
});
test('invalid confirmations are bounded per chat and globally, reset on expiry', async () => {
  let now = new Date('2026-10-10'); const allow = createAttemptLimiter(() => now);
  for (let i = 0; i < 5; i++) assert.equal(allow('123'), true);
  assert.equal(allow('123'), false); now = new Date(now.getTime() + TTL_MS); assert.equal(allow('123'), true);
  for (let i = 0; i < 99; i++) assert.equal(allow(String(i + 1000)), true);
  assert.equal(allow('999999'), false);
});
const update = (text, overrides = {}) => ({ update_id: 7, message: { text, chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false }, ...overrides } });
test('bot transfer derives chat from validated private update and never forwards to Node-RED', async () => {
  const calls = [], replies = []; const process = createTelegramUpdateProcessor({ send: async (...args) => replies.push(args),
    emit: () => assert.fail('Transfer must not enter command routing'), recovery: { confirm: async (...args) => { calls.push(args); return { status: 'USED' }; } } });
  await process(update('/transfer TRF-ABCDEF1234567890'));
  assert.deepEqual(calls, [['TRF-ABCDEF1234567890', '123']]); assert.equal(replies[0][1], 'Esta transferencia ya fue utilizada.');
  for (const overrides of [{ chat: { id: -123, type: 'group' } }, { from: { id: 456, is_bot: false } }, { from: { id: 123, is_bot: true } }]) await process(update('/transfer TRF-ABCDEF1234567890', overrides));
  assert.equal(calls.length, 1);
});
test('normal start/pairing/commands survive, duplicate normal pairing has safe recovery guidance', async () => {
  const replies = [], events = []; let saves = 0;
  const process = createTelegramUpdateProcessor({ send: async (id, text) => replies.push(text), emit: (...args) => events.push(args),
    connections: { findOne: async () => ({ save: async () => { saves++; } }) } });
  await process(update('/start')); await process(update('/stock')); await process(update('/start BILLING-123456'));
  assert.equal(saves, 1); assert.equal(events[0][0], 'telegram.command'); assert.match(replies.at(-1), /connected successfully/);
  const duplicate = createTelegramUpdateProcessor({ send: async (id, text) => replies.push(text), connections: { findOne: async () => ({ save: async () => { throw { code: 11000 }; } }) } });
  await duplicate(update('BILLING-123456')); assert.match(replies.at(-1), /Recuperar conexión/);
});
test('HTTP initiation rejects chat/business/user and sanitizes all failures', async () => {
  let calls = 0; const handler = createTelegramRecoveryHandler({ configured: () => true, service: { initiate: async scope => {
    calls++; assert.deepEqual(scope, { businessId: 'V2', userId: 'authenticated-user' }); throw Error('private raw secret'); } } });
  const response = () => ({ statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  for (const body of [{ chatId: '123' }, { businessId: 'old' }, { userId: 'old' }, [], 'text', null]) {
    const res = response(); await handler({ body }, res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0); const res = response(); await handler({ body: {}, businessId: 'V2', user: { _id: 'authenticated-user' } }, res);
  assert.equal(res.statusCode, 503); assert.doesNotMatch(JSON.stringify(res.body), /secret|private|stack|chatId/);
});
test('recovery route requires existing authentication, and provides no public confirm/update endpoint', async () => {
  const express = require('express'); const { once } = require('node:events');
  const app = express(); app.use(express.json()); app.use('/api/telegram', require('../src/routes/telegram'));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { const result = await fetch(`http://127.0.0.1:${server.address().port}/api/telegram/recovery/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(result.status, 401); }
  finally { await new Promise(resolve => server.close(resolve)); }
  const source = require('node:fs').readFileSync(require.resolve('../src/routes/telegram'), 'utf8');
  assert.ok(source.indexOf('router.use(checkBusinessAccess)') < source.indexOf("router.post('/recovery/code'"));
  assert.doesNotMatch(source, /post\(['"](?:\/transfer|\/recovery\/confirm|\/update)/);
});
