'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { BSON, MongoClient } = mongoose.mongo;
const config = require('../../src/config/v3Operational');
const M = require('../../src/services/mlTestCheckpointManifest');
const S = require('../../src/services/mlTestCheckpointService');
const R = require('../../src/services/mlTestRestoreService');
const F = require('../../src/services/mlTestFence');
const models = require('../../src/models');
const scope = M.authorizedScope();
test('local restore: exact BSON, operational cycles, epoch fencing and fail-closed recovery', { timeout: 60000 }, async t => {
  assert(process.env.MONGODB_TEST_URI, 'Use mlTestRestore.run.js');
  const target = new URL(process.env.MONGODB_TEST_URI);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  assert.match(target.pathname, /^\/ml_checkpoint_[a-f0-9]{32}_test$/);
  let client, db;
  try {
    await mongoose.connect(target.href, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 4000 });
    client = mongoose.connection.getClient(); db = mongoose.connection.db;
    await S.provisionLocal(client, db);
    for (const { collection } of M.COLLECTIONS) await db.createCollection(collection);
    const p1 = new BSON.ObjectId(), p2 = new BSON.ObjectId(), vendor = new BSON.ObjectId();
    await db.collection('historicalscenarios').insertOne({ ...scope, status: 'completed', sourceSha256: config.sourceSha256,
      metadata: { datasetVersion: config.datasetVersion, referenceDate: config.historicalCutoff, timezone: config.timezone } });
    await db.collection('v3operationalrevisions').insertOne({ _id: scope.businessId, revision: BSON.Long.fromNumber(83),
      bootstrapStatus: 'VERIFIED', historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256 });
    await db.collection('contacts').insertOne({ _id: vendor, businessId: scope.businessId, type: 'vendor',
      name: 'Local supplier', isActive: true });
    for (const [_id, stock, sku] of [[p1, 50, 'LOCAL-01'], [p2, 20, 'LOCAL-02']]) {
      await db.collection('products').insertOne({ _id, businessId: scope.businessId, sku, name: sku,
        stock, minStockLevel: 0, price: 2, costPrice: 1, currency: 'USD', category: 'Local', isActive: true,
        supplierPrices: [{ supplierId: vendor, purchasePrice: 1 }],
        canonicalData: { long: BSON.Long.fromString('9007199254740993'), decimal: BSON.Decimal128.fromString('1.20'),
          binary: new BSON.Binary(Buffer.from('payload'), 128), date: new Date('2026-10-01T00:00:00Z') } });
      await db.collection('inventorymovements').insertOne({ businessId: scope.businessId, productId: _id,
        type: 'opening', quantityDelta: stock, stockBefore: 0, stockAfter: stock,
        occurredAt: new Date('2026-10-01T00:00:00Z'), source: 'historical_import', scenarioId: null });
    }
    await db.collection('products').insertOne({ _id: new BSON.ObjectId(), businessId: 'foreign', stock: 999 });
    for (const horizonDays of [7, 14]) {
      await db.collection('forecastmodelartifacts').insertOne({ ...scope, horizonDays, modelVersion: 1,
        status: 'ACTIVE', artifactData: new BSON.Binary(Buffer.from(`v1-${horizonDays}`)), artifactBytes: 4,
        artifactHash: M.digest(Buffer.from(`v1-${horizonDays}`)), trainedDataVersion: BSON.Long.fromNumber(83), dataCutoff: '2026-10-15' });
      await db.collection('forecastmodelregistries').insertOne({ ...scope, horizonDays, activeModelVersion: 1,
        generation: 4, lastIssuedModelVersion: 1 });
      await db.collection('forecastmlupdateevents').insertMany(Array.from({ length: 90 }, (_, n) => ({ ...scope,
        horizonDays, eventKey: `initial-${horizonDays}-${n}`, dataVersion: BSON.Long.fromNumber(83) })));
    }
    await t.test('NO_TEST preserves ordinary mutations without requiring a test context', async () => {
      await db.collection('mltestcontrols').insertOne({ businessId: scope.businessId, state: 'NO_TEST',
        resetEpoch: BSON.Long.ZERO, activeCheckpointId: null, testCycleId: null });
      assert.equal((await models.Product.updateOne({ _id: p1, businessId: scope.businessId }, { $set: { price: 2 } })).matchedCount, 1);
      assert.equal(await F.externalAllowed(db), true);
    });
    const checkpoint = await S.captureLocalCheckpoint({ client, db, localWritersPaused: true });
    const restore = options => R.restoreLocalCheckpoint({ client, db, checkpointId: checkpoint.checkpointId,
      branch: 'NORMAL', restoreId: randomUUID(), ...options });
    const transaction = async (work, expected) => F.withEpoch(db, async () => {
      const session = await mongoose.startSession();
      try { return await session.withTransaction(async () => { await F.guard({ db, session }); return work(session); }); }
      finally { await session.endSession(); }
    }, expected);
    const stock = id => db.collection('products').findOne({ _id: id }).then(row => row.stock);
    const reconcile = async () => {
      for (const id of [p1, p2]) {
        const rows = await db.collection('inventorymovements').find({ businessId: scope.businessId, productId: id }).toArray();
        assert.equal(rows.reduce((sum, row) => sum + row.quantityDelta, 0), await stock(id));
      }
    };
    await t.test('real sale x3 -> exact restore, revision, LIVE null scenario and ledger', async () => {
      const sale = await require('../../src/services/transactionWriteService').writeTransaction({ businessId: scope.businessId,
        input: { type: 'sale', currency: 'USD', paymentMethod: 'cash', products: [{ productId: p1, quantity: 3 }] } });
      assert.equal(await stock(p1), 47);
      assert.equal((await db.collection('v3operationalrevisions').findOne({ _id: scope.businessId })).revision, 84);
      assert.equal(sale.transaction.scenarioId, null);
      await reconcile();
      await restore();
      assert.equal(await stock(p1), 50);
      assert.equal(await db.collection('transactions').countDocuments({ businessId: scope.businessId }), 0);
      await reconcile();
    });
    await t.test('real purchase +10 -> exact restore and ledger', async () => {
      await require('../../src/services/transactionWriteService').writeTransaction({ businessId: scope.businessId,
        input: { type: 'purchase', vendorId: vendor, currency: 'USD', paymentMethod: 'cash', products: [{ productId: p2, quantity: 10 }] } });
      assert.equal(await stock(p2), 30); await reconcile();
      await restore(); assert.equal(await stock(p2), 20); await reconcile();
    });
    await t.test('real deferred receipt +10 -> exact restore of stock, order, receipt, journal and ledger', async () => {
      const orderedAt = new Date(Date.now() - 60000);
      let purchase;
      await transaction(async session => {
        [purchase] = await models.Transaction.create([{ businessId: scope.businessId, type: 'purchase', status: 'pending',
          vendorId: vendor, vendorName: 'Local supplier', supplierId: vendor, currency: 'USD', totalAmount: 10,
          date: orderedAt, scenarioId: null,
          products: [{ productId: p2, productName: 'LOCAL-02', quantity: 10, price: 1, costPrice: 1, total: 10 }],
          purchaseLifecycle: { fulfillmentMode: 'DEFERRED', orderedAtUtc: orderedAt, receiptState: 'NONE', receipts: [] }
        }], { session });
      });
      await require('../../src/services/v3PurchaseReceiptService').receiveV3Purchase({ businessId: scope.businessId,
        purchaseId: purchase._id, receiptKey: 'local-receipt-001', receivedAtUtc: new Date() });
      assert.equal(await stock(p2), 30); await reconcile();
      await restore(); assert.equal(await stock(p2), 20); await reconcile();
      assert.equal(await db.collection('transactions').countDocuments({ _id: purchase._id }), 0);
    });
    await t.test('simulated v1 -> v2 -> exact v1 artifacts, registry generation, jobs, executions and state', async () => {
      await transaction(async session => {
        await db.collection('forecastmodelartifacts').updateMany(scope, { $set: { status: 'SUPERSEDED' } }, { session });
        for (const horizonDays of [7, 14]) {
          await db.collection('forecastmodelartifacts').insertOne({ ...scope, horizonDays, modelVersion: 2,
            status: 'ACTIVE', artifactData: new BSON.Binary(Buffer.from('different v2')) }, { session });
          await db.collection('forecastmodelregistries').updateOne({ ...scope, horizonDays },
            { $set: { activeModelVersion: 2, generation: 5, lastIssuedModelVersion: 2 } }, { session });
        }
        for (const collection of ['forecasttrainingjobs', 'forecastmlupdateexecutions', 'forecastmlupdatestates'])
          await db.collection(collection).insertOne({ ...scope, executionId: 'local-v2', status: 'PROMOTED' }, { session });
      });
      await restore({ branch: 'SHIFT' });
      for (const row of await db.collection('forecastmodelregistries').find(scope).toArray()) {
        assert.equal(row.activeModelVersion, 1); assert.equal(row.generation, 4); assert.equal(row.lastIssuedModelVersion, 1);
      }
      assert.equal(await db.collection('forecastmodelartifacts').countDocuments({ ...scope, status: 'ACTIVE' }), 2);
    });
    await t.test('initial signals N=180 -> N exactly, never zero', async () => {
      await transaction(session => db.collection('forecastmlupdateevents').insertOne({ ...scope, horizonDays: 7, eventKey: 'extra' }, { session }));
      await restore(); assert.equal(await db.collection('forecastmlupdateevents').countDocuments(scope), 180);
      for (const horizonDays of [7, 14]) assert.equal(await db.collection('forecastmlupdateevents').countDocuments({ ...scope, horizonDays }), 90);
    });
    await t.test('created document disappears, modified returns and deleted reappears with exact BSON', async () => {
      await transaction(async session => {
        await models.Product.updateOne({ _id: p1, businessId: scope.businessId }, { $set: { stock: 5 } }, { session });
        await models.Product.deleteOne({ _id: p2, businessId: scope.businessId }, { session });
        await db.collection('contacts').insertOne({ businessId: scope.businessId, name: 'temporary' }, { session });
      });
      await restore({ branch: 'OUTLIER' }); assert.equal(await stock(p1), 50); assert.equal(await stock(p2), 20);
      assert.equal(await db.collection('contacts').countDocuments({ businessId: scope.businessId }), 1);
    });
    const stale = await F.capture(db);
    const cacheBefore = await F.cacheIdentity();
    await restore();
    for (const [label, model, filter] of [
      ['stale worker artifact persistence', models.ForecastModelArtifact, { ...scope, horizonDays: 7 }],
      ['late ACK', models.ForecastMlUpdateState, { ...scope, horizonDays: 7 }],
      ['late promotion', models.ForecastModelRegistry, { ...scope, horizonDays: 7 }],
      ['late execution FINISHED/FAILED', models.ForecastMlUpdateExecution, scope]]) {
      await t.test(`${label} rejects old epoch without changing any source document`, async () => {
        await assert.rejects(transaction(session => model.updateOne(filter, { $set: { updatedAt: new Date() } }, { session }), stale),
          { code: 'STALE_TEST_EPOCH' });
      });
    }
    await t.test('commercial writer during RESTORING is blocked; cache generation changes', async () => {
      await restore({ afterCollection: async collection => {
        if (collection !== 'products') return;
        await assert.rejects(transaction(session => models.Product.updateOne({ _id: p1 }, { $set: { stock: 0 } }, { session })),
          { code: 'TEST_RESTORE_BLOCKED' });
      } });
      assert.notEqual(await F.cacheIdentity(), cacheBefore);
    });
    await t.test('transaction pinned before reset cannot pass its final epoch write after reset', async () => {
      const expected = await F.capture(db), session = client.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' } });
        await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { session });
        await restore();
        await assert.rejects(F.withEpoch(db, () => F.guard({ db, session }), expected), { code: 'STALE_TEST_EPOCH' });
      } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
    });
    await t.test('test mutations without a captured cycle or without transaction fail closed', async () => {
      await assert.rejects(models.Product.updateOne({ _id: p1 }, { $set: { stock: 0 } }), { code: 'TEST_EPOCH_CONTEXT_REQUIRED' });
      await assert.rejects(F.withEpoch(db, () => models.Product.updateOne({ _id: p1 }, { $set: { stock: 0 } })),
        { code: 'TEST_TRANSACTION_REQUIRED' });
      await F.withEpoch(db, async () => {
        await assert.rejects(async () => F.runCycle(async () => {}, stale), { code: 'STALE_TEST_EPOCH' });
      });
    });
    await t.test('bulk writes are fenced and changing a document tenant cannot bypass its original scope', async () => {
      const doc = await models.Product.findById(p1); doc.businessId = 'foreign';
      await assert.rejects(doc.save(), { code: 'TEST_EPOCH_CONTEXT_REQUIRED' });
      await assert.rejects(F.withEpoch(db, async () => await models.Product.bulkWrite([
        { updateOne: { filter: { _id: p1, businessId: scope.businessId }, update: { $set: { stock: 0 } } } }
      ]), stale), { code: 'STALE_TEST_EPOCH' });
      await transaction(session => models.Product.bulkWrite([
        { updateOne: { filter: { _id: p1, businessId: scope.businessId }, update: { $set: { stock: 49 } } } }
      ], { session }));
      await restore(); assert.equal(await stock(p1), 50);
    });
    await t.test('second same restoreId is idempotent and does not increment epoch or archive twice', async () => {
      const restoreId = randomUUID(); const first = await restore({ restoreId });
      const archives = await db.collection('mltestbrancharchives').countDocuments({ restoreId });
      const second = await restore({ restoreId });
      assert.equal(second.idempotent, true); assert.equal(second.resetEpoch, first.resetEpoch);
      assert.equal(await db.collection('mltestbrancharchives').countDocuments({ restoreId }), archives);
    });
    await t.test('interrupted restore fails closed and explicit resume uses the same epoch', async () => {
      const restoreId = randomUUID();
      await assert.rejects(restore({ restoreId, afterCollection: async collection => {
        if (collection === 'products') throw new Error('simulated interruption');
      } }), { code: 'RESTORE_OPERATION_FAILED' });
      const failed = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
      assert.equal(failed.state, 'FAILED');
      await assert.rejects(transaction(async () => {}), { code: 'TEST_RESTORE_BLOCKED' });
      const resumed = await restore({ restoreId }); assert.equal(resumed.resetEpoch, String(failed.resetEpoch));
    });
    await t.test('foreign tenant stays intact; clock-derived watermark is not restored', async () => {
      assert.equal((await db.collection('products').findOne({ businessId: 'foreign' })).stock, 999);
      const C = require('../../src/services/forecastMlUpdateCoordinator');
      assert.notEqual(C.watermark(new Date('2026-10-18T18:00:00Z')), C.watermark(new Date('2026-10-20T18:00:00Z')));
      await reconcile();
    });
    await t.test('NORMAL/OUTLIER/SHIFT branch evidence survives restore outside the snapshot allowlist', async () => {
      const rows = await db.collection('mltestbrancharchives').find(scope).toArray();
      assert.deepEqual([...new Set(rows.map(row => row.branch))].sort(), ['NORMAL', 'OUTLIER', 'SHIFT']);
      for (const row of rows) {
        assert.equal(row.checkpointId, checkpoint.checkpointId); assert(row.testCycleId);
        assert.equal(row.dataVersionBefore, '83'); assert(row.summary.documentCountDelta.products);
      }
      assert(!M.COLLECTIONS.some(row => row.collection === 'mltestbrancharchives'));
    });
    await t.test('test mode suppresses Telegram/webhook/outbox/channel/GitHub before network or claim', async () => {
      assert.equal(await F.externalAllowed(db), false);
      assert.equal((await require('../../src/services/telegramService').sendMessage('local', 'fixture')).suppressed, true);
      assert.equal((await require('../../src/services/webhookService').notifyNodeRed('fixture')).reason, 'ML_TEST_MODE');
      assert.equal((await require('../../src/services/inventoryAlertOutbox').createInventoryAlertDispatcher({
        repo: { claim: () => { throw new Error('must not claim'); } } }).run()).suppressed, true);
      assert.equal((await require('../../src/services/inventoryAlertChannels').createInventoryAlertChannels().processPendingEvent('fixture')).status, 'SUPPRESSED');
      assert.equal(await require('../../src/services/forecastManualUpdateService').createWorkflowDispatcher({
        fetchImpl: () => { throw new Error('must not fetch'); } })({}), 'DEFERRED');
    });
    await t.test('corrupt hash cannot begin restore; no source document is deleted and epoch does not change', async () => {
      const before = await F.capture(db);
      const chunk = await db.collection('mltestcheckpointchunks').findOne({ checkpointId: checkpoint.checkpointId, collection: 'products' });
      const payload = M.bytesOf(chunk.payload); payload[10] ^= 1;
      await db.collection('mltestcheckpointchunks').updateOne({ _id: chunk._id }, { $set: { payload } });
      await assert.rejects(restore(), { code: 'CHECKPOINT_CHUNK_INVALID' });
      assert.equal((await F.capture(db)).resetEpoch, before.resetEpoch); assert.equal(await stock(p1), 50);
    });
  } finally {
    if (db) { S.assertLocalTarget(client, db); await db.dropDatabase(); }
    await mongoose.disconnect();
  }
});
