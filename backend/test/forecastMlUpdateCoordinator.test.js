'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  watermark, matureOrigin, classifyChange, relevantProductDiff, eligible,
  DEBOUNCE_MS, RATE_LIMIT_MS
} = require('../src/services/forecastMlUpdateCoordinator');

test('Lima closure excludes the open day and matures 7/14 labels independently', () => {
  assert.equal(watermark(new Date('2026-10-16T04:59:59Z')), '2026-10-14');
  assert.equal(watermark(new Date('2026-10-16T05:00:00Z')), '2026-10-15');
  assert.equal(matureOrigin('2026-10-15', 7), '2026-10-08');
  assert.equal(matureOrigin('2026-10-15', 14), '2026-10-01');
});

test('only approved commercial changes mark Ridge27 dirty', () => {
  const closedThrough = '2026-10-15';
  const classify = change => classifyChange(change, { closedThrough, affectedLocalDate: '2026-10-12' });
  assert.equal(classify({ entityType: 'sale', operation: 'CREATE', projection: {
    initialStatus: 'completed', localDate: '2026-10-16' } }).eventType, 'SALE_COMPLETED');
  assert.equal(classify({ entityType: 'sale', operation: 'CREATE', projection: {
    initialStatus: 'pending' } }), null);
  assert.deepEqual(classify({ entityType: 'transaction', operation: 'CANCEL', projection: { type: 'sale' } }), {
    eventType: 'SALE_CANCELLED', affectedLocalDate: '2026-10-12', historicalCorrection: true
  });
  for (const change of [
    { entityType: 'movement', operation: 'ADJUST' },
    { entityType: 'transaction', operation: 'RECEIVE' },
    { entityType: 'purchase', operation: 'CREATE' }
  ]) assert.equal(classify(change), null);
  for (const field of ['sku', 'categoryCode', 'subcategoryCode', 'brand', 'presentation',
    'unit', 'sizeValue', 'containedUnits']) {
    assert.equal(relevantProductDiff({ [field]: 'A' }, { [field]: 'B' }), true, field);
  }
  assert.equal(relevantProductDiff({ sku: 'A', priceCents: 100, minStock: 1 },
    { sku: 'A', priceCents: 200, minStock: 2 }), false);
  assert.equal(classify({ entityType: 'product', operation: 'UPDATE', projection: {
    before: { sku: 'A', priceCents: 100 }, after: { sku: 'A', priceCents: 200 }
  } }), null);
});

test('debounce, maturity, rate limit, and historical correction determine readiness', () => {
  const now = new Date('2026-10-16T15:00:00Z');
  const row = { latestMatureOrigin: '2026-10-08', initialMatureOrigin: '2026-10-08',
    lastTrainedMatureOrigin: null, historicalCorrectionVersion: null,
    nextEligibleAt: new Date(now.getTime() + DEBOUNCE_MS), lastAttemptAt: null };
  assert.equal(eligible(row, now), false);
  row.nextEligibleAt = now;
  assert.equal(eligible(row, now), false);
  row.latestMatureOrigin = '2026-10-09';
  assert.equal(eligible(row, now), true);
  row.lastAttemptAt = new Date(now.getTime() - RATE_LIMIT_MS + 1000);
  assert.equal(eligible(row, now), false);
  row.historicalCorrectionVersion = 10n;
  assert.equal(eligible(row, now), true);
});
