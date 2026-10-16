'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const config = require('../config/v3Operational');
const { ForecastTrainingJob: Job, ForecastMlUpdateState: State,
  ForecastModelRegistry: Registry, V3OperationalRevision: Revision } = require('../models');
const coordinator = require('./forecastMlUpdateCoordinator');
const { createForecastModelRegistryService } = require('./forecastModelRegistryService');

const ROOT = path.resolve(__dirname, '../../..');
const POLICY_HASH = '522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3';
const FEATURE_HASH = '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonicalBytes = value => Buffer.from(JSON.stringify(stable(value)), 'utf8');
const sanitized = value => /^[A-Z][A-Z0-9_]{0,79}$/.test(String(value)) ? String(value) : 'TRAINING_FAILED';

function runPython(request, { executable = process.env.FORECAST_TRAINING_PYTHON || 'python',
  timeoutMs = 120000, moduleName = 'ml.service.v3_ridge_training' } = {}) {
  if (!['ml.service.v3_ridge_training', 'ml.service.v3_ridge_bundle_check'].includes(moduleName)) {
    throw new Error('Invalid internal Python module');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-m', moduleName],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let oversized = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) { oversized = true; child.kill(); }
    });
    // Do not expose Python traceback, journal data, model bytes or credentials.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('Python training runtime unavailable'), { code: 'TRAINING_RUNTIME_UNAVAILABLE' })); });
    child.on('close', code => {
      clearTimeout(timer);
      if (oversized || code !== 0) return reject(Object.assign(new Error('Python trainer failed'),
        { code: oversized ? 'TRAINING_RESPONSE_INVALID' : timedOut ? 'TRAINING_TIMEOUT' : 'TRAINING_RUNTIME_UNAVAILABLE' }));
      try {
        const envelope = JSON.parse(output);
        if (envelope.ok === false) return reject(Object.assign(new Error('Training rejected'), { code: sanitized(envelope.code) }));
        if (envelope.ok !== true || !envelope.result) throw new Error('Invalid trainer envelope');
        resolve(envelope.result);
      } catch (error) {
        reject(Object.assign(new Error('Trainer response incompatible'), { code: sanitized(error.code || 'TRAINING_RESPONSE_INVALID') }));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function createForecastRidgeTrainingWorker({ registry = createForecastModelRegistryService(),
  update = coordinator, runTraining = runPython, jobModel = Job,
  stateModel = State, pointerModel = Registry, revisionModel = Revision,
  clock = () => new Date(), beforePromotion,
  log = (event, fields) => console.info(JSON.stringify({ event, ...fields })) } = {}) {
  const { inBoundedTransaction } = require('./forecastModelRegistryService');
  const scope = (horizonDays, businessId = config.businessId, scenarioId = config.scenarioId) => {
    if (![7, 14].includes(horizonDays)) throw Object.assign(new Error('Unsupported horizon'), { code: 'MODEL_NOT_APPROVED' });
    if (businessId !== config.businessId || scenarioId !== config.scenarioId) {
      throw Object.assign(new Error('Invalid training scope'), { code: 'INVALID_SCOPE' });
    }
    return { businessId, scenarioId, horizonDays };
  };
  const codeOf = error => ['MongooseServerSelectionError', 'MongoServerSelectionError', 'MongoNetworkError'].includes(error.name)
    ? 'MONGO_UNAVAILABLE' : sanitized(typeof error.code === 'string' ? error.code : error.message);
  const retryable = (error, code) => error.hasErrorLabel?.('TransientTransactionError')
    || [112, 11000].includes(error.code) || ['TRAINING_EXPORT_VERSION_MISMATCH', 'TRAINING_RUNTIME_UNAVAILABLE',
      'COMMIT_RESULT_UNKNOWN', 'TRANSACTION_RETRY_EXHAUSTED', 'ACK_PENDING', 'TRAINING_TIMEOUT', 'MONGO_UNAVAILABLE'].includes(code);
  async function assertFence(claim, session) {
    if (!claim) return;
    const result = await stateModel.updateOne({ ...scope(claim.horizonDays, claim.businessId, claim.scenarioId),
      status: 'CLAIMED', leaseOwner: claim.leaseOwner, fencingToken: claim.fencingToken,
      claimedDataVersion: BigInt(claim.inputDataVersion), claimedMatureOrigin: claim.latestMatureOrigin,
      leaseUntil: { $gt: clock() } }, { $currentDate: { lastAttemptAt: true } }, { session }).exec();
    if (result.matchedCount !== 1) throw Object.assign(new Error('Stale training lease'), { code: 'STALE_FENCING_TOKEN' });
  }
  async function mutateJob(job, claim, values, session) {
    const result = await jobModel.updateOne({ _id: job._id,
      ...(claim ? { fencingToken: claim.fencingToken } : {}) }, { $set: values },
    { session, runValidators: true }).exec();
    if (result.matchedCount !== 1) throw Object.assign(new Error('Job ownership changed'), { code: 'STALE_FENCING_TOKEN' });
  }
  async function saveJob(job, claim, values) {
    await inBoundedTransaction(async session => {
      await assertFence(claim, session);
      await mutateJob(job, claim, values, session);
    });
    Object.assign(job, values);
  }
  async function exportJournal(inputDataVersion) {
    const journal = [];
    const exported = await update.exportOperationalChanges({ businessId: config.businessId,
      scenarioId: config.scenarioId, inputDataVersion, onPage: async page => {
        journal.push(...JSON.parse(JSON.stringify(page, (_, value) => typeof value === 'bigint' ? String(value) : value)));
      } });
    if (!exported.complete) throw Object.assign(new Error('Incomplete journal'), { code: 'DATASET_INVALID' });
    return journal;
  }
  async function acknowledge(job, claim) {
    if (!claim || job.ackedAt) return;
    const begin = Date.now();
    const accepted = await update.ackUpdate({ ...claim, inputDataVersion: job.inputDataVersion,
      processedMatureOrigin: job.matureOrigin, modelVersion: job.candidateModelVersion || null,
      outcome: job.outcome, jobKey: job.trainingKey, now: clock(),
      onFinish: session => mutateJob(job, claim, { ackedAt: clock(), failureCode: null, retryable: null }, session) });
    if (!accepted) throw Object.assign(new Error('Claim no longer owns ACK'), { code: 'STALE_FENCING_TOKEN' });
    job.ackedAt = clock();
    return Date.now() - begin;
  }
  async function process({ horizonDays, businessId = config.businessId, scenarioId = config.scenarioId,
    inputDataVersion, observationsClosedThrough, claim = null, mode = 'automatic' }) {
    const key = scope(horizonDays, businessId, scenarioId);
    if (!['automatic', 'bootstrap'].includes(mode) || (mode === 'automatic' && !claim)
        || (mode === 'bootstrap' && claim) || typeof inputDataVersion !== 'string'
        || !/^(0|[1-9]\d*)$/.test(inputDataVersion) || !/^\d{4}-\d{2}-\d{2}$/.test(observationsClosedThrough)
        || (claim && (claim.businessId !== businessId || claim.scenarioId !== scenarioId
          || claim.horizonDays !== horizonDays || claim.inputDataVersion !== inputDataVersion
          || claim.observationsClosedThrough !== observationsClosedThrough
          || claim.latestMatureOrigin !== update.matureOrigin(observationsClosedThrough, horizonDays)))) {
      throw Object.assign(new Error('Invalid training boundary'), { code: 'DATASET_INVALID' });
    }
    const matureOrigin = claim?.latestMatureOrigin
      || update.matureOrigin(observationsClosedThrough, horizonDays);
    const trainingKey = sha256(canonicalBytes({ ...key, inputDataVersion, matureOrigin,
      observationsClosedThrough, mode, recipe: 'RIDGE-CAUSAL27', featureHash: FEATURE_HASH,
      policyHash: POLICY_HASH, historicalDatasetHash: config.sourceSha256 }));
    let job;
    const started = Date.now();
    const times = {};
    try {
      const pointer = await pointerModel.findOne(key).lean();
      await inBoundedTransaction(async session => {
        await assertFence(claim, session);
        job = await jobModel.findOneAndUpdate({ ...key, trainingKey }, {
          $setOnInsert: { ...key, trainingKey, inputDataVersion, matureOrigin,
            observationsClosedThrough, mode, expectedGeneration: pointer?.generation || 0,
            status: 'CLAIMED', startedAt: clock() },
          $set: { fencingToken: claim?.fencingToken || null }
        }, { upsert: true, new: true, session, setDefaultsOnInsert: true, runValidators: true })
          .select('+preparedCandidate').lean();
      });
      if (job.outcome) {
        times.ack = await acknowledge(job, claim);
        return { status: job.outcome, modelVersion: job.candidateModelVersion, idempotent: true, performanceMs: times };
      }
      if (job.status === 'FAILED' && job.retryable === false) {
        throw Object.assign(new Error('Terminal training job'), { code: job.failureCode || 'TRAINING_FAILED' });
      }
      let result = job.preparedCandidate;
      if (!result) {
        await saveJob(job, claim, { status: 'TRAINING', failureCode: null });
        log('ML_RETRAIN_STARTED', { jobId: String(job._id), horizonDays, dataVersion: inputDataVersion });
        const journal = await exportJournal(inputDataVersion);
        result = await runTraining({ ...key, inputDataVersion, observationsClosedThrough, journal, mode });
        const validStatus = ['PASS', 'REJECTED', 'INSUFFICIENT_EVALUATION_HISTORY',
          'BOOTSTRAP_FROM_APPROVED_HISTORICAL_EVIDENCE'].includes(result.evaluationStatus);
        if (!validStatus || result.featureHash !== FEATURE_HASH || result.promotionPolicyHash !== POLICY_HASH
            || result.trainedDataVersion !== inputDataVersion || !/^[a-f0-9]{64}$/.test(result.sourceDatasetHash)) {
          throw Object.assign(new Error('Trainer contract mismatch'), { code: 'TRAINING_RESPONSE_INVALID' });
        }
        if (mode === 'automatic' && (result.checks?.policyHash !== POLICY_HASH
            || result.checks.status !== result.evaluationStatus)) {
          throw Object.assign(new Error('Policy contract mismatch'), { code: 'TRAINING_RESPONSE_INVALID' });
        }
        if (mode === 'automatic' && result.evaluationStatus !== 'INSUFFICIENT_EVALUATION_HISTORY') {
          const protocol = result.checks.protocol;
          const checks = Object.values(result.checks.checks || {});
          const pass = result.evaluationStatus === 'PASS';
          if (!protocol || protocol.status !== 'READY' || protocol.requiredOrigins !== 107
              || protocol.observationsClosedThrough !== observationsClosedThrough
              || protocol.horizonDays !== horizonDays || protocol.availableOrigins < 107
              || JSON.stringify(protocol.foldLengths) !== '[31,30,46]' || checks.length === 0
              || !Array.isArray(result.checks.reasons) || !Array.isArray(result.checks.catastrophicVeto)
              || checks.some(value => typeof value !== 'boolean')
              || (pass && (checks.some(value => !value) || result.checks.reasons?.length
                || result.checks.catastrophicVeto?.length))
              || (!pass && (checks.every(Boolean) || result.checks.reasons.length === 0))) {
            throw Object.assign(new Error('Policy outcome is inconsistent with evidence'), { code: 'TRAINING_RESPONSE_INVALID' });
          }
        }
        if (result.evaluationStatus !== 'INSUFFICIENT_EVALUATION_HISTORY'
            && (!result.artifact || result.artifact.modelVersion !== null
              || result.artifact.businessId !== businessId || result.artifact.scenarioId !== scenarioId
              || result.artifact.horizonDays !== horizonDays || result.artifact.featureHash !== FEATURE_HASH
              || !Number.isFinite(result.parityMaxAbsoluteError) || result.parityMaxAbsoluteError > 1e-10)) {
          throw Object.assign(new Error('Artifact scope mismatch'), { code: 'TRAINING_RESPONSE_INVALID' });
        }
        await saveJob(job, claim, { status: 'EVALUATING', preparedCandidate: result,
          sourceDatasetHash: result.sourceDatasetHash, evaluation: result.checks,
          metricsSummary: { globalWape: result.globalWape ?? null, globalMae: result.globalMae ?? null,
            globalBias: result.globalBias ?? null, parityMaxAbsoluteError: result.parityMaxAbsoluteError ?? null,
            performanceMs: result.performanceMs || {} } });
      }
      if (result.evaluationStatus === 'INSUFFICIENT_EVALUATION_HISTORY') {
        await saveJob(job, claim, { status: 'REJECTED', outcome: 'NO_PROMOTION_INSUFFICIENT_HISTORY',
          finishedAt: clock(), failureCode: null });
        times.ack = await acknowledge(job, claim);
        log('ML_CANDIDATE_REJECTED', { jobId: String(job._id), horizonDays, dataVersion: inputDataVersion,
          outcome: job.outcome });
        return { status: job.outcome, modelVersion: null, performanceMs: times };
      }
      let modelVersion = job.candidateModelVersion;
      if (modelVersion == null) {
        const begin = Date.now();
        const candidate = await registry.createCandidateMetadata({ ...key,
          modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', trainedAt: new Date(job.startedAt),
          trainedDataVersion: result.trainedDataVersion, dataCutoff: result.dataCutoff,
          trainingWindow: result.trainingWindow, labelClosedThrough: result.labelClosedThrough,
          featureVersion: result.featureVersion, featureHash: result.featureHash,
          promotionPolicyVersion: result.promotionPolicyVersion, promotionPolicyHash: result.promotionPolicyHash,
          sourceDatasetHash: result.sourceDatasetHash, globalWape: result.globalWape,
          globalMae: result.globalMae, globalBias: result.globalBias, checks: result.checks,
          lineage: result.lineage, triggerReason: mode === 'bootstrap'
            ? 'BOOTSTRAP_FROM_APPROVED_HISTORICAL_EVIDENCE' : claim.historicalCorrection ? 'HISTORICAL_CORRECTION' : 'MATURE_OPERATIONAL_UPDATE',
          idempotencyKey: trainingKey, precondition: session => assertFence(claim, session),
          artifactFactory: version => canonicalBytes({ ...result.artifact, modelVersion: version }),
          onCreated: async (session, metadata) => {
            await mutateJob(job, claim, { candidateModelVersion: metadata.modelVersion, status: 'PERSISTING' }, session);
          } });
        modelVersion = candidate.modelVersion;
        job.candidateModelVersion = modelVersion;
        times.candidatePersistence = Date.now() - begin;
        log('ML_CANDIDATE_CREATED', { jobId: String(job._id), horizonDays,
          dataVersion: inputDataVersion, modelVersion, policyOutcome: result.evaluationStatus });
      }
      const pass = result.evaluationStatus === 'PASS' || result.evaluationStatus === 'BOOTSTRAP_FROM_APPROVED_HISTORICAL_EVIDENCE';
      const outcome = pass ? 'PROMOTED' : 'REJECTED';
      const finalized = { status: outcome, outcome, finishedAt: clock(), failureCode: null, retryable: null };
      const begin = Date.now();
      if (pass) {
        if (beforePromotion) await beforePromotion({ job, claim, modelVersion });
        await registry.promoteCandidate({ ...key, modelVersion, expectedGeneration: job.expectedGeneration,
          precondition: session => assertFence(claim, session),
          onPromoted: session => mutateJob(job, claim, finalized, session) });
        times.promotion = Date.now() - begin;
        log('ML_MODEL_PROMOTED', { jobId: String(job._id), horizonDays, dataVersion: inputDataVersion,
          modelVersion, policyOutcome: result.evaluationStatus, durationMs: Date.now() - started });
      } else {
        await registry.rejectCandidate({ ...key, modelVersion, precondition: session => assertFence(claim, session),
          onTransition: session => mutateJob(job, claim, finalized, session) });
        times.rejection = Date.now() - begin;
        log('ML_CANDIDATE_REJECTED', { jobId: String(job._id), horizonDays,
          dataVersion: inputDataVersion, modelVersion, policyOutcome: result.evaluationStatus });
      }
      Object.assign(job, finalized);
      times.ack = await acknowledge(job, claim);
      await jobModel.updateOne({ _id: job._id }, { $set: { 'metricsSummary.lifecycleMs': times } }).exec();
      return { status: outcome, modelVersion, performanceMs: times };
    } catch (error) {
      let code = codeOf(error);
      let canRetry = Boolean(retryable(error, code));
      if (code === 'CONFLICT') { code = 'REGISTRY_CAS_CONFLICT'; canRetry = false; }
      if (job) {
        // A transaction may have committed promotion before a reply/ACK failed.
        const persisted = await jobModel.findById(job._id).lean().catch(() => null);
        if (persisted?.outcome) {
          job = persisted;
          if (code !== 'STALE_FENCING_TOKEN') { code = 'ACK_PENDING'; canRetry = true; }
        } else if (code !== 'STALE_FENCING_TOKEN') {
          try {
            const failed = { status: 'FAILED', failureCode: code, retryable: canRetry, finishedAt: clock() };
            const version = persisted?.candidateModelVersion || job.candidateModelVersion;
            if (version && !canRetry) {
              await registry.markCandidateFailed({ ...key, modelVersion: version, failureCode: code,
                precondition: session => assertFence(claim, session),
                onTransition: session => mutateJob(job, claim, failed, session) });
            } else await saveJob(job, claim, failed);
          } catch (recordError) {
            if (codeOf(recordError) === 'STALE_FENCING_TOKEN') code = 'STALE_FENCING_TOKEN';
          }
        }
      }
      if (claim) await update.failUpdate({ ...claim, inputDataVersion, processedMatureOrigin: matureOrigin,
        failureCode: code, retryable: canRetry, now: clock() }).catch(() => false);
      log('ML_RETRAIN_FAILED', { jobId: job ? String(job._id) : null,
        horizonDays, dataVersion: inputDataVersion, failureCode: code, retryable: canRetry });
      throw Object.assign(error, { code });
    }
  }
  async function runEligible({ horizonDays, leaseOwner, businessId = config.businessId, scenarioId = config.scenarioId }) {
    const key = scope(horizonDays, businessId, scenarioId);
    const claim = await update.claimEligibleUpdate({ ...key, leaseOwner, now: clock() });
    if (!claim) return null;
    return process({ ...key, inputDataVersion: claim.inputDataVersion,
      observationsClosedThrough: claim.observationsClosedThrough, claim });
  }
  async function bootstrapLocal({ horizonDays, observationsClosedThrough }) {
    const key = scope(horizonDays);
    const existing = await registry.getActiveModelMetadata(key);
    if (existing) return { status: 'PROMOTED', modelVersion: existing.modelVersion, idempotent: true };
    const revision = await revisionModel.findById(config.businessId).setOptions({ useBigInt64: true }).lean();
    if (!revision || revision.bootstrapStatus !== 'VERIFIED' || revision.historicalDatasetVersion !== config.datasetVersion
        || revision.historicalDatasetSha256 !== config.sourceSha256) {
      throw Object.assign(new Error('V3 bootstrap lineage is unverified'), { code: 'BOOTSTRAP_LINEAGE_INVALID' });
    }
    return process({ horizonDays, inputDataVersion: String(revision.revision), observationsClosedThrough, mode: 'bootstrap' });
  }
  return Object.freeze({ runEligible, bootstrapLocal, process });
}

module.exports = { createForecastRidgeTrainingWorker, runPython, canonicalBytes };
