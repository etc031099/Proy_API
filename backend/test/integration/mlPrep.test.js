const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');

const {
  Product, Contact, Transaction, CreditPayment,
  InventoryMovement, HistoricalScenario
} = require('../../src/models');
const { createProduct, updateProductStock } = require('../../src/controllers/productController');
const {
  createTransaction,
  updateTransactionStatus
} = require('../../src/controllers/transactionController');
const { reconstructStockAt } = require('../../src/services/inventoryService');
const {
  importHistoricalScenario,
  resetHistoricalScenario
} = require('../../scripts/lib/historicalScenario');

const testUri = process.env.MONGODB_TEST_URI;
const runId = `${Date.now()}-${process.pid}`;
const businessId = `ml-prep-${runId}`;
const otherBusinessId = `ml-prep-other-${runId}`;
const originalFetch = global.fetch;
const tempFiles = [];
let counter = 0;

const invokeController = (controller, req) => new Promise((resolve, reject) => {
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { resolve({ statusCode, body }); return this; }
  };
  controller(req, res, reject);
});

const createApiProduct = async (stock = 10, business = businessId, overrides = {}) => {
  const response = await invokeController(createProduct, {
    businessId: business,
    body: {
      name: `ML-PREP product ${++counter}`,
      price: 10,
      currency: 'PEN',
      costPrice: 6,
      stock,
      category: 'ML-PREP',
      ...overrides
    }
  });
  assert.equal(response.statusCode, 201);
  return response.body.data.product;
};

const createContact = (type, business = businessId, overrides = {}) => Contact.create({
  name: `ML-PREP ${type} ${++counter}`,
  phone: `ml-prep-${runId}-${counter}`,
  type,
  businessId: business,
  ...overrides
});

const createApiTransaction = (body, business = businessId) => invokeController(
  createTransaction,
  { businessId: business, body }
);

const writeNdjson = records => {
  const file = path.join(os.tmpdir(), `ml-prep-${runId}-${++counter}.ndjson`);
  fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  tempFiles.push(file);
  return file;
};

test.before(async () => {
  if (!testUri) throw new Error('MONGODB_TEST_URI is required for ML-PREP tests');
  await mongoose.connect(testUri, { serverSelectionTimeoutMS: 10000 });
  if (!mongoose.connection.name.endsWith('_test')) {
    throw new Error(`Refusing non-test database: ${mongoose.connection.name}`);
  }
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
  await Promise.all([
    Product.init(), Contact.init(), Transaction.init(), CreditPayment.init(),
    InventoryMovement.init(), HistoricalScenario.init()
  ]);
  global.fetch = async url => ({
    ok: true,
    json: async () => ({ rates: String(url).includes('/PEN') ? { PEN: 1, USD: 1, EUR: 1 } : { PEN: 1, USD: 1, EUR: 1 } })
  });
});

test.after(async () => {
  global.fetch = originalFetch;
  for (const file of tempFiles) fs.rmSync(file, { force: true });
  const businesses = { $in: [businessId, otherBusinessId] };
  await Promise.all([
    InventoryMovement.collection.deleteMany({ businessId: businesses }),
    CreditPayment.deleteMany({ businessId: businesses }),
    Transaction.deleteMany({ businessId: businesses }),
    Product.deleteMany({ businessId: businesses }),
    Contact.deleteMany({ businessId: businesses }),
    HistoricalScenario.deleteMany({ businessId: businesses })
  ]);
  await mongoose.disconnect();
});

test('opening movement is created atomically for positive initial stock', async () => {
  const product = await createApiProduct(10);
  const movement = await InventoryMovement.findOne({ productId: product._id });
  assert.deepEqual(
    [movement.type, movement.quantityDelta, movement.stockBefore, movement.stockAfter],
    ['opening', 10, 0, 10]
  );
  assert.equal(movement.transactionId, null);
});

test('zero opening stock does not create a zero movement', async () => {
  const product = await createApiProduct(0);
  assert.equal(await InventoryMovement.countDocuments({ productId: product._id }), 0);
});

test('completed purchase writes positive stock movement with canonical cost', async () => {
  const vendor = await createContact('vendor');
  const product = await createApiProduct(3, businessId, {
    supplierPrices: [{ supplierId: vendor._id, purchasePrice: 6 }],
    preferredSupplierId: vendor._id
  });
  const response = await createApiTransaction({
    type: 'purchase', vendorId: vendor._id, currency: 'PEN', paymentMethod: 'cash',
    products: [{ productId: product._id, quantity: 4, costPrice: 999999 }]
  });
  const transaction = response.body.data.transaction;
  const movement = await InventoryMovement.findOne({ transactionId: transaction._id });
  assert.equal(transaction.products[0].costPrice, 6);
  assert.deepEqual([movement.type, movement.quantityDelta, movement.stockBefore, movement.stockAfter], ['purchase', 4, 3, 7]);
});

