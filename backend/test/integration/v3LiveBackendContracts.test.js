'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { Product, Contact, Transaction, InventoryMovement, HistoricalScenario,
  V3OperationalRevision, V3OperationalChange } = require('../../src/models');
const config = require('../../src/config/v3Operational');
const { bootstrapV3OperationalRevision, getDataVersion, buildV3OperationalSnapshot, limaDate } = require('../../src/services/v3OperationalSnapshotService');
const { receiveV3Purchase } = require('../../src/services/v3PurchaseReceiptService');
const { updateTransactionStatus } = require('../../src/controllers/transactionController');

const uri = process.env.MONGODB_TEST_URI;
const TEST_DATABASE = new URL(uri || 'mongodb://127.0.0.1/inventory_v3_f4b_missing_test').pathname.slice(1);
const at = value => new Date(value);
const source = (kind, code) => `${config.datasetVersion}|${kind}|${code}|1`;

function invoke(controller, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = { status(code) { statusCode = code; return this; }, json(body) { resolve({ statusCode, body }); return this; } };
    controller(req, res, reject);
  });
}

test('F.4B RECEIVE and frozen cancellation persist transactionally on a disposable local replica set', { skip: !uri }, async t => {
  const businessId = config.businessId;
  let product, supplier, sale, purchase, rollbackPurchase;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, directConnection: true });
    if (mongoose.connection.name !== TEST_DATABASE || !TEST_DATABASE.startsWith('inventory_v3_f4b_') || !TEST_DATABASE.endsWith('_test')) {
      throw new Error('Refusing F.4B cleanup outside its exact generated disposable test database.');
    }
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.equal(hello.setName, 'rs0');
    assert.equal(hello.isWritablePrimary, true);
    await Promise.all([Product.init(), Contact.init(), Transaction.init(), InventoryMovement.init(),
      HistoricalScenario.init(), V3OperationalRevision.init(), V3OperationalChange.init()]);
    const transactionIndexes = await mongoose.connection.db.collection(Transaction.collection.name).listIndexes().toArray();
    assert(transactionIndexes.some(index => index.name === 'transaction_v3_receipt_key_uq' && index.unique === true
      && JSON.stringify(index.key) === JSON.stringify({ businessId: 1, 'purchaseLifecycle.receipts.receiptKey': 1 })
      && index.partialFilterExpression?.['purchaseLifecycle.receipts.receiptKey']?.$type === 'string'));
    const changeIndexes = await mongoose.connection.db.collection(V3OperationalChange.collection.name).listIndexes().toArray();
    assert(changeIndexes.some(index => index.name === 'v3_operational_change_receipt_key_uq' && index.unique === true
      && JSON.stringify(index.key) === JSON.stringify({ businessId: 1, 'projection.receiptKey': 1 })
      && index.partialFilterExpression?.operation === 'RECEIVE'));
    const preexisting = await Promise.all([
      Product.countDocuments({ businessId }), Contact.countDocuments({ businessId }),
      Transaction.countDocuments({ businessId }), InventoryMovement.countDocuments({ businessId }),
      HistoricalScenario.countDocuments({ businessId }), V3OperationalRevision.countDocuments({ _id: businessId }),
      V3OperationalChange.countDocuments({ businessId })
    ]);
    assert.deepEqual(preexisting, [0, 0, 0, 0, 0, 0, 0]);
    await HistoricalScenario.create({ businessId, scenarioId: config.scenarioId, sourceSha256: config.sourceSha256,
      status: 'completed', metadata: { datasetVersion: config.datasetVersion,
        referenceDate: config.historicalCutoff, timezone: config.timezone } });

    supplier = await Contact.create({ businessId, scenarioId: config.scenarioId,
      sourceEventId: `${config.datasetVersion}|supplier|SUP-01|1`, stableCode: 'SUP-01', stableKey: 'v3.SUP-01',
      name: 'F4B historical supplier', phone: `f4b-supplier-${Date.now()}`, type: 'vendor' });
    product = await Product.create({ businessId, scenarioId: config.scenarioId,
      sourceEventId: `${config.datasetVersion}|product|PAN-FRE-001|1`, productKey: 'v3.pan-fre.001', sku: 'PAN-FRE-001',
      name: 'F4B historical bread', price: 5, costPrice: 2, currency: 'PEN', stock: 8, category: 'Test' });

    const saleCode = 'V3-SALE-20261012-F4B-000001';
    const saleLineKey = `${saleCode}|v3.pan-fre.001`;
    const saleSource = source('sale', saleCode);
    const saleLineSource = `${config.datasetVersion}|sale-line|${saleCode}|v3.pan-fre.001|1`;
    sale = await Transaction.create({ businessId, scenarioId: config.scenarioId, sourceEventId: saleSource,
      stableCode: saleCode, localDate: '2026-10-12', type: 'sale', customerName: 'Consumidor final',
      products: [{ productId: product._id, productName: product.name, quantity: 2, price: 5, total: 10,
        sku: product.sku, productKey: product.productKey, stableLineKey: saleLineKey, sourceEventId: saleLineSource }],
      totalAmount: 10, currency: 'PEN', paymentMethod: 'cash', status: 'completed',
      date: at('2026-10-12T17:00:00.000Z'), scenarioData: {
        canonicalRecord: { saleCode, sourceEventId: saleSource, scenarioId: config.scenarioId,
          localDate: '2026-10-12', status: 'completed' },
        canonicalLines: [{ saleCode, saleLineKey, sourceEventId: saleLineSource, productKey: product.productKey,
          sku: product.sku, quantity: 2, unitsSold: 2 }]
      } });
    await InventoryMovement.create([
      { businessId, productId: product._id, transactionId: null, type: 'opening', quantityDelta: 10,
        stockBefore: 0, stockAfter: 10, occurredAt: at('2026-10-01T12:00:00Z'), source: 'historical_import',
        scenarioId: config.scenarioId, sourceEventId: `${config.datasetVersion}|movement|OPEN-1|1` },
      { businessId, productId: product._id, transactionId: sale._id, type: 'sale', quantityDelta: -2,
        stockBefore: 10, stockAfter: 8, occurredAt: sale.date, source: 'historical_import',
        scenarioId: config.scenarioId, sourceEventId: `${config.datasetVersion}|movement|SALE-1|1` }
    ]);
    const [savedProduct] = await Promise.all([Product.findById(product._id)]);
    savedProduct.stock = 8;
    await savedProduct.save();
    await bootstrapV3OperationalRevision({ businessId, attestNoUnjournaledBaseCatalogChanges: true });

    await t.test('post-cutoff cancellation references the frozen sale and restores ledger stock once', async () => {
      const response = await invoke(updateTransactionStatus, { businessId,
        params: { id: String(sale._id) }, body: { status: 'cancelled' } });
      assert.equal(response.statusCode, 200);
      assert.equal((await Transaction.findById(sale._id)).status, 'cancelled');
      assert.equal((await Product.findById(product._id)).stock, 10);
      const change = await V3OperationalChange.findOne({ businessId, operation: 'CANCEL' }).lean();
      assert.equal(change.projection.transactionKey, saleCode);
      assert.deepEqual(change.projection.affectedStableLineKeys, [saleLineKey]);
      assert.equal(change.projection.transactionOrigin, 'HISTORICAL');
      assert.equal(await getDataVersion(businessId), '1');
      const movements = await InventoryMovement.find({ businessId, transactionId: sale._id, type: 'cancellation' });
      assert.equal(movements.length, 1);
      assert.equal(movements[0].quantityDelta, 2);
      const wrongTenant = await invoke(updateTransactionStatus, { businessId: `${businessId}-OTHER`,
        params: { id: String(sale._id) }, body: { status: 'cancelled' } });
      assert.equal(wrongTenant.statusCode, 404);
      assert.equal(await getDataVersion(businessId), '1');
    });

    const purchaseCode = 'V3-PO-20261011-F4B-000001';
    const purchaseLineKey = `${purchaseCode}|v3.pan-fre.001`;
    const purchaseSource = source('purchase', purchaseCode);
    const purchaseLineSource = `${config.datasetVersion}|purchase-line|${purchaseCode}|v3.pan-fre.001|1`;
    const promisedAt = at('2026-10-13T15:00:00.000Z');
    const canonicalRecord = { purchaseCode, sourceEventId: purchaseSource, scenarioId: config.scenarioId,
      supplierCode: supplier.stableCode, orderedAt: '2026-10-11T15:00:00.000Z',
      promisedAt: promisedAt.toISOString(), receivedAt: null, orderedLocalDate: '2026-10-11',
      status: 'pending', currency: 'PEN' };
    const canonicalLine = { purchaseCode, purchaseLineKey, sourceEventId: purchaseLineSource,
      supplierCode: supplier.stableCode, productKey: product.productKey, sku: product.sku,
      quantityOrdered: 3, quantityReceived: 0, purchasePriceCents: 200, currency: 'PEN' };
    purchase = await Transaction.create({ businessId, scenarioId: config.scenarioId, sourceEventId: purchaseSource,
      stableCode: purchaseCode, localDate: '2026-10-11', type: 'purchase', vendorId: supplier._id,
      supplierId: supplier._id, vendorName: supplier.name,
      products: [{ productId: product._id, productName: product.name, quantity: 3, price: 2, costPrice: 2,
        total: 6, sku: product.sku, productKey: product.productKey, stableLineKey: purchaseLineKey,
        sourceEventId: purchaseLineSource, costCents: 200 }],
      totalAmount: 6, currency: 'PEN', paymentMethod: 'cash', status: 'pending',
      date: at('2026-10-11T15:00:00.000Z'), scenarioData: { canonicalRecord, canonicalLines: [canonicalLine] } });

    await t.test('full RECEIVE is atomic, idempotent, dated, and snapshot-hashed as contract v2', async () => {
      const receivedAtUtc = new Date(Date.now() - 60000);
      const first = await receiveV3Purchase({ businessId, purchaseId: purchase._id,
        receiptKey: 'f4b-receipt-key-0001', receivedAtUtc });
      assert.equal(first.alreadyApplied, false);
      assert.equal(first.receiptState, 'COMPLETE');
      assert.equal(first.revision, '2');
      assert.equal((await Transaction.findById(purchase._id)).status, 'completed');
      assert.equal((await Transaction.findById(purchase._id)).purchaseLifecycle.receiptState, 'COMPLETE');
      assert.equal((await Product.findById(product._id)).stock, 13);
      const receiptMovement = await InventoryMovement.find({ businessId, transactionId: purchase._id, type: 'purchase' });
      assert.equal(receiptMovement.length, 1);
      assert.equal(receiptMovement[0].quantityDelta, 3);
      assert.equal(receiptMovement[0].unitCostCents, 200);
      assert.equal(receiptMovement[0].valueDeltaCents, 600);
      assert.equal(receiptMovement[0].costBasis, 'HISTORICAL_COST');
      const event = await V3OperationalChange.findOne({ businessId, operation: 'RECEIVE' }).lean();
      assert.equal(event.projection.receiptKey, 'f4b-receipt-key-0001');
      assert.equal(event.projection.transactionKey, purchaseCode);
      assert.equal(event.projection.lines[0].receivedQty, 3);
      assert.equal(event.projection.lines[0].costBasis, 'HISTORICAL_COST');
      assert.equal(event.projection.lines[0].purchaseUnitCostCents, 200);

      const retry = await receiveV3Purchase({ businessId, purchaseId: purchase._id,
        receiptKey: 'f4b-receipt-key-0001', receivedAtUtc: at('2026-10-14T19:00:00.000Z') });
      assert.equal(retry.alreadyApplied, true);
      assert.equal(String(retry.revision), '2');
      assert.equal(await getDataVersion(businessId), '2');
      assert.equal(await V3OperationalChange.countDocuments({ businessId, operation: 'RECEIVE' }), 1);
      assert.equal(await InventoryMovement.countDocuments({ businessId, transactionId: purchase._id, type: 'purchase' }), 1);
      await assert.rejects(receiveV3Purchase({ businessId, purchaseId: purchase._id,
        receiptKey: 'f4b-receipt-key-0001', observedReceiptCosts: [{ lineKey: purchaseLineKey,
          purchaseUnitCostCents: 250, currency: 'PEN' }] }), error => error.code === 'RECEIPT_ALREADY_APPLIED');
      await assert.rejects(receiveV3Purchase({ businessId, purchaseId: 'not-an-object-id',
        receiptKey: 'f4b-invalid-id-0001' }), error => error.code === 'RECEIPT_REFERENCE_INVALID' && error.statusCode === 400);

      const fixedNow = new Date(Date.now() + 1000);
      const asOfDate = limaDate(fixedNow);
      const snapshotA = await buildV3OperationalSnapshot({ businessId, asOfDate, now: fixedNow, minimumDataVersion: '2' });
      const snapshotB = await buildV3OperationalSnapshot({ businessId, asOfDate, now: fixedNow, minimumDataVersion: '2' });
      assert.equal(snapshotA.snapshot.metadata.contractVersion, '2');
      assert.equal(snapshotA.snapshot.transactionChanges.filter(row => row.kind === 'RECEIVE').length, 1);
      assert.equal(Object.hasOwn(snapshotA.snapshot.metadata, 'receiptEvents'), false);
      assert.equal(Object.hasOwn(snapshotA.snapshot.metadata, 'cancellationEvents'), false);
      const cancelChange = snapshotA.snapshot.transactionChanges.find(row => row.kind === 'CANCEL');
      const receiveChange = snapshotA.snapshot.transactionChanges.find(row => row.kind === 'RECEIVE');
      assert.equal(cancelChange.transactionKey, saleCode);
      assert.equal(cancelChange.entityKey, saleCode);
      assert.equal(cancelChange.lineChanges[0].lineKey, saleLineKey);
      assert.equal(receiveChange.transactionKey, purchaseCode);
      assert.equal(receiveChange.entityKey, purchaseCode);
      assert.equal(receiveChange.receiptKey, 'f4b-receipt-key-0001');
      assert.equal(receiveChange.lineChanges[0].costBasis, 'HISTORICAL_COST');
      assert.equal(snapshotA.snapshot.stockStates.find(row => row.sku === product.sku).onHand, 13);
      assert.equal(snapshotA.snapshot.metadata.snapshotHash, snapshotB.snapshot.metadata.snapshotHash);
    });

    const rollbackCode = 'V3-PO-20261011-F4B-ROLLBACK';
    const rollbackLineKey = `${rollbackCode}|v3.pan-fre.001`;
    rollbackPurchase = await Transaction.create({ businessId, scenarioId: config.scenarioId,
      sourceEventId: source('purchase', rollbackCode), stableCode: rollbackCode,
      type: 'purchase', vendorId: supplier._id, supplierId: supplier._id, vendorName: supplier.name,
      products: [{ productId: product._id, productName: product.name, quantity: 2, price: 2, costPrice: 2,
        total: 4, sku: product.sku, productKey: product.productKey, stableLineKey: rollbackLineKey,
        sourceEventId: `${config.datasetVersion}|purchase-line|${rollbackCode}|v3.pan-fre.001|1`, costCents: 200 }],
      totalAmount: 4, currency: 'PEN', status: 'pending', date: at('2026-10-11T16:00:00Z'),
      scenarioData: { canonicalRecord: { purchaseCode: rollbackCode, sourceEventId: source('purchase', rollbackCode),
        scenarioId: config.scenarioId, supplierCode: supplier.stableCode, status: 'pending',
        promisedAt: promisedAt.toISOString() }, canonicalLines: [{ purchaseCode: rollbackCode,
        purchaseLineKey: rollbackLineKey, supplierCode: supplier.stableCode, productKey: product.productKey,
        sku: product.sku, quantityOrdered: 2, purchasePriceCents: 200, currency: 'PEN' }] } });

    await t.test('failure after stock/state writes rolls back everything', async tRollback => {
      const beforeStock = (await Product.findById(product._id)).stock;
      const beforeVersion = await getDataVersion(businessId);
      const beforeMovements = await InventoryMovement.countDocuments({ businessId, transactionId: rollbackPurchase._id });
      const original = V3OperationalChange.insertMany;
      tRollback.mock.method(V3OperationalChange, 'insertMany', async () => { throw new Error('forced journal failure'); });
      try {
        await assert.rejects(receiveV3Purchase({ businessId, purchaseId: rollbackPurchase._id,
          receiptKey: 'f4b-receipt-rollback-01', receivedAtUtc: new Date(Date.now() - 1000) }), /forced journal failure/);
      } finally {
        V3OperationalChange.insertMany = original;
      }
      assert.equal((await Transaction.findById(rollbackPurchase._id)).status, 'pending');
      assert.equal((await Product.findById(product._id)).stock, beforeStock);
      assert.equal(await InventoryMovement.countDocuments({ businessId, transactionId: rollbackPurchase._id }), beforeMovements);
      assert.equal(await getDataVersion(businessId), beforeVersion);
      assert.equal(await V3OperationalChange.countDocuments({ businessId, operation: 'RECEIVE' }), 1);
    });

    await t.test('cross-tenant receive is denied before opening a transaction', async () => {
      await assert.rejects(receiveV3Purchase({ businessId: `${businessId}-OTHER`, purchaseId: purchase._id,
        receiptKey: 'f4b-cross-tenant-01' }), error => error.code === 'RECEIPT_REFERENCE_INVALID' && error.statusCode === 403);
    });
  } finally {
    try {
      if (mongoose.connection.readyState === 1) {
        if (!mongoose.connection.name.startsWith('inventory_v3_f4b_') || !mongoose.connection.name.endsWith('_test')) {
          throw new Error('Refusing F.4B cleanup outside its generated disposable test database.');
        }
        await mongoose.connection.db.dropDatabase();
        const remains = (await mongoose.connection.db.admin().listDatabases({ nameOnly: true }))
          .databases.some(database => database.name === mongoose.connection.name);
        assert.equal(remains, false, 'generated disposable F.4B database must be removed');
      }
    } finally { await mongoose.disconnect(); }
  }
});
