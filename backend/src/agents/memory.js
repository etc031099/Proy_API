const { createHash } = require('node:crypto');
const { AgentError, assertAgentRequestContext, deepFreeze, isObjectId, isDate, isTimestamp, isTraceId } = require('./contracts');

const TTL_MS = 30 * 60 * 1000;
const BUDGET_PLAN_TTL_MS = 30 * 60 * 1000;
const contextBinding = context => createHash('sha256')
  .update(JSON.stringify([context.userId, context.businessId, context.conversationId])).digest('hex');
const label = (value, max) => typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ')
  .replace(/\bBearer\s+\S+|AIza[\w-]{20,}|[\w.+-]+@[a-z\d.-]+\.[a-z]{2,}/gi, '[omitido]').slice(0, max) : null;
const compactEntity = value => value && isObjectId(value.id || value.productId) ? {
  type: 'product', id: value.id || value.productId, sku: label(value.sku, 100), label: label(value.name || value.label, 80)
} : null;
const compactSupplier = value => value && isObjectId(value.id) && typeof value.name === 'string' && value.name.trim()
  ? deepFreeze({ id: value.id, name: label(value.name, 100) }) : null;
const LIST_INTENTS = new Set(['search_product', 'low_stock', 'top_selling_products', 'replenishment_candidates', 'demand_forecast', 'ml_analytics']);
const compactProductSelection = (value, now) => {
  if (!value || !LIST_INTENTS.has(value.sourceIntent) || !Array.isArray(value.items)) return null;
  const currentTime = now();
  const sourceTime = Number.isSafeInteger(value.createdAt) ? value.createdAt : currentTime;
  if (sourceTime > currentTime + 5000 || sourceTime <= currentTime - TTL_MS) return null;
  const timestamp = Math.min(sourceTime, currentTime);
  const items = value.items.slice(0, 5).map(row => {
    const entity = compactEntity(row);
    if (!entity) return null;
    const stock = finiteNonNegative(row.stock ?? row.stockAtAnchor);
    const predictedDemand = finiteNonNegative(row.predictedDemand7d ?? row.predictedDemand);
    const recommendedQty = finiteNonNegative(row.recommendedQty);
    const status = ['OK', 'VIGILAR', 'REPONER'].includes(row.inventoryStatus ?? row.status)
      ? row.inventoryStatus ?? row.status : null;
    return { ...entity, ...(stock !== null ? { stock } : {}),
      ...(predictedDemand !== null ? { predictedDemand } : {}),
      ...(recommendedQty !== null ? { recommendedQty } : {}), ...(status ? { status } : {}) };
  }).filter(Boolean);
  if (!items.length) return null;
  return deepFreeze({ semanticReference: 'last_product_list', sourceIntent: value.sourceIntent, items, createdAt: timestamp });
};
const compactSelectedProductReference = (value, now = Date.now) => {
  const entity = compactEntity(value);
  if (!entity) return null;
  const currentTime = now();
  const sourceTime = Number.isSafeInteger(value.createdAt) ? value.createdAt : currentTime;
  return sourceTime > currentTime + 5000 || sourceTime <= currentTime - TTL_MS
    ? null : deepFreeze({ ...entity, createdAt: Math.min(sourceTime, currentTime) });
};
const finiteNonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const compactBudgetPlan = (value, now = Date.now()) => {
  if (!value || value.semanticReference !== 'last_replenishment_budget_plan'
    || !isTraceId(value.conversationId)
    || !/^[a-f\d]{64}$/i.test(value.contextBinding || '')
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + BUDGET_PLAN_TTL_MS
    || value.currency !== 'PEN' || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 10
    || !value.evidence || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value.evidence.evidenceId || '')
    || !['budget', 'spent', 'remaining'].every(key => finiteNonNegative(value[key]) !== null)) return null;
  const date = candidate => isDate(candidate) || isTimestamp(candidate) ? candidate : null;
  const items = value.items.map(row => {
    if (!row || typeof row.sku !== 'string' || !row.sku.trim() || row.sku.length > 100
      || typeof row.productName !== 'string' || !row.productName.trim() || row.productName.length > 100
      || typeof row.supplierName !== 'string' || !row.supplierName.trim() || row.supplierName.length > 100
      || !Number.isSafeInteger(row.plannedQty) || row.plannedQty < 1
      || !['recommendedQty', 'unitCost', 'plannedCost', 'predictedDemand7d', 'stockAtAnchor', 'shortage'].every(key => finiteNonNegative(row[key]) !== null)) return null;
    return { sku: label(row.sku, 100), productName: label(row.productName, 100), supplierName: label(row.supplierName, 100),
      plannedQty: row.plannedQty, recommendedQty: row.recommendedQty, unitCost: row.unitCost, plannedCost: row.plannedCost,
      pendingQty: finiteNonNegative(row.pendingQty ?? row.unplannedQty),
      predictedDemand7d: row.predictedDemand7d, stockAtAnchor: row.stockAtAnchor, shortage: row.shortage,
      inventoryStatus: ['OK', 'VIGILAR', 'REPONER'].includes(row.inventoryStatus) ? row.inventoryStatus : null };
  });
  if (items.some(row => !row)) return null;
  const plannedUnits = finiteNonNegative(value.plannedUnits) ?? items.reduce((total, item) => total + item.plannedQty, 0);
  const pendingUnits = finiteNonNegative(value.pendingUnits ?? value.unplannedUnits)
    ?? (items.every(item => item.pendingQty !== null) ? items.reduce((total, item) => total + item.pendingQty, 0) : null);
  return deepFreeze({ semanticReference: 'last_replenishment_budget_plan', budget: value.budget, currency: 'PEN',
    spent: value.spent, remaining: value.remaining, plannedUnits, pendingUnits,
    itemsComplete: value.itemsComplete === true, items,
    conversationId: value.conversationId, contextBinding: value.contextBinding,
    scenarioId: typeof value.scenarioId === 'string' ? label(value.scenarioId, 80) : null,
    anchor: date(value.anchor), pricingAsOf: date(value.pricingAsOf), expiresAt: value.expiresAt,
    evidence: { evidenceId: value.evidence.evidenceId, label: label(value.evidence.label, 160),
      ...(date(value.evidence.asOf) ? { asOf: date(value.evidence.asOf) } : {}) } });
};
const SUPPLIER_SELECTION_TTL_MS = 20 * 60 * 1000;
const compactSupplierResolution = (value, now = Date.now()) => {
  if (!value || !['get_replenishment_cost', 'compare_supplier_costs', 'get_supplier_products'].includes(value.skillId)
    || (value.candidateType !== undefined && value.candidateType !== 'supplier')
    || !value.args || (value.skillId !== 'get_supplier_products' && (typeof value.args.productRef !== 'string' || value.args.productRef.length > 100))
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + SUPPLIER_SELECTION_TTL_MS
    || !Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 100
    || !Number.isSafeInteger(value.offset || 0) || (value.offset || 0) < 0 || (value.offset || 0) % 5 !== 0) return null;
  const candidates = value.candidates.filter(row => /^[a-f\d]{24}$/i.test(row?.id || '') && typeof row.name === 'string' && row.name.trim())
    .map(row => ({ id: row.id, name: label(row.name, 100), ...(typeof row.detail === 'string' ? { detail: label(row.detail, 80) } : {}) }));
  if (!candidates.length) return null;
  return deepFreeze({ candidateType: 'supplier', pageSize: 5, totalMatches: candidates.length,
    ...(value.truncatedMatches === true ? { truncatedMatches: true } : {}),
    originalIntent: value.originalIntent || value.skillId, skillId: value.skillId, args: { ...(value.skillId === 'get_replenishment_cost' && value.args.mode === 'single' ? { mode: 'single' } : {}),
    ...(typeof value.args.productRef === 'string' ? { productRef: value.args.productRef } : {}),
    ...(Number.isSafeInteger(value.args.limit) ? { limit: Math.max(1, Math.min(5, value.args.limit)) } : {}),
    ...(Number.isSafeInteger(value.args.offset) ? { offset: Math.max(0, Math.min(10000, value.args.offset)) } : {}) }, candidates, offset: value.offset || 0,
    ...(typeof value.query === 'string' ? { query: label(value.query, 100) } : {}), refining: value.refining === true,
    expiresAt: value.expiresAt });
};
const compactSupplierProductListing = (value, now = Date.now()) => {
  if (!value || !/^[a-f\d]{24}$/i.test(value.supplierId || '') || typeof value.supplierName !== 'string'
    || !value.supplierName.trim() || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset % 5 !== 0
    || !Number.isSafeInteger(value.totalProducts) || value.totalProducts < 0
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + SUPPLIER_SELECTION_TTL_MS) return null;
  return deepFreeze({ supplierId: value.supplierId, supplierName: label(value.supplierName, 100),
    offset: value.offset, totalProducts: value.totalProducts, expiresAt: value.expiresAt });
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
          const supplier = compactSupplier(patch.lastSupplier);
          const productSelection = Object.hasOwn(patch, 'lastProductSelection')
            ? compactProductSelection(patch.lastProductSelection, now) : state.lastProductSelection || null;
          const supplierResolution = Object.hasOwn(patch, 'supplierResolution')
            ? compactSupplierResolution(patch.supplierResolution, now) : state.supplierResolution || null;
          const supplierProductListing = Object.hasOwn(patch, 'supplierProductListing')
            ? compactSupplierProductListing(patch.supplierProductListing, now) : state.supplierProductListing || null;
          const period = patch.lastPeriod;
          pending = deepFreeze({
            lastReplenishmentPlan: Object.hasOwn(patch, 'lastReplenishmentPlan')
              ? compactBudgetPlan({ ...patch.lastReplenishmentPlan,
                conversationId: patch.lastReplenishmentPlan?.conversationId || context.conversationId,
                contextBinding: patch.lastReplenishmentPlan?.contextBinding || contextBinding(context) }, now()) : state.lastReplenishmentPlan || null,
            lastForecastAnalytics: Object.hasOwn(patch, 'lastForecastAnalytics')
              ? require('./forecastAnalytics').compactAnalyticsContext(patch.lastForecastAnalytics) : state.lastForecastAnalytics || null,
            lastIntent: label(patch.lastIntent ?? state.lastIntent, 40),
            lastAgent: ['operations', 'analyst'].includes(patch.lastAgent) ? patch.lastAgent : state.lastAgent || null,
            lastEntity: entity || (entities.length === 1 ? entities[0] : null), recentEntities: entities,
            lastSupplier: supplier || (Object.hasOwn(patch, 'lastSupplier') ? null : state.lastSupplier || null),
            lastProductSelection: productSelection,
            selectedProductReference: Object.hasOwn(patch, 'selectedProductReference')
              ? compactSelectedProductReference(patch.selectedProductReference, now) : state.selectedProductReference || null,
            supplierResolution,
            supplierProductListing,
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

module.exports = { createConversationMemory, compactEntity, compactSupplier, compactProductSelection, compactSupplierResolution,
  compactSelectedProductReference, compactSupplierProductListing, compactBudgetPlan, contextBinding,
  SUPPLIER_SELECTION_TTL_MS, BUDGET_PLAN_TTL_MS, TTL_MS };