test('completed sale writes negative movement with canonical price', async () => {
  const product = await createApiProduct(8);
  const response = await createApiTransaction({
    type: 'sale', currency: 'PEN', paymentMethod: 'cash',
    products: [{ productId: product._id, quantity: 2, price: 0.01 }]
  });
  const transaction = response.body.data.transaction;
  const movement = await InventoryMovement.findOne({ transactionId: transaction._id });
  assert.equal(transaction.products[0].price, 10);
  assert.deepEqual([movement.type, movement.quantityDelta, movement.stockBefore, movement.stockAfter], ['sale', -2, 8, 6]);
});

test('sale cancellation restores stock and sets cancelledAt once', async () => {
  const product = await createApiProduct(8);
  const sale = await createApiTransaction({
    type: 'sale', paymentMethod: 'cash', currency: 'PEN',
    products: [{ productId: product._id, quantity: 2 }]
  });
  const id = sale.body.data.transaction._id;
  assert.equal((await Transaction.findById(id)).cancelledAt, null);
  const first = await invokeController(updateTransactionStatus, {
    businessId, params: { id }, body: { status: 'cancelled', cancelledAt: '1990-01-01' }
  });
  const stored = await Transaction.findById(id);
  const originalCancelledAt = stored.cancelledAt.getTime();
  assert.equal(first.statusCode, 200);
  assert.ok(stored.cancelledAt > stored.createdAt);
  assert.notEqual(stored.cancelledAt.toISOString(), '1990-01-01T00:00:00.000Z');
  await invokeController(updateTransactionStatus, {
    businessId, params: { id }, body: { status: 'cancelled' }
  });
  assert.equal((await Transaction.findById(id)).cancelledAt.getTime(), originalCancelledAt);
  assert.equal(await InventoryMovement.countDocuments({ transactionId: id, type: 'cancellation' }), 1);
});

test('purchase cancellation creates the inverse movement', async () => {
  const vendor = await createContact('vendor');
  const product = await createApiProduct(2, businessId, {
    supplierPrices: [{ supplierId: vendor._id, purchasePrice: 6 }]
  });
  const purchase = await createApiTransaction({
    type: 'purchase', vendorId: vendor._id, paymentMethod: 'cash', currency: 'PEN',
    products: [{ productId: product._id, quantity: 3 }]
  });
  const id = purchase.body.data.transaction._id;
  await invokeController(updateTransactionStatus, {
    businessId, params: { id }, body: { status: 'cancelled' }
  });
  const movements = await InventoryMovement.find({ transactionId: id }).sort({ occurredAt: 1 });
  assert.deepEqual(movements.map(item => item.quantityDelta), [3, -3]);
  assert.equal((await Product.findById(product._id)).stock, 2);
});

test('manual increment, decrement and set create exact adjustments', async () => {
  const product = await createApiProduct(10);
  for (const [operation, quantity, expectedDelta, expectedStock] of [
    ['add', 4, 4, 14], ['subtract', 3, -3, 11], ['set', 5, -6, 5]
  ]) {
    await invokeController(updateProductStock, {
      businessId, params: { id: product._id }, body: { operation, quantity }
    });
    const movement = await InventoryMovement.findOne({
      productId: product._id, type: 'manual_adjustment', stockAfter: expectedStock
    });
    assert.equal(movement.quantityDelta, expectedDelta);
  }
});

test('movement failure rolls back the corresponding product stock write', async () => {
  const product = await createApiProduct(10);
  const originalCreate = InventoryMovement.create;
  InventoryMovement.create = async () => { throw new Error('deliberate movement failure'); };
  try {
    await assert.rejects(
      invokeController(updateProductStock, {
        businessId, params: { id: product._id }, body: { operation: 'add', quantity: 2 }
      }),
      /deliberate movement failure/
    );
  } finally {
    InventoryMovement.create = originalCreate;
  }
  assert.equal((await Product.findById(product._id)).stock, 10);
});

test('movement schema enforces the stock equation and append-only policy', async () => {
  const product = await createApiProduct(1);
  await assert.rejects(InventoryMovement.create({
    businessId, productId: product._id, type: 'manual_adjustment',
    quantityDelta: 2, stockBefore: 1, stockAfter: 4, source: 'api'
  }), /stockAfter/);
  const movement = await InventoryMovement.findOne({ productId: product._id });
  await assert.rejects(
    InventoryMovement.updateOne({ _id: movement._id }, { $set: { stockAfter: 9 } }),
    /append-only/
  );
  movement.occurredAt = new Date(movement.occurredAt.getTime() + 1000);
  await assert.rejects(movement.save(), /append-only/);
});

