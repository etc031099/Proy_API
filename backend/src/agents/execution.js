const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { AgentError, isPlainObject, assertAgentRequestContext, createExecutionBudget } = require('./contracts');
const { validateSkillInvocation } = require('./skills');
const { createTraceEvent, createRequestUsage } = require('./observability');

/** Internal request lifecycle. AG-R3 will supply bounded read-only executors. */
const createAgentExecution = options => {
  if (!isPlainObject(options) || Reflect.ownKeys(options).some(key => !['context', 'onEvent'].includes(key))) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  const { context, onEvent = () => {} } = options;
  assertAgentRequestContext(context);
  if (typeof onEvent !== 'function') throw new AgentError('AGENT_INVALID_REQUEST');
  const budget = createExecutionBudget();
  const participants = new Set();
  const events = [];
  const startedAt = performance.now();
  let closed = false;
  let failed = false;
  const emit = (type, metadata = {}) => {
    const event = createTraceEvent(type, {
      requestId: context.requestId, conversationId: context.conversationId, ...metadata
    });
    events.push(event);
    try { onEvent(event); } catch { /* A trace sink cannot break domain execution. */ }
  };
  const usage = () => createRequestUsage({ totalSkillCalls: budget.snapshot().skillCalls, agentIds: [...participants] });
  emit('request_started', { status: 'STARTED' });

  return Object.freeze({
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
      emit('skill_called', { ...ids, status: 'STARTED' });
      // No executor, database access or provider is installed in AG-R2.
      const error = new AgentError('AGENT_EXECUTOR_NOT_READY');
      failed = true;
      emit('error', { ...ids, status: 'FAILED', code: error.code });
      emit('skill_finished', { ...ids, status: 'FAILED', durationMs: performance.now() - start });
      emit('agent_finished', { agentId, agentRunId: ids.agentRunId, status: 'FAILED', durationMs: performance.now() - start });
      throw error;
    },
    getUsage: usage,
    getEvents: () => Object.freeze([...events]),
    finish() {
      if (!closed) {
        closed = true;
        emit('request_finished', { status: failed ? 'FAILED' : 'SUCCEEDED', durationMs: performance.now() - startedAt });
      }
      return usage();
    }
  });
};

module.exports = { createAgentExecution };
