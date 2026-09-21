const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');

const { Product, Contact, Transaction, CreditPayment, InventoryMovement } = require('../../src/models');
const { createTransaction } = require('../../src/controllers/transactionController');
const { createTransactionValidation } = require('../../src/utils/validations');

const testUri = process.env.MONGODB_TEST_URI;
const runId = `${Date.now()}-${process.pid}`;
const businessId = `h05a-${runId}`;
const originalFetch = global.fetch;
let sequence = 0;

const USD_RATES = { USD: 1, PEN: 3.7, EUR: 0.92 };

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
  name: `H05A product ${++sequence}`,
  price: 100,
  currency: 'PEN',
  stock: 50,
  category: 'H05A',
  businessId,
  ...overrides
});

const createSale = (products, overrides = {}) => invokeController(createTransaction, {
  businessId,
  body: {
    type: 'sale',
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
  if (!testUri) throw new Error('MONGODB_TEST_URI is required for H-05A integration tests');

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
    Product.init(), Contact.init(), Transaction.init(), CreditPayment.init(), InventoryMovement.init()
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
      CreditPayment.deleteMany({ businessId }),
      InventoryMovement.collection.deleteMany({ businessId })
    ]);
  }
  await mongoose.disconnect();
});

for (const manipulatedPrice of [0, 0.01, 999999]) {
  test(`sale ignores client price ${manipulatedPrice} and snapshots Product.price`, async () => {
    const product = await createProduct();
    const response = await createSale([{
      productId: product._id,
      quantity: 1,
      price: manipulatedPrice
    }]);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.data.transaction.products[0].price, 100);
    assert.equal(response.body.data.transaction.totalAmount, 100);
  });
}

test('sale request without price passes validation and uses Product.price', async () => {
  const product = await createProduct({ price: 42.5 });
  const requestBody = {
    type: 'sale',
    products: [{ productId: String(product._id), quantity: '2' }],
    paymentMethod: 'cash',
    currency: 'PEN'
  };
  const validation = await runValidation(requestBody);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.req.body.products[0].quantity, 2);

  const response = await createSale(validation.req.body.products);
  assert.equal(response.body.data.transaction.products[0].price, 42.5);
  assert.equal(response.body.data.transaction.totalAmount, 85);
});

test('two sale products each use their own canonical price', async () => {
  const [first, second] = await Promise.all([
    createProduct({ price: 12 }),
    createProduct({ price: 7.5 })
  ]);
  const response = await createSale([
    { productId: first._id, quantity: 1, price: 999 },
    { productId: second._id, quantity: 1, price: 0 }
  ]);
  const stored = response.body.data.transaction;
  assert.deepEqual(stored.products.map(item => item.price), [12, 7.5]);
  assert.equal(stored.totalAmount, 19.5);
});

test('quantity multiplies the canonical unit price into the line subtotal', async () => {
  const product = await createProduct({ price: 13.25 });
  const response = await createSale([{ productId: product._id, quantity: 4, price: 1 }]);
  const item = response.body.data.transaction.products[0];
  assert.equal(item.price, 13.25);
  assert.equal(item.total, 53);
});

test('transaction total is the sum of server-calculated line totals', async () => {
  const [first, second] = await Promise.all([
    createProduct({ price: 10 }),
    createProduct({ price: 2.5 })
  ]);
  const response = await createSale([
    { productId: first._id, quantity: 3 },
    { productId: second._id, quantity: 4 }
  ]);
  assert.deepEqual(response.body.data.transaction.products.map(item => item.total), [30, 10]);
  assert.equal(response.body.data.transaction.totalAmount, 40);
});

for (const scenario of [
  { source: 'USD', target: 'PEN', expected: 370 },
  { source: 'PEN', target: 'USD', expected: 100 / 3.7 },
  { source: 'EUR', target: 'PEN', expected: 100 * 3.7 / 0.92 }
]) {
  test(`sale converts canonical ${scenario.source} price to ${scenario.target}`, async () => {
    const product = await createProduct({ price: 100, currency: scenario.source });
    const response = await createSale(
      [{ productId: product._id, quantity: 1, price: 0 }],
      { currency: scenario.target }
    );
    const transaction = response.body.data.transaction;
    assert.equal(transaction.currency, scenario.target);
    assertAmount(transaction.products[0].price, scenario.expected);
    assertAmount(transaction.totalAmount, scenario.expected);
  });
}

test('client line subtotals and transaction totals do not affect a sale', async () => {
  const product = await createProduct({ price: 25 });
  const response = await createSale(
    [{ productId: product._id, quantity: 2, price: 0.01, total: 0.02, subtotal: 0.02 }],
    { subtotal: 0.02, total: 0.02, totalAmount: 0.02 }
  );
  const transaction = response.body.data.transaction;
  assert.equal(transaction.products[0].price, 25);
  assert.equal(transaction.products[0].total, 50);
  assert.equal(transaction.totalAmount, 50);
});