test('historical and current stock reconstruction uses movements only', async () => {
  const product = await createApiProduct(10);
  const opening = await InventoryMovement.findOne({ productId: product._id });
  await invokeController(updateProductStock, {
    businessId, params: { id: product._id }, body: { operation: 'add', quantity: 4 }
  });
  assert.equal(await reconstructStockAt(businessId, product._id, opening.occurredAt), 10);
  assert.equal(await reconstructStockAt(businessId, product._id, new Date()), 14);
  assert.equal((await Product.findById(product._id)).stock, 14);
});

test('stock reconstruction is tenant isolated', async () => {
  const product = await createApiProduct(5);
  assert.equal(await reconstructStockAt(otherBusinessId, product._id, new Date()), 0);
});

test('invalid status transition preserves status and cancelledAt', async () => {
  const product = await createApiProduct(3);
  const transaction = await Transaction.create({
    type: 'sale', status: 'pending', customerName: 'Final', businessId,
    products: [{ productId: product._id, productName: product.name, quantity: 1, price: 10, total: 10 }],
    totalAmount: 10
  });
  await assert.rejects(invokeController(updateTransactionStatus, {
    businessId, params: { id: transaction._id }, body: { status: 'cancelled' }
  }), /cannot transition/);
  const stored = await Transaction.findById(transaction._id);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.cancelledAt, null);
});

