const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const telegram = require('../src/services/telegramService');
const { Product } = require('../src/models');
const { Transaction } = require('../src/models');
const writeService = require('../src/services/transactionWriteService');
const inventoryService = require('../src/services/inventoryService');
const snapshotService = require('../src/services/v3OperationalSnapshotService');

test('low-stock READ endpoint never invokes Telegram', async (t) => {
  let sends = 0;
  t.mock.method(telegram, 'notifyLowStock', async () => { sends += 1; });
  t.mock.method(Product, 'findLowStock', async (businessId) => {
    assert.equal(businessId, 'tenant-read');
    return [{ name: 'Producto sintético', stock: 1, minStockLevel: 3 }];
  });
  const { getLowStockProducts } = require('../src/controllers/productController');
  let payload;
  await new Promise((resolve, reject) => getLowStockProducts({ businessId: 'tenant-read' }, {
    json(value) { payload = value; resolve(); }
  }, reject));
  assert.equal(payload.data.products[0].stock, 1);
  assert.equal(sends, 0);
});

test('failed transaction never invokes the post-commit Telegram notifier', async (t) => {
  let sends = 0;
  t.mock.method(telegram, 'notifyLowStock', async () => { sends += 1; });
  t.mock.method(writeService, 'writeTransaction', async () => {
    throw Object.assign(new Error('synthetic transaction failure'), { code: 'TEST_ABORT' });
  });
  const { createTransaction } = require('../src/controllers/transactionController');
  const error = await new Promise((resolve) => createTransaction({
    body: {}, businessId: 'tenant-write-failure', historicalContext: null
  }, {}, resolve));
  assert.equal(error.code, 'TEST_ABORT');
  assert.equal(sends, 0);
});

test('purchase cancellation alerts only after a committed crossing into low stock', async (t) => {
  let failCommit = true;
  let committed = false;
  let active = false;
  const session = {
    startTransaction() { active = true; committed = false; },
    inTransaction() { return active; },
    async commitTransaction() {
      if (failCommit) throw new Error('synthetic commit failure');
      active = false; committed = true;
    },
    async abortTransaction() { active = false; },
    async endSession() {}
  };
  const notifications = [];
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(telegram, 'notifyLowStock', async (...args) => {
    assert.equal(committed, true);
    notifications.push(args);
  });
  t.mock.method(inventoryService, 'applyStockChange', async ({ product, quantityDelta }) => {
    product.stock += quantityDelta;
  });
  t.mock.method(snapshotService, 'recordV3Transaction', async () => {});
  const makeRows = () => {
    const product = { _id: 'product-id', businessId: 'tenant-a', sku: 'SKU-TEST', name: 'Producto sintético', stock: 4, minStockLevel: 3 };
    const transaction = { _id: 'transaction-id', type: 'purchase', status: 'completed',
      createdAt: new Date('2026-10-01T00:00:00Z'), date: new Date('2026-10-01T00:00:00Z'),
      products: [{ productId: product._id, productName: product.name, quantity: 1 }],
      async save() {} };
    return { product, transaction };
  };
  let rows = makeRows();
  t.mock.method(Transaction, 'findOne', () => ({ session: async () => rows.transaction }));
  t.mock.method(Product, 'findOne', () => ({ session: async () => rows.product }));
  delete require.cache[require.resolve('../src/controllers/transactionController')];
  const { updateTransactionStatus } = require('../src/controllers/transactionController');
  const invoke = () => new Promise((resolve) => updateTransactionStatus({
    params: { id: 'transaction-id' }, body: { status: 'cancelled' }, businessId: 'tenant-a', historicalContext: null
  }, { json: resolve }, resolve));

  const failure = await invoke();
  assert.match(failure.message, /synthetic commit failure/);
  assert.equal(notifications.length, 0);

  failCommit = false;
  rows = makeRows();
  await invoke();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows.product.stock, 3);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], 'tenant-a');
  assert.equal(notifications[0][1], rows.product);
  assert.equal(notifications[0][2], 4);
});
