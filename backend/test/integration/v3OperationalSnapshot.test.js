'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { Product, HistoricalScenario, V3OperationalRevision, V3OperationalChange } = require('../../src/models');
const { config, bootstrapV3OperationalRevision, getDataVersion, recordV3ProductChange, buildV3OperationalSnapshot } = require('../../src/services/v3OperationalSnapshotService');

const uri = process.env.MONGODB_TEST_URI;
const ownedProductIds = [];
let ownsScenario = false;
let initializedRevision = false;

test('F.2 revision, rollback, tenant isolation, and snapshot on local replica set', { skip: !uri }, async t => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const dbName = mongoose.connection.name;
  if (!dbName.endsWith('_test')) throw new Error('Refusing V3 operational integration test outside a dedicated *_test database.');
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
  await Promise.all([Product.init(), HistoricalScenario.init(), V3OperationalRevision.init(), V3OperationalChange.init()]);
  const existing = await Promise.all([
    HistoricalScenario.countDocuments({ businessId: config.businessId }),
    V3OperationalRevision.countDocuments({ _id: config.businessId }),
    V3OperationalChange.countDocuments({ businessId: config.businessId }),
    Product.countDocuments({ businessId: config.businessId })
  ]);
  assert.deepEqual(existing, [0, 0, 0, 0], 'V3 fixture IDs are intentionally reserved; use an empty dedicated test database.');

  const scenario = await HistoricalScenario.create({ businessId: config.businessId, scenarioId: config.scenarioId,
    sourceSha256: config.sourceSha256, status: 'completed', metadata: { datasetVersion: config.datasetVersion,
      referenceDate: config.historicalCutoff, timezone: config.timezone } });
  ownsScenario = true;

  try {
    const version0 = await bootstrapV3OperationalRevision({ businessId: config.businessId, attestNoUnjournaledBaseCatalogChanges: true });
    initializedRevision = true;
    assert.equal(String(version0.revision), '0');
    assert.equal(version0.bootstrapStatus, 'VERIFIED');
    assert.equal(await getDataVersion(config.businessId), '0');

    const session1 = await mongoose.startSession();
    let productId;
    try {
      session1.startTransaction({ writeConcern: { w: 'majority' } });
      const [product] = await Product.create([{ businessId: config.businessId, name: 'F2 test item', sku: `F2-${Date.now()}`,
        price: 2, currency: 'PEN', costPrice: 1, category: 'Test', stock: 0 }], { session: session1 });
      productId = product._id;
      ownedProductIds.push(productId);
      await recordV3ProductChange({ businessId: config.businessId, session: session1, after: product, operation: 'CREATE',
        extraChanges: [{ entityType: 'movement', entityKey: `opening-${product._id}`, operation: 'ADJUST', projection: { quantityDelta: 1 } }] });
      assert.equal(await getDataVersion(config.businessId, { session: session1 }), '1');
      await session1.commitTransaction();
    } catch (error) { if (session1.inTransaction()) await session1.abortTransaction(); throw error; }
    finally { await session1.endSession(); }

    assert.equal(await getDataVersion(config.businessId), '1');
    assert.equal(await V3OperationalChange.countDocuments({ businessId: config.businessId, revision: 1n }), 2);

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
    assert.equal(await getDataVersion(config.businessId), '2');

    const session2 = await mongoose.startSession();
    let rolledBackId;
    try {
      session2.startTransaction({ writeConcern: { w: 'majority' } });
      const [product] = await Product.create([{ businessId: config.businessId, name: 'Rollback item', sku: `F2-RB-${Date.now()}`,
        price: 2, currency: 'PEN', costPrice: 1, category: 'Test', stock: 0 }], { session: session2 });
      rolledBackId = product._id;
      await recordV3ProductChange({ businessId: config.businessId, session: session2, after: product, operation: 'CREATE' });
      assert.equal(await getDataVersion(config.businessId, { session: session2 }), '3');
      await session2.abortTransaction();
    } finally { await session2.endSession(); }
    assert.equal(await Product.exists({ _id: rolledBackId, businessId: config.businessId }), null);
    assert.equal(await getDataVersion(config.businessId), '2');
    assert.equal(await V3OperationalChange.countDocuments({ businessId: config.businessId }), 3);

    const nonV3 = await mongoose.startSession();
    try {
      nonV3.startTransaction();
      assert.equal(await require('../../src/services/v3OperationalSnapshotService').bumpV3OperationalRevision({
        businessId: 'other-test-business', session: nonV3, changes: []
      }), null);
      await nonV3.abortTransaction();
    } finally { await nonV3.endSession(); }
    assert.equal(await getDataVersion(config.businessId), '2');

    const now = new Date();
    const snapshot = await buildV3OperationalSnapshot({ businessId: config.businessId,
      asOfDate: require('../../src/services/v3OperationalSnapshotService').limaDate(now), now, minimumDataVersion: '2' });
    assert.equal(snapshot.mode, 'LIVE');
    assert.equal(snapshot.dataVersion, '2');
    assert.equal(snapshot.snapshot.metadata.completeness, 'COMPLETE');
    assert.equal(snapshot.snapshot.catalogChanges.length, 2);
    assert.match(snapshot.snapshot.metadata.snapshotHash, /^[a-f0-9]{64}$/);
    assert(snapshot.snapshot.metadata.payloadBytes <= config.maxPayloadBytes);
  } finally {
    if (ownedProductIds.length) await Product.deleteMany({ _id: { $in: ownedProductIds }, businessId: config.businessId });
    if (initializedRevision) {
      await V3OperationalChange.deleteMany({ businessId: config.businessId });
      await V3OperationalRevision.deleteOne({ _id: config.businessId });
    }
    if (ownsScenario) await HistoricalScenario.deleteOne({ _id: scenario._id, businessId: config.businessId });
    await mongoose.disconnect();
  }
});
