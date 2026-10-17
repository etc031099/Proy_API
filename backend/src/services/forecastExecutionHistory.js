'use strict';

const D = require('./forecastMlUpdateExecutionDomain');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);

function executionIdentityFromEnv(env) {
  if (env.GITHUB_RUN_ID || env.GITHUB_REPOSITORY || env.GITHUB_RUN_ATTEMPT) {
    if (!['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
        || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')
        || !/^[1-9]\d{0,24}$/.test(env.GITHUB_RUN_ID || '')
        || !/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT || '')) D.fail('INVALID_EXECUTION_IDENTITY');
    if (env.FORECAST_MANUAL_REQUEST_KEY && !opaque(env.FORECAST_MANUAL_REQUEST_KEY)) D.fail('INVALID_EXECUTION_IDENTITY');
    return { triggerSource: env.GITHUB_EVENT_NAME === 'schedule' ? 'SCHEDULED'
      : env.FORECAST_MANUAL_REQUEST_KEY ? 'MANUAL' : 'CLI',
    github: { repository: env.GITHUB_REPOSITORY.toLowerCase(), runId: env.GITHUB_RUN_ID,
      runAttempt: Number(env.GITHUB_RUN_ATTEMPT) },
    ...(env.FORECAST_MANUAL_REQUEST_KEY ? { manualRequestKey: env.FORECAST_MANUAL_REQUEST_KEY } : {}),
    ...(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && !env.FORECAST_MANUAL_REQUEST_KEY
      ? { cliInvocationKey: `github-${env.GITHUB_RUN_ID}` } : {}) };
  }
  if (!opaque(env.FORECAST_WORKER_INVOCATION_KEY)) D.fail('CLI_INVOCATION_KEY_REQUIRED');
  return { triggerSource: 'CLI', cliInvocationKey: env.FORECAST_WORKER_INVOCATION_KEY };
}

