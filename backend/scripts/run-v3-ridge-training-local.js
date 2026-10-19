'use strict';

// Explicit local-only entrypoint. Never imported by the HTTP application.
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { ForecastModelArtifact, ForecastModelRegistry, ForecastTrainingJob,
  ForecastMlUpdateState, ForecastMlUpdateEvent } = require('../src/models');
const { watermark } = require('../src/services/forecastMlUpdateCoordinator');
const updateCoordinator = require('../src/services/forecastMlUpdateCoordinator');
const { describePending } = require('../src/services/forecastCloudWorker');
const v3Config = require('../src/config/v3Operational');
const { createForecastRidgeTrainingWorker } = require('../src/services/forecastRidgeTrainingWorker');
const mlTestFence = require('../src/services/mlTestFence');
const MANUAL_TERMINAL_DECISIONS = new Set(['NO_PENDING_WORK', 'DEBOUNCE_NOT_ELAPSED', 'NOT_MATURE',
  'COOLDOWN_ACTIVE', 'PREVIOUS_FAILURE_NOT_RETRYABLE']);

function assertLocalTarget(uri) {
  const target = new URL(uri);
  if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || !target.pathname || target.pathname === '/' || target.searchParams.has('srv')) {
    throw new Error('Refusing a non-local or unspecified Mongo database.');
  }
  return target;
}

function assertActiveTestEpoch(token) {
  if (token?.state !== 'TEST_ACTIVE' || !/^[a-f0-9-]{36}$/.test(token.testCycleId || '')
      || !/^[1-9]\d*$/.test(String(token.resetEpoch || ''))) {
    throw Object.assign(new Error('TEST_EPOCH_REQUIRED'), { code: 'TEST_EPOCH_REQUIRED' });
  }
  return token;
}

function assertLocalReplicaSetPrimary(hello) {
  if (hello?.setName !== 'rs0' || !hello.isWritablePrimary) {
    throw new Error('Local rs0 PRIMARY is required.');
  }
}

function assertBootstrapAllowed(token) {
  if (token?.state === 'TEST_ACTIVE') {
    throw Object.assign(new Error('TEST_BOOTSTRAP_ACTIVE_CYCLE_FORBIDDEN'), { code: 'TEST_BOOTSTRAP_ACTIVE_CYCLE_FORBIDDEN' });
  }
}

async function drainInCapturedEpoch({ db, worker, horizonDays, leaseOwner, token, fence = mlTestFence,
  readState, update = updateCoordinator, completeManualEvaluation = updateCoordinator.completeManualEvaluation,
  describe = describePending, now = () => new Date() }) {
  const expected = assertActiveTestEpoch(token);
  return fence.withEpoch(db, async () => {
    const result = await worker.runEligible({ horizonDays, leaseOwner });
    if (result !== null) return { result };
    if (typeof readState !== 'function') throw new Error('Local drain state reader is required.');
    const state = await readState(horizonDays);
    const details = describe(state, horizonDays, update, now());
    const evaluation = details.eligibility === 'ELIGIBLE' ? 'CLAIM_NOT_ACQUIRED' : details.eligibility;
    let manualRequestClosed = false;
    if (state?.manualPending === true && typeof state.manualRequestKey === 'string'
        && state.manualRequestKey && MANUAL_TERMINAL_DECISIONS.has(details.eligibility)) {
      manualRequestClosed = await completeManualEvaluation({ businessId: v3Config.businessId,
        scenarioId: v3Config.scenarioId, horizonDays, manualRequestKey: state.manualRequestKey,
        result: details.eligibility, now: now() });
    }
    return { result: null, evaluation, ...(state?.manualPending === true ? { manualRequestClosed } : {}) };
  }, expected);
}

async function main() {
  const uri = process.env.FORECAST_LOCAL_MONGO_URI;
  if (!uri) throw new Error('FORECAST_LOCAL_MONGO_URI is required.');
  const target = assertLocalTarget(uri);
  const mode = process.argv[2];
  const horizonDays = Number(process.argv[3]);
  if (!['--bootstrap', '--drain'].includes(mode) || ![7, 14].includes(horizonDays)) {
    throw new Error('Usage: node scripts/run-v3-ridge-training-local.js --bootstrap|--drain 7|14');
  }
  target.searchParams.set('directConnection', 'true');
  await mongoose.connect(target.href, { serverSelectionTimeoutMS: 5000 });
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assertLocalReplicaSetPrimary(hello);
    const token = await mlTestFence.capture(mongoose.connection.db);
    if (mode === '--drain') assertActiveTestEpoch(token);
    else assertBootstrapAllowed(token);
    await Promise.all([ForecastModelArtifact, ForecastModelRegistry, ForecastTrainingJob,
      ForecastMlUpdateState, ForecastMlUpdateEvent].map(model => model.init()));
    const worker = createForecastRidgeTrainingWorker();
    const outcome = mode === '--bootstrap'
      ? { result: await worker.bootstrapLocal({ horizonDays, observationsClosedThrough: watermark(new Date()) }) }
      : await drainInCapturedEpoch({ db: mongoose.connection.db, worker, horizonDays,
        leaseOwner: `local-${randomUUID()}`, token, fence: mlTestFence,
        readState: days => ForecastMlUpdateState.findOne({ businessId: v3Config.businessId,
          scenarioId: v3Config.scenarioId, horizonDays: days }).lean() });
    process.stdout.write(`${JSON.stringify({ mode, horizonDays, ...outcome })}\n`);
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.code || 'FORECAST_WORKER_FAILED'}\n`);
  process.exitCode = 1;
});

module.exports = { assertLocalTarget, assertLocalReplicaSetPrimary, assertActiveTestEpoch,
  assertBootstrapAllowed, drainInCapturedEpoch };
