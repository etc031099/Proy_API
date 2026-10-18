'use strict';

// Cloud CLI orchestration only. Eligibility and every mutation belong to the
// existing coordinator/worker. Importing this module opens no connection.
const { randomUUID } = require('node:crypto');
const config = require('../config/v3Operational');

const HORIZONS = Object.freeze([7, 14]);
const TRAINING_TIMEOUT_MS = 120000;
const CYCLE_TIMEOUT_MS = 8 * 60 * 1000;
const SAFE_CODES = new Set([
  'STALE_TEST_EPOCH', 'TEST_CLOUD_WORKER_DISABLED', 'TEST_RESTORE_BLOCKED', 'TEST_TRANSACTION_REQUIRED', 'TEST_EPOCH_CONTEXT_REQUIRED',
  'INVALID_CLOUD_ARGUMENTS', 'CLOUD_ENV_REQUIRED', 'INVALID_CLOUD_TARGET', 'CLOUD_SCOPE_MISMATCH',
  'CLOUD_CONNECTION_FAILED', 'CLOUD_DATABASE_MISMATCH', 'CLOUD_REPLICA_SET_REQUIRED',
  'ML_COLLECTIONS_NOT_READY', 'ML_INDEXES_NOT_READY', 'BOOTSTRAP_LINEAGE_INVALID',
  'ACTIVE_MODEL_REQUIRED', 'REGISTRY_INCONSISTENT', 'ARTIFACT_HASH_MISMATCH', 'ARTIFACT_INVALID',
  'ACTIVE_METADATA_INVALID', 'PYTHON_UNAVAILABLE', 'PYTHON_PREFLIGHT_FAILED', 'PYTHON_PREFLIGHT_TIMEOUT',
  'PYTHON_IMPORT_FAILED', 'PROMOTION_POLICY_MISMATCH', 'INVALID_UPDATE_STATE',
  'TRAINING_RUNTIME_UNAVAILABLE', 'TRAINING_RESPONSE_INVALID', 'TRAINING_EXPORT_VERSION_MISMATCH',
  'TRAINING_TIMEOUT', 'TRAINING_FAILED', 'DATASET_INVALID', 'FEATURE_UNAVAILABLE',
  'INSUFFICIENT_MATURE_LABELS', 'ARTIFACT_PARITY_FAILED', 'ARTIFACT_TOO_LARGE',
  'POLICY_COMPUTATION_FAILED', 'STALE_FENCING_TOKEN', 'REGISTRY_CAS_CONFLICT',
  'ACK_PENDING', 'COMMIT_RESULT_UNKNOWN', 'TRANSACTION_RETRY_EXHAUSTED', 'MONGO_UNAVAILABLE',
  'WORKER_RESPONSE_INVALID', 'WORKER_CYCLE_TIMEOUT', 'WORKER_FAILED',
  'ML_HISTORY_NOT_READY', 'ML_HISTORY_INDEX_MISSING', 'ML_HISTORY_INDEX_INCOMPATIBLE',
  'ML_HISTORY_INDEX_NAME_CONFLICT', 'INVALID_EXECUTION_IDENTITY', 'CLI_INVOCATION_KEY_REQUIRED',
  'MANUAL_CORRELATION_INVALID', 'EXECUTION_CONFLICT', 'PROMOTION_HISTORY_MISSING',
]);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => SAFE_CODES.has(error?.code) ? error.code
  : ['MongooseServerSelectionError', 'MongoServerSelectionError', 'MongoNetworkError'].includes(error?.name)
    ? 'MONGO_UNAVAILABLE' : 'WORKER_FAILED';
const parseMode = argv => {
  if (argv.length !== 1 || !['--check', '--status', '--run'].includes(argv[0])) fail('INVALID_CLOUD_ARGUMENTS');
  return argv[0].slice(2).toUpperCase();
};

