const { compactEntity, compactProductSelection } = require('../agents/memory');
const { isDate } = require('../agents/contracts');
const redact = value => String(value).replace(/\bBearer\s+\S+|AIza[\w-]{20,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|(?:password|api[_-]?key|jwt|secret|token)\s*[:=]\s*\S+/gi, '[secreto omitido]');
const text = (value, max = 100) => typeof value === 'string' ? redact(value).slice(0, max) : null;
const tokens = { inputTokens: true, outputTokens: true, thoughtTokens: true, cachedInputTokens: true, toolUseTokens: true, totalTokens: true };
const agent = { agentId: true, model: true, llmCalls: true, ...tokens, latencyMs: true, usageAvailable: true };
const tokenUsage = { ...tokens, usageAvailable: true };
const period = { startDate: true, endDate: true };
const actionItem = { sku: true, name: true, quantity: true, stock: true, resultingStock: true, price: true, total: true };
const shape = {
  pendingAction: { pendingActionId: true, action: true, summary: true, status: true, expiresAt: true,
    requiresConfirmation: true, fields: { name: true, sku: true, price: true, currency: true, stock: true, resultingStock: true,
      minStockLevel: true, category: true, costPrice: true, description: true, total: true, paymentMethod: true, contact: true },
    items: [actionItem], result: { id: true, type: true, currency: true, total: true, sku: true, name: true, stock: true, items: [actionItem] } },
  requestId: true, conversationId: true, answer: true, intent: true, agent: true,
  requiresClarification: true, clarificationQuestion: true, latencyMs: true,
  participants: [{ ...agent, skillCalls: true, providerLatencyMs: true }],
  actions: [{ skillId: true, agentId: true, status: true, durationMs: true }],
  evidence: [{ evidenceId: true, sourceType: true, skillId: true, label: true, asOf: true, period, recordCount: true }],
  usage: { totalLlmCalls: true, totalSkillCalls: true, totalInputTokens: true, totalOutputTokens: true,
    totalThoughtTokens: true, totalCachedInputTokens: true, totalToolUseTokens: true, totalTokens: true,
    metricsComplete: true, totalProviderLatencyMs: true, totalLatencyMs: true, toolSelectionCycles: true,
    agents: [agent], providerGenerations: [{ agentId: true, requestedModel: true, finalModel: true,
      fallbackUsed: true, fallbackIndex: true, providerAttempts: true, deadlineMs: true,
      logicalGenerationUsage: tokenUsage, totalKnownUsage: tokens, attemptMetricsComplete: true,
      providerAttemptUsage: [{ providerAttempt: true, model: true, status: true, durationMs: true, usage: tokenUsage }] }] }
};
const project = (value, schema) => {
  if (value === null || value === undefined) return value;
  if (schema === true) return typeof value === 'string' ? redact(value).slice(0, 20000)
    : typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (Array.isArray(schema)) return Array.isArray(value) ? value.slice(0, 20).map(item => project(item, schema[0])) : [];
  return Object.fromEntries(Object.entries(schema).filter(([key]) => Object.hasOwn(value, key)).map(([key, rule]) => [key, project(value[key], rule)]));
};
const publicResponse = result => project(result, shape);
const snapshot = state => ({
  lastIntent: text(state.lastIntent, 40), lastAgent: ['operations', 'analyst'].includes(state.lastAgent) ? state.lastAgent : null,
  lastEntity: compactEntity(state.lastEntity),
  recentEntities: (state.recentEntities || []).map(compactEntity).filter(Boolean).slice(0, 4),
  lastProductSelection: compactProductSelection(state.lastProductSelection, Date.now),
  lastPeriod: state.lastPeriod && isDate(state.lastPeriod.startDate) && isDate(state.lastPeriod.endDate)
    ? { startDate: state.lastPeriod.startDate, endDate: state.lastPeriod.endDate } : null,
  lastPeriodExplicit: state.lastPeriodExplicit === true,
  lastCurrency: text(state.lastCurrency, 8), lastSearchQuery: text(state.lastSearchQuery, 100),
  listLimit: Number.isSafeInteger(state.listLimit) ? Math.max(1, Math.min(20, state.listLimit)) : 5
});
const titleFor = message => {
  const normalized = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /stock bajo/.test(normalized) ? 'Productos con stock bajo' : /resum|negocio/.test(normalized) ? 'Resumen del negocio'
    : /reponer|reposicion/.test(normalized) ? 'Productos para reponer' : /mas vendidos/.test(normalized) ? 'Productos más vendidos'
      : redact(message).replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, 60);
};
module.exports = { redact, publicResponse, snapshot, titleFor };
