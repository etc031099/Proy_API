const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const models = [
  require('../../src/models/TelegramAssistantBinding'), require('../../src/models/TelegramUpdateReceipt'),
  require('../../src/models/TelegramCallbackToken'), require('../../src/models/AgentConversation'),
  require('../../src/models/AgentConversationMessage')
];
const { inspectTelegramTransportIndexes, provisionTelegramTransportIndexes, verifyTelegramTransportIndexes } =
  require('../../src/services/telegramTransportIndexes');
const { parseArgs } = require('../../scripts/provision-telegram-transport-indexes');
const orderSchema = new mongoose.Schema({}, { autoCreate: false, autoIndex: false });
orderSchema.index({ alpha: 1, beta: -1 }, { name: 'telegram_order_probe', unique: true });
const orderProbe = mongoose.model('TelegramIndexOrderProbe', orderSchema, 'telegram_index_order_probe');
const ttlSchema = new mongoose.Schema({}, { autoCreate: false, autoIndex: false });
ttlSchema.index({ expiresAt: 1 }, { name: 'telegram_ttl_probe', expireAfterSeconds: 0 });
const ttlProbe = mongoose.model('TelegramIndexTtlProbe', ttlSchema, 'telegram_index_ttl_probe');

let databaseName;
let connected = false;
const collectionNames = () => mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
const actualIndexes = Model => Model.collection.listIndexes().toArray();
const createCollection = Model => mongoose.connection.db.createCollection(Model.collection.collectionName);

test.before(async () => {
  const raw = process.env.MONGODB_TEST_URI || '';
  const uri = new URL(raw);
  if (uri.protocol !== 'mongodb:' || uri.hostname !== '127.0.0.1' || uri.port !== '27018'
    || uri.username || uri.password || !/^\/telegram_indexes_[a-f0-9]{16}_test$/.test(uri.pathname)
    || uri.searchParams.get('replicaSet') !== 'rs0' || uri.searchParams.get('directConnection') !== 'true') {
    throw Error('Refusing MongoDB test URI: require unauthenticated 127.0.0.1:27018, isolated random database, rs0 and directConnection=true');
  }
  databaseName = uri.pathname.slice(1);
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, autoCreate: false, autoIndex: false });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
  assert.deepEqual(await collectionNames(), []);
  connected = true;
});

test.after(async () => {
  if (connected && mongoose.connection.readyState === 1 && mongoose.connection.name === databaseName
    && /^telegram_indexes_[a-f0-9]{16}_test$/.test(databaseName)) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('index preflight is read-only and reports missing indexes without creating collections', async () => {
  const report = await inspectTelegramTransportIndexes(models);
  assert.ok(report.summary.missing > 0);
  assert.equal(report.summary.conflict, 0);
  assert.deepEqual(await collectionNames(), []);
});

test('preflight detects indexes already present and lists the remaining requirements', async () => {
  for (const Model of [models[3], models[4]]) {
    await createCollection(Model);
    for (const [key, options] of Model.schema.indexes()) await Model.collection.createIndex(key, options);
  }
  const report = await inspectTelegramTransportIndexes(models);
  assert.ok(report.collections.find(row => row.collection === models[3].collection.collectionName)
    .indexes.every(index => index.status === 'EXISTS'));
  assert.ok(report.collections.find(row => row.collection === models[0].collection.collectionName)
    .indexes.every(index => index.status === 'MISSING'));
});

test('provisioning rejects a mismatched database before inspecting or writing', async () => {
  await assert.rejects(provisionTelegramTransportIndexes(models, { expectedDatabaseName: 'wrong_database',
    actualDatabaseName: databaseName, authorized: true }), { code: 'TELEGRAM_DATABASE_MISMATCH' });
  assert.equal((await actualIndexes(models[3])).length, models[3].schema.indexes().length + 1);
  assert.equal((await collectionNames()).some(row => row.name === models[0].collection.collectionName), false);
});

test('all index conflicts are detected before provisioning creates any missing index', async () => {
  await createCollection(models[0]);
  await models[0].collection.createIndex({ wrongField: 1 }, { name: 'telegram_assistant_chat_unique', unique: true });
  await assert.rejects(provisionTelegramTransportIndexes(models, { expectedDatabaseName: databaseName,
    actualDatabaseName: databaseName, authorized: true }), error => {
    assert.equal(error.code, 'TELEGRAM_INDEX_CONFLICT');
    assert.ok(error.details.summary.conflict > 0);
    return true;
  });
  assert.deepEqual((await collectionNames()).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: models[0].collection.collectionName, type: 'collection' },
    { name: models[3].collection.collectionName, type: 'collection' },
    { name: models[4].collection.collectionName, type: 'collection' }
  ].sort((a, b) => a.name.localeCompare(b.name)));
  await models[0].collection.dropIndex('telegram_assistant_chat_unique');
});

