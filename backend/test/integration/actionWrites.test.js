const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { Product, Transaction, Contact, InventoryMovement, CreditPayment } = require('../../src/models');
const PendingAction = require('../../src/models/PendingAction');
const StockAlertRule = require('../../src/models/StockAlertRule');
const InventoryAlert = require('../../src/models/InventoryAlert');
const InventoryAlertOutboxEvent = require('../../src/models/InventoryAlertOutboxEvent');
const { createAgentExecution, createAgentRequestContext } = require('../../src/agents');
const ActionAudit = require('../../src/models/ActionAudit');
const Outbox = require('../../src/models/ActionDomainEvent');
const Conversation = require('../../src/models/AgentConversation');
const { createActionContext } = require('../../src/automations/contracts');
const { createActionService } = require('../../src/automations/execution');
const { createActionRepository } = require('../../src/automations/repository');
const { createActionExecutors } = require('../../src/automations/executors');
const { resolveReference } = require('../../src/automations/actionInput');
const { withActionAssistant } = require('../../src/automations/assistant');
const { createAgentConversationService } = require('../../src/services/agentConversationService');
const { createTransaction, updateTransactionStatus } = require('../../src/controllers/transactionController');
const { updateProductStock } = require('../../src/controllers/productController');
const { applyStockChange } = require('../../src/services/inventoryService');
const { evaluateStockAlertRules } = require('../../src/services/stockAlertRuleEvaluator');
const businessId = `auto-r2-${randomUUID()}`, foreignBusiness = `auto-r2-${randomUUID()}`;
const conversationId = randomUUID(), userId = new mongoose.Types.ObjectId();
const req = business => ({ businessId: business || businessId, user: { _id: userId, businessId: business || businessId, role: 'user', isActive: true } });
const context = () => createActionContext(req(), { conversationId });
const service = createActionService();
let vendor, customer, sequence = 0;
const originalFetch = global.fetch;
const newProduct = overrides => Product.create({ businessId, name: `Producto sintético ${++sequence}`, sku: `AUTO-${sequence}`,
  price: 10, currency: 'PEN', stock: 20, minStockLevel: 2, category: 'Sintético', supplierPrices: [{ supplierId: vendor._id, purchasePrice: 4 }], ...overrides });
const prepare = (skillId, args, target = service) => target.prepare({ skillId, args, context: context(), externalRequestId: randomUUID() });
const saleArgs = (product, extra = {}) => ({ products: [{ productId: String(product._id), quantity: 3 }], currency: 'PEN', ...extra });
const counts = async () => Promise.all([Product, Transaction, InventoryMovement, CreditPayment, ActionAudit, Outbox].map(model => model.countDocuments({ businessId })));
test.before(async () => {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) throw Error('MONGODB_TEST_URI local dedicated test database is required');
  const url = new URL(uri);
  if (url.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.pathname.slice(1).endsWith('_test')) throw Error('Refusing non-local/non-test Mongo');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.isWritablePrimary, true); assert.ok(hello.setName);
  await Promise.all([Product, Contact, Transaction, InventoryMovement, CreditPayment, PendingAction, ActionAudit, Outbox, Conversation, StockAlertRule, InventoryAlert, InventoryAlertOutboxEvent].map(model => model.init()));
  global.fetch = async () => ({ ok: true, json: async () => ({ rates: { USD: 1, PEN: 3.7, EUR: 0.92 } }) });
  [vendor, customer] = await Contact.create([{ businessId, name: 'Proveedor sintético', type: 'vendor', phone: '000000000' },
    { businessId, name: 'Cliente sintético', type: 'customer', phone: '000000001', creditLimit: 100 }]);
  await Conversation.create({ businessId, userId, conversationId, title: 'AUTO-R2 sintético', lastMessageAt: new Date() });
});
test.after(async () => {
  global.fetch = originalFetch;
  if (mongoose.connection.readyState === 1 && mongoose.connection.name.endsWith('_test')) {
    const filter = { businessId: { $in: [businessId, foreignBusiness] } };
    await Promise.all([Product, Contact, Transaction, CreditPayment, PendingAction, ActionAudit, Outbox, Conversation, StockAlertRule, InventoryAlert, InventoryAlertOutboxEvent].map(model => model.deleteMany(filter)));
    await InventoryMovement.collection.deleteMany(filter); // Fixture-only cleanup; production remains append-only.
  }
  await mongoose.disconnect();
});

test('guided fuzzy lookup covers the actual tenant and hides foreign products/vendors', async () => {
  const p = await newProduct({ name: 'Azúcar Morena 500ML', sku: 'GUIDED-AZUCAR' });
  await Product.create({ businessId: foreignBusiness, name: 'Azúcar Morena 500ML', sku: 'FOREIGN-AZUCAR', category: 'Sintético', price: 1 });
  const exact = await resolveReference(Product, context(), 'azucar morena 500 ml'); assert.equal(String(exact.value._id), String(p._id));
  const fuzzy = await resolveReference(Product, context(), 'azucar morna'); assert.ok(fuzzy.candidates.some(row => String(row._id) === String(p._id)));
  assert.ok(fuzzy.candidates.every(row => row.businessId === undefined));
  const supplier = await resolveReference(Contact, context(), 'proveedor sintetico', 'vendor'); assert.equal(String(supplier.value._id), String(vendor._id));
  assert.equal((await resolveReference(Contact, createActionContext(req(foreignBusiness)), String(vendor._id), 'vendor')).confidence, 'NOT_FOUND');
});

