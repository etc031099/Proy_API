const { AgentError } = require('../contracts');

const LOGICAL_DEADLINE_MS = 40000;
const MIN_ATTEMPT_MS = 2000;
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedInputTokens', 'toolUseTokens', 'totalTokens'];
const parseFallbackModels = (value = '', primary) => {
  if (typeof value !== 'string') throw new AgentError('GEMINI_NOT_CONFIGURED');
  const models = [...new Set(value.split(',').map(model => model.trim()).filter(Boolean))].filter(model => model !== primary);
  if (models.length > 2 || models.some(model => !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(model))) throw new AgentError('GEMINI_NOT_CONFIGURED');
  return Object.freeze(models);
};
const safeUsage = usage => ({ usageAvailable: usage?.usageAvailable === true,
  ...Object.fromEntries(TOKEN_FIELDS.map(field => [field,
    usage?.usageAvailable === true && Number.isSafeInteger(usage[field]) && usage[field] >= 0 ? usage[field] : null])) });
// A known subtotal is not a claim that unreported attempts cost zero.
const knownUsage = attempts => Object.fromEntries(TOKEN_FIELDS.map(field => {
  const values = attempts.map(attempt => attempt.usage[field]).filter(value => value !== null);
  return [field, values.length ? values.reduce((sum, value) => sum + value, 0) : null];
}));
module.exports = { LOGICAL_DEADLINE_MS, MIN_ATTEMPT_MS, parseFallbackModels, safeUsage, knownUsage };