function validateEnvironment(env) {
  const names = ['FORECAST_CLOUD_MONGO_URI', 'FORECAST_CLOUD_EXPECTED_DATABASE',
    'FORECAST_CLOUD_EXPECTED_BUSINESS_ID', 'FORECAST_CLOUD_EXPECTED_SCENARIO_ID', 'FORECAST_TRAINING_PYTHON'];
  if (names.some(name => typeof env[name] !== 'string' || !env[name].trim())) fail('CLOUD_ENV_REQUIRED');
  if (env.FORECAST_CLOUD_EXPECTED_BUSINESS_ID !== config.businessId
      || env.FORECAST_CLOUD_EXPECTED_SCENARIO_ID !== config.scenarioId) fail('CLOUD_SCOPE_MISMATCH');
  const database = env.FORECAST_CLOUD_EXPECTED_DATABASE;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(database)) fail('INVALID_CLOUD_TARGET');
  let uri;
  try { uri = new URL(env.FORECAST_CLOUD_MONGO_URI); } catch { fail('INVALID_CLOUD_TARGET'); }
  let path;
  try { path = decodeURIComponent(uri.pathname.slice(1)); } catch { fail('INVALID_CLOUD_TARGET'); }
  if (uri.protocol !== 'mongodb+srv:' || !uri.hostname.endsWith('.mongodb.net') || uri.port
      || uri.hash || path !== database || !uri.username || !uri.password
      || ['tls', 'ssl'].some(key => uri.searchParams.has(key) && uri.searchParams.get(key) !== 'true')
      || ['tlsInsecure', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames', 'directConnection']
        .some(key => uri.searchParams.has(key) && uri.searchParams.get(key) !== 'false')) fail('INVALID_CLOUD_TARGET');
  return Object.freeze({ uri: env.FORECAST_CLOUD_MONGO_URI, database,
    businessId: config.businessId, scenarioId: config.scenarioId, python: env.FORECAST_TRAINING_PYTHON });
}

const version = value => {
  const text = String(value ?? '');
  if (!/^(0|[1-9]\d*)$/.test(text) || BigInt(text) > 9223372036854775807n) fail('INVALID_UPDATE_STATE');
  return text;
};

// Read-only projection of refreshWatermarks, with the coordinator's eligible()
// as the authority. Never refresh/claim from --check or --status.
function describePending(row, horizonDays, update, now) {
  const closedThrough = update.watermark(now);
  const base = { horizonDays, closedThrough, pending: false, eligibility: 'NO_PENDING_WORK' };
  if (!row) return base;
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (row.businessId !== config.businessId || row.scenarioId !== config.scenarioId
      || row.horizonDays !== horizonDays || !['PENDING', 'READY', 'CLAIMED', 'IDLE'].includes(row.status)
      || !(row.nextEligibleAt instanceof Date) || !Number.isFinite(row.nextEligibleAt.getTime())
      || !(row.lastDirtyAt instanceof Date) || !Number.isFinite(row.lastDirtyAt.getTime())
      || !['observationsClosedThrough', 'latestMatureOrigin', 'initialMatureOrigin'].every(key => day(row[key]))
      || (row.lastTrainedMatureOrigin != null && !day(row.lastTrainedMatureOrigin))
      || (row.lastAttemptAt != null && (!(row.lastAttemptAt instanceof Date) || !Number.isFinite(row.lastAttemptAt.getTime())))
      || row.observationsClosedThrough > closedThrough) fail('INVALID_UPDATE_STATE');
  const origin = update.matureOrigin(closedThrough, horizonDays);
  if (row.latestMatureOrigin > origin) fail('INVALID_UPDATE_STATE');
  const projected = { ...row, observationsClosedThrough: closedThrough,
    latestMatureOrigin: origin > row.latestMatureOrigin ? origin : row.latestMatureOrigin };
  if (row.status === 'CLAIMED' && !(row.leaseUntil instanceof Date)) fail('INVALID_UPDATE_STATE');
  const expiredLease = row.status === 'CLAIMED' && row.leaseUntil <= now;
  if (expiredLease) projected.lastAttemptAt = null;
  const latestDataVersion = version(row.latestDataVersion);
  const lastProcessedDataVersion = row.lastProcessedDataVersion == null ? null : version(row.lastProcessedDataVersion);
  if (lastProcessedDataVersion != null && BigInt(lastProcessedDataVersion) > BigInt(latestDataVersion)) fail('INVALID_UPDATE_STATE');
  const newOrigin = projected.latestMatureOrigin > (row.lastTrainedMatureOrigin || row.initialMatureOrigin);
  const correction = row.historicalCorrectionVersion != null;
  const pending = lastProcessedDataVersion == null || BigInt(latestDataVersion) > BigInt(lastProcessedDataVersion)
    || correction || newOrigin;
  let eligibility;
  if (row.status === 'CLAIMED' && !expiredLease) eligibility = 'LEASE_ACTIVE';
  else if (update.eligible(projected, now)) eligibility = 'ELIGIBLE';
  else if (!pending) eligibility = 'NO_PENDING_WORK';
  else if (row.lastFailureRetryable === false && row.lastFailedDataVersion != null
      && version(row.lastFailedDataVersion) === latestDataVersion
      && row.lastFailedMatureOrigin >= projected.latestMatureOrigin) eligibility = 'PREVIOUS_FAILURE_NOT_RETRYABLE';
  else if (row.nextEligibleAt > now) eligibility = 'DEBOUNCE_NOT_ELAPSED';
  else if (!newOrigin && !correction) eligibility = 'NOT_MATURE';
  else eligibility = 'COOLDOWN_ACTIVE';
  return { ...base, pending: pending || row.manualPending === true || eligibility === 'LEASE_ACTIVE', eligibility,
    manualPending: row.manualPending === true,
    state: row.status, latestDataVersion, lastProcessedDataVersion,
    latestMatureOrigin: projected.latestMatureOrigin, historicalCorrection: correction,
    nextEligibleAt: row.nextEligibleAt.toISOString(), expiredLease };
}

