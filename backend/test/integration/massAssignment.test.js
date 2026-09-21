const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { Product, Contact, Transaction, CreditPayment, InventoryMovement } = require('../../src/models');
const {
  createProduct,
  updateProduct,
  updateProductStock
} = require('../../src/controllers/productController');
const {
  createContact,
  updateContact,
  updateContactBalance
} = require('../../src/controllers/contactController');

const testUri = process.env.MONGODB_TEST_URI;
const runId = `${Date.now()}-${process.pid}`;
const businessA = `h03-a-${runId}`;
const businessB = `h03-b-${runId}`;
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

const expectRejectedField = (promise, field) => assert.rejects(
  promise,
  error => error.statusCode === 400
    && error.code === 'FIELD_NOT_ALLOWED'
    && error.field === field
);

const createStoredProduct = (businessId = businessA, overrides = {}) => Product.create({
  name: `H03 product ${++sequence}`,
  price: 10,
  currency: 'PEN',
  stock: 5,
  category: 'H03',
  businessId,
  ...overrides
});

const createStoredContact = (businessId = businessA, overrides = {}) => Contact.create({
  name: `H03 contact ${++sequence}`,
  phone: `h03-${runId}-${sequence}`,
  type: 'customer',
  businessId,
  ...overrides
});

const updateProductRequest = (product, body, businessId = businessA) => invokeController(
  updateProduct,
  { businessId, params: { id: product._id }, body }
);

const updateContactRequest = (contact, body, businessId = businessA) => invokeController(
  updateContact,
  { businessId, params: { id: contact._id }, body }
);

test.before(async () => {
  if (!testUri) throw new Error('MONGODB_TEST_URI is required for H-03 integration tests');
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
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    const businesses = { $in: [businessA, businessB] };
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

test('product create rejects a client-supplied businessId', async () => {
  await expectRejectedField(
    invokeController(createProduct, {
      businessId: businessA,
      body: {
        name: 'Malicious product', price: 10, stock: 1, category: 'H03',
        businessId: businessB
      }
    }),
    'businessId'
  );
  assert.equal(await Product.countDocuments({ name: 'Malicious product' }), 0);
});

for (const [field, value] of [
  ['businessId', businessB],
  ['stock', 999],
  ['isActive', false],
  ['_id', new mongoose.Types.ObjectId()],
  ['unknownField', 'unexpected']
]) {
  test(`product update rejects ${field} and leaves the document intact`, async () => {
    const product = await createStoredProduct();
    await expectRejectedField(updateProductRequest(product, { [field]: value }), field);
    const stored = await Product.findById(product._id);
    assert.equal(stored.businessId, businessA);
    assert.equal(stored.stock, 5);
    assert.equal(stored.isActive, true);
  });
}

test('product update rejects MongoDB operators', async () => {
  const product = await createStoredProduct();
  await expectRejectedField(
    updateProductRequest(product, { $set: { price: 1 } }),
    '$set'
  );
  assert.equal((await Product.findById(product._id)).price, 10);
});

test('valid product update persists only allowed fields', async () => {
  const product = await createStoredProduct();
  const response = await updateProductRequest(product, {
    name: 'Allowed product update',
    description: 'Allowed description',
    price: 22,
    category: 'Allowed category'
  });
  const stored = await Product.findById(product._id);
  assert.equal(response.statusCode, 200);
  assert.equal(stored.name, 'Allowed product update');
  assert.equal(stored.description, 'Allowed description');
  assert.equal(stored.price, 22);
  assert.equal(stored.stock, 5);
  assert.equal(stored.businessId, businessA);
});

test('specialized product stock endpoint still updates stock', async () => {
  const product = await createStoredProduct();
  const response = await invokeController(updateProductStock, {
    businessId: businessA,
    params: { id: product._id },
    body: { quantity: 9, operation: 'set' }
  });
  assert.equal(response.statusCode, 200);
  assert.equal((await Product.findById(product._id)).stock, 9);
});

for (const field of ['currentBalance', 'balancesByCurrency']) {
  test(`contact create rejects ${field}`, async () => {
    const body = {
      name: `Rejected contact ${field}`,
      phone: `h03-rejected-${field}-${runId}`,
      type: 'customer',
      [field]: field === 'currentBalance' ? 500 : { PEN: 500, USD: 0, EUR: 0 }
    };
    await expectRejectedField(
      invokeController(createContact, { businessId: businessA, body }),
      field
    );
    assert.equal(await Contact.countDocuments({ phone: body.phone }), 0);
  });
}

for (const [field, value] of [
  ['businessId', businessB],
  ['currentBalance', 500],
  ['balancesByCurrency', { PEN: 500, USD: 0, EUR: 0 }],
  ['isActive', false],
  ['type', 'vendor']
]) {
  test(`contact update rejects ${field} and preserves sensitive state`, async () => {
    const contact = await createStoredContact();
    await expectRejectedField(updateContactRequest(contact, { [field]: value }), field);
    const stored = await Contact.findById(contact._id);
    assert.equal(stored.businessId, businessA);
    assert.equal(stored.type, 'customer');
    assert.equal(stored.currentBalance, 0);
    assert.equal(stored.balancesByCurrency.PEN, 0);
    assert.equal(stored.isActive, true);
  });
}

test('contact update rejects MongoDB operators, including nested operators', async () => {
  const contact = await createStoredContact();
  await expectRejectedField(
    updateContactRequest(contact, { address: { $set: { city: 'Injected' } } }),
    'address.$set'
  );
  assert.equal((await Contact.findById(contact._id)).address.city, undefined);
});

test('contact update rejects unknown nested address fields', async () => {
  const contact = await createStoredContact();
  await expectRejectedField(
    updateContactRequest(contact, { address: { city: 'Lima', internalCode: 'hidden' } }),
    'address.internalCode'
  );
});

test('valid contact update persists allowed fields', async () => {
  const contact = await createStoredContact();
  const response = await updateContactRequest(contact, {
    name: 'Allowed contact update',
    email: 'allowed@example.com',
    address: { city: 'Lima', country: 'Peru' },
    creditLimit: 250
  });
  const stored = await Contact.findById(contact._id);
  assert.equal(response.statusCode, 200);
  assert.equal(stored.name, 'Allowed contact update');
  assert.equal(stored.email, 'allowed@example.com');
  assert.equal(stored.address.city, 'Lima');
  assert.equal(stored.creditLimit, 250);
  assert.equal(stored.type, 'customer');
});

test('specialized contact balance endpoint still updates balance', async () => {
  const contact = await createStoredContact();
  const response = await invokeController(updateContactBalance, {
    businessId: businessA,
    params: { id: contact._id },
    body: { amount: 20, operation: 'add' }
  });
  assert.equal(response.statusCode, 200);
  assert.equal((await Contact.findById(contact._id)).currentBalance, 20);
});

test('tenant A cannot update a product belonging to tenant B', async () => {
  const product = await createStoredProduct(businessB);
  const response = await updateProductRequest(product, { name: 'Cross-tenant update' }, businessA);
  assert.equal(response.statusCode, 404);
  assert.notEqual((await Product.findById(product._id)).name, 'Cross-tenant update');
});

test('tenant A cannot update a contact belonging to tenant B', async () => {
  const contact = await createStoredContact(businessB);
  const response = await updateContactRequest(contact, { name: 'Cross-tenant update' }, businessA);
  assert.equal(response.statusCode, 404);
  assert.notEqual((await Contact.findById(contact._id)).name, 'Cross-tenant update');
});
