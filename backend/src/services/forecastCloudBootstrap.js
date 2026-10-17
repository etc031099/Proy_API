'use strict';

// Deliberately separate from app startup and the local-only training CLI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config/v3Operational');
const ROOT = path.resolve(__dirname, '../../..');
const EVIDENCE_HASH = '008927803998f5b628b300b71edc30147383c6bd3aa392daf63038b53d2873de';
const POLICY_HASH = '522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3';
const FEATURE_HASH = '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const scopeFor = horizonDays => ({ businessId: config.businessId, scenarioId: config.scenarioId, horizonDays });
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function verifyEvidence(expectedHash) {
  const bytes = fs.readFileSync(path.join(ROOT, 'ml/service/forecast_bootstrap_evidence_v1.json'));
  if (expectedHash !== EVIDENCE_HASH || hash(bytes) !== EVIDENCE_HASH) fail('BOOTSTRAP_EVIDENCE_HASH_MISMATCH');
  if (hash(fs.readFileSync(path.join(ROOT, 'ml/service/forecast_promotion_policy_v1.json'))) !== POLICY_HASH) {
    fail('PROMOTION_POLICY_MISMATCH');
  }
  const data = JSON.parse(bytes);
  if (data.promotionPolicyHash !== POLICY_HASH || data.featureHash !== FEATURE_HASH
      || data.historicalDatasetSha256 !== config.sourceSha256 || data.recipeId !== 'RIDGE-CAUSAL27'
      || data.featureVersion !== 'RIDGE_CAUSAL27_V1' || data.promotionPolicyVersion !== 'M6.10A22-PROMOTION-v1'
      || JSON.stringify(data.excludedHorizons) !== '[1]' || Object.keys(data.horizons).sort().join() !== '14,7') {
    fail('BOOTSTRAP_EVIDENCE_INVALID');
  }
  for (const n of [7, 14]) {
    const r = data.horizons[n];
    if (r.horizon !== n || r.candidate !== data.recipeId || !r.eligible || !r.qualityPassed
        || !r.causalEligible || !Object.keys(r.checks).length || Object.values(r.checks).some(v => v !== true)
        || r.reasons.length) fail('BOOTSTRAP_EVIDENCE_INVALID');
  }
  return data;
}

function parseOptions(argv) {
  const values = new Set(['business-id', 'scenario-id', 'expected-database', 'expected-evidence-hash',
    'expected-policy-hash', 'expected-feature-hash', 'expected-data-version', 'expected-closed-through']);
  const flags = new Set(['confirm-cloud-bootstrap', 'execute']);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if ((!values.has(key) && !flags.has(key)) || Object.hasOwn(options, key)) fail('INVALID_CLOUD_ARGUMENTS');
    if (flags.has(key)) options[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('INVALID_CLOUD_ARGUMENTS');
      options[key] = argv[++i];
    }
  }
  if (!options['confirm-cloud-bootstrap']) fail('CLOUD_CONFIRMATION_REQUIRED');
  if (options['business-id'] !== config.businessId) fail('TENANT_MISMATCH');
  if (options['scenario-id'] !== config.scenarioId) fail('SCENARIO_MISMATCH');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options['expected-database'] || '')) fail('EXPECTED_DATABASE_REQUIRED');
  if (options['expected-policy-hash'] !== POLICY_HASH) fail('PROMOTION_POLICY_MISMATCH');
  if (options['expected-feature-hash'] !== FEATURE_HASH) fail('FEATURE_HASH_MISMATCH');
  verifyEvidence(options['expected-evidence-hash']);
  if (options['expected-data-version'] !== undefined && !/^(0|[1-9]\d*)$/.test(options['expected-data-version'])) {
    fail('INVALID_DATA_VERSION');
  }
  if (options['expected-closed-through'] !== undefined && !day(options['expected-closed-through'])) fail('INVALID_CLOSED_THROUGH');
  if (options.execute && (!options['expected-data-version'] || !options['expected-closed-through'])) {
    fail('DRY_RUN_PRECONDITIONS_REQUIRED');
  }
  return Object.freeze(options);
}

function validateTarget(uri, expectedDatabase) {
  let target;
  try { target = new URL(uri); } catch { fail('INVALID_CLOUD_TARGET'); }
  // A dedicated URI is required. No implicit MONGODB_URI or dotenv fallback.
  if (target.protocol !== 'mongodb+srv:' || !target.hostname.endsWith('.mongodb.net')
      || target.hostname === 'localhost' || target.port
      || decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase
      || ['tls', 'ssl'].some(k => target.searchParams.has(k) && target.searchParams.get(k) !== 'true')
      || target.searchParams.get('directConnection') === 'true') fail('INVALID_CLOUD_TARGET');
  return { cloud: true, database: expectedDatabase };
}

