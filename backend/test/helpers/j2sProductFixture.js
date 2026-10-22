'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { V3, createV3IntelligenceService } = require('../../src/services/v3IntelligenceService');
const { createAgentOrchestrator } = require('../../src/agents/orchestrator');
const { createConversationMemory } = require('../../src/agents/memory');
const { withActionAssistant } = require('../../src/automations/assistant');
const id = n => n.toString(16).padStart(24, '0');
const included = ['PAN-ENV-001', 'PAN-FRE-001', 'ABA-ACE-001', 'ABA-ACE-002', 'BEB-GAS-001', 'BEB-GAS-002', 'ABA-ARR-001'];
const rows = require('../../../data/minimarket-pasco-v3/products.json').catalog.filter(row => included.includes(row.sku))
  .sort((a, b) => a.sku.localeCompare(b.sku)).map((row, index) => ({ _id: id(index + 1), name: row.name, sku: row.sku,
    businessId: V3.businessId, scenarioId: V3.scenarioId, isActive: true, currency: 'PEN', stock: 21,
    supplierPrices: [{ supplierId: id(500), purchasePrice: 2 }] }));
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => key === '$or'
  ? value.some(branch => matches(row, branch)) : value instanceof RegExp ? value.test(String(row[key]))
    : value?.$in ? value.$in.includes(row[key]) : String(row[key]) === String(value));
