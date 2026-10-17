'use strict';
const P = require('./forecastPredictionImpactDomain');
const D = require('./forecastMlUpdateExecutionDomain');
const config = require('../config/v3Operational');
const { logicalHash } = require('./v3OperationalSnapshotService');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeReason = error => Object.hasOwn(D.REASONS, error?.code) ? error.code : 'IMPACT_SCORING_FAILED';
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function pinFromSnapshot(envelope, products, scope) {
  const m = envelope?.snapshot?.metadata;
  if (envelope?.mode !== 'LIVE' || !m || envelope.dataVersion !== m.dataVersion
      || m.businessId !== scope.businessId || m.scenarioId !== scope.scenarioId
      || m.historicalDatasetSha256 !== config.sourceSha256) fail('SNAPSHOT_MISMATCH');
  const { capturedAtUtc, snapshotHash, payloadBytes, ...hashMetadata } = m;
  if (logicalHash({ ...envelope.snapshot, metadata: hashMetadata }) !== snapshotHash) fail('SNAPSHOT_MISMATCH');
  const universe = products.map(p => ({ sku: p.sku, productName: p.productName ?? null }))
    .sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  return P.validatePin({ businessId: m.businessId, scenarioId: m.scenarioId,
    dataVersion: m.dataVersion, asOf: m.asOfDate, capturedAtUtc,
    observationsClosedThrough: m.observationsClosedThrough, snapshotHash,
    historicalDatasetSha256: m.historicalDatasetSha256, universeHash: P.digest(universe), products: universe }, scope);
}

function productionProducts(snapshot) {
  const path = require('node:path');
  const catalog = JSON.parse(require('node:fs').readFileSync(path.resolve(__dirname,
    '../../../data/minimarket-pasco-v3/products.json'), 'utf8')).catalog;
  const names = new Map(catalog.map(p => [p.sku, p.name ?? p.productName ?? null]));
  for (const change of snapshot.catalogChanges) if (change.entityType === 'product') {
    const after = change.projection?.after;
    if (after?.sku) names.set(after.sku, after.name ?? null);
  }
  return snapshot.stockStates.map(p => ({ sku: p.sku, productName: names.get(p.sku) ?? null }));
}