test('stock rule real Mongo preview, confirm and cross-conversation semantic dedupe', async () => {
  const p = await newProduct(), args = { productId: String(p._id), operator: '<=', threshold: 3 };
  const before = await counts(), pending = await prepare('create_stock_alert_rule', args);
  assert.equal(await StockAlertRule.countDocuments({ businessId, productId: p._id }), 0);
  assert.deepEqual(await counts(), before);
  const first = await service.confirmPendingAction(context(), pending.pendingActionId);
  assert.equal(first.status, 'EXECUTED');
  assert.deepEqual((await service.confirmPendingAction(context(), pending.pendingActionId)).result, first.result);
  const otherId = randomUUID(); await Conversation.create({ businessId, userId, conversationId: otherId, title: 'Regla sintética', lastMessageAt: new Date() });
  const otherContext = createActionContext(req(), { conversationId: otherId });
  const other = await service.prepare({ skillId: 'create_stock_alert_rule', args, context: otherContext, externalRequestId: randomUUID() });
  const duplicate = await service.confirmPendingAction(otherContext, other.pendingActionId);
  assert.equal(duplicate.result.alreadyExists, true); assert.equal(duplicate.result.id, first.result.id);
  const distinct = await prepare('create_stock_alert_rule', { ...args, operator: '<' });
  await service.confirmPendingAction(context(), distinct.pendingActionId);
  assert.equal(await StockAlertRule.countDocuments({ businessId, productId: p._id }), 2);
  assert.equal((await Product.findById(p._id)).stock, p.stock);
});
test('configured rule read uses real persisted, deduplicated rules and excludes canceled actions, events and foreign references', async () => {
  const p = await newProduct(), args = { productId: String(p._id), operator: '<=', threshold: 3 };
  const pending = await prepare('create_stock_alert_rule', args);
  const read = async sku => createAgentExecution({ context: createAgentRequestContext(req()) })
    .executeSkill({ agentId: 'operations', skillId: 'list_stock_alert_rules', args: { sku } });
  assert.equal((await read(p.sku)).metadata.totalMatches, 0);
  await service.confirmPendingAction(context(), pending.pendingActionId);
  await service.confirmPendingAction(context(), pending.pendingActionId);
  const duplicate = await prepare('create_stock_alert_rule', args);
  await service.confirmPendingAction(context(), duplicate.pendingActionId);
  const canceled = await prepare('create_stock_alert_rule', { ...args, operator: '<', threshold: 2 });
  await service.cancelPendingAction(context(), canceled.pendingActionId);
  await InventoryAlert.create({ businessId, actionId: randomUUID(), type: 'LOW_STOCK', productId: p._id, label: 'Evento sintético' });
  const foreign = await newProduct({ businessId: foreignBusiness });
  await StockAlertRule.create({ businessId: foreignBusiness, productId: foreign._id, operator: '<', threshold: 2, createdBy: userId });
  const before = await Promise.all([counts(), StockAlertRule.countDocuments({ businessId }), InventoryAlert.countDocuments({ businessId })]);
  const result = await read(p.sku);
  assert.equal(result.metadata.totalMatches, 1);
  assert.deepEqual(result.data, [{ sku: p.sku, name: p.name, operator: '<=', threshold: 3, enabled: true }]);
  assert.equal((await read(foreign.sku)).metadata.totalMatches, 0);
  assert.deepEqual(await Promise.all([counts(), StockAlertRule.countDocuments({ businessId }), InventoryAlert.countDocuments({ businessId })]), before);
});

