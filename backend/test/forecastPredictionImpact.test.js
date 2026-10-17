'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config/v3Operational');
const P = require('../src/services/forecastPredictionImpactDomain');
const { logicalHash } = require('../src/services/v3OperationalSnapshotService');
const { createForecastPredictionImpact, pinFromSnapshot } = require('../src/services/forecastPredictionImpact');
const { fixture } = require('./helpers/forecastExecutionFixture');
const scope = { businessId: config.businessId, scenarioId: config.scenarioId };
const NOW = new Date('2026-10-17T18:00:00Z');
function snapshot(count = 2) {
  const payload = { metadata: { ...scope, dataVersion: '83', asOfDate: '2026-10-17',
    capturedAtUtc: NOW.toISOString(), observationsClosedThrough: '2026-10-16',
    historicalDatasetSha256: config.sourceSha256 },
    sales: [{ units: 3 }], purchases: [{ units: 5 }], stockStates: Array.from({ length: count }, (_, i) => ({ sku: `SKU-${i}`, onHand: 8 })),
    catalogChanges: [], closedSalesDays: [] };
  const { capturedAtUtc, ...metadata } = payload.metadata;
  payload.metadata.snapshotHash = logicalHash({ ...payload, metadata });
  return { mode: 'LIVE', dataVersion: '83', snapshot: payload };
}
async function setup({ count = 2, values = { 7: [10, 12], 14: [20, 18] } } = {}) {
  const f = fixture(); let row = await f.service.createExecution({ ...scope, triggerSource: 'CLI', cliInvocationKey: 'impact-test' });
  row = await f.service.startExecution({ ...scope, executionId: row.executionId, expectedVersion: row.writeVersion });
  const executionId = row.executionId, input = { ...scope, executionId }, calls = { builds: 0, scores: 0, modelReads: 0 };
  const source = snapshot(count), control = { revision: '83', failedScore: false, missingHorizon: null, mismatchResult: false, productName: 'Producto' };
  const products = data => data.stockStates.map(p => ({ sku: p.sku, productName: control.productName }));
  const get = () => f.service.getExecution(input);
  const make = () => createForecastPredictionImpact({ service: f.service, scope, clock: () => NOW,
    snapshotBuilder: async options => {
      calls.builds++; assert.equal(options.asOfDate, '2026-10-17');
      assert.equal(options.now.toISOString(), NOW.toISOString()); return structuredClone(source);
    }, readRevision: async () => control.revision, products,
    auditModels: { loadForExecution: async () => {
      calls.modelReads++;
      const current = await get();
      return { horizons: current.perHorizon.map(h => ({ horizonDays: h.horizonDays,
        beforeVersion: h.activeVersionBefore, afterVersion: h.activeVersionAfter,
        comparable: h.horizonDays !== control.missingHorizon,
        reasonCode: h.horizonDays === control.missingHorizon ? 'BEFORE_MODEL_NOT_AVAILABLE' : null })) };
    } },
    score: async ({ snapshot: fixed, audit, products: universe }) => {
      calls.scores++;
      assert.equal(fixed.sales[0].units, 3); assert.equal(fixed.purchases[0].units, 5);
      assert.equal(fixed.stockStates[0].onHand, 8);
      if (control.failedScore) throw new Error('secret must never persist');
      return { horizons: audit.horizons.filter(h => h.comparable).map(h => ({
        horizonDays: h.horizonDays, beforeVersion: h.beforeVersion, afterVersion: h.afterVersion,
        dataVersion: control.mismatchResult ? '84' : fixed.metadata.dataVersion,
        snapshotHash: fixed.metadata.snapshotHash,
        rows: universe.map(p => ({ sku: p.sku, oldPrediction: values[h.horizonDays][0],
          newPrediction: h.beforeVersion === h.afterVersion ? values[h.horizonDays][0] : values[h.horizonDays][1], reasonCode: null })) })) };
    }, pendingReader: async () => [executionId] });
  async function promote(mixed = false) {
    let current = await get();
    for (const horizonDays of [7, 14]) {
      const unchanged = mixed && horizonDays === 14;
      current = await f.service.recordHorizonResult({ ...input, expectedVersion: current.writeVersion,
        result: { horizonDays, resultStatus: unchanged ? 'EVALUATED_NO_PROMOTION' : 'PROMOTED',
          promotionDecision: unchanged ? 'NOT_PROMOTED' : 'PROMOTED', activeVersionBefore: 1,
          activeVersionAfter: unchanged ? 1 : 2, candidateVersion: unchanged ? null : 2,
          candidateStatus: unchanged ? null : 'ACTIVE', activeChangeSource: unchanged ? 'NONE' : 'EXECUTION',
          trainingJobReference: 'job', trainedDataVersion: '83' } });
      if (!unchanged) current = await f.service.setImpactStatus({ ...input, expectedVersion: current.writeVersion, status: 'PENDING' });
    }
    return await f.service.transitionExecution({ ...input, expectedVersion: current.writeVersion, status: mixed ? 'PARTIAL' : 'PROMOTED' });
  }
  return { ...f, executionId, input, calls, source, control, make, get, promote, adapter: make(), products };
}
for (const [old, next, expected] of [
  [10, 12, { delta: 2, deltaPct: 20, direction: 'INCREASED' }],
  [20, 15, { delta: -5, deltaPct: -25, direction: 'DECREASED' }],
  [3, 4, { delta: 1, deltaPct: 100 / 3, direction: 'INCREASED' }],
  [7, 7, { delta: 0, deltaPct: 0, direction: 'UNCHANGED' }],
  [0, 2, { delta: 2, deltaPct: null, direction: 'INCREASED' }],
  [null, 2, { delta: null, deltaPct: null, direction: 'NOT_COMPARABLE' }],
  [2, null, { delta: null, deltaPct: null, direction: 'NOT_COMPARABLE' }],
]) test(`exact delta ${old} -> ${next}`, () => {
  const result = P.delta(old, next);
  for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value);
  if (old === null) assert.equal(result.old, null);
});
test('snapshot fingerprint stable across object key ordering and rejects changed content', () => {
  const data = snapshot(), products = data.snapshot.stockStates.map(p => ({ sku: p.sku, productName: null }));
  const pin = pinFromSnapshot(data, products, scope);
  const shuffled = structuredClone(data); shuffled.snapshot.metadata = Object.fromEntries(Object.entries(shuffled.snapshot.metadata).reverse());
  assert.equal(pinFromSnapshot(shuffled, products, scope).snapshotHash, pin.snapshotHash);
  shuffled.snapshot.sales[0].units++;
  assert.throws(() => pinFromSnapshot(shuffled, products, scope), { code: 'SNAPSHOT_MISMATCH' });
});
test('promotion PENDING preserves pre-promotion snapshot; final details reconcile exactly', async () => {
  const f = await setup({ count: 80 }); await f.adapter.capture({ executionId: f.executionId });
  const pin = (await f.get()).impact.prediction.snapshot;
  assert.equal(pin.products.length, 80);
  await f.promote(); assert.equal((await f.get()).impact.status, 'PENDING');
  assert.deepEqual((await f.get()).impact.prediction.snapshot, pin);
  const result = await f.adapter.calculate({ executionId: f.executionId });
  assert.equal(result.status, 'COMPLETE');
  const row = await f.get(), p = row.impact.prediction;
  assert.equal(row.status, 'PROMOTED'); assert.equal(p.summary.totalProductsEvaluated, 80);
  assert.equal(p.summary.comparableProductsCount, 80); assert.equal(p.summary.predictionChangedCount, 80);
  assert.equal(p.summary.p7.increasedCount, 80); assert.equal(p.summary.p14.decreasedCount, 80);
  assert.deepEqual(p.detail.map(d => d.sku), pin.products.map(d => d.sku));
  assert.equal(p.detail[0].p7.delta, 2); assert.equal(p.detail[0].p14.deltaPct, -10);
  assert.equal(p.snapshot.observationsClosedThrough, '2026-10-16');
  assert.equal(f.calls.builds, 1);
});
for (const kind of ['sale', 'purchase', 'stock adjustment']) test(`later ${kind} never enters in-memory pinned comparison`, async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId });
  f.source.snapshot.sales[0].units = 999; f.source.snapshot.purchases[0].units = 999;
  f.source.snapshot.stockStates[0].onHand = 999; f.control.revision = '84';
  await f.promote(); assert.equal((await f.adapter.calculate({ executionId: f.executionId })).status, 'COMPLETE');
  assert.equal(f.calls.builds, 1);
});
test('restart recovers only matching revision, timestamp, hash, closure and SKU universe', async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
  await f.make().recoverPending(); assert.equal((await f.get()).impact.status, 'COMPLETE');
  assert.equal(f.calls.builds, 2);
});
test('restart after a newer revision refuses reconstruction before reading current snapshot', async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
  f.control.revision = '84'; await f.make().calculate({ executionId: f.executionId });
  const row = await f.get(); assert.equal(row.impact.status, 'NOT_CAPTURED');
  assert.equal(row.impact.reasonCode, 'SNAPSHOT_MISMATCH'); assert.equal(row.status, 'PROMOTED');
  assert.equal(f.calls.builds, 1); assert.equal(f.calls.scores, 0);
});
test('same revision with changed source fingerprint is rejected during recovery', async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
  f.source.snapshot.purchases[0].units = 77;
  await f.make().calculate({ executionId: f.executionId });
  assert.equal((await f.get()).impact.reasonCode, 'SNAPSHOT_MISMATCH'); assert.equal(f.calls.scores, 0);
});
test('even a valid newer fingerprint or changed product names cannot replace the pinned universe', async () => {
  for (const change of ['valid fingerprint', 'names']) {
    const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
    if (change === 'names') f.control.productName = 'Nombre distinto';
    else {
      f.source.snapshot.sales[0].units = 8;
      const { capturedAtUtc, snapshotHash, ...metadata } = f.source.snapshot.metadata;
      f.source.snapshot.metadata.snapshotHash = logicalHash({ ...f.source.snapshot, metadata });
    }
    await f.make().calculate({ executionId: f.executionId });
    assert.equal((await f.get()).impact.reasonCode, 'SNAPSHOT_MISMATCH'); assert.equal(f.calls.scores, 0);
  }
});
test('retry/concurrent calculators have one final CAS, no duplicated SKU details, stable identity', async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
  await Promise.all([f.adapter.calculate({ executionId: f.executionId }), f.adapter.calculate({ executionId: f.executionId })]);
  const before = await f.get(); await f.adapter.calculate({ executionId: f.executionId });
  assert.deepEqual((await f.get()).impact, before.impact);
  assert.equal((await f.get()).writeVersion, before.writeVersion);
  assert.equal(before.impact.prediction.detail.length, 2);
  assert.match(before.impact.prediction.idempotencyKey, /^[a-f0-9]{64}$/);
  await assert.rejects(f.service.setImpactStatus({ ...f.input, expectedVersion: before.writeVersion, status: 'PENDING' }),
    { code: 'IMPACT_ALREADY_FINALIZED' });
});
test('scoring failure never demotes promotion and persists only canonical code', async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
  f.control.failedScore = true; await f.adapter.calculate({ executionId: f.executionId });
  const row = await f.get(); assert.equal(row.status, 'PROMOTED'); assert.equal(row.impact.status, 'NOT_CAPTURED');
  assert.equal(row.impact.reasonCode, 'IMPACT_SCORING_FAILED');
  assert.ok(!JSON.stringify(row.impact).includes('secret must'));
});
test('mixed horizon uses recorded unchanged companion; no invented new model', async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote(true);
  await f.adapter.calculate({ executionId: f.executionId }); const p = (await f.get()).impact.prediction;
  assert.equal(p.detail[0].p14.direction, 'UNCHANGED'); assert.equal(p.detail[0].p14.delta, 0);
  assert.equal(p.versions[1].beforeVersion, p.versions[1].afterVersion);
});
test('unchanged predictions fully reconcile summary without a minimal-change threshold', async () => {
  const f = await setup({ values: { 7: [3, 3], 14: [0, 0] } });
  await f.adapter.capture({ executionId: f.executionId }); await f.promote(); await f.adapter.calculate({ executionId: f.executionId });
  const p = (await f.get()).impact.prediction;
  assert.equal(p.summary.predictionUnchangedCount, 2); assert.equal(p.summary.predictionChangedCount, 0);
  assert.equal(p.summary.notComparableCount, 0); assert.equal(p.summary.p14.unchangedCount, 2);
  assert.equal(p.detail[0].p14.deltaPct, null);
});
test('missing horizon leaves exact partial comparison and unavailable values null', async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
  f.control.missingHorizon = 7; await f.adapter.calculate({ executionId: f.executionId });
  const row = await f.get(); assert.equal(row.impact.status, 'PARTIAL');
  assert.equal(row.impact.reasonCode, 'BEFORE_MODEL_NOT_AVAILABLE');
  assert.equal(row.impact.prediction.detail[0].p7.old, null);
  assert.equal(row.impact.prediction.detail[0].p7.direction, 'NOT_COMPARABLE');
  assert.equal(row.impact.prediction.summary.notComparableCount, 2);
});
test('missing original pin never captures a post-promotion snapshot', async () => {
  const f = await setup(); await f.promote(); await f.adapter.capture({ executionId: f.executionId });
  await f.adapter.calculate({ executionId: f.executionId });
  assert.equal((await f.get()).impact.status, 'NOT_CAPTURED'); assert.equal(f.calls.builds, 0);
});
test('no promotion leaves NOT_APPLICABLE and does not score, train or promote', async () => {
  const f = await setup(); assert.equal((await f.adapter.calculate({ executionId: f.executionId })).status, 'NOT_APPLICABLE');
  assert.equal((await f.get()).impact.status, 'NOT_APPLICABLE'); assert.equal(f.calls.scores, 0);
  assert.equal(f.calls.modelReads, 0);
});
test('size limit is explicit; no silent truncation or dataset/artifact/features persistence', async () => {
  const oversized = await setup({ count: 201 }); await oversized.adapter.capture({ executionId: oversized.executionId });
  await oversized.promote(); await oversized.adapter.calculate({ executionId: oversized.executionId });
  assert.equal((await oversized.get()).impact.reasonCode, 'IMPACT_SIZE_LIMIT');
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
  await f.adapter.calculate({ executionId: f.executionId });
  const stored = JSON.stringify((await f.get()).impact);
  for (const forbidden of ['artifactBase64', 'artifactData', 'coefficients', 'sales', 'purchases', 'stockStates', 'features', 'MongoURI']) {
    assert.ok(!stored.includes(`"${forbidden}"`));
  }
  assert.ok(Buffer.byteLength(stored) < P.MAX_BYTES);
});
test('scorer revision mismatch is rejected without accepting another snapshot', async () => {
  const f = await setup(); await f.adapter.capture({ executionId: f.executionId }); await f.promote();
  f.control.mismatchResult = true; await f.adapter.calculate({ executionId: f.executionId });
  assert.equal((await f.get()).impact.reasonCode, 'SNAPSHOT_MISMATCH');
});
test('tenant/scenario cannot pin or finalize a foreign execution', async () => {
  const f = await setup(); const row = await f.get();
  for (const foreign of [{ businessId: 'OTHER' }, { scenarioId: 'OTHER' }]) {
    await assert.rejects(f.service.pinPredictionSnapshot({ ...f.input, ...foreign,
      expectedVersion: row.writeVersion, snapshot: null }), { code: 'EXECUTION_NOT_FOUND' });
    await assert.rejects(f.service.finalizePredictionImpact({ ...f.input, ...foreign,
      expectedVersion: row.writeVersion, results: [] }), { code: 'EXECUTION_NOT_FOUND' });
  }
});
test('legacy promoted execution without a pin is recovered, never reset to retrain', async () => {
  const f = await setup(); await f.promote();
  const { createExecutionHistory } = require('../src/services/forecastExecutionHistory');
  const history = createExecutionHistory({ service: f.service, scope, clock: () => NOW,
    identity: { triggerSource: 'CLI', cliInvocationKey: 'impact-test' },
    recoverImpact: f.adapter.calculate, prepare: async () => {} });
  const result = await history.begin(); assert.equal(result.duplicate, true);
  const row = await f.get(); assert.equal(row.status, 'PROMOTED'); assert.equal(row.impact.status, 'NOT_CAPTURED');
  assert.equal(row.perHorizon[0].activeVersionAfter, 2); assert.equal(f.calls.scores, 0);
});

