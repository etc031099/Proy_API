'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient, BSON } = require('mongoose').mongo;
const S = require('../../src/services/mlTestCheckpointService');
const M = require('../../src/services/mlTestCheckpointManifest');
const scope = M.authorizedScope();
const focus = process.env.CHECKPOINT_INTEGRATION_FOCUS;
const selected = name => !focus || name.toLowerCase().includes(focus.toLowerCase());
const safeAttemptError = error => ({ name: error?.name || null,
  code: typeof error?.code === 'string' ? error.code : Number.isInteger(error?.code) ? error.code : null,
  message: String(error?.message || '').replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, '[REDACTED_URI]') });
test('local replica set: scoped BSON checkpoint, consistent read, CAS, verification and read-only preflight', { timeout: 60000 }, async t => {
  assert(process.env.MONGODB_TEST_URI, 'Use mlTestCheckpoint.run.js');
  const target = new URL(process.env.MONGODB_TEST_URI);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  assert.match(target.pathname, /^\/ml_checkpoint_[a-f0-9]{32}_test$/);
  const client = new MongoClient(target.href, { serverSelectionTimeoutMS: 4000, monitorCommands: true });
  let connected = false, db;
  try {
    try { await client.connect(); connected = true; } catch { throw new Error('CHECKPOINT_LOCAL_MONGO_UNAVAILABLE'); }
    db = client.db(target.pathname.slice(1));
    await S.provisionLocal(client, db);
    // No source index is created by the service; fixture setup owns source DDL.
    for (const { collection } of M.COLLECTIONS) await db.createCollection(collection);
    const fixture = new BSON.ObjectId();
    await db.collection('v3operationalrevisions').insertOne({ _id: scope.businessId, revision: BSON.Long.fromString('9007199254740993') });
    await db.collection('transactions').insertMany([{ _id: 'live', businessId: scope.businessId, scenarioId: null },
      { _id: 'foreign', businessId: 'foreign', scenarioId: null }]);
    await db.collection('products').insertOne({ _id: fixture, businessId: scope.businessId, stock: 50,
      payload: new BSON.Binary(Buffer.alloc(M.TARGET_BYTES + 50)), decimal: BSON.Decimal128.fromString('1.20') });
    await db.collection('forecastmlupdatestates').insertMany([{ ...scope, horizonDays: 7, pending: true, eventCount: 3 },
      { ...scope, scenarioId: 'foreign', horizonDays: 7, eventCount: 99 }]);
    await db.collection('forecastmodelartifacts').insertOne({ ...scope, horizonDays: 7, modelVersion: 4,
      status: 'ACTIVE', artifactBytes: 3, artifactData: new BSON.Binary(Buffer.from('abc')) });
    await db.collection('forecastmodelregistries').insertOne({ ...scope, horizonDays: 7, activeModelVersion: 4, generation: 8 });
    const indexesBefore = await db.collection('products').listIndexes().toArray();
    let checkpoint;
    const runFocus = name => selected(name);
    await t.test('concurrent creation has one owner; manifest captures actual revision and complete tenant scope', { skip: !runFocus('concurrent creation') }, async () => {
      const attempts = await Promise.all([1, 2].map(async attempt => {
        let result;
        try {
          const value = await S.captureLocalCheckpoint({ client, db, localWritersPaused: true });
          result = { attempt, status: 'fulfilled', checkpointId: value?.checkpointId ?? null,
            resetEpoch: value?.resetEpoch == null ? null : String(value.resetEpoch), value };
        } catch (error) {
          result = { attempt, status: 'rejected', ...safeAttemptError(error) };
        }
        const currentControl = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
        result.control = currentControl && { checkpointId: currentControl.activeCheckpointId,
          state: currentControl.state, resetEpoch: currentControl.resetEpoch == null ? null : String(currentControl.resetEpoch) };
        result.state = result.control?.state ?? null;
        result.resetEpoch ??= result.control?.resetEpoch ?? null;
        return result;
      }));
      const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
      if (focus) console.log(JSON.stringify({ concurrentCaptureAttempts: attempts.map(({ value, ...attempt }) => attempt),
        control: control && { checkpointId: control.activeCheckpointId, state: control.state,
          resetEpoch: control.resetEpoch == null ? null : String(control.resetEpoch) } }, null, 2));
      assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(attempts.find(row => row.status === 'rejected')?.code, 'CHECKPOINT_CONTROL_BUSY');
      checkpoint = attempts.find(row => row.status === 'fulfilled')?.value;
      assert(checkpoint, 'concurrent diagnostic: no checkpoint attempt fulfilled');
      assert.equal(checkpoint.status, 'READY'); assert.equal(checkpoint.resetEpoch, '1');
      const row = await db.collection('mltestcheckpoints').findOne({ checkpointId: checkpoint.checkpointId });
      assert.equal(row.dataVersion, '9007199254740993'); assert.equal(row.activeModels[0].modelVersion, 4);
      assert.equal(row.documentCounts.transactions, 1); assert.equal(row.documentCounts.forecastmlupdatestates, 1);
      assert.equal(row.collectionManifest.length, 23); assert.equal(row.documentCounts.mltestcontrols, undefined);
      assert.deepEqual(await db.collection('products').listIndexes().toArray(), indexesBefore);
      assert.equal((await db.collection('mltestcontrols').findOne({ businessId: scope.businessId })).state, 'TEST_ACTIVE');
    });
    await t.test('preflight never inserts, updates, deletes, creates collections or builds indexes', { skip: !runFocus('preflight') }, async () => {
      const commands = []; const listener = event => commands.push(event.commandName);
      client.on('commandStarted', listener);
      let report;
      try { report = await S.preflightCheckpoint({ client, db }); } finally { client.off('commandStarted', listener); }
      assert.equal(report.writes, 0); assert.equal(report.totalBsonBytes, checkpoint.totalBytes);
      assert.equal(report.collections.find(row => row.collection === 'products').estimatedChunks, 2);
      assert.equal(report.cloudRestoreEnabled, false);
      assert(commands.includes('find')); assert(commands.includes('commitTransaction'));
      assert(!commands.some(name => ['insert', 'update', 'delete', 'create', 'createIndexes', 'findAndModify', 'drop'].includes(name)));
    });
    await t.test('snapshot reads remain consistent across collections under an external concurrent write', { skip: !runFocus('snapshot') }, async () => {
      const session = client.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
        await db.collection('transactions').findOne({ _id: 'live' }, { session });
        await db.collection('products').updateOne({ _id: fixture }, { $set: { stock: 47 } });
        assert.equal((await db.collection('products').findOne({ _id: fixture }, { session })).stock, 50);
        await session.commitTransaction();
      } finally { await session.endSession(); }
      await db.collection('products').updateOne({ _id: fixture }, { $set: { stock: 50 } });
    });
    await t.test('corruption cannot remain READY and epoch cannot go backwards through verification', { skip: !runFocus('corruption') }, async () => {
      const row = await db.collection('mltestcheckpointchunks').findOne({ checkpointId: checkpoint.checkpointId });
      const bytes = M.bytesOf(row.payload); bytes[8] ^= 1;
      await db.collection('mltestcheckpointchunks').updateOne({ _id: row._id }, { $set: { payload: bytes } });
      await assert.rejects(S.verifyLocalCheckpoint({ client, db, checkpointId: checkpoint.checkpointId }), { code: 'CHECKPOINT_CHUNK_INVALID' });
      assert.equal((await db.collection('mltestcheckpoints').findOne({ checkpointId: checkpoint.checkpointId })).status, 'FAILED');
      const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
      assert.equal(control.state, 'FAILED'); assert.equal(String(control.resetEpoch), '1');
      // Fixture-only release to prove the next CAS increments the epoch, never restores it.
      await db.collection('mltestcontrols').updateOne({ _id: control._id }, { $set: { state: 'NO_TEST', activeCheckpointId: null } });
      const second = await S.captureLocalCheckpoint({ client, db, localWritersPaused: true });
      assert.equal(second.resetEpoch, '2');
    });
  } finally {
    if (connected && db) { S.assertLocalTarget(client, db); await db.dropDatabase(); }
    await client.close();
  }
});
