'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getCertifiedReplayOrigins, getCertifiedReplayOrigin, validateDetailCertificate, DETAIL_SHA256 } = require('../src/services/forecastReplayDetailService');
const { getCertifiedStable2020Replay } = require('../src/services/forecastReplayCertificateService');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');

const raw = fs.readFileSync(path.join(__dirname, '../src/evidence/forecast-replay/cert-stable-2020-detail.json'));
const detail = JSON.parse(raw);
const summary = getCertifiedStable2020Replay();
const policyRaw = fs.readFileSync(path.join(__dirname, '../../ml/service/forecast_promotion_policy_v1.json'));
const policy = JSON.parse(policyRaw);

test('fixed detailed certificate is STABLE/2020, pinned to original policy and detects changed bytes', () => {
  assert.equal(detail.demoRunId, 'cert-stable-2020');
  assert.equal(detail.seed, 2020); assert.equal(detail.profile, 'STABLE');
  assert.equal(detail.purpose, 'REPLAY_ONLY'); assert.equal(detail.requiredOrigins, 107);
  assert.equal(detail.reference, 'MA28');
  assert.equal(detail.policy.numericPolicySha256, createHash('sha256').update(policyRaw).digest('hex'));
  assert.equal(detail.policy.replayPolicy, summary.policy.replayPolicy);
  assert.equal(createHash('sha256').update(raw).digest('hex'), DETAIL_SHA256);
  assert.deepEqual(validateDetailCertificate(raw), detail);
  assert.throws(() => validateDetailCertificate(Buffer.concat([raw, Buffer.from(' ')])), /INTEGRITY_FAILED/);
  assert.ok(Object.values(detail.liveImpact).every(value => value === false));
  for (const hash of Object.values(detail.provenance).filter(value => typeof value === 'string')) assert.match(hash, /^[a-f0-9]{64}$/);
});

for (const h of ['7', '14']) test(`${h}d exposes exactly 107 real unique origins with 31/30/46 folds and reconciling metrics`, () => {
  const index = getCertifiedReplayOrigins({ horizonDays: h });
  const rows = [];
  for (let page = 1; page <= index.totalPages; page++) rows.push(...getCertifiedReplayOrigins({ horizonDays: h, page: String(page) }).items);
  assert.equal(rows.length, 107); assert.equal(new Set(rows.map(r => r.origin)).size, 107);
  assert.deepEqual(index.folds.map(f => [f.key, f.origins, f.startOrigin, f.endOrigin]), [
    ['F2', 31, '2026-04-17', '2026-05-17'], ['F3', 30, '2026-05-18', '2026-06-16'], ['VALIDATION', 46, '2026-06-17', '2026-08-01'],
  ]);
  for (const fold of index.folds) {
    assert.equal(rows.filter(row => row.fold === fold.key).length, fold.origins);
    const filtered = getCertifiedReplayOrigins({ horizonDays: h, fold: fold.key });
    assert.equal(filtered.total, fold.origins);
    assert.ok(filtered.items.every(row => row.fold === fold.key));
  }
  const details = rows.map(row => getCertifiedReplayOrigin(row.origin, { horizonDays: h }));
  for (const row of details) {
    assert.equal(new Date(`${row.origin}T00:00:00Z`).toISOString().slice(0, 10), row.origin);
    assert.equal(row.sampleCount, 80);
    assert.equal(row.candidate.rows, 80); assert.equal(row.baseline.rows, 80);
    assert.equal(row.candidate.actual_units, row.actualUnits);
    assert.ok(Math.abs((row.candidateUnits - row.actualUnits) / row.sampleCount - row.candidate.bias_units) < 1e-10);
  }
  const aggregateMae = details.reduce((sum, row) => sum + row.candidate.mae, 0) / details.length;
  assert.ok(Math.abs(aggregateMae - summary.horizons.find(row => row.horizonDays === Number(h)).metrics.mae) < 1e-10);
  assert.ok(Buffer.byteLength(JSON.stringify(index)) < 10_000);
});

test('14d focal veto is the real F3 second block, with authoritative support and unchanged 1.50 threshold', () => {
  const focal = getCertifiedReplayOrigins({ horizonDays: '14' }).focalEvidence;
  assert.equal(focal.ruleKey, summary.horizons[1].reasons[0]);
  assert.equal(focal.sku, 'BEB-GAS-003'); assert.equal(focal.fold, 'F3');
  assert.deepEqual(focal.support, { origins: 30, uniqueDayUnits: 221, sufficient: true });
  assert.equal(focal.threshold, policy.priority.supportedFoldMaeRatioCatastrophicMax);
  assert.equal(focal.passed, false);
  assert.ok(Math.abs(focal.candidateMae / focal.baselineMae - focal.ratio) < 1e-12);
  assert.ok(focal.ratio > focal.threshold);
  const seven = getCertifiedReplayOrigins({ horizonDays: '7' });
  assert.equal(seven.status, 'PASS'); assert.deepEqual(seven.reasons, []);
  assert.equal(seven.focalEvidence, null); assert.equal(seven.allCheckCount, seven.passedCheckCount);
});

test('closed selection rejects horizon 1, invented fold keys, out-of-certificate dates and arbitrary file/run selection', () => {
  for (const query of [{ horizonDays: '1' }, { horizonDays: ['7'] }, { fold: 'F1' }, { fold: '../../' },
    { page: '0' }, { page: '999' }, { page: '1.5' }, { runId: 'other' }, { file: '/tmp/x' }]) {
    assert.throws(() => getCertifiedReplayOrigins(query), error => error.httpStatus === 400);
  }
  for (const origin of ['2026-08-02', '2026-02-30', '../../x', '2026-04-16']) {
    assert.throws(() => getCertifiedReplayOrigin(origin), error => error.httpStatus === 400);
  }
  assert.throws(() => getCertifiedReplayOrigin('2026-04-17', { fold: 'F3' }), error => error.httpStatus === 400);
});

test('readers return detached evidence without changing certificate', () => {
  const index = getCertifiedReplayOrigins(); index.folds[0].key = 'altered'; index.items[0].origin = 'changed';
  assert.equal(getCertifiedReplayOrigins().folds[0].key, 'F2');
  assert.equal(getCertifiedReplayOrigins().items[0].origin, '2026-04-17');
});

test('new routes retain shared auth/access and no-store, never invoking dashboard/ML/DB paths', async () => {
  const router = createBusinessIntelligenceDashboardRoutes({
    service: new Proxy({}, { get() { throw new Error('LIVE must not run'); } }),
    authenticateMiddleware: function authenticated(_req, _res, next) { next(); },
    businessAccessMiddleware: function scoped(_req, _res, next) { next(); },
  });
  assert.deepEqual(router.stack.slice(0, 2).map(layer => layer.name), ['authenticated', 'scoped']);
  const reads = router.stack.filter(layer => layer.route?.path.includes('/origins'));
  assert.equal(reads.length, 2);
  for (const layer of reads) {
    assert.deepEqual({ ...layer.route.methods }, { get: true });
    const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; },
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const handler = layer.route.stack[0].handle;
    await handler({ query: { horizonDays: '14' }, params: { origin: '2026-05-18' } }, res);
    assert.equal(res.body.success, true); assert.equal(res.body.data.purpose, 'REPLAY_ONLY');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    await handler({ query: { path: '../x' }, params: { origin: '2026-05-18' } }, res);
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'FORECAST_REPLAY_SELECTION_INVALID');
  }
});
