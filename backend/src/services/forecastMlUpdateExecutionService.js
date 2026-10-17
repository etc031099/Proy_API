'use strict';

const { randomUUID } = require('node:crypto');
const Model = require('../models/ForecastMlUpdateExecution');
const D = require('./forecastMlUpdateExecutionDomain');
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const FIELDS = Object.keys(Model.schema.paths).filter(key => !['_id', 'createdAt', 'updatedAt'].includes(key));
const clone = value => structuredClone(value);
const requireKey = value => { if (typeof value !== 'string' || !KEY.test(value)) D.fail('INVALID_EXECUTION_IDENTITY'); return value; };
const scopeOf = input => ({ businessId: requireKey(input?.businessId), scenarioId: requireKey(input?.scenarioId) });
const dateOf = value => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) D.fail('INVALID_EXECUTION_TIME');
  return date;
};
const emptyPair = () => [7, 14].map(horizonDays => ({ horizonDays, resultStatus: 'REQUESTED' }));
const view = row => row == null ? null : Object.fromEntries(FIELDS.filter(key => row[key] !== undefined)
  .map(key => [key, clone(row[key])]));
const unknownFields = (input, allowed) => {
  if (!input || Object.keys(input).some(key => !allowed.includes(key))) D.fail('INVALID_EXECUTION_FIELDS');
};

function productionRepository(model = Model, session) {
  const query = value => session ? value.session(session) : value;
  return {
    withSession: next => productionRepository(model, next),
    find: filter => query(model.findOne(filter)).select('-_id -createdAt -updatedAt').lean().exec(),
    async insert(row) { return session ? (await model.create([row], { session }))[0].toObject() : (await model.create(row)).toObject(); },
    replace: (scope, executionId, writeVersion, values) => query(model.findOneAndUpdate(
      { ...scope, executionId, writeVersion }, { $set: values, $inc: { writeVersion: 1 } },
      { new: true, runValidators: true })).select('-_id -createdAt -updatedAt').lean().exec(),
  };
}

async function validate(row) {
  // Validate complete documents before atomic updates: array/query validators
  // alone cannot enforce all cross-field audit invariants.
  const document = new Model(row);
  try { await document.validate(); } catch { D.fail('INVALID_EXECUTION_DOCUMENT'); }
  if (row.perHorizon?.some(h => h.horizonDays === 1)) D.fail('INVALID_EXECUTION_HORIZON');
  if (row.github && (!row.attempts.length || row.github.runAttempt !== row.attempts.at(-1).runAttempt)) {
    D.fail('INVALID_EXECUTION_ATTEMPT');
  }
  return view(document.toObject());
}

function identityOf(input) {
  const scope = scopeOf(input), identity = {};
  if (!['MANUAL', 'SCHEDULED', 'CLI'].includes(input.triggerSource)) D.fail('INVALID_EXECUTION_TRIGGER');
  if (input.manualRequestKey !== undefined) identity.manualRequestKey = requireKey(input.manualRequestKey);
  if (input.cliInvocationKey !== undefined) identity.cliInvocationKey = requireKey(input.cliInvocationKey);
  if (input.github !== undefined) {
    unknownFields(input.github, ['repository', 'runId', 'runAttempt']);
    const { repository, runId, runAttempt } = input.github;
    if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
        || typeof runId !== 'string' || !/^[1-9]\d{0,24}$/.test(runId)
        || !Number.isSafeInteger(runAttempt) || runAttempt < 1) D.fail('INVALID_EXECUTION_IDENTITY');
    identity.github = { repository: repository.toLowerCase(), runId, runAttempt };
  }
  if ((input.triggerSource === 'MANUAL' && !identity.manualRequestKey)
      || (input.triggerSource === 'SCHEDULED' && !identity.github)
      || (input.triggerSource === 'CLI' && !identity.cliInvocationKey)) D.fail('INVALID_EXECUTION_IDENTITY');
  return { scope, identity };
}