test('preflight detects compound key order and TTL option conflicts', async () => {
  await createCollection(orderProbe);
  await orderProbe.collection.createIndex({ beta: -1, alpha: 1 }, { name: 'telegram_order_probe', unique: true });
  await createCollection(ttlProbe);
  await ttlProbe.collection.createIndex({ expiresAt: 1 }, { name: 'telegram_ttl_probe', expireAfterSeconds: 3600 });
  const orderReport = await inspectTelegramTransportIndexes([orderProbe]);
  const ttlReport = await inspectTelegramTransportIndexes([ttlProbe]);
  assert.equal(orderReport.collections[0].indexes[0].status, 'CONFLICT');
  assert.ok(orderReport.collections[0].indexes[0].reasons.includes('NAME_HAS_DIFFERENT_KEYS'));
  assert.equal(ttlReport.collections[0].indexes[0].status, 'CONFLICT');
  assert.ok(ttlReport.collections[0].indexes[0].reasons.includes('OPTIONS_MISMATCH'));
});

test('explicit authorization creates only missing indexes and reruns without duplicates', async () => {
  await assert.rejects(provisionTelegramTransportIndexes(models, { expectedDatabaseName: databaseName,
    actualDatabaseName: databaseName }), { code: 'TELEGRAM_PROVISION_NOT_AUTHORIZED' });
  await assert.rejects(provisionTelegramTransportIndexes(models, { expectedDatabaseName: databaseName,
    actualDatabaseName: databaseName, authorized: true }), { code: 'TELEGRAM_COLLECTIONS_MISSING' });
  assert.equal((await collectionNames()).length, 5);
  for (const Model of models) {
    if (!(await collectionNames()).some(row => row.name === Model.collection.collectionName)) await createCollection(Model);
  }
  const before = await actualIndexes(models[3]);
  const first = await provisionTelegramTransportIndexes(models, { expectedDatabaseName: databaseName,
    actualDatabaseName: databaseName, authorized: true });
  assert.equal(first.summary.missing, 0);
  assert.equal(first.summary.conflict, 0);
  assert.equal((await actualIndexes(models[3])).length, before.length);
  const counts = await Promise.all(models.map(async Model => (await actualIndexes(Model)).length));
  const second = await provisionTelegramTransportIndexes(models, { expectedDatabaseName: databaseName,
    actualDatabaseName: databaseName, authorized: true });
  assert.equal(second.summary.exists, counts.reduce((sum, count, index) => sum + count - 1, 0));
  assert.deepEqual(await Promise.all(models.map(async Model => (await actualIndexes(Model)).length)), counts);
  await verifyTelegramTransportIndexes(models);
});

test('CLI requires an explicit expected database and exposes only a separate provisioning authorization option', () => {
  assert.throws(() => parseArgs([]), { code: 'TELEGRAM_EXPECTED_DATABASE_REQUIRED' });
  assert.deepEqual(parseArgs(['--expected-db', 'inventory_billing']), { expectedDatabaseName: 'inventory_billing', authorized: false });
  assert.deepEqual(parseArgs(['--expected-db', 'inventory_billing', '--authorize-provision']),
    { expectedDatabaseName: 'inventory_billing', authorized: true });
  assert.throws(() => parseArgs(['--expected-db', 'bad.name']), { code: 'TELEGRAM_EXPECTED_DATABASE_REQUIRED' });
});
