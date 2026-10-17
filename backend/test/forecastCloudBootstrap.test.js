'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const config = require('../src/config/v3Operational');
const service = require('../src/services/forecastCloudBootstrap');
const { EVIDENCE_HASH, POLICY_HASH, FEATURE_HASH, parseOptions, verifyEvidence,
  validateTarget, createCloudBootstrap } = service;
const ROOT = path.resolve(__dirname, '../..');
const base = () => ({ 'business-id': config.businessId, 'scenario-id': config.scenarioId,
  'expected-database': 'approved_cloud_db', 'confirm-cloud-bootstrap': true,
  'expected-evidence-hash': EVIDENCE_HASH, 'expected-policy-hash': POLICY_HASH,
  'expected-feature-hash': FEATURE_HASH });
const argv = opts => Object.entries(opts).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, value]);
const execute = () => ({ ...base(), execute: true, 'expected-data-version': '100', 'expected-closed-through': '2026-10-15' });
const revision = () => ({ _id: config.businessId, revision: 100n, bootstrapStatus: 'VERIFIED',
  historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256 });
const code = value => ({ code: value });

function harness({ failHorizon, changeAtPromotion = false, competingPointer = false } = {}) {
  const pointers = new Map();
  const artifacts = new Map();
  const calls = [];
  let row = revision();
  const deps = {
    clock: () => new Date('2026-10-16T17:00:00Z'), watermark: () => '2026-10-15',
    readRevision: async () => row,
    readRegistry: async scope => pointers.get(scope.horizonDays) || null,
    countArtifacts: async scope => artifacts.has(scope.horizonDays) ? 1 : 0,
    exportJournal: async version => { calls.push(['export', version]); return []; },
    inspectDataset: async request => {
      assert.equal(request.mode, 'bootstrap'); assert.equal(request.dryRun, true);
      calls.push(['inspect', request.horizonDays]);
      return { status: 'FEASIBLE', horizonDays: request.horizonDays, trainRows: 800,
        trainedDataVersion: request.inputDataVersion, observationsClosedThrough: request.observationsClosedThrough,
        sourceDatasetHash: 'a'.repeat(64), evidenceHash: EVIDENCE_HASH,
        featureHash: FEATURE_HASH, promotionPolicyHash: POLICY_HASH };
    },
    assertIndexes: async () => calls.push(['indexes']),
    createWorker: guard => ({ process: async request => {
      calls.push(['worker', request.horizonDays]);
      assert.equal(request.mode, 'bootstrap');
      for (const phase of ['initial', 'training', 'candidate']) await guard({ ...request, phase });
      if (request.horizonDays === failHorizon) throw code('TRAINING_RUNTIME_UNAVAILABLE');
      // Mock the existing registry allocator and promotion transaction, not a direct ACTIVE insert.
      const pointer = { generation: 0, lastIssuedModelVersion: 1, activeArtifactId: null, activeModelVersion: null };
      pointers.set(request.horizonDays, pointer);
      artifacts.set(request.horizonDays, { status: 'CANDIDATE' });
      if (changeAtPromotion) row = { ...row, revision: 101n };
      if (competingPointer) { pointer.generation = 1; pointer.activeArtifactId = 'winner'; pointer.activeModelVersion = 1; }
      await guard({ ...request, phase: 'promotion', modelVersion: 1 });
      calls.push(['CAS', request.horizonDays, 0, 1]);
      pointer.generation = 1; pointer.activeArtifactId = 'mock-id'; pointer.activeModelVersion = 1;
      artifacts.get(request.horizonDays).status = 'ACTIVE';
      return { status: 'PROMOTED', modelVersion: 1 };
    } })
  };
  return { deps, pointers, artifacts, calls, setRevision: value => { row = value; },
    run: opts => createCloudBootstrap(deps).run(opts || base()) };
}

test('canonical evidence is pinned, stable and contains no model bytes or raw data', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'ml/service/forecast_bootstrap_evidence_v1.json'));
  // Serialize keys lexically, including numeric-looking object keys (7/14).
  const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : x && typeof x === 'object'
    ? `{${Object.keys(x).sort().map(key => `${JSON.stringify(key)}:${canonical(x[key])}`).join(',')}}` : JSON.stringify(x);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), EVIDENCE_HASH);
  assert.equal(raw.toString(), `${canonical(JSON.parse(raw))}\n`);
  assert.doesNotMatch(raw.toString(), /password|mongodb:|artifactBase64|customerName|rawSales/i);
  assert.equal(verifyEvidence(EVIDENCE_HASH).sourceEvidenceHash,
    '7e46d58d044815edb23a5126e5f6a56c857bb6d6c6b5e8eececd64aee73bb04c');
});

