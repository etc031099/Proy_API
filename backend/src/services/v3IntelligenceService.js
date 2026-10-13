'use strict';

const { AgentError, isDate, isPlainObject } = require('../agents/contracts');
const { V3_SKILLS } = require('../agents/v3Skills');
const { rankEntities, normalize } = require('../automations/entityResolution');
const { AGENT_ML_HTTP_TIMEOUT_MS } = require('../agents/timeouts');
const V3 = Object.freeze({ businessId: 'MINIMARKET-PASCO-V3', scenarioId: 'minimarket-pasco-v3',
  datasetVersion: 'minimarket-pasco-v3-seed2026-v1', datasetSha256: 'a90b913b6ee83174165b39eaab1526525b3aacc53cae1abe6c3f5a54a469cac8',
  referenceDate: '2026-10-12', timezone: 'America/Lima' });
const unavailable = () => new AgentError('ML_SERVICE_UNAVAILABLE');
const safeData = (value, depth = 0) => {
  if (depth > 18) throw unavailable();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) { if (value.length > 100) throw unavailable(); return value.map(row => safeData(row, depth + 1)); }
  if (!isPlainObject(value)) throw unavailable();
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:_id|id|email|phone|address|payload|secret|token|headers|url|lease|canonicalData)$/i.test(key))
    .map(([key, row]) => [key, safeData(row, depth + 1)]));
};
// One request owns the source binding and entity promises. No decisions are cached
// across users/tenants or across conversation turns.
const createV3IntelligenceService = ({ models, mlClient } = {}) => {
  const getModels = () => models || require('../models');
  const client = mlClient || require('./mlServiceClient').createMlServiceClient({ timeoutMs: AGENT_ML_HTTP_TIMEOUT_MS });
  const contexts = new Map(), entities = new Map();
  const resolveContext = async context => {
    if (context.businessId !== V3.businessId) return null;
    if (!contexts.has(context.businessId)) contexts.set(context.businessId, Promise.resolve().then(async () => {
      const row = await getModels().HistoricalScenario.findOne({ businessId: context.businessId, scenarioId: V3.scenarioId })
        .select('businessId scenarioId status sourceSha256 metadata').lean().maxTimeMS(5000);
      if (!row || row.businessId !== context.businessId || row.scenarioId !== V3.scenarioId || row.status !== 'completed' || row.sourceSha256 !== V3.datasetSha256
        || row.metadata?.datasetVersion !== V3.datasetVersion || row.metadata?.referenceDate !== V3.referenceDate
        || row.metadata?.timezone !== V3.timezone) throw unavailable();
      return Object.freeze({ businessId: context.businessId, scenarioId: V3.scenarioId, datasetVersion: V3.datasetVersion,
        datasetSha256: V3.datasetSha256, timezone: V3.timezone, asOfDate: V3.referenceDate });
    }));
    return contexts.get(context.businessId);
  };
  const rowsFor = async (type, context) => {
    const key = `${context.businessId}:${type}`;
    if (!entities.has(key)) entities.set(key, Promise.resolve().then(async () => {
      if (['category', 'subcategory'].includes(type)) {
        const records = await getModels().MinimarketV3Record.find({ businessId: context.businessId, scenarioId: V3.scenarioId, recordType: 'category' })
          .select('_id canonicalData').limit(20).lean().maxTimeMS(5000);
        return records.flatMap(row => type === 'category' ? [{ _id: row._id, name: row.canonicalData.name, stableCode: row.canonicalData.code }]
          : row.canonicalData.subcategories.map(item => ({ _id: row._id, name: item.name, stableCode: item.code })));
      }
      const model = type === 'product' ? getModels().Product : getModels().Contact;
      return model.find({ businessId: context.businessId, scenarioId: V3.scenarioId, isActive: true,
        ...(type === 'product' ? {} : { type: type === 'supplier' ? 'vendor' : 'customer' }) })
        .select('_id name sku stableCode').sort({ _id: 1 }).limit(100).lean().maxTimeMS(5000);
    }));
    return entities.get(key);
  };
  const resolveEntity = async (type, reference, context, offset = 0) => {
    if (!await resolveContext(context)) throw new AgentError('AGENT_SKILL_NOT_ALLOWED');
    const rows = await rowsFor(type, context);
    const code = rows.find(row => normalize(row.sku || row.stableCode || '') === normalize(reference));
    const match = code ? { value: code, confidence: 'EXACT' } : rankEntities(rows, reference, offset, type === 'supplier');
    const compact = row => ({ id: String(row._id), key: row.sku || row.stableCode, label: row.name, type });
    if (match.value) return { entity: compact(match.value) };
    if (match.confidence === 'HIGH_CONFIDENCE' && match.candidates.length === 1) return { entity: compact(match.candidates[0]) };
    return { candidates: (match.candidates || []).map(compact), pagination: match.pagination, query: reference, type };
  };
  const execute = async invocation => {
    const binding = await resolveContext(invocation.context);
    if (!binding) throw new AgentError('AGENT_SKILL_NOT_ALLOWED');
    invocation.signal.throwIfAborted();
    const spec = V3_SKILLS[invocation.skill.id], args = invocation.args;
    const request = { requestId: invocation.context.requestId, context: { ...binding }, limit: args.limit || 5 };
    const supplierOrder = spec.domain === 'suppliers' && args.mode === 'rank' ? {
      lead_time: ['leadTime', 'averageDays'], fastestLeadTime: ['leadTime', 'averageDays'],
      late_share: ['punctuality', 'delayRatePct'], delays: ['punctuality', 'delayedOrderCount'],
      dependency: ['exclusiveOfferedSkuCount']
    }[args.metric] : null;
    for (const field of ['mode', 'metric', 'offset', 'risk', 'abc', 'xyz', 'flag', 'segment', 'entityType', 'categoryCode', 'subcategoryCode', 'horizonDays']) {
      if (args[field] !== undefined) request[field] = args[field];
    }
    if (supplierOrder) {
      // Fetch the complete bounded (10-supplier) aggregate set before ordering
      // approved computed metrics. No supplier formula or score is reimplemented.
      request.mode = 'summary'; request.metric = 'spend'; request.limit = 20; request.offset = 0;
    }
    if (args.asOfDate) {
      if (!isDate(args.asOfDate) || args.asOfDate > binding.asOfDate || args.asOfDate < '2025-10-13') throw new AgentError('AGENT_INVALID_SKILL_ARGS');
      request.context.asOfDate = args.asOfDate;
    }
    if (args.startDate) {
      if (args.endDate > request.context.asOfDate || args.startDate < '2025-10-13') throw new AgentError('AGENT_INVALID_SKILL_ARGS');
      request.period = { startDate: args.startDate, endDate: args.endDate };
    }
    if (spec.domain === 'suppliers' && !request.period) request.period = { startDate: '2025-10-13', endDate: binding.asOfDate };
    if (['detail', 'preferences', 'activity'].includes(request.mode) && spec.domain === 'customers' && !args.customerRef
      || request.mode === 'detail' && spec.domain === 'suppliers' && !args.supplierRef
      || request.mode === 'detail' && ['inventory', 'forecast'].includes(spec.domain) && !args.productRef && !args.productRefs) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
    const selected = {};
    for (const [field, type] of [['productRef', 'product'], ['customerRef', 'customer'], ['supplierRef', 'supplier'], ['categoryRef', 'category'], ['subcategoryRef', 'subcategory']]) {
      if (!args[field]) continue;
      const resolution = await resolveEntity(type, args[field], invocation.context);
      if (!resolution.entity) return { status: 'CLARIFICATION', data: [], metadata: { returnedCount: 0,
        totalMatches: resolution.pagination?.totalMatches || 0, resolution, asOf: binding.asOfDate } };
      selected[type] = resolution.entity;
    }
    if (selected.product) {
      if (spec.domain === 'business') request.productSku = selected.product.key;
      else if (spec.domain === 'cross-sell') request.sku = selected.product.key;
      else request[spec.domain === 'suppliers' ? 'productSkus' : 'skus'] = [selected.product.key];
    }
    if (args.productRefs) {
      const refs = args.productRefs.split('|');
      if (args.productRef || refs.length > 5 || refs.some(ref => !ref.trim() || ref.length > 100)) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
      const skus = [];
      for (let index = 0; index < refs.length; index++) {
        const resolution = await resolveEntity('product', refs[index], invocation.context);
        if (!resolution.entity) return { status: 'CLARIFICATION', data: [], metadata: { returnedCount: 0, totalMatches: resolution.pagination?.totalMatches || 0,
          asOf: binding.asOfDate, resolution: { ...resolution, referenceField: 'productRefs', selectionIndex: index } } };
        skus.push(resolution.entity.key);
      }
      request.skus = [...new Set(skus)];
    }
    if (spec.domain === 'forecast' && request.mode === 'compare' && (request.skus?.length || 0) < 2) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
    if (selected.customer) request.customerCode = selected.customer.key;
    if (selected.category) request.categoryCode = selected.category.key;
    if (selected.subcategory) request.subcategoryCode = selected.subcategory.key;
    if (selected.supplier) {
      if (spec.domain === 'suppliers') request.supplierCode = selected.supplier.key;
      else {
        // Supplier-scoped inventory uses only authorized offer SKUs, fetched in bulk.
        const products = await getModels().Product.find({ businessId: binding.businessId, scenarioId: binding.scenarioId,
          isActive: true, 'supplierPrices.supplierId': selected.supplier.id }).select('sku').limit(80).lean().maxTimeMS(5000);
        if (!products.length) return { status: 'NO_DATA', data: { items: [] }, metadata: { returnedCount: 0, totalMatches: 0, asOf: binding.asOfDate, selected } };
        request.skus = products.map(row => row.sku).filter(sku => !selected.product || sku === selected.product.key);
        if (!request.skus.length) return { status: 'NO_DATA', data: { items: [] }, metadata: { returnedCount: 0, totalMatches: 0, asOf: binding.asOfDate, selected } };
      }
    }
    if (request.mode === 'method' && spec.domain === 'forecast') return { status: 'READY',
      data: { method: 'MOVING_AVERAGE_28', horizons: [1, 7, 14] }, metadata: { returnedCount: 1, totalMatches: 1, asOf: binding.asOfDate, selected } };
    let body;
    try { body = await client.intelligence(spec.domain, request, { signal: invocation.signal }); }
    catch (error) { const safe = unavailable(); if (error?.functionalCode) safe.functionalCode = error.functionalCode; throw safe; }
    const meta = body?.metadata;
    if (body?.requestId !== request.requestId || !['OK', 'PARTIAL'].includes(body?.status) || !isPlainObject(body.data)
      || meta?.scenarioId !== binding.scenarioId || meta?.datasetSha256 !== binding.datasetSha256
      || meta?.datasetVersion !== binding.datasetVersion || meta?.asOfDate !== request.context.asOfDate
      || meta?.timezone !== binding.timezone || meta?.source !== 'CANONICAL_V3_BUNDLE' || meta?.contractVersion !== 'm6.9b-v3-intelligence-v1') throw unavailable();
    const data = safeData(body.data); let count = Array.isArray(data.items) ? data.items.length : 1;
    const validShape = spec.domain === 'business' ? (isPlainObject(data.kpis) || Array.isArray(data.items))
      : spec.domain === 'inventory' ? (isPlainObject(data.summary) || Array.isArray(data.items))
        : spec.domain === 'forecast' ? (Array.isArray(data.items) || Number.isFinite(data.totalExpectedUnits))
          : spec.domain === 'health' ? isPlainObject(data.businessHealth)
            : spec.domain === 'cross-sell' ? typeof data.available === 'boolean' && (data.available === false || Array.isArray(data.items))
              : Array.isArray(data.items);
    if (!validShape) throw unavailable();
    const responseItems = data.items || [];
    const responseType = ['inventory', 'forecast', 'business'].includes(spec.domain) && request.entityType !== 'category' ? 'product'
      : spec.domain === 'customers' ? 'customer' : spec.domain === 'suppliers' ? request.mode === 'alternatives' ? 'product' : 'supplier' : null;
    if (responseType && responseItems.length) {
      const allowed = new Set((await rowsFor(responseType, invocation.context)).map(row => row.sku || row.stableCode));
      const field = responseType === 'product' ? 'sku' : `${responseType}Code`;
      const required = responseType === 'product' ? request.skus || request.productSkus || (request.productSku ? [request.productSku] : null)
        : request[field] ? [request[field]] : null;
      if (responseItems.some(row => !isPlainObject(row) || !allowed.has(row[field]) || required && !required.includes(row[field]))) throw unavailable();
    }
    if (spec.domain === 'cross-sell' && data.available && responseItems.length) {
      const allowed = new Set((await rowsFor('product', invocation.context)).map(row => row.sku));
      if (responseItems.some(row => (row.consequentSkus || [row.recommendedSku]).filter(Boolean).some(sku => !allowed.has(sku)))) throw unavailable();
    }
    if (request.period && data.period && (data.period.startDate !== request.period.startDate || data.period.endDate !== request.period.endDate)) throw unavailable();
    if (data.kpis && ['revenueCents', 'unitsSold', 'ticketCount'].some(key => !Number.isFinite(data.kpis[key]))) throw unavailable();
    if (spec.domain === 'inventory' && responseItems.some(row => !isPlainObject(row.stock) || !Number.isFinite(row.stock.onHand)
      || !isPlainObject(row.recommendation) || !Number.isSafeInteger(row.recommendation.recommendedQty) || !isPlainObject(row.risk))) throw unavailable();
    if (spec.domain === 'forecast' && responseItems.some(row => !Number.isFinite(row[`expectedUnitsNext${request.horizonDays || 7}d`]))) throw unavailable();
    if (count > invocation.skill.maxRecords || Array.isArray(data.items) && count > request.limit) throw unavailable();
    if (supplierOrder) {
      const value = row => supplierOrder.reduce((result, field) => result?.[field], row);
      const descending = args.sortDirection === 'desc' || !args.sortDirection && !['lead_time', 'fastestLeadTime'].includes(args.metric);
      data.items.sort((a, b) => {
        const av = value(a), bv = value(b), aValid = Number.isFinite(av), bValid = Number.isFinite(bv);
        return Number(bValid) - Number(aValid) || (aValid && bValid ? (descending ? bv - av : av - bv) : 0) || a.supplierCode.localeCompare(b.supplierCode);
      });
      data.items = data.items.slice(args.offset || 0, (args.offset || 0) + (args.limit || 5)); count = data.items.length;
    }
    return { status: body.status === 'PARTIAL' ? 'PARTIAL' : count ? 'READY' : 'NO_DATA', data,
      metadata: { asOf: meta.asOfDate, period: request.period, returnedCount: count, totalMatches: data.total ?? count,
        truncated: (data.total || count) > count, selected, domain: spec.domain, source: meta.source,
        evidenceLabel: `Inteligencia V3 · ${spec.domain} · corte ${meta.asOfDate}` } };
  };
  return Object.freeze({ resolveContext, resolveEntity, execute });
};
module.exports = { V3, createV3IntelligenceService, safeData };
