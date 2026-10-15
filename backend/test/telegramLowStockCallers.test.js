const test = require('node:test');
const assert = require('node:assert/strict');
const telegram = require('../src/services/telegramService');
const { Product } = require('../src/models');
const writeService = require('../src/services/transactionWriteService');

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
