const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { Product, Contact, Transaction, CreditPayment, InventoryMovement } = require('../../src/models');
const {
  updateTransactionStatus,
  getTransactionSummary
} = require('../../src/controllers/transactionController');
const {
  getTransactionReport,
  getCustomerReport,
  getVendorReport,
  getDashboardSummary
} = require('../../src/controllers/reportController');

const testUri = process.env.MONGODB_TEST_URI;
const runId = `${Date.now()}-${process.pid}`;
const businessId = `h01-${runId}`;
const reportBusinessId = `h02-${runId}`;
const originalFetch = global.fetch;
let sequence = 0;

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

const expectBusinessError = async (promise, messagePattern) => {
  await assert.rejects(
    promise,
    error => error.statusCode === 409 && messagePattern.test(error.message)
  );
};

const createProduct = (overrides = {}) => Product.create({
  name: `H01 product ${++sequence}`,
  price: 10,
  currency: 'PEN',
  stock: 8,
  category: 'H01',
  businessId,
  ...overrides
});

const createContact = (type = 'customer', overrides = {}) => Contact.create({
  name: `H01 ${type} ${++sequence}`,
  phone: `h01-${runId}-${sequence}`,
  type,
  businessId,
  ...overrides
});

const createTransaction = ({ product, type = 'sale', status = 'completed', quantity = 2,
  paymentMethod = 'cash', customer, vendor, currency = 'PEN', totalAmount = 20,
  business = businessId, date = new Date(), ...overrides }) => Transaction.create({
  type,
  status,
  products: [{
    productId: product._id,
    productName: product.name,
    quantity,
    price: totalAmount / quantity,
    costPrice: type === 'purchase' ? totalAmount / quantity : undefined,
    total: totalAmount
  }],
  totalAmount,
  originalAmount: currency === 'USD' ? totalAmount : totalAmount / 3.7,
  exchangeRate: currency === 'USD' ? 1 : 3.7,
  currency,
  paymentMethod,
  customerId: customer?._id,
  customerName: type === 'sale' ? (customer?.name || 'Final customer') : undefined,
  vendorId: vendor?._id,
  supplierId: vendor?._id,
  vendorName: type === 'purchase' ? vendor.name : undefined,
  businessId: business,
  date,
  ...overrides
});

const changeStatus = (transaction, status, business = businessId) => invokeController(
  updateTransactionStatus,
  { businessId: business, params: { id: transaction._id }, body: { status } }
);

test.before(async () => {
  if (!testUri) {
    throw new Error('MONGODB_TEST_URI is required for H-01/H-02 integration tests');
  }
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
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ rates: { USD: 1, PEN: 3.7, EUR: 0.92 } })
  });
});

test.after(async () => {
  global.fetch = originalFetch;
  if (mongoose.connection.readyState === 1) {
    const businesses = { $in: [businessId, reportBusinessId] };
    await Promise.all([
      Product.deleteMany({ businessId: businesses }),
      Contact.deleteMany({ businessId: businesses }),
      Transaction.deleteMany({ businessId: businesses }),
      CreditPayment.deleteMany({ businessId: businesses }),
      InventoryMovement.collection.deleteMany({ businessId: businesses })
    ]);
  }
  await mongoose.disconnect();
});

test('completed sale cancellation restores stock and marks it cancelled', async () => {
  const product = await createProduct({ stock: 8 });
  const transaction = await createTransaction({ product });
  const response = await changeStatus(transaction, 'cancelled');
  assert.equal(response.statusCode, 200);
  assert.equal((await Product.findById(product._id)).stock, 10);
  assert.equal((await Transaction.findById(transaction._id)).status, 'cancelled');
});

test('credit sale cancellation restores stock and reverses PEN balance', async () => {
  const [product, customer] = await Promise.all([
    createProduct({ stock: 8 }),
    createContact('customer', {
      currentBalance: 20,
      balancesByCurrency: { PEN: 20, USD: 0, EUR: 0 }
    })
  ]);
  const transaction = await createTransaction({ product, customer, paymentMethod: 'credit' });
  await changeStatus(transaction, 'cancelled');
  const storedCustomer = await Contact.findById(customer._id);
  assert.equal((await Product.findById(product._id)).stock, 10);
  assert.equal(storedCustomer.currentBalance, 0);
  assert.equal(storedCustomer.balancesByCurrency.PEN, 0);
});

test('cash sale cancellation does not modify customer balance', async () => {
  const [product, customer] = await Promise.all([
    createProduct({ stock: 8 }),
    createContact('customer', {
      currentBalance: 40,
      balancesByCurrency: { PEN: 40, USD: 0, EUR: 0 }
    })
  ]);
  const transaction = await createTransaction({ product, customer, paymentMethod: 'cash' });
  await changeStatus(transaction, 'cancelled');
  const storedCustomer = await Contact.findById(customer._id);
  assert.equal(storedCustomer.currentBalance, 40);
  assert.equal(storedCustomer.balancesByCurrency.PEN, 40);
});

