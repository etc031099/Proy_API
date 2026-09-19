const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { Product, Contact, Transaction, CreditPayment } = require('../../src/models');
const {
  createTransaction,
  updateTransactionStatus
} = require('../../src/controllers/transactionController');
const { createCreditPayment } = require('../../src/controllers/creditPaymentController');

const testUri = process.env.MONGODB_TEST_URI;
const businessId = `c03-integration-${Date.now()}-${process.pid}`;
const capabilityCollectionName = `c03_capability_${Date.now()}_${process.pid}`;
const originalFetch = global.fetch;

const requireTestDatabase = () => {
  if (!testUri) {
    throw new Error(
      'MONGODB_TEST_URI is required and must point to a dedicated replica-set test database'
    );
  }
};

const startTransaction = async () => {
  const session = await mongoose.startSession();
  session.startTransaction();
  return session;
};

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

test.before(async () => {
  requireTestDatabase();
  await mongoose.connect(testUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });

  const databaseName = mongoose.connection.name;
  if (!databaseName.endsWith('_test')) {
    await mongoose.disconnect();
    throw new Error(
      `Refusing to run destructive integration cleanup against non-test database: ${databaseName}`
    );
  }

  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0', 'Integration MongoDB must use replica set rs0');
  assert.equal(hello.isWritablePrimary, true, 'Integration MongoDB must have a writable PRIMARY');

  // Do not start transactions while Mongoose is still creating collections or indexes.
  await Promise.all([
    Product.init(),
    Contact.init(),
    Transaction.init(),
    CreditPayment.init()
  ]);
  await mongoose.connection.db.createCollection(capabilityCollectionName);

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ rates: { USD: 1, PEN: 3.7, EUR: 0.92 } })
  });
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

    const collections = await mongoose.connection.db.listCollections(
      { name: capabilityCollectionName },
      { nameOnly: true }
    ).toArray();
    if (collections.length > 0) {
      await mongoose.connection.db.collection(capabilityCollectionName).drop();
    }
  }
  await mongoose.disconnect();
});

test('real replica set commits two writes atomically', async () => {
  const collection = mongoose.connection.db.collection(capabilityCollectionName);
  const session = await startTransaction();

  try {
    await collection.insertOne({ marker: 'commit-first' }, { session });
    await collection.insertOne({ marker: 'commit-second' }, { session });
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }

  assert.equal(
    await collection.countDocuments({ marker: { $in: ['commit-first', 'commit-second'] } }),
    2
  );
});

test('real replica set rolls back every write after a deliberate error', async () => {
  const collection = mongoose.connection.db.collection(capabilityCollectionName);
  const session = await startTransaction();

  try {
    await collection.insertOne({ marker: 'rollback-first' }, { session });
    await collection.insertOne({ marker: 'rollback-second' }, { session });
    throw new Error('deliberate rollback');
  } catch (error) {
    await session.abortTransaction();
    assert.equal(error.message, 'deliberate rollback');
  } finally {
    await session.endSession();
  }

  assert.equal(
    await collection.countDocuments({ marker: { $in: ['rollback-first', 'rollback-second'] } }),
    0
  );
});

test('successful credit sale controller commits transaction, stock and balance', async () => {
  const [product, customer] = await Promise.all([
    Product.create({
      name: 'C03 sale product', price: 10, currency: 'PEN', stock: 10,
      category: 'C03', businessId
    }),
    Contact.create({
      name: 'C03 customer', phone: `sale-${Date.now()}`, type: 'customer',
      businessId, creditLimit: 1000
    })
  ]);

  const response = await invokeController(createTransaction, {
    businessId,
    body: {
      type: 'sale', customerId: customer._id,
      products: [{ productId: product._id, quantity: '2' }],
      paymentMethod: 'credit', currency: 'PEN'
    }
  });

  const [storedProduct, storedCustomer, storedTransaction] = await Promise.all([
    Product.findById(product._id),
    Contact.findById(customer._id),
    Transaction.findById(response.body.data.transaction._id)
  ]);
  assert.equal(response.statusCode, 201);
  assert.equal(storedProduct.stock, 8);
  assert.equal(storedCustomer.currentBalance, 20);
  assert.equal(storedCustomer.balancesByCurrency.PEN, 20);
  assert.equal(storedTransaction.type, 'sale');
});