test('stock rules concurrent different pending actions cannot duplicate equivalent active rules', async () => {
  const p = await newProduct(), args = { productId: String(p._id), operator: '<=', threshold: 8 };
  const pending = await Promise.all([1, 2].map(() => prepare('create_stock_alert_rule', args)));
  const results = await Promise.allSettled(pending.map(row => service.confirmPendingAction(context(), row.pendingActionId)));
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'ACTION_CONFLICT');
  assert.equal(await StockAlertRule.countDocuments({ businessId, productId: p._id, enabled: true }), 1);
  for (const row of pending) await service.confirmPendingAction(context(), row.pendingActionId);
  assert.equal(await StockAlertRule.countDocuments({ businessId, productId: p._id }), 1);
});
test('stock rules cancelled/expired pending and foreign product cannot create rules', async () => {
  const p = await newProduct(), args = { productId: String(p._id), operator: '<', threshold: 2 };
  const cancelled = await prepare('create_stock_alert_rule', args); await service.cancelPendingAction(context(), cancelled.pendingActionId);
  await assert.rejects(service.confirmPendingAction(context(), cancelled.pendingActionId), { code: 'ACTION_CANCELLED' });
  const expired = await prepare('create_stock_alert_rule', args);
  await PendingAction.updateOne({ businessId, pendingActionId: expired.pendingActionId }, { $set: { expiresAt: new Date(0) } });
  await assert.rejects(service.confirmPendingAction(context(), expired.pendingActionId), { code: 'ACTION_EXPIRED' });
  const foreign = await newProduct({ businessId: foreignBusiness });
  await assert.rejects(prepare('create_stock_alert_rule', { ...args, productId: String(foreign._id) }), { code: 'ACTION_VALIDATION_FAILED' });
  assert.equal(await StockAlertRule.countDocuments({ businessId, productId: p._id }), 0);
});
const makeRule = (product, operator = '<=', threshold = 3, extra = {}) => StockAlertRule.create({
  businessId, productId: product._id, operator, threshold, createdBy: userId, ...extra
});
const changeStock = async (product, newStock, options = {}) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const row = await Product.findOne({ _id: product._id, businessId: product.businessId }).session(session);
    const movement = await applyStockChange({ product: row, quantityDelta: newStock - row.stock,
      type: 'manual_adjustment', session, ...options });
    await session.commitTransaction(); return movement;
  } catch (error) { await session.abortTransaction(); throw error; }
  finally { await session.endSession(); }
};
const invoke = (controller, request) => new Promise((resolve, reject) => controller(request,
  { status() { return this; }, json: resolve }, reject));

test('real stock-rule crossing/recovery cycle keeps evidence and only resolves its own custom events', async () => {
  const p = await newProduct({ stock: 4 }), rule = await makeRule(p);
  const legacy = await InventoryAlert.create({ businessId, productId: p._id, actionId: randomUUID(), type: 'LOW_STOCK', label: 'Legacy' });
  const first = await changeStock(p, 3);
  let alerts = await InventoryAlert.find({ businessId, ruleId: rule._id }).lean();
  assert.equal(alerts.length, 1); assert.equal(alerts[0].status, 'OPEN');
  assert.equal(String(alerts[0].inventoryMovementId), String(first._id));
  assert.deepEqual(alerts[0].condition, { operator: '<=', threshold: 3 });
  assert.deepEqual([alerts[0].previousStock, alerts[0].newStock], [4, 3]); assert.ok(alerts[0].createdAt instanceof Date);
  await changeStock(p, 2); assert.equal(await InventoryAlert.countDocuments({ ruleId: rule._id }), 1);
  await changeStock(p, 5); assert.equal((await InventoryAlert.findOne({ ruleId: rule._id })).status, 'RESOLVED');
  assert.equal((await InventoryAlert.findById(legacy._id)).status, 'OPEN');
  await changeStock(p, 3);
  assert.equal(await InventoryAlert.countDocuments({ ruleId: rule._id }), 2);
  assert.equal(await InventoryAlert.countDocuments({ ruleId: rule._id, status: 'OPEN' }), 1);
});

test('two crossed rules create distinct events; disabled and cross-tenant rules are ignored', async () => {
  const p = await newProduct({ stock: 4 }), rules = await Promise.all([makeRule(p), makeRule(p, '<', 1)]);
  await makeRule(p, '<=', 4, { enabled: false });
  await makeRule(p, '<=', 3, { businessId: foreignBusiness });
  const movement = await changeStock(p, 0);
  const events = await InventoryAlert.find({ productId: p._id, source: 'stock_alert_rule' }).lean();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => String(e.ruleId)).sort(), rules.map(r => String(r._id)).sort());
  assert.ok(events.every(e => e.businessId === businessId && String(e.inventoryMovementId) === String(movement._id)));
});

test('rule creation while already below threshold is not retroactive', async () => {
  const p = await newProduct({ stock: 2 });
  const pending = await prepare('create_stock_alert_rule', { productId: String(p._id), operator: '<=', threshold: 3 });
  await service.confirmPendingAction(context(), pending.pendingActionId);
  assert.equal(await InventoryAlert.countDocuments({ businessId, productId: p._id }), 0);
  await changeStock(p, 1); assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 0);
  await changeStock(p, 5); await changeStock(p, 3);
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 1);
});

test('real unique index and concurrent evaluation prevent duplicate rule/movement events', async () => {
  const p = await newProduct({ stock: 4 }), rule = await makeRule(p);
  const movement = await changeStock(p, 3, { evaluateAlerts: false });
  const evaluate = async repeat => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      for (let i = 0; i < repeat; i++) await evaluateStockAlertRules({ businessId, productId: p._id,
        previousStock: 4, newStock: 3, inventoryMovementId: movement._id, session });
      await session.commitTransaction();
    } catch (error) { await session.abortTransaction(); throw error; }
    finally { await session.endSession(); }
  };
  const results = await Promise.allSettled([evaluate(2), evaluate(1)]);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected') assert.ok([11000, 112].includes(result.reason.code));
  await evaluate(1);
  assert.equal(await InventoryAlert.countDocuments({ businessId, ruleId: rule._id, inventoryMovementId: movement._id }), 1);
  const indexes = await InventoryAlert.collection.indexes();
  assert.ok(indexes.some(index => index.unique && index.key.ruleId && index.key.inventoryMovementId
    && index.partialFilterExpression.source === 'stock_alert_rule'));
  const existing = await InventoryAlert.findOne({ ruleId: rule._id }).lean();
  const { _id, ...duplicate } = existing;
  await assert.rejects(InventoryAlert.create({ ...duplicate, actionId: randomUUID() }), error => error.code === 11000);
});

