const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const Transfer = require('../../src/models/TelegramConnectionTransfer');
const Connection = require('../../src/models/TelegramConnection');
const User = require('../../src/models/User');
const { createTelegramRecovery, repository, hash, TTL_MS } = require('../../src/services/telegramRecovery');
const service = options => createTelegramRecovery({ audit() {}, ...options });
const fixture = async () => {
  const key = randomUUID(); const businesses = ['old', 'destination', 'other'].map(label => `${label}-${key}`);
  const users = businesses.map((businessId, index) => ({ _id: new mongoose.Types.ObjectId(), businessId, name: 'Synthetic fixture',
    email: `synthetic-${key}-${index}@example.test`, password: 'test-fixture-not-used-for-authentication', isActive: true }));
  await User.collection.insertMany(users);
  return { source: businesses[0], destination: businesses[1], other: businesses[2], user: users[1]._id, otherUser: users[2]._id,
    chat: String(100000000 + Math.floor(Math.random() * 100000000)), start: s => s.initiate({ businessId: businesses[1], userId: users[1]._id }) };
};
test.before(async () => {
  const url = new URL(process.env.MONGODB_TEST_URI || 'http://invalid');
  if (url.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/telegram_recovery_[a-f0-9]+_test$/.test(url.pathname)) throw Error('Refusing non-local/non-isolated Mongo');
  await mongoose.connect(url.href, { serverSelectionTimeoutMS: 5000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.isWritablePrimary, true); assert.ok(hello.setName);
  await Promise.all([Transfer, Connection, User].map(model => model.init()));
});
test.after(async () => {
  if (mongoose.connection.readyState === 1 && /^telegram_recovery_[a-f0-9]+_test$/.test(mongoose.connection.name)) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
test('Mongo real: atomic transfer keeps source identity/preferences and destination preferences; history stays isolated', async () => {
  const f = await fixture(), s = service();
  const old = await Connection.create({ businessId: f.source, chatId: f.chat, enabled: true, stockRuleAlertsEnabled: true,
    lowStockAlertsEnabled: false, connectionCodeHash: 'synthetic-old-code' });
  const dest = await Connection.create({ businessId: f.destination, stockRuleResolvedAlertsEnabled: true, stockRuleAlertsEnabled: false });
  const collections = ['inventoryalerts', 'stockalertrules', 'inventoryalertoutboxevents', 'inventoryalertchanneldeliveries', 'transactions', 'products', 'inventorymovements', 'agentconversations'];
  const saved = [];
  for (const name of collections) { const row = { _id: new mongoose.Types.ObjectId(), businessId: f.source, fixture: true }; await mongoose.connection.db.collection(name).insertOne(row); saved.push(row); }
  const { code } = await f.start(s); const result = await s.confirm(code, f.chat); assert.equal(result.status, 'CONNECTED');
  const source = await Connection.findById(old._id).lean(), destination = await Connection.findById(dest._id).lean();
  assert.equal(source.chatId, undefined); assert.equal(source.connectionCodeHash, undefined); assert.equal(source.stockRuleAlertsEnabled, true);
  assert.equal(source.lowStockAlertsEnabled, false); assert.equal(destination.chatId, f.chat); assert.equal(destination.stockRuleAlertsEnabled, false);
  assert.equal(destination.stockRuleResolvedAlertsEnabled, true); assert.equal(await Connection.countDocuments({ chatId: f.chat }), 1);
  for (let i = 0; i < collections.length; i++) assert.deepEqual(await mongoose.connection.db.collection(collections[i]).findOne({ _id: saved[i]._id }), saved[i]);
  const challenge = await Transfer.findOne({ challengeHash: hash(code) }).lean();
  assert.equal(challenge.status, 'USED'); assert.equal(challenge.sourceBusinessId, f.source); assert.equal(challenge.auditEvent, 'telegram.connection.transferred');
  assert.equal(challenge.chatId, undefined); assert.equal(challenge.code, undefined);
});
test('Mongo real: no owner connects once; unique sparse chat and challenge replay prevent duplicate update', async () => {
  const f = await fixture(), s = service(), { code } = await f.start(s);
  assert.equal((await s.confirm(code, f.chat)).status, 'CONNECTED');
  assert.equal((await service().confirm(code, f.chat)).status, 'USED');
  assert.equal(await Connection.countDocuments({ chatId: f.chat }), 1);
  await assert.rejects(Connection.create({ businessId: f.other, chatId: f.chat }), { code: 11000 });
  const unique = (await Connection.collection.indexes()).find(index => index.key.chatId === 1);
  assert.equal(unique.unique, true); assert.equal(unique.sparse, true);
});
test('Mongo real: failure after releasing source rolls back both connections and unused challenge', async () => {
  const f = await fixture(), s = service(); await Connection.create({ businessId: f.source, chatId: f.chat }); const { code } = await f.start(s);
  const failing = service({ repo: { ...repository, assign: async () => { throw Error('synthetic failure after release'); } } });
  assert.equal((await failing.confirm(code, f.chat)).status, 'UNAVAILABLE');
  assert.equal((await Connection.findOne({ businessId: f.source })).chatId, f.chat);
  assert.equal(await Connection.countDocuments({ businessId: f.destination }), 0);
  assert.equal((await Transfer.findOne({ challengeHash: hash(code) })).status, 'PENDING');
});
test('Mongo real: concurrent confirmations of one update commit exactly once', async () => {
  const f = await fixture(), s = service(); await Connection.create({ businessId: f.source, chatId: f.chat }); const { code } = await f.start(s);
  const results = await Promise.all([s.confirm(code, f.chat), service().confirm(code, f.chat)]);
  assert.equal(results.filter(row => row.status === 'CONNECTED').length, 1);
  assert.equal(await Connection.countDocuments({ chatId: f.chat }), 1);
  assert.equal((await Connection.findOne({ businessId: f.destination })).chatId, f.chat);
});
test('Mongo real: two destinations racing one owned chat cannot partially release it or duplicate ownership', async () => {
  const f = await fixture(), s = service(); await Connection.create({ businessId: f.source, chatId: f.chat });
  const first = await f.start(s), second = await s.initiate({ businessId: f.other, userId: f.otherUser });
  // Both transactions observe the same source snapshot before attempting its write.
  let readers = 0, unlock; const barrier = new Promise(resolve => { unlock = resolve; });
  const racingRepo = { ...repository, async connection(query, session) {
    const row = await repository.connection(query, session);
    if (query.chatId) { readers++; if (readers === 2) unlock(); await barrier; }
    return row;
  } };
  const results = await Promise.all([service({ repo: racingRepo }).confirm(first.code, f.chat), service({ repo: racingRepo }).confirm(second.code, f.chat)]);
  assert.equal(results.filter(row => row.status === 'CONNECTED').length, 1);
  assert.equal(await Connection.countDocuments({ chatId: f.chat }), 1);
  const owner = await Connection.findOne({ chatId: f.chat }); assert.ok([f.destination, f.other].includes(owner.businessId));
  assert.equal((await Connection.findOne({ businessId: f.source })).chatId, undefined);
});
test('Mongo real: new destination challenge supersedes old; concurrent generation leaves one active challenge', async () => {
  const f = await fixture(), s = service(), first = await f.start(s), second = await f.start(s);
  assert.equal((await s.confirm(first.code, f.chat)).status, 'INVALID');
  assert.equal((await s.confirm(second.code, f.chat)).status, 'CONNECTED');
  const g = await fixture(), calls = await Promise.allSettled([g.start(service()), g.start(service())]);
  assert.ok(calls.some(row => row.status === 'fulfilled')); assert.equal(await Transfer.countDocuments({ destinationBusinessId: g.destination, status: 'PENDING' }), 1);
});
test('Mongo real: expiry, invalid challenge, inactive actor and conflicting destination preserve owner', async () => {
  const f = await fixture(), now = new Date(), s = service({ clock: () => now }); await Connection.create({ businessId: f.source, chatId: f.chat }); const { code } = await f.start(s);
  assert.equal((await service({ clock: () => new Date(now.getTime() + TTL_MS) }).confirm(code, f.chat)).status, 'EXPIRED');
  assert.equal((await s.confirm('TRF-0000000000000000', f.chat)).status, 'INVALID');
  await User.updateOne({ _id: f.user }, { $set: { isActive: false } }); assert.equal((await s.confirm(code, f.chat)).status, 'INVALID');
  await User.updateOne({ _id: f.user }, { $set: { isActive: true } });
  await Connection.create({ businessId: f.destination, chatId: `${f.chat}1` });
  assert.equal((await s.confirm(code, f.chat)).status, 'DESTINATION_CONNECTED'); assert.equal((await Connection.findOne({ businessId: f.source })).chatId, f.chat);
  await assert.rejects(s.initiate({ businessId: f.destination, userId: f.otherUser }), { code: 'TELEGRAM_RECOVERY_FORBIDDEN' });
});
