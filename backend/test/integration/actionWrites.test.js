const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { Product, Transaction, Contact, InventoryMovement, CreditPayment } = require('../../src/models');
const PendingAction = require('../../src/models/PendingAction');
const ActionAudit = require('../../src/models/ActionAudit');
const Outbox = require('../../src/models/ActionDomainEvent');
const Conversation = require('../../src/models/AgentConversation');
const { createActionContext } = require('../../src/automations/contracts');
const { createActionService } = require('../../src/automations/execution');
const { createActionRepository } = require('../../src/automations/repository');
const { createActionExecutors } = require('../../src/automations/executors');
const { resolveReference } = require('../../src/automations/actionInput');
const { createAgentConversationService } = require('../../src/services/agentConversationService');
const { createTransaction } = require('../../src/controllers/transactionController');
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
  await Promise.all([Product, Contact, Transaction, InventoryMovement, CreditPayment, PendingAction, ActionAudit, Outbox, Conversation].map(model => model.init()));
  global.fetch = async () => ({ ok: true, json: async () => ({ rates: { USD: 1, PEN: 3.7, EUR: 0.92 } }) });
  [vendor, customer] = await Contact.create([{ businessId, name: 'Proveedor sintético', type: 'vendor', phone: '000000000' },
    { businessId, name: 'Cliente sintético', type: 'customer', phone: '000000001', creditLimit: 100 }]);
  await Conversation.create({ businessId, userId, conversationId, title: 'AUTO-R2 sintético', lastMessageAt: new Date() });
});
test.after(async () => {
  global.fetch = originalFetch;
  if (mongoose.connection.readyState === 1 && mongoose.connection.name.endsWith('_test')) {
    const filter = { businessId: { $in: [businessId, foreignBusiness] } };
    await Promise.all([Product, Contact, Transaction, CreditPayment, PendingAction, ActionAudit, Outbox, Conversation].map(model => model.deleteMany(filter)));
    await InventoryMovement.collection.deleteMany(filter); // Fixture-only cleanup; production remains append-only.
  }
  await mongoose.disconnect();
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
