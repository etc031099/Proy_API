const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { User, Product } = require('../../src/models');
const { register } = require('../../src/controllers/authController');
const { getProduct } = require('../../src/controllers/productController');
const { authenticate, checkBusinessAccess } = require('../../src/middleware/auth');
const {
  BUSINESS_ID_INDEX_NAME,
  BUSINESS_ID_INDEX_KEY,
  EMAIL_INDEX_NAME,
  BusinessIdMigrationBlockedError,
  migrateBusinessIdIndex
} = require('../../scripts/migrate-business-id-index');

const testUri = process.env.MONGODB_TEST_URI;
const runId = `${Date.now()}-${process.pid}`;
const businessIds = new Set();
const duplicateMigrationCollection = `h04_duplicate_${runId}`;
const cleanMigrationCollection = `h04_clean_${runId}`;
let emailSequence = 0;
let concurrentBusinessId;
let trimmedBusinessId;
let isolationUserA;
let isolationUserB;

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

const registerUser = (businessId, overrides = {}) => {
  businessIds.add(String(businessId).trim());
  return invokeController(register, {
    body: {
      name: 'H04 user',
      email: `h04-${runId}-${++emailSequence}@example.com`,
      password: 'Password1',
      businessId,
      ...overrides
    }
  });
};

const responseStub = () => {
  const response = { statusCode: 200, body: undefined };
  response.status = code => {
    response.statusCode = code;
    return response;
  };
  response.json = body => {
    response.body = body;
    return response;
  };
  return response;
};

test.before(async () => {
  if (!testUri) throw new Error('MONGODB_TEST_URI is required for H-04 integration tests');
  const expectedDb = testUri.split('?')[0].split('/').pop();
  if (!expectedDb.endsWith('_test')) {
    throw new Error(`Refusing to use non-test database: ${expectedDb}`);
  }

  await migrateBusinessIdIndex({ uri: testUri, expectedDb });
  await mongoose.connect(testUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
  await Promise.all([User.init(), Product.init()]);
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await Product.deleteMany({ businessId: { $in: [...businessIds] } });
    await User.deleteMany({ businessId: { $in: [...businessIds] } });
    for (const collectionName of [duplicateMigrationCollection, cleanMigrationCollection]) {
      const exists = await mongoose.connection.db.listCollections(
        { name: collectionName },
        { nameOnly: true }
      ).hasNext();
      if (exists) await mongoose.connection.db.collection(collectionName).drop();
    }
  }
  await mongoose.disconnect();
});

test('normal registration returns 201', async () => {
  const response = await registerUser(`h04-normal-${runId}`);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.success, true);
});

test('sequential duplicate registration returns 409 BUSINESS_EXISTS', async () => {
  const businessId = `h04-sequential-${runId}`;
  assert.equal((await registerUser(businessId)).statusCode, 201);
  const duplicate = await registerUser(businessId);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.code, 'BUSINESS_EXISTS');
});

test('concurrent registrations return one 201 and one 409', async () => {
  concurrentBusinessId = `h04-concurrent-${runId}`;
  const responses = await Promise.all([
    registerUser(concurrentBusinessId),
    registerUser(concurrentBusinessId)
  ]);

  assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 409]);
  assert.equal(responses.find(response => response.statusCode === 409).body.code, 'BUSINESS_EXISTS');
});

test('concurrent registration persists exactly one user', async () => {
  assert.equal(await User.countDocuments({ businessId: concurrentBusinessId }), 1);
});

test('businessId E11000 is translated to 409 BUSINESS_EXISTS', async () => {
  const businessId = `h04-e11000-${runId}`;
  assert.equal((await registerUser(businessId)).statusCode, 201);
  const originalFindOne = User.findOne;
  User.findOne = async () => null;
  try {
    const response = await registerUser(businessId);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'BUSINESS_EXISTS');
  } finally {
    User.findOne = originalFindOne;
  }
});

test('listIndexes confirms businessId_1 is unique', async () => {
  const indexes = await User.collection.indexes();
  const index = indexes.find(candidate => candidate.name === BUSINESS_ID_INDEX_NAME);
  assert.deepEqual(index.key, BUSINESS_ID_INDEX_KEY);
  assert.equal(index.unique, true);
});

test('email_1 remains unique', async () => {
  const indexes = await User.collection.indexes();
  const index = indexes.find(candidate => candidate.name === EMAIL_INDEX_NAME);
  assert.deepEqual(index.key, { email: 1 });
  assert.equal(index.unique, true);
});

test('ACME and acme remain distinct tenants', async () => {
  const upper = `H04-ACME-${runId}`;
  const lower = `h04-acme-${runId}`;
  assert.equal((await registerUser(upper)).statusCode, 201);
  assert.equal((await registerUser(lower)).statusCode, 201);
  assert.equal(await User.countDocuments({ businessId: { $in: [upper, lower] } }), 2);
});

