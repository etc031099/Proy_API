const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { readTelegramConfig, legacyPollingEnabled } = require('../src/config/telegramAssistant');
const { createTelegramAssistantTransport, parseUpdate } = require('../src/services/telegramAssistantTransport');
const { createTelegramTransportRepository } = require('../src/services/telegramTransportRepository');
const { createTelegramWebhookRoutes } = require('../src/routes/telegramWebhook');
const { createAgentConversationService } = require('../src/services/agentConversationService');
const { withActionAssistant } = require('../src/automations/assistant');
const { createActionContext } = require('../src/automations/contracts');
const { provisionTelegramTransportIndexes } = require('../src/services/telegramTransportIndexes');
const Binding = require('../src/models/TelegramAssistantBinding');
const Receipt = require('../src/models/TelegramUpdateReceipt');
const Conversation = require('../src/models/AgentConversation');

const mapping = { chatId: '123', telegramUserId: '123', systemUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'DEMO', bindingGeneration: 1 };
const environment = () => ({ AGENT_ENABLED: 'true', TELEGRAM_ASSISTANT_ENABLED: 'true', TELEGRAM_UPDATES_MODE: 'webhook',
  TELEGRAM_ASSISTANT_OPERATIONS_ENABLED: 'false', TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDE12345',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(40), TELEGRAM_ASSISTANT_BINDINGS: JSON.stringify([mapping]) });
const update = (id = 1, text = 'vende 2 productos') => ({ update_id: id,
  message: { message_id: id, text, chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false } } });

const { fixture } = require('./helpers/telegramTransportFixture');

test('flags default disabled; webhook, bindings and explicit operations enablement are required', () => {
  assert.equal(readTelegramConfig({}).enabled, false); assert.equal(readTelegramConfig({}).mode, 'disabled');
  assert.equal(readTelegramConfig({}).operationsEnabled, false);
  for (const change of [{ TELEGRAM_UPDATES_MODE: 'legacy_polling' }, { TELEGRAM_WEBHOOK_SECRET: '' },
    { TELEGRAM_ASSISTANT_BINDINGS: '[]' }, { TELEGRAM_ASSISTANT_BINDINGS: '{}' }, { TELEGRAM_BOT_TOKEN: 'bad/token' },
    { TELEGRAM_ASSISTANT_ENABLED: 'yes' },
    { NODE_RED_WEBHOOK_SECRET: 'a'.repeat(40) }, { JWT_SECRET: 'a'.repeat(40) }])
    assert.throws(() => readTelegramConfig({ ...environment(), ...change }), { code: 'TELEGRAM_CONFIGURATION_INVALID' });
  assert.equal(readTelegramConfig(environment()).operationsEnabled, false);
  assert.equal(readTelegramConfig({ ...environment(), TELEGRAM_ASSISTANT_OPERATIONS_ENABLED: 'true' }).operationsEnabled, true);
  assert.throws(() => readTelegramConfig({ ...environment(), TELEGRAM_ASSISTANT_ENABLED: 'false', TELEGRAM_UPDATES_MODE: 'disabled',
    TELEGRAM_ASSISTANT_OPERATIONS_ENABLED: 'true' }), { code: 'TELEGRAM_CONFIGURATION_INVALID' });
  assert.throws(() => readTelegramConfig({ ...environment(), TELEGRAM_ASSISTANT_BINDINGS: JSON.stringify([mapping, mapping]) }));
});

test('durable keyboard output inserts multiple callback tokens with ordered session writes', async () => {
  const session = { id: 'mongo-session' };
  const binding = { _id: 'binding-id', active: true, bindingGeneration: 1, chatId: '123', telegramUserId: '123',
    systemUserId: mapping.systemUserId, businessId: mapping.businessId, conversationId: randomUUID() };
  const receipt = { _id: 'receipt-id', ownerToken: 'owner', status: 'PROCESSING', requestKey: randomUUID() };
  let tokenInsert, receiptUpdate;
  const repository = createTelegramTransportRepository({
    BindingModel: { findOneAndUpdate: () => ({ lean: async () => binding }), updateOne: async () => ({}) },
    ReceiptModel: { findOne: () => ({ session: () => ({ lean: async () => receipt }) }),
      updateOne: async (_filter, update) => { receiptUpdate = update; } },
    CallbackModel: { create: async (documents, options) => { tokenInsert = { documents, options }; } },
    transact: async work => work(session)
  });
  const claim = { binding, receipt };
  await repository.output(claim, [
    { token: 'opaque-one', purpose: 'CONFIRM_ACTION', position: 0 },
    { token: 'opaque-two', purpose: 'CANCEL_ACTION', position: 1 }
  ]);
  assert.equal(tokenInsert.documents.length, 2);
  assert.equal(tokenInsert.options.session, session);
  assert.equal(tokenInsert.options.ordered, true);
  assert.equal(receiptUpdate.$set.status, 'OUTPUT_READY');
});

test('private text only: groups, impersonated actors, bots, callbacks, commands and media denied', () => {
  const invalid = [null, { update_id: 1, callback_query: {} }, { ...update(), channel_post: {} }];
  for (const change of [{ chat: { id: -1, type: 'group' } }, { from: { id: 456, is_bot: false } },
    { from: { id: 123, is_bot: true } }, { text: undefined, photo: [] }, { text: '/admin' }, { text: 'x'.repeat(2001) }])
    invalid.push({ ...update(), message: { ...update().message, ...change } });
  for (const value of invalid) assert.throws(() => parseUpdate(value), { code: 'TELEGRAM_UPDATE_UNSUPPORTED' });
});

test('unknown chat denied before user lookup, transport data, assistant or LLM', async () => {
  const transport = createTelegramAssistantTransport({ config: () => readTelegramConfig(environment()),
    loadUser: () => assert.fail('No user read'), repository: { assertReady: () => assert.fail('No transport read') }, conversations: {} });
  const other = update(); other.message.chat.id = 456; other.message.from.id = 456;
  await assert.rejects(transport.admit(other), { code: 'TELEGRAM_UNAUTHORIZED' });
});

test('disabled system user, tenant mismatch and invalid role rejected before receipt admission', async () => {
  const f = fixture();
  for (const change of [{ isActive: false }, { businessId: 'FOREIGN' }, { role: 'owner' }]) {
    f.user({ _id: mapping.systemUserId, businessId: 'DEMO', role: 'user', isActive: true, ...change });
    await assert.rejects(f.make().admit(update()), { code: 'TELEGRAM_UNAUTHORIZED' });
    assert.equal(f.state.receipts.length, 0);
  }
});

test('same update has one durable receipt and stable requestKey, without storing text', async () => {
  const f = fixture(), transport = f.make();
  const [a, b] = await Promise.all([transport.admit(update()), transport.admit(update())]);
  assert.equal(a.requestKey, b.requestKey); assert.equal(f.state.receipts.length, 1);
  assert.equal(f.state.bindings.length, 1); assert.equal(f.state.receipts[0].status, 'RECEIVED');
  assert.equal(JSON.stringify(f.state.receipts).includes('vende 2'), false);
  await transport.recover(); await transport.recover();
  assert.equal(f.state.receipts[0].status, 'COMPLETED'); assert.equal(f.state.receipts[0].resultCode, 'READ_COMPLETED');
  assert.equal(f.state.conversations.length, 1); assert.equal(f.conversationCalls, 1);
  const retry = await transport.admit(update()); assert.equal(retry.requestKey, a.requestKey); assert.equal(retry.status, 'COMPLETED');
});

test('duplicate ID with different text is rejected, not overwritten', async () => {
  const f = fixture(); await f.make().admit(update());
  await assert.rejects(f.make().admit(update(1, 'different')), { code: 'TELEGRAM_UPDATE_CONFLICT' });
  assert.equal(f.state.receipts.length, 1);
});

test('concurrent chat updates serialize, out-of-order update IDs are not discarded', async () => {
  const f = fixture(); await Promise.all([f.make().admit(update(20)), f.make().admit(update(10))]);
  assert.deepEqual(f.state.receipts.map(row => row.sequence), [1, 2]);
  await Promise.all([f.make().recover(), f.make().recover()]);
  await f.make().recover();
  assert.ok(f.state.receipts.every(row => row.status === 'COMPLETED'));
  assert.equal(f.state.conversations.length, 1); assert.equal(f.conversationCalls, 2);
});

test('restart after admission recovers; uncertain generation is not replayed', async () => {
  const f = fixture(); await f.make().admit(update());
  await f.make().recover();
  assert.equal(f.state.receipts[0].status, 'COMPLETED'); assert.equal(f.state.conversations.length, 1);
  const g = fixture(); await g.make().admit(update()); g.crash(true); await g.make().recover();
  assert.equal(g.state.receipts[0].status, 'UNCERTAIN'); g.advance(130000); g.crash(false); await g.make().recover();
  assert.equal(g.state.receipts[0].status, 'UNCERTAIN'); assert.equal(g.sent.length, 0);
});

test('revoked binding or disabled user cannot process admitted work or silently adopt a new identity', async () => {
  const f = fixture(); await f.make().admit(update()); f.state.bindings[0].active = false;
  await assert.rejects(f.make().admit(update(2)), { code: 'TELEGRAM_BINDING_REVOKED' });
  await f.make().recover(); assert.equal(f.state.receipts[0].resultCode, 'TELEGRAM_BINDING_REVOKED');
  assert.equal(f.sent.length, 0);
  const g = fixture(); await g.make().admit(update()); g.user(null); await g.make().recover();
  assert.equal(g.state.receipts[0].resultCode, 'TELEGRAM_UNAUTHORIZED');
  const h = fixture(); await h.make().admit(update()); h.state.bindings[0].bindingGeneration++;
  await assert.rejects(h.make().admit(update(2)), { code: 'TELEGRAM_BINDING_REVOKED' });
  await h.make().recover(); assert.equal(h.state.receipts[0].resultCode, 'TELEGRAM_BINDING_REVOKED');
});

test('client identity fields do not change server-side binding or role', async () => {
  const f = fixture(), input = update();
  Object.assign(input.message, { businessId: 'FOREIGN', role: 'admin', sourceChannel: 'assistant', systemUserId: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
  await f.make().admit(input); await f.make().recover();
  assert.equal(f.state.conversations[0].businessId, mapping.businessId);
  assert.equal(f.state.conversations[0].userId, mapping.systemUserId);
});

test('schema isolates transport from notification binding and requires explicit index provisioning', () => {
  assert.equal(Binding.schema.options.autoCreate, false); assert.equal(Binding.schema.options.autoIndex, false);
  assert.equal(Receipt.schema.options.autoCreate, false); assert.equal(Receipt.schema.options.autoIndex, false);
  assert.ok(Binding.schema.indexes().some(([key, options]) => key.businessId === 1 && options.unique));
  assert.ok(Binding.schema.indexes().some(([key, options]) => key.chatId === 1 && options.unique));
  assert.equal(Binding.schema.path('stockRuleAlertsEnabled'), undefined);
});

test('missing required index fails closed; indexes additive/idempotent and conflicts never dropped', async () => {
  const model = { schema: Binding.schema, collection: { listIndexes: () => ({ toArray: async () => [] }), createIndex: async () => {} } };
  const repository = createTelegramTransportRepository({ BindingModel: model });
  await assert.rejects(repository.assertReady(), { code: 'TELEGRAM_INDEXES_REQUIRED' });
  const indexes = []; let creates = 0;
  model.collection.listIndexes = () => ({ toArray: async () => indexes });
  model.collection.createIndex = async (key, options) => { creates++; indexes.push({ key, ...options }); };
  await provisionTelegramTransportIndexes([model]); await provisionTelegramTransportIndexes([model]);
  assert.equal(creates, 3);
  indexes[0].unique = false;
  await assert.rejects(provisionTelegramTransportIndexes([model]), { code: 'TELEGRAM_INDEX_CONFLICT' });
  assert.equal(creates, 3); assert.equal(Receipt.schema.indexes().some(([, options]) => options.expireAfterSeconds !== undefined), false);
});

test('web default context is unchanged; Telegram read-only wrapper cannot prepare or execute writes', async () => {
  const req = { user: { _id: mapping.systemUserId, businessId: 'DEMO', role: 'user', isActive: true }, businessId: 'DEMO',
    body: { sourceChannel: 'telegram', role: 'admin' } };
  assert.equal(createActionContext(req).sourceChannel, 'assistant');
  const wrapper = withActionAssistant({ handle: () => assert.fail('No runtime') },
    { prepare: () => assert.fail('No PendingAction'), confirmPendingAction: () => assert.fail('No execution') }, { readOnly: true });
  for (const message of ['vende 2 cocas', 'confirmar']) {
    const result = await wrapper.handle(req, { message, conversationId: randomUUID() });
    assert.match(result.answer, /todavía no están habilitadas/); assert.equal(result.usage.totalLlmCalls, 0);
  }
});

test('durable transport APIs require the server-side transport adapter, not request channel fields', async () => {
  const req = { user: { _id: mapping.systemUserId, businessId: 'DEMO', role: 'user', isActive: true }, businessId: 'DEMO', body: { sourceChannel: 'telegram' } };
  const service = createAgentConversationService({ runtime: {}, repository: {} });
  await assert.rejects(service.transportRequest(req, randomUUID(), randomUUID()), { code: 'AGENT_INVALID_REQUEST' });
});

test('legacy polling remains disabled unless explicitly selected', async () => {
  assert.equal(legacyPollingEnabled(), false);
});

test('webhook secret/content/size gates precede admission; ACK only follows durable admission', async t => {
  let admitted = 0, durable = false, release;
  const config = () => readTelegramConfig(environment());
  const transport = { admit: async () => { admitted++; await new Promise(resolve => { release = resolve; }); durable = true;
    return { status: 'RECEIVED', duplicate: false }; } };
  const app = express(); app.use('/api/telegram/webhook', createTelegramWebhookRoutes({ config, transport }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/telegram/webhook`;
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Telegram-Bot-Api-Secret-Token': config().secret, ...headers }, body });
  assert.equal((await post('{}', { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })).status, 401);
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(JSON.stringify({ data: 'x'.repeat(17000) }))).status, 413);
  assert.equal((await post('{')).status, 400); assert.equal(admitted, 0);
  let acknowledged = false;
  const pending = post(JSON.stringify(update())).then(response => { acknowledged = true; return response; });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false); assert.equal(durable, false); release();
  assert.equal((await pending).status, 200); assert.equal(durable, true); assert.equal(admitted, 1);
});