function createCloudWorker({ preflight, readState, runEligible, completeManualEvaluation,
  update, executionHistory, predictionImpact, clock = () => new Date() }) {
  const impact = async (method, input) => {
    try { return await predictionImpact?.[method]?.(input); }
    catch { return { status: 'PENDING', reasonCode: 'IMPACT_SCORING_FAILED' }; }
  };
  async function cycle(mode, context) {
    if (!['CHECK', 'STATUS', 'RUN'].includes(mode)) fail('INVALID_CLOUD_ARGUMENTS');
    const started = clock().getTime();
    if (mode === 'RUN' && executionHistory) {
      const audit = await executionHistory.begin();
      context.executionId = audit.executionId;
      if (audit.duplicate) {
        const recoveredImpact = await impact('calculate', { executionId: audit.executionId });
        return { status: 'OK', mode, executionId: audit.executionId,
          result: 'EXECUTION_ALREADY_RECORDED', horizons: [], writesPerformed: null, writesMayHaveOccurred: true,
          ...(recoveredImpact ? { predictionImpact: recoveredImpact } : {}) };
      }
    }
    const inspected = await preflight();
    if (mode === 'RUN' && executionHistory) await executionHistory.preflight(inspected);
    if (mode === 'RUN') await impact('recoverPending');
    const report = { status: 'OK', mode, businessId: 'MINI…V3', scenarioId: config.scenarioId,
      dataVersion: version(inspected.dataVersion), closedThrough: update.watermark(clock()),
      preflight: { status: 'PASS', python: 'PASS', activeModels: 'PASS', indexes: 'PASS' },
      limits: { maxJobsPerHorizon: 1, maxJobsPerCycle: 2, trainingTimeoutMs: TRAINING_TIMEOUT_MS,
        cycleTimeoutMs: CYCLE_TIMEOUT_MS }, horizons: [], writesPerformed: 0, writesMayHaveOccurred: false };
    const owner = `cloud-${randomUUID()}`;
    if (mode === 'RUN' && executionHistory) {
      report.executionId = executionHistory.executionId;
      report.writesPerformed = null; report.writesMayHaveOccurred = true;
    }
    for (const horizonDays of HORIZONS) {
      const active = inspected.activeModels.find(row => row.horizonDays === horizonDays);
      const readiness = inspected.promotionReadiness[String(horizonDays)];
      if (!active || !Number.isSafeInteger(active.modelVersion) || active.modelVersion < 1
          || !['READY', 'NO_PROMOTION_INSUFFICIENT_HISTORY'].includes(readiness?.status)
          || readiness.requiredOrigins !== 107 || !Number.isSafeInteger(readiness.availableOrigins)
          || readiness.availableOrigins < 0) fail('WORKER_RESPONSE_INVALID');
      const promotionReadiness = { status: readiness.status, availableOrigins: readiness.availableOrigins, requiredOrigins: 107 };
      const item = { horizonDays, activeModelVersionAtPreflight: active.modelVersion,
        activeTrainedDataVersionAtPreflight: version(active.trainedDataVersion), promotionReadiness };
      report.horizons.push(item);
      if (mode === 'CHECK') { item.result = 'PREFLIGHT_PASS'; continue; }
      let state;
      const describe = async () => {
        state = await readState(horizonDays);
        return describePending(state, horizonDays, update, clock());
      };
      try {
        Object.assign(item, await describe());
        item.result = item.eligibility;
        if (mode !== 'RUN') continue;
        if (item.eligibility !== 'ELIGIBLE') {
          if (state?.manualPending && item.eligibility !== 'LEASE_ACTIVE' && completeManualEvaluation) {
            report.writesPerformed = null;
            report.writesMayHaveOccurred = true;
            await completeManualEvaluation({ horizonDays, manualRequestKey: state.manualRequestKey,
              result: item.eligibility });
          }
          continue;
        }
        if (clock().getTime() - started >= CYCLE_TIMEOUT_MS) fail('WORKER_CYCLE_TIMEOUT');
        if (context.executionId) await impact('capture', { executionId: context.executionId,
          minimumDataVersion: inspected.dataVersion });
        // runEligible may write refreshed watermarks even if a concurrent claim
        // wins. Do not invent a count for the coordinator's internal writes.
        report.writesPerformed = null;
        report.writesMayHaveOccurred = true;
        const result = await runEligible({ horizonDays, businessId: config.businessId,
          scenarioId: config.scenarioId, leaseOwner: owner,
          ...(executionHistory?.executionId ? { executionId: executionHistory.executionId } : {}) });
        if (result == null) {
          Object.assign(item, await describe());
          item.result = item.eligibility === 'ELIGIBLE' ? 'CLAIM_NOT_ACQUIRED' : item.eligibility;
          continue;
        }
        const outcomes = { PROMOTED: 'CANDIDATE_PROMOTED', REJECTED: 'CANDIDATE_REJECTED',
          NO_PROMOTION_INSUFFICIENT_HISTORY: 'NO_PROMOTION_INSUFFICIENT_HISTORY' };
        if (!Object.hasOwn(outcomes, result.status)) fail('WORKER_RESPONSE_INVALID');
        item.result = outcomes[result.status];
        item.candidateModelVersion = Number.isSafeInteger(result.modelVersion) && result.modelVersion > 0
          ? result.modelVersion : null;
        item.idempotent = result.idempotent === true;
      } catch (error) {
        item.result = 'FAILED'; item.code = safeCode(error); report.status = 'FAILED';
      } finally {
        if (mode === 'RUN' && executionHistory) await executionHistory.horizon(item);
      }
    }
    if (mode === 'RUN' && executionHistory) await executionHistory.finish();
    if (mode === 'RUN' && context.executionId) {
      const calculated = await impact('calculate', { executionId: context.executionId });
      if (calculated) report.predictionImpact = calculated;
    }
    return report;
  }
  async function run(mode) {
    const context = {};
    try { return await cycle(mode, context); }
    catch (error) {
      if (mode === 'RUN' && executionHistory) await executionHistory.fail(error);
      if (mode === 'RUN' && context.executionId) await impact('calculate', { executionId: context.executionId });
      throw error;
    }
  }
  return Object.freeze({ run });
}

module.exports = { HORIZONS, TRAINING_TIMEOUT_MS, CYCLE_TIMEOUT_MS, parseMode, validateEnvironment,
  describePending, createCloudWorker, safeCode, fail };
