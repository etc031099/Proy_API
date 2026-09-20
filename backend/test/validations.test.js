const test = require('node:test');
const assert = require('node:assert/strict');
const { validationResult } = require('express-validator');

const {
  createProductValidation,
  updateProductValidation,
  createContactValidation,
  updateContactValidation,
  updateStockValidation,
  updateBalanceValidation,
  createTransactionValidation,
  createCreditPaymentValidation,
  paginationValidation,
  productQueryValidation,
  paymentMethodQueryValidation,
  MAX_PAGE,
  MAX_PAGE_SIZE
} = require('../src/utils/validations');

const objectId = '507f1f77bcf86cd799439011';

const runValidation = async (middlewares, { body = {}, query = {} } = {}) => {
  const req = { body, query, params: {} };

  for (const middleware of middlewares) {
    await new Promise((resolve, reject) => {
      middleware(req, {}, (error) => error ? reject(error) : resolve());
    });
  }

  return { req, errors: validationResult(req).array() };
};

const errorFor = (result, path) => result.errors.find(error => error.path === path);

test('product validation converts all numeric strings, including supplier prices', async () => {
  const result = await runValidation(createProductValidation, {
    body: {
      name: 'Product',
      price: '12.50',
      costPrice: '8.25',
      stock: '5',
      minStockLevel: '2',
      category: 'Category',
      supplierPrices: [{ supplierId: objectId, purchasePrice: '7.75' }]
    }
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.req.body.price, 12.5);
  assert.equal(result.req.body.costPrice, 8.25);
  assert.equal(result.req.body.stock, 5);
  assert.equal(result.req.body.minStockLevel, 2);
  assert.equal(result.req.body.supplierPrices[0].purchasePrice, 7.75);
});

test('product validation normalizes blank optional SKUs and preserves real SKUs', async () => {
  const base = { name: 'Product', price: 1, stock: 0, category: 'Category' };
  const empty = await runValidation(createProductValidation, {
    body: { ...base, sku: '' }
  });
  const whitespace = await runValidation(createProductValidation, {
    body: { ...base, sku: '   ' }
  });
  const real = await runValidation(updateProductValidation, {
    body: { sku: '  ABC-01  ' }
  });
  const invalid = await runValidation(updateProductValidation, {
    body: { sku: 123 }
  });

  assert.deepEqual(empty.errors, []);
  assert.deepEqual(whitespace.errors, []);
  assert.equal(empty.req.body.sku, null);
  assert.equal(whitespace.req.body.sku, null);
  assert.deepEqual(real.errors, []);
  assert.equal(real.req.body.sku, 'ABC-01');
  assert.equal(errorFor(invalid, 'sku').msg, 'SKU must be a string');
});

test('stock and balance adjustments are numbers before addition', async () => {
  const stock = await runValidation(updateStockValidation, {
    body: { quantity: '2', operation: 'add' }
  });
  const balance = await runValidation(updateBalanceValidation, {
    body: { amount: '2.50', operation: 'add' }
  });

  assert.deepEqual(stock.errors, []);
  assert.deepEqual(balance.errors, []);
  assert.equal(stock.req.body.quantity, 2);
  assert.equal(balance.req.body.amount, 2.5);
  assert.equal(5 + stock.req.body.quantity, 7);
  assert.equal(5 + balance.req.body.amount, 7.5);
});

test('transaction validation converts quantity, price and cost price', async () => {
  const result = await runValidation(createTransactionValidation, {
    body: {
      type: 'purchase',
      vendorId: objectId,
      products: [{ productId: objectId, quantity: '3', price: '4.50', costPrice: '4.25' }],
      paymentMethod: 'cash',
      currency: 'pen'
    }
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.req.body.products[0].quantity, 3);
  assert.equal(result.req.body.products[0].price, 4.5);
  assert.equal(result.req.body.products[0].costPrice, 4.25);
  assert.equal(result.req.body.currency, 'PEN');
});

test('credit payments and numeric query parameters are converted', async () => {
  const payment = await runValidation(createCreditPaymentValidation, {
    body: {
      customerId: objectId,
      amount: '25.75',
      currency: 'usd',
      paymentMethod: 'cash'
    }
  });
  const productQuery = await runValidation(productQueryValidation, {
    query: { page: '2', limit: '20', minStock: '1', maxStock: '10' }
  });
  const externalQuery = await runValidation(paymentMethodQueryValidation, {
    query: { amount: '10.25' }
  });

  assert.deepEqual(payment.errors, []);
  assert.equal(payment.req.body.amount, 25.75);
  assert.equal(payment.req.body.currency, 'USD');
  assert.deepEqual(productQuery.errors, []);
  assert.deepEqual(productQuery.req.query, { page: 2, limit: 20, minStock: 1, maxStock: 10 });
  assert.deepEqual(externalQuery.errors, []);
  assert.equal(externalQuery.req.query.amount, 10.25);
});

test('numeric validators reject arrays before sanitization', async () => {
  const cases = [
    [updateStockValidation, { body: { quantity: [], operation: 'add' } }, 'quantity'],
    [updateBalanceValidation, { body: { amount: [5], operation: 'add' } }, 'amount'],
    [createProductValidation, {
      body: { name: 'Product', price: [5, 6], stock: 1, category: 'Category' }
    }, 'price'],
    [createCreditPaymentValidation, {
      body: { customerId: objectId, amount: [], paymentMethod: 'cash' }
    }, 'amount'],
    [paymentMethodQueryValidation, { query: { amount: [5] } }, 'amount']
  ];

  for (const [middlewares, request, path] of cases) {
    const result = await runValidation(middlewares, request);
    const error = errorFor(result, path);
    assert.ok(error, `Expected a validation error for ${path}`);
    assert.equal(error.type, 'field');
  }
});

test('nullable contact numbers preserve null without coercion', async () => {
  const result = await runValidation(updateContactValidation, {
    body: { latitude: null, longitude: null, creditLimit: null }
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.req.body.latitude, null);
  assert.equal(result.req.body.longitude, null);
  assert.equal(result.req.body.creditLimit, null);
});

test('optional contact numbers allow omitted fields in partial updates', async () => {
  const contact = await runValidation(updateContactValidation, { body: { notes: 'Only notes' } });
  const product = await runValidation(updateProductValidation, { body: { description: 'Only description' } });

  assert.deepEqual(contact.errors, []);
  assert.deepEqual(product.errors, []);
  assert.equal(Object.hasOwn(contact.req.body, 'latitude'), false);
  assert.equal(Object.hasOwn(contact.req.body, 'creditLimit'), false);
  assert.equal(Object.hasOwn(product.req.body, 'price'), false);
});

test('blank optional contact numbers are rejected with the correct fields', async () => {
  const result = await runValidation(updateContactValidation, {
    body: { latitude: '', longitude: '', creditLimit: '' }
  });

  assert.deepEqual(
    result.errors.map(error => error.path).sort(),
    ['creditLimit', 'latitude', 'longitude']
  );
  for (const error of result.errors) assert.equal(error.type, 'field');
});

test('zero coordinates and credit limit remain valid', async () => {
  const result = await runValidation(createContactValidation, {
    body: {
      name: 'Customer', phone: '999999999', type: 'customer',
      latitude: 0, longitude: 0, creditLimit: 0
    }
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.req.body.latitude, 0);
  assert.equal(result.req.body.longitude, 0);
  assert.equal(result.req.body.creditLimit, 0);
});

test('pagination accepts page 1, normal values and the configured maximum', async () => {
  const first = await runValidation(paginationValidation, { query: { page: '1', limit: '1' } });
  const normal = await runValidation(paginationValidation, { query: { page: '25', limit: '50' } });
  const maximum = await runValidation(paginationValidation, {
    query: { page: String(MAX_PAGE), limit: String(MAX_PAGE_SIZE) }
  });

  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.req.query, { page: 1, limit: 1 });
  assert.deepEqual(normal.errors, []);
  assert.deepEqual(normal.req.query, { page: 25, limit: 50 });
  assert.deepEqual(maximum.errors, []);
  assert.equal(maximum.req.query.page, MAX_PAGE);
  assert.equal(maximum.req.query.limit, MAX_PAGE_SIZE);
  assert.equal(Number.isSafeInteger((MAX_PAGE - 1) * MAX_PAGE_SIZE), true);
});

test('pagination rejects values above the maximum and previously unsafe pages', async () => {
  const aboveMaximum = await runValidation(paginationValidation, {
    query: { page: String(MAX_PAGE + 1), limit: String(MAX_PAGE_SIZE + 1) }
  });
  const unsafe = await runValidation(paginationValidation, {
    query: { page: String(Number.MAX_SAFE_INTEGER), limit: '100' }
  });

  assert.ok(errorFor(aboveMaximum, 'page'));
  assert.ok(errorFor(aboveMaximum, 'limit'));
  assert.equal(errorFor(aboveMaximum, 'page').type, 'field');
  assert.ok(errorFor(unsafe, 'page'));
});

test('numeric validation reports the exact invalid fields', async () => {
  const fractionalStock = await runValidation(updateStockValidation, {
    body: { quantity: '1.5', operation: 'add' }
  });
  const infiniteBalance = await runValidation(updateBalanceValidation, {
    body: { amount: 'Infinity', operation: 'add' }
  });
  const invertedRange = await runValidation(productQueryValidation, {
    query: { minStock: '10', maxStock: '1' }
  });

  assert.equal(errorFor(fractionalStock, 'quantity').type, 'field');
  assert.equal(errorFor(fractionalStock, 'quantity').value, '1.5');
  assert.equal(errorFor(infiniteBalance, 'amount').type, 'field');
  assert.equal(errorFor(infiniteBalance, 'amount').value, 'Infinity');
  assert.equal(errorFor(invertedRange, 'maxStock').type, 'field');
  assert.match(errorFor(invertedRange, 'maxStock').msg, /greater than or equal/);
});
