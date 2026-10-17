'use strict';
const { createHash } = require('node:crypto');
const D = require('./forecastMlUpdateExecutionDomain');
const MAX_PRODUCTS = 200, MAX_BYTES = 256 * 1024;
const FINAL = ['COMPLETE', 'PARTIAL', 'NOT_CAPTURED'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const promoted = row => row.perHorizon?.some(h => h.resultStatus === 'PROMOTED'
  && h.promotionDecision === 'PROMOTED' && h.activeChangeSource === 'EXECUTION');
const versions = row => [7, 14].map(horizonDays => {
  const h = row.perHorizon.find(item => item.horizonDays === horizonDays);
  return { horizonDays, beforeVersion: h?.activeVersionBefore ?? null, afterVersion: h?.activeVersionAfter ?? null };
});
function checkSize(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) fail('IMPACT_SIZE_LIMIT');
}
function validatePin(pin, scope) {
  const fields = ['businessId', 'scenarioId', 'dataVersion', 'asOf', 'capturedAtUtc', 'observationsClosedThrough',
    'snapshotHash', 'universeHash', 'historicalDatasetSha256', 'products'];
  if (!pin || Object.keys(pin).some(key => !fields.includes(key))
      || pin.businessId !== scope.businessId || pin.scenarioId !== scope.scenarioId
      || !D.validRevision(pin.dataVersion) || !D.validDay(pin.asOf) || !D.validDay(pin.observationsClosedThrough)
      || pin.observationsClosedThrough >= pin.asOf || typeof pin.capturedAtUtc !== 'string'
      || !Number.isFinite(Date.parse(pin.capturedAtUtc))
      || !['snapshotHash', 'universeHash', 'historicalDatasetSha256'].every(key => /^[a-f0-9]{64}$/.test(pin[key] || ''))
      || !Array.isArray(pin.products) || !pin.products.length) fail('SNAPSHOT_MISMATCH');
  if (pin.products.length > MAX_PRODUCTS) fail('IMPACT_SIZE_LIMIT');
  if (pin.products.some(row => !row || Object.keys(row).some(key => !['sku', 'productName'].includes(key))
      || typeof row.sku !== 'string' || !row.sku || row.sku.length > 160
      || (row.productName !== null && (typeof row.productName !== 'string' || row.productName.length > 200)))
      || new Set(pin.products.map(row => row.sku)).size !== pin.products.length
      || pin.universeHash !== digest(pin.products)) fail('SNAPSHOT_MISMATCH');
  checkSize(pin);
  return pin;
}
function delta(oldValue, newValue) {
  const old = finite(oldValue) ? oldValue : null, next = finite(newValue) ? newValue : null;
  if (old === null || next === null) return { old, new: next, delta: null, deltaPct: null, direction: 'NOT_COMPARABLE' };
  const difference = next - old;
  const pct = old !== 0 ? (100 * difference) / old : null;
  if (!Number.isFinite(difference) || (pct !== null && !Number.isFinite(pct))) fail('IMPACT_SCORING_INVALID');
  return { old, new: next, delta: difference, deltaPct: pct,
    direction: difference === 0 ? 'UNCHANGED' : difference > 0 ? 'INCREASED' : 'DECREASED' };
}
function buildPrediction(row, results = [], failureReason = null) {
  const pin = row.impact.prediction?.snapshot;
  if (pin) validatePin(pin, row);
  const exactVersions = versions(row);
  const identity = digest({ executionId: row.executionId, snapshot: pin || null, versions: exactVersions });
  if (!pin) return { status: 'NOT_CAPTURED', reasonCode: failureReason || 'SNAPSHOT_NOT_AVAILABLE',
    prediction: { kind: 'MODEL_ATTRIBUTED_IMPACT', idempotencyKey: identity, versions: exactVersions,
      detail: [], snapshot: null } };
  if (!Array.isArray(results) || results.length > 2 || new Set(results.map(r => r.horizonDays)).size !== results.length) {
    fail('IMPACT_SCORING_INVALID');
  }
  const maps = new Map();
  for (const result of results) {
    const expected = exactVersions.find(h => h.horizonDays === result.horizonDays);
    const evidence = row.perHorizon.find(h => h.horizonDays === result.horizonDays);
    const allowed = evidence?.resultStatus === 'PROMOTED' && evidence.promotionDecision === 'PROMOTED'
      && evidence.activeChangeSource === 'EXECUTION' && evidence.candidateVersion === evidence.activeVersionAfter
      || evidence?.resultStatus !== 'PROMOTED' && evidence?.activeChangeSource === 'NONE'
      && ['NOT_PROMOTED', 'NOT_EVALUATED'].includes(evidence?.promotionDecision)
      && evidence?.activeVersionBefore != null && evidence.activeVersionBefore === evidence.activeVersionAfter;
    if (!allowed || !expected || !Number.isSafeInteger(expected.beforeVersion) || expected.beforeVersion < 1
        || !Number.isSafeInteger(expected.afterVersion) || expected.afterVersion < 1
        || result.beforeVersion !== expected.beforeVersion || result.afterVersion !== expected.afterVersion
        || result.dataVersion !== pin.dataVersion || result.snapshotHash !== pin.snapshotHash
        || !Array.isArray(result.rows) || result.rows.length !== pin.products.length
        || new Set(result.rows.map(r => r.sku)).size !== pin.products.length
        || result.rows.some(r => !pin.products.some(p => p.sku === r.sku))) fail('SNAPSHOT_MISMATCH');
    for (const r of result.rows) if (![r.oldPrediction, r.newPrediction].every(value => value === null || finite(value))) {
      fail('IMPACT_SCORING_INVALID');
    }
    maps.set(result.horizonDays, new Map(result.rows.map(r => [r.sku, r])));
  }
  const detail = pin.products.map(product => ({ ...product,
    p7: delta(maps.get(7)?.get(product.sku)?.oldPrediction, maps.get(7)?.get(product.sku)?.newPrediction),
    p14: delta(maps.get(14)?.get(product.sku)?.oldPrediction, maps.get(14)?.get(product.sku)?.newPrediction) }));
  const counts = field => ({ increasedCount: detail.filter(r => r[field].direction === 'INCREASED').length,
    decreasedCount: detail.filter(r => r[field].direction === 'DECREASED').length,
    unchangedCount: detail.filter(r => r[field].direction === 'UNCHANGED').length,
    notComparableCount: detail.filter(r => r[field].direction === 'NOT_COMPARABLE').length });
  const comparable = detail.filter(r => r.p7.direction !== 'NOT_COMPARABLE' && r.p14.direction !== 'NOT_COMPARABLE');
  const summary = { totalProductsEvaluated: detail.length, comparableProductsCount: comparable.length,
    predictionChangedCount: comparable.filter(r => r.p7.direction !== 'UNCHANGED' || r.p14.direction !== 'UNCHANGED').length,
    predictionUnchangedCount: comparable.filter(r => r.p7.direction === 'UNCHANGED' && r.p14.direction === 'UNCHANGED').length,
    notComparableCount: detail.length - comparable.length, p7: counts('p7'), p14: counts('p14') };
  const any = detail.some(r => r.p7.direction !== 'NOT_COMPARABLE' || r.p14.direction !== 'NOT_COMPARABLE');
  const status = comparable.length === detail.length ? 'COMPLETE' : any ? 'PARTIAL' : 'NOT_CAPTURED';
  const prediction = { kind: 'MODEL_ATTRIBUTED_IMPACT', snapshot: pin, idempotencyKey: identity,
    versions: exactVersions, summary, detail };
  checkSize(prediction);
  return { status, reasonCode: status === 'COMPLETE' ? null : failureReason || 'PARTIAL_HORIZON_COMPARISON', prediction };
}
module.exports = { MAX_PRODUCTS, MAX_BYTES, FINAL, promoted, versions, digest, delta, validatePin, checkSize, buildPrediction };
