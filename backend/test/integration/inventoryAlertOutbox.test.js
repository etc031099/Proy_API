require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const Product = require('../../src/models/Product');
const Rule = require('../../src/models/StockAlertRule');
const Alert = require('../../src/models/InventoryAlert');
const Event = require('../../src/models/InventoryAlertOutboxEvent');
const { applyStockChange } = require('../../src/services/inventoryService');
const Movement = require('../../src/models/InventoryMovement');
const { repository, receiveAlertEvent, createInventoryAlertDispatcher } = require('../../src/services/inventoryAlertOutbox');
const scope = `outbox-test-${randomUUID()}`, foreign = `${scope}-foreign`;
const models = [Product, Rule, Alert, Event, Movement];
let product, event;
test.before(async () => {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) throw Error('Local test Mongo required');
  const url = new URL(uri);
  if (url.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.pathname.slice(1).endsWith('_test')) throw Error('Refusing non-local/non-test Mongo');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 }); assert.equal(hello.isWritablePrimary, true); assert.ok(hello.setName);
  await Promise.all(models.map(model => model.init()));
  // Dispatcher tests isolate their collection with a unique database per run.
  assert.equal(await Event.countDocuments({}), 0, 'Use a fresh dedicated test database for dispatcher tests');
  product = await Product.create({ businessId: scope, sku: 'OUTBOX-TEST', name: 'Synthetic', category: 'Test', stock: 4, price: 1 });
  await Rule.create({ businessId: scope, productId: product._id, operator: '<=', threshold: 3, createdBy: new mongoose.Types.ObjectId() });
});
test.after(async () => {
  if (mongoose.connection.readyState === 1 && mongoose.connection.name.endsWith('_test')) {
    for (const model of models) await model.collection.deleteMany({ businessId: { $in: [scope, foreign] } });
  }
  await mongoose.disconnect();
});
async function change(delta, rollback = false) {
  const session = await mongoose.startSession(); session.startTransaction();
  try {
    const current = await Product.findById(product._id).session(session);
    await applyStockChange({ product: current, quantityDelta: delta, type: 'manual_adjustment', source: 'api', session });
    if (rollback) await session.abortTransaction(); else await session.commitTransaction();
  } finally { await session.endSession(); }
}
test('real rollback leaves stock, movement, alert and outbox unchanged', async () => {
  await change(-1, true);
  assert.equal((await Product.findById(product._id)).stock, 4);
  assert.equal(await Alert.countDocuments({ businessId: scope }), 0);
  assert.equal(await Event.countDocuments({ businessId: scope }), 0);
  assert.equal(await Movement.countDocuments({ businessId: scope }), 0);
});
test('OPEN and RESOLVED persist distinct immutable snapshots in the business transaction', async () => {
  await change(-1);
  event = await Event.findOne({ businessId: scope }).lean();
  assert.equal(event.status, 'PENDING'); assert.equal(event.payload.data.previousStock, 4); assert.equal(event.payload.data.newStock, 3);
  await change(1);
  const resolved = await Event.findOne({ businessId: scope, eventType: 'inventory.alert.resolved' }).lean();
  assert.equal(resolved.payload.data.previousStock, 3); assert.equal(resolved.payload.data.newStock, 4);
  assert.notEqual(resolved.eventId, event.eventId); assert.equal(String(resolved.alertId), String(event.alertId));
  assert.equal((await Alert.findById(event.alertId)).status, 'RESOLVED');
  await assert.rejects(Event.collection.insertOne({ ...event, _id: new mongoose.Types.ObjectId() }), error => error.code === 11000);
  await Event.updateMany({ businessId: scope }, { $set: { status: 'DELIVERED' } });
});
test('two concurrent workers claim only one eligible event', async () => {
  await Event.updateOne({ eventId: event.eventId }, { $set: { status: 'PENDING', nextAttemptAt: new Date(0) } });
  const claims = await Promise.all([repository.claim(new Date(), 'worker-a'), repository.claim(new Date(), 'worker-b')]);
  assert.equal(claims.filter(Boolean).length, 1);
  const row = claims.find(Boolean); assert.equal(row.status, 'IN_FLIGHT'); assert.equal(row.attempts, 1);
  const stale = await repository.finish(row, 'stale-worker', { status: 'DELIVERED' }); assert.equal(stale.modifiedCount, 0);
});
test('expired lease survives restart and stale worker cannot finalize reclaimed work', async () => {
  await Event.updateOne({ eventId: event.eventId }, { $set: { leaseUntil: new Date(0) } });
  const row = await repository.claim(new Date(), 'restarted-worker'); assert.equal(row.eventId, event.eventId); assert.equal(row.attempts, 2);
  assert.equal(await repository.claim(new Date(), 'racing-worker'), null);
  await repository.finish(row, 'restarted-worker', { status: 'FAILED', nextAttemptAt: new Date(0), lastErrorCategory: 'NETWORK' });
});
test('offline transport persists retry, then successful dispatcher records delivery', async () => {
  const failed = await createInventoryAlertDispatcher({ deliver: async () => ({ category: 'UNAVAILABLE', retryable: true }) }).run();
  assert.equal(failed.retrying, 1);
  const row = await Event.findOne({ eventId: event.eventId }).lean(); assert.equal(row.status, 'FAILED'); assert.ok(row.nextAttemptAt > row.lastAttemptAt);
  await Event.updateOne({ eventId: event.eventId }, { $set: { nextAttemptAt: new Date(0) } });
  let sends = 0;
  const worker = () => createInventoryAlertDispatcher({ deliver: async () => { sends++; return { delivered: true }; } });
  await Promise.all([worker().run(), worker().run()]); assert.equal(sends, 1);
  assert.equal((await Event.findOne({ eventId: event.eventId })).status, 'DELIVERED');
});
test('durable receipt is idempotent under concurrency and rejects tenant/payload spoofing', async () => {
  const receipts = await Promise.all([receiveAlertEvent(event.payload), receiveAlertEvent(event.payload)]);
  assert.equal(receipts.filter(result => !result.duplicate).length, 1);
  assert.equal(receipts.filter(result => result.duplicate).length, 1);
  assert.ok((await Event.findOne({ eventId: event.eventId })).receivedAt);
  const tampered = structuredClone(event.payload); tampered.data.businessId = foreign;
  assert.equal(await receiveAlertEvent(tampered), null);
  assert.equal(await receiveAlertEvent({ ...event.payload, eventId: `${new mongoose.Types.ObjectId()}:inventory.alert.opened` }), null);
  assert.equal(await Event.countDocuments({ businessId: foreign }), 0);
});
test('immutable snapshots cannot be rewritten through Mongoose delivery updates', async () => {
  await Event.updateOne({ eventId: event.eventId }, { $set: { businessId: foreign, payload: { secret: 'must-not-persist' } } });
  const row = await Event.findOne({ eventId: event.eventId }).lean();
  assert.equal(row.businessId, scope); assert.deepEqual(row.payload, event.payload);
});
test('terminal payload failure remains durable without reclaim or rapid retry', async () => {
  await Event.updateOne({ eventId: event.eventId }, { $set: { status: 'PENDING', nextAttemptAt: new Date(0) } });
  const result = await createInventoryAlertDispatcher({ deliver: async () => ({ category: 'PAYLOAD', retryable: false }) }).run();
  assert.equal(result.failed, 1);
  const row = await Event.findOne({ eventId: event.eventId }).lean();
  assert.equal(row.status, 'FAILED'); assert.equal(row.nextAttemptAt, null);
  assert.equal(await repository.claim(new Date(), 'later-worker'), null);
});
test('real local HTTP backend-to-Node-RED ACK requires persisted receipt and sends no Telegram', async () => {
  const express = require('express'), { once } = require('node:events');
  const { createInventoryAlertDispatchRoutes } = require('../../src/routes/inventoryAlertDispatch');
  const { createWebhookSecurity } = require('../../../node-red/lib/webhook-security');
  const secret = 'synthetic-local-inventory-webhook-secret-12345';
  const backend = express(); backend.use(express.json());
  backend.use('/api/internal/inventory-alert-dispatch', createInventoryAlertDispatchRoutes({ config: () => ({ NODE_RED_WEBHOOK_SECRET: secret }) }));
  const backendServer = backend.listen(0, '127.0.0.1'); await once(backendServer, 'listening');
  const security = createWebhookSecurity(secret), receiver = express(); receiver.use(express.json());
  receiver.post('/webhook', async (req, res) => {
    const reply = await security.receiveInventoryAlert({ req, payload: req.body }, `http://127.0.0.1:${backendServer.address().port}/api`);
    res.status(reply.statusCode).json(reply.payload);
  });
  const receiverServer = receiver.listen(0, '127.0.0.1'); await once(receiverServer, 'listening');
  const oldUrl = process.env.NODE_RED_WEBHOOK_URL, oldSecret = process.env.NODE_RED_WEBHOOK_SECRET;
  process.env.NODE_RED_WEBHOOK_URL = `http://127.0.0.1:${receiverServer.address().port}/webhook`;
  process.env.NODE_RED_WEBHOOK_SECRET = secret;
  try {
    const resolved = await Event.findOne({ businessId: scope, eventType: 'inventory.alert.resolved' }).lean();
    await Event.updateOne({ eventId: resolved.eventId }, { $set: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    assert.equal((await createInventoryAlertDispatcher().run()).delivered, 1);
    const delivered = await Event.findOne({ eventId: resolved.eventId }).lean();
    assert.ok(delivered.receivedAt); assert.ok(delivered.deliveredAt); assert.equal(delivered.status, 'DELIVERED');
    const repeated = await require('../../src/services/inventoryAlertOutbox').send(resolved.payload);
    assert.equal(repeated.delivered, true);
    assert.equal(await Event.countDocuments({ eventId: resolved.eventId }), 1);
  } finally {
    if (oldUrl === undefined) delete process.env.NODE_RED_WEBHOOK_URL; else process.env.NODE_RED_WEBHOOK_URL = oldUrl;
    if (oldSecret === undefined) delete process.env.NODE_RED_WEBHOOK_SECRET; else process.env.NODE_RED_WEBHOOK_SECRET = oldSecret;
    await Promise.all([backendServer, receiverServer].map(server => new Promise(resolve => server.close(resolve))));
  }
});
