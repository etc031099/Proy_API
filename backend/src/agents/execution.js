const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { AgentError, deepFreeze, isPlainObject, assertAgentRequestContext, createExecutionBudget } = require('./contracts');
const { validateSkillInvocation } = require('./skills');
const { createTraceEvent, createRequestUsage, createEvidence } = require('./observability');
const { createSkillExecutors } = require('./executors');
const { getGeminiProvider, providerError } = require('./providers/geminiProvider');
const { DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_TIMEOUT_MS } = require('../config/env');

const GEMINI_CAUSES = new Set(['GEMINI_AUTHENTICATION_FAILED', 'GEMINI_PERMISSION_DENIED', 'GEMINI_MODEL_NOT_FOUND',
  'GEMINI_RATE_LIMITED', 'GEMINI_TIMEOUT', 'GEMINI_NETWORK_ERROR', 'GEMINI_UNAVAILABLE', 'GEMINI_INVALID_RESPONSE',
  'GEMINI_EMPTY_RESPONSE', 'GEMINI_INVALID_JSON', 'GEMINI_SCHEMA_VALIDATION_FAILED', 'GEMINI_OUTPUT_TRUNCATED',
  'GEMINI_BUDGET_EXCEEDED']);
const providerTimeoutMs = () => {
  const configured = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 1000 && configured <= 20000
    ? configured : DEFAULT_GEMINI_TIMEOUT_MS;
};
const RETRY_DELAY_MS = 1000;
const shouldRetryProviderFailure = error => error?.retryable === true
  && (error.code === 'GEMINI_UNAVAILABLE' && [500, 502, 503, 504].includes(error.httpStatus)
    || ['GEMINI_NETWORK_ERROR', 'GEMINI_TIMEOUT'].includes(error.code));
const usageMetricsComplete = usage => usage?.usageAvailable === true
  && ['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedInputTokens', 'toolUseTokens', 'totalTokens']
    .every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0);

/** A wall-clock deadline complements Mongo maxTimeMS and the ML client's timeout.
 * Skills do not retry. Gemini gets at most one additional attempt for approved transient failures.
 */
const withSkillTimeout = async (operation, timeoutMs) => {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new AgentError('AGENT_SKILL_TIMEOUT');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
};

