'use strict';

const { AgentError, isDate, isPlainObject } = require('../agents/contracts');
const { V3_SKILLS } = require('../agents/v3Skills');
const { rankEntities, normalize } = require('../automations/entityResolution');
const { AGENT_ML_HTTP_TIMEOUT_MS } = require('../agents/timeouts');
const { createOperationalClock, operationalDate } = require('../utils/operationalClock');
const V3 = Object.freeze({ ...require('../config/v3Demo'), scenarioId: 'minimarket-pasco-v3',
  datasetVersion: 'minimarket-pasco-v3-seed2026-v1', datasetSha256: 'a90b913b6ee83174165b39eaab1526525b3aacc53cae1abe6c3f5a54a469cac8',
  historicalCutoff: '2026-10-12', referenceDate: '2026-10-12', timezone: 'America/Lima', earliestDate: '2025-10-13' });
const unavailable = () => new AgentError('ML_SERVICE_UNAVAILABLE');
const safeData = (value, depth = 0, maxArrayLength = 100) => {
  if (depth > 18) throw unavailable();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) { if (value.length > maxArrayLength) throw unavailable(); return value.map(row => safeData(row, depth + 1, maxArrayLength)); }
  if (!isPlainObject(value)) throw unavailable();
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:_id|id|email|phone|address|payload|secret|token|headers|url|lease|canonicalData)$/i.test(key))
    .map(([key, row]) => [key, safeData(row, depth + 1, maxArrayLength)]));
};
// One request owns the source binding and entity promises. No decisions are cached
// across users/tenants or across conversation turns.
const createV3IntelligenceService = ({ models, mlClient, clock = () => new Date(), snapshotBuilder } = {}) => {
  const getModels = () => models || require('../models');
  const client = mlClient || require('./mlServiceClient').createMlServiceClient({ timeoutMs: AGENT_ML_HTTP_TIMEOUT_MS });
  const operationalClock = createOperationalClock({ clock, timeZone: V3.timezone });
  const buildSnapshot = snapshotBuilder || (options => require('./v3OperationalSnapshotService').buildV3OperationalSnapshot(options));
  const contexts = new Map(), entities = new Map(), turnContexts = new Map(), liveSnapshots = new Map();
  const resolveContext = async context => {
    if (context.businessId !== V3.businessId) return null;
    if (!contexts.has(context.businessId)) contexts.set(context.businessId, Promise.resolve().then(async () => {
      const row = await getModels().HistoricalScenario.findOne({ businessId: context.businessId, scenarioId: V3.scenarioId })
        .select('businessId scenarioId status sourceSha256 metadata').lean().maxTimeMS(5000);
      if (!row || row.businessId !== context.businessId || row.scenarioId !== V3.scenarioId || row.status !== 'completed' || row.sourceSha256 !== V3.datasetSha256
        || row.metadata?.datasetVersion !== V3.datasetVersion || row.metadata?.referenceDate !== V3.referenceDate
        || row.metadata?.timezone !== V3.timezone) throw unavailable();
      return Object.freeze({ businessId: context.businessId, scenarioId: V3.scenarioId, datasetVersion: V3.datasetVersion,
        datasetSha256: V3.datasetSha256, timezone: V3.timezone, historicalCutoff: V3.historicalCutoff, earliestDate: V3.earliestDate });
    }));
    const verified = await contexts.get(context.businessId);
    if (!verified) return null;
    const turnKey = `${context.businessId}:${context.requestId || ''}`;
    const cachedTurn = turnContexts.get(turnKey);
    if (!cachedTurn || cachedTurn.expiresAt <= Date.now()) {
      const instant = operationalClock.now();
      const date = operationalDate(instant, V3.timezone);
      const binding = Object.freeze({ ...verified, operationalDate: date, asOfDate: date, clockInstant: instant.toISOString() });
      turnContexts.set(turnKey, { binding, expiresAt: Date.now() + 5 * 60 * 1000 });
      while (turnContexts.size > 512) turnContexts.delete(turnContexts.keys().next().value);
    }
    return turnContexts.get(turnKey).binding;
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
  const getLiveSnapshot = (binding, requestId, asOfDate) => {
    const build = () => buildSnapshot({ businessId: binding.businessId, asOfDate, now: new Date(binding.clockInstant) });
    // Reuse one immutable snapshot only inside a single assistant request (e.g. a
    // bounded multi-intent). A new requestId always reads a fresh revision.
    if (!requestId) return build();
    const key = `${binding.businessId}:${binding.scenarioId}:${binding.datasetVersion}:${requestId}:${asOfDate}`;
    if (!liveSnapshots.has(key)) {
      liveSnapshots.set(key, Promise.resolve().then(build));
      while (liveSnapshots.size > 32) liveSnapshots.delete(liveSnapshots.keys().next().value);
    }
    return liveSnapshots.get(key);
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
    const domain = spec.domain, isFrozenDomain = domain === 'cross-sell';
    const frozenMetadata = data => ({ status: 'READY', data, metadata: { asOf: V3.historicalCutoff,
      dataMode: 'HISTORICAL', frozenCutoff: V3.historicalCutoff, returnedCount: Array.isArray(data.assignments)
        ? data.assignments.length : Array.isArray(data.topAnomalies) ? data.topAnomalies.length : 1,
      totalMatches: Array.isArray(data.assignments) ? data.assignments.length : Array.isArray(data.topAnomalies) ? data.topAnomalies.length : 1,
      domain } });
    // These are existing, validated dashboard contracts exposed through their
    // owning READ skills. They remain historical evidence and never alter an
    // operational calculation or feed user-supplied model inputs.
    if (domain === 'forecast' && args.mode === 'evaluation') {
      return frozenMetadata(await forecastEvaluation(invocation.context, { signal: invocation.signal }));
    }
    if (domain === 'customers' && args.mode === 'clustering') {
      if (args.clusterFilter && args.clusterId || args.customerRef && (args.clusterFilter || args.clusterId)) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
      const raw = await customerClustering(invocation.context, { signal: invocation.signal, customerRef: args.customerRef });
      const customerRows = await rowsFor('customer', invocation.context);
      const labels = new Map(customerRows.map(row => [row.stableCode, row.name]));
      if ((raw.assignments || []).some(row => !labels.has(row.customerRef))) throw unavailable();
      let selectedCluster = null;
      if (args.clusterId !== undefined) selectedCluster = raw.clusters.find(row => row.cluster === args.clusterId) || null;
      if (args.clusterFilter) selectedCluster = raw.clusters.find(row => normalize(row.name).includes(normalize(args.clusterFilter))) || null;
      const assignments = args.customerRef ? raw.assignments
        : args.clusterId !== undefined || args.clusterFilter ? selectedCluster
          ? raw.assignments.filter(row => row.cluster === selectedCluster.cluster) : [] : [];
      const data = { algorithm: raw.algorithm, learningType: raw.learningType, task: raw.task,
        trainingCutoff: raw.trainingCutoff, sampleCount: raw.sampleCount, excludedCount: raw.excludedCount,
        features: raw.features, featureWindow: raw.featureWindow, transformations: raw.transformations,
        scaler: raw.scaler, k: raw.k, status: raw.status,
        metrics: { silhouetteMean: raw.metrics?.silhouetteMean, subsampleAriMean: raw.metrics?.subsampleAriMean,
          inertia: raw.metrics?.inertia }, clusters: raw.clusters.map(row => ({ cluster: row.cluster, name: row.name,
          size: row.size, silhouetteMean: row.silhouetteMean })),
        assignments: assignments.slice(0, 20).map(row => ({ customerRef: row.customerRef, customerName: labels.get(row.customerRef),
          status: row.status, ...(row.cluster !== undefined ? { cluster: row.cluster, clusterName: row.clusterName } : {}) })),
        assignmentAsOfDate: raw.assignmentAsOfDate, assignmentSource: raw.assignmentSource,
        limitations: raw.limitations };
      if ((args.clusterFilter || args.clusterId !== undefined) && !selectedCluster) data.requestedClusterFound = false;
      return frozenMetadata(data);
    }
    if (domain === 'business' && args.mode === 'anomalies') {
      if (Boolean(args.startDate) !== Boolean(args.endDate)) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
      const startDate = args.startDate || V3.earliestDate, endDate = args.endDate || V3.historicalCutoff;
      const raw = await salesAnomalies(invocation.context, { signal: invocation.signal, startDate, endDate,
        limit: args.limit || 10 });
      const data = { algorithm: raw.algorithm, learningType: raw.learningType, task: raw.task, mode: raw.mode,
        trainingCutoff: raw.trainingCutoff, analysisCutoff: raw.analysisCutoff, sampleCount: raw.sampleCount,
        analysisDays: raw.analysisDays, features: raw.features, transformations: raw.transformations,
        contamination: raw.contamination, threshold: raw.threshold, anomalyCount: raw.anomalyCount,
        anomalyRate: raw.anomalyRate, filteredDays: raw.filteredDays, filteredAnomalyCount: raw.filteredAnomalyCount,
        stability: raw.stability, scoreSemantics: raw.scoreSemantics, selectionReason: raw.selectionReason,
        status: raw.status, limitations: raw.limitations, period: raw.period,
        topAnomalies: raw.topAnomalies.slice(0, args.limit || 10).map(row => ({ date: row.date,
          anomalyScore: row.anomalyScore, decisionFunction: row.decisionFunction, isAnomaly: row.isAnomaly })) };
      return frozenMetadata(data);
    }
    const requestedAsOfDate = isFrozenDomain ? V3.historicalCutoff : (args.asOfDate || args.endDate || binding.operationalDate);
    if (!isDate(requestedAsOfDate) || requestedAsOfDate > binding.operationalDate || requestedAsOfDate < V3.earliestDate) {
      const error = new AgentError('AGENT_INVALID_SKILL_ARGS'); error.functionalCode = 'INVALID_PERIOD'; throw error;
    }
    const request = { requestId: invocation.context.requestId,
      context: { businessId: binding.businessId, scenarioId: binding.scenarioId, datasetVersion: binding.datasetVersion,
        datasetSha256: binding.datasetSha256, timezone: binding.timezone, asOfDate: requestedAsOfDate },
      dataMode: isFrozenDomain || requestedAsOfDate <= V3.historicalCutoff ? 'HISTORICAL' : 'LIVE', limit: args.limit || 5 };
    const supplierOrder = spec.domain === 'suppliers' && args.mode === 'rank' ? {
      lead_time: ['leadTime', 'averageDays'], fastestLeadTime: ['leadTime', 'averageDays'],
      late_share: ['punctuality', 'delayRatePct'], delays: ['punctuality', 'delayedOrderCount'],
      dependency: ['exclusiveOfferedSkuCount']
    }[args.metric] : null;
    for (const field of ['mode', 'metric', 'offset', 'risk', 'abc', 'xyz', 'flag', 'segment', 'entityType', 'categoryCode', 'subcategoryCode', 'horizonDays', 'includeObservedSeries']) {
      if (args[field] !== undefined) request[field] = args[field];
    }
    if (supplierOrder) {
      // Fetch the complete bounded (10-supplier) aggregate set before ordering
      // approved computed metrics. No supplier formula or score is reimplemented.
      request.mode = 'summary'; request.metric = 'spend'; request.limit = 20; request.offset = 0;
    }
    if (args.asOfDate) {
      if (!isDate(args.asOfDate) || args.asOfDate > binding.operationalDate || args.asOfDate < V3.earliestDate) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
      request.context.asOfDate = args.asOfDate;
    }
    if (args.startDate) {
      if (!isDate(args.endDate) || args.endDate > request.context.asOfDate || args.startDate < V3.earliestDate || args.startDate > args.endDate) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
      request.period = { startDate: args.startDate, endDate: args.endDate };
    }
    if (spec.domain === 'suppliers' && !request.period) request.period = { startDate: V3.earliestDate, endDate: request.context.asOfDate };
    if (['detail', 'preferences', 'activity'].includes(request.mode) && spec.domain === 'customers' && !args.customerRef
      || request.mode === 'detail' && spec.domain === 'suppliers' && !args.supplierRef
      || request.mode === 'detail' && ['inventory', 'forecast'].includes(spec.domain) && !args.productRef && !args.productRefs) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
    const selected = {};
    for (const [field, type] of [['productRef', 'product'], ['customerRef', 'customer'], ['supplierRef', 'supplier'], ['categoryRef', 'category'], ['subcategoryRef', 'subcategory']]) {
      if (!args[field]) continue;
      const resolution = await resolveEntity(type, args[field], invocation.context);
      if (!resolution.entity) return { status: 'CLARIFICATION', data: [], metadata: { returnedCount: 0,
        totalMatches: resolution.pagination?.totalMatches || 0, resolution, asOf: binding.operationalDate } };
      selected[type] = resolution.entity;
    }
    if (selected.product) {
      if (spec.domain === 'business') request.productSku = selected.product.key;
      else if (spec.domain === 'cross-sell') request.sku = selected.product.key;
      else request[spec.domain === 'suppliers' ? 'productSkus' : 'skus'] = [selected.product.key];
    }
    if (args.productRefs) {
      const refs = args.productRefs.split('|');
      const maxProductRefs = spec.domain === 'inventory' && ['low_stock', 'should_reorder'].includes(args.flag) ? 20 : 5;
      if (args.productRef || refs.length > maxProductRefs || refs.some(ref => !ref.trim() || ref.length > 100)) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
      const skus = [];
      for (let index = 0; index < refs.length; index++) {
        const resolution = await resolveEntity('product', refs[index], invocation.context);
        if (!resolution.entity) return { status: 'CLARIFICATION', data: [], metadata: { returnedCount: 0, totalMatches: resolution.pagination?.totalMatches || 0,
          asOf: binding.operationalDate, resolution: { ...resolution, referenceField: 'productRefs', selectionIndex: index } } };
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
        if (!products.length) return { status: 'NO_DATA', data: { items: [] }, metadata: { returnedCount: 0, totalMatches: 0, asOf: request.context.asOfDate, selected } };
        request.skus = products.map(row => row.sku).filter(sku => !selected.product || sku === selected.product.key);
        if (!request.skus.length) return { status: 'NO_DATA', data: { items: [] }, metadata: { returnedCount: 0, totalMatches: 0, asOf: request.context.asOfDate, selected } };
      }
    }
    if (request.mode === 'method' && spec.domain === 'forecast') return { status: 'READY',
      data: { method: 'MOVING_AVERAGE_28', horizons: [1, 7, 14] }, metadata: { returnedCount: 1, totalMatches: 1, asOf: request.context.asOfDate, selected } };
    let liveSnapshot = null;
    if (request.dataMode === 'LIVE') {
      try {
        liveSnapshot = await getLiveSnapshot(binding, invocation.context.requestId, requestedAsOfDate);
      } catch (error) {
        const safe = unavailable();
        safe.functionalCode = ['SNAPSHOT_BOOTSTRAP_REQUIRED', 'SNAPSHOT_CONSISTENCY_UNAVAILABLE', 'SNAPSHOT_TOO_LARGE']
          .includes(error?.code) ? error.code : 'LIVE_SNAPSHOT_UNAVAILABLE';
        throw safe;
      }
      const snapshotMetadata = liveSnapshot?.snapshot?.metadata;
      if (liveSnapshot?.mode !== 'LIVE' || liveSnapshot.dataVersion == null || snapshotMetadata?.businessId !== binding.businessId
          || snapshotMetadata?.scenarioId !== binding.scenarioId || snapshotMetadata?.asOfDate !== requestedAsOfDate
          || String(snapshotMetadata?.dataVersion) !== String(liveSnapshot.dataVersion)
          || !['v3-operational-snapshot-v1', 'v3-operational-snapshot-v2'].includes(snapshotMetadata?.snapshotVersion)) {
        const safe = unavailable(); safe.functionalCode = 'LIVE_SNAPSHOT_UNAVAILABLE'; throw safe;
      }
      request.operationalSnapshot = liveSnapshot.snapshot;
    }
    let body;
    try { body = await client.intelligence(spec.domain, request, { signal: invocation.signal }); }
    catch (error) { const safe = unavailable(); if (error?.functionalCode) safe.functionalCode = error.functionalCode; throw safe; }
    const meta = body?.metadata;
    const expectedSource = request.dataMode === 'LIVE' ? 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT' : 'CANONICAL_V3_BUNDLE';
    const expectedContract = request.dataMode === 'LIVE' ? 'm6.9f4-live-intelligence-v1' : 'm6.9b-v3-intelligence-v1';
    if (body?.requestId !== request.requestId || !['OK', 'PARTIAL'].includes(body?.status) || !isPlainObject(body.data)
      || meta?.scenarioId !== binding.scenarioId || meta?.datasetSha256 !== binding.datasetSha256
      || meta?.datasetVersion !== binding.datasetVersion || meta?.asOfDate !== request.context.asOfDate
      || meta?.timezone !== binding.timezone || meta?.source !== expectedSource || meta?.contractVersion !== expectedContract
      || request.dataMode === 'LIVE' && (String(meta?.dataVersion) !== String(liveSnapshot.dataVersion)
        || meta?.snapshotHash !== liveSnapshot.snapshot.metadata.snapshotHash)) throw unavailable();
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
    if (spec.domain === 'forecast' && responseItems.some(row => row.status === 'READY'
      ? !Number.isFinite(row[`expectedUnitsNext${request.horizonDays || 7}d`])
      : !['COLD_START', 'INSUFFICIENT_HISTORY'].includes(row.status))) throw unavailable();
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
      metadata: { asOf: meta.asOfDate, dataMode: request.dataMode,
        ...(request.dataMode === 'LIVE' ? { updatedAt: liveSnapshot.snapshot.metadata.capturedAtUtc,
          dataThrough: liveSnapshot.snapshot.metadata.dataThroughUtc || null,
          observationsClosedThrough: liveSnapshot.snapshot.metadata.observationsClosedThrough } : {}),
        ...(request.dataMode === 'LIVE' ? { dataVersion: String(meta.dataVersion), snapshotHash: meta.snapshotHash } : {}),
        ...(domain === 'cross-sell' ? { freshness: 'FROZEN_HISTORICAL', frozenCutoff: V3.historicalCutoff } : {}),
        period: request.period, returnedCount: count, totalMatches: data.total ?? count,
        truncated: (data.total || count) > count, selected, domain: spec.domain, source: meta.source,
        evidenceLabel: domain === 'cross-sell' ? `Inteligencia V3 · asociaciones históricas al ${V3.historicalCutoff}`
          : `Inteligencia V3 · ${spec.domain} · ${request.dataMode === 'LIVE' ? 'operativo' : 'histórico'} al ${meta.asOfDate}` } };
  };
  const forecastEvaluation = async (context, { signal } = {}) => {
    const binding = await resolveContext(context);
    if (!binding) throw new AgentError('AGENT_SKILL_NOT_ALLOWED');
    const payload = { requestId: context.requestId, dataMode: 'HISTORICAL', mode: 'evaluation',
      context: { businessId: binding.businessId, scenarioId: binding.scenarioId,
        datasetVersion: binding.datasetVersion, datasetSha256: binding.datasetSha256,
        timezone: binding.timezone, asOfDate: V3.historicalCutoff } };
    let body;
    try { body = await client.intelligence('forecast', payload, { signal }); }
    catch (error) { const safe = unavailable(); safe.functionalCode = error?.functionalCode; throw safe; }
    const meta = body?.metadata;
    if (body?.requestId !== payload.requestId || body.status !== 'OK'
      || meta?.scenarioId !== binding.scenarioId || meta?.datasetVersion !== binding.datasetVersion
      || meta?.datasetSha256 !== binding.datasetSha256 || meta?.timezone !== binding.timezone
      || meta?.asOfDate !== V3.historicalCutoff || meta?.source !== 'CANONICAL_V3_BUNDLE'
      || meta?.contractVersion !== 'm6.9b-v3-intelligence-v1') throw unavailable();
    const data = safeData(body.data);
    if (data.contractVersion !== 'forecast-model-evaluation-v1' || data.analysisCutoff !== V3.historicalCutoff
      || data.selectedOperationalMethod?.algorithm !== 'MOVING_AVERAGE_28'
      || data.selectedOperationalMethod?.modelType !== 'STATISTICAL_BASELINE'
      || !Array.isArray(data.modelEvaluation) || data.modelEvaluation.length !== 2
      || data.modelEvaluation.some(row => row.algorithm !== 'HistGradientBoostingRegressor'
        || !['EVALUATED', 'REJECTED_FOR_OPERATIONAL_USE'].includes(row.modelStatus)
        || !Number.isFinite(row.metrics?.test?.wape))) throw unavailable();
    return data;
  };
  const customerClustering = async (context, { signal, customerRef } = {}) => {
    const binding = await resolveContext(context);
    if (!binding) throw new AgentError('AGENT_SKILL_NOT_ALLOWED');
    const payload = { requestId: context.requestId, dataMode: 'HISTORICAL', mode: 'clustering',
      context: { businessId: binding.businessId, scenarioId: binding.scenarioId,
        datasetVersion: binding.datasetVersion, datasetSha256: binding.datasetSha256,
        timezone: binding.timezone, asOfDate: V3.historicalCutoff } };
    if (customerRef) {
      // Raw RFM never comes from frontend parameters: the existing tenant-scoped
      // customer skill reads and verifies its historical/LIVE source first.
      const result = await execute({ context, signal, skill: { id: 'get_customer_intelligence', maxRecords: 1 },
        args: { mode: 'detail', customerRef, limit: 1 } });
      const row = result.data?.items?.[0];
      if (!row) { const error = unavailable(); error.functionalCode = 'CUSTOMER_NOT_FOUND'; throw error; }
      const raw = row.rfm90d?.raw;
      if (!raw || !Number.isFinite(raw.frequency90d) || !Number.isFinite(raw.monetary90dCents)) throw unavailable();
      payload.customerCode = row.customerCode;
      payload.assignmentRfm = { recency: raw.recencyDays, frequency: raw.frequency90d, monetary: raw.monetary90dCents / 100 };
      payload.assignmentAsOfDate = binding.operationalDate;
    }
    let body;
    try { body = await client.intelligence('customers', payload, { signal }); }
    catch (error) { const safe = unavailable(); safe.functionalCode = error?.functionalCode; throw safe; }
    const meta = body?.metadata;
    if (body?.requestId !== payload.requestId || body.status !== 'OK'
      || meta?.scenarioId !== binding.scenarioId || meta?.datasetVersion !== binding.datasetVersion
      || meta?.datasetSha256 !== binding.datasetSha256 || meta?.timezone !== binding.timezone
      || meta?.asOfDate !== V3.historicalCutoff || meta?.source !== 'CANONICAL_V3_BUNDLE'
      || meta?.contractVersion !== 'm6.9b-v3-intelligence-v1') throw unavailable();
    const data = safeData(body.data);
    if (data.contractVersion !== 'customer-kmeans-v3-v1' || data.algorithm !== 'KMeans'
      || data.learningType !== 'unsupervised' || data.trainingCutoff !== V3.historicalCutoff
      || data.status !== 'EXPLORATORY' || !Array.isArray(data.assignments) || !Array.isArray(data.clusters)
      || data.assignments.some(row => 'probability' in row || 'confidence' in row)
      || customerRef && (data.assignments.length !== 1 || data.assignments[0].customerRef !== payload.customerCode
        || data.assignmentAsOfDate !== payload.assignmentAsOfDate)) throw unavailable();
    return data;
  };
  const salesAnomalies = async (context, { signal, startDate = V3.earliestDate, endDate = V3.historicalCutoff, limit = 10 } = {}) => {
    const binding = await resolveContext(context);
    if (!binding) throw new AgentError('AGENT_SKILL_NOT_ALLOWED');
    if (!isDate(startDate) || !isDate(endDate) || startDate < V3.earliestDate || startDate > endDate
      || endDate > V3.historicalCutoff || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      const error = new AgentError('AGENT_INVALID_SKILL_ARGS'); error.functionalCode = 'INVALID_PERIOD'; throw error;
    }
    const payload = { requestId: context.requestId, dataMode: 'HISTORICAL', mode: 'anomalies', limit,
      period: { startDate, endDate }, context: { businessId: binding.businessId, scenarioId: binding.scenarioId,
        datasetVersion: binding.datasetVersion, datasetSha256: binding.datasetSha256,
        timezone: binding.timezone, asOfDate: V3.historicalCutoff } };
    let body;
    try { body = await client.intelligence('business', payload, { signal }); }
    catch (error) { const safe = unavailable(); safe.functionalCode = error?.functionalCode; throw safe; }
    const meta = body?.metadata;
    if (body?.requestId !== payload.requestId || body.status !== 'OK'
      || meta?.scenarioId !== binding.scenarioId || meta?.datasetVersion !== binding.datasetVersion
      || meta?.datasetSha256 !== binding.datasetSha256 || meta?.timezone !== binding.timezone
      || meta?.asOfDate !== V3.historicalCutoff || meta?.source !== 'CANONICAL_V3_BUNDLE'
      || meta?.contractVersion !== 'm6.9b-v3-intelligence-v1') throw unavailable();
    // This sole frozen 365-day series has a specific bound; other skill limits
    // retain their existing 100-element guard.
    const data = safeData(body.data, 0, 365);
    if (data.contractVersion !== 'sales-isolation-forest-v3-v1' || data.algorithm !== 'IsolationForest'
      || data.mode !== 'FROZEN' || data.analysisCutoff !== V3.historicalCutoff || data.status !== 'EXPLORATORY'
      || data.period?.startDate !== startDate || data.period?.endDate !== endDate
      || !Array.isArray(data.series) || !Array.isArray(data.topAnomalies) || data.topAnomalies.length > limit
      || data.filteredDays !== data.series.length || data.filteredAnomalyCount !== data.series.filter(row => row.isAnomaly).length
      || data.series.length !== (Date.parse(endDate)-Date.parse(startDate))/86400000+1
      || new Set(data.series.map(row => row.date)).size !== data.series.length
      || data.series.some(row => !isDate(row.date) || row.date < startDate || row.date > endDate
        || !Number.isFinite(row.anomalyScore) || typeof row.isAnomaly !== 'boolean'
        || row.isAnomaly !== (row.decisionFunction < 0) || Math.abs(row.decisionFunction-(row.anomalyScore-data.threshold)) > 1e-12
        || 'probability' in row || 'accuracy' in row)
      || data.topAnomalies.some(row => !row.isAnomaly || !data.series.some(day => day.date === row.date && day.anomalyScore === row.anomalyScore))) throw unavailable();
    return data;
  };
  return Object.freeze({ resolveContext, resolveEntity, execute, operationalClock, forecastEvaluation, customerClustering, salesAnomalies });
};
module.exports = { V3, createV3IntelligenceService, safeData };
