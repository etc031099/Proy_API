const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { Product, Contact, Transaction, InventoryMovement, CreditPayment } = require('../../src/models');
const User = require('../../src/models/User');
const Binding = require('../../src/models/TelegramAssistantBinding');
const Receipt = require('../../src/models/TelegramUpdateReceipt');
const Callback = require('../../src/models/TelegramCallbackToken');
const Conversation = require('../../src/models/AgentConversation');
const Message = require('../../src/models/AgentConversationMessage');
const Pending = require('../../src/models/PendingAction');
const Audit = require('../../src/models/ActionAudit');
const Events = require('../../src/models/ActionDomainEvent');
const Alert = require('../../src/models/InventoryAlert');
const AlertOutbox = require('../../src/models/InventoryAlertOutboxEvent');
const AlertRule = require('../../src/models/StockAlertRule');
const TelegramConnection = require('../../src/models/TelegramConnection');
const { createTelegramAssistantTransport } = require('../../src/services/telegramAssistantTransport');
const { createTelegramTransportRepository } = require('../../src/services/telegramTransportRepository');
const { createAgentConversationService } = require('../../src/services/agentConversationService');
const { createAgentOrchestrator } = require('../../src/agents/orchestrator');
const { withActionAssistant } = require('../../src/automations/assistant');
const { createActionService } = require('../../src/automations/execution');
const { createActionExecutors } = require('../../src/automations/executors');
const { readTelegramConfig } = require('../../src/config/telegramAssistant');
const { update, callback } = require('../helpers/telegramOperationsFixture');
let disposableDatabase, ready = false, updateId = 0, nextChat = 10000;
const originalFetch = global.fetch;
test.before(async () => {
  const url = new URL(process.env.MONGODB_TEST_URI || 'http://invalid');
  if (url.protocol !== 'mongodb:' || url.hostname !== '127.0.0.1' || url.port !== '27018'
    || url.username || url.password || !/^\/telegram_operations_[a-f0-9]{16}_test$/.test(url.pathname)
    || url.searchParams.get('replicaSet') !== 'rs0' || url.searchParams.get('directConnection') !== 'true') {
    throw Error('Refusing MongoDB test URI: require unauthenticated 127.0.0.1:27018, isolated random database, rs0 and directConnection=true');
  }
  disposableDatabase = url.pathname.slice(1);
  await mongoose.connect(url.href, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.isWritablePrimary, true); assert.equal(hello.setName, 'rs0');
  // Never remove an existing database. Provision only a new isolated fixture database.
  assert.equal((await mongoose.connection.db.listCollections().toArray()).length, 0);
  ready = true;
  for (const model of [User, Product, Contact, Transaction, InventoryMovement, CreditPayment, Binding, Receipt, Callback,
    Conversation, Message, Pending, Audit, Events, Alert, AlertOutbox, AlertRule, TelegramConnection]) {
    await model.createCollection(); await model.createIndexes();
  }
  // Real gateway/transaction/executors; only external FX and Telegram API are mocked.
  global.fetch = async url => {
    assert.match(String(url), /^https:\/\/(?:api\.frankfurter\.app|open\.er-api\.com|api\.exchangerate-api\.com)/);
    return { ok: true, json: async () => ({ rates: { USD: 1, PEN: 3.7, EUR: 0.92 } }) };
  };
});
test.after(async () => {
  global.fetch = originalFetch;
  if (ready && mongoose.connection.readyState === 1 && mongoose.connection.name === disposableDatabase
    && /^telegram_operations_[a-f0-9]{16}_test$/.test(disposableDatabase)) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
const fixture = async ({ failAfterWrite = false } = {}) => {
  const businessId = `tg-${randomUUID()}`, chat = ++nextChat;
  const userId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, name: 'Usuario sintético', email: `telegram-${randomUUID()}@example.test`,
    businessId, role: 'admin', isActive: true });
  const vendor = await Contact.create({ businessId, name: 'Proveedor sintético', phone: '000000000', type: 'vendor' });
  const products = await Product.create(['TG-001', 'TG-002'].map(sku => ({ businessId, name: `Producto ${sku}`, sku,
    price: 10, currency: 'PEN', stock: 20, category: 'Sintético', minStockLevel: 2,
    supplierPrices: [{ supplierId: vendor._id, purchasePrice: 4 }] })));
  const config = () => readTelegramConfig({ AGENT_ENABLED: 'true', TELEGRAM_ASSISTANT_ENABLED: 'true', TELEGRAM_UPDATES_MODE: 'webhook',
    TELEGRAM_ASSISTANT_OPERATIONS_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDE12345', TELEGRAM_WEBHOOK_SECRET: 'z'.repeat(40),
    TELEGRAM_ASSISTANT_BINDINGS: JSON.stringify([{ chatId: String(chat), telegramUserId: String(chat), systemUserId: String(userId), businessId, bindingGeneration: 1 }]) });
  const executors = createActionExecutors();
  if (failAfterWrite) {
    const execute = executors.create_sale.execute;
    executors.create_sale.execute = async (...args) => { await execute(...args); throw Error('Synthetic failure after transactional stock and events'); };
  }
  const actionService = createActionService({ executors });
  const core = createAgentOrchestrator({ provider: { generateStructured: () => assert.fail('No LLM'), generateWithTools: () => assert.fail('No LLM') } });
  const runtime = withActionAssistant(core, actionService, { sourceChannel: 'telegram', requireCustomerDecision: true,
    telegramOperationsEnabled: () => config().operationsEnabled });
  const conversations = createAgentConversationService({ runtime, actionService, sourceChannel: 'telegram', durableTransport: true,
    onError: () => assert.fail('History must persist') });
  const sent = [];
  const transport = createTelegramAssistantTransport({ config, repository: createTelegramTransportRepository(), conversations,
    telegram: { answerCallbackQuery: async () => {}, sendMessage: async (_chat, text, extra) => {
      sent.push({ text, ...extra }); return { message_id: sent.length }; } } });
  const send = async text => { await transport.admit(update(++updateId, text, chat)); await transport.recover(); };
  const token = async purpose => Callback.findOne({ businessId, purpose }).sort({ createdAt: -1 }).lean();
  const press = async value => { const admitted = await transport.admit(callback(++updateId, value, value.messageId, chat));
    await transport.recover(); return admitted; };
  return { businessId, chat, products, actionService, transport, sent, send, token, press };
};