// All execution mutations remain in the domain service; this adapter maps real
// coordinator/Registry evidence, never trains or selects a model by max(version).
function createExecutionHistory({ service, scope, identity, prepare = async () => {}, readState,
  registry, update, clock = () => new Date() }) {
  let executionId, owned = false, ownedAttempt = null, inspected;
  const args = row => ({ ...scope, executionId: row.executionId, expectedVersion: row.writeVersion });
  const current = async (api = service) => {
    const row = await api.getExecution({ ...scope, executionId });
    if (owned && row?.attempts.at(-1)?.runAttempt !== ownedAttempt) D.fail('EXECUTION_CONFLICT');
    return row;
  };
  const pending = async () => {
    const rows = await Promise.all([7, 14].map(readState));
    return rows.some((row, index) => require('./forecastCloudWorker').describePending(row, [7, 14][index], update, clock()).pending);
  };
  async function begin() {
    await prepare();
    let row = identity.github ? await service.findExecutionByGithubRun({ ...scope,
      repository: identity.github.repository, runId: identity.github.runId })
      : await service.findExecutionByCliInvocation({ ...scope, cliInvocationKey: identity.cliInvocationKey });
    if (!row) {
      const states = await Promise.all([7, 14].map(readState));
      const keys = [...new Set(states.filter(state => state?.manualPending).map(state => state.manualRequestKey))];
      if (!identity.manualRequestKey && keys.length > 1) D.fail('MANUAL_CORRELATION_INVALID');
      const key = identity.manualRequestKey || (keys.length === 1 ? keys[0] : null);
      if (identity.manualRequestKey && !keys.includes(identity.manualRequestKey)) {
        const prior = await service.findExecutionByManualRequest({ ...scope, manualRequestKey: identity.manualRequestKey });
        if (prior && (D.TERMINAL.includes(prior.status) || prior.status === 'RUNNING')) {
          return { duplicate: true, executionId: prior.executionId };
        }
        D.fail('MANUAL_CORRELATION_INVALID');
      }
      if (key) {
        row = await service.findExecutionByManualRequest({ ...scope, manualRequestKey: key });
        if (!row) {
          // Real durable request predating history support: recover its known
          // request time, not an invented original revision or training result.
          const state = states.find(value => value?.manualRequestKey === key);
          if (!state?.lastManualRequestAt || !Number.isFinite(new Date(state.lastManualRequestAt).getTime())) D.fail('MANUAL_CORRELATION_INVALID');
          row = await service.createExecution({ ...scope, triggerSource: 'MANUAL', manualRequestKey: key,
            requestedAt: state.lastManualRequestAt });
        }
        if (row.status === 'RUNNING' || D.TERMINAL.includes(row.status)) return { duplicate: true, executionId: row.executionId };
        row = await service.bindExecutionRun({ ...args(row), github: identity.github,
          cliInvocationKey: identity.cliInvocationKey, triggerSource: identity.triggerSource });
      } else row = await service.createExecution({ ...scope, ...identity });
    }
    executionId = row.executionId;
    if (!identity.github && row.status === 'INTERRUPTED') row = await service.resumeInterruptedExecution(args(row));
    if (identity.github && identity.github.runAttempt > row.github.runAttempt) {
      if (!D.TERMINAL.includes(row.status)) {
        const states = await Promise.all([7, 14].map(readState));
        if (states.some(state => state?.status === 'CLAIMED' && new Date(state.leaseUntil) > clock())) D.fail('LEASE_ACTIVE');
        row = row.perHorizon.some(h => h.resultStatus === 'PROMOTED')
          ? await service.markPartial({ ...args(row), reasonCode: 'EXECUTION_INTERRUPTED' })
          : await service.markInterrupted({ ...args(row), reasonCode: 'EXECUTION_INTERRUPTED' });
      }
      row = await service.registerGithubAttempt({ ...args(row), runAttempt: identity.github.runAttempt });
    }
    if (D.TERMINAL.includes(row.status) || row.status === 'RUNNING') return { duplicate: true, executionId };
    row = await service.startExecution({ ...args(row), stage: 'PREFLIGHT' });
    ownedAttempt = row.attempts.at(-1)?.runAttempt;
    owned = true;
    return { duplicate: false, executionId };
  }
  async function preflight(data) {
    inspected = data;
    const row = await current();
    // RUNNING stage updates are metadata, not a second start/ownership claim.
    await service.updateRunningMetadata({ ...args(row), stage: 'ELIGIBILITY', data: {
      dataVersionBefore: data.dataVersion, dataVersionEvaluated: data.dataVersion,
      observationsClosedThrough: update.watermark(clock()), pendingBefore: await pending() } });
  }
  async function horizon(item) {
    let row = await current();
    const previous = row.perHorizon.find(h => h.horizonDays === item.horizonDays);
    if (D.TERMINAL.includes(previous.resultStatus)) return;
    const after = await registry.getActiveModelMetadata({ ...scope, horizonDays: item.horizonDays });
    const status = item.result === 'FAILED' ? 'FAILED' : item.result === 'NO_PENDING_WORK' ? 'NO_PENDING_WORK'
      : item.result === 'CANDIDATE_PROMOTED' ? null
        : ['CANDIDATE_REJECTED', 'NO_PROMOTION_INSUFFICIENT_HISTORY'].includes(item.result)
          ? 'EVALUATED_NO_PROMOTION' : 'NOT_ELIGIBLE';
    // A plain worker return value is not authoritative promotion evidence: the
    // transaction hook must already have recorded a confirmed promotion.
    if (!status) D.fail('PROMOTION_HISTORY_MISSING');
    const before = previous.activeVersionBefore ?? item.activeModelVersionAtPreflight ?? null;
    await service.recordHorizonResult({ ...args(row), result: { horizonDays: item.horizonDays,
      activeVersionBefore: before, activeVersionAfter: after?.modelVersion ?? null,
      activeChangeSource: before != null && after?.modelVersion !== before ? 'EXTERNAL' : 'NONE',
      resultStatus: status, promotionDecision: status === 'EVALUATED_NO_PROMOTION' ? 'NOT_PROMOTED' : 'NOT_EVALUATED',
      promotionReason: D.safeReason(item.code || item.result), eligibility: D.safeReason(item.eligibility),
      dataVersionEvaluated: inspected?.dataVersion || null, observationsClosedThrough: update.watermark(clock()),
      availableOrigins: item.promotionReadiness?.availableOrigins ?? null, requiredOrigins: 107 } });
  }
  async function finish(error, interrupted = false) {
    if (!owned) return;
    let row = await current();
    if (D.TERMINAL.includes(row.status)) return;
    if (error) {
      for (const h of row.perHorizon) if (!D.TERMINAL.includes(h.resultStatus)) {
        row = await service.recordHorizonResult({ ...args(row), result: { horizonDays: h.horizonDays,
          resultStatus: interrupted ? 'INTERRUPTED' : 'FAILED', promotionReason: D.safeReason(error.code || 'WORKER_FAILED') } });
      }
    }
    const statuses = row.perHorizon.map(h => h.resultStatus);
    const terminal = statuses.every(s => s === 'PROMOTED') ? 'PROMOTED'
      : statuses.every(s => s === 'EVALUATED_NO_PROMOTION') ? 'EVALUATED_NO_PROMOTION'
        : statuses.every(s => s === 'NO_PENDING_WORK') ? 'NO_PENDING_WORK'
          : statuses.every(s => s === 'FAILED') ? 'FAILED'
            : statuses.every(s => s === 'INTERRUPTED') ? 'INTERRUPTED'
              : statuses.every(s => ['NOT_ELIGIBLE', 'NO_PENDING_WORK'].includes(s)) ? 'NOT_ELIGIBLE' : 'PARTIAL';
    const versions = [...new Set(row.perHorizon.map(h => h.dataVersionEvaluated).filter(Boolean))];
    row = await service.transitionExecution({ ...args(row), status: terminal,
      reasonCode: error?.code || (terminal === 'PARTIAL' ? 'PARTIAL_HORIZON_RESULT'
        : terminal === 'EVALUATED_NO_PROMOTION' ? row.perHorizon[0].promotionReason
          : terminal === 'NOT_ELIGIBLE' ? row.perHorizon.find(h => h.resultStatus === 'NOT_ELIGIBLE')?.promotionReason : terminal),
      data: { pendingAfter: await pending(), dataVersionEvaluated: versions.length === 1 ? versions[0] : null } });
    await service.setImpactStatus({ ...args(row), status: statuses.includes('PROMOTED') ? 'PENDING' : 'NOT_APPLICABLE',
      reasonCode: statuses.includes('PROMOTED') ? null : 'NO_MODEL_PROMOTION' });
    owned = false;
  }
  return { begin, preflight, horizon, finish: () => finish(), fail: error => finish(error),
    interrupt: () => finish({ code: 'EXECUTION_INTERRUPTED' }, true),
    get executionId() { return owned ? executionId : null; } };
}