test('failed credit sale controller rolls back transaction, stock and balance', async () => {
  const [product, customer] = await Promise.all([
    Product.create({
      name: 'C03 rollback product', price: 10, currency: 'PEN', stock: 10,
      category: 'C03', businessId
    }),
    Contact.create({
      name: 'C03 rollback customer', phone: `rollback-${Date.now()}`,
      type: 'customer', businessId, creditLimit: 1000
    })
  ]);
  const originalSave = Contact.prototype.save;
  Contact.prototype.save = async function saveAndFail(...args) {
    const result = await originalSave.apply(this, args);
    if (String(this._id) === String(customer._id)) {
      throw new Error('deliberate failure after transactional writes');
    }
    return result;
  };

  try {
    await assert.rejects(
      invokeController(createTransaction, {
        businessId,
        body: {
          type: 'sale', customerId: customer._id,
          products: [{ productId: product._id, quantity: 3 }],
          paymentMethod: 'credit', currency: 'PEN'
        }
      }),
      /deliberate failure after transactional writes/
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

test('purchase controller commits stock increase and transaction', async () => {
  const vendor = await Contact.create({
    name: 'C03 vendor', phone: `vendor-${Date.now()}`, type: 'vendor', businessId
  });
  const product = await Product.create({
    name: 'C03 purchase product', price: 8, costPrice: 6, currency: 'PEN', stock: 5,
    category: 'C03', businessId,
    supplierPrices: [{ supplierId: vendor._id, purchasePrice: 6 }]
  });

  const response = await invokeController(createTransaction, {
    businessId,
    body: {
      type: 'purchase', vendorId: vendor._id,
      products: [{ productId: product._id, quantity: 4, costPrice: 6 }],
      paymentMethod: 'cash', currency: 'PEN'
    }
  });

  assert.equal(response.statusCode, 201);
  assert.equal((await Product.findById(product._id)).stock, 9);
  assert.equal(
    await Transaction.countDocuments({ businessId, type: 'purchase', vendorId: vendor._id }),
    1
  );
});

test('credit payment controller commits payment and balance decrease', async () => {
  const customer = await Contact.create({
    name: 'C03 payment customer', phone: `payment-${Date.now()}`,
    type: 'customer', businessId, currentBalance: 50,
    balancesByCurrency: { PEN: 50, USD: 0, EUR: 0 }
  });

  const response = await invokeController(createCreditPayment, {
    businessId,
    body: {
      customerId: customer._id, amount: '20', currency: 'PEN', paymentMethod: 'cash'
    }
  });

  assert.equal(response.statusCode, 201);
  assert.equal((await Contact.findById(customer._id)).currentBalance, 30);
  assert.equal(
    await CreditPayment.countDocuments({ businessId, customerId: customer._id }),
    1
  );
});

test('cancellation controller commits status, restored stock and reversed balance', async () => {
  const [product, customer] = await Promise.all([
    Product.create({
      name: 'C03 cancellation product', price: 10, currency: 'PEN', stock: 8,
      category: 'C03', businessId
    }),
    Contact.create({
      name: 'C03 cancellation customer', phone: `cancel-${Date.now()}`,
      type: 'customer', businessId, currentBalance: 20,
      balancesByCurrency: { PEN: 20, USD: 0, EUR: 0 }
    })
  ]);
  const transaction = await Transaction.create({
    type: 'sale', customerId: customer._id, customerName: customer.name,
    products: [{
      productId: product._id, productName: product.name,
      quantity: 2, price: 10, total: 20
    }],
    totalAmount: 20, currency: 'PEN', paymentMethod: 'credit',
    status: 'completed', businessId
  });

  const response = await invokeController(updateTransactionStatus, {
    businessId,
    params: { id: transaction._id },
    body: { status: 'cancelled' }
  });

  const [storedProduct, storedCustomer, storedTransaction] = await Promise.all([
    Product.findById(product._id),
    Contact.findById(customer._id),
    Transaction.findById(transaction._id)
  ]);
  assert.equal(response.statusCode, 200);
  assert.equal(storedProduct.stock, 10);
  assert.equal(storedCustomer.currentBalance, 0);
  assert.equal(storedTransaction.status, 'cancelled');
});
