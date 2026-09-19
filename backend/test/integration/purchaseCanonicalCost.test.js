const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');

const { Product, Contact, Transaction, CreditPayment } = require('../../src/models');
const { createTransaction } = require('../../src/controllers/transactionController');
const { createTransactionValidation } = require('../../src/utils/validations');

const testUri = process.env.MONGODB_TEST_URI;
const runId = `${Date.now()}-${process.pid}`;
const businessId = `h05b-${runId}`;
const originalFetch = global.fetch;
const USD_RATES = { USD: 1, PEN: 3.7, EUR: 0.92 };
let sequence = 0;
let vendorA;
let vendorB;

const invokeController = (controller, req) => new Promise((resolve, reject) => {
  let statusCode = 200;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      resolve({ statusCode, body });
      return this;
    }
  };
  controller(req, res, reject);
});

const runValidation = async (body) => {
  const req = { body, query: {}, params: {} };
  for (const middleware of createTransactionValidation) {
    await new Promise((resolve, reject) => {
      middleware(req, {}, error => error ? reject(error) : resolve());
    });
  }
  return { req, errors: validationResult(req).array() };
};

const createProduct = (overrides = {}) => Product.create({
  name: `H05B product ${++sequence}`,
  price: 100,
  costPrice: 10,
  currency: 'PEN',
  stock: 5,
  category: 'H05B',
  businessId,
  supplierPrices: [{ supplierId: vendorA._id, purchasePrice: 50 }],
  ...overrides
});

const createPurchase = (products, overrides = {}) => invokeController(createTransaction, {
  businessId,
  body: {
    type: 'purchase',
    vendorId: vendorA._id,
    products,
    paymentMethod: 'cash',
    currency: 'PEN',
    ...overrides
  }
});

const assertAmount = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) < 0.011, `expected ${actual} to be close to ${expected}`);
};

test.before(async () => {
  if (!testUri) throw new Error('MONGODB_TEST_URI is required for H-05B integration tests');
  await mongoose.connect(testUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });
  if (!mongoose.connection.name.endsWith('_test')) {
    const databaseName = mongoose.connection.name;
    await mongoose.disconnect();
    throw new Error(`Refusing to use non-test database: ${databaseName}`);
  }

  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
  await Promise.all([
    Product.init(), Contact.init(), Transaction.init(), CreditPayment.init()
  ]);
  [vendorA, vendorB] = await Contact.create([
    {
      name: 'H05B vendor A', phone: `h05b-a-${runId}`,
      type: 'vendor', businessId
    },
    {
      name: 'H05B vendor B', phone: `h05b-b-${runId}`,
      type: 'vendor', businessId
    }
  ]);

  global.fetch = async (url) => {
    const base = String(url).split('/').pop();
    const rates = Object.fromEntries(
      Object.entries(USD_RATES).map(([currency, rate]) => [currency, rate / USD_RATES[base]])
    );
    return { ok: true, json: async () => ({ rates }) };
  };
});

test.after(async () => {
  global.fetch = originalFetch;
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      Product.deleteMany({ businessId }),
      Contact.deleteMany({ businessId }),
      Transaction.deleteMany({ businessId }),
      CreditPayment.deleteMany({ businessId })
    ]);
  }
  await mongoose.disconnect();
});

test('purchase ignores client costPrice 0 and uses supplier purchasePrice', async () => {
  const product = await createProduct();
  const response = await createPurchase([{
    productId: product._id, quantity: 1, costPrice: 0
  }]);
  const item = response.body.data.transaction.products[0];
  assert.equal(response.statusCode, 201);
  assert.equal(item.price, 50);
  assert.equal(item.costPrice, 50);
  assert.equal(response.body.data.transaction.totalAmount, 50);
});

test('purchase ignores client costPrice 999999', async () => {
  const product = await createProduct();
  const response = await createPurchase([{
    productId: product._id, quantity: 1, costPrice: 999999
  }]);
  assert.equal(response.body.data.transaction.products[0].costPrice, 50);
});