test('alert persistence failure rolls stock and movement back; later audit failure also rolls back the alert', async () => {
  const p = await newProduct({ stock: 4 }); await makeRule(p);
  const before = await counts(); const original = InventoryAlert.updateOne;
  InventoryAlert.updateOne = () => { throw Error('synthetic alert persistence failure'); };
  try { await assert.rejects(changeStock(p, 3), /alert persistence/); }
  finally { InventoryAlert.updateOne = original; }
  assert.deepEqual(await counts(), before); assert.equal((await Product.findById(p._id)).stock, 4);
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 0);
  const failing = createActionService({ repository: createActionRepository({ audit: async () => { throw Error('synthetic audit failure'); } }) });
  const pending = await prepare('create_sale', saleArgs(p), failing);
  await assert.rejects(failing.confirmPendingAction(context(), pending.pendingActionId), { code: 'ACTION_EXECUTION_FAILED' });
  assert.deepEqual(await counts(), before); assert.equal((await Product.findById(p._id)).stock, 4);
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 0);
});

test('historical import, bootstrap, backfill and explicit internal exclusion produce no alerts; normal changes resume evaluation', async () => {
  const p = await newProduct({ stock: 4 }); await makeRule(p);
  for (const options of [{ source: 'historical_import' }, { source: 'backfill' }, { evaluateAlerts: false },
    { source: 'historical_import', evaluateAlerts: true }]) {
    await changeStock(p, 3, options); await changeStock(p, 4, options);
  }
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 0);
  await changeStock(p, 3); assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 1);
});

test('traditional sale, purchase cancellation and manual stock adjustment share the evaluator; request cannot disable it', async () => {
  const p = await newProduct({ stock: 4 }); await makeRule(p);
  await invoke(createTransaction, { ...req(), body: { ...saleArgs(p), type: 'sale', evaluateAlerts: false } });
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id, status: 'OPEN' }), 1);
  const purchase = await invoke(createTransaction, { ...req(), body: { ...saleArgs(p, { vendorId: String(vendor._id) }), type: 'purchase' } });
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id, status: 'OPEN' }), 0);
  await invoke(updateTransactionStatus, { ...req(), params: { id: String(purchase.data.transaction._id) }, body: { status: 'cancelled' } });
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id, status: 'OPEN' }), 1);
  await invoke(updateProductStock, { ...req(), params: { id: String(p._id) }, body: { operation: 'set', quantity: 5 } });
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id, status: 'OPEN' }), 0);
  await invoke(updateProductStock, { ...req(), params: { id: String(p._id) }, body: { operation: 'set', quantity: 3, evaluateAlerts: false } });
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id, status: 'OPEN' }), 1);
});

test('assistant sale/purchase confirmations use evaluator; previews, rule reads and repeated confirms never emit additional events', async () => {
  const p = await newProduct({ stock: 4 }); await makeRule(p);
  const sale = await prepare('create_sale', saleArgs(p));
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 0);
  await createAgentExecution({ context: createAgentRequestContext(req()) })
    .executeSkill({ agentId: 'operations', skillId: 'list_stock_alert_rules', args: { sku: p.sku } });
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 0);
  await service.confirmPendingAction(context(), sale.pendingActionId);
  await service.confirmPendingAction(context(), sale.pendingActionId);
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id }), 1);
  const purchase = await prepare('create_purchase', saleArgs(p, { vendorId: String(vendor._id) }));
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id, status: 'OPEN' }), 1);
  await service.confirmPendingAction(context(), purchase.pendingActionId);
  assert.equal(await InventoryAlert.countDocuments({ productId: p._id, status: 'OPEN' }), 0);
});