test('surrounding spaces are trimmed before storing businessId', async () => {
  trimmedBusinessId = `H04-SPACE-${runId}`;
  const response = await registerUser(`  ${trimmedBusinessId}  `);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.data.user.businessId, trimmedBusinessId);
  assert.equal(await User.countDocuments({ businessId: trimmedBusinessId }), 1);
});

test('trimmed businessId collides with the existing canonical value', async () => {
  const response = await registerUser(` ${trimmedBusinessId} `);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'BUSINESS_EXISTS');
});

test('body businessId cannot replace the authenticated tenant', async () => {
  const a = await registerUser(`h04-isolation-a-${runId}`);
  const b = await registerUser(`h04-isolation-b-${runId}`);
  isolationUserA = await User.findById(a.body.data.user.id);
  isolationUserB = await User.findById(b.body.data.user.id);
  const req = { user: isolationUserA, body: { businessId: isolationUserB.businessId } };
  let nextCalled = false;
  checkBusinessAccess(req, responseStub(), () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.businessId, isolationUserA.businessId);
});

test('a manipulated JWT businessId cannot replace the database tenant', async () => {
  const token = jwt.sign({
    id: isolationUserA._id,
    email: isolationUserA.email,
    businessId: isolationUserB.businessId,
    role: isolationUserA.role
  }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const req = {
    header: name => name === 'Authorization' ? `Bearer ${token}` : undefined
  };
  let authenticated = false;
  await authenticate(req, responseStub(), () => { authenticated = true; });
  assert.equal(authenticated, true);
  checkBusinessAccess(req, responseStub(), () => {});
  assert.equal(req.businessId, isolationUserA.businessId);
});

test('tenant A cannot access a product belonging to tenant B', async () => {
  const product = await Product.create({
    name: 'H04 isolated product', price: 1, stock: 0, category: 'H04',
    businessId: isolationUserB.businessId
  });
  const response = await invokeController(getProduct, {
    businessId: isolationUserA.businessId,
    params: { id: product._id }
  });
  assert.equal(response.statusCode, 404);
});

test('migration aborts on duplicates without changing the index', async () => {
  const collection = mongoose.connection.db.collection(duplicateMigrationCollection);
  await collection.createIndex({ email: 1 }, { name: EMAIL_INDEX_NAME, unique: true });
  await collection.createIndex(BUSINESS_ID_INDEX_KEY, { name: BUSINESS_ID_INDEX_NAME });
  await collection.insertMany([
    { email: `duplicate-a-${runId}@example.com`, businessId: 'DUPLICATE' },
    { email: `duplicate-b-${runId}@example.com`, businessId: 'DUPLICATE' }
  ]);

  await assert.rejects(
    migrateBusinessIdIndex({
      uri: testUri,
      expectedDb: mongoose.connection.name,
      collectionName: duplicateMigrationCollection
    }),
    error => error instanceof BusinessIdMigrationBlockedError
      && error.audit.duplicates.length === 1
  );
  const index = (await collection.indexes()).find(candidate => candidate.name === BUSINESS_ID_INDEX_NAME);
  assert.equal(index.unique, undefined);
});

test('clean migration safely converts a non-unique businessId index', async () => {
  const collection = mongoose.connection.db.collection(cleanMigrationCollection);
  await collection.createIndex({ email: 1 }, { name: EMAIL_INDEX_NAME, unique: true });
  await collection.createIndex(BUSINESS_ID_INDEX_KEY, { name: BUSINESS_ID_INDEX_NAME });
  await collection.insertMany([
    { email: `clean-a-${runId}@example.com`, businessId: 'CLEAN-A' },
    { email: `clean-b-${runId}@example.com`, businessId: 'CLEAN-B' }
  ]);

  const result = await migrateBusinessIdIndex({
    uri: testUri,
    expectedDb: mongoose.connection.name,
    collectionName: cleanMigrationCollection
  });
  assert.equal(result.index, BUSINESS_ID_INDEX_NAME);
  const index = (await collection.indexes()).find(candidate => candidate.name === BUSINESS_ID_INDEX_NAME);
  assert.equal(index.unique, true);
});

test('second migration execution is idempotent', async () => {
  const result = await migrateBusinessIdIndex({
    uri: testUri,
    expectedDb: mongoose.connection.name,
    collectionName: cleanMigrationCollection
  });
  assert.equal(result.index, BUSINESS_ID_INDEX_NAME);
  const indexes = await mongoose.connection.db.collection(cleanMigrationCollection).indexes();
  assert.equal(indexes.filter(index => index.name === BUSINESS_ID_INDEX_NAME).length, 1);
  assert.equal(indexes.find(index => index.name === EMAIL_INDEX_NAME).unique, true);
});