test('purchase ignores client price 0', async () => {
  const product = await createProduct();
  const response = await createPurchase([{
    productId: product._id, quantity: 1, price: 0
  }]);
  assert.equal(response.body.data.transaction.products[0].price, 50);
});

test('purchase without price or costPrice passes validation and uses supplier price', async () => {
  const product = await createProduct({ supplierPrices: [
    { supplierId: vendorA._id, purchasePrice: 32.5 }
  ] });
  const body = {
    type: 'purchase',
    vendorId: String(vendorA._id),
    products: [{ productId: String(product._id), quantity: '2' }],
    paymentMethod: 'cash',
    currency: 'PEN'
  };
  const validation = await runValidation(body);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.req.body.products[0].quantity, 2);

  const response = await invokeController(createTransaction, { businessId, body: validation.req.body });
  assert.equal(response.body.data.transaction.products[0].costPrice, 32.5);
  assert.equal(response.body.data.transaction.totalAmount, 65);
});

test('vendor B uses its own configured price instead of vendor A price', async () => {
  const product = await createProduct({ supplierPrices: [
    { supplierId: vendorA._id, purchasePrice: 50 },
    { supplierId: vendorB._id, purchasePrice: 80 }
  ] });
  const response = await createPurchase(
    [{ productId: product._id, quantity: 1 }],
    { vendorId: vendorB._id }
  );
  assert.equal(response.body.data.transaction.products[0].costPrice, 80);
  assert.equal(response.body.data.transaction.totalAmount, 80);
});

test('preferred supplier A never overrides selected vendor B', async () => {
  const product = await createProduct({
    preferredSupplierId: vendorA._id,
    supplierPrices: [
      { supplierId: vendorA._id, purchasePrice: 50 },
      { supplierId: vendorB._id, purchasePrice: 80 }
    ]
  });
  const response = await createPurchase(
    [{ productId: product._id, quantity: 1, costPrice: 1 }],
    { vendorId: vendorB._id }
  );
  assert.equal(response.body.data.transaction.products[0].costPrice, 80);
});

test('selected vendor without supplier price is rejected without writes', async () => {
  const product = await createProduct({ stock: 5 });
  await assert.rejects(
    createPurchase([{ productId: product._id, quantity: 2 }], { vendorId: vendorB._id }),
    error => error.statusCode === 400 && /not configured/.test(error.message)
  );
  assert.equal((await Product.findById(product._id)).stock, 5);
  assert.equal(await Transaction.countDocuments({ businessId, 'products.productId': product._id }), 0);
});

test('invalid supplier purchasePrice values reject and roll back safely', async () => {
  const mutations = [
    { $unset: { 'supplierPrices.0.purchasePrice': '' } },
    { $set: { 'supplierPrices.0.purchasePrice': null } },
    { $set: { 'supplierPrices.0.purchasePrice': NaN } },
    { $set: { 'supplierPrices.0.purchasePrice': Infinity } },
    { $set: { 'supplierPrices.0.purchasePrice': -1 } },
    { $set: { 'supplierPrices.0.purchasePrice': 'invalid' } }
  ];

  for (const mutation of mutations) {
    const product = await createProduct({ stock: 5 });
    await Product.collection.updateOne({ _id: product._id }, mutation);
    await assert.rejects(
      createPurchase([{ productId: product._id, quantity: 2 }]),
      error => error.statusCode === 400 && error.code === 'INVALID_NUMBER'
    );
    assert.equal((await Product.findById(product._id)).stock, 5);
    assert.equal(await Transaction.countDocuments({ businessId, 'products.productId': product._id }), 0);
  }
});

test('two products use their distinct supplier prices and calculate the total', async () => {
  const [first, second] = await Promise.all([
    createProduct({ supplierPrices: [{ supplierId: vendorA._id, purchasePrice: 20 }] }),
    createProduct({ supplierPrices: [{ supplierId: vendorA._id, purchasePrice: 7.5 }] })
  ]);
  const response = await createPurchase([
    { productId: first._id, quantity: 2 },
    { productId: second._id, quantity: 4 }
  ]);
  const transaction = response.body.data.transaction;
  assert.deepEqual(transaction.products.map(item => item.costPrice), [20, 7.5]);
  assert.deepEqual(transaction.products.map(item => item.total), [40, 30]);
  assert.equal(transaction.totalAmount, 70);
});

