'use strict';
const P = require('./forecastPredictionImpactDomain');
const D = require('./forecastMlUpdateExecutionDomain');
const MAX_BYTES = 192 * 1024; // prediction + inventory <=448 KiB per attempt.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const statuses = ['COMPLETE', 'PARTIAL', 'NOT_CAPTURED'];
const numeric = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
function predictionStatus(row) {
  if (statuses.includes(row.impact.predictionStatus)) return row.impact.predictionStatus;
  const detail = row.impact.prediction?.detail || [];
  if (!detail.length) return 'NOT_CAPTURED';
  const comparable = h => h?.direction && h.direction !== 'NOT_COMPARABLE';
  if (detail.every(r => comparable(r.p7) && comparable(r.p14))) return 'COMPLETE';
  return detail.some(r => comparable(r.p7) || comparable(r.p14)) ? 'PARTIAL' : 'NOT_CAPTURED';
}
const globalStatus = (prediction, inventory) => prediction === 'PENDING' || inventory === 'PENDING' ? 'PENDING'
  : prediction === 'COMPLETE' && inventory === 'COMPLETE' ? 'COMPLETE'
    : [prediction, inventory].some(status => ['COMPLETE', 'PARTIAL'].includes(status)) ? 'PARTIAL' : 'NOT_CAPTURED';
