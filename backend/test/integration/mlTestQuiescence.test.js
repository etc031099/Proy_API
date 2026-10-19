'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const S = require('../../src/services/mlTestCheckpointService');
const M = require('../../src/services/mlTestCheckpointManifest');
const F = require('../../src/services/mlTestFence');
const R = require('../../src/services/mlTestRestoreService');
const A = require('../../src/services/mlTestAdminExecutor');
const access = require('../../src/services/mlTestAccess');
const config = require('../../src/config/v3Operational');
const scope = M.authorizedScope();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const admin = { _id: 'local-admin', role: 'admin', isActive: true, businessId: scope.businessId };
async function waitFor(db, state) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
    if (control?.state === state) return control;
    await delay(10);
  }
  assert.fail(`control did not reach ${state}`);
}

test('operative checkpoint drains durable writers and excludes concurrent admission (local replica set)', { timeout: 30000 }, async t => {
  let db, client, secondClient, unblock;
  try {
    await mongoose.connect(process.env.MONGODB_TEST_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 4000 });
    db = mongoose.connection.db; client = mongoose.connection.getClient(); S.assertLocalTarget(client, db);
    await S.provisionLocal(client, db);
    for (const { collection } of M.COLLECTIONS) await db.createCollection(collection);
    await db.collection('v3operationalrevisions').insertOne({ _id: scope.businessId, revision: mongoose.mongo.BSON.Long.fromNumber(173) });
    const productId = new mongoose.mongo.BSON.ObjectId();
    await db.collection('products').insertOne({ _id: productId, businessId: scope.businessId, stock: 8 });
    await t.test('first production mutation initializes admission without changing epoch or losing outer identity', async () => {
      const absent = await F.capture(db); assert.equal(absent.present, false);
      await F.withEpoch(db, async () => {
        await F.runCycle(async () => assert.equal(F.current().present, true));
        assert.equal(F.current().present, true); assert.equal(F.current().resetEpoch, '0');
        assert.equal(F.current().testCycleId, null);
      }, absent);
      assert.deepEqual((await db.collection('mltestcontrols').findOne({})).activeWriterIds, []);
    });
    await t.test('standalone NO_TEST save/create/query/insertMany/bulkWrite keep their contract and release admission on error', async () => {
      const Product = require('../../src/models/Product');
      const base = { businessId: scope.businessId, name: 'Synthetic automatic admission', category: 'Local', price: 2, stock: 1 };
      const doc = await Product.create({ ...base, sku: 'AUTO-01' });
      doc.stock = 2; await doc.save();
      const inserted = await Product.insertMany([{ ...base, sku: 'AUTO-02' }]);
      await Product.bulkWrite([{ updateOne: { filter: { _id: doc._id }, update: { $set: { stock: 3 } } } }]);
      assert.equal((await Product.updateOne({ _id: doc._id }, { $set: { stock: 4 } })).matchedCount, 1);
      await assert.rejects(Product.updateOne({ _id: doc._id }, { $set: { stock: 'INVALID_NUMBER' } }));
      assert.equal((await Product.findById(doc._id).lean()).stock, 4);
      assert.deepEqual((await db.collection('mltestcontrols').findOne({})).activeWriterIds, []);
      await Product.deleteMany({ _id: { $in: [doc._id, inserted[0]._id] } });
    });
    await t.test('already-visible training work rejects capture before maintenance or epoch changes', async () => {
      const job = await db.collection('forecasttrainingjobs').insertOne({ ...scope, status: 'TRAINING' });
      try {
        await assert.rejects(S.captureOperationalCheckpoint({ client, db, scope }), { code: 'CHECKPOINT_SOURCE_BUSY' });
        const status = await F.capture(db);
        assert.equal(status.state, 'NO_TEST'); assert.equal(status.resetEpoch, '0');
        assert.equal(await db.collection('mltestcheckpoints').countDocuments({}), 0);
      } finally { await db.collection('forecasttrainingjobs').deleteOne({ _id: job.insertedId }); }
    });
    secondClient = await new mongoose.mongo.MongoClient(process.env.MONGODB_TEST_URI).connect();
    const remoteDb = secondClient.db(db.databaseName);
    const executor = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION' });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const writer = F.withWriter(remoteDb, async () => {
      started(); await new Promise(resolve => { unblock = resolve; });
      await assert.rejects(F.guard({ db: remoteDb }), { code: 'STALE_TEST_EPOCH' });
    });
    await entered;
    const capture = S.captureOperationalCheckpoint({ client, db, scope });
    await waitFor(db, 'CHECKPOINT_CREATING');
    let checkpoint;
    await t.test('admitted writer is still durable; no snapshot starts until it drains', async () => {
      assert.equal(await db.collection('mltestcheckpoints').countDocuments({}), 0);
      const status = await executor.execute({ user: admin, body: {}, query: {} }, 'STATUS');
      assert.equal(status.state, 'CHECKPOINT_CREATING'); assert.equal(status.quiescence.activeWriterCount, 1);
      assert.equal(status.quiescence.admissionClosed, true); assert.equal(status.quiescence.writersPaused, false);
    });
    await t.test('new writers and a second checkpoint owner are rejected', async () => {
      await assert.rejects(F.withWriter(remoteDb, () => assert.fail('writer must not enter')), { code: 'TEST_RESTORE_BLOCKED' });
      await assert.rejects(S.captureOperationalCheckpoint({ client, db, scope }), { code: 'CHECKPOINT_CONTROL_BUSY' });
      const denied = [];
      const res = { status(value) { denied.push(value); return this; }, set() { return this; }, json() { return this; } };
      await access.maintenanceGuard({ user: admin, method: 'POST', originalUrl: '/api/products' }, res,
        () => assert.fail('mutation must not pass maintenance'), db);
      assert.deepEqual(denied, [503]);
      for (const url of ['/api/ml-test/status', '/api/ml-test/restore', '/api/ml-test/recover-failed-checkpoint']) {
        let allowed = false;
        await access.maintenanceGuard({ user: admin, originalUrl: url }, res, () => { allowed = true; }, db);
        assert.equal(allowed, true);
      }
    });
    await t.test('another tenant can still complete an ordinary sale without entering the demo fence', async () => {
      const foreignId = new mongoose.mongo.BSON.ObjectId();
      await db.collection('products').insertOne({ _id: foreignId, businessId: 'FOREIGN', sku: 'FOREIGN', name: 'Synthetic',
        stock: 10, price: 2, costPrice: 1, minStockLevel: 0, currency: 'USD', category: 'Local', isActive: true });
      await require('../../src/services/transactionWriteService').writeTransaction({ businessId: 'FOREIGN',
        input: { type: 'sale', currency: 'USD', paymentMethod: 'cash', products: [{ productId: foreignId, quantity: 1 }] } });
      assert.equal((await db.collection('products').findOne({ _id: foreignId })).stock, 9);
      assert.equal((await db.collection('mltestcontrols').findOne({ businessId: scope.businessId })).activeWriterIds.length, 1);
    });
    unblock(); await writer; checkpoint = await capture;
    await t.test('drained snapshot is READY and TEST_ACTIVE, with monotonic epoch and no writer slots', async () => {
      assert.equal(checkpoint.status, 'READY');
      const control = await waitFor(db, 'TEST_ACTIVE');
      assert.equal(String(control.resetEpoch), '1'); assert.deepEqual(control.activeWriterIds, []);
      assert.equal(control.activeCheckpointId, checkpoint.checkpointId);
    });
    await t.test('restore-and-finish remains usable; a fresh writer can be admitted afterwards', async () => {
      const restored = await R.restoreLocalCheckpoint({ client, db, scope, checkpointId: checkpoint.checkpointId,
        restoreId: randomUUID(), branch: 'NORMAL', finish: true });
      assert.equal(restored.status, 'NO_TEST');
      await F.withWriter(remoteDb, () => F.guard({ db: remoteDb }));
      assert.deepEqual((await remoteDb.collection('mltestcontrols').findOne({})).activeWriterIds, []);
    });
    await t.test('capture failure remains FAILED; retries cannot reopen writers or restore an uncertified source', async () => {
      const original = db.collection.bind(db);
      const wrapped = Object.create(db);
      wrapped.collection = name => {
        const collection = original(name);
        if (name === 'mltestcheckpointchunks') collection.insertOne = async () => { throw new Error('PRIVATE_FAILURE'); };
        return collection;
      };
      await assert.rejects(S.captureOperationalCheckpoint({ client, db: wrapped, scope }));
      const failed = await waitFor(db, 'FAILED');
      assert.deepEqual(failed.activeWriterIds, []);
      await assert.rejects(F.withWriter(remoteDb, () => assert.fail('must stay blocked')), { code: 'TEST_RESTORE_BLOCKED' });
      await assert.rejects(S.captureOperationalCheckpoint({ client, db, scope }), { code: 'CHECKPOINT_CONTROL_BUSY' });
      assert.equal((await F.capture(db)).state, 'FAILED');
      assert.equal(await F.externalAllowed(db), false);
    });
  } finally {
    unblock?.();
    if (secondClient) await secondClient.close();
    if (db) { S.assertLocalTarget(client, db); await db.dropDatabase(); }
    await mongoose.disconnect();
  }
});

