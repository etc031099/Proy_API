'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config/v3Operational');
const P = require('../src/services/forecastPredictionImpactDomain');
const I = require('../src/services/forecastInventoryImpactDomain');
const { fixture } = require('./helpers/forecastExecutionFixture');
const { logicalHash } = require('../src/services/v3OperationalSnapshotService');
const { createForecastPredictionImpact } = require('../src/services/forecastPredictionImpact');
const { createForecastInventoryImpact } = require('../src/services/forecastInventoryImpact');
const scope = { businessId: config.businessId, scenarioId: config.scenarioId };
const now = new Date('2026-10-17T18:00:00Z');

function resultFor(prediction) {
  const pin = prediction.snapshot, skus = pin.products.map(p => p.sku);
  const rows = skus.map(sku => ({ sku, risk: 'LOW', shouldReorder: false, recommendedQty: 12,
    reorderPoint: 10, daysCover: 7, availability: 'AVAILABLE', reasonCodes: [] }));
  return { predictionIdentity: prediction.idempotencyKey, snapshotHash: pin.snapshotHash,
    dataVersion: pin.dataVersion, asOf: pin.asOf, observationsClosedThrough: pin.observationsClosedThrough,
    skuUniverse: skus, before: rows, after: structuredClone(rows),
    ranking: { metric: 'stockout_risk', before: skus, after: [...skus] } };
}
async function setup({ enabled = true, count = 2 } = {}) {
  const f = fixture(), calls = { builds: 0, models: 0, prediction: 0, inventory: 0 };
  const control = { revision: '83', scoreError: false, inventoryResult: null };
  let row = await f.service.createExecution({ ...scope, triggerSource: 'CLI', cliInvocationKey: 'inventory-impact' });
  const executionId = row.executionId, input = { ...scope, executionId };
  row = await f.service.startExecution({ ...input, expectedVersion: row.writeVersion });
  const snapshot = { metadata: { ...scope, dataVersion: '83', asOfDate: '2026-10-17',
    observationsClosedThrough: '2026-10-16', historicalDatasetSha256: config.sourceSha256 },
    stockStates: Array.from({ length: count }, (_, i) => ({ sku: `SKU-${i}`, onHand: 8 })),
    sales: [{ units: 3 }], purchases: [{ units: 5 }], catalogChanges: [], closedSalesDays: [] };
  snapshot.metadata.snapshotHash = logicalHash(snapshot);
  snapshot.metadata.capturedAtUtc = now.toISOString();
  const get = () => f.service.getExecution(input);
  const make = (enable = enabled) => createForecastPredictionImpact({ service: f.service, scope,
    clock: () => now, readRevision: async () => control.revision,
    snapshotBuilder: async () => { calls.builds++; return { mode: 'LIVE', dataVersion: '83', snapshot: structuredClone(snapshot) }; },
    products: data => data.stockStates.map(p => ({ sku: p.sku, productName: 'Producto' })),
    auditModels: { loadForExecution: async () => { calls.models++; return { horizons: [7, 14].map(horizonDays =>
      ({ horizonDays, comparable: true, beforeVersion: 1, afterVersion: 2 })) }; } },
    score: async ({ snapshot: fixed, audit, products }) => {
      calls.prediction++; assert.equal(fixed.stockStates[0].onHand, 8);
      return { horizons: audit.horizons.map(h => ({ ...h, dataVersion: '83', snapshotHash: fixed.metadata.snapshotHash,
        rows: products.map(p => ({ sku: p.sku, oldPrediction: h.horizonDays, newPrediction: h.horizonDays + 1, reasonCode: null })) })) };
    }, inventoryScore: enable ? async ({ snapshot: fixed, prediction }) => {
      calls.inventory++;
      assert.equal(fixed.stockStates[0].onHand, 8); assert.equal(fixed.sales[0].units, 3);
      assert.equal(fixed.purchases[0].units, 5); assert.equal(fixed.metadata.dataVersion, '83');
      assert.equal(prediction.snapshot.snapshotHash, fixed.metadata.snapshotHash);
      if (control.scoreError) throw new Error('private secret, never persist');
      return control.inventoryResult || resultFor(prediction);
    } : undefined });
  async function promote() {
    let r = await get();
    for (const horizonDays of [7, 14]) r = await f.service.recordHorizonResult({ ...input, expectedVersion: r.writeVersion,
      result: { horizonDays, resultStatus: 'PROMOTED', promotionDecision: 'PROMOTED', activeVersionBefore: 1,
        activeVersionAfter: 2, candidateVersion: 2, candidateStatus: 'ACTIVE', activeChangeSource: 'EXECUTION',
        trainingJobReference: 'job', trainedDataVersion: '83' } });
    return f.service.transitionExecution({ ...input, expectedVersion: r.writeVersion, status: 'PROMOTED' });
  }
  const adapter = make();
  await adapter.capture({ executionId }); await promote();
  return { ...f, calls, control, get, make, adapter, input, snapshot, executionId };
}
async function predictionRow() {
  const f = await setup({ enabled: false }); await f.adapter.calculate(f.input); return f;
}