test('canonical evidence matches original A.2.2 decisions exactly when the audit source is available', t => {
  const sourcePath = path.join(ROOT, 'ml/.test-tmp/m610a22/final-results.json');
  if (!fs.existsSync(sourcePath)) { t.skip('Original experiment is optional for deployed runtime, mandatory for this local provenance audit'); return; }
  const raw = fs.readFileSync(sourcePath), source = JSON.parse(raw), pinned = verifyEvidence(EVIDENCE_HASH);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), pinned.sourceEvidenceHash);
  assert.equal(source.policySha256, POLICY_HASH); assert.equal(source.complete, true);
  assert.equal(source.bestEligible[1], null);
  for (const horizon of [7, 14]) {
    const best = source.bestEligible[horizon];
    const matches = source.decisions.filter(r => r.horizon === horizon && r.candidate === best.candidate && r.phase === best.phase);
    assert.equal(matches.length, 1);
    const projected = Object.fromEntries(Object.keys(pinned.horizons[horizon]).map(k => [k, matches[0][k]]));
    assert.deepEqual(projected, pinned.horizons[horizon]);
  }
});

for (const horizon of [7, 14]) test(`${horizon}d is independently eligible under exact policy/features`, () => {
  const data = verifyEvidence(EVIDENCE_HASH), row = data.horizons[horizon];
  assert.equal(row.eligible, true); assert.equal(row.candidate, 'RIDGE-CAUSAL27');
  assert.equal(data.promotionPolicyHash, POLICY_HASH); assert.equal(data.featureHash, FEATURE_HASH);
  assert.ok(Object.values(row.checks).every(v => v === true));
});
test('1d explicitly excluded', () => {
  const data = verifyEvidence(EVIDENCE_HASH);
  assert.deepEqual(data.excludedHorizons, [1]); assert.equal(data.horizons[1], undefined);
});
test('default dry-run builds both datasets and performs zero writes or worker calls', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.mode, 'DRY_RUN'); assert.equal(result.writesPerformed, 0);
  assert.equal(result.expectedDataVersion, '100'); assert.equal(result.observationsClosedThrough, '2026-10-15');
  assert.deepEqual(result.horizons.map(r => r.horizonDays), [7, 14]);
  assert.equal(h.pointers.size, 0); assert.equal(h.artifacts.size, 0);
  assert.deepEqual(h.calls, [['export', '100'], ['inspect', 7], ['inspect', 14], ['indexes']]);
});
test('local CLI keeps localhost / rs0 guards and dedicated local URI', () => {
  const source = fs.readFileSync(path.join(ROOT, 'backend/scripts/run-v3-ridge-training-local.js'), 'utf8');
  assert.match(source, /FORECAST_LOCAL_MONGO_URI/); assert.match(source, /localhost/);
  assert.match(source, /hello.setName !== 'rs0'/); assert.doesNotMatch(source, /FORECAST_CLOUD_MONGO_URI/);
});
test('cloud target is explicit SRV database and never falls back to ordinary Mongo config', () => {
  assert.deepEqual(validateTarget('mongodb+srv://user:secret@sample.mongodb.net/approved_cloud_db', 'approved_cloud_db'),
    { cloud: true, database: 'approved_cloud_db' });
  for (const uri of [undefined, 'mongodb://localhost/approved_cloud_db', 'mongodb+srv://sample.mongodb.net/wrong',
    'mongodb+srv://untrusted.example/approved_cloud_db', 'mongodb+srv://sample.mongodb.net/approved_cloud_db?tls=false']) {
    assert.throws(() => validateTarget(uri, 'approved_cloud_db'), code('INVALID_CLOUD_TARGET'));
  }
});
const invalid = [
  ['missing confirmation', 'confirm-cloud-bootstrap', undefined, 'CLOUD_CONFIRMATION_REQUIRED'],
  ['tenant mismatch', 'business-id', 'other', 'TENANT_MISMATCH'],
  ['scenario mismatch', 'scenario-id', 'other', 'SCENARIO_MISMATCH'],
  ['missing explicit database', 'expected-database', undefined, 'EXPECTED_DATABASE_REQUIRED'],
  ['evidence mismatch', 'expected-evidence-hash', 'b'.repeat(64), 'BOOTSTRAP_EVIDENCE_HASH_MISMATCH'],
  ['policy mismatch', 'expected-policy-hash', 'b'.repeat(64), 'PROMOTION_POLICY_MISMATCH'],
  ['feature mismatch', 'expected-feature-hash', 'b'.repeat(64), 'FEATURE_HASH_MISMATCH']
];
for (const [name, key, value, expected] of invalid) test(`${name} aborts before any dependency call`, async () => {
  const opts = base(); if (value === undefined) delete opts[key]; else opts[key] = value;
  const h = harness(); await assert.rejects(h.run(opts), code(expected)); assert.deepEqual(h.calls, []);
});
test('execute requires revision and closed-day preconditions from a prior dry-run', () => {
  assert.throws(() => parseOptions(argv({ ...base(), execute: true })), code('DRY_RUN_PRECONDITIONS_REQUIRED'));
  assert.throws(() => parseOptions([...argv(base()), '--horizon', '1']), code('INVALID_CLOUD_ARGUMENTS'));
});
test('registry or orphan artifacts abort before export', async () => {
  for (const kind of ['pointer', 'artifact']) {
    const h = harness();
    if (kind === 'pointer') h.pointers.set(7, { generation: 0 }); else h.artifacts.set(14, { status: 'CANDIDATE' });
    await assert.rejects(h.run(), code('REGISTRY_ALREADY_INITIALIZED')); assert.deepEqual(h.calls, []);
  }
});
test('dataVersion mismatch prevents training and writes', async () => {
  const h = harness(); await assert.rejects(h.run({ ...base(), 'expected-data-version': '99' }), code('DATA_VERSION_MISMATCH'));
  assert.deepEqual(h.calls, []);
});
test('lineage mismatch rejects a different canonical dataset', async () => {
  const h = harness(); h.setRevision({ ...revision(), historicalDatasetSha256: 'b'.repeat(64) });
  await assert.rejects(h.run(), code('BOOTSTRAP_LINEAGE_INVALID')); assert.deepEqual(h.calls, []);
});
test('closed-day changed requires new dry-run', async () => {
  const h = harness(); await assert.rejects(h.run({ ...execute(), 'expected-closed-through': '2026-10-14' }), code('CLOSED_THROUGH_CHANGED'));
  assert.deepEqual(h.calls, []);
});
test('revision advance during dataset inspection aborts before a worker is made', async () => {
  const h = harness(), inspect = h.deps.inspectDataset;
  h.deps.inspectDataset = async req => { const r = await inspect(req); h.setRevision({ ...revision(), revision: 101n }); return r; };
  await assert.rejects(h.run(execute()), code('DATA_VERSION_MISMATCH'));
  assert.ok(!h.calls.some(c => c[0] === 'worker'));
});
test('registry initialized after preflight aborts before training', async () => {
  const h = harness(), inspect = h.deps.inspectDataset;
  h.deps.inspectDataset = async req => { const r = await inspect(req); h.pointers.set(7, { generation: 1 }); return r; };
  await assert.rejects(h.run(execute()), code('REGISTRY_ALREADY_INITIALIZED'));
  assert.ok(!h.calls.some(c => c[0] === 'worker'));
});
test('dataset feasibility failure is fail-closed', async () => {
  const h = harness(); h.deps.inspectDataset = async () => ({ status: 'UNKNOWN' });
  await assert.rejects(h.run(execute()), code('DATASET_NOT_FEASIBLE')); assert.equal(h.pointers.size, 0);
});
test('future execute uses independent empty pointers and CAS generation zero', async () => {
  const h = harness(), report = await h.run(execute());
  assert.equal(report.status, 'PROMOTED');
  assert.deepEqual(h.calls.filter(c => c[0] === 'CAS'), [['CAS', 7, 0, 1], ['CAS', 14, 0, 1]]);
  assert.ok([...h.pointers.values()].every(p => p.generation === 1 && p.activeModelVersion === 1));
  await assert.rejects(h.run(execute()), code('REGISTRY_ALREADY_INITIALIZED'));
  assert.equal(h.calls.filter(c => c[0] === 'CAS').length, 2);
});
test('7d committed survives 14d failure; no retry or bundle rollback', async () => {
  const h = harness({ failHorizon: 14 }), report = await h.run(execute());
  assert.equal(report.status, 'PARTIAL'); assert.equal(report.horizons[0].action, 'PROMOTED');
  assert.equal(report.horizons[1].action, 'FAILED'); assert.equal(h.artifacts.get(7).status, 'ACTIVE');
  assert.equal(h.pointers.has(14), false); assert.equal(h.calls.filter(c => c[0] === 'worker').length, 2);
});
test('first-horizon failure stops without attempting the second', async () => {
  const h = harness({ failHorizon: 7 }), report = await h.run(execute());
  assert.equal(report.status, 'FAILED'); assert.equal(h.calls.filter(c => c[0] === 'worker').length, 1);
  assert.equal(h.pointers.size, 0);
});
test('revision changing before CAS cannot promote', async () => {
  const h = harness({ changeAtPromotion: true }), report = await h.run(execute());
  assert.equal(report.status, 'FAILED'); assert.ok(!h.calls.some(c => c[0] === 'CAS'));
  assert.equal(h.artifacts.get(7).status, 'CANDIDATE');
});
test('competing ACTIVE before promotion fails the empty-pointer CAS guard', async () => {
  const h = harness({ competingPointer: true }), report = await h.run(execute());
  assert.equal(report.status, 'FAILED'); assert.equal(report.horizons[0].reasonCode, 'REGISTRY_CAS_CONFLICT');
  assert.ok(!h.calls.some(c => c[0] === 'CAS'));
});
test('index readiness is checked before any worker or metadata writes', async () => {
  const h = harness(); h.deps.assertIndexes = async () => { throw code('ML_INDEXES_NOT_READY'); };
  await assert.rejects(h.run(execute()), code('ML_INDEXES_NOT_READY'));
  assert.ok(!h.calls.some(c => c[0] === 'worker'));
});
test('dry-run reports missing ML indexes without creating collections or pretending execution is ready', async () => {
  const h = harness(); h.deps.assertIndexes = async () => { throw code('ML_INDEXES_NOT_READY'); };
  const report = await h.run();
  assert.equal(report.executionPrerequisites, 'ML_INDEXES_NOT_READY'); assert.equal(report.writesPerformed, 0);
  assert.ok(report.horizons.every(row => row.action === 'BLOCKED_ML_INDEXES'));
  assert.equal(h.pointers.size, 0);
});
test('sanitized report contains no URI, journal, artifact bytes or credentials', async () => {
  const text = JSON.stringify(await harness().run());
  assert.doesNotMatch(text, /mongodb|secret|password|journal|artifactBase64|authorization|sales/i);
  assert.doesNotMatch(text, new RegExp(config.businessId));
});
test('CLI fails safely before connecting when explicit opt-in is absent', () => {
  const result = spawnSync(process.execPath, ['backend/scripts/run-v3-ridge-bootstrap-cloud.js'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORECAST_CLOUD_MONGO_URI: 'mongodb+srv://secret:password@sample.mongodb.net/db' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /CLOUD_CONFIRMATION_REQUIRED/);
  assert.doesNotMatch(result.stderr + result.stdout, /secret|password|mongodb|stack/i);
});
test('entrypoint has no commercial mutation imports or schema initialization', () => {
  const source = fs.readFileSync(path.join(ROOT, 'backend/scripts/run-v3-ridge-bootstrap-cloud.js'), 'utf8');
  assert.doesNotMatch(source, /\.init\(|syncIndexes|createIndexes|require\([^\n]*(?:salesService|purchaseService|inventoryAdjustment|actionExecution)/);
  assert.match(source, /autoCreate: false, autoIndex: false/);
});

test('real worker reuses candidate allocation, canonical bytes and exact CAS path with cloud guards', async t => {
  const registryModule = require('../src/services/forecastModelRegistryService');
  t.mock.method(registryModule, 'inBoundedTransaction', async work => work({ fixtureSession: true }));
  const { createForecastRidgeTrainingWorker } = require('../src/services/forecastRidgeTrainingWorker');
  const trace = [];
  const job = { _id: 'fixture-job', startedAt: new Date('2026-10-16T12:00:00Z'), expectedGeneration: 0 };
  const result = { evaluationStatus: 'BOOTSTRAP_FROM_APPROVED_HISTORICAL_EVIDENCE',
    featureVersion: 'RIDGE_CAUSAL27_V1', promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
    featureHash: FEATURE_HASH, promotionPolicyHash: POLICY_HASH, trainedDataVersion: '100', sourceDatasetHash: 'a'.repeat(64),
    artifact: { schemaVersion: 'ridge-causal27-json-v1', modelFamily: 'RIDGE_REGRESSION', modelVersion: null, businessId: config.businessId,
      scenarioId: config.scenarioId, horizonDays: 7, recipeId: 'RIDGE-CAUSAL27', featureVersion: 'RIDGE_CAUSAL27_V1', featureHash: FEATURE_HASH },
    lineage: { approvedEvidenceSha256: EVIDENCE_HASH, historicalDatasetSha256: config.sourceSha256 },
    dataCutoff: '2026-10-15', labelClosedThrough: '2026-10-15', parityMaxAbsoluteError: 0, checks: {} };
  const worker = createForecastRidgeTrainingWorker({
    log: () => {}, bootstrapPrecondition: async req => trace.push(req.phase),
    update: { matureOrigin: () => '2026-10-08', exportOperationalChanges: async ({ onPage }) => { await onPage([]); return { complete: true }; } },
    pointerModel: { findOne: () => ({ lean: async () => null }) },
    jobModel: { findOneAndUpdate: () => ({ select: () => ({ lean: async () => job }) }),
      updateOne: () => ({ exec: async () => ({ matchedCount: 1 }) }) },
    runTraining: async () => result,
    registry: {
      createCandidateMetadata: async input => {
        assert.equal(input.triggerReason, 'BOOTSTRAP_FROM_APPROVED_HISTORICAL_EVIDENCE');
        await input.precondition({});
        const bytes = input.artifactFactory(1); assert.equal(JSON.parse(bytes).modelVersion, 1);
        await input.onCreated({}, { modelVersion: 1 }); trace.push('registryCandidate'); return { modelVersion: 1 };
      },
      promoteCandidate: async input => {
        assert.equal(input.modelVersion, 1); assert.equal(input.expectedGeneration, 0);
        await input.precondition({}); await input.onPromoted({}); trace.push('registryCAS');
      }
    }
  });
  const output = await worker.process({ businessId: config.businessId, scenarioId: config.scenarioId,
    horizonDays: 7, inputDataVersion: '100', observationsClosedThrough: '2026-10-15', mode: 'bootstrap' });
  assert.equal(output.status, 'PROMOTED');
  assert.deepEqual(trace, ['initial', 'initial', 'training', 'candidate', 'registryCandidate', 'promotion', 'registryCAS']);
});

test('recovered preparedCandidate cannot bypass evidence validation in the real worker', async t => {
  const registryModule = require('../src/services/forecastModelRegistryService');
  t.mock.method(registryModule, 'inBoundedTransaction', async work => work({}));
  const { createForecastRidgeTrainingWorker } = require('../src/services/forecastRidgeTrainingWorker');
  const job = { _id: 'fixture-recovered', preparedCandidate: { evaluationStatus: 'PASS' } };
  let candidateCalls = 0, trainingCalls = 0;
  const worker = createForecastRidgeTrainingWorker({ log: () => {}, bootstrapPrecondition: async () => {},
    update: { matureOrigin: () => '2026-10-08' }, pointerModel: { findOne: () => ({ lean: async () => null }) },
    jobModel: { findOneAndUpdate: () => ({ select: () => ({ lean: async () => job }) }),
      findById: () => ({ lean: async () => job }), updateOne: () => ({ exec: async () => ({ matchedCount: 1 }) }) },
    registry: { createCandidateMetadata: async () => { candidateCalls += 1; } },
    runTraining: async () => { trainingCalls += 1; }
  });
  await assert.rejects(worker.process({ businessId: config.businessId, scenarioId: config.scenarioId,
    horizonDays: 7, inputDataVersion: '100', observationsClosedThrough: '2026-10-15', mode: 'bootstrap' }),
  code('TRAINING_RESPONSE_INVALID'));
  assert.equal(candidateCalls, 0); assert.equal(trainingCalls, 0);
});