test('guided purchase retrieves real supplier costs and preview remains read-only', async () => {
  const p = await newProduct({ name: 'Arroz Superior Guiado', sku: 'GUIDED-ARROZ' });
  const adapter = withActionAssistant({}, service);
  const before = await counts();
  const first = await adapter.handle(req(), { conversationId, message: `Compré dos de ${p.sku}` });
  assert.match(first.suggestions[0].detail, /4 PEN/); assert.deepEqual(await counts(), before);
  const second = await adapter.handle(req(), { conversationId, message: 'Opción 1' });
  assert.equal(second.pendingAction.fields.total, 8); assert.equal(second.usage.totalTokens, 0); assert.deepEqual(await counts(), before);
  await service.cancelPendingAction(context(), second.pendingAction.pendingActionId);
});
test('guided product enrichment persists supplier association only after confirmation', async () => {
  const adapter = withActionAssistant({}, service);
  const first = await adapter.handle(req(), { conversationId, message: 'Agrega un producto Producto Guiado, SKU GUIDED-NUEVO, precio S/ 5, stock 2, mínimo 1, categoría Sintético' });
  assert.equal(first.pendingAction, undefined);
  await adapter.handle(req(), { conversationId, message: 'Elegir proveedor' });
  await adapter.handle(req(), { conversationId, message: '1' });
  const preview = await adapter.handle(req(), { conversationId, message: 'precio de compra 2.50' });
  assert.match(preview.pendingAction.fields.supplierCosts, /Proveedor sintético: 2.5 PEN/);
  assert.equal(await Product.exists({ businessId, sku: 'GUIDED-NUEVO' }), null);
  await service.confirmPendingAction(context(), preview.pendingAction.pendingActionId);
  const product = await Product.findOne({ businessId, sku: 'GUIDED-NUEVO' });
  assert.equal(String(product.supplierPrices[0].supplierId), String(vendor._id)); assert.equal(product.supplierPrices[0].purchasePrice, 2.5);
});
test('supplier association rejects a foreign vendor during preview', async () => {
  const [foreign] = await Contact.create([{ businessId: foreignBusiness, name: 'Proveedor ajeno', type: 'vendor', phone: '000' }]);
  await assert.rejects(prepare('create_product', { name: 'Ajeno', sku: 'GUIDED-REJECT', price: 2, currency: 'PEN', stock: 0,
    minStockLevel: 1, category: 'Sintético', supplierPrices: [{ supplierId: String(foreign._id), purchasePrice: 1 }] }), { code: 'ACTION_VALIDATION_FAILED' });
  assert.equal(await Product.exists({ businessId, sku: 'GUIDED-REJECT' }), null);
});
test('Mongo history restores a guided candidate draft after runtime restart without business writes', async () => {
  await newProduct({ name: 'Refresco Guiado 500ml', sku: 'GUIDED-REF-500' });
  await newProduct({ name: 'Refresco Guiado 1.5L', sku: 'GUIDED-REF-1500' });
  const firstRuntime = withActionAssistant({}, service);
  const history = createAgentConversationService({ runtime: firstRuntime, actionService: service });
  const before = await counts();
  const first = await history.send(req(), { message: 'Vende dos de refresco guiado' }, randomUUID());
  assert.equal(first.suggestions.length, 2); assert.deepEqual(await counts(), before);
  const restart = withActionAssistant({}, service);
  const resumed = createAgentConversationService({ runtime: restart, actionService: service });
  const restored = await resumed.get(req(), first.conversationId, 1, 20);
  const choices = restored.messages.find(row => row.response?.suggestions)?.response;
  assert.deepEqual(choices.suggestions, JSON.parse(JSON.stringify(first.suggestions)));
  assert.equal(choices.suggestionsExpiresAt, first.suggestionsExpiresAt);
  assert.ok(choices.suggestionsExpiresAt > Date.now());
  assert.match(choices.answer, /1\..+GUIDED-REF/);
  assert.deepEqual(await counts(), before);
  const next = await resumed.send(req(), { message: '2', conversationId: first.conversationId }, randomUUID());
  assert.equal(next.pendingAction.status, 'PENDING'); assert.equal(next.usage.totalTokens, 0);
  assert.deepEqual(await counts(), before);
  await service.cancelPendingAction(createActionContext(req(), { conversationId: first.conversationId }), next.pendingAction.pendingActionId);
});

