const { randomUUID } = require('node:crypto');
const { deepFreeze, isPlainObject, isTraceId, isObjectId, createAgentRequestContext, assertAgentRequestContext } = require('../agents/contracts');
const RISK_LEVELS = deepFreeze(['READ_ONLY', 'SAFE_AUTOMATIC', 'REQUIRES_CONFIRMATION', 'RESTRICTED']);
const CHANNELS = deepFreeze(['assistant', 'telegram', 'automation', 'node_red']);
const PENDING_TTL_MS = 600000;
const ERROR_MESSAGES = deepFreeze({
  ACTION_VALIDATION_FAILED: 'Datos de acción no válidos.', ACTION_CONFIRMATION_REQUIRED: 'Esta acción requiere confirmación.',
  ACTION_EXPIRED: 'La acción expiró. Prepara una nueva.', ACTION_CANCELLED: 'La acción fue cancelada.',
  ACTION_ALREADY_EXECUTED: 'La acción ya fue ejecutada.', ACTION_NOT_ALLOWED: 'Acción no disponible o no autorizada.',
  ACTION_CONFLICT: 'La acción cambió o está en proceso. Recarga su estado.', ACTION_EXECUTION_FAILED: 'No fue posible ejecutar la acción.'
});
class ActionError extends Error {
  constructor(code) { super(ERROR_MESSAGES[code] || ERROR_MESSAGES.ACTION_EXECUTION_FAILED); this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'ACTION_EXECUTION_FAILED'; }
}
const fail = code => { throw new ActionError(code); };
const trusted = new WeakSet();
// Channel is chosen by a trusted server adapter, never from an HTTP request body.
const createActionContext = (req, { sourceChannel = 'assistant', conversationId } = {}) => {
  if (!CHANNELS.includes(sourceChannel)) fail('ACTION_VALIDATION_FAILED');
  const agentContext = createAgentRequestContext(req, conversationId ? { conversationId } : {});
  const context = Object.freeze({ ...agentContext, sourceChannel, agentContext, actorType: sourceChannel === 'automation' ? 'AUTOMATION' : 'USER' });
  trusted.add(context); return context;
};
const assertContext = context => {
  if (!trusted.has(context)) fail('ACTION_NOT_ALLOWED'); assertAgentRequestContext(context.agentContext);
};
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const objectId = { ...string(24), format: 'object-id' };
const number = (maximum = 1000000000) => ({ type: 'number', minimum: 0, maximum });
const integer = maximum => ({ type: 'integer', minimum: 0, maximum });
const validateArgs = (rule, input) => {
  const invalid = () => fail('ACTION_VALIDATION_FAILED');
  let value = input;
  if (rule.type === 'object') {
    if (!isPlainObject(value) || Reflect.ownKeys(value).some(key => !Object.hasOwn(rule.properties, key))
      || rule.required.some(key => !Object.hasOwn(value, key))) invalid();
    value = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, validateArgs(rule.properties[key], child)]));
  } else if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length > rule.maxLength) invalid();
    value = value.trim();
    if (require('../services/agentHistoryProjection').redact(value) !== value) invalid();
    if (value.length < rule.minLength || /[\x00-\x1f]/.test(value) || rule.format === 'object-id' && !isObjectId(value)) invalid();
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < 1 || value.length > rule.maxItems) invalid();
    value = value.map(child => validateArgs(rule.items, child));
  } else if (['number', 'integer'].includes(rule.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.minimum || value > rule.maximum
      || rule.type === 'integer' && !Number.isSafeInteger(value)) invalid();
  } else if (rule.type === 'boolean') { if (typeof value !== 'boolean') invalid(); }
  else invalid();
  if (rule.enum && !rule.enum.includes(value)) invalid();
  return deepFreeze(value);
};
const scopeOf = context => { assertContext(context); return { userId: context.userId, businessId: context.businessId }; };
const bindingOf = context => ({ sourceChannel: context.sourceChannel, conversationId: context.conversationId || null });
const zeroUsage = () => ({ llmCalls: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedInputTokens: 0, toolUseTokens: 0, totalTokens: 0, metricsComplete: true });
module.exports = { RISK_LEVELS, CHANNELS, PENDING_TTL_MS, ERROR_MESSAGES, ActionError, fail, createActionContext, assertContext,
  scopeOf, bindingOf, schema, string, objectId, number, integer, validateArgs, zeroUsage, randomUUID, isTraceId, deepFreeze };