test('invalid stored Product.price rejects the sale and rolls back stock', async () => {
  const product = await createProduct({ stock: 10 });
  await Product.collection.updateOne({ _id: product._id }, { $unset: { price: '' } });

  await assert.rejects(
    createSale([{ productId: product._id, quantity: 2, price: 1 }]),
    error => error.statusCode === 400 && error.code === 'INVALID_NUMBER'
  );
  assert.equal((await Product.findById(product._id)).stock, 10);
  assert.equal(await Transaction.countDocuments({ businessId, 'products.productId': product._id }), 0);
});

test('non-finite and negative stored Product.price values are rejected without writes', async () => {
  for (const invalidPrice of [NaN, Infinity, -1]) {
    const product = await createProduct({ stock: 10 });
    await Product.collection.updateOne({ _id: product._id }, { $set: { price: invalidPrice } });

    await assert.rejects(
      createSale([{ productId: product._id, quantity: 2 }]),
      error => error.statusCode === 400 && error.code === 'INVALID_NUMBER'
    );
    assert.equal((await Product.findById(product._id)).stock, 10);
    assert.equal(await Transaction.countDocuments({ businessId, 'products.productId': product._id }), 0);
  }
});

test('invalid stored Product.currency rejects the sale without stock changes', async () => {
  const product = await createProduct({ stock: 10 });
  await Product.collection.updateOne({ _id: product._id }, { $set: { currency: 'BTC' } });

  await assert.rejects(
    createSale([{ productId: product._id, quantity: 2 }]),
    error => error.statusCode === 400 && error.code === 'INVALID_CURRENCY'
  );
  assert.equal((await Product.findById(product._id)).stock, 10);
  assert.equal(await Transaction.countDocuments({ businessId, 'products.productId': product._id }), 0);
});

test('failure after stock, transaction and balance writes rolls the entire sale back', async () => {
  const [product, customer] = await Promise.all([
    createProduct({ price: 20, stock: 10 }),
    Contact.create({
      name: 'H05A rollback customer',
      phone: `h05a-${runId}`,
      type: 'customer',
      businessId,
      creditLimit: 1000
    })
  ]);
  const originalSave = Contact.prototype.save;
  Contact.prototype.save = async function saveAndFail(...args) {
    const result = await originalSave.apply(this, args);
    if (String(this._id) === String(customer._id)) {
      throw new Error('deliberate H-05A failure');
    }
    return result;
  };

  try {
    await assert.rejects(
      createSale(
        [{ productId: product._id, quantity: 2, price: 0 }],
        { customerId: customer._id, paymentMethod: 'credit' }
      ),
      /deliberate H-05A failure/
    );
  } finally {
    Contact.prototype.save = originalSave;
  }

  const [storedProduct, storedCustomer, transactionCount] = await Promise.all([
    Product.findById(product._id),
    Contact.findById(customer._id),
    Transaction.countDocuments({ businessId, customerId: customer._id })
  ]);
  assert.equal(storedProduct.stock, 10);
  assert.equal(storedCustomer.currentBalance, 0);
  assert.equal(storedCustomer.balancesByCurrency.PEN, 0);
  assert.equal(transactionCount, 0);
});

test('purchase accepts legacy cost fields but supplier price remains canonical', async () => {
  const vendor = await Contact.create({
    name: 'H05A purchase vendor',
    phone: `h05a-vendor-${runId}`,
    type: 'vendor',
    businessId
  });
  const product = await createProduct({
    price: 100,
    costPrice: 20,
    stock: 5,
    supplierPrices: [{ supplierId: vendor._id, purchasePrice: 25 }]
  });
  const requestBody = {
    type: 'purchase',
    vendorId: String(vendor._id),
    products: [{
      productId: String(product._id), quantity: '3', price: '777', costPrice: '30'
    }],
    paymentMethod: 'cash',
    currency: 'PEN'
  };
  const validation = await runValidation(requestBody);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.req.body.products[0].price, 777);
  assert.equal(validation.req.body.products[0].costPrice, 30);

  const response = await invokeController(createTransaction, { businessId, body: validation.req.body });
  const transaction = response.body.data.transaction;
  assert.equal(response.statusCode, 201);
  assert.equal(transaction.products[0].price, 25);
  assert.equal(transaction.products[0].costPrice, 25);
  assert.equal(transaction.totalAmount, 75);
  assert.equal((await Product.findById(product._id)).stock, 8);

  const missingPrice = await runValidation({
    ...requestBody,
    products: [{ productId: String(product._id), quantity: 1 }]
  });
  assert.deepEqual(missingPrice.errors, []);
});
