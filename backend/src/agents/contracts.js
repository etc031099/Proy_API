const { randomUUID } = require('node:crypto');
const { toFiniteNumber } = require('../utils/numbers');

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

// Limits are planning budgets, never measured usage.
const EXECUTION_LIMITS = deepFreeze({
  maxMessageChars: 2000,
  maxLlmCalls: 3,
  maxSkillCalls: 4,
  maxToolSelectionCycles: 2
});
const TOKEN_BUDGETS = deepFreeze({
  coordinator: { maxInputTokens: 800, responseTargetTokens: 100, providerMaxOutputTokens: 512 },
  operations: { maxInputTokens: 1500, responseTargetTokens: 200, providerMaxOutputTokens: 768 },
  analyst: { maxInputTokens: 2200, responseTargetTokens: 450, providerMaxOutputTokens: 1024 }
});
const ERROR_MESSAGES = deepFreeze({
  AGENT_INVALID_REQUEST: 'Invalid agent request',
  AGENT_SKILL_NOT_FOUND: 'Skill not found',
  AGENT_SKILL_NOT_ALLOWED: 'Skill is not allowed for this agent',
  AGENT_INVALID_SKILL_ARGS: 'Invalid skill arguments',
  AGENT_BUDGET_EXCEEDED: 'Agent execution budget exceeded',
  AGENT_EXECUTOR_NOT_READY: 'Skill executor is not implemented',
  AGENT_RESOURCE_NOT_FOUND: 'Resource not found',
  AGENT_SKILL_EXECUTION_FAILED: 'Skill execution failed',
  AGENT_SKILL_TIMEOUT: 'Skill execution timed out',
  AGENT_UNSUPPORTED_QUERY: 'Query is outside the agent scope',
  AGENT_CLARIFICATION_REQUIRED: 'More information is required',
  AGENT_SKILL_FAILED: 'The requested information could not be retrieved',
  AGENT_PROVIDER_FAILED: 'The AI provider is temporarily unavailable',
  AGENT_INTERNAL_ERROR: 'The agent request could not be completed',
  PLAN_CONTEXT_MISSING: 'A same-conversation budget plan is required',
  PLAN_CONTEXT_INVALID: 'The saved budget plan is invalid',
  PLAN_FOLLOWUP_FORMAT_ERROR: 'The saved budget plan could not be formatted',
  ML_SERVICE_UNAVAILABLE: 'ML service is temporarily unavailable',
  GEMINI_NOT_CONFIGURED: 'Gemini is not configured',
  GEMINI_AUTHENTICATION_FAILED: 'Gemini authentication failed',
  GEMINI_PERMISSION_DENIED: 'Gemini permission denied',
  GEMINI_MODEL_NOT_FOUND: 'Gemini model was not found',
  GEMINI_NETWORK_ERROR: 'Gemini network request failed',
  GEMINI_TIMEOUT: 'Gemini request timed out',
  GEMINI_RATE_LIMITED: 'Gemini rate limit reached',
  GEMINI_UNAVAILABLE: 'Gemini is temporarily unavailable',
  GEMINI_INVALID_RESPONSE: 'Gemini returned an invalid response',
  GEMINI_EMPTY_RESPONSE: 'Gemini returned no usable content',
  GEMINI_INVALID_JSON: 'Gemini returned invalid JSON',
  GEMINI_SCHEMA_VALIDATION_FAILED: 'Gemini response did not match the required schema',
  GEMINI_OUTPUT_TRUNCATED: 'Gemini output was truncated by its token limit',
  GEMINI_BUDGET_EXCEEDED: 'Gemini request budget exceeded'
});

class AgentError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.AGENT_INVALID_REQUEST);
    this.name = 'AgentError';
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'AGENT_INVALID_REQUEST';
  }

  // Use this projection at future HTTP boundaries, never serialize an Error directly.
  toJSON() { return { code: this.code, message: this.message }; }
}