function createForecastPredictionImpact({ service, scope, snapshotBuilder, readRevision,
  products = productionProducts, auditModels, score, inventoryScore, clock = () => new Date(), pendingReader } = {}) {
  let memory = new Map();
  const get = executionId => service.getExecution({ ...scope, executionId });
  const args = row => ({ ...scope, executionId: row.executionId, expectedVersion: row.writeVersion });
  async function resolveSnapshot(row) {
    const pin = row.impact.prediction?.snapshot;
    if (!pin) fail('SNAPSHOT_NOT_AVAILABLE');
    P.validatePin(pin, scope);
    const cached = memory.get(row.executionId);
    if (cached?.pinHash === P.digest(pin)) return cached.snapshot;
    let revision;
    try { revision = await readRevision(scope.businessId); } catch { fail('SNAPSHOT_NOT_AVAILABLE'); }
    if (revision !== pin.dataVersion) fail('SNAPSHOT_MISMATCH');
    let rebuilt;
    try { rebuilt = await snapshotBuilder({ businessId: scope.businessId, asOfDate: pin.asOf,
      now: new Date(pin.capturedAtUtc), minimumDataVersion: pin.dataVersion }); }
    catch { fail('SNAPSHOT_NOT_AVAILABLE'); }
    const checked = pinFromSnapshot(rebuilt, await products(rebuilt.snapshot), scope);
    if (P.digest(checked) !== P.digest(pin)) fail('SNAPSHOT_MISMATCH');
    const snapshot = freeze(structuredClone(rebuilt.snapshot));
    memory.set(row.executionId, { pinHash: P.digest(pin), snapshot });
    return snapshot;
  }
  const inventory = inventoryScore ? require('./forecastInventoryImpact').createForecastInventoryImpact({
    service, scope, resolveSnapshot, score: inventoryScore }) : null;
  async function finishInventory(executionId, fallback) {
    if (!inventory) return fallback;
    if (!(await get(executionId))?.impact.prediction?.finalizedAt) return fallback;
    const result = await inventory.calculate({ executionId });
    if ((await get(executionId))?.impact.inventory?.completedAt) memory.delete(executionId);
    return result;
  }
  async function capture({ executionId, minimumDataVersion }) {
    try {
      let row = await get(executionId);
      if (!row || row.impact.prediction || row.status !== 'RUNNING' || P.promoted(row)) return;
      let pin = null, snapshot = null, reasonCode = null;
      try {
        const now = clock(), asOfDate = require('./v3OperationalSnapshotService').limaDate(now);
        const envelope = await snapshotBuilder({ businessId: scope.businessId, asOfDate, now, minimumDataVersion });
        snapshot = freeze(structuredClone(envelope.snapshot));
        pin = pinFromSnapshot({ ...envelope, snapshot }, await products(snapshot), scope);
      } catch (error) { reasonCode = safeReason(error) === 'IMPACT_SCORING_FAILED' ? 'SNAPSHOT_NOT_AVAILABLE' : safeReason(error); }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          row = await service.pinPredictionSnapshot({ ...args(row), snapshot: pin, reasonCode });
          if (pin) memory.set(executionId, { pinHash: P.digest(pin), snapshot });
          return { status: pin ? 'PINNED' : 'NOT_CAPTURED', reasonCode };
        } catch (error) {
          if (error.code !== 'EXECUTION_CONFLICT') throw error;
          row = await get(executionId);
          if (!row || row.impact.prediction) return;
        }
      }
    } catch { return { status: 'NOT_CAPTURED', reasonCode: 'SNAPSHOT_NOT_AVAILABLE' }; }
  }
  async function finish(row, results, reasonCode) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (row.impact.prediction?.finalizedAt) return { status: row.impact.status, reasonCode: 'IMPACT_ALREADY_FINALIZED' };
      try {
        const final = await service.finalizePredictionImpact({ ...args(row), results, reasonCode, includeInventory: !!inventory });
        if (!inventory) memory.delete(row.executionId);
        return { status: final.impact.status, reasonCode: final.impact.reasonCode };
      } catch (error) {
        if (error.code === 'IMPACT_ALREADY_FINALIZED') return { status: (await get(row.executionId)).impact.status,
          reasonCode: 'IMPACT_ALREADY_FINALIZED' };
        if (error.code === 'EXECUTION_CONFLICT') { row = await get(row.executionId); continue; }
        if (attempt === 0) { results = []; reasonCode = safeReason(error); row = await get(row.executionId); continue; }
        throw error;
      }
    }
    return { status: 'PENDING', reasonCode: null };
  }
  async function calculate({ executionId }) {
    try {
      const row = await get(executionId);
      if (!row || !P.promoted(row)) return { status: 'NOT_APPLICABLE', reasonCode: 'NO_MODEL_PROMOTION' };
      if (!D.TERMINAL.includes(row.status)) return { status: 'PENDING', reasonCode: null };
      if (row.impact.prediction?.finalizedAt) return await finishInventory(executionId,
        { status: row.impact.status, reasonCode: 'IMPACT_ALREADY_FINALIZED' });
      const pin = row.impact.prediction?.snapshot;
      if (!pin) return await finishInventory(executionId,
        await finish(row, [], row.impact.prediction?.captureReason || 'SNAPSHOT_NOT_AVAILABLE'));
      let results = [], reasonCode = null;
      try {
        const snapshot = await resolveSnapshot(row);
        const models = await auditModels.loadForExecution({ ...scope, executionId, tolerateUnavailable: true });
        const output = models.horizons.some(h => h.comparable)
          ? await score({ snapshot, audit: models, products: pin.products }) : { horizons: [] };
        if (!output || !Array.isArray(output.horizons)) fail('IMPACT_SCORING_INVALID');
        results = output.horizons;
        reasonCode = output.errors?.[0]?.reasonCode || models.horizons.find(h => !h.comparable)?.reasonCode || null;
        if (!Object.hasOwn(D.REASONS, reasonCode)) reasonCode = reasonCode ? 'PARTIAL_HORIZON_COMPARISON' : null;
      } catch (error) { reasonCode = safeReason(error); }
      return await finishInventory(executionId, await finish(row, results, reasonCode));
    } catch { return { status: 'PENDING', reasonCode: 'IMPACT_SCORING_FAILED' }; }
  }
  async function recoverPending() {
    // One bounded recovery per RUN; never used from a GET or CHECK/STATUS.
    try { for (const executionId of await pendingReader?.() || []) await calculate({ executionId }); } catch { /* next cycle */ }
  }
  return { capture, calculate, recoverPending };
}
module.exports = { createForecastPredictionImpact, pinFromSnapshot, productionProducts };