function identity(row) {
  const p = row.impact.prediction, s = p?.snapshot;
  return P.digest({ kind: 'MODEL_ATTRIBUTED_INVENTORY_IMPACT', executionId: row.executionId,
    predictionIdentity: p?.idempotencyKey || null, snapshotHash: s?.snapshotHash || null,
    dataVersion: s?.dataVersion || null, universeHash: s?.universeHash || null, versions: p?.versions || [] });
}
function checkSize(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) fail('IMPACT_SIZE_LIMIT');
}
function buildInventory(row, result, reasonCode) {
  const prediction = row.impact.prediction, pin = prediction?.snapshot;
  const base = { kind: 'MODEL_ATTRIBUTED_INVENTORY_IMPACT', idempotencyKey: identity(row),
    predictionIdentity: prediction?.idempotencyKey || null, rankingMetric: 'stockout_risk' };
  if (!pin || !result) return { ...base, status: 'NOT_CAPTURED', reasonCode: D.safeReason(reasonCode || 'INVENTORY_IMPACT_NOT_CAPTURED'), details: [] };
  P.validatePin(pin, row);
  if (result.predictionIdentity !== prediction.idempotencyKey || result.snapshotHash !== pin.snapshotHash
      || result.dataVersion !== pin.dataVersion || result.asOf !== pin.asOf
      || result.observationsClosedThrough !== pin.observationsClosedThrough
      || P.digest(result.skuUniverse) !== P.digest(pin.products.map(p => p.sku))
      || !Array.isArray(result.before) || !Array.isArray(result.after)) fail('SNAPSHOT_MISMATCH');
  const lookup = values => {
    if (values.length !== pin.products.length || new Set(values.map(r => r.sku)).size !== values.length) fail('SNAPSHOT_MISMATCH');
    for (const r of values) {
      if (!pin.products.some(p => p.sku === r.sku) || ![null, 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(r.risk)
          || ![null, true, false].includes(r.shouldReorder) || ![r.recommendedQty, r.reorderPoint, r.daysCover].every(numeric)
          || !['AVAILABLE', 'PARTIAL'].includes(r.availability) || !Array.isArray(r.reasonCodes)
          || r.reasonCodes.length > 32 || r.reasonCodes.some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code))) {
        fail('INVENTORY_IMPACT_INVALID');
      }
    }
    return new Map(values.map(r => [r.sku, r]));
  };
  const old = lookup(result.before), next = lookup(result.after);
  const forecast = new Map((prediction.detail || []).map(p => [p.sku, p]));
  const comparableForecast = f => !!f && [f.p7, f.p14].every(h => h?.direction
    && h.direction !== 'NOT_COMPARABLE' && typeof h.old === 'number' && Number.isFinite(h.old)
    && typeof h.new === 'number' && Number.isFinite(h.new));
  const ranked = value => Array.isArray(value) && value.length === pin.products.length
    && new Set(value).size === value.length && value.every(sku => old.has(sku));
  const rankingComparable = result.ranking?.metric === 'stockout_risk'
    && pin.products.every(p => comparableForecast(forecast.get(p.sku)))
    && ranked(result.ranking.before) && ranked(result.ranking.after)
    && [...old.values(), ...next.values()].every(r => r.risk !== null && r.availability === 'AVAILABLE');
  const oldPositions = new Map((rankingComparable ? result.ranking.before : []).map((sku, i) => [sku, i + 1]));
  const newPositions = new Map((rankingComparable ? result.ranking.after : []).map((sku, i) => [sku, i + 1]));
  let comparableProductsCount = 0, anyComparable = false;
  const details = pin.products.map(product => {
    const a = old.get(product.sku), b = next.get(product.sku), f = forecast.get(product.sku);
    const forecastComparable = comparableForecast(f);
    const pair = (before, after, type) => ({ before, after,
      [type]: forecastComparable && before !== null && after !== null
        ? type === 'delta' ? after - before : before !== after : null });
    const risk = pair(a.risk, b.risk, 'changed'), shouldReorder = pair(a.shouldReorder, b.shouldReorder, 'changed');
    const recommendedQty = pair(a.recommendedQty, b.recommendedQty, 'delta');
    const reorderPoint = pair(a.reorderPoint, b.reorderPoint, 'delta');
    const cover = pair(a.daysCover, b.daysCover, 'delta');
    const full = forecastComparable && a.availability === 'AVAILABLE' && b.availability === 'AVAILABLE'
      && [risk.changed, shouldReorder.changed, recommendedQty.delta, reorderPoint.delta, cover.delta].every(v => v !== null);
    if (full) comparableProductsCount++;
    if ([risk.changed, shouldReorder.changed, recommendedQty.delta, reorderPoint.delta, cover.delta].some(v => v !== null)) anyComparable = true;
    return { ...product, risk, shouldReorder, recommendedQty, reorderPoint,
      coverage: { daysCoverBefore: cover.before, daysCoverAfter: cover.after, delta: cover.delta },
      ranking: { positionBefore: forecastComparable ? oldPositions.get(product.sku) ?? null : null,
        positionAfter: forecastComparable ? newPositions.get(product.sku) ?? null : null,
        delta: rankingComparable && forecastComparable ? newPositions.get(product.sku) - oldPositions.get(product.sku) : null,
        status: rankingComparable && forecastComparable ? 'COMPARABLE' : 'NOT_COMPARABLE' },
      availability: { before: a.availability, after: b.availability,
        reasonCodesBefore: a.reasonCodes, reasonCodesAfter: b.reasonCodes } };
  });
  const changed = field => details.filter(r => r[field].changed === true).length;
  const deltaChanged = field => details.filter(r => r[field].delta !== null && r[field].delta !== 0).length;
  const summary = { totalProductsEvaluated: details.length, comparableProductsCount,
    riskChangedCount: changed('risk'), reorderDecisionChangedCount: changed('shouldReorder'),
    recommendedQtyChangedCount: deltaChanged('recommendedQty'), reorderPointChangedCount: deltaChanged('reorderPoint'),
    coverageChangedCount: deltaChanged('coverage'), rankingChangedCount: deltaChanged('ranking'),
    unavailableCount: details.filter(r => r.availability.before !== 'AVAILABLE' || r.availability.after !== 'AVAILABLE').length,
    notComparableCount: details.length - comparableProductsCount };
  const status = comparableProductsCount === details.length && rankingComparable ? 'COMPLETE' : anyComparable ? 'PARTIAL' : 'NOT_CAPTURED';
  const output = { ...base, status, reasonCode: status === 'COMPLETE' ? null : D.safeReason(reasonCode || 'INVENTORY_PARTIAL_COMPARISON'), summary, details };
  checkSize(output);
  return output;
}
module.exports = { MAX_BYTES, predictionStatus, globalStatus, identity, checkSize, buildInventory };
