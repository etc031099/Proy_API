'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const mongoose = require('mongoose');
const path = require('node:path');
const { Product, Transaction, InventoryMovement, HistoricalScenario, V3OperationalRevision, V3OperationalChange } = require('../../src/models');
const StockAlertRule = require('../../src/models/StockAlertRule');
const { config, bootstrapV3OperationalRevision, getDataVersion, recordV3ProductChange, buildV3OperationalSnapshot } = require('../../src/services/v3OperationalSnapshotService');

const uri = process.env.MONGODB_TEST_URI;
const TEST_DATABASE = 'inventory_billing_m6_9f2_test';

function loadSnapshotServiceForBusiness(businessId) {
  const servicePath = require.resolve('../../src/services/v3OperationalSnapshotService');
  const isolatedModule = new Module(servicePath, module);
  isolatedModule.filename = servicePath;
  isolatedModule.paths = Module._nodeModulePaths(path.dirname(servicePath));
  const originalLoad = Module._load;
  Module._load = function loadBusinessScopedV3Config(request, parent, isMain) {
    if (request === '../config/v3Operational' && parent?.filename === servicePath) {
      return Object.freeze({ ...config, businessId });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    isolatedModule._compile(fs.readFileSync(servicePath, 'utf8'), servicePath);
  } finally {
    Module._load = originalLoad;
  }
  return isolatedModule.exports;
}

test('F.2 revision, rollback, tenant isolation, and snapshot on local replica set', { skip: !uri }, async t => {
  const parsedUri = new URL(uri);
  assert.equal(parsedUri.protocol, 'mongodb:');
  assert.equal(parsedUri.hostname, '127.0.0.1');
  assert.equal(parsedUri.port || '27017', '27017');
  assert.equal(parsedUri.searchParams.get('directConnection'), 'true');
  assert.equal(parsedUri.searchParams.has('replicaSet'), false);
  assert.equal(parsedUri.pathname, `/${TEST_DATABASE}`);
  try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, directConnection: true });
  const dbName = mongoose.connection.name;
  if (dbName !== TEST_DATABASE) throw new Error('Refusing V3 operational integration test outside its exact dedicated test database.');
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
  await Promise.all([Product.init(), Transaction.init(), InventoryMovement.init(), HistoricalScenario.init(),
    V3OperationalRevision.init(), V3OperationalChange.init(), StockAlertRule.init()]);
  const existing = await Promise.all([
    HistoricalScenario.countDocuments({ businessId: config.businessId }),
    V3OperationalRevision.countDocuments({ _id: config.businessId }),
    V3OperationalChange.countDocuments({ businessId: config.businessId }),
    Product.countDocuments({ businessId: config.businessId }),
    Transaction.countDocuments({ businessId: config.businessId }),
    InventoryMovement.countDocuments({ businessId: config.businessId })
  ]);
  assert.deepEqual(existing, [0, 0, 0, 0, 0, 0], 'V3 fixture IDs are intentionally reserved; use an empty dedicated test database.');

  const revisionIndexes = await mongoose.connection.db.collection(V3OperationalRevision.collection.name).listIndexes().toArray();
  assert(revisionIndexes.some(index => index.name === '_id_' && index.key._id === 1), 'revision primary key index exists in Mongo');
  const changeIndexes = await mongoose.connection.db.collection(V3OperationalChange.collection.name).listIndexes().toArray();
  assert(changeIndexes.some(index => index.name === 'v3_operational_change_revision_ordinal_uq'
    && index.unique === true && JSON.stringify(index.key) === JSON.stringify({ businessId: 1, revision: 1, eventOrdinal: 1 })));
  assert(changeIndexes.some(index => index.name === 'v3_operational_change_asof'
    && JSON.stringify(index.key) === JSON.stringify({ businessId: 1, effectiveAtUtc: 1, revision: 1 })));
  await HistoricalScenario.create({ businessId: config.businessId, scenarioId: config.scenarioId,
    sourceSha256: config.sourceSha256, status: 'completed', metadata: { datasetVersion: config.datasetVersion,
      referenceDate: config.historicalCutoff, timezone: config.timezone } });

    const version0 = await bootstrapV3OperationalRevision({ businessId: config.businessId, attestNoUnjournaledBaseCatalogChanges: true });
    assert.equal(String(version0.revision), '0');
    assert.equal(version0.bootstrapStatus, 'VERIFIED');
    assert.equal(await getDataVersion(config.businessId), '0');
    await assert.rejects(V3OperationalRevision.create({ _id: config.businessId, revision: 0n,
      bootstrapStatus: 'VERIFIED', historicalDatasetVersion: config.datasetVersion,
      historicalDatasetSha256: config.sourceSha256 }), error => error.code === 11000,
    'the revision identity is unique in the live Mongo index');

    const businessB = 'MINIMARKET-PASCO-V3-ISOLATION-TEST';
    const businessBService = loadSnapshotServiceForBusiness(businessB);
    await HistoricalScenario.create({ businessId: businessB, scenarioId: config.scenarioId,
      sourceSha256: config.sourceSha256, status: 'completed', metadata: { datasetVersion: config.datasetVersion,
        referenceDate: config.historicalCutoff, timezone: config.timezone } });
    const businessBRevision0 = await businessBService.bootstrapV3OperationalRevision({ businessId: businessB });
    assert.equal(String(businessBRevision0.revision), '0');
    assert.equal(await businessBService.getDataVersion(businessB), '0');

    const session1 = await mongoose.startSession();
    let productId;
    const productSku = `F2-${Date.now()}`;
    try {
      session1.startTransaction({ writeConcern: { w: 'majority' } });
      const [product] = await Product.create([{ businessId: config.businessId, name: 'F2 test item', sku: productSku,
        price: 2, currency: 'PEN', costPrice: 1, category: 'Test', stock: 5 }], { session: session1 });
      productId = product._id;
      const [openingMovement] = await InventoryMovement.create([{
        businessId: config.businessId, productId, type: 'opening', quantityDelta: 5,
        stockBefore: 0, stockAfter: 5, occurredAt: new Date(), source: 'api'
      }], { session: session1 });
      await recordV3ProductChange({ businessId: config.businessId, session: session1, after: product, operation: 'CREATE',
        extraChanges: [{ entityType: 'movement', entityKey: String(openingMovement._id), operation: 'ADJUST',
          projection: { quantityDelta: 5, stockBefore: 0, stockAfter: 5 } }] });
      assert.equal(await getDataVersion(config.businessId, { session: session1 }), '1');
      await session1.commitTransaction();
    } catch (error) { if (session1.inTransaction()) await session1.abortTransaction(); throw error; }
    finally { await session1.endSession(); }

    assert.equal(await getDataVersion(config.businessId), '1');
    assert.equal(await businessBService.getDataVersion(businessB), '0');
    assert.equal(await V3OperationalChange.countDocuments({ businessId: config.businessId, revision: 1n }), 2);

    const externalApi = require('../../src/services/externalApiService');
    t.mock.method(externalApi, 'getExchangeRate', async () => ({ rate: 1 }));
    const { writeTransaction } = require('../../src/services/transactionWriteService');
    const executeSale = (quantity = 1) => writeTransaction({ businessId: config.businessId, input: {
      type: 'sale', paymentMethod: 'cash', currency: 'PEN',
      products: [{ productId: String(productId), quantity }]
    } });
    const sale1 = await executeSale();
    assert.equal(String(sale1.transaction.products[0].quantity), '1');
    assert.equal(await getDataVersion(config.businessId), '2');
    assert.equal(await businessBService.getDataVersion(businessB), '0');
    assert.equal(await V3OperationalChange.countDocuments({ businessId: config.businessId, revision: 2n }), 1,
      'sale header, line, and inventory movement share one logical revision');
    assert.equal(await Transaction.countDocuments({ businessId: config.businessId, type: 'sale' }), 1);
    assert.equal(await InventoryMovement.countDocuments({ businessId: config.businessId, productId }), 2);

    const sale2 = await executeSale();
    assert(sale2.transaction);
    assert.equal(await getDataVersion(config.businessId), '3');
    assert.equal(await businessBService.getDataVersion(businessB), '0');
    assert.equal(await V3OperationalChange.countDocuments({ businessId: config.businessId, revision: 3n }), 1);
    assert.equal(await Transaction.countDocuments({ businessId: config.businessId, type: 'sale' }), 2);
    assert.equal(await InventoryMovement.countDocuments({ businessId: config.businessId, productId }), 3);
    await assert.rejects(executeSale(4), /Insufficient stock/);
    assert.equal(await getDataVersion(config.businessId), '3', 'invalid write does not advance the revision');
    assert.equal(await Transaction.countDocuments({ businessId: config.businessId, type: 'sale' }), 2);
    assert.equal(await InventoryMovement.countDocuments({ businessId: config.businessId, productId }), 3);
    const captureTime = new Date(Date.now() + 1000);
    const asOfDate = require('../../src/services/v3OperationalSnapshotService').limaDate(captureTime);
    const snapshot1 = await buildV3OperationalSnapshot({ businessId: config.businessId, asOfDate, now: captureTime, minimumDataVersion: '3' });
    const snapshot2 = await buildV3OperationalSnapshot({ businessId: config.businessId, asOfDate, now: captureTime, minimumDataVersion: '3' });
    assert.equal(snapshot1.mode, 'LIVE');
    assert.equal(snapshot1.dataVersion, '3');
    assert.equal(snapshot1.snapshot.metadata.historicalCutoff, '2026-10-12');
    assert.equal(snapshot1.snapshot.metadata.deltaStart, '2026-10-13');
    assert.equal(snapshot1.snapshot.metadata.timezone, 'America/Lima');
    assert.equal(snapshot1.snapshot.metadata.asOfDate, asOfDate);
    assert.equal(snapshot1.snapshot.metadata.payloadBytes <= config.maxPayloadBytes, true);
    assert.equal(snapshot1.snapshot.metadata.snapshotHash, snapshot2.snapshot.metadata.snapshotHash);
    assert.equal(snapshot1.snapshot.stockStates[0].onHand, 3);
    assert.equal(snapshot1.snapshot.sales.length, 2);
    assert.equal(snapshot1.snapshot.closedSalesDays.every(row => row.localDate <= snapshot1.snapshot.metadata.observationsClosedThrough), true);
    const sessionUpdate = await mongoose.startSession();
    try {
      sessionUpdate.startTransaction({ writeConcern: { w: 'majority' } });
      const before = await Product.findOne({ _id: productId, businessId: config.businessId }).session(sessionUpdate);
      const after = await Product.findOneAndUpdate({ _id: productId, businessId: config.businessId }, { name: 'F2 renamed item' },
        { new: true, session: sessionUpdate });
      await recordV3ProductChange({ businessId: config.businessId, session: sessionUpdate, before, after, operation: 'UPDATE' });
      await sessionUpdate.commitTransaction();
    } catch (error) { if (sessionUpdate.inTransaction()) await sessionUpdate.abortTransaction(); throw error; }
    finally { await sessionUpdate.endSession(); }
    assert.equal(await getDataVersion(config.businessId), '4');
    const snapshotAfterUpdate = await buildV3OperationalSnapshot({ businessId: config.businessId,
      asOfDate: require('../../src/services/v3OperationalSnapshotService').limaDate(new Date()), minimumDataVersion: '4' });
    assert.equal(snapshotAfterUpdate.dataVersion, '4');
    assert.notEqual(snapshotAfterUpdate.snapshot.metadata.snapshotHash, snapshot1.snapshot.metadata.snapshotHash);
    const session2 = await mongoose.startSession();
    let rolledBackId;
    try {
      session2.startTransaction({ writeConcern: { w: 'majority' } });
      const [product] = await Product.create([{ businessId: config.businessId, name: 'Rollback item', sku: `F2-RB-${Date.now()}`,
        price: 2, currency: 'PEN', costPrice: 1, category: 'Test', stock: 0 }], { session: session2 });
      rolledBackId = product._id;
      await recordV3ProductChange({ businessId: config.businessId, session: session2, after: product, operation: 'CREATE' });
      assert.equal(await getDataVersion(config.businessId, { session: session2 }), '5');
      await session2.abortTransaction();
    } finally { await session2.endSession(); }
    assert.equal(await Product.exists({ _id: rolledBackId, businessId: config.businessId }), null);
    assert.equal(await getDataVersion(config.businessId), '4');
    assert.equal(await V3OperationalChange.countDocuments({ businessId: config.businessId }), 5);
    assert.equal(await getDataVersion(config.businessId), '4');
    assert.equal(await businessBService.getDataVersion(businessB), '0');

    const businessBProductId = new mongoose.Types.ObjectId();
    const businessBSku = `F2B-${Date.now()}`;
    const businessBSession = await mongoose.startSession();
    try {
      businessBSession.startTransaction({ writeConcern: { w: 'majority' } });
      const [businessBProduct] = await Product.create([{ _id: businessBProductId, businessId: businessB,
        scenarioId: config.scenarioId, name: 'F2 isolated business item', sku: businessBSku,
        price: 3, currency: 'PEN', costPrice: 1, category: 'Test', stock: 9 }], { session: businessBSession });
      const [businessBMovement] = await InventoryMovement.create([{
        businessId: businessB, productId: businessBProductId, type: 'opening', quantityDelta: 9,
        stockBefore: 0, stockAfter: 9, occurredAt: new Date(), source: 'api'
      }], { session: businessBSession });
      await businessBService.recordV3ProductChange({ businessId: businessB, session: businessBSession,
        after: businessBProduct, operation: 'CREATE', extraChanges: [{ entityType: 'movement',
          entityKey: String(businessBMovement._id), operation: 'ADJUST',
          projection: { quantityDelta: 9, stockBefore: 0, stockAfter: 9 } }] });
      await businessBSession.commitTransaction();
    } catch (error) {
      if (businessBSession.inTransaction()) await businessBSession.abortTransaction();
      throw error;
    } finally { await businessBSession.endSession(); }

    assert.equal(await businessBService.getDataVersion(businessB), '1');
    assert.equal(await getDataVersion(config.businessId), '4');
    const isolationAsOfDate = require('../../src/services/v3OperationalSnapshotService').limaDate(new Date());
    const snapshotA = await buildV3OperationalSnapshot({ businessId: config.businessId,
      asOfDate: isolationAsOfDate, minimumDataVersion: '4' });
    const snapshotB = await businessBService.buildV3OperationalSnapshot({ businessId: businessB,
      asOfDate: isolationAsOfDate, minimumDataVersion: '1' });
    assert.equal(snapshotA.snapshot.metadata.businessId, config.businessId);
    assert.equal(snapshotB.snapshot.metadata.businessId, businessB);
    assert(snapshotA.snapshot.stockStates.some(row => row.sku === productSku));
    assert(snapshotA.snapshot.stockStates.every(row => row.sku !== businessBSku));
    assert(snapshotB.snapshot.stockStates.some(row => row.sku === businessBSku));
    assert(snapshotB.snapshot.stockStates.every(row => row.sku !== productSku));
    assert.notEqual(snapshotA.snapshot.metadata.snapshotHash, snapshotB.snapshot.metadata.snapshotHash);
    assert.equal(await getDataVersion(config.businessId), '4');
    assert.equal(await businessBService.getDataVersion(businessB), '1');
  } finally {
    try {
      if (mongoose.connection.readyState === 1) {
        if (mongoose.connection.name !== TEST_DATABASE) throw new Error('Refusing to drop an unexpected Mongo database.');
        await mongoose.connection.db.dropDatabase();
        const remains = (await mongoose.connection.db.admin().listDatabases({ nameOnly: true }))
          .databases.some(database => database.name === TEST_DATABASE);
        assert.equal(remains, false, 'dedicated integration database must be removed during cleanup');
      }
    } finally {
      await mongoose.disconnect();
    }
  }
});