test('purchase cancellation removes purchased stock exactly once', async () => {
  const [product, vendor] = await Promise.all([
    createProduct({ stock: 9 }),
    createContact('vendor')
  ]);
  const transaction = await createTransaction({
    product, vendor, type: 'purchase', quantity: 4, totalAmount: 24
  });
  await changeStatus(transaction, 'cancelled');
  assert.equal((await Product.findById(product._id)).stock, 5);
  assert.equal((await Transaction.findById(transaction._id)).status, 'cancelled');
});

test('purchase cancellation without enough stock rolls back and remains completed', async () => {
  const [product, vendor] = await Promise.all([
    createProduct({ stock: 2 }),
    createContact('vendor')
  ]);
  const transaction = await createTransaction({
    product, vendor, type: 'purchase', quantity: 4, totalAmount: 24
  });
  await expectBusinessError(changeStatus(transaction, 'cancelled'), /enough stock/);
  assert.equal((await Product.findById(product._id)).stock, 2);
  assert.equal((await Transaction.findById(transaction._id)).status, 'completed');
});

for (const [current, target] of [
  ['cancelled', 'completed'],
  ['completed', 'pending'],
  ['cancelled', 'pending'],
  ['pending', 'completed'],
  ['pending', 'cancelled']
]) {
  test(`${current} -> ${target} is rejected without stock changes`, async () => {
    const product = await createProduct({ stock: current === 'cancelled' ? 10 : 8 });
    const transaction = await createTransaction({ product, status: current });
    await expectBusinessError(changeStatus(transaction, target), /cannot transition/);
    assert.equal((await Product.findById(product._id)).stock, current === 'cancelled' ? 10 : 8);
    assert.equal((await Transaction.findById(transaction._id)).status, current);
  });
}

test('cancelled -> cancelled is an idempotent no-op', async () => {
  const product = await createProduct({ stock: 10 });
  const transaction = await createTransaction({ product, status: 'cancelled' });
  const response = await changeStatus(transaction, 'cancelled');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.match(response.body.message, /no changes/);
  assert.equal((await Product.findById(product._id)).stock, 10);
});

test('completed -> completed is an idempotent no-op', async () => {
  const product = await createProduct({ stock: 8 });
  const transaction = await createTransaction({ product });
  const response = await changeStatus(transaction, 'completed');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal((await Product.findById(product._id)).stock, 8);
});

test('pending -> pending is an idempotent no-op', async () => {
  const product = await createProduct({ stock: 8 });
  const transaction = await createTransaction({ product, status: 'pending' });
  const response = await changeStatus(transaction, 'pending');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal((await Product.findById(product._id)).stock, 8);
});

test('failure during cancellation rolls back every stock and status change', async () => {
  const [firstProduct, secondProduct] = await Promise.all([
    createProduct({ stock: 8 }), createProduct({ stock: 8 })
  ]);
  const transaction = await Transaction.create({
    type: 'sale', status: 'completed', paymentMethod: 'cash', businessId,
    customerName: 'Final customer', totalAmount: 20,
    products: [firstProduct, secondProduct].map(product => ({
      productId: product._id, productName: product.name,
      quantity: 1, price: 10, total: 10
    }))
  });
  const originalSave = Product.prototype.save;
  Product.prototype.save = async function saveAndFail(...args) {
    const result = await originalSave.apply(this, args);
    if (String(this._id) === String(secondProduct._id)) {
      throw new Error('deliberate cancellation failure');
    }
    return result;
  };
  try {
    await assert.rejects(changeStatus(transaction, 'cancelled'), /deliberate cancellation failure/);
  } finally {
    Product.prototype.save = originalSave;
  }
  assert.equal((await Product.findById(firstProduct._id)).stock, 8);
  assert.equal((await Product.findById(secondProduct._id)).stock, 8);
  assert.equal((await Transaction.findById(transaction._id)).status, 'completed');
});

test('credit cancellation reverses the correct USD and EUR balances', async () => {
  for (const currency of ['USD', 'EUR']) {
    const [product, customer] = await Promise.all([
      createProduct({ stock: 8, currency }),
      createContact('customer', {
        currentBalance: 7,
        balancesByCurrency: {
          PEN: 7,
          USD: currency === 'USD' ? 20 : 0,
          EUR: currency === 'EUR' ? 20 : 0
        }
      })
    ]);
    const transaction = await createTransaction({
      product, customer, paymentMethod: 'credit', currency, totalAmount: 20
    });
    await changeStatus(transaction, 'cancelled');
    const stored = await Contact.findById(customer._id);
    assert.equal(stored.balancesByCurrency[currency], 0);
    assert.equal(stored.currentBalance, 7);
  }
});

