'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductOperationHistoryService, cursorCondition, parseFilters, encodeCursor, decodeCursor } = require('../src/services/productOperationHistoryService');
const V3 = require('../src/config/v3Operational');

const productId = '507f1f77bcf86cd799439011';
const docs = {
  sale: [{ _id: '507f1f77bcf86cd799439101', type: 'sale', status: 'completed', date: new Date('2026-10-18T10:00:00Z'),
    products: [{ productId, quantity: 3, stableLineKey: 'line-sale' }], invoiceNumber: 'S-1', customerName: 'Cliente', scenarioId: V3.scenarioId }],
  cancel: [{ _id: '507f1f77bcf86cd799439102', type: 'sale', status: 'cancelled', date: new Date('2026-10-17T10:00:00Z'),
    cancelledAt: new Date('2026-10-18T10:00:00Z'), products: [{ productId, quantity: 3, stableLineKey: 'line-sale' }], scenarioId: V3.scenarioId }],
  purchase: [{ _id: '507f1f77bcf86cd799439103', type: 'purchase', date: new Date('2026-10-16T10:00:00Z'),
    products: [{ productId, quantity: 8 }], vendorName: 'Proveedor', scenarioId: V3.scenarioId,
    purchaseLifecycle: { receipts: [{ receiptKey: 'receipt:stable-001', receivedAtUtc: new Date('2026-10-17T10:00:00Z'), lines: [] }] } }],
  transactionMovements: [
    { _id: '507f1f77bcf86cd799439111', productId, transactionId: '507f1f77bcf86cd799439101', type: 'sale',
      occurredAt: new Date('2026-10-18T10:00:00Z'), quantityDelta: -3, stockBefore: 10, stockAfter: 7 },
    { _id: '507f1f77bcf86cd799439112', productId, transactionId: '507f1f77bcf86cd799439102', type: 'cancellation',
      occurredAt: new Date('2026-10-18T10:01:00Z'), quantityDelta: 3, stockBefore: 7, stockAfter: 10 },
  ],
  receipt: [{ _id: '507f1f77bcf86cd799439104', productId, transactionId: '507f1f77bcf86cd799439103', type: 'purchase',
    occurredAt: new Date('2026-10-17T10:00:00Z'), quantityDelta: 5, stockBefore: 2, stockAfter: 7,
    reason: 'v3_purchase_receipt', sourceEventId: 'v3-receipt:receipt:stable-001:purchase:line-0', scenarioId: V3.scenarioId }],
  adjustment: [{ _id: '507f1f77bcf86cd799439105', productId, type: 'manual_adjustment', occurredAt: new Date('2026-10-15T10:00:00Z'),
    quantityDelta: -2, stockBefore: 9, stockAfter: 7, scenarioId: V3.scenarioId }],
};
const chain = result => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS: async () => result });
function modelsFixture({ useDocs = true } = {}) {
  const queries = [];
  const models = {
    Product: { findOne(query) { queries.push(['Product', query]); return chain({ _id: productId, sku: 'SKU-1', name: 'Producto' }); } },
    Transaction: { findOne(query) { queries.push(['Transaction.findOne', query]);
      const id = String(query._id); return chain([...docs.sale, ...docs.cancel, ...docs.purchase].find(row => row._id === id) || null); },
      find(query) { queries.push(['Transaction', query]);
      const str = JSON.stringify(query); const type = query.type || (str.includes('"type":"sale"') ? 'sale' : 'purchase');
      const stream = type === 'sale' && query.status === 'cancelled' ? 'cancel'
        : type === 'sale' ? 'sale' : 'purchase';
      return chain(useDocs ? docs[stream] : []); } },
    InventoryMovement: { findOne(query) { queries.push(['InventoryMovement.findOne', query]);
      return chain([...docs.receipt, ...docs.adjustment].find(row => row._id === String(query._id)) || null); },
      find(query) { queries.push(['InventoryMovement', query]);
      const str = JSON.stringify(query);
      const stream = str.includes('transactionId') ? 'transactionMovements' : str.includes('manual_adjustment') ? 'adjustment' : 'receipt';
      return chain(useDocs ? docs[stream] : []); } },
    V3OperationalChange: { find(query) {
      queries.push(['V3OperationalChange', query]);
      const rows = [
        { revision: 84n, eventOrdinal: 0, eventKey: 'sale-event-key', effectiveAtUtc: docs.sale[0].date,
          entityType: 'sale', entityKey: docs.sale[0]._id, operation: 'CREATE', projection: { lines: [{ sku: 'SKU-1', productKey: 'SKU-1' }] } },
        { revision: 85n, eventOrdinal: 0, eventKey: 'cancel-event-key', effectiveAtUtc: docs.cancel[0].cancelledAt,
          entityType: 'transaction', entityKey: docs.cancel[0]._id, operation: 'CANCEL', projection: { affectedStableLineKeys: ['line-sale'] } },
        { revision: 86n, eventOrdinal: 0, eventKey: 'receipt-event-key', effectiveAtUtc: docs.receipt[0].occurredAt,
          entityType: 'transaction', entityKey: docs.purchase[0]._id, operation: 'RECEIVE', projection: { receiptKey: 'receipt:stable-001', lines: [{ productKey: 'SKU-1', sku: 'SKU-1' }] } },
        { revision: 87n, eventOrdinal: 0, eventKey: 'adjust-event-key', effectiveAtUtc: docs.adjustment[0].occurredAt,
          entityType: 'movement', entityKey: docs.adjustment[0]._id, operation: 'ADJUST', projection: { productKey: `OP-P-${productId}` } },
      ];
      return chain(rows.filter(row => query.entityKey.$in.includes(row.entityKey)));
    } },
    ForecastMlUpdateEvent: { find(query) { queries.push(['ForecastMlUpdateEvent', query]); return chain(query.eventKey.$in.flatMap(eventKey =>
      query.eventType.$in.flatMap(eventType => [7, 14].map(horizonDays => ({ eventKey, horizonDays, eventType, dataVersion: 84n,
        occurredAt: eventType === 'SALE_CANCELLED' ? docs.cancel[0].cancelledAt : docs.sale[0].date,
        historicalCorrection: eventType === 'SALE_CANCELLED' }))))); } },
  };
  return { models, queries };
}
const user = { businessId: V3.businessId };

