'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Revision = require('../src/models/V3OperationalRevision');
const Change = require('../src/models/V3OperationalChange');
const {
  config, limaDate, limaDayStart, logicalHash, transactionProjection,
  buildSnapshotSections, enforcePayloadLimit
} = require('../src/services/v3OperationalSnapshotService');

const sale = ({ key, date, status = 'completed', sku = 'SKU-1', quantity = 2, costCents = null }) => ({
  businessId: config.businessId, scenarioId: config.scenarioId, revision: 1n, eventOrdinal: 0,
  eventKey: `1:0:sale:${key}:CREATE`, effectiveAtUtc: new Date(`${date}T18:00:00.000Z`),
  entityType: 'sale', entityKey: key, operation: 'CREATE',
  projection: { saleKey: key, occurredAtUtc: `${date}T18:00:00.000Z`, localDate: date, customerKey: null,
    currency: 'PEN', totalCents: 1000, initialStatus: status, lines: [{ lineKey: `${key}:0`, productKey: sku, sku,
      quantity, unitPriceCents: 500, lineTotalCents: 1000, unitCostAtSaleCents: costCents, costBasis: costCents == null ? 'UNKNOWN' : 'CAPTURED',
      costKnown: costCents != null, promo: false }] }
});

test('F.2 schemas use BSON int64 and enforce append-only event identity', () => {
  assert.equal(Revision.schema.path('revision').instance, 'BigInt');
  assert.equal(Revision.schema.path('bootstrapStatus').enumValues.includes('VERIFIED'), true);
  assert.equal(Change.schema.indexes().some(([keys, options]) => keys.businessId === 1 && keys.revision === 1
    && keys.eventOrdinal === 1 && options.unique === true), true);
});

test('Lima day boundaries use UTC-05 and historical dates are stable', () => {
  assert.equal(limaDate(new Date('2026-10-14T04:59:59.999Z')), '2026-10-13');
  assert.equal(limaDate(new Date('2026-10-14T05:00:00.000Z')), '2026-10-14');
  assert.equal(limaDayStart('2026-10-13').toISOString(), '2026-10-13T05:00:00.000Z');
});

test('logical hash ignores accidental object and array ordering', () => {
  assert.equal(logicalHash({ sales: [{ b: 2, a: 1 }, { a: 3 }] }), logicalHash({ sales: [{ a: 3 }, { a: 1, b: 2 }] }));
  assert.notEqual(logicalHash({ sales: [{ a: 1 }] }), logicalHash({ sales: [{ a: 2 }] }));
});

test('sale projection preserves stable lines and never invents missing cost', () => {
  const projected = transactionProjection({ _id: 't1', type: 'sale', date: new Date('2026-10-13T18:00:00Z'), status: 'completed',
    currency: 'PEN', totalAmount: 10, products: [{ productId: 'p1', productKey: 'PAN-1', sku: 'PAN-1', quantity: 2, price: 5, total: 10 }] });
  assert.equal(projected.saleKey, 't1');
  assert.equal(projected.lines[0].productKey, 'PAN-1');
  assert.equal(projected.lines[0].costKnown, false);
  assert.equal(projected.lines[0].unitCostAtSaleCents, null);
});

test('purchase projection marks current immediate stock receipt and does not claim pending receipt', () => {
  const input = { _id: 't2', type: 'purchase', date: new Date('2026-10-13T18:00:00Z'), currency: 'PEN', totalAmount: 8,
    vendorId: 's1', products: [{ productId: 'p1', sku: 'SKU-1', quantity: 2, price: 4, costPrice: 4, total: 8 }] };
  assert.equal(transactionProjection(input).receiptEvidence, 'IMMEDIATE_PURCHASE');
  assert.equal(transactionProjection({ ...input, status: 'pending' }).receiptEvidence, 'NONE');
});

test('snapshot delta excludes pre-cutoff and future events and applies cancellation only as of its event time', () => {
  const created = sale({ key: 's1', date: '2026-10-13' });
  const preCutoff = { ...sale({ key: 'old', date: '2026-10-12' }), effectiveAtUtc: new Date('2026-10-12T18:00:00Z') };
  const future = { ...sale({ key: 'future', date: '2026-10-14' }), effectiveAtUtc: new Date('2026-10-14T20:00:00Z') };
  const cancel = { ...created, eventKey: '2:0:transaction:s1:CANCEL', entityType: 'transaction', entityKey: 's1', operation: 'CANCEL',
    effectiveAtUtc: new Date('2026-10-14T05:30:00Z'), projection: { transactionOrigin: 'LIVE' } };
  const beforeCancel = buildSnapshotSections([created, cancel], '2026-10-13', '2026-10-12', [], new Date('2026-10-14T04:59:59Z'));
  assert.equal(beforeCancel.sales.length, 1);
  assert.equal(beforeCancel.transactionChanges.length, 0);
  const afterCancel = buildSnapshotSections([created, cancel, preCutoff, future], '2026-10-14', '2026-10-13', [], new Date('2026-10-14T06:00:00Z'));
  assert.deepEqual(afterCancel.sales.map(row => row.saleKey), ['s1']);
  assert.equal(afterCancel.transactionChanges.length, 1);
  assert.equal(afterCancel.closedSalesDays.length, 0); // canceled sale nets to zero
});

test('closed days are explicit zero-complete rows; current partial day is excluded', () => {
  const sections = buildSnapshotSections([sale({ key: 's1', date: '2026-10-13' })], '2026-10-14', '2026-10-13', ['SKU-1', 'SKU-2'], new Date('2026-10-14T20:00:00Z'));
  assert.deepEqual(sections.closedSalesDays, [
    { productKey: 'SKU-1', localDate: '2026-10-13', unitsSold: 2, completeness: 'COMPLETE', availability: 'UNKNOWN', availableHours: null, onHandUsableAtOrigin: null },
    { productKey: 'SKU-2', localDate: '2026-10-13', unitsSold: 0, completeness: 'COMPLETE', availability: 'UNKNOWN', availableHours: null, onHandUsableAtOrigin: null }
  ]);
  assert.equal(sections.closedSalesDays.some(row => row.localDate === '2026-10-14'), false);
});

test('snapshot payload limit rejects instead of truncating and accepts at-limit payload', () => {
  const withinLimit = { content: 'x'.repeat(config.maxPayloadBytes - 100) };
  const measured = enforcePayloadLimit(withinLimit);
  assert(measured <= config.maxPayloadBytes);
  assert.equal(measured, Buffer.byteLength(JSON.stringify(withinLimit), 'utf8'));
  assert.throws(() => enforcePayloadLimit({ content: 'x'.repeat(config.maxPayloadBytes) }), error => error.code === 'SNAPSHOT_PAYLOAD_TOO_LARGE' && error.statusCode === 413);
});