test('missing credit customer rejects cancellation without partial changes', async () => {
  const product = await createProduct({ stock: 8 });
  const missingCustomerId = new mongoose.Types.ObjectId();
  const transaction = await createTransaction({
    product,
    paymentMethod: 'credit',
    customer: { _id: missingCustomerId, name: 'Missing customer' }
  });
  await expectBusinessError(changeStatus(transaction, 'cancelled'), /customer no longer exists/);
  assert.equal((await Product.findById(product._id)).stock, 8);
  assert.equal((await Transaction.findById(transaction._id)).status, 'completed');
});

test('credit sale with subsequent payment is rejected without altering the payment', async () => {
  const saleDate = new Date(Date.now() - 60000);
  const [product, customer] = await Promise.all([
    createProduct({ stock: 8 }),
    createContact('customer', {
      currentBalance: 15,
      balancesByCurrency: { PEN: 15, USD: 0, EUR: 0 }
    })
  ]);
  const transaction = await createTransaction({
    product, customer, paymentMethod: 'credit', date: saleDate
  });
  const payment = await CreditPayment.create({
    customerId: customer._id, businessId, amount: 5,
    currency: 'PEN', paymentMethod: 'cash', date: new Date()
  });
  await expectBusinessError(changeStatus(transaction, 'cancelled'), /subsequent payments/);
  assert.equal((await Product.findById(product._id)).stock, 8);
  assert.equal((await Contact.findById(customer._id)).currentBalance, 15);
  assert.equal((await Transaction.findById(transaction._id)).status, 'completed');
  assert.equal((await CreditPayment.findById(payment._id)).amount, 5);
});

test('summary and financial reports include only completed transactions', async () => {
  const [product, customer, vendor] = await Promise.all([
    Product.create({
      name: `H02 product ${runId}`, price: 10, currency: 'USD', stock: 10,
      category: 'H02', businessId: reportBusinessId
    }),
    Contact.create({
      name: `H02 customer ${runId}`, phone: `h02-c-${runId}`,
      type: 'customer', businessId: reportBusinessId
    }),
    Contact.create({
      name: `H02 vendor ${runId}`, phone: `h02-v-${runId}`,
      type: 'vendor', businessId: reportBusinessId
    })
  ]);
  const records = [
    ['sale', 'completed', 100], ['sale', 'pending', 200], ['sale', 'cancelled', 300],
    ['purchase', 'completed', 40], ['purchase', 'pending', 50], ['purchase', 'cancelled', 60]
  ];
  for (const [type, status, amount] of records) {
    await createTransaction({
      product, customer, vendor, type, status, totalAmount: amount,
      currency: 'USD', business: reportBusinessId
    });
  }

  const request = { businessId: reportBusinessId, query: {} };
  const summary = await invokeController(getTransactionSummary, request);
  assert.equal(summary.body.data.summary.sales.totalAmount, 370);
  assert.equal(summary.body.data.summary.sales.transactionCount, 1);
  assert.equal(summary.body.data.summary.sales.averageAmount, 370);
  assert.equal(summary.body.data.summary.purchases.totalAmount, 148);
  assert.equal(summary.body.data.summary.purchases.transactionCount, 1);
  assert.equal(summary.body.data.summary.purchases.averageAmount, 148);
  assert.equal(summary.body.data.summary.profitLoss, 222);

  const transactionReport = await invokeController(getTransactionReport, request);
  assert.equal(transactionReport.body.data.transactions.length, 2);
  assert.equal(transactionReport.body.data.summary.totalTransactions, 2);
  assert.equal(transactionReport.body.data.summary.totalSales, 370);
  assert.equal(transactionReport.body.data.summary.totalPurchases, 148);

  const customerReport = await invokeController(getCustomerReport, {
    businessId: reportBusinessId, params: { id: customer._id }, query: {}
  });
  assert.equal(customerReport.body.data.transactions.length, 1);
  assert.equal(customerReport.body.data.topProducts[0].totalQuantity, 2);

  const vendorReport = await invokeController(getVendorReport, {
    businessId: reportBusinessId, params: { id: vendor._id }, query: {}
  });
  assert.equal(vendorReport.body.data.transactions.length, 1);
  assert.equal(vendorReport.body.data.topProducts[0].totalQuantity, 2);

  const dashboard = await invokeController(getDashboardSummary, {
    businessId: reportBusinessId, query: {}
  });
  assert.equal(dashboard.body.data.monthly.transactionCount, 2);
  assert.equal(dashboard.body.data.yearly.transactionCount, 2);
  assert.equal(dashboard.body.data.recentTransactions.length, 2);
  assert.ok(dashboard.body.data.recentTransactions.every(item => item.status === 'completed'));
});
