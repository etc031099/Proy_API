'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const R = require('../src/services/mlTestRestoreService');
const M = require('../src/services/mlTestCheckpointManifest');
const F = require('../src/services/mlTestFence');
const { BSON } = M;
test('restore order covers exactly the snapshot allowlist and excludes control/archive namespaces', () => {
  assert.equal(R.ORDER.length, 23);
  assert.deepEqual([...R.ORDER].sort(), M.COLLECTIONS.map(row => row.collection).sort());
  assert(R.ORDER.indexOf('forecastmodelartifacts') < R.ORDER.indexOf('forecastmodelregistries'));
  assert(R.ORDER.indexOf('products') < R.ORDER.indexOf('inventorymovements'));
});
test('cloud, ordinary databases and malformed local restore requests fail before reads or writes', async () => {
  const local = { options: { hosts: [{ host: '127.0.0.1' }] } };
  const db = { databaseName: `ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`,
    collection() { assert.fail('must not access data'); } };
  await assert.rejects(R.restoreLocalCheckpoint({ client: { options: { srvHost: 'fixture.mongodb.net' } }, db }),
    { code: 'CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED' });
  await assert.rejects(R.restoreLocalCheckpoint({ client: local, db: { ...db, databaseName: 'production' } }),
    { code: 'CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED' });
  await assert.rejects(R.restoreLocalCheckpoint({ client: local, db, restoreId: 'invalid', branch: 'NORMAL' }),
    { code: 'RESTORE_REQUEST_INVALID' });
});
test('streamed reconstruction retains exact BSON numeric types and Binary subtype across chunk boundaries', async () => {
  const raw = BSON.serialize({ _id: new BSON.ObjectId(), int: new BSON.Int32(3), double: new BSON.Double(3),
    long: BSON.Long.fromString('9007199254740993'), decimal: BSON.Decimal128.fromString('1.20'),
    binary: new BSON.Binary(Buffer.alloc(150), 128), date: new Date('2026-10-15T00:00:00Z') });
  const chunks = []; for await (const chunk of M.chunkDocuments([raw], 64)) chunks.push(chunk);
  let closed = false;
  const db = { collection: () => ({ find: () => ({ sort() { return this; },
    async *[Symbol.asyncIterator]() { yield* chunks; }, async close() { closed = true; } }) }) };
  const docs = []; for await (const doc of R.documents(db, 'fixture', 'products')) docs.push(doc);
  assert.equal(docs.length, 1); assert(BSON.serialize(docs[0]).equals(raw)); assert.equal(closed, true);
});
test('fence compares epoch/cycle and writes the control in the exact supplied transaction', async () => {
  const session = { inTransaction: () => true }, resetEpoch = BSON.Long.fromNumber(9);
  let writes = 0;
  const db = { collection: () => ({
    async findOne(_filter, options) { assert.equal(options.session, session);
      return { state: 'TEST_ACTIVE', resetEpoch, testCycleId: 'cycle' }; },
    async updateOne(filter, change, options) {
      writes++; assert.equal(options.session, session); assert.equal(filter.resetEpoch, resetEpoch);
      assert.equal(filter.testCycleId, 'cycle'); assert.equal(filter.state, 'TEST_ACTIVE');
      assert(change.$set.writeFenceNonce); assert.equal(change.$inc, undefined);
      return { matchedCount: 1 };
    }
  }) };
  await F.guard({ db, session, expected: { present: true, resetEpoch: '9', testCycleId: 'cycle' } });
  assert.equal(writes, 1);
  await assert.rejects(F.guard({ db, session, expected: { present: true, resetEpoch: '8', testCycleId: 'cycle' } }),
    { code: 'STALE_TEST_EPOCH' });
  assert.equal(writes, 1);
});
test('nested cycle cannot overwrite an old expected epoch with a freshly captured epoch', async () => {
  const expected = { present: true, resetEpoch: '9', testCycleId: 'cycle' };
  const db = { collection: () => ({ findOne: async () => ({ resetEpoch: BSON.Long.fromNumber(9), testCycleId: 'cycle' }) }) };
  await F.withEpoch(db, async () => {
    await assert.rejects(F.withEpoch(db, async () => assert.fail('must not execute'), { ...expected, resetEpoch: '8' }),
      { code: 'STALE_TEST_EPOCH' });
  }, expected);
});
