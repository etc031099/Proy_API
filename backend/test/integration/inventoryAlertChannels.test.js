const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const Event = require('../../src/models/InventoryAlertOutboxEvent');
const Delivery = require('../../src/models/InventoryAlertChannelDelivery');
const Connection = require('../../src/models/TelegramConnection');
const { createInventoryAlertChannels, repository, destinationKey } = require('../../src/services/inventoryAlertChannels');
const a = `channel-test-${randomUUID()}`, b = `channel-test-${randomUUID()}`;
let now = new Date(), sent = [];
const sender = async (chat, message) => { sent.push({ chat, message }); };
const service = () => createInventoryAlertChannels({ send: sender, clock: () => now });
const event = async (businessId = a, status = 'DELIVERED') => {
  const alertId = new mongoose.Types.ObjectId(), productId = new mongoose.Types.ObjectId();
  const eventId = `${alertId}:inventory.alert.opened`;
  return Event.create({ businessId, alertId, productId, eventId, eventType: 'inventory.alert.opened', status, receivedAt: now,
    payload: { eventId, eventType: 'inventory.alert.opened', data: { product: { sku: 'CHANNEL-SKU', name: 'Synthetic fixture' },
      previousStock: 4, newStock: 3, condition: { operator: '<=', threshold: 3 } } } });
};
test.before(async () => {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) throw Error('Local test URI required');
  const url = new URL(uri);
  if (url.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.pathname.endsWith('_test')) throw Error('Refusing non-local/non-test Mongo');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.isWritablePrimary, true); assert.ok(hello.setName);
  await Promise.all([Event, Delivery, Connection].map(model => model.init()));
  await Connection.create([{ businessId: a, chatId: '111111', enabled: true, stockRuleAlertsEnabled: true },
    { businessId: b, chatId: '222222', enabled: true, stockRuleAlertsEnabled: true }]);
});
test.after(async () => {
  if (mongoose.connection.readyState === 1 && mongoose.connection.name.endsWith('_test')) {
    await Promise.all([Event, Delivery, Connection].map(model => model.deleteMany({ businessId: { $in: [a, b] } })));
  }
  await mongoose.disconnect();
});
test('real unique index is event + channel + destination', async () => {
  const index = (await Delivery.collection.indexes()).find(row => row.unique);
  assert.deepEqual(index.key, { eventId: 1, channel: 1, destinationKey: 1 });
  const e = await event(), c = await repository.connection(a); await repository.ensure(e, c, now);
  const row = await Delivery.findOne({ eventId: e.eventId }).lean(); delete row._id;
  await assert.rejects(Delivery.create(row), { code: 11000 });
  await Delivery.deleteMany({ eventId: e.eventId });
});
test('real concurrent duplicate requests send once and persist success across service restart', async () => {
  sent = []; const e = await event();
  await Promise.all(Array.from({ length: 6 }, () => service().process(e.eventId)));
  assert.equal(sent.length, 1); assert.equal(await Delivery.countDocuments({ eventId: e.eventId }), 1);
  await service().process(e.eventId); assert.equal(sent.length, 1);
  assert.equal((await Delivery.findOne({ eventId: e.eventId })).status, 'DELIVERED');
});
test('real claim lease excludes another worker and permits restart recovery after expiry', async () => {
  sent = []; const e = await event(); await repository.ensure(e, await repository.connection(a), now);
  const first = await repository.claim(e, now, 'worker-one'); assert.ok(first);
  assert.equal(await repository.claim(e, now, 'worker-two'), null);
  await repository.finish(first, 'wrong-lease', { status: 'DELIVERED' });
  assert.equal((await Delivery.findOne({ eventId: e.eventId })).status, 'IN_FLIGHT');
  now = new Date(now.getTime() + 30001); await service().processPendingEvent(e.eventId);
  assert.equal(sent.length, 1); assert.equal((await Delivery.findOne({ eventId: e.eventId })).status, 'DELIVERED');
});
test('real retry persists due time and recovers without duplicate success', async () => {
  sent = []; const e = await event();
  const failing = createInventoryAlertChannels({ clock: () => now, send: async () => { throw { category: 'RATE_LIMIT' }; } });
  await failing.process(e.eventId);
  let row = await Delivery.findOne({ eventId: e.eventId }); assert.equal(row.status, 'FAILED'); assert.equal(row.attempts, 1);
  await service().process(e.eventId); assert.equal(sent.length, 0);
  now = new Date(row.nextAttemptAt.getTime()); await service().process(e.eventId); await service().process(e.eventId);
  assert.equal(sent.length, 1); row = await Delivery.findOne({ eventId: e.eventId }); assert.equal(row.attempts, 2);
});
test('real persisted event derives tenant A/B destination; no caller tenant input exists', async () => {
  sent = []; const ea = await event(a), eb = await event(b);
  await service().process(ea.eventId); await service().process(eb.eventId);
  assert.deepEqual(sent.map(row => row.chat).sort(), ['111111', '222222']);
  assert.equal(await Delivery.countDocuments({ businessId: a, eventId: eb.eventId }), 0);
  assert.equal(await Delivery.countDocuments({ businessId: b, eventId: ea.eventId }), 0);
});
test('real ACK race persists PENDING then sends only after outbox delivered', async () => {
  sent = []; const e = await event(a, 'IN_FLIGHT');
  await service().process(e.eventId); assert.equal(sent.length, 0);
  assert.equal((await Delivery.findOne({ eventId: e.eventId })).status, 'PENDING');
  await Event.updateOne({ eventId: e.eventId }, { $set: { status: 'DELIVERED' } });
  await service().processPendingEvent(e.eventId); assert.equal(sent.length, 1);
});
test('real missing preference skips permanently and does not migrate legacy opt-in', async () => {
  const c = await Connection.findOne({ businessId: b });
  await Connection.updateOne({ businessId: b }, { $unset: { stockRuleAlertsEnabled: 1, stockRuleResolvedAlertsEnabled: 1 } });
  const e = await event(b); sent = []; await service().process(e.eventId);
  const row = await Delivery.findOne({ businessId: b, eventId: e.eventId });
  assert.equal(row.status, 'SKIPPED'); assert.equal(row.skipReason, 'preference_disabled'); assert.equal(sent.length, 0);
  assert.equal(row.destinationKey, destinationKey(c)); assert.equal(row.nextAttemptAt, null);
});
test('real durable receipt reserves channel work before ACK without sending; restart batch recovers', async () => {
  sent = []; const e = await event();
  await Event.updateOne({ eventId: e.eventId }, { $unset: { receivedAt: 1 } });
  const ack = await require('../../src/services/inventoryAlertOutbox').receiveAlertEvent(e.payload);
  assert.equal(ack.success, true); assert.equal(sent.length, 0);
  const row = await Delivery.findOne({ eventId: e.eventId }); assert.equal(row.status, 'PENDING');
  now = new Date(Math.max(Date.now(), now.getTime()) + 1000);
  await service().run(); assert.equal(sent.length, 1);
});
test('undelivered outbox backlog cannot starve the eligible channel batch', async () => {
  sent = [];
  for (let i = 0; i < 11; i++) {
    const waiting = await event(a, 'IN_FLIGHT'); await service().process(waiting.eventId);
  }
  const ready = await event(a); await service().prepare(ready.eventId);
  const result = await service().run();
  assert.equal(result.processed, 1); assert.equal(sent.length, 1);
  assert.equal((await Delivery.findOne({ eventId: ready.eventId })).status, 'DELIVERED');
});