test('integrated worker compares original snapshot, persists exact Inventory and leaves promotion unchanged', async () => {
  const f = await setup({ count: 80 });
  f.snapshot.stockStates[0].onHand = 999; f.control.revision = '84';
  assert.equal((await f.adapter.calculate(f.input)).status, 'COMPLETE');
  const row = await f.get(), report = row.impact.inventory;
  assert.equal(row.status, 'PROMOTED'); assert.equal(row.impact.predictionStatus, 'COMPLETE');
  assert.equal(report.kind, 'MODEL_ATTRIBUTED_INVENTORY_IMPACT');
  assert.equal(report.summary.totalProductsEvaluated, 80); assert.equal(report.summary.comparableProductsCount, 80);
  assert.equal(report.details[0].recommendedQty.before, 12); assert.equal(report.details[0].shouldReorder.before, false);
  assert.equal(report.details[0].risk.changed, false); assert.equal(report.details[0].coverage.delta, 0);
  assert.equal(report.summary.rankingChangedCount, 0);
  assert.deepEqual(f.calls, { builds: 1, models: 1, prediction: 1, inventory: 1 });
  assert.ok(report.completedAt); assert.ok(report.idempotencyKey);
  const text = JSON.stringify(report);
  for (const forbidden of ['stockStates', 'artifactBase64', 'dailyRows', 'private secret']) assert.equal(text.includes(forbidden), false);
});
test('exact risk/reorder/quantity/point/coverage deltas and canonical ranking positions', async () => {
  const f = await predictionRow(), row = await f.get(), raw = resultFor(row.impact.prediction);
  Object.assign(raw.after[0], { risk: 'HIGH', shouldReorder: true, recommendedQty: 17, reorderPoint: 13, daysCover: 3.5 });
  raw.before[1].shouldReorder = true; raw.after[1].shouldReorder = false;
  raw.ranking.after.reverse();
  const report = I.buildInventory(row, raw);
  assert.equal(report.status, 'COMPLETE');
  assert.deepEqual(report.details[0].recommendedQty, { before: 12, after: 17, delta: 5 });
  assert.deepEqual(report.details[0].reorderPoint, { before: 10, after: 13, delta: 3 });
  assert.equal(report.details[0].coverage.delta, -3.5);
  assert.equal(report.summary.riskChangedCount, 1); assert.equal(report.summary.reorderDecisionChangedCount, 2);
  assert.equal(report.summary.rankingChangedCount, 2); assert.equal(report.details[0].ranking.delta, 1);
});
test('unavailable/null is never LOW/zero and invalid ranking is not assigned a position', async () => {
  const f = await predictionRow(), row = await f.get(), raw = resultFor(row.impact.prediction);
  Object.assign(raw.before[0], { risk: null, shouldReorder: null, recommendedQty: null, reorderPoint: null,
    daysCover: null, availability: 'PARTIAL', reasonCodes: ['FORECAST_HORIZON_UNAVAILABLE'] });
  raw.ranking.before = ['SKU-1'];
  const report = I.buildInventory(row, raw);
  assert.equal(report.status, 'PARTIAL'); assert.equal(report.summary.unavailableCount, 1);
  assert.equal(report.details[0].risk.before, null); assert.equal(report.details[0].risk.changed, null);
  assert.equal(report.details[0].recommendedQty.delta, null);
  for (const r of report.details) assert.deepEqual(r.ranking, { positionBefore: null, positionAfter: null, delta: null, status: 'NOT_COMPARABLE' });
});
test('non-comparable P7/P14 never authorizes Inventory/ranking comparisons', async () => {
  const f = await predictionRow(), row = await f.get();
  row.impact.prediction.detail[0].p7 = P.delta(null, 7);
  const report = I.buildInventory(row, resultFor(row.impact.prediction));
  assert.equal(report.details[0].shouldReorder.changed, null);
  assert.equal(report.details[0].coverage.delta, null);
  assert.ok(report.details.every(r => r.ranking.status === 'NOT_COMPARABLE'));
  assert.equal(report.summary.notComparableCount, 1);
});
for (const field of ['dataVersion', 'snapshotHash', 'asOf', 'observationsClosedThrough', 'predictionIdentity', 'skuUniverse']) {
  test(`rejects mismatched ${field}`, async () => {
    const f = await predictionRow(), row = await f.get(), raw = resultFor(row.impact.prediction);
    raw[field] = field === 'skuUniverse' ? ['OTHER'] : 'WRONG';
    assert.throws(() => I.buildInventory(row, raw), { code: 'SNAPSHOT_MISMATCH' });
  });
}
test('Inventory fails safely without demoting promoted execution or replacing prediction', async () => {
  const f = await setup(); f.control.scoreError = true;
  assert.equal((await f.adapter.calculate(f.input)).status, 'PARTIAL');
  const row = await f.get(); assert.equal(row.status, 'PROMOTED');
  assert.equal(row.impact.predictionStatus, 'COMPLETE'); assert.equal(row.impact.inventory.status, 'NOT_CAPTURED');
  assert.equal(JSON.stringify(row).includes('private secret'), false);
});
test('restart after prediction finalization recovers Inventory only, without ACTIVE loads or scoring again', async () => {
  const f = await predictionRow(), before = structuredClone((await f.get()).impact.prediction);
  await f.make(true).calculate(f.input);
  const row = await f.get(); assert.equal(row.impact.inventory.status, 'COMPLETE');
  assert.deepEqual(row.impact.prediction, before);
  assert.deepEqual(f.calls, { builds: 2, models: 1, prediction: 1, inventory: 1 });
});
test('restart refuses new revision and never captures a replacement snapshot', async () => {
  const f = await predictionRow(); f.control.revision = '84'; await f.make(true).calculate(f.input);
  const row = await f.get(); assert.equal(row.impact.inventory.status, 'NOT_CAPTURED');
  assert.equal(row.impact.inventory.reasonCode, 'SNAPSHOT_MISMATCH');
  assert.equal(f.calls.builds, 1); assert.equal(f.calls.inventory, 0); assert.equal(row.status, 'PROMOTED');
});
test('restart rejects changed hash, closure or universe even at same revision', async () => {
  for (const mutate of [s => s.sales[0].units++, s => s.metadata.observationsClosedThrough = '2026-10-15',
    s => s.stockStates.push({ sku: 'OTHER', onHand: 1 })]) {
    const f = await predictionRow(); mutate(f.snapshot); await f.make(true).calculate(f.input);
    assert.equal((await f.get()).impact.inventory.reasonCode, 'SNAPSHOT_MISMATCH'); assert.equal(f.calls.inventory, 0);
  }
});
test('concurrent retries finalize once; finalized report immutable', async () => {
  const f = await predictionRow(), adapter = f.make(true);
  await Promise.all([adapter.calculate(f.input), adapter.calculate(f.input)]);
  const row = await f.get(), count = f.counts.writes;
  await adapter.calculate(f.input); assert.equal(f.counts.writes, count);
  assert.deepEqual((await f.get()).impact.inventory, row.impact.inventory);
  await assert.rejects(f.service.finalizeInventoryImpact({ ...f.input, expectedVersion: row.writeVersion,
    result: null }), { code: 'IMPACT_ALREADY_FINALIZED' });
});
test('prediction finalization atomically records pending Inventory; general status cannot bypass finalizer', async () => {
  const f = await setup();
  const r = await f.service.finalizePredictionImpact({ ...f.input, expectedVersion: (await f.get()).writeVersion,
    includeInventory: true, results: [], reasonCode: 'IMPACT_SCORING_FAILED' });
  assert.equal(r.impact.status, 'PENDING'); assert.equal(r.impact.inventory.status, 'PENDING');
  await assert.rejects(f.service.setImpactStatus({ ...f.input, expectedVersion: r.writeVersion, status: 'COMPLETE' }),
    { code: 'IMPACT_ALREADY_FINALIZED' });
});
test('tenant and scenario isolation fail before evaluation or persistence', async () => {
  const f = await predictionRow();
  for (const changed of [{ businessId: 'other' }, { scenarioId: 'other' }]) {
    const adapter = createForecastInventoryImpact({ service: f.service, scope: { ...scope, ...changed },
      resolveSnapshot: () => assert.fail('foreign context'), score: () => assert.fail('foreign score') });
    assert.equal((await adapter.calculate(f.input)).status, 'NOT_APPLICABLE');
  }
});
test('bounded report rejects oversize/duplicate/invalid fields without truncation', async () => {
  const f = await predictionRow(), row = await f.get();
  const raw = resultFor(row.impact.prediction); raw.after[0].recommendedQty = NaN;
  assert.throws(() => I.buildInventory(row, raw), { code: 'INVENTORY_IMPACT_INVALID' });
  assert.throws(() => I.checkSize({ text: 'x'.repeat(I.MAX_BYTES) }), { code: 'IMPACT_SIZE_LIMIT' });
  raw.after = [raw.after[1], raw.after[1]];
  assert.throws(() => I.buildInventory(row, raw), { code: 'SNAPSHOT_MISMATCH' });
});
test('global status reconciliation never makes prediction-only report complete', () => {
  for (const [p, i, out] of [['COMPLETE','COMPLETE','COMPLETE'], ['COMPLETE','PARTIAL','PARTIAL'],
    ['COMPLETE','NOT_CAPTURED','PARTIAL'], ['PARTIAL','COMPLETE','PARTIAL'],
    ['NOT_CAPTURED','NOT_CAPTURED','NOT_CAPTURED'], ['COMPLETE','PENDING','PENDING']]) assert.equal(I.globalStatus(p,i), out);
});
test('database interruption leaves pending Inventory recoverable without recalculating prediction', async () => {
  const f = await setup(), original = f.service.finalizeInventoryImpact;
  // Wrap the service instead of changing immutable production service methods.
  let unavailable = true;
  const recoveringService = { ...f.service, finalizeInventoryImpact: input => {
    if (unavailable) throw new Error('private database outage');
    return original(input);
  } };
  const adapter = createForecastInventoryImpact({ service: recoveringService, scope,
    resolveSnapshot: async () => f.snapshot, score: async ({ prediction }) => resultFor(prediction) });
  let row = await f.get();
  await f.service.finalizePredictionImpact({ ...f.input, expectedVersion: row.writeVersion, results: [], includeInventory: true });
  await assert.rejects(adapter.calculate(f.input));
  row = await f.get(); assert.equal(row.impact.status, 'PENDING'); assert.equal(row.status, 'PROMOTED');
  const fixed = structuredClone(row.impact.prediction);
  unavailable = false; await adapter.calculate(f.input);
  assert.ok((await f.get()).impact.inventory.completedAt);
  assert.deepEqual((await f.get()).impact.prediction, fixed);
});
test('invalid Inventory output is finalized safely, not silently truncated or repeatedly retried', async () => {
  const f = await setup(); f.control.inventoryResult = { before: [], after: [] };
  await f.adapter.calculate(f.input);
  const row = await f.get(); assert.equal(row.impact.inventory.status, 'NOT_CAPTURED');
  assert.equal(row.status, 'PROMOTED'); assert.equal(row.impact.status, 'PARTIAL');
  const count = f.calls.inventory; await f.adapter.calculate(f.input); assert.equal(f.calls.inventory, count);
});
test('Inventory Python bridge uses configured executable, dedicated internal module and safe output only', async () => {
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const { scoreInventoryImpact } = require('../src/services/forecastPredictionImpactPython');
  let received;
  const out = await scoreInventoryImpact({ prediction: { idempotencyKey: 'fixed' } }, { executable: 'configured-python',
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, 'configured-python');
      assert.deepEqual(args, ['-B', '-m', 'ml.service.v3_inventory_model_impact']);
      assert.equal(options.cwd, require('node:path').resolve(__dirname, '../..'));
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {}; let body = '';
      child.stdin.on('data', chunk => { body += chunk; });
      child.stdin.on('finish', () => {
        received = JSON.parse(body); child.stderr.write('private data is discarded');
        child.stdout.write(JSON.stringify({ ok: true, result: { before: [], after: [] } }));
        child.emit('close', 0);
      });
      return child;
    } });
  assert.deepEqual(received, { prediction: { idempotencyKey: 'fixed' } });
  assert.deepEqual(out, { before: [], after: [] });
});