test('product history reads five streams and resolves receipt keys containing colons without parsing line keys', async () => {
  const { models, queries } = modelsFixture();
  const service = createProductOperationHistoryService({ models, secret: 'synthetic-cursor-secret-for-tests-123456789' });
  const result = await service.list({ user, params: { sku: 'SKU-1' }, query: { limit: '20' } });
  assert.deepEqual(result.items.map(row => row.type), ['SALE_CANCELLED', 'SALE', 'PURCHASE_RECEIVED', 'PURCHASE_CREATED', 'INVENTORY_ADJUSTMENT']);
  assert.equal(result.items[0].quantity, 3);
  assert.equal(result.items[1].ridgeImpact.status, 'persisted');
  assert.deepEqual(result.items[1].ridgeImpact.horizons.map(row => row.horizonDays), [7, 14]);
  assert.equal(result.items[0].relationQuality, 'DIRECT_REVISION');
  assert.equal(result.items[0].ridgeImpact.horizons[0].eventType, 'SALE_CANCELLED');
  assert.equal(result.items[0].inventoryImpact.stockBefore, 7);
  assert.equal(result.items[1].inventoryImpact.stockAfter, 7);
  assert.equal(result.items[2].inventoryImpact.stockBefore, 2);
  assert.equal(result.items[2].ridgeImpact.status, 'not_applicable');
  assert.equal(result.items[2].relationQuality, 'DIRECT_REVISION');
  assert.equal(result.items[4].relationQuality, 'DIRECT_REVISION');
  assert.equal(queries.filter(([name]) => name === 'Transaction').length, 4); // three timeline streams plus exact receipt enrichment
  assert.equal(queries.filter(([name]) => name === 'InventoryMovement').length, 3); // transaction movement enrichment plus two timeline streams
  assert.ok(queries.every(([, query]) => JSON.stringify(query).includes(V3.businessId)));
});

test('legacy cancellation is retained without invented revision or Ridge evidence', async () => {
  const { models } = modelsFixture();
  models.V3OperationalChange.find = query => chain([]);
  const service = createProductOperationHistoryService({ models, secret: 'synthetic-cursor-secret-for-tests-123456789' });
  const result = await service.list({ user, params: { sku: 'SKU-1' }, query: { type: 'SALE_CANCELLED' } });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].relationQuality, 'LIMITED_LEGACY');
  assert.equal(result.items[0].ridgeImpact.status, 'not_found');
});