function createCloudBootstrap(deps) {
  const { readRevision, readRegistry, countArtifacts, exportJournal, inspectDataset,
    createWorker, watermark, clock = () => new Date(), assertIndexes } = deps;
  function validateRevision(revision, expectedVersion) {
    if (!revision || revision._id !== config.businessId || revision.bootstrapStatus !== 'VERIFIED'
        || revision.historicalDatasetVersion !== config.datasetVersion
        || revision.historicalDatasetSha256 !== config.sourceSha256) fail('BOOTSTRAP_LINEAGE_INVALID');
    const version = String(revision.revision);
    if (!/^(0|[1-9]\d*)$/.test(version)) fail('INVALID_DATA_VERSION');
    if (expectedVersion !== undefined && version !== expectedVersion) fail('DATA_VERSION_MISMATCH');
    return version;
  }
  async function empty(scope, session) {
    if (await readRegistry(scope, session) || await countArtifacts(scope, session)) fail('REGISTRY_ALREADY_INITIALIZED');
  }
  async function run(options) {
    // Revalidate even when called internally instead of through the CLI parser.
    options = parseOptions(Object.entries(options).flatMap(([k, v]) => v === true ? [`--${k}`] : [`--${k}`, String(v)]));
    const evidence = verifyEvidence(options['expected-evidence-hash']);
    const version = validateRevision(await readRevision(), options['expected-data-version']);
    const closed = watermark(clock());
    if (!day(closed) || closed < config.historicalCutoff) fail('INVALID_CLOSED_THROUGH');
    if (options['expected-closed-through'] && options['expected-closed-through'] !== closed) fail('CLOSED_THROUGH_CHANGED');
    for (const n of [7, 14]) await empty(scopeFor(n));
    // Read-only, full version-pinned A.3.3 export; never a limited serving snapshot.
    const journal = await exportJournal(version);
    const horizons = [];
    for (const n of [7, 14]) {
      const result = await inspectDataset({ ...scopeFor(n), inputDataVersion: version,
        observationsClosedThrough: closed, journal, mode: 'bootstrap', dryRun: true,
        expectedEvidenceHash: EVIDENCE_HASH });
      if (result.status !== 'FEASIBLE' || result.horizonDays !== n || result.trainedDataVersion !== version
          || result.observationsClosedThrough !== closed || result.evidenceHash !== EVIDENCE_HASH
          || result.featureHash !== FEATURE_HASH || result.promotionPolicyHash !== POLICY_HASH
          || !Number.isSafeInteger(result.trainRows) || result.trainRows < 1
          || !/^[a-f0-9]{64}$/.test(result.sourceDatasetHash || '')) fail('DATASET_NOT_FEASIBLE');
      horizons.push({ horizonDays: n, registry: 'ABSENT', evidence: 'VERIFIED', dataset: 'FEASIBLE',
        proposedModelVersion: 1, action: 'WOULD_CREATE_CANDIDATE_AND_PROMOTE' });
    }
    validateRevision(await readRevision(), version);
    for (const n of [7, 14]) await empty(scopeFor(n));
    const report = { mode: options.execute ? 'EXECUTE' : 'DRY_RUN', cloud: true,
      tenant: 'MINI…V3', scenario: config.scenarioId, dataVersion: version,
      observationsClosedThrough: closed, expectedDataVersion: version, evidenceHash: EVIDENCE_HASH,
      historicalDatasetHash: evidence.historicalDatasetSha256, horizons, writesPerformed: 0 };
    // This inspection is read-only even on an empty database. Never initialize indexes here.
    try { await assertIndexes(); report.executionPrerequisites = 'READY'; }
    catch (error) {
      if (options.execute || error.code !== 'ML_INDEXES_NOT_READY') throw error;
      report.executionPrerequisites = 'ML_INDEXES_NOT_READY';
      for (const horizon of horizons) horizon.action = 'BLOCKED_ML_INDEXES';
    }
    if (!options.execute) return report;
    const guard = async ({ horizonDays, inputDataVersion, observationsClosedThrough, phase, session, modelVersion }) => {
      verifyEvidence(EVIDENCE_HASH);
      validateRevision(await readRevision(session), inputDataVersion);
      if (watermark(clock()) !== observationsClosedThrough) fail('CLOSED_THROUGH_CHANGED');
      const scope = scopeFor(horizonDays);
      if (phase !== 'promotion') return empty(scope, session);
      const pointer = await readRegistry(scope, session);
      if (!pointer || pointer.generation !== 0 || pointer.activeArtifactId != null
          || pointer.activeModelVersion != null || pointer.lastIssuedModelVersion !== 1 || modelVersion !== 1) {
        fail('REGISTRY_CAS_CONFLICT');
      }
    };
    const worker = createWorker(guard);
    report.writesPerformed = null; // Do not claim an exact metadata-write count.
    for (const horizon of horizons) {
      try {
        const result = await worker.process({ ...scopeFor(horizon.horizonDays), inputDataVersion: version,
          observationsClosedThrough: closed, mode: 'bootstrap' });
        if (result.status !== 'PROMOTED') fail('BOOTSTRAP_NOT_PROMOTED');
        horizon.action = 'PROMOTED'; horizon.modelVersion = result.modelVersion;
      } catch (error) {
        horizon.action = 'FAILED';
        const safeReasons = new Set(['DATA_VERSION_MISMATCH', 'CLOSED_THROUGH_CHANGED', 'REGISTRY_ALREADY_INITIALIZED',
          'REGISTRY_CAS_CONFLICT', 'BOOTSTRAP_LINEAGE_INVALID', 'BOOTSTRAP_EVIDENCE_HASH_MISMATCH',
          'TRAINING_RESPONSE_INVALID', 'TRAINING_RUNTIME_UNAVAILABLE', 'TRAINING_TIMEOUT', 'ARTIFACT_PARITY_FAILED']);
        horizon.reasonCode = safeReasons.has(error.code) ? error.code : 'BOOTSTRAP_HORIZON_FAILED';
        for (const remaining of horizons) if (remaining.action === 'WOULD_CREATE_CANDIDATE_AND_PROMOTE') remaining.action = 'NOT_ATTEMPTED';
        // Independent horizons: preserve an already committed ACTIVE; stop, never retry.
        report.status = horizons.some(h => h.action === 'PROMOTED') ? 'PARTIAL' : 'FAILED';
        return report;
      }
    }
    report.status = 'PROMOTED';
    return report;
  }
  return { run };
}

module.exports = { EVIDENCE_HASH, POLICY_HASH, FEATURE_HASH, verifyEvidence, parseOptions,
  validateTarget, createCloudBootstrap };