function createForecastMlUpdateExecutionService({ repository = productionRepository(), clock = () => new Date() } = {}) {
  const getExecution = async input => view(await repository.find({ ...scopeOf(input), executionId: requireKey(input.executionId) }));
  const findExecutionByManualRequest = async input => view(await repository.find({ ...scopeOf(input),
    manualRequestKey: requireKey(input.manualRequestKey) }));
  const findExecutionByCliInvocation = async input => view(await repository.find({ ...scopeOf(input),
    cliInvocationKey: requireKey(input.cliInvocationKey) }));
  const findExecutionByGithubRun = async input => {
    const { identity } = identityOf({ ...scopeOf(input), triggerSource: 'SCHEDULED', github: {
      repository: input.repository, runId: input.runId, runAttempt: 1 } });
    return view(await repository.find({ ...scopeOf(input), 'github.repository': identity.github.repository,
      'github.runId': identity.github.runId }));
  };

  async function update(input, mutate) {
    const scope = scopeOf(input);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
        || input.expectedVersion >= Number.MAX_SAFE_INTEGER) D.fail('EXECUTION_VERSION_REQUIRED');
    const row = await getExecution(input);
    if (!row) D.fail('EXECUTION_NOT_FOUND');
    if (row.writeVersion !== input.expectedVersion) D.fail('EXECUTION_CONFLICT');
    mutate(row, dateOf(clock()));
    const next = await validate(row);
    const values = Object.fromEntries(Object.entries(next).filter(([key]) => ![
      'executionId', 'businessId', 'scenarioId', 'requestSource', 'manualRequestKey', 'writeVersion', 'github',
    ].includes(key)));
    if (next.github) for (const key of ['repository', 'runId', 'runAttempt']) values[`github.${key}`] = next.github[key];
    const changed = await repository.replace(scope, row.executionId, input.expectedVersion, values);
    if (!changed) D.fail('EXECUTION_CONFLICT');
    return view(changed);
  }

  async function createExecution(input) {
    unknownFields(input, ['businessId', 'scenarioId', 'triggerSource', 'manualRequestKey', 'cliInvocationKey',
      'github', 'requestedAt', 'dataVersionBefore', 'pendingBefore', 'signalTypes', 'reasonCode', 'message']);
    const { scope, identity } = identityOf(input);
    const filters = [];
    if (identity.manualRequestKey) filters.push({ ...scope, manualRequestKey: identity.manualRequestKey });
    if (identity.cliInvocationKey) filters.push({ ...scope, cliInvocationKey: identity.cliInvocationKey });
    if (identity.github) filters.push({ ...scope, 'github.repository': identity.github.repository, 'github.runId': identity.github.runId });
    async function existing() {
      const rows = (await Promise.all(filters.map(filter => repository.find(filter)))).filter(Boolean);
      if (!rows.length) return null;
      const row = view(rows[0]);
      if (rows.some(other => other.executionId !== row.executionId)
          || (row.requestSource || row.triggerSource) !== input.triggerSource
          || ['manualRequestKey', 'cliInvocationKey'].some(key => identity[key] && row[key] !== identity[key])
          || (identity.github && JSON.stringify(row.github ? [row.github.repository, row.github.runId] : null)
            !== JSON.stringify([identity.github.repository, identity.github.runId]))) {
        D.fail('EXECUTION_IDENTITY_CONFLICT');
      }
      if (identity.github && identity.github.runAttempt > row.github.runAttempt) {
        try {
          return await registerGithubAttempt({ ...scope, executionId: row.executionId, expectedVersion: row.writeVersion,
            runAttempt: identity.github.runAttempt });
        } catch (error) {
          if (error.code !== 'EXECUTION_CONFLICT') throw error;
          const current = await getExecution({ ...scope, executionId: row.executionId });
          if (!current || current.github.runAttempt < identity.github.runAttempt) throw error;
          return current;
        }
      }
      return row;
    }
    const found = await existing();
    if (found) return found;
    const reasonCode = D.safeReason(input.reasonCode || 'ML_UPDATE_REQUESTED');
    const row = await validate({ ...scope, ...identity, triggerSource: input.triggerSource, requestSource: input.triggerSource, executionId: randomUUID(),
      requestedAt: dateOf(input.requestedAt ?? clock()), status: 'REQUESTED', stage: 'REQUEST',
      reasonCode, message: D.safeMessage(reasonCode),
      dataVersionBefore: input.dataVersionBefore ?? null, pendingBefore: input.pendingBefore ?? null,
      signalTypes: [...new Set(input.signalTypes || [])], perHorizon: emptyPair(),
      impact: { status: 'NOT_APPLICABLE', reasonCode: null }, writeVersion: 0,
      attempts: identity.github || identity.cliInvocationKey
        ? [{ runAttempt: identity.github?.runAttempt || 1, status: 'REQUESTED' }] : [] });
    try { return view(await repository.insert(row)); }
    catch (error) {
      if (error.code !== 11000) throw error;
      const winner = await existing();
      if (!winner) D.fail('EXECUTION_CONFLICT');
      return winner;
    }
  }

  const recordHorizonResult = input => update(input, row => {
    if (row.status !== 'RUNNING') D.fail('INVALID_EXECUTION_TRANSITION');
    const result = input.result;
    unknownFields(result, ['horizonDays', 'activeVersionBefore', 'activeVersionAfter', 'candidateVersion',
      'candidateStatus', 'trainingJobReference', 'trainedDataVersion', 'promotionDecision', 'promotionReason',
      'policyVersion', 'resultStatus', 'availableOrigins', 'requiredOrigins', 'eligibility', 'activeChangeSource',
      'dataVersionEvaluated', 'observationsClosedThrough']);
    if (![7, 14].includes(result.horizonDays)) D.fail('INVALID_EXECUTION_HORIZON');
    const index = row.perHorizon.findIndex(item => item.horizonDays === result.horizonDays);
    const previous = row.perHorizon[index];
    const next = { ...previous, ...result,
      promotionReason: D.safeReason(result.promotionReason ?? previous.promotionReason),
      eligibility: D.safeReason(result.eligibility ?? previous.eligibility) };
    if (D.TERMINAL.includes(previous.resultStatus) && JSON.stringify(previous) !== JSON.stringify(next)) {
      D.fail('HORIZON_RESULT_FINAL');
    }
    if (next.resultStatus !== previous.resultStatus && !D.TERMINAL.includes(previous.resultStatus)
        && !D.TRANSITIONS[previous.resultStatus]?.includes(next.resultStatus)
        && !(previous.resultStatus === 'REQUESTED' && D.TERMINAL.includes(next.resultStatus))) {
      D.fail('INVALID_HORIZON_TRANSITION');
    }
    if (next.promotionDecision === 'PROMOTED' && next.resultStatus !== 'PROMOTED') D.fail('INVALID_PROMOTION_RESULT');
    if (next.resultStatus === 'PROMOTED' && (next.promotionDecision !== 'PROMOTED'
        || next.candidateStatus !== 'ACTIVE' || next.candidateVersion == null
        || next.activeVersionAfter !== next.candidateVersion
        || (next.activeVersionBefore != null && next.activeVersionAfter <= next.activeVersionBefore))) {
      D.fail('INVALID_PROMOTION_RESULT');
    }
    if (['NOT_ELIGIBLE', 'EVALUATED_NO_PROMOTION', 'NO_PENDING_WORK'].includes(next.resultStatus)
        && (next.promotionDecision === 'PROMOTED' || (next.activeVersionBefore != null
          && next.activeVersionAfter != null && next.activeVersionAfter !== next.activeVersionBefore
          && next.activeChangeSource !== 'EXTERNAL'))) {
      D.fail('INVALID_NO_PROMOTION_RESULT');
    }
    row.perHorizon[index] = next;
  });

  const transitionExecution = input => update(input, (row, now) => {
    if (!D.TRANSITIONS[row.status]?.includes(input.status)) D.fail('INVALID_EXECUTION_TRANSITION');
    const outcomes = row.perHorizon.map(h => h.resultStatus);
    if (input.status === 'PROMOTED' && !outcomes.every(value => value === 'PROMOTED')) D.fail('HORIZON_RESULTS_REQUIRED');
    if (input.status === 'EVALUATED_NO_PROMOTION' && !outcomes.every(value => value === 'EVALUATED_NO_PROMOTION')) {
      D.fail('HORIZON_RESULTS_REQUIRED');
    }
    if (input.status === 'PARTIAL' && (!outcomes.some(value => D.TERMINAL.includes(value))
        || new Set(outcomes).size < 2)) D.fail('HORIZON_RESULTS_REQUIRED');
    if (['FAILED', 'NOT_ELIGIBLE', 'NO_PENDING_WORK', 'INTERRUPTED'].includes(input.status)
        && outcomes.some(value => value === 'PROMOTED')) D.fail('PROMOTION_RESULT_MUST_BE_PRESERVED');
    const data = input.data || {};
    unknownFields(data, ['dataVersionBefore', 'dataVersionEvaluated', 'observationsClosedThrough', 'pendingBefore',
      'pendingAfter', 'availableOrigins', 'requiredOrigins', 'eligibility', 'signalTypes']);
    Object.assign(row, data);
    if (Object.hasOwn(data, 'eligibility')) row.eligibility = D.safeReason(data.eligibility);
    row.status = input.status;
    row.stage = input.stage || (D.TERMINAL.includes(input.status) ? 'FINISHED'
      : input.status === 'RUNNING' ? 'PREFLIGHT' : 'REQUEST');
    row.reasonCode = D.safeReason(input.reasonCode);
    row.message = D.safeMessage(row.reasonCode);
    if (input.status === 'RUNNING') row.startedAt = now;
    if (D.TERMINAL.includes(input.status)) row.finishedAt = now;
    if (row.startedAt && row.finishedAt && row.finishedAt < row.startedAt) D.fail('INVALID_EXECUTION_TIME');
    const attempt = row.attempts.at(-1);
    if (attempt) {
      Object.assign(attempt, { status: row.status, reasonCode: row.reasonCode,
        startedAt: row.startedAt, finishedAt: row.finishedAt });
      if (D.TERMINAL.includes(row.status)) {
        attempt.perHorizon = clone(row.perHorizon);
        attempt.dataVersionEvaluated = row.dataVersionEvaluated;
        attempt.observationsClosedThrough = row.observationsClosedThrough;
        attempt.impact = clone(row.impact);
      }
    }
  });

  const registerGithubAttempt = input => update(input, row => {
    if (!row.github || !Number.isSafeInteger(input.runAttempt) || input.runAttempt <= row.github.runAttempt) {
      D.fail('INVALID_EXECUTION_ATTEMPT');
    }
    if (!D.TERMINAL.includes(row.status)) D.fail('PREVIOUS_ATTEMPT_NOT_FINISHED');
    if (row.attempts.length >= D.MAX_ATTEMPTS) D.fail('EXECUTION_ATTEMPT_LIMIT');
    row.github.runAttempt = input.runAttempt;
    row.attempts.push({ runAttempt: input.runAttempt, status: 'REQUESTED', startedAt: null,
      finishedAt: null, reasonCode: null });
    row.status = 'REQUESTED'; row.stage = 'REQUEST'; row.reasonCode = null; row.message = null;
    row.startedAt = null; row.finishedAt = null; row.perHorizon = emptyPair();
    row.dataVersionBefore = null; row.dataVersionEvaluated = null; row.observationsClosedThrough = null;
    row.pendingBefore = null; row.pendingAfter = null; row.availableOrigins = null; row.eligibility = null;
    row.signalTypes = [];
    // Old impact is never claimed to describe the new attempt.
    row.impact = { status: 'NOT_APPLICABLE', reasonCode: null };
  });
  const setImpactStatus = input => update(input, row => {
    if (!D.IMPACT_STATUSES.includes(input.status)) D.fail('INVALID_IMPACT_STATUS');
    if (['PENDING', 'COMPLETE', 'PARTIAL'].includes(input.status)
        && !row.perHorizon.some(h => h.resultStatus === 'PROMOTED')) D.fail('IMPACT_REQUIRES_PROMOTION');
    row.impact = { status: input.status, reasonCode: D.safeReason(input.reasonCode) };
    if (row.attempts.length && D.TERMINAL.includes(row.status)) row.attempts.at(-1).impact = clone(row.impact);
  });
  const mark = status => input => transitionExecution({ ...input, status });
  const updateRunningMetadata = input => update(input, row => {
    if (row.status !== 'RUNNING') D.fail('INVALID_EXECUTION_TRANSITION');
    unknownFields(input.data || {}, ['dataVersionBefore', 'dataVersionEvaluated', 'observationsClosedThrough',
      'pendingBefore', 'pendingAfter', 'availableOrigins', 'requiredOrigins', 'eligibility']);
    Object.assign(row, input.data || {});
    if (input.data?.eligibility) row.eligibility = D.safeReason(input.data.eligibility);
    row.stage = input.stage || row.stage;
  });
  const bindExecutionRun = input => update(input, row => {
    if (!['REQUESTED', 'PENDING', 'DEFERRED'].includes(row.status)) D.fail('INVALID_EXECUTION_TRANSITION');
    const { identity } = identityOf({ ...scopeOf(input), ...(input.github
      ? { triggerSource: 'SCHEDULED', github: input.github } : { triggerSource: 'CLI', cliInvocationKey: input.cliInvocationKey }) });
    if ((row.github && (!identity.github || row.github.repository !== identity.github.repository || row.github.runId !== identity.github.runId))
        || (row.cliInvocationKey && identity.cliInvocationKey && row.cliInvocationKey !== identity.cliInvocationKey)) {
      D.fail('EXECUTION_IDENTITY_CONFLICT');
    }
    if (!['MANUAL', 'SCHEDULED', 'CLI'].includes(input.triggerSource)) D.fail('INVALID_EXECUTION_TRIGGER');
    row.requestSource ||= row.triggerSource;
    row.triggerSource = input.triggerSource;
    if (identity.github) row.github = identity.github;
    else row.cliInvocationKey = identity.cliInvocationKey;
    if (input.cliInvocationKey) {
      const key = requireKey(input.cliInvocationKey);
      if (row.cliInvocationKey && row.cliInvocationKey !== key) D.fail('EXECUTION_IDENTITY_CONFLICT');
      row.cliInvocationKey = key;
    }
    const attempt = identity.github?.runAttempt || 1;
    if (!row.attempts.length) row.attempts.push({ runAttempt: attempt, status: row.status });
    else if (row.attempts.at(-1).runAttempt !== attempt) D.fail('INVALID_EXECUTION_ATTEMPT');
  });
  const resumeInterruptedExecution = input => update(input, row => {
    if (row.github || row.triggerSource !== 'CLI' || row.status !== 'INTERRUPTED') D.fail('INVALID_EXECUTION_TRANSITION');
    if (row.attempts.length >= D.MAX_ATTEMPTS) D.fail('EXECUTION_ATTEMPT_LIMIT');
    row.attempts.push({ runAttempt: (row.attempts.at(-1)?.runAttempt || 0) + 1, status: 'REQUESTED' });
    row.status = 'REQUESTED'; row.stage = 'REQUEST'; row.startedAt = null; row.finishedAt = null;
    row.reasonCode = null; row.message = null; row.perHorizon = emptyPair();
    row.dataVersionBefore = null; row.dataVersionEvaluated = null; row.observationsClosedThrough = null;
    row.pendingBefore = null; row.pendingAfter = null; row.availableOrigins = null; row.eligibility = null;
    row.impact = { status: 'NOT_APPLICABLE', reasonCode: null };
  });
  return Object.freeze({ createExecution, getExecution, findExecutionByManualRequest, findExecutionByGithubRun, findExecutionByCliInvocation,
    resumeInterruptedExecution,
    bindExecutionRun,
    updateRunningMetadata,
    withSession: session => {
      if (!repository.withSession) D.fail('EXECUTION_SESSION_UNSUPPORTED');
      return createForecastMlUpdateExecutionService({ repository: repository.withSession(session), clock });
    },
    transitionExecution, startExecution: mark('RUNNING'), markPending: mark('PENDING'),
    markDeferred: mark('DEFERRED'), markNotEligible: mark('NOT_ELIGIBLE'), markNoPendingWork: mark('NO_PENDING_WORK'),
    markPromoted: mark('PROMOTED'), markNoPromotion: mark('EVALUATED_NO_PROMOTION'), markPartial: mark('PARTIAL'),
    markFailed: mark('FAILED'), markInterrupted: mark('INTERRUPTED'), recordHorizonResult, registerGithubAttempt, setImpactStatus });
}

module.exports = { createForecastMlUpdateExecutionService, productionRepository };
