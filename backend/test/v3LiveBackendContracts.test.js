'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { config, verifiedTransactionReference, transactionProjection, buildSnapshotSections, logicalHash } = require('../src/services/v3OperationalSnapshotService');

const historicalSale = () => {
  const saleCode = 'V3-SALE-20261012-000001';
  const saleLineKey = `${saleCode}|v3.pan-fre.001`;
  const sourceEventId = `${config.datasetVersion}|sale|${saleCode}|1`;
  const lineEventId = `${config.datasetVersion}|sale-line|${saleCode}|v3.pan-fre.001|1`;
  return {
    _id: '507f1f77bcf86cd799439011', businessId: config.businessId, type: 'sale',
    date: new Date('2026-10-12T17:00:00.000Z'), scenarioId: config.scenarioId,
    stableCode: saleCode, sourceEventId,
    products: [{ productId: '507f1f77bcf86cd799439012', quantity: 2, productKey: 'v3.pan-fre.001',
      sku: 'PAN-FRE-001', stableLineKey: saleLineKey, sourceEventId: lineEventId }],
    scenarioData: { canonicalRecord: { saleCode, sourceEventId, scenarioId: config.scenarioId,
      localDate: '2026-10-12', status: 'completed' }, canonicalLines: [{ saleCode, saleLineKey,
      sourceEventId: lineEventId, productKey: 'v3.pan-fre.001', sku: 'PAN-FRE-001', quantity: 2, unitsSold: 2 }] }
  };
};

test('historical transaction cancellation resolves only frozen stableCode and stableLineKey', () => {
  const tx = historicalSale();
  const reference = verifiedTransactionReference(tx);
  assert.equal(reference.origin, 'HISTORICAL');
  assert.equal(reference.transactionKey, tx.stableCode);
  assert.deepEqual(reference.lineKeys, [tx.products[0].stableLineKey]);

  assert.throws(() => verifiedTransactionReference({ ...tx, stableCode: 'wrong-sale' }),
    error => error.code === 'HISTORICAL_REFERENCE_NOT_FOUND');
  assert.throws(() => verifiedTransactionReference({ ...tx, products: [{ ...tx.products[0], stableLineKey: 'wrong-line' }] }),
    error => error.code === 'HISTORICAL_LINE_REFERENCE_INVALID');
  assert.throws(() => verifiedTransactionReference({ ...tx, businessId: 'OTHER-TENANT' }),
    error => error.code === 'HISTORICAL_REFERENCE_NOT_FOUND');
});

test('deferred purchase CREATE is marked for snapshot contract v2 while immediate purchases retain v1 shape', () => {
  const tx = { _id: '507f1f77bcf86cd799439021', type: 'purchase', date: new Date('2026-10-14T15:00:00Z'),
    status: 'pending', currency: 'PEN', vendorId: '507f1f77bcf86cd799439022',
    products: [{ productId: '507f1f77bcf86cd799439023', quantity: 3, price: 6, total: 18,
      stableLineKey: 'purchase:line:1', productKey: 'v3.pan-fre.001', sku: 'PAN-FRE-001' }],
    purchaseLifecycle: { fulfillmentMode: 'DEFERRED', orderedAtUtc: new Date('2026-10-14T15:00:00Z'),
      promisedAtUtc: new Date('2026-10-16T15:00:00Z'), receiptState: 'NONE', receipts: [] } };
  const deferred = transactionProjection(tx, { stableCode: 'SUP-01' });
  assert.equal(deferred.contractVersion, 2);
  assert.equal(deferred.fulfillmentMode, 'DEFERRED');
  assert.equal(deferred.initialStatus, 'pending');
  assert.equal(deferred.receiptEvidence, 'NONE');
  const immediate = transactionProjection({ ...tx, status: 'completed', purchaseLifecycle: null }, { stableCode: 'SUP-01' });
  assert.equal(immediate.contractVersion, null);
  assert.equal(immediate.fulfillmentMode, null);
  assert.equal(immediate.initialStatus, null);
  assert.equal(immediate.receiptEvidence, 'IMMEDIATE_PURCHASE');
});

test('snapshot emits stable cancellation and dated receive evidence with deterministic logical hash', () => {
  const at = '2026-10-14T18:00:00.000Z';
  const changes = [
    { eventKey: '2:0:transaction:private-id:CANCEL', revision: 2n, effectiveAtUtc: at,
      entityType: 'transaction', entityKey: 'private-id', operation: 'CANCEL',
      projection: { contractVersion: 2, transactionKey: 'V3-SALE-20261012-000001',
        transactionOrigin: 'HISTORICAL', type: 'sale', kind: 'CANCEL', affectedStableLineKeys: ['V3-SALE-20261012-000001|v3.pan-fre.001'] } },
    { eventKey: '3:0:transaction:private-purchase:RECEIVE', revision: 3n, effectiveAtUtc: at,
      entityType: 'transaction', entityKey: 'private-purchase', operation: 'RECEIVE',
      projection: { contractVersion: 2, transactionKey: 'V3-PO-20261011-000001', transactionOrigin: 'HISTORICAL',
        type: 'purchase', kind: 'RECEIVE', receiptKey: 'receipt-test-0001', supplierKey: 'SUP-01',
        lines: [{ lineKey: 'V3-PO-20261011-000001|v3.pan-fre.001', productKey: 'v3.pan-fre.001',
          sku: 'PAN-FRE-001', orderedQty: 3, receivedQty: 3, purchaseUnitCostCents: 600,
          costBasis: 'HISTORICAL_COST', currency: 'PEN' }] } }
  ];
  const first = buildSnapshotSections(changes, '2026-10-14', '2026-10-13', [], new Date(at));
  const second = buildSnapshotSections(changes, '2026-10-14', '2026-10-13', [], new Date(at));
  assert.equal(first.contractVersion, '2');
  assert.equal(first.transactionChanges[0].entityKey, 'V3-SALE-20261012-000001');
  assert.equal(first.transactionChanges[0].lineChanges[0].lineKey, changes[0].projection.affectedStableLineKeys[0]);
  assert.equal(first.transactionChanges[1].transactionKey, 'V3-PO-20261011-000001');
  assert.equal(first.transactionChanges[1].receiptKey, 'receipt-test-0001');
  assert.equal(first.transactionChanges[1].lineChanges[0].costBasis, 'HISTORICAL_COST');
  assert.equal(logicalHash(first), logicalHash(second));
});