for (const verb of ['vende', 'compra']) test(`Mongo rs0 Telegram → shared gateway → ${verb} multi-product commits exactly once`, async () => {
  const x = await fixture(); await x.send(`${verb} 2 TG-001 y 3 TG-002`);
  if (verb === 'vende') await x.send('Consumidor Final');
  const token = await x.token('CONFIRM_ACTION'); assert.ok(token, JSON.stringify(await Receipt.find({}).lean()));
  assert.equal((await Pending.findOne({ businessId: x.businessId }).lean()).status, 'PENDING');
  assert.equal(await Transaction.countDocuments({ businessId: x.businessId }), 0);
  assert.equal(await Audit.countDocuments({ businessId: x.businessId }), 0);
  await x.press(token); await x.press(token);
  assert.equal(await Transaction.countDocuments({ businessId: x.businessId }), 1);
  const stocks = await Promise.all(x.products.map(p => Product.findById(p._id).lean()));
  assert.deepEqual(stocks.map(p => p.stock), verb === 'vende' ? [18, 17] : [22, 23]);
  assert.equal(await InventoryMovement.countDocuments({ businessId: x.businessId }), 2);
  const action = await Pending.findOne({ businessId: x.businessId }).lean();
  assert.equal(action.status, 'EXECUTED'); assert.equal(action.sourceChannel, 'telegram');
  assert.equal(await Audit.countDocuments({ businessId: x.businessId, status: 'EXECUTED' }), 1);
  assert.match(x.sent.at(-1).text, /registrada correctamente/);
});
test('Mongo rs0 Telegram sale rollback is atomic across stock, ledger, transaction, domain events and audit', async () => {
  const x = await fixture({ failAfterWrite: true }); await x.send('vende 2 TG-001 y 3 TG-002');
  await x.send('Consumidor Final');
  await x.press(await x.token('CONFIRM_ACTION'));
  assert.deepEqual((await Promise.all(x.products.map(p => Product.findById(p._id).lean()))).map(p => p.stock), [20, 20]);
  for (const Model of [Transaction, InventoryMovement, Events]) assert.equal(await Model.countDocuments({ businessId: x.businessId }), 0);
  assert.equal((await Pending.findOne({ businessId: x.businessId })).status, 'FAILED');
  assert.equal(await Audit.countDocuments({ businessId: x.businessId, status: 'FAILED' }), 1);
  assert.match(x.sent.at(-1).text, /No fue posible/);
});
test('Mongo rs0 concurrent Telegram confirmations and concurrent recoverers cannot duplicate a transaction', async () => {
  const x = await fixture(); await x.send('vende 2 TG-001'); await x.send('Consumidor Final'); const token = await x.token('CONFIRM_ACTION');
  const inputs = [1, 2].map(() => callback(++updateId, token, token.messageId, x.chat));
  const admitted = await Promise.all(inputs.map(input => x.transport.admit(input)));
  assert.equal(admitted[0].requestKey, admitted[1].requestKey);
  await Promise.all([x.transport.recover(), x.transport.recover()]);
  assert.equal(await Transaction.countDocuments({ businessId: x.businessId }), 1);
  assert.equal((await Product.findById(x.products[0]._id)).stock, 18);
  assert.equal(await Receipt.countDocuments({ requestKey: admitted[0].requestKey }), 1);
});
test('Mongo rs0 rechecks the active role and rejects an ordinary user before gateway execution', async () => {
  const x = await fixture(); await x.send('vende 2 TG-001'); await x.send('Consumidor Final'); const token = await x.token('CONFIRM_ACTION');
  await User.updateOne({ businessId: x.businessId }, { $set: { role: 'user' } });
  assert.equal((await User.findOne({ businessId: x.businessId }).lean()).role, 'user');
  const callbackRequest = await x.press(token);
  assert.equal(await Transaction.countDocuments({ businessId: x.businessId }), 0);
  assert.equal((await Pending.findOne({ businessId: x.businessId })).status, 'PENDING');
  const callbackReceipt = await Receipt.findOne({ requestKey: callbackRequest.requestKey }).select('status resultCode control').lean();
  assert.equal(callbackReceipt.status, 'FAILED', JSON.stringify(callbackReceipt));
});