const scenarioRecords = ({ scenarioId }) => {
  const vendorId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const productId = new mongoose.Types.ObjectId();
  const purchaseId = new mongoose.Types.ObjectId();
  const creditSaleId = new mongoose.Types.ObjectId();
  const cashSaleId = new mongoose.Types.ObjectId();
  const paymentId = new mongoose.Types.ObjectId();
  const at = (day) => `2024-01-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  return {
    ids: { vendorId, customerId, productId, purchaseId, creditSaleId, cashSaleId, paymentId },
    records: [
      { eventType: 'contact.created', eventId: `${scenarioId}-vendor`, occurredAt: at(1), payload: { _id: vendorId, name: 'Historical vendor', phone: `${scenarioId}-v`, type: 'vendor' } },
      { eventType: 'contact.created', eventId: `${scenarioId}-customer`, occurredAt: at(2), payload: { _id: customerId, name: 'Historical customer', phone: `${scenarioId}-c`, type: 'customer', creditLimit: 1000 } },
      { eventType: 'product.created', eventId: `${scenarioId}-product`, occurredAt: at(3), payload: { _id: productId, name: 'Historical product', price: 10, costPrice: 6, stock: 10, currency: 'PEN', category: 'Historical', supplierPrices: [{ supplierId: vendorId, purchasePrice: 6 }] } },
      { eventType: 'transaction.completed', eventId: `${scenarioId}-purchase`, occurredAt: at(4), payload: { _id: purchaseId, type: 'purchase', vendorId, currency: 'PEN', paymentMethod: 'cash', exchangeRates: { 'USD/PEN': 3.7 }, products: [{ productId, quantity: 5, costPrice: 999999 }] } },
      { eventType: 'transaction.completed', eventId: `${scenarioId}-credit-sale`, occurredAt: at(5), payload: { _id: creditSaleId, type: 'sale', customerId, currency: 'PEN', paymentMethod: 'credit', exchangeRates: { 'USD/PEN': 3.7 }, products: [{ productId, quantity: 2, price: 0.01 }] } },
      { eventType: 'credit-payment.created', eventId: `${scenarioId}-payment`, occurredAt: at(6), payload: { _id: paymentId, customerId, amount: 5, currency: 'PEN', paymentMethod: 'cash' } },
      { eventType: 'transaction.completed', eventId: `${scenarioId}-cash-sale`, occurredAt: at(7), payload: { _id: cashSaleId, type: 'sale', customerId, currency: 'PEN', paymentMethod: 'cash', exchangeRates: { 'USD/PEN': 3.7 }, products: [{ productId, quantity: 1 }] } },
      { eventType: 'transaction.cancelled', eventId: `${scenarioId}-cancel`, occurredAt: at(8), payload: { transactionId: cashSaleId } }
    ]
  };
};

test('NDJSON importer preserves dates, canonical values, stock, credit and cancellation', async () => {
  const scenarioId = `scenario-${runId}`;
  const { records, ids } = scenarioRecords({ scenarioId });
  const filePath = writeNdjson(records);
  const result = await importHistoricalScenario({ filePath, businessId, scenarioId, batchSize: 2 });
  assert.equal(result.importedRecords, 8);
  const [product, purchase, creditSale, cashSale, payment, movements, customer, vendor] = await Promise.all([
    Product.findById(ids.productId), Transaction.findById(ids.purchaseId),
    Transaction.findById(ids.creditSaleId), Transaction.findById(ids.cashSaleId),
    CreditPayment.findById(ids.paymentId),
    InventoryMovement.find({ businessId, scenarioId }).sort({ occurredAt: 1 }),
    Contact.findById(ids.customerId), Contact.findById(ids.vendorId)
  ]);
  assert.equal(vendor.createdAt.toISOString(), records[0].occurredAt);
  assert.equal(product.createdAt.toISOString(), records[2].occurredAt);
  assert.equal(purchase.date.toISOString(), records[3].occurredAt);
  assert.equal(payment.date.toISOString(), records[5].occurredAt);
  assert.equal(purchase.products[0].costPrice, 6);
  assert.equal(creditSale.products[0].price, 10);
  assert.equal(product.stock, 13);
  assert.equal(customer.currentBalance, 15);
  assert.equal(cashSale.status, 'cancelled');
  assert.equal(cashSale.cancelledAt.toISOString(), records[7].occurredAt);
  assert.deepEqual(movements.map(item => item.quantityDelta), [10, 5, -2, -1, 1]);
  assert.equal(movements[0].occurredAt.toISOString(), records[2].occurredAt);
});

test('second import of the same scenario and file is an idempotent no-op', async () => {
  const scenarioId = `idempotent-${runId}`;
  const fixture = scenarioRecords({ scenarioId });
  const filePath = writeNdjson(fixture.records);
  await importHistoricalScenario({ filePath, businessId, scenarioId });
  const before = await InventoryMovement.countDocuments({ businessId, scenarioId });
  const second = await importHistoricalScenario({ filePath, businessId, scenarioId });
  assert.equal(second.alreadyImported, true);
  assert.equal(await InventoryMovement.countDocuments({ businessId, scenarioId }), before);
});

test('import rejects non-causal order and marks a partial scenario failed', async () => {
  const scenarioId = `failed-${runId}`;
  const firstId = new mongoose.Types.ObjectId();
  const filePath = writeNdjson([
    { eventType: 'contact.created', eventId: 'later', occurredAt: '2024-02-02T00:00:00Z', payload: { _id: firstId, name: 'Partial', phone: `partial-${runId}`, type: 'vendor' } },
    { eventType: 'product.created', eventId: 'earlier', occurredAt: '2024-02-01T00:00:00Z', payload: { _id: new mongoose.Types.ObjectId(), name: 'Invalid order', price: 1, stock: 1, category: 'X' } }
  ]);
  await assert.rejects(
    importHistoricalScenario({ filePath, businessId, scenarioId }),
    /causal time order/
  );
  assert.equal((await HistoricalScenario.findOne({ businessId, scenarioId })).status, 'failed');
  assert.ok(await Contact.exists({ _id: firstId, businessId, scenarioId }));
  assert.equal(await Product.countDocuments({ businessId, scenarioId }), 0);
});

test('scenario reset deletes only the requested business and scenario', async () => {
  const scenarioId = `reset-${runId}`;
  const fixture = scenarioRecords({ scenarioId });
  const filePath = writeNdjson(fixture.records);
  await importHistoricalScenario({ filePath, businessId, scenarioId });
  const foreign = await Product.create({
    name: 'Foreign preserved', price: 1, stock: 1, category: 'X',
    businessId: otherBusinessId, scenarioId
  });
  const reset = await resetHistoricalScenario({ businessId, scenarioId, batchSize: 2 });
  assert.equal(reset.found, true);
  assert.equal(await Product.countDocuments({ businessId, scenarioId }), 0);
  assert.ok(await Product.findById(foreign._id));
  assert.equal(await HistoricalScenario.countDocuments({ businessId, scenarioId }), 0);
});

test('InventoryMovement has no public route and required indexes are present', async () => {
  const indexes = await InventoryMovement.collection.indexes();
  assert.ok(indexes.some(index => index.name === 'businessId_1_productId_1_occurredAt_1_createdAt_1'));
  const idempotency = indexes.find(index => index.name === 'businessId_1_scenarioId_1_sourceEventId_1');
  assert.equal(idempotency.unique, true);
  const appSource = fs.readFileSync(path.join(__dirname, '../../src/app.js'), 'utf8');
  assert.doesNotMatch(appSource, /inventory-movements/);
  const initSource = fs.readFileSync(path.join(__dirname, '../../init-mongo.js'), 'utf8');
  assert.match(initSource, /inventorymovements/);
  assert.match(initSource, /businessId_1_scenarioId_1_sourceEventId_1/);
});