test('operation detail returns exact stock movement and only persisted traceability for all stream types', async () => {
  const { models } = modelsFixture();
  const service = createProductOperationHistoryService({ models, secret: 'synthetic-cursor-secret-for-tests-123456789' });
  const sale = await service.detail({ user, params: { sku: 'SKU-1', operationId: `SALE:${docs.sale[0]._id}` }, query: {} });
  assert.equal(sale.facts.quantity, 3);
  assert.equal(sale.inventoryMovements[0].stockBefore, 10);
  assert.equal(sale.traceability.revision, '84');
  assert.equal(Object.hasOwn(sale, 'execution'), false);
  const cancelled = await service.detail({ user, params: { sku: 'SKU-1', operationId: `SALE_CANCELLED:${docs.cancel[0]._id}` }, query: {} });
  assert.equal(cancelled.operation.relationQuality, 'DIRECT_REVISION');
  assert.equal(cancelled.inventoryMovements[0].quantityDelta, 3);
  const purchase = await service.detail({ user, params: { sku: 'SKU-1', operationId: `PURCHASE_CREATED:${docs.purchase[0]._id}` }, query: {} });
  assert.equal(purchase.facts.quantity, 8);
  const received = await service.detail({ user, params: { sku: 'SKU-1', operationId: `PURCHASE_RECEIVED:${docs.receipt[0]._id}` }, query: {} });
  assert.equal(received.facts.receiptKey, 'receipt:stable-001');
  assert.equal(received.inventoryMovements[0].stockAfter, 7);
  assert.equal(received.ridgeEvidence.status, 'not_applicable');
  const adjustment = await service.detail({ user, params: { sku: 'SKU-1', operationId: `INVENTORY_ADJUSTMENT:${docs.adjustment[0]._id}` }, query: {} });
  assert.equal(adjustment.inventoryMovements[0].quantityDelta, -2);
  assert.equal(adjustment.traceability.operation, 'ADJUST');
});

test('filters use Lima local days as a UTC half-open interval and validate limit/type', async () => {
  assert.deepEqual(parseFilters({ from: '2026-10-18', to: '2026-10-18' }), {
    type: 'ALL', from: '2026-10-18', to: '2026-10-18', limit: 20, cursor: null,
  });
  const { models, queries } = modelsFixture({ useDocs: false });
  const service = createProductOperationHistoryService({ models, secret: 'synthetic-cursor-secret-for-tests-123456789' });
  await service.list({ user, params: { sku: 'SKU-1' }, query: { from: '2026-10-18', to: '2026-10-18', type: 'SALE', limit: '50' } });
  const saleQuery = queries.find(([name, query]) => name === 'Transaction' && JSON.stringify(query).includes('"status":"completed"'))[1];
  assert.match(JSON.stringify(saleQuery), /2026-10-18T05:00:00.000Z/);
  assert.match(JSON.stringify(saleQuery), /2026-10-19T05:00:00.000Z/);
  assert.throws(() => parseFilters({ type: 'UNKNOWN' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseFilters({ limit: '51' }), { code: 'INVALID_REQUEST' });
});

test('cursor is scope-bound and global keyset respects stream rank tie order', () => {
  const key = { timestamp: '2026-10-18T10:00:00.000Z', sourceRank: 30, sourceId: '507f1f77bcf86cd799439102' };
  assert.deepEqual(cursorCondition({ type: 'PURCHASE_CREATED', timeField: 'date' }, key), { date: { $lte: new Date(key.timestamp) } });
  assert.deepEqual(cursorCondition({ type: 'SALE_CANCELLED', timeField: 'cancelledAt' }, key), {
    $or: [{ cancelledAt: { $lt: new Date(key.timestamp) } }, { cancelledAt: new Date(key.timestamp), _id: { $lt: key.sourceId } }],
  });
  const secret = 'synthetic-cursor-secret-for-tests-123456789';
  const scope = { v: 1, businessId: V3.businessId, scenarioId: V3.scenarioId, productId, sku: 'SKU-1', type: 'ALL', from: null, to: null };
  const cursor = encodeCursor({ ...scope, key }, secret);
  assert.deepEqual(decodeCursor(cursor, scope, secret), { ...scope, key });
  assert.throws(() => decodeCursor(cursor, { ...scope, businessId: 'OTHER' }, secret), { code: 'CURSOR_INVALID' });
  assert.throws(() => decodeCursor(`${cursor.slice(0, -1)}x`, scope, secret), { code: 'CURSOR_INVALID' });
});

test('missing product and missing tenant fail closed', async () => {
  const { models } = modelsFixture();
  models.Product.findOne = () => chain(null);
  const service = createProductOperationHistoryService({ models, secret: 'synthetic-cursor-secret-for-tests-123456789' });
  await assert.rejects(service.list({ user, params: { sku: 'UNKNOWN' }, query: {} }), { code: 'PRODUCT_NOT_FOUND', httpStatus: 404 });
  await assert.rejects(service.list({ user: {}, params: { sku: 'SKU-1' }, query: {} }), { code: 'INVALID_REQUEST', httpStatus: 401 });
});
