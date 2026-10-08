const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { AgentError, deepFreeze, isPlainObject, assertAgentRequestContext, createExecutionBudget } = require('./contracts');
const { validateSkillInvocation } = require('./skills');
const { createTraceEvent, createRequestUsage, createEvidence } = require('./observability');
const { createSkillExecutors } = require('./executors');
const { getGeminiProvider, providerError } = require('./providers/geminiProvider');

/** A wall-clock deadline complements Mongo maxTimeMS and the ML client's timeout.
 * Abort prevents subsequent reads; already-dispatched read-only operations may
 * finish under their own driver/service deadline. There are no automatic retries.
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
        const evidence = createEvidence({ skillId, label: invocation.skill.description,
          ...(result.metadata.asOf ? { asOf: result.metadata.asOf } : {}),
          ...(result.metadata.period ? { period: result.metadata.period } : {}) });
        emit('skill_finished', { ...ids, status: 'SUCCEEDED', durationMs: performance.now() - start, returnedCount });
        emit('agent_finished', { agentId, agentRunId: ids.agentRunId, status: 'SUCCEEDED', durationMs: performance.now() - start });
        return deepFreeze({ ...result, evidence });
      } catch (error) {
        failed = true;
        const safeError = error instanceof AgentError ? error : new AgentError('AGENT_SKILL_EXECUTION_FAILED');
        emit('error', { ...ids, status: 'FAILED', code: safeError.code });
        if (dispatched) emit('skill_finished', { ...ids, status: 'FAILED', durationMs: performance.now() - start });
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
    llmCallsByAgent.set(agent.id, llmCount + 1);
    participants.add(agent.id);
    const agentRunId = randomUUID();
    const start = performance.now();
    active++;
    emit('agent_started', { agentId: agent.id, agentRunId, status: 'STARTED' });
    emit('llm_started', { agentId: agent.id, agentRunId, status: 'STARTED' });
    try {
      const result = await (provider || getGeminiProvider())[method](input);
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
      llmRecords.push({ agentId: agent.id, model: result.model, latencyMs: result.latencyMs, ...result.usage });
      emit('llm_finished', { agentId: agent.id, agentRunId, model: result.model,
        durationMs: result.latencyMs, status: 'SUCCEEDED', ...result.usage });
      emit('agent_finished', { agentId: agent.id, agentRunId, durationMs: performance.now() - start, status: 'SUCCEEDED' });
      return result;
    } catch (error) {
      failed = true;
      const safeError = error instanceof AgentError ? error : providerError(error);
      llmRecords.push({ agentId: agent.id, model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
        latencyMs: performance.now() - start, usageAvailable: false });
      emit('error', { agentId: agent.id, agentRunId, durationMs: performance.now() - start,
        status: 'FAILED', code: safeError.code });
      emit('agent_finished', { agentId: agent.id, agentRunId, durationMs: performance.now() - start, status: 'FAILED' });
      throw safeError;
    } finally { active--; }
  }
};

module.exports = { createAgentExecution, withSkillTimeout };