/** Internal request lifecycle. Dependencies are supplied by trusted server code. */
const createAgentExecution = options => {
  if (!isPlainObject(options) || Reflect.ownKeys(options).some(key => !['context', 'onEvent', 'dependencies', 'provider'].includes(key))) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  const { context, onEvent = () => {} } = options;
  assertAgentRequestContext(context);
  if (typeof onEvent !== 'function') throw new AgentError('AGENT_INVALID_REQUEST');
  if (options.dependencies !== undefined && (!isPlainObject(options.dependencies)
    || Reflect.ownKeys(options.dependencies).some(key => !['models', 'forecastService', 'clock', 'toObjectId'].includes(key)))) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  if (options.provider !== undefined && (!isPlainObject(options.provider)
    || typeof options.provider.generateStructured !== 'function' || typeof options.provider.generateWithTools !== 'function')) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  const provider = options.provider;
  const executors = createSkillExecutors(options.dependencies);
  const budget = createExecutionBudget();
  const participants = new Set();
  const events = [];
  const startedAt = performance.now();
  let closed = false;
  let failed = false;
  let active = 0;
  let skillCalls = 0;
  const llmRecords = [];
  const llmCallsByAgent = new Map();
  const emit = (type, metadata = {}) => {
    const event = createTraceEvent(type, {
      requestId: context.requestId, conversationId: context.conversationId, ...metadata
    });
    events.push(event);
    try { onEvent(event); } catch { /* A trace sink cannot break domain execution. */ }
  };
  const usage = () => createRequestUsage({ llmRecords, totalSkillCalls: skillCalls, agentIds: [...participants] });
  emit('request_started', { status: 'STARTED' });

  return Object.freeze({
    async runAgent(agentId, operation) {
      if (closed || typeof operation !== 'function') throw new AgentError('AGENT_INVALID_REQUEST');
      require('./definitions').getAgentDefinition(agentId);
      participants.add(agentId);
      const agentRunId = randomUUID();
      const start = performance.now();
      active++;
      emit('agent_started', { agentId, agentRunId, status: 'STARTED' });
      try {
        const result = await operation();
        emit('agent_finished', { agentId, agentRunId, status: 'SUCCEEDED', durationMs: performance.now() - start });
        return result;
      } catch (error) {
        failed = true;
        emit('agent_finished', { agentId, agentRunId, status: 'FAILED', durationMs: performance.now() - start });
        throw error;
      } finally { active--; }
    },
    recordError(code) { failed = true; emit('error', { status: 'FAILED', code }); },
    async selectTools(input) {
      if (closed) throw new AgentError('AGENT_INVALID_REQUEST');
      try { budget.consume('toolSelectionCycles'); } catch (error) {
        failed = true; emit('error', { status: 'FAILED', code: error.code }); throw error;
      }
      return runLlmCall('generateWithTools', input);
    },
    async generateStructured(input) { return runLlmCall('generateStructured', input); },
    async generateWithTools(input) { return runLlmCall('generateWithTools', input); },
    async executeSkill(input) {
      if (closed) throw new AgentError('AGENT_INVALID_REQUEST');
      let invocation;
      try {
        if (!isPlainObject(input) || Reflect.ownKeys(input).some(key => !['agentId', 'skillId', 'args'].includes(key))) {
          throw new AgentError('AGENT_INVALID_REQUEST');
        }
        const { agentId, skillId, args = {} } = input;
        invocation = validateSkillInvocation({ agentId, skillId, args, context });
        // Count admitted dispatch attempts, including pending/failed executions.
        budget.consume('skillCalls');
      } catch (error) {
        failed = true;
        const safeError = error instanceof AgentError ? error : new AgentError('AGENT_INVALID_REQUEST');
        emit('error', { status: 'FAILED', code: safeError.code });
        throw safeError;
      }
      const { agentId, skillId } = input;
      participants.add(invocation.agent.id);
      const ids = { agentId, skillId, agentRunId: randomUUID(), skillCallId: randomUUID() };
      const start = performance.now();
      emit('agent_started', { agentId, agentRunId: ids.agentRunId, status: 'STARTED' });
      let dispatched = false;
      active++;
      try {
        const executor = executors[skillId];
        if (invocation.skill.executorStatus !== 'READY' || typeof executor !== 'function') {
          throw new AgentError('AGENT_EXECUTOR_NOT_READY');
        }
        dispatched = true;
        skillCalls++;
        emit('skill_called', { ...ids, status: 'STARTED' });
        const result = await withSkillTimeout(signal => executor({ ...invocation, signal }), invocation.skill.timeoutMs);
        const returnedCount = result.metadata?.returnedCount;
        if (!Number.isSafeInteger(returnedCount) || returnedCount < 0 || returnedCount > invocation.skill.maxRecords) {
          throw new AgentError('AGENT_SKILL_EXECUTION_FAILED');
        }
        const evidence = createEvidence({ skillId, label: result.metadata.evidenceLabel || invocation.skill.description,
          ...(result.metadata.asOf ? { asOf: result.metadata.asOf } : {}),
          ...(result.metadata.period ? { period: result.metadata.period } : {}) });
        emit('skill_finished', { ...ids, status: 'SUCCEEDED', durationMs: performance.now() - start, returnedCount });
        emit('agent_finished', { agentId, agentRunId: ids.agentRunId, status: 'SUCCEEDED', durationMs: performance.now() - start });
        return deepFreeze({ ...result, evidence });
      } catch (error) {
        failed = true;
        const safeError = error instanceof AgentError ? error : new AgentError('AGENT_SKILL_EXECUTION_FAILED');
        const skillDurationMs = performance.now() - start;
        const diagnostic = error?.diagnostic && isPlainObject(error.diagnostic) ? error.diagnostic : {};
        const internalCause = diagnostic.internalCause
          || (error?.code === 'ML_SERVICE_UNAVAILABLE' ? 'ML_SERVICE_UNAVAILABLE'
            : error?.code === 'AGENT_SKILL_TIMEOUT' ? 'AGENT_SKILL_TIMEOUT'
              : error?.code === 'AGENT_SKILL_EXECUTION_FAILED' ? 'AGENT_SKILL_VALIDATION_ERROR' : 'AGENT_EXECUTION_ERROR');
        const diagnostics = { internalCause, skillDurationMs, timeoutMs: invocation.skill.timeoutMs,
          ...(typeof diagnostic.mlCallDurationMs === 'number' ? { mlCallDurationMs: diagnostic.mlCallDurationMs } : {}) };
        emit('error', { ...ids, status: 'FAILED', code: safeError.code, ...diagnostics });
        if (dispatched) emit('skill_finished', { ...ids, status: 'FAILED', durationMs: skillDurationMs });
        emit('agent_finished', { agentId, agentRunId: ids.agentRunId, status: 'FAILED', durationMs: performance.now() - start });
        throw safeError;
      } finally { active--; }
    },
    getUsage: usage,
    getBudget: () => budget.snapshot(),
    getEvents: () => Object.freeze([...events]),
    finish() {
      if (active) throw new AgentError('AGENT_INVALID_REQUEST');
      if (!closed) {
        closed = true;
        emit('request_finished', { status: failed ? 'FAILED' : 'SUCCEEDED', durationMs: performance.now() - startedAt });
      }
      return usage();
    }
  });

  async function runLlmCall(method, input) {
    if (closed || !isPlainObject(input) || Reflect.ownKeys(input).some(key => !['agentId', 'systemInstruction', 'messages', 'schema'].includes(key))) {
      throw new AgentError('AGENT_INVALID_REQUEST');
    }
    let agent;
    try { agent = require('./definitions').getAgentDefinition(input.agentId); } catch { throw new AgentError('AGENT_INVALID_REQUEST'); }
    const llmCount = llmCallsByAgent.get(agent.id) || 0;
    if (llmCount >= agent.limits.maxLlmCalls || budget.snapshot().llmCalls >= agent.limits.maxLlmCalls) {
      failed = true;
      const error = new AgentError('AGENT_BUDGET_EXCEEDED');
      emit('error', { agentId: agent.id, status: 'FAILED', code: error.code });
      throw error;
    }
    budget.consume('llmCalls');
    const llmCallsBeforeFailure = budget.snapshot().llmCalls - 1;
    llmCallsByAgent.set(agent.id, llmCount + 1);
    participants.add(agent.id);
    const agentRunId = randomUUID();
    const start = performance.now();
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const configuredTimeoutMs = providerTimeoutMs();
    const attemptState = { providerAttempts: 0, firstAttemptDurationMs: null, retryDelayMs: 0,
      secondAttemptDurationMs: null, totalProviderDurationMs: 0, retryReason: null };
    active++;
    emit('agent_started', { agentId: agent.id, agentRunId, status: 'STARTED' });
    emit('llm_started', { agentId: agent.id, agentRunId, status: 'STARTED' });
    try {
      const providerClient = provider || getGeminiProvider();
      const validateResult = result => {
        if (!isPlainObject(result) || typeof result.model !== 'string' || !/^[\w.:/-]{1,100}$/.test(result.model)
          || typeof result.latencyMs !== 'number' || !Number.isFinite(result.latencyMs) || result.latencyMs < 0
          || !isPlainObject(result.usage) || typeof result.usage.usageAvailable !== 'boolean'
          || !['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedInputTokens', 'toolUseTokens', 'totalTokens'].every(key =>
            result.usage[key] === null || Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0)) {
          throw new AgentError('GEMINI_INVALID_RESPONSE');
        }
        if (method === 'generateStructured' && !isPlainObject(result.output)) throw new AgentError('GEMINI_INVALID_RESPONSE');
        if (method === 'generateWithTools' && (!Array.isArray(result.toolCalls) || result.toolCalls.length > 4)) {
          throw new AgentError('GEMINI_INVALID_RESPONSE');
        }
        return result;
      };
      const attempt = async (providerAttempt, retryReason = null) => {
        attemptState.providerAttempts = providerAttempt;
        const attemptStart = performance.now();
        try {
          const result = validateResult(await providerClient[method](input));
          const durationMs = performance.now() - attemptStart;
          if (providerAttempt === 1) attemptState.firstAttemptDurationMs = durationMs;
          else attemptState.secondAttemptDurationMs = durationMs;
          attemptState.totalProviderDurationMs = performance.now() - start;
          emit('provider_attempt', { agentId: agent.id, agentRunId, model: result.model,
            providerAttempt, providerAttempts: providerAttempt, status: 'SUCCEEDED', durationMs,
            ...(retryReason ? { retryReason } : {}), retryScheduled: false,
            firstAttemptDurationMs: attemptState.firstAttemptDurationMs,
            retryDelayMs: attemptState.retryDelayMs,
            secondAttemptDurationMs: attemptState.secondAttemptDurationMs,
            totalProviderDurationMs: attemptState.totalProviderDurationMs,
            timeoutMs: configuredTimeoutMs, llmCallsBeforeFailure,
            ...(result.diagnostics ? {
              responseKind: result.diagnostics.responseKind,
              candidateCount: result.diagnostics.candidateCount,
              finishReason: result.diagnostics.finishReason?.[0] || null,
              hasText: result.diagnostics.hasText,
              hasFunctionCall: result.diagnostics.hasFunctionCall,
              hasUsageMetadata: result.diagnostics.hasUsageMetadata
            } : {}),
            usageAvailable: result.usage.usageAvailable,
            metricsComplete: usageMetricsComplete(result.usage) });
          return { result };
        } catch (error) {
          const safeError = GEMINI_CAUSES.has(error?.code) ? error : providerError(error);
          const durationMs = performance.now() - attemptStart;
          if (providerAttempt === 1) attemptState.firstAttemptDurationMs = durationMs;
          else attemptState.secondAttemptDurationMs = durationMs;
          attemptState.totalProviderDurationMs = performance.now() - start;
          const retryScheduled = providerAttempt === 1 && shouldRetryProviderFailure(safeError);
          if (retryScheduled) attemptState.retryDelayMs = RETRY_DELAY_MS;
          const effectiveTimeoutMs = Number.isSafeInteger(safeError.timeoutMs) ? safeError.timeoutMs
            : safeError.code === 'GEMINI_BUDGET_EXCEEDED' ? null : configuredTimeoutMs;
          emit('provider_attempt', { agentId: agent.id, agentRunId, model,
            providerAttempt, providerAttempts: providerAttempt, status: 'FAILED', code: safeError.code,
            publicCode: retryScheduled ? null : safeError.code === 'GEMINI_BUDGET_EXCEEDED'
              ? 'AGENT_BUDGET_EXCEEDED' : 'AGENT_PROVIDER_FAILED',
            internalCause: GEMINI_CAUSES.has(safeError.code) ? safeError.code : 'GEMINI_UNAVAILABLE',
            providerStatus: safeError.httpStatus ?? null, providerCode: safeError.providerCode ?? null,
            ...(retryReason || retryScheduled ? { retryReason: retryReason || safeError.code } : {}), retryScheduled,
            durationMs, firstAttemptDurationMs: attemptState.firstAttemptDurationMs,
            retryDelayMs: attemptState.retryDelayMs,
            secondAttemptDurationMs: attemptState.secondAttemptDurationMs,
            totalProviderDurationMs: attemptState.totalProviderDurationMs,
            timeoutMs: effectiveTimeoutMs, llmCallsBeforeFailure,
            ...(safeError.diagnostics ? {
              responseKind: safeError.diagnostics.responseKind,
              candidateCount: safeError.diagnostics.candidateCount,
              finishReason: safeError.diagnostics.finishReason?.[0] || null,
              hasText: safeError.diagnostics.hasText,
              hasFunctionCall: safeError.diagnostics.hasFunctionCall,
              hasUsageMetadata: safeError.diagnostics.hasUsageMetadata
            } : {}),
            usageAvailable: safeError.usageAvailable === true,
            metricsComplete: safeError.metricsComplete === true });
          return { error: safeError, retryScheduled };
        }
      };

      let outcome = await attempt(1);
      if (outcome.error && outcome.retryScheduled) {
        attemptState.retryReason = outcome.error.code;
        attemptState.retryDelayMs = RETRY_DELAY_MS;
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        outcome = await attempt(2, attemptState.retryReason);
      }
      if (outcome.error) throw outcome.error;
      const result = outcome.result;
      const providerDurationMs = attemptState.providerAttempts > 1
        ? attemptState.totalProviderDurationMs : result.latencyMs;
      llmRecords.push({ agentId: agent.id, model: result.model, latencyMs: providerDurationMs, ...result.usage });
      emit('llm_finished', { agentId: agent.id, agentRunId, model: result.model,
        durationMs: providerDurationMs, status: 'SUCCEEDED', ...attemptState, ...result.usage });
      emit('agent_finished', { agentId: agent.id, agentRunId, durationMs: performance.now() - start, status: 'SUCCEEDED' });
      return result;
    } catch (error) {
      failed = true;
      const safeError = GEMINI_CAUSES.has(error?.code) ? error : providerError(error);
      const llmDurationMs = performance.now() - start;
      const timeoutMs = Number.isSafeInteger(safeError.timeoutMs) ? safeError.timeoutMs
        : safeError.code === 'GEMINI_BUDGET_EXCEEDED' ? null : providerTimeoutMs();
      const diagnostics = safeError.diagnostics && isPlainObject(safeError.diagnostics) ? safeError.diagnostics : null;
      const publicCode = safeError.code === 'GEMINI_BUDGET_EXCEEDED' ? 'AGENT_BUDGET_EXCEEDED' : 'AGENT_PROVIDER_FAILED';
      llmRecords.push({ agentId: agent.id, model, latencyMs: llmDurationMs, usageAvailable: false });
      emit('error', { agentId: agent.id, agentRunId, status: 'FAILED', code: safeError.code,
        publicCode, internalCause: GEMINI_CAUSES.has(safeError.code) ? safeError.code : 'GEMINI_UNAVAILABLE',
        model, llmDurationMs, timeoutMs, llmCallsBeforeFailure, ...attemptState,
        providerStatus: safeError.httpStatus ?? null, providerCode: safeError.providerCode ?? null,
        ...(diagnostics ? {
          responseKind: diagnostics.responseKind,
          candidateCount: diagnostics.candidateCount,
          finishReason: diagnostics.finishReason?.[0] || null,
          hasText: diagnostics.hasText,
          hasFunctionCall: diagnostics.hasFunctionCall,
          hasUsageMetadata: diagnostics.hasUsageMetadata
        } : {}),
        usageAvailable: safeError.usageAvailable === true,
        metricsComplete: safeError.metricsComplete === true });
      emit('agent_finished', { agentId: agent.id, agentRunId, durationMs: llmDurationMs, status: 'FAILED' });
      throw safeError;
    } finally { active--; }
  }
};

module.exports = { createAgentExecution, withSkillTimeout };