function query(value) {
  let fields;
  const project = row => fields && row && typeof row === 'object'
    ? Object.fromEntries(Object.entries(row).filter(([key]) => key === '_id' || fields.includes(key))) : row;
  return { select(selection) { fields = selection.split(' '); return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS() { return this; },
    then(resolve, reject) { return Promise.resolve(structuredClone(Array.isArray(value) ? value.map(project) : project(value))).then(resolve, reject); },
    async *cursor() { for (const row of value) yield structuredClone(project(row)); } };
}
const productFind = filter => query(rows.filter(row => matches(row, filter)));
function fixture({ now = Date.now, memoryTtl, productRows = rows, contactRows = [], neutralProvider, mlTransform, legacyModels, forecastRegistryService } = {}) {
  const calls = [], catalogReads = [], providerCalls = [], events = [], prepared = [], mutations = [], pending = new Map();
  const previewArgs = new Map(), confirmations = [];
  const request = { businessId: V3.businessId, user: { _id: id(999), businessId: V3.businessId, role: 'user', isActive: true } };
  const scenario = { businessId: V3.businessId, scenarioId: V3.scenarioId, status: 'completed', sourceSha256: V3.datasetSha256,
    metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.referenceDate, timezone: V3.timezone } };
  const service = createV3IntelligenceService({ clock: () => new Date('2026-10-15T17:00:00Z'), forecastRegistryService,
    models: { HistoricalScenario: { findOne: () => query(scenario) }, Product: { find: filter => {
      catalogReads.push(filter); return query(productRows.filter(row => matches(row, filter))); } }, Contact: {
      find: filter => query(contactRows.filter(row => matches(row, filter))),
      findOne: filter => query(contactRows.find(row => matches(row, filter)) || null) } },
    snapshotBuilder: async ({ businessId, asOfDate }) => ({ mode: 'LIVE', dataVersion: '0', snapshot: { metadata: {
      snapshotVersion: 'v3-operational-snapshot-v2', businessId, scenarioId: V3.scenarioId, asOfDate, dataVersion: '0', snapshotHash: 'f'.repeat(64) } } }),
    mlClient: { intelligence: async (domain, payload) => {
      calls.push({ domain, payload });
      const skus = payload.skus || (payload.productSku ? [payload.productSku] : productRows.map(row => row.sku));
      let data;
      if (domain === 'inventory') data = { items: skus.slice(0, payload.limit).map(sku => ({ sku, productName: productRows.find(row => row.sku === sku).name,
        stock: { onHand: 21, incoming: 0 }, coverage: { daysCover: 7 }, risk: { level: 'LOW' },
        inventoryPolicy: { configuredMinimumStock: 5 }, recommendation: { recommendedQty: 3, shouldReorder: true } })), total: skus.length };
      else if (domain === 'forecast') data = { method: 'MOVING_AVERAGE_28', horizonDays: payload.horizonDays,
        items: skus.slice(0, payload.limit).map(sku => ({ sku, productName: productRows.find(row => row.sku === sku).name,
          status: 'READY', expectedUnitsNext1d: 2, expectedUnitsNext7d: 14, expectedUnitsNext14d: 28 })), total: skus.length };
      else if (domain === 'cross-sell') data = { available: true, mode: 'FROZEN', analysisCutoff: V3.historicalCutoff,
        items: [{ recommendedSku: 'BEB-GAS-001', recommendedProduct: 'Coca-Cola', support: .1, confidence: .4, lift: 2, ticketCount: 30 }], total: 1 };
      else if (domain === 'business') data = payload.mode === 'rank'
        ? { items: skus.slice(0, payload.limit).map(sku => ({ sku, productName: productRows.find(row => row.sku === sku).name, metric: 100 })), total: skus.length }
        : { kpis: { revenueCents: 50000, unitsSold: 100, ticketCount: 20, averageTicket: 25, grossMarginPct: null } };
      else if (domain === 'health') data = { businessHealth: {}, alerts: [] };
      else if (domain === 'customers') { const contacts = contactRows.filter(row => row.type === 'customer' && (!payload.customerCode || row.stableCode === payload.customerCode));
        data = { items: contacts.map(row => ({ customerCode: row.stableCode, displayName: row.name, totalSpentCents: 12000, ticketCount: 4,
          segment: 'AT_RISK', rfm90d: { raw: { recencyDays: 35, frequency90d: 4, monetary90dCents: 12000 } } })), total: contacts.length }; }
      else if (domain === 'suppliers') data = { items: [], total: 0 };
      else assert.fail(`Unexpected domain ${domain}`);
      const response = { requestId: payload.requestId, status: 'OK', data, metadata: { ...payload.context,
        source: payload.dataMode === 'LIVE' ? 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT' : 'CANONICAL_V3_BUNDLE',
        contractVersion: payload.dataMode === 'LIVE' ? 'm6.9f4-live-intelligence-v1' : 'm6.9b-v3-intelligence-v1',
        ...(payload.dataMode === 'LIVE' ? { dataVersion: '0', snapshotHash: 'f'.repeat(64) } : {}) } };
      return mlTransform ? mlTransform(domain, payload, response) : response;
    } } });
  const denied = () => { providerCalls.push('unexpected'); assert.fail('No provider is permitted in J2S'); };
  const provider = { generateStructured: denied, generateWithTools: denied };
  const runtime = createAgentOrchestrator({ memory: createConversationMemory({ now, ...(memoryTtl ? { ttlMs: memoryTtl } : {}) }),
    clock: () => new Date('2026-10-15T17:00:00Z'), dependencies: { v3Service: service, ...(legacyModels ? { models: legacyModels } : {}) }, provider,
    neutralProvider: neutralProvider === undefined ? { provider: 'mock', model: 'offline', generate: denied } : neutralProvider, onEvent: event => events.push(event) });
  const actionService = {
    async prepare(input) { prepared.push(structuredClone(input.args));
      const items = input.args.products?.map(item => ({ quantity: item.quantity, price: 2, total: item.quantity * 2,
        stock: 21, resultingStock: input.skillId === 'create_purchase' ? 21 + item.quantity : 21 - item.quantity,
        sku: productRows.find(row => String(row._id) === String(item.productId))?.sku,
        name: productRows.find(row => String(row._id) === String(item.productId))?.name }));
      const value = { pendingActionId: randomUUID(), action: input.skillId, status: 'PENDING', summary: 'Preview simulado',
        ...(items ? { items, fields: { total: items.reduce((sum, item) => sum + item.total, 0), currency: 'PEN' } } : {}),
        expiresAt: new Date(now() + 60000).toISOString() };
      pending.set(value.pendingActionId, value); previewArgs.set(value.pendingActionId, structuredClone(input.args)); return value; },
    async get(_context, key) { const row = pending.get(key); return row?.status === 'PENDING' && Date.parse(row.expiresAt) <= now() ? { ...row, status: 'EXPIRED' } : row; },
    async resolvePending() { return [...pending.values()].find(row => row.status === 'PENDING'); },
    async confirmPendingAction(_context, key) { const value = pending.get(key);
      if (value.status !== 'PENDING' || Date.parse(value.expiresAt) <= now()) throw Object.assign(new Error('Stale offline preview'), { code: 'ACTION_CANCELLED' });
      mutations.push('mock-only'); confirmations.push({ id: key, args: structuredClone(previewArgs.get(key)) }); value.status = 'EXECUTED';
      return { ...value, result: { type: value.action === 'create_purchase' ? 'purchase' : 'sale', total: value.fields?.total ?? 4, currency: 'PEN',
        items: value.items?.map(row => ({ name: row.name, sku: row.sku, quantity: row.quantity, stock: row.resultingStock }))
          || [{ name: 'Producto simulado', quantity: 2, stock: 19 }] } }; },
    async cancelPendingAction(_context, key) { const value = pending.get(key); value.status = 'CANCELLED'; return value; }
  };
  const actions = withActionAssistant(runtime, actionService, { clock: now, provider, supplierLookup: async () => [{ _id: id(500), name: 'Proveedor simulado' }] });
  const conversationId = randomUUID();
  return { service, runtime, request, actions, actionService, pending, calls, catalogReads, events, providerCalls, prepared, mutations, confirmations, previewArgs, conversationId,
    run: (message, convo = conversationId, req = request) => actions.handle(req, { message, conversationId: convo }),
    snapshot: () => actions.getContextSnapshot(request, conversationId) };
}
module.exports = { fixture, rows, productFind, id };