test('quantity multiplies the canonical supplier cost', async () => {
  const product = await createProduct({ supplierPrices: [
    { supplierId: vendorA._id, purchasePrice: 12.25 }
  ] });
  const response = await createPurchase([{ productId: product._id, quantity: 4 }]);
  const item = response.body.data.transaction.products[0];
  assert.equal(item.costPrice, 12.25);
  assert.equal(item.total, 49);
});

test('client line and transaction totals cannot alter a purchase', async () => {
  const product = await createProduct({ supplierPrices: [
    { supplierId: vendorA._id, purchasePrice: 25 }
  ] });
  const response = await createPurchase(
    [{ productId: product._id, quantity: 2, price: 1, costPrice: 1, total: 2, subtotal: 2 }],
    { subtotal: 2, total: 2, totalAmount: 2 }
  );
  const transaction = response.body.data.transaction;
  assert.equal(transaction.products[0].price, 25);
  assert.equal(transaction.products[0].costPrice, 25);
  assert.equal(transaction.products[0].total, 50);
  assert.equal(transaction.totalAmount, 50);
});

test('purchase converts supplier price from Product.currency server-side', async () => {
  const product = await createProduct({
    currency: 'USD',
    supplierPrices: [{ supplierId: vendorA._id, purchasePrice: 10 }]
  });
  const response = await createPurchase(
    [{ productId: product._id, quantity: 2 }],
    { currency: 'PEN' }
  );
  const transaction = response.body.data.transaction;
  assert.equal(transaction.currency, 'PEN');
  assertAmount(transaction.products[0].costPrice, 37);
  assertAmount(transaction.products[0].price, 37);
  assertAmount(transaction.totalAmount, 74);
});

test('invalid purchase Product.currency rejects without stock changes', async () => {
  const product = await createProduct({ stock: 5 });
  await Product.collection.updateOne({ _id: product._id }, { $set: { currency: 'BTC' } });
  await assert.rejects(
    createPurchase([{ productId: product._id, quantity: 2 }]),
    error => error.statusCode === 400 && error.code === 'INVALID_CURRENCY'
  );
  assert.equal((await Product.findById(product._id)).stock, 5);
  assert.equal(await Transaction.countDocuments({ businessId, 'products.productId': product._id }), 0);
});

test('failure on the second product rolls back the first stock update', async () => {
  const [first, second] = await Promise.all([
    createProduct({ stock: 5 }),
    createProduct({ stock: 8, supplierPrices: [
      { supplierId: vendorB._id, purchasePrice: 90 }
    ] })
  ]);
  await assert.rejects(
    createPurchase([
      { productId: first._id, quantity: 3 },
      { productId: second._id, quantity: 2 }
    ]),
    error => error.statusCode === 400 && /not configured/.test(error.message)
  );

  assert.equal((await Product.findById(first._id)).stock, 5);
  assert.equal((await Product.findById(second._id)).stock, 8);
  assert.equal(await Transaction.countDocuments({
    businessId,
    'products.productId': { $in: [first._id, second._id] }
  }), 0);
});

test('canonical sale pricing remains unchanged by purchase cost rules', async () => {
  const product = await createProduct({
    price: 100,
    stock: 5,
    supplierPrices: [{ supplierId: vendorA._id, purchasePrice: 50 }]
  });
  const response = await invokeController(createTransaction, {
    businessId,
    body: {
      type: 'sale',
      products: [{ productId: product._id, quantity: 2, price: 0, costPrice: 0 }],
      paymentMethod: 'cash',
      currency: 'PEN'
    }
  });
  const transaction = response.body.data.transaction;
  assert.equal(response.statusCode, 201);
  assert.equal(transaction.products[0].price, 100);
  assert.equal(transaction.products[0].costPrice, undefined);
  assert.equal(transaction.totalAmount, 200);
  assert.equal((await Product.findById(product._id)).stock, 3);
});