const isPlainObject = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isObjectId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const isTraceId = value => typeof value === 'string'
  && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const isTimestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const validateAgentMessage = message => {
  if (typeof message !== 'string' || !message.trim() || message.length > EXECUTION_LIMITS.maxMessageChars) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  return message;
};

// These identities must come from authenticate/checkBusinessAccess, not request payloads.
const trustedContexts = new WeakSet();
const createAgentRequestContext = (req, options = {}) => {
  if (!isPlainObject(options) || Reflect.ownKeys(options).some(key => key !== 'conversationId')) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  const { conversationId } = options;
  const user = req?.user;
  const userId = user?._id?.toString() || user?.id;
  if (!isObjectId(userId) || user?.isActive !== true
    || typeof user.businessId !== 'string' || !user.businessId.trim()
    || user.businessId.length > 50 || !['admin', 'user'].includes(user.role)
    || (req.businessId !== undefined && req.businessId !== user.businessId)
    || (conversationId !== undefined && !isTraceId(conversationId))) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  const context = Object.freeze({
    requestId: randomUUID(),
    ...(conversationId === undefined ? {} : { conversationId }),
    userId, businessId: user.businessId, role: user.role
  });
  trustedContexts.add(context);
  return context;
};
const assertAgentRequestContext = context => {
  if (!trustedContexts.has(context)) throw new AgentError('AGENT_INVALID_REQUEST');
};

/** Validates the closed scalar schema subset used by the internal skill registry. */
const validateSkillArgs = (schema, args) => {
  const invalid = () => { throw new AgentError('AGENT_INVALID_SKILL_ARGS'); };
  if (!isPlainObject(args)) invalid();
  const keys = Reflect.ownKeys(args);
  if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key))) invalid();
  if ((schema.required || []).some(key => !Object.hasOwn(args, key))) invalid();
  if (schema.oneOf && schema.oneOf.filter(option => option.required.every(key => Object.hasOwn(args, key))).length !== 1) invalid();
  const result = {};
  for (const key of keys) {
    const rule = schema.properties[key];
    const value = args[key];
    if (rule.type === 'string') {
      if (typeof value !== 'string' || !value.trim()
        || value.length < (rule.minLength || 1) || value.length > rule.maxLength
        || (rule.enum && !rule.enum.includes(value))
        || (rule.format === 'object-id' && !isObjectId(value))
        || (rule.format === 'date' && !isDate(value))) invalid();
    } else if (rule.type === 'integer') {
      if (typeof value !== 'number') invalid();
      try { toFiniteNumber(value, { integer: true, min: rule.minimum, max: rule.maximum }); } catch { invalid(); }
    } else if (rule.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < (rule.minimum ?? -Infinity)
        || value > (rule.maximum ?? Infinity)) invalid();
    } else invalid();
    result[key] = value;
  }
  if (Object.hasOwn(result, 'startDate') || Object.hasOwn(result, 'endDate')) {
    if (!result.startDate || !result.endDate || result.startDate > result.endDate) invalid();
  }
  return Object.freeze(result);
};

const createExecutionBudget = () => {
  const used = { llmCalls: 0, skillCalls: 0, toolSelectionCycles: 0 };
  const limits = { llmCalls: 'maxLlmCalls', skillCalls: 'maxSkillCalls', toolSelectionCycles: 'maxToolSelectionCycles' };
  return Object.freeze({
    consume(kind) {
      if (!Object.hasOwn(limits, kind)) throw new AgentError('AGENT_INVALID_REQUEST');
      if (used[kind] >= EXECUTION_LIMITS[limits[kind]]) throw new AgentError('AGENT_BUDGET_EXCEEDED');
      used[kind] += 1;
    },
    snapshot: () => Object.freeze({ ...used })
  });
};

module.exports = {
  AgentError, ERROR_MESSAGES, EXECUTION_LIMITS, TOKEN_BUDGETS, deepFreeze,
  isPlainObject, isObjectId, isTraceId, isDate, isTimestamp,
  validateAgentMessage, createAgentRequestContext, assertAgentRequestContext,
  validateSkillArgs, createExecutionBudget
};