function cloudFixture() {
  const { createCloudWorker } = require('../src/services/forecastCloudWorker');
  const update = require('../src/services/forecastMlUpdateCoordinator');
  const events = [], control = { duplicate: false, impactFails: false };
  const id = '11111111-1111-4111-8111-111111111111';
  const run = mode => createCloudWorker({ update, clock: () => NOW,
    preflight: async () => ({ dataVersion: '83', activeModels: [7, 14].map(horizonDays => ({ horizonDays, modelVersion: 1, trainedDataVersion: '83' })),
      promotionReadiness: Object.fromEntries([7, 14].map(h => [h, { status: 'READY', availableOrigins: 107, requiredOrigins: 107 }])) }),
    readState: async h => ({ ...scope, horizonDays: h, status: 'PENDING', latestDataVersion: 84n,
      lastProcessedDataVersion: 83n, initialMatureOrigin: update.matureOrigin('2026-10-15', h),
      latestMatureOrigin: update.matureOrigin('2026-10-15', h), lastTrainedMatureOrigin: update.matureOrigin('2026-10-15', h),
      observationsClosedThrough: '2026-10-15', lastDirtyAt: new Date('2026-10-17T15:00:00Z'),
      nextEligibleAt: new Date('2026-10-17T15:15:00Z'), lastAttemptAt: null, historicalCorrectionVersion: null }),
    executionHistory: { begin: async () => ({ duplicate: control.duplicate, executionId: id }),
      preflight: async () => {}, horizon: async () => {}, finish: async () => events.push('confirmed-terminal'), fail: async () => {} },
    runEligible: async ({ horizonDays }) => { events.push(`worker-${horizonDays}`); return { status: 'PROMOTED', modelVersion: 2 }; },
    predictionImpact: { recoverPending: async () => events.push('recovery'),
      capture: async () => events.push('capture'), calculate: async () => {
        events.push('calculate'); if (control.impactFails) throw new Error('raw private'); return { status: 'COMPLETE' };
      } },
  }).run(mode);
  return { run, events, control };
}
test('worker captures before eligible work and calculates only after confirmed terminal audit', async () => {
  const f = cloudFixture(); const result = await f.run('RUN');
  assert.deepEqual(f.events, ['recovery', 'capture', 'worker-7', 'capture', 'worker-14', 'confirmed-terminal', 'calculate']);
  assert.equal(result.predictionImpact.status, 'COMPLETE');
});
test('impact failure does not change a promoted worker result or leak private error', async () => {
  const f = cloudFixture(); f.control.impactFails = true; const result = await f.run('RUN');
  assert.equal(result.status, 'OK'); assert.ok(result.horizons.every(h => h.result === 'CANDIDATE_PROMOTED'));
  assert.equal(result.predictionImpact.status, 'PENDING'); assert.ok(!JSON.stringify(result).includes('raw private'));
});
test('duplicate worker execution recovers impact without another training call', async () => {
  const f = cloudFixture(); f.control.duplicate = true; await f.run('RUN');
  assert.deepEqual(f.events, ['calculate']);
});
for (const mode of ['CHECK', 'STATUS']) test(`${mode} never captures, computes or recovers impact`, async () => {
  const f = cloudFixture(); await f.run(mode); assert.deepEqual(f.events, []);
});

test('Python bridge uses exact audit module/configured executable and discards stderr', async () => {
  const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
  const { scorePredictionImpact } = require('../src/services/forecastPredictionImpactPython');
  let input;
  const result = await scorePredictionImpact({ test: 'fixed snapshot' }, { executable: 'configured-python',
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, 'configured-python'); assert.deepEqual(args, ['-B', '-m', 'ml.service.v3_ridge_prediction_impact']);
      assert.equal(options.cwd, require('node:path').resolve(__dirname, '../..'));
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {}; let body = ''; child.stdin.on('data', chunk => { body += chunk; });
      child.stdin.on('finish', () => {
        input = JSON.parse(body); child.stderr.write('secret never emitted');
        child.stdout.write(JSON.stringify({ ok: true, result: { horizons: [] } })); child.emit('close', 0);
      }); return child;
    } });
  assert.deepEqual(input, { test: 'fixed snapshot' }); assert.deepEqual(result, { horizons: [] });
});