test('real Mongo paginates 28 tenant matches and restores page two without business mutations', async () => {
  await Promise.all(Array.from({ length: 28 }, (_, i) => newProduct({ name: `PageFood group ${i}`, sku: `PAGEFOOD-${i}` })));
  await newProduct({ businessId: foreignBusiness, name: 'PageFood foreign', sku: 'PAGEFOOD-FOREIGN' });
  const before = await counts();
  const history = createAgentConversationService({ runtime: withActionAssistant({}, service), actionService: service });
  const first = await history.send(req(), { message: 'vende 2 PageFood' }, randomUUID());
  assert.equal(first.suggestionsPagination.totalMatches, 28); assert.equal(first.suggestions.length, 5);
  const second = await history.send(req(), { message: 'Ver más', conversationId: first.conversationId }, randomUUID());
  assert.equal(second.suggestionsPagination.offset, 5); assert.equal(second.suggestionsPagination.totalMatches, 28);
  assert.ok(second.suggestions.every(row => !first.suggestions.some(other => other.label.slice(3) === row.label.slice(3))));
  assert.ok(!JSON.stringify(second).includes('FOREIGN')); assert.equal(second.usage.totalLlmCalls, 0);
  const resumed = createAgentConversationService({ runtime: withActionAssistant({}, service), actionService: service });
  const loaded = await resumed.get(req(), first.conversationId, 1, 50);
  const restored = loaded.messages.filter(row => row.response?.suggestions).at(-1).response;
  assert.deepEqual(restored.suggestionsPagination, second.suggestionsPagination);
  assert.deepEqual(restored.suggestions, JSON.parse(JSON.stringify(second.suggestions)));
  assert.equal(restored.suggestionsExpiresAt, second.suggestionsExpiresAt);
  assert.deepEqual(await counts(), before);
  const selected = await resumed.send(req(), { message: 'el primero', conversationId: first.conversationId }, randomUUID());
  assert.equal(selected.pendingAction.items[0].quantity, 2); assert.equal(selected.usage.totalTokens, 0);
  assert.ok(second.suggestions[0].label.includes(selected.pendingAction.items[0].sku));
  await service.cancelPendingAction(createActionContext(req(), { conversationId: first.conversationId }), selected.pendingAction.pendingActionId);
});
test('real product preview writes no business record, confirmation creates one opening and two outbox records', async () => {
  const args = { name: 'Producto asistente', sku: 'AUTO-NEW', category: 'Sintético', price: 2, currency: 'PEN', stock: 5, minStockLevel: 1 };
  const before = await counts(); const pending = await prepare('create_product', args);
  assert.deepEqual(await counts(), before);
  const result = await service.confirmPendingAction(context(), pending.pendingActionId);
  assert.equal(result.result.stock, 5);
  assert.equal(await InventoryMovement.countDocuments({ businessId, productId: result.result.id }), 1);
  assert.equal(await Outbox.countDocuments({ businessId, actionId: pending.pendingActionId }), 2);
  assert.equal((await ActionAudit.findOne({ businessId, actionId: pending.pendingActionId })).resultSummary.stock, 5);
});
test('cash sale preview is read-only and confirmation uses canonical price, movement and idempotency', async () => {
  const p = await newProduct(), before = await counts(), pending = await prepare('create_sale', saleArgs(p));
  assert.deepEqual(await counts(), before); assert.equal((await Product.findById(p._id)).stock, 20);
  assert.deepEqual([pending.items[0].stock, pending.items[0].resultingStock, pending.fields.total], [20, 17, 30]);
  const result = await service.confirmPendingAction(context(), pending.pendingActionId);
  assert.equal(result.result.total, 30); assert.equal((await Product.findById(p._id)).stock, 17);
  const tx = await Transaction.findById(result.result.id); assert.equal(tx.paymentMethod, 'cash'); assert.equal(tx.products[0].price, 10);
  assert.equal(await InventoryMovement.countDocuments({ businessId, transactionId: tx._id }), 1);
  assert.deepEqual((await service.confirmPendingAction(context(), pending.pendingActionId)).result, result.result);
  assert.equal(await Transaction.countDocuments({ _id: tx._id, businessId }), 1);
});
test('sale insufficient stock rejected before PendingAction', async () => {
  const p = await newProduct({ stock: 1 }), before = await counts();
  await assert.rejects(prepare('create_sale', saleArgs(p)), { code: 'ACTION_VALIDATION_FAILED' });
  assert.deepEqual(await counts(), before);
});
test('parallel confirmation executes exactly once; repeated request retrieves committed result', async () => {
  const p = await newProduct(), pending = await prepare('create_sale', saleArgs(p));
  const results = await Promise.allSettled([1, 2].map(() => service.confirmPendingAction(context(), pending.pendingActionId)));
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal((await Product.findById(p._id)).stock, 17);
  const done = await service.confirmPendingAction(context(), pending.pendingActionId);
  assert.equal(await Transaction.countDocuments({ _id: done.result.id, businessId }), 1);
  assert.equal(await Outbox.countDocuments({ businessId, actionId: pending.pendingActionId, type: 'SALE_CREATED' }), 1);
});
for (const field of ['stock', 'price', 'currency', 'isActive']) test(`mutable sale ${field} change conflicts without partial writes`, async () => {
  const p = await newProduct(), pending = await prepare('create_sale', saleArgs(p));
  await Product.updateOne({ _id: p._id, businessId }, { $set: { [field]: { stock: 19, price: 11, currency: 'USD', isActive: false }[field] } });
  const before = await counts(); await assert.rejects(service.confirmPendingAction(context(), pending.pendingActionId), { code: 'ACTION_CONFLICT' });
  assert.deepEqual(await counts(), before); assert.equal(await Outbox.countDocuments({ businessId, actionId: pending.pendingActionId }), 0);
});
test('multi-item and repeated-product sale use cumulative stock; insufficient later item rolls back', async () => {
  const p = await newProduct(), q = await newProduct();
  const args = { products: [{ productId: String(p._id), quantity: 2 }, { productId: String(q._id), quantity: 3 }, { productId: String(p._id), quantity: 1 }], currency: 'PEN' };
  const pending = await prepare('create_sale', args); assert.equal(pending.items[2].stock, 18);
  const done = await service.confirmPendingAction(context(), pending.pendingActionId);
  assert.equal(done.result.items.length, 3); assert.equal((await Product.findById(p._id)).stock, 17);
  assert.equal(await InventoryMovement.countDocuments({ businessId, transactionId: done.result.id }), 3);
  await assert.rejects(prepare('create_sale', { ...args, products: [...args.products, { productId: String(q._id), quantity: 999 }] }), { code: 'ACTION_VALIDATION_FAILED' });
});
test('credit sale preserves balances and credit limit; no CreditPayment is fabricated', async () => {
  const p = await newProduct(); const pending = await prepare('create_sale', saleArgs(p, { customerId: String(customer._id), paymentMethod: 'credit' }));
  await service.confirmPendingAction(context(), pending.pendingActionId);
  const contact = await Contact.findById(customer._id); assert.equal(contact.currentBalance, 30); assert.equal(contact.balancesByCurrency.PEN, 30);
  assert.equal(await CreditPayment.countDocuments({ businessId }), 0);
  await assert.rejects(prepare('create_sale', { ...saleArgs(p), paymentMethod: 'credit' }), { code: 'ACTION_VALIDATION_FAILED' });
  await assert.rejects(prepare('create_sale', { ...saleArgs(p, { customerId: String(customer._id), paymentMethod: 'credit' }), products: [{ productId: String(p._id), quantity: 10 }] }), { code: 'ACTION_VALIDATION_FAILED' });
});
test('changed customer balance prevents stale credit confirmation', async () => {
  const p = await newProduct(), pending = await prepare('create_sale', saleArgs(p, { customerId: String(customer._id), paymentMethod: 'credit' }));
  await Contact.updateOne({ _id: customer._id, businessId }, { $set: { currentBalance: 35, 'balancesByCurrency.PEN': 35 } });
  const before = await counts(); await assert.rejects(service.confirmPendingAction(context(), pending.pendingActionId), { code: 'ACTION_CONFLICT' });
  assert.deepEqual(await counts(), before);
});
test('purchase increments stock using configured supplier cost, with idempotent confirmation', async () => {
  const p = await newProduct(); const pending = await prepare('create_purchase', saleArgs(p, { vendorId: String(vendor._id) }));
  assert.equal(pending.fields.total, 12); assert.equal(pending.items[0].resultingStock, 23);
  assert.equal((await Product.findById(p._id)).stock, 20);
  const result = await service.confirmPendingAction(context(), pending.pendingActionId);
  assert.equal((await Product.findById(p._id)).stock, 23);
  assert.equal((await Transaction.findById(result.result.id)).products[0].costPrice, 4);
  assert.deepEqual((await service.confirmPendingAction(context(), pending.pendingActionId)).result, result.result);
  assert.equal(await InventoryMovement.countDocuments({ businessId, transactionId: result.result.id }), 1);
});
test('purchase validates supplier, missing price and foreign product/contact ownership', async () => {
  const p = await newProduct(), foreign = await newProduct({ businessId: foreignBusiness });
  for (const args of [saleArgs(p), saleArgs(p, { vendorId: String(customer._id) }), saleArgs(foreign, { vendorId: String(vendor._id) })])
    await assert.rejects(prepare('create_purchase', args), { code: 'ACTION_VALIDATION_FAILED' });
  const other = await Contact.create({ businessId, name: 'Otro sintético', phone: '000000003', type: 'vendor' });
  await assert.rejects(prepare('create_purchase', saleArgs(p, { vendorId: String(other._id) })), { code: 'ACTION_VALIDATION_FAILED' });
  await assert.rejects(prepare('create_sale', saleArgs(foreign)), { code: 'ACTION_VALIDATION_FAILED' });
  for (const ref of [String(foreign._id), foreign.sku]) assert.ok((await resolveReference(Product, context(), ref)).clarification);
});
test('changed supplier cost conflicts instead of silently charging new cost', async () => {
  const p = await newProduct(), pending = await prepare('create_purchase', saleArgs(p, { vendorId: String(vendor._id) }));
  await Product.updateOne({ _id: p._id, businessId }, { $set: { 'supplierPrices.0.purchasePrice': 5 } });
  const before = await counts(); await assert.rejects(service.confirmPendingAction(context(), pending.pendingActionId), { code: 'ACTION_CONFLICT' });
  assert.deepEqual(await counts(), before);
});
for (const type of ['sale', 'purchase']) test(`real ${type} rollback on audit failure includes movements, stock, outbox and credit`, async () => {
  const p = await newProduct(); const repo = createActionRepository({ audit: async () => { throw Error('synthetic audit failure'); } });
  const failing = createActionService({ repository: repo });
  const args = saleArgs(p, type === 'sale' ? { customerId: String(customer._id), paymentMethod: 'credit' } : { vendorId: String(vendor._id) });
  const pending = await prepare(`create_${type}`, args, failing), before = await counts();
  const balanceBefore = (await Contact.findById(customer._id)).currentBalance;
  await assert.rejects(failing.confirmPendingAction(context(), pending.pendingActionId), { code: 'ACTION_EXECUTION_FAILED' });
  assert.deepEqual(await counts(), before); assert.equal((await Product.findById(p._id)).stock, 20);
  assert.equal((await Contact.findById(customer._id)).currentBalance, balanceBefore);
});
test('foreign tenant/user cannot see or confirm; cancel and expiry never write business data', async () => {
  const p = await newProduct(), pending = await prepare('create_sale', saleArgs(p)), before = await counts();
  const foreignCtx = createActionContext(req(foreignBusiness), { conversationId });
  await assert.rejects(service.get(foreignCtx, pending.pendingActionId), { code: 'ACTION_NOT_ALLOWED' });
  await assert.rejects(service.confirmPendingAction(foreignCtx, pending.pendingActionId), { code: 'ACTION_NOT_ALLOWED' });
  await service.cancelPendingAction(context(), pending.pendingActionId);
  await assert.rejects(service.confirmPendingAction(context(), pending.pendingActionId), { code: 'ACTION_CANCELLED' });
  const expired = await prepare('create_sale', saleArgs(p));
  await PendingAction.updateOne({ businessId, pendingActionId: expired.pendingActionId }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await service.get(context(), expired.pendingActionId)).status, 'EXPIRED');
  await assert.rejects(service.confirmPendingAction(context(), expired.pendingActionId), { code: 'ACTION_EXPIRED' });
  const after = await counts(); assert.deepEqual(after.slice(0, 4), before.slice(0, 4));
});
test('history replay reads authoritative executed/expired cards without executing actions', async () => {
  const p = await newProduct(), pending = await prepare('create_sale', saleArgs(p));
  const done = await service.confirmPendingAction(context(), pending.pendingActionId), before = await counts();
  const expired = await prepare('create_sale', saleArgs(p));
  await PendingAction.updateOne({ businessId, pendingActionId: expired.pendingActionId }, { $set: { expiresAt: new Date(0) } });
  const history = createAgentConversationService({ runtime: {}, actionService: service, repository: {
    findConversation: async () => ({ conversationId }), messages: async () => ({ messages: [pending, expired].map(card => ({ _id: new mongoose.Types.ObjectId(), role: 'assistant', text: 'Revisa', response: { pendingAction: card } })) }) } });
  const replay = await history.get(req(), conversationId, 1, 10);
  assert.equal(replay.messages[0].response.pendingAction.status, 'EXECUTED');
  assert.equal(replay.messages[0].response.pendingAction.result.id, done.result.id);
  assert.equal(replay.messages[1].response.pendingAction.status, 'EXPIRED'); assert.deepEqual(await counts(), before);
});
test('traditional CRUD delegates to identical shared pricing/stock logic and keeps public response', async () => {
  const p = await newProduct(); let result;
  await new Promise((resolve, reject) => createTransaction({ ...req(), body: { ...saleArgs(p), type: 'sale' } }, {
    status(code) { assert.equal(code, 201); return this; }, json(body) { result = body; resolve(); }
  }, reject));
  assert.equal(result.data.transaction.totalAmount, 30); assert.equal((await Product.findById(p._id)).stock, 17);
});
test('real natural-language sale resolves tenant SKU and prepares with zero tokens', async () => {
  const p = await newProduct();
  const adapter = require('../../src/automations/assistant').withActionAssistant({}, service);
  const prepared = await adapter.handle(req(), { conversationId, message: `Vende 3 unidades de ${p.sku}` });
  assert.equal(prepared.pendingAction.status, 'PENDING'); assert.equal(prepared.usage.totalTokens, 0);
  assert.equal((await Product.findById(p._id)).stock, 20);
  const done = await service.confirmPendingAction(context(), prepared.pendingAction.pendingActionId);
  assert.equal(done.result.items[0].stock, 17);
});
test('real multi-item purchase updates both products and preserves supplier costs', async () => {
  const p = await newProduct(), q = await newProduct({ supplierPrices: [{ supplierId: vendor._id, purchasePrice: 6 }] });
  const pending = await prepare('create_purchase', { currency: 'PEN', vendorId: String(vendor._id),
    products: [{ productId: String(p._id), quantity: 2 }, { productId: String(q._id), quantity: 4 }] });
  assert.equal(pending.fields.total, 32);
  const done = await service.confirmPendingAction(context(), pending.pendingActionId);
  assert.equal((await Product.findById(p._id)).stock, 22); assert.equal((await Product.findById(q._id)).stock, 24);
  assert.equal(await InventoryMovement.countDocuments({ businessId, transactionId: done.result.id }), 2);
});
test('real unambiguous name resolution and duplicate names never leak or guess', async () => {
  const p = await newProduct({ name: 'Nombre único sintético' });
  assert.equal(String((await resolveReference(Product, context(), p.name)).value._id), String(p._id));
  await newProduct({ name: p.name }); assert.match((await resolveReference(Product, context(), p.name)).clarification, /varias/);
});
test('frozen snapshot integrity check blocks persisted tampering before writes', async () => {
  const p = await newProduct(), pending = await prepare('create_sale', saleArgs(p)), before = await counts();
  await PendingAction.updateOne({ businessId, pendingActionId: pending.pendingActionId }, { $set: { 'preview.snapshot.totalAmount': 0.01 } });
  await assert.rejects(service.confirmPendingAction(context(), pending.pendingActionId), { code: 'ACTION_CONFLICT' });
  assert.deepEqual(await counts(), before); assert.equal((await Product.findById(p._id)).stock, 20);
});
test('two distinct pending sales cannot both execute against the same preview stock', async () => {
  const p = await newProduct(), first = await prepare('create_sale', saleArgs(p)), second = await prepare('create_sale', saleArgs(p));
  await service.confirmPendingAction(context(), first.pendingActionId);
  await assert.rejects(service.confirmPendingAction(context(), second.pendingActionId), { code: 'ACTION_CONFLICT' });
  assert.equal((await Product.findById(p._id)).stock, 17);
  assert.equal(await Transaction.countDocuments({ businessId, 'products.productId': p._id }), 1);
});
