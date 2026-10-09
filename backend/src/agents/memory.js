const { AgentError, assertAgentRequestContext, deepFreeze, isObjectId, isDate } = require('./contracts');

const TTL_MS = 30 * 60 * 1000;
const label = (value, max) => typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ')
  .replace(/\bBearer\s+\S+|AIza[\w-]{20,}|[\w.+-]+@[a-z\d.-]+\.[a-z]{2,}/gi, '[omitido]').slice(0, max) : null;
const compactEntity = value => value && isObjectId(value.id || value.productId) ? {
  type: 'product', id: value.id || value.productId, sku: label(value.sku, 100), label: label(value.name || value.label, 80)
} : null;
const LIST_INTENTS = new Set(['search_product', 'low_stock', 'top_selling_products', 'replenishment_candidates', 'demand_forecast', 'ml_analytics']);
const compactProductSelection = (value, now) => {
  if (!value || !LIST_INTENTS.has(value.sourceIntent) || !Array.isArray(value.items)) return null;
  return deepFreeze({ sourceIntent: value.sourceIntent,
    items: value.items.map(compactEntity).filter(Boolean).slice(0, 5), createdAt: now() });
};
const SUPPLIER_SELECTION_TTL_MS = 20 * 60 * 1000;
const compactSupplierResolution = (value, now = Date.now()) => {
  if (!value || !['get_replenishment_cost', 'compare_supplier_costs'].includes(value.skillId)
    || !value.args || typeof value.args.productRef !== 'string' || value.args.productRef.length > 100
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + SUPPLIER_SELECTION_TTL_MS
    || !Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 20
    || !Number.isSafeInteger(value.offset || 0) || (value.offset || 0) < 0 || (value.offset || 0) % 5 !== 0) return null;
  const candidates = value.candidates.filter(row => /^[a-f\d]{24}$/i.test(row?.id || '') && typeof row.name === 'string' && row.name.trim())
    .map(row => ({ id: row.id, name: label(row.name, 100), ...(typeof row.detail === 'string' ? { detail: label(row.detail, 80) } : {}) }));
  if (!candidates.length) return null;
  return deepFreeze({ skillId: value.skillId, args: { ...(value.skillId === 'get_replenishment_cost' && value.args.mode === 'single' ? { mode: 'single' } : {}),
    productRef: value.args.productRef }, candidates, offset: value.offset || 0,
    ...(typeof value.query === 'string' ? { query: label(value.query, 100) } : {}), refining: value.refining === true,
    expiresAt: value.expiresAt });
};

/** Demo-only, bounded in-process working context. Render restarts erase this cache,
 * not the separate Mongo conversation history; a compact snapshot may be restored.
 * Only domain references are retained: no messages, provider responses or reasoning.
 * A per-key queue serializes read/commit so concurrent follow-ups see committed state.
 */
const createConversationMemory = ({ now = Date.now, ttlMs = TTL_MS, maxEntries = 1000 } = {}) => {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new AgentError('AGENT_INVALID_REQUEST');
  const entries = new Map();
  const queues = new Map();
  const keyFor = context => {
    assertAgentRequestContext(context);
    if (!context.conversationId) throw new AgentError('AGENT_INVALID_REQUEST');
    return JSON.stringify([context.userId, context.businessId, context.conversationId]);
  };
  const purge = () => {
    for (const [key, entry] of entries) if (entry.expiresAt <= now() && !queues.has(key)) entries.delete(key);
  };
  return Object.freeze({
    forget(context) {
      const key = keyFor(context);
      if (queues.has(key)) throw new AgentError('AGENT_BUDGET_EXCEEDED');
      entries.delete(key);
    },
    async withConversation(context, operation) {
      const key = keyFor(context);
      if (typeof operation !== 'function') throw new AgentError('AGENT_INVALID_REQUEST');
      purge();
      if (!queues.has(key) && queues.size >= maxEntries) throw new AgentError('AGENT_BUDGET_EXCEEDED');
      const previous = queues.get(key) || { tail: Promise.resolve(), count: 0 };
      if (previous.count >= 4) throw new AgentError('AGENT_BUDGET_EXCEEDED');
      const record = { count: previous.count + 1 };
      const task = previous.tail.catch(() => {}).then(async () => {
        const entry = entries.get(key);
        const state = entry && entry.expiresAt > now() ? entry.state : Object.freeze({});
        let pending;
        const commit = patch => {
          const entities = Array.isArray(patch.recentEntities)
            ? patch.recentEntities.map(compactEntity).filter(Boolean).slice(0, 4) : state.recentEntities || [];
          const entity = compactEntity(patch.lastEntity);
          const productSelection = Object.hasOwn(patch, 'lastProductSelection')
            ? compactProductSelection(patch.lastProductSelection, now) : state.lastProductSelection || null;
          const supplierResolution = Object.hasOwn(patch, 'supplierResolution')
            ? compactSupplierResolution(patch.supplierResolution, now) : state.supplierResolution || null;
          const period = patch.lastPeriod;
          pending = deepFreeze({
            lastForecastAnalytics: Object.hasOwn(patch, 'lastForecastAnalytics')
              ? require('./forecastAnalytics').compactAnalyticsContext(patch.lastForecastAnalytics) : state.lastForecastAnalytics || null,
            lastIntent: label(patch.lastIntent ?? state.lastIntent, 40),
            lastAgent: ['operations', 'analyst'].includes(patch.lastAgent) ? patch.lastAgent : state.lastAgent || null,
            lastEntity: entity || (entities.length === 1 ? entities[0] : null), recentEntities: entities,
            lastProductSelection: productSelection,
            supplierResolution,
            lastPeriod: period && isDate(period.startDate) && isDate(period.endDate)
              ? { startDate: period.startDate, endDate: period.endDate } : state.lastPeriod || null,
            lastPeriodExplicit: typeof patch.lastPeriodExplicit === 'boolean'
              ? patch.lastPeriodExplicit : state.lastPeriodExplicit === true,
            lastTransactionFilters: patch.lastTransactionFilters ? {
              periodRequested: patch.lastTransactionFilters.periodRequested === true,
              type: ['sale', 'purchase'].includes(patch.lastTransactionFilters.type) ? patch.lastTransactionFilters.type : null,
              status: ['completed', 'pending', 'cancelled'].includes(patch.lastTransactionFilters.status) ? patch.lastTransactionFilters.status : null
            } : state.lastTransactionFilters || null,
            lastCurrency: label(patch.lastCurrency ?? state.lastCurrency, 8),
            lastSearchQuery: label(patch.lastSearchQuery ?? state.lastSearchQuery, 100),
            listLimit: Number.isSafeInteger(patch.listLimit) ? Math.min(20, Math.max(1, patch.listLimit)) : state.listLimit || 5
          });
        };
        const result = await operation(state, commit);
        if (pending) {
          entries.delete(key);
          entries.set(key, { state: pending, expiresAt: now() + ttlMs });
          while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        }
        return result;
      });
      record.tail = task;
      queues.set(key, record);
      try { return await task; } finally {
        if (queues.get(key) === record) queues.delete(key);
        else { const current = queues.get(key); if (current) current.count--; }
      }
    }
  });
};

module.exports = { createConversationMemory, compactEntity, compactProductSelection, compactSupplierResolution, SUPPLIER_SELECTION_TTL_MS, TTL_MS };