// Called only by training transaction hooks. Promotion and its basic horizon
// audit/impact metadata commit together or both roll back.
async function recordTrainingExecution(service, execution, job, resultStatus, session, evidence = {}) {
  if (!execution) return;
  const api = session ? service.withSession(session) : service;
  const scope = { businessId: job.businessId, scenarioId: job.scenarioId, executionId: execution };
  let row = await api.getExecution(scope);
  if (!row || row.status !== 'RUNNING') D.fail('EXECUTION_NOT_RUNNING');
  const old = row.perHorizon.find(h => h.horizonDays === job.horizonDays);
  if (D.TERMINAL.includes(old.resultStatus)) {
    if (old.candidateVersion === (job.candidateModelVersion || null)
        && (old.resultStatus === resultStatus || (evidence.reasonCode === 'REUSED_TRAINING_RESULT'
          && old.trainingJobReference === String(job._id)))) return;
    D.fail('HORIZON_RESULT_FINAL');
  }
  if (resultStatus === 'PROMOTED' && evidence.activeVersionAfter !== job.candidateModelVersion) D.fail('REGISTRY_CAS_CONFLICT');
  const prepared = job.preparedCandidate;
  const result = { horizonDays: job.horizonDays, resultStatus,
    activeVersionBefore: job.activeVersionBefore ?? old.activeVersionBefore ?? null,
    activeVersionAfter: resultStatus === 'PROMOTED' ? job.candidateModelVersion : evidence.activeVersionAfter ?? null,
    candidateVersion: job.candidateModelVersion || null,
    candidateStatus: evidence.candidateStatus || (job.candidateModelVersion ? resultStatus === 'PROMOTED' ? 'ACTIVE'
      : resultStatus === 'EVALUATED_NO_PROMOTION' ? 'REJECTED' : resultStatus === 'FAILED' ? 'FAILED' : 'CANDIDATE' : null
    ),
    trainingJobReference: String(job._id), trainedDataVersion: prepared?.trainedDataVersion || null,
    dataVersionEvaluated: job.inputDataVersion, observationsClosedThrough: job.observationsClosedThrough,
    promotionDecision: resultStatus === 'PROMOTED' ? 'PROMOTED' : resultStatus === 'EVALUATED_NO_PROMOTION' ? 'NOT_PROMOTED' : 'NOT_EVALUATED',
    promotionReason: evidence.reasonCode || (resultStatus === 'PROMOTED' ? 'PROMOTED' : resultStatus === 'EVALUATED_NO_PROMOTION'
      ? job.outcome === 'NO_PROMOTION_INSUFFICIENT_HISTORY' ? job.outcome : 'POLICY_FAILED' : evidence.reasonCode || null
    ),
    policyVersion: prepared?.promotionPolicyVersion || null,
    availableOrigins: Number.isSafeInteger(prepared?.checks?.protocol?.availableOrigins)
      ? prepared.checks.protocol.availableOrigins : null,
    activeChangeSource: resultStatus === 'PROMOTED' ? 'EXECUTION'
      : job.activeVersionBefore != null && evidence.activeVersionAfter != null && job.activeVersionBefore !== evidence.activeVersionAfter ? 'EXTERNAL' : 'UNKNOWN' };
  row = await api.recordHorizonResult({ ...scope, expectedVersion: row.writeVersion, result });
  row = await api.updateRunningMetadata({ ...scope, expectedVersion: row.writeVersion,
    stage: job.status === 'TRAINING' ? 'TRAINING' : job.status === 'EVALUATING' ? 'EVALUATION'
      : ['PERSISTING', 'PROMOTED', 'REJECTED'].includes(job.status) ? 'PROMOTION' : 'ELIGIBILITY' });
  if (resultStatus === 'PROMOTED') await api.setImpactStatus({ ...scope, expectedVersion: row.writeVersion, status: 'PENDING' });
}

module.exports = { executionIdentityFromEnv, createExecutionHistory, recordTrainingExecution };
