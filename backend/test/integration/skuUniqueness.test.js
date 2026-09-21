const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const { Product, InventoryMovement } = require('../../src/models');
const { createProduct, updateProduct } = require('../../src/controllers/productController');
const {
  SKU_INDEX_NAME,
  SKU_INDEX_KEY,
  SKU_PARTIAL_FILTER
} = require('../../src/utils/sku');
const {
  SkuMigrationBlockedError,
  migrateSkuIndex
} = require('../../scripts/migrate-sku-index');

const testUri = process.env.MONGODB_TEST_URI;
const runId = `${Date.now()}-${process.pid}`;
const tenantA = `h06-a-${runId}`;
const tenantB = `h06-b-${runId}`;
const migrationTestCollection = `h06_migration_${Date.now()}_${process.pid}`;
const cleanMigrationCollection = `h06_migration_clean_${Date.now()}_${process.pid}`;
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

const productBody = overrides => ({
  name: `H06 product ${++sequence}`,
  price: 10,
  currency: 'PEN',
  stock: 1,
  category: 'H06',
  ...overrides
});

const create = (businessId, overrides = {}) => invokeController(createProduct, {
  businessId,
  body: productBody(overrides)
});

test.before(async () => {
  if (!testUri) throw new Error('MONGODB_TEST_URI is required for H-06 integration tests');

  const uriDatabase = new URL(testUri.replace('mongodb://', 'http://')).pathname.slice(1).split('?')[0];
  if (!uriDatabase.endsWith('_test')) {
    throw new Error(`Refusing to use non-test database: ${uriDatabase}`);
  }

  await migrateSkuIndex({ uri: testUri, expectedDb: uriDatabase });
  await mongoose.connect(testUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
  await Promise.all([Product.init(), InventoryMovement.init()]);
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await Product.deleteMany({ businessId: { $in: [tenantA, tenantB] } });
    await InventoryMovement.collection.deleteMany({ businessId: { $in: [tenantA, tenantB] } });
    for (const collectionName of [migrationTestCollection, cleanMigrationCollection]) {
      const exists = await mongoose.connection.db.listCollections(
        { name: collectionName },
        { nameOnly: true }
      ).hasNext();
      if (exists) await mongoose.connection.db.collection(collectionName).drop();
    }
  }
  await mongoose.disconnect();
});

test('same SKU is allowed in different tenants but rejected within one tenant', async () => {
  const first = await create(tenantA, { sku: 'ABC' });
  const otherTenant = await create(tenantB, { sku: 'ABC' });
  const duplicate = await create(tenantA, { sku: 'ABC' });

  assert.equal(first.statusCode, 201);
  assert.equal(otherTenant.statusCode, 201);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.code, 'SKU_ALREADY_EXISTS');
  assert.equal(await Product.countDocuments({ businessId: tenantA, sku: 'ABC' }), 1);
  assert.equal(await Product.countDocuments({ businessId: tenantB, sku: 'ABC' }), 1);
});

test('concurrent creates persist exactly one product for the same tenant and SKU', async () => {
  const results = await Promise.all([
    create(tenantA, { sku: 'CONCURRENT' }),
    create(tenantA, { sku: 'CONCURRENT' })
  ]);

  assert.deepEqual(results.map(result => result.statusCode).sort(), [201, 409]);
  assert.equal(results.find(result => result.statusCode === 409).body.code, 'SKU_ALREADY_EXISTS');
  assert.equal(await Product.countDocuments({ businessId: tenantA, sku: 'CONCURRENT' }), 1);
});