test('real authenticated HTTP admission drains response lifetime without counting admin CREATE itself', { timeout: 15000 }, async () => {
  const express = require('express');
  const { authenticate } = require('../../src/middleware/auth');
  const { createMlTestAdminRoutes } = require('../../src/routes/mlTestAdmin');
  const uri = new URL(process.env.MONGODB_TEST_URI);
  uri.pathname = `/ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`;
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID(); // Synthetic, local test identity only.
  let db, client, server, releaseWriter;
  try {
    await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false });
    db = mongoose.connection.db; client = mongoose.connection.getClient(); S.assertLocalTarget(client, db);
    await S.provisionLocal(client, db);
    for (const { collection } of M.COLLECTIONS) await db.createCollection(collection);
    await db.collection('v3operationalrevisions').insertOne({ _id: scope.businessId, revision: mongoose.mongo.BSON.Long.ONE });
    const userId = new mongoose.mongo.BSON.ObjectId();
    await db.collection('users').insertOne({ ...admin, _id: userId });
    const token = require('../../src/utils/jwt').generateToken({ id: userId.toString() });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const executor = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION' });
    const app = express(); app.use(express.json());
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    app.post('/api/products', authenticate, async (_req, res) => {
      assert(F.current()?.writer); entered();
      await new Promise(resolve => { releaseWriter = resolve; });
      res.json({ finished: true });
    });
    app.use('/api/ml-test', createMlTestAdminRoutes({ getExecutor: () => ({
      execute: (req, action) => action === 'CREATE'
        ? S.captureOperationalCheckpoint({ client, db, scope, createdBy: String(req.user._id) })
        : executor.execute(req, action)
    }) }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const writer = fetch(`${base}/api/products`, { method: 'POST', headers, body: '{}' });
    await started;
    const capture = fetch(`${base}/api/ml-test/checkpoint`, { method: 'POST', headers, body: '{}' });
    await waitFor(db, 'CHECKPOINT_CREATING');
    assert.equal((await fetch(`${base}/api/products`, { method: 'POST', headers, body: '{}' })).status, 503);
    const pending = await fetch(`${base}/api/ml-test/status`, { headers });
    assert.equal(pending.status, 200);
    assert.equal((await pending.json()).data.quiescence.activeWriterCount, 1);
    const recovery = await fetch(`${base}/api/ml-test/restore`, { method: 'POST', headers, body: '{"mode":"finish"}' });
    assert.equal(recovery.status, 409); // Reachable, but no READY source yet.
    const abort = await fetch(`${base}/api/ml-test/recover-failed-checkpoint`, { method: 'POST', headers, body: '{}' });
    assert.equal(abort.status, 409); // Reachable, but CHECKPOINT_CREATING cannot be abandoned.
    releaseWriter(); assert.equal((await writer).status, 200);
    const captured = await capture; assert.equal(captured.status, 201);
    const ready = (await captured.json()).data;
    assert.equal(ready.state, 'TEST_ACTIVE'); assert.equal(ready.quiescence.activeWriterCount, 0);
    assert.equal((await fetch(`${base}/api/ml-test/restore`, { method: 'POST', headers, body: '{"mode":"finish"}' })).status, 200);
    assert.equal((await F.capture(db)).state, 'NO_TEST');
  } finally {
    releaseWriter?.();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (db) { S.assertLocalTarget(client, db); await db.dropDatabase(); }
    await mongoose.disconnect();
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  }
});