test('update that collides with another product returns a coherent conflict', async () => {
  await create(tenantA, { sku: 'UPDATE-TAKEN' });
  const available = await create(tenantA, { sku: 'UPDATE-FREE' });
  const response = await invokeController(updateProduct, {
    businessId: tenantA,
    params: { id: available.body.data.product._id },
    body: { sku: 'UPDATE-TAKEN' }
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'SKU_ALREADY_EXISTS');
  assert.equal((await Product.findById(available.body.data.product._id)).sku, 'UPDATE-FREE');
});

test('multiple omitted, empty and whitespace-only SKUs are stored without a real SKU', async () => {
  const results = await Promise.all([
    create(tenantA),
    create(tenantA),
    create(tenantA, { sku: '' }),
    create(tenantA, { sku: '   ' })
  ]);

  assert.deepEqual(results.map(result => result.statusCode), [201, 201, 201, 201]);
  const stored = await Product.find({
    _id: { $in: results.map(result => result.body.data.product._id) }
  }).select('sku').lean();
  assert.equal(stored.filter(product => product.sku === null).length, 2);
  assert.equal(stored.filter(product => !Object.prototype.hasOwnProperty.call(product, 'sku')).length, 2);
});

test('an inactive product continues reserving its SKU', async () => {
  await Product.create({
    ...productBody({ sku: 'INACTIVE-RESERVED' }),
    businessId: tenantA,
    isActive: false
  });

  const response = await create(tenantA, { sku: 'INACTIVE-RESERVED' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'SKU_ALREADY_EXISTS');
});

test('products index is tenant-scoped, unique and partial', async () => {
  const indexes = await Product.collection.indexes();
  const index = indexes.find(candidate => candidate.name === SKU_INDEX_NAME);

  assert.deepEqual(index.key, SKU_INDEX_KEY);
  assert.equal(index.unique, true);
  assert.deepEqual(index.partialFilterExpression, SKU_PARTIAL_FILTER);
  assert.equal(indexes.some(candidate => candidate.name === 'sku_1'), false);
});

test('Mongoose and init-mongo declare the same SKU index policy', () => {
  const schemaIndex = Product.schema.indexes().find(([key]) => (
    key.businessId === 1 && key.sku === 1
  ));
  assert.deepEqual(schemaIndex[0], SKU_INDEX_KEY);
  assert.equal(schemaIndex[1].name, SKU_INDEX_NAME);
  assert.equal(schemaIndex[1].unique, true);
  assert.deepEqual(schemaIndex[1].partialFilterExpression, SKU_PARTIAL_FILTER);

  const initMongo = fs.readFileSync(path.join(__dirname, '../../init-mongo.js'), 'utf8');
  assert.match(initMongo, /\{ businessId: 1, sku: 1 \}/);
  assert.match(initMongo, /name: 'businessId_1_sku_1'/);
  assert.match(initMongo, /partialFilterExpression: \{ sku: \{ \$type: 'string', \$gt: '' \} \}/);
});

test('migration refuses duplicate tenant SKUs without changing indexes', async () => {
  const collection = mongoose.connection.db.collection(migrationTestCollection);
  await collection.insertMany([
    { businessId: tenantA, sku: 'DUPLICATE', isActive: true },
    { businessId: tenantA, sku: 'DUPLICATE', isActive: false }
  ]);
  await collection.createIndex({ sku: 1 }, { name: 'sku_1' });

  await assert.rejects(
    migrateSkuIndex({
      uri: testUri,
      expectedDb: mongoose.connection.name,
      collectionName: migrationTestCollection
    }),
    error => error instanceof SkuMigrationBlockedError
      && error.audit.duplicates.length === 1
      && error.audit.duplicates[0].active === 1
      && error.audit.duplicates[0].inactive === 1
  );

  const indexes = await collection.indexes();
  assert.equal(indexes.some(index => index.name === 'sku_1'), true);
  assert.equal(indexes.some(index => index.name === SKU_INDEX_NAME), false);
});

test('migration normalizes blank SKUs, creates the index and is idempotent', async () => {
  const collection = mongoose.connection.db.collection(cleanMigrationCollection);
  await collection.insertMany([
    { businessId: tenantA, sku: '' },
    { businessId: tenantA, sku: '   ' },
    { businessId: tenantA },
    { businessId: tenantA, sku: 'REAL' },
    { businessId: tenantB, sku: 'REAL' }
  ]);
  await collection.createIndex({ sku: 1 }, { name: 'sku_1' });

  const first = await migrateSkuIndex({
    uri: testUri,
    expectedDb: mongoose.connection.name,
    collectionName: cleanMigrationCollection
  });
  const second = await migrateSkuIndex({
    uri: testUri,
    expectedDb: mongoose.connection.name,
    collectionName: cleanMigrationCollection
  });

  assert.equal(first.normalizedEmptySkus, 2);
  assert.equal(second.normalizedEmptySkus, 0);
  assert.equal(await collection.countDocuments({ sku: { $type: 10 } }), 2);
  assert.equal(await collection.countDocuments({ sku: { $exists: false } }), 1);
  const indexes = await collection.indexes();
  const index = indexes.find(candidate => candidate.name === SKU_INDEX_NAME);
  assert.deepEqual(index.key, SKU_INDEX_KEY);
  assert.equal(index.unique, true);
  assert.deepEqual(index.partialFilterExpression, SKU_PARTIAL_FILTER);
  assert.equal(indexes.some(candidate => candidate.name === 'sku_1'), false);
});
