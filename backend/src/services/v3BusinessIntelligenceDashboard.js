'use strict';

const { randomUUID } = require('node:crypto');
const { V3, createV3IntelligenceService } = require('./v3IntelligenceService');

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validDate = value => datePattern.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const safeError = (error, status = 503) => {
  const code = error?.functionalCode || ({ AGENT_SKILL_NOT_ALLOWED: 'SCENARIO_NOT_SUPPORTED', AGENT_INVALID_SKILL_ARGS: 'INVALID_REQUEST' }[error?.code]) || 'ANALYTICS_UNAVAILABLE';
  const known = new Map([
    ['SNAPSHOT_BOOTSTRAP_REQUIRED', [503, 'La analítica operativa aún no está disponible.']],
    ['LIVE_SNAPSHOT_UNAVAILABLE', [503, 'No se pudo obtener una lectura operativa consistente.']],
    ['LIVE_SNAPSHOT_REQUIRED', [503, 'La analítica operativa requiere un snapshot válido.']],
    ['LIVE_SNAPSHOT_INVALID', [503, 'La lectura operativa no pudo validarse.']],
    ['TENANT_MISMATCH', [403, 'El negocio no está autorizado para este escenario.']],
    ['PRODUCT_NOT_FOUND', [404, 'No se encontró el producto solicitado.']],
    ['CUSTOMER_NOT_FOUND', [404, 'No se encontró el cliente solicitado.']],
    ['SUPPLIER_NOT_FOUND', [404, 'No se encontró el proveedor solicitado.']],
    ['AMBIGUOUS_ENTITY', [409, 'La referencia coincide con más de una entidad.']],
    ['INSUFFICIENT_HISTORY', [422, 'No hay historial suficiente para esta consulta.']],
    ['DATA_NOT_AVAILABLE', [503, 'La analítica solicitada no está disponible.']],
    ['UNSUPPORTED_HORIZON', [400, 'El horizonte solicitado no está disponible.']],
    ['INVALID_PERIOD', [400, 'La fecha solicitada no es válida.']],
    ['SCENARIO_NOT_SUPPORTED', [403, 'Este negocio no tiene acceso a la analítica V3.']],
    ['ARTIFACT_UNAVAILABLE', [503, 'La analítica solicitada no está disponible temporalmente.']],
  ]);
  const [httpStatus, message] = known.get(code) || [status, 'No se pudo cargar la analítica del negocio.'];
  return { code, httpStatus, message };
};

const createV3BusinessIntelligenceDashboard = ({ models, intelligenceService, forecastRegistryService, clock = () => new Date() } = {}) => {
  const service = intelligenceService || createV3IntelligenceService({ models, clock });
  const getModels = () => models || require('../models');
  const registry = forecastRegistryService || require('./forecastModelRegistryService').createForecastModelRegistryService();
  const loadCatalogProducts = async (businessId, skus, fields) => {
    if (!skus.length) return new Map();
    const rows = await getModels().Product.find({ businessId, scenarioId: V3.scenarioId, isActive: true, sku: { $in: skus } })
      .select(fields).lean().maxTimeMS(3000);
    return new Map(rows.map(row => [row.sku, row]));
  };
  const contextFor = async (req, { frozen = false } = {}) => {
    const businessId = req.user?.businessId;
    if (!businessId || req.businessId && req.businessId !== businessId) {
      const error = new Error('Tenant context mismatch'); error.functionalCode = 'TENANT_MISMATCH'; throw error;
    }
    const requestId = randomUUID();
    const authenticated = { businessId, requestId, userId: String(req.user?._id || req.user?.id || '') };
    const binding = await service.resolveContext(authenticated);
    if (!binding) { const error = new Error('Scenario not supported'); error.functionalCode = 'SCENARIO_NOT_SUPPORTED'; throw error; }
    // Market Basket is an approved frozen artifact, not a period-based LIVE
    // query. Ignore generic dashboard date params and bind it to its lineage.
    const asOf = frozen ? V3.historicalCutoff : req.query?.asOf || binding.operationalDate;
    if (!validDate(asOf) || asOf > binding.operationalDate || asOf < V3.earliestDate) {
      const error = new Error('Invalid period'); error.functionalCode = 'INVALID_PERIOD'; throw error;
    }
    return { authenticated, binding, asOf };
  };
  const execute = (context, skillId, args = {}, maxRecords = 20, trusted = {}) => service.execute({
    context: context.authenticated,
    skill: { id: skillId, maxRecords },
    args: { ...args, asOfDate: context.asOf },
    signal: new AbortController().signal,
    ...trusted,
  });
  const liveRidgeModelsFor = async context => Promise.all([7, 14].map(async horizonDays => {
    try {
      const active = await registry.getActiveModelArtifact({ businessId: context.authenticated.businessId,
        scenarioId: V3.scenarioId, horizonDays });
      return active ? trustedForecastEnvelope(active, { businessId: context.authenticated.businessId,
        scenarioId: V3.scenarioId, horizonDays }) : null;
    } catch (_) {
      // An unavailable/corrupt ACTIVE artifact makes forecast-dependent
      // inventory fields partial; it must not suppress independent stock data.
      return null;
    }
  }));
  const executeInventoryHealth = async (context, skillId, args = {}, maxRecords = 20) => {
    if (context.asOf <= V3.historicalCutoff) return execute(context, skillId, args, maxRecords);
    const envelopes = await liveRidgeModelsFor(context);
    return execute(context, skillId, args, maxRecords, {
      trustedInventoryRidgeModels: envelopes.filter(Boolean),
    });
  };
  const responseMeta = (result, context, domain) => ({
    asOf: context.asOf, timezone: V3.timezone, mode: domain === 'cross-sell' ? 'FROZEN' : result.metadata?.dataMode || null,
    updatedAt: result.metadata?.updatedAt || null, dataThrough: result.metadata?.dataThrough || null,
    freshness: domain === 'cross-sell' ? { mode: 'FROZEN', cutoff: V3.historicalCutoff }
      : result.data?.freshness || { mode: result.metadata?.dataMode || null,
        updatedAt: result.metadata?.updatedAt || null, dataThrough: result.metadata?.dataThrough || null,
        dataVersion: result.metadata?.dataVersion || null, snapshotHash: result.metadata?.snapshotHash || null },
    dataVersion: result.metadata?.dataVersion || null, snapshotHash: result.metadata?.snapshotHash || null,
    source: result.metadata?.source || null, engineVersion: result.metadata?.engineVersion || null,
  });
  const periodRange = (context, query = {}) => {
    const { startDate, endDate } = query;
    if (startDate !== undefined || endDate !== undefined) {
      if (!validDate(startDate) || !validDate(endDate) || startDate > endDate || endDate > context.asOf) return null;
      return { startDate, endDate };
    }
    const period = String(query.period || 'TODAY').toUpperCase();
    const days = { TODAY: 1, LAST_7_DAYS: 7, LAST_30_DAYS: 30 }[period];
    if (!days) return null;
    return { startDate: addDays(context.asOf, -(days - 1)), endDate: context.asOf };
  };
  const periodArgs = period => ({ startDate: period.startDate, endDate: period.endDate });
  const money = cents => Number.isFinite(cents) ? { value: cents / 100, currency: 'PEN' } : null;
  const kpiContract = data => {
    const kpis = data?.kpis || {};
    const marginAvailable = Number.isFinite(kpis.grossMarginCents);
    return { revenue: money(kpis.revenueCents), units: finiteOrNull(kpis.unitsSold), tickets: finiteOrNull(kpis.ticketCount),
      averageTicket: money(Number.isFinite(kpis.averageTicket) ? Math.round(kpis.averageTicket * 100) : null),
      grossMargin: { value: marginAvailable ? kpis.grossMarginCents / 100 : null, currency: marginAvailable ? 'PEN' : null,
        percent: finiteOrNull(kpis.grossMarginPct), availability: marginAvailable ? data?.availabilityStatus === 'PARTIAL' ? 'PARTIAL' : 'AVAILABLE' : 'UNAVAILABLE' } };
  };
  const executionError = result => result.status === 'CLARIFICATION'
    ? { code: 'AMBIGUOUS_ENTITY', httpStatus: 409, message: 'La referencia coincide con más de una entidad.',
      candidates: (result.metadata?.resolution?.candidates || []).map(({ key, label, type }) => ({ key, label, type })) }
    : null;
  const sales = async req => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, period = periodRange(context, req.query || {});
    if (!period) return { error: invalidPeriodError() };
    const limit = parseLimit(req.query?.limit);
    if (!limit) return { error: invalidLimitError() };
    const compare = String(req.query?.compare || '').toLowerCase() === 'true';
    const includeSeries = String(req.query?.includeSeries || '').toLowerCase() === 'true';
    if (includeSeries && daysBetween(period.startDate, period.endDate) > 29) return { error: invalidPeriodError() };
    try {
      const summaryArgs = { ...periodArgs(period), mode: compare ? 'compare' : 'summary' };
      const [summaryResult, productsResult, categoriesResult] = await Promise.all([
        execute(context, 'get_business_analytics', summaryArgs, 1),
        execute(context, 'get_business_analytics', { ...periodArgs(period), mode: 'rank', entityType: 'product', metric: 'revenue', limit }, limit),
        execute(context, 'get_business_analytics', { ...periodArgs(period), mode: 'rank', entityType: 'category', metric: 'revenue', limit }, limit),
      ]);
      const summaryClarification = executionError(summaryResult); if (summaryClarification) return { error: summaryClarification };
      const kpis = kpiContract(summaryResult.data);
      const series = [];
      if (includeSeries) {
        const days = [];
        for (let day = period.startDate; day <= period.endDate; day = addDays(day, 1)) days.push(day);
        // Independent dates share this request's immutable snapshot. Bound concurrency for ML Free.
        for (let offset = 0; offset < days.length; offset += 4) {
          series.push(...await Promise.all(days.slice(offset, offset + 4).map(async day => {
            const pointResult = await execute(context, 'get_business_analytics', { mode: 'summary', startDate: day, endDate: day }, 1);
            const point = kpiContract(pointResult.data);
            return { date: day, revenue: point.revenue, units: point.units, tickets: point.tickets,
              status: pointResult.status || 'UNAVAILABLE' };
          })));
        }
      }
      const ranking = result => (result.data?.items || []).map(row => ({
        name: row.name || row.categoryName || row.sku || row.categoryCode || null,
        sku: row.sku || null, category: row.categoryCode || null, revenue: row.revenueCents !== undefined ? money(row.revenueCents) :
          String(row.metricName || result.data?.metric || '').toLowerCase().includes('revenue') && Number.isFinite(row.metric) ? money(row.metric) : null,
        units: finiteOrNull(row.units ?? (String(row.metricName || result.data?.metric || '').toLowerCase().includes('unit') ? row.metric : null)),
        tickets: finiteOrNull(row.ticketCount ?? (String(row.metricName || result.data?.metric || '').toLowerCase().includes('ticket') ? row.metric : null)),
        metric: finiteOrNull(row.metric), metricName: row.metricName || result.data?.metric || null,
      }));
      return { data: { ...responseMeta(summaryResult, context, 'business'), period,
        comparisonPeriod: summaryResult.data?.previousPeriod || null, summary: kpis,
        grossMarginAvailability: kpis.grossMargin.availability,
        variation: summaryResult.data?.trends || null, comparisonAvailability: summaryResult.data?.comparisonAvailability || null,
        series: includeSeries ? series : null,
        seriesStatus: !includeSeries ? 'NOT_REQUESTED'
          : series.every(point => point.status === 'READY') ? 'READY' : series.every(point => point.status === 'NO_DATA') ? 'NO_DATA' : 'PARTIAL',
        rankings: { topProducts: ranking(productsResult), topCategories: ranking(categoriesResult) } } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const customers = async req => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, limit = parseLimit(req.query?.limit), offset = parseOffset(req.query?.offset);
    if (!limit || offset === null) return { error: invalidLimitError() };
    const segment = req.query?.segment ? String(req.query.segment).toUpperCase() : undefined;
    if (segment && !['AT_RISK', 'INACTIVE', 'NEW', 'LOYAL', 'TOP_HIGH_VALUE', 'POTENTIAL'].includes(segment)) return { error: invalidRequestError() };
    const metrics = { spend: 'spend', frequency: 'tickets', recency: 'recency', gross_margin: 'gross_margin' };
    const metric = metrics[String(req.query?.sortBy || 'spend').toLowerCase()];
    if (!metric) return { error: invalidRequestError() };
    try {
      const [summaryResult, rankResult] = await Promise.all([
        execute(context, 'get_customer_intelligence', { mode: 'summary', limit: 20 }, 20),
        execute(context, 'get_customer_intelligence', { mode: 'rank', metric, segment, limit, offset }, limit),
      ]);
      const distribution = summaryResult.data?.segmentDistribution || {};
      const rows = rankResult.data?.items || [];
      const totalRegistered = finiteOrNull(summaryResult.data?.total), inactive = finiteOrNull(distribution.INACTIVE);
      return { data: { ...responseMeta(rankResult, context, 'customers'), summary: {
        totalRegistered, active: totalRegistered !== null && inactive !== null ? totalRegistered - inactive : null,
        new: finiteOrNull(distribution.NEW), inactive, atRisk: finiteOrNull(distribution.AT_RISK),
        highValue: finiteOrNull(distribution.TOP_HIGH_VALUE), potential: finiteOrNull(distribution.POTENTIAL), segments: distribution,
        consumerFinalIncludedInIndividualRfm: false },
        items: rows.map(customerRow), total: rankResult.data?.total ?? 0, limit, offset } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const customer = async req => entityDetail(req, { domain: 'customers', skill: 'get_customer_intelligence', refArg: 'customerRef', notFound: 'CUSTOMER_NOT_FOUND', mapper: customerRow,
    args: { mode: 'detail' } });
  const suppliers = async req => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, period = periodRange(context, req.query || {}), limit = parseLimit(req.query?.limit), offset = parseOffset(req.query?.offset);
    if (!period) return { error: invalidPeriodError() };
    if (!limit || offset === null) return { error: invalidLimitError() };
    try {
      const args = { mode: 'summary', ...periodArgs(period), limit: 20 };
      const [summaryResult, rankingResult, dependencyResult] = await Promise.all([
        execute(context, 'get_supplier_intelligence', args, 20),
        execute(context, 'get_supplier_intelligence', { mode: 'rank', metric: 'spend', ...periodArgs(period), limit, offset }, limit),
        execute(context, 'get_supplier_intelligence', { mode: 'dependency', ...periodArgs(period), limit: 20 }, 20),
      ]);
      const summary = summaryResult.data?.summary || {};
      return { data: { ...responseMeta(rankingResult, context, 'suppliers'), period,
        summary: { totalSuppliers: finiteOrNull(summary.suppliers), totalSpend: money(summary.receivedSpendCents),
          pendingOrders: finiteOrNull(summary.pendingOrders), receivedOrders: finiteOrNull(summary.receivedOrders),
          dependency: dependencyResult.data?.singleSourceCriticalOrHigh || null,
          averageLeadTime: { days: null, sampleSize: null, status: 'NOT_EXPOSED_BY_ENGINE' } },
        items: (rankingResult.data?.items || []).map(supplierRow), total: rankingResult.data?.total ?? 0, limit, offset } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const supplier = async req => entityDetail(req, { domain: 'suppliers', skill: 'get_supplier_intelligence', refArg: 'supplierRef', notFound: 'SUPPLIER_NOT_FOUND', mapper: supplierRow,
    args: { mode: 'detail' } });
  const associations = async req => {
    const prepared = await run(req, { frozen: true }); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, limit = parseLimit(req.query?.limit), offset = parseOffset(req.query?.offset);
    if (!limit || offset === null) return { error: invalidLimitError() };
    try {
      const [summaryResult, result] = await Promise.all([
        execute(context, 'get_cross_sell_recommendations', { mode: 'summary', limit: 1 }, 1),
        execute(context, 'get_cross_sell_recommendations', { mode: 'rules', limit, offset }, limit),
      ]);
      return { data: { ...responseMeta(summaryResult, context, 'cross-sell'), mode: 'FROZEN', cutoff: V3.historicalCutoff,
        summary: summaryResult.data?.summary || null, available: result.data?.available === true,
        items: (result.data?.items || []).map(ruleRow), total: result.data?.total ?? 0, limit, offset } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const productRelated = async req => {
    const prepared = await run(req, { frozen: true }); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, sku = String(req.params?.sku || '').trim(), limit = parseLimit(req.query?.limit);
    if (!limit) return { error: invalidLimitError() };
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(sku)) return { error: invalidRequestError() };
    try {
      const productRow = await getModels().Product.findOne({ businessId: context.authenticated.businessId, scenarioId: V3.scenarioId,
        isActive: true, sku }).select('name presentation').lean().maxTimeMS(3000);
      if (!productRow) return { error: safeError(Object.assign(new Error(), { functionalCode: 'PRODUCT_NOT_FOUND' })) };
      const result = await execute(context, 'get_cross_sell_recommendations', { mode: 'recommend', productRef: sku, limit }, limit);
      const ambiguous = executionError(result); if (ambiguous) return { error: ambiguous };
      return { data: { ...responseMeta(result, context, 'cross-sell'), mode: 'FROZEN', cutoff: V3.historicalCutoff,
        sourceProduct: { sku, name: productRow.name, presentation: productRow.presentation || null },
        available: result.data?.available === true,
        items: (result.data?.items || []).map(row => ({ relatedProduct: { sku: row.recommendedSku || row.sku || null,
          name: row.recommendedProduct || row.productName || row.name || null }, support: finiteOrNull(row.support),
          confidence: finiteOrNull(row.confidence), lift: finiteOrNull(row.lift), ticketCount: finiteOrNull(row.ticketCount),
          stability: row.stability?.status || row.stability || null, classification: row.classification || null })),
        total: result.data?.total ?? 0 } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const health = async req => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, period = periodRange(context, req.query || {}), limit = req.query?.limit === undefined ? 5 : parseLimit(req.query.limit);
    if (!period) return { error: invalidPeriodError() };
    if (!limit || limit > 5) return { error: invalidLimitError('El límite debe estar entre 1 y 5.') };
    try {
      const result = await executeInventoryHealth(context, 'get_business_health', { ...periodArgs(period), limit }, 5);
      const data = result.data || {}, sections = data.businessHealth || {};
      return { data: { ...responseMeta(result, context, 'health'), status: data.availabilityStatus || result.status,
        period: data.period || period, domains: Object.fromEntries(['sales', 'margin', 'customers', 'inventory', 'suppliers', 'forecast', 'marketBasket']
          .map(name => [name, sections[name] ? { status: domainStatus(sections[name]), freshness: sections[name].freshness || null, metrics: stripAlerts(sections[name]),
            insights: sections[name].alerts || [] } : { status: 'UNAVAILABLE', freshness: null, metrics: null, insights: [] }])),
        insights: Array.isArray(data.alerts) ? data.alerts : [] } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const entityDetail = async (req, options) => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, reference = String(req.params?.[options.refArg] || '').trim();
    if (!reference || reference.length > 100) return { error: invalidRequestError() };
    try {
      const result = await execute(context, options.skill, { ...options.args, [options.refArg]: reference, limit: 1 }, 1);
      if (result.status === 'CLARIFICATION') return { error: executionError(result) };
      const row = result.data?.items?.[0];
      if (!row) return { error: safeError(Object.assign(new Error(), { functionalCode: options.notFound })) };
      const item = options.mapper(row);
      if (options.domain === 'suppliers') {
        item.costTrends = Array.isArray(result.data?.costTrends) ? result.data.costTrends : null;
        item.historyAvailability = item.costTrends === null ? 'NOT_EXPOSED_BY_ENGINE' : item.costTrends.length ? 'AVAILABLE' : 'INSUFFICIENT_HISTORY';
      }
      const historyAvailability = options.domain === 'suppliers' ? item.historyAvailability
        : result.status === 'PARTIAL' ? 'PARTIAL' : 'AVAILABLE';
      return { data: { ...responseMeta(result, context, options.domain), status: result.status,
        item, historyAvailability } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const run = async (req, options) => {
    try { return { context: await contextFor(req, options), error: null }; }
    catch (error) { return { context: null, error: safeError(error) }; }
  };
  const revision = async req => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared;
    try {
      const row = await getModels().V3OperationalRevision.findById(context.authenticated.businessId)
        .select('revision bootstrapStatus historicalDatasetVersion historicalDatasetSha256')
        .read('primary').readConcern('majority').setOptions({ useBigInt64: true }).lean().maxTimeMS(3000);
      if (!row || row.bootstrapStatus !== 'VERIFIED' || row.historicalDatasetVersion !== V3.datasetVersion
        || row.historicalDatasetSha256 !== V3.datasetSha256 || typeof row.revision !== 'bigint' || row.revision < 0n) {
        return { error: safeError({ functionalCode: 'SNAPSHOT_BOOTSTRAP_REQUIRED' }) };
      }
      return { data: { businessId: context.authenticated.businessId, scenarioId: V3.scenarioId,
        datasetVersion: V3.datasetVersion, asOf: context.binding.operationalDate, dataVersion: String(row.revision) } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const summary = async req => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, today = context.asOf;
    try {
      const [business, inventory, suppliers] = await Promise.all([
        execute(context, 'get_business_analytics', { mode: 'summary', startDate: today, endDate: today }),
        executeInventoryHealth(context, 'get_inventory_intelligence', { mode: 'summary' }),
        execute(context, 'get_supplier_intelligence', { mode: 'summary', startDate: V3.earliestDate, endDate: today }),
      ]);
      const kpis = business.data?.kpis || {}, inv = inventory.data?.summary || {};
      const pendingPurchasesCount = finiteOrNull(suppliers.data?.summary?.pendingOrders);
      const marginAvailable = Number.isFinite(kpis.grossMarginCents) && Number.isFinite(kpis.grossMarginPct);
      const freshness = business.data?.freshness || inventory.data?.freshness || null;
      return { data: {
        asOf: today, timezone: V3.timezone,
        mode: business.metadata.dataMode,
        updatedAt: business.metadata.updatedAt || inventory.metadata.updatedAt || null,
        dataThrough: business.metadata.dataThrough || inventory.metadata.dataThrough || null,
        salesToday: Number.isFinite(kpis.revenueCents) ? { value: kpis.revenueCents / 100, currency: 'PEN' } : null,
        unitsToday: Number.isFinite(kpis.unitsSold) ? kpis.unitsSold : null,
        ticketsToday: Number.isFinite(kpis.ticketCount) ? kpis.ticketCount : null,
        averageTicket: Number.isFinite(kpis.averageTicket) ? { value: kpis.averageTicket, currency: 'PEN' } : null,
        grossMargin: marginAvailable ? { value: kpis.grossMarginCents / 100, currency: 'PEN', percent: kpis.grossMarginPct,
          availability: business.status === 'PARTIAL' ? 'PARTIAL' : 'AVAILABLE' }
          : { value: null, currency: null, percent: null, availability: business.status === 'PARTIAL' ? 'PARTIAL' : 'UNAVAILABLE' },
        inventory: {
          totalProducts: finiteOrNull(inv.products), riskCounts: { critical: finiteOrNull(inv.critical), high: finiteOrNull(inv.high),
            medium: finiteOrNull(inv.medium), low: finiteOrNull(inv.low) },
          reorderCount: finiteOrNull(inv.shouldReorder), lowStockCount: finiteOrNull(inv.lowStock),
          overstockCount: finiteOrNull(inv.overstock), pendingPurchasesCount,
        },
        availability: { sales: business.status, inventory: inventory.status, suppliers: suppliers.status,
          freshness: freshness?.status || (business.metadata.dataMode === 'LIVE' ? 'LIVE' : 'HISTORICAL') },
      } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const inventory = async req => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, limit = parseLimit(req.query?.limit);
    if (!limit) return { error: { code: 'INVALID_REQUEST', httpStatus: 400, message: 'El límite debe estar entre 1 y 20.' } };
    const allowedFlags = ['low_stock', 'overstock', 'slow_moving', 'dead_stock', 'single_source', 'should_reorder'];
    const flag = req.query?.flag ? String(req.query.flag) : null;
    if (flag && !allowedFlags.includes(flag)) return { error: invalidRequestError() };
    try {
      const [summaryResult, rowsResult] = await Promise.all([
        executeInventoryHealth(context, 'get_inventory_intelligence', { mode: 'summary' }),
        flag ? executeInventoryHealth(context, 'get_inventory_intelligence', { mode: 'summary', flag, limit })
          : executeInventoryHealth(context, 'get_inventory_intelligence', { mode: 'rank', metric: 'stockout_risk', limit }),
      ]);
      const summary = summaryResult.data?.summary || {};
      const rankedItems = rowsResult.data?.items || [];
      const catalog = await loadCatalogProducts(context.authenticated.businessId, rankedItems.map(row => row.sku), 'name presentation');
      return { data: { ...responseMeta(rowsResult, context, 'inventory'),
        summary: { totalProducts: finiteOrNull(summary.products), riskCounts: { critical: finiteOrNull(summary.critical),
          high: finiteOrNull(summary.high), medium: finiteOrNull(summary.medium), low: finiteOrNull(summary.low) },
          reorderCount: finiteOrNull(summary.shouldReorder), lowStockCount: finiteOrNull(summary.lowStock),
          overstockCount: finiteOrNull(summary.overstock), slowMovingCount: finiteOrNull(summary.slowMoving),
          deadStockCount: finiteOrNull(summary.deadStock), incomingUnits: finiteOrNull(summary.incomingUnits),
          riskCountsStatus: summary.riskCountsStatus || null,
          riskUnavailableCount: finiteOrNull(summary.riskUnavailableCount),
          recommendationUnavailableCount: finiteOrNull(summary.recommendationUnavailableCount),
          forecastAvailability: summary.forecastAvailability || null,
          modelVersion7: finiteOrNull(summary.modelVersion7), modelVersion14: finiteOrNull(summary.modelVersion14),
          abcCounts: summaryResult.data?.abcCounts || null, xyzCounts: summaryResult.data?.xyzCounts || null,
          abcXyzCounts: summaryResult.data?.abcXyzCounts || null },
        availabilityStatus: summaryResult.data?.availabilityStatus || summaryResult.status,
        reasonCode: summaryResult.data?.reasonCode || null,
        fieldAvailability: summaryResult.data?.fieldAvailability || null,
        unavailableCount: finiteOrNull(summaryResult.data?.unavailableCount), flag,
        items: rankedItems.map(row => {
          const catalogProduct = catalog.get(row.sku);
          return { sku: row.sku, productName: catalogProduct?.name || row.productName || row.sku,
            presentation: catalogProduct?.presentation || null, stock: finiteOrNull(row.stock?.onHand),
            coverageDays: finiteOrNull(row.coverage?.daysCover), risk: row.risk?.level || null,
            riskReasonCodes: row.risk?.reasonCodes || [], recommendedQty: finiteOrNull(row.recommendation?.recommendedQty),
            reorderNow: row.recommendation?.shouldReorder ?? null,
            availabilityStatus: row.status || null,
            coverageStatus: row.coverage?.status || null,
            coverageReasonCode: row.coverage?.reasonCode || null,
            riskStatus: row.risk?.status || null, riskReasonCode: row.risk?.reasonCode || null,
            recommendationStatus: row.recommendation?.status || null,
            recommendationReasonCode: row.recommendation?.reasonCode || null };
        }), total: rowsResult.data?.total ?? 0 } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const activeForecastModels = async req => {
    const prepared = await run(req);
    if (prepared.error) return { error: prepared.error };
    const { context } = prepared;
    try {
      const registered = await Promise.all([7, 14].map(horizonDays => registry.getActiveModelMetadata({
        businessId: context.authenticated.businessId, scenarioId: V3.scenarioId, horizonDays,
      })));
      return { data: { models: [
        { horizonDays: 1, status: 'MODEL_NOT_APPROVED', activeModelStatus: 'NOT_APPROVED',
          reasonCode: 'PROMOTION_POLICY_FAILED', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27' },
        ...registered.map((metadata, index) => publicForecastModelMetadata(metadata, [7, 14][index])),
      ] } };
    } catch (error) { return { error: safeError(error) }; }
  };
  const product = async (req, type) => {
    const horizon = req.query?.horizonDays === undefined ? 7 : Number(req.query.horizonDays);
    if (type === 'forecast' && ![1, 7, 14].includes(horizon)) {
      return { error: { code: 'UNSUPPORTED_HORIZON', httpStatus: 400, message: 'Solo están disponibles los horizontes de 1, 7 y 14 días.' } };
    }
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, sku = String(req.params?.sku || '').trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(sku)) return { error: { code: 'INVALID_REQUEST', httpStatus: 400, message: 'El SKU no es válido.' } };
    try {
      const catalogProduct = await getModels().Product.findOne({ businessId: context.authenticated.businessId,
        scenarioId: V3.scenarioId, isActive: true, sku }).select('name presentation brand sizeValue sizeUnit')
        .lean().maxTimeMS(3000);
      if (!catalogProduct) { const error = new Error('Product not found'); error.functionalCode = 'PRODUCT_NOT_FOUND';
        return { error: safeError(error) }; }
      const isLiveRidge = type === 'forecast' && context.asOf > V3.historicalCutoff;
      let trustedForecastModelEnvelope;
      if (isLiveRidge && horizon !== 1) {
        try {
          const active = await registry.getActiveModelArtifact({ businessId: context.authenticated.businessId,
            scenarioId: V3.scenarioId, horizonDays: horizon });
          trustedForecastModelEnvelope = active ? trustedForecastEnvelope(active, {
            businessId: context.authenticated.businessId, scenarioId: V3.scenarioId, horizonDays: horizon,
          }) : null;
        } catch (error) { return { error: safeError(error) }; }
      }
      const args = type === 'forecast'
        ? { mode: 'detail', productRef: sku, horizonDays: horizon, includeObservedSeries: true }
        : { mode: 'detail', productRef: sku };
      const result = await execute(context, type === 'forecast' ? 'get_product_forecast' : 'get_inventory_intelligence', args, 20,
        isLiveRidge ? { trustedForecastModelEnvelope, useLiveRidge: true } : {});
      if (result.status === 'NO_DATA' || !result.data?.items?.length) {
        if (isLiveRidge) return { data: emptyLiveRidgeResponse(context, productIdentityFor(catalogProduct, sku), horizon,
          result.metadata || {}) };
        return { data: { status: 'NOT_AVAILABLE', asOf: context.asOf, timezone: V3.timezone,
          mode: result.metadata?.dataMode || null, reason: 'INSUFFICIENT_HISTORY', product: { sku } } };
      }
      const row = result.data.items[0];
      const productIdentity = productIdentityFor(catalogProduct, sku, row);
      if (type === 'forecast' && isLiveRidge) return { data: liveRidgeResponse(row, context, productIdentity, horizon, result.metadata || {}) };
      if (type === 'forecast') return { data: { status: row.status === 'READY' ? 'READY' : row.status,
        asOf: context.asOf, timezone: V3.timezone, mode: result.metadata.dataMode,
        updatedAt: result.metadata.updatedAt || null, dataThrough: result.metadata.dataThrough || null,
        product: productIdentity,
        method: 'MOVING_AVERAGE_28', observationCutoff: row.observationsThrough || row.cutoffDate || null,
        horizons: { '1d': finiteOrNull(row.expectedUnitsNext1d), '7d': finiteOrNull(row.expectedUnitsNext7d),
          '14d': finiteOrNull(row.expectedUnitsNext14d) }, observedSeries: row.observedSeries || [],
        forecastPeriod: { startDate: row.forecastStartDate || null, selectedHorizonDays: horizon,
          units: finiteOrNull(row[`expectedUnitsNext${horizon}d`]) } } };
      return { data: { status: result.status, availability: result.data?.availabilityStatus || result.data?.fieldAvailability || result.status,
        asOf: context.asOf, timezone: V3.timezone,
        mode: result.metadata.dataMode, updatedAt: result.metadata.updatedAt || null, dataThrough: result.metadata.dataThrough || null,
        freshness: result.data?.freshness || { mode: result.metadata.dataMode,
          updatedAt: result.metadata.updatedAt || null, dataThrough: result.metadata.dataThrough || null },
        product: productIdentity,
        stock: { onHand: finiteOrNull(row.stock?.onHand), incoming: finiteOrNull(row.stock?.incoming),
          inventoryPosition: finiteOrNull(row.stock?.inventoryPosition) },
        demand: { expectedDaily: finiteOrNull(row.demand?.expectedDaily), expectedUnitsNext1d: finiteOrNull(row.demand?.expectedUnitsNext1d),
          expectedUnitsNext7d: finiteOrNull(row.demand?.expectedUnitsNext7d), expectedUnitsNext14d: finiteOrNull(row.demand?.expectedUnitsNext14d) },
        fieldAvailability: row.availabilityStatus || result.data?.fieldAvailability || null,
        coverage: { daysCover: finiteOrNull(row.coverage?.daysCover), status: row.coverage?.status || null,
          availabilityStatus: row.coverage?.availabilityStatus || null, reasonCode: row.coverage?.reasonCode || null },
        inventoryPolicy: { safetyStock: finiteOrNull(row.inventoryPolicy?.safetyStock), reorderPoint: finiteOrNull(row.inventoryPolicy?.reorderPoint),
          status: row.inventoryPolicy?.status || null, reasonCode: row.inventoryPolicy?.reasonCode || null,
          safetyStockStatus: row.inventoryPolicy?.safetyStockStatus || null, reorderStatus: row.inventoryPolicy?.reorderStatus || null },
        recommendation: { reorderNow: row.recommendation?.shouldReorder ?? null,
          preventiveRecommendation: null,
          recommendedQty: finiteOrNull(row.recommendation?.recommendedQty), status: row.recommendation?.status || null,
          availabilityStatus: row.recommendation?.availabilityStatus || null,
          reasonCode: row.recommendation?.reasonCode || null },
        risk: { level: row.risk?.level || null, reasonCodes: row.risk?.reasonCodes || [], status: row.risk?.status || null,
          availabilityStatus: row.risk?.availabilityStatus || null, reasonCode: row.risk?.reasonCode || null },
        classification: { abc: row.classification?.abc || null, xyz: row.classification?.xyz || null } } };
    } catch (error) {
      if (type === 'forecast' && error?.functionalCode === 'INSUFFICIENT_HISTORY') return { data: {
        status: 'INSUFFICIENT_HISTORY', asOf: context.asOf, timezone: V3.timezone,
        mode: context.asOf <= V3.historicalCutoff ? 'HISTORICAL' : 'LIVE',
        product: { sku }, method: 'MOVING_AVERAGE_28', observationCutoff: null,
        horizons: { '1d': null, '7d': null, '14d': null }, observedSeries: [], forecastPeriod: null,
      } };
      return { error: safeError(error) };
    }
  };
  const forecastEvaluation = async req => {
    const prepared = await run(req, { frozen: true });
    if (prepared.error) return { error: prepared.error };
    try { return { data: await service.forecastEvaluation(prepared.context.authenticated,
      { signal: new AbortController().signal }) }; }
    catch (error) { return { error: safeError(error) }; }
  };
  const customerClustering = async req => {
    const prepared = await run(req, { frozen: true });
    if (prepared.error) return { error: prepared.error };
    const customerRef = req.query?.customerRef;
    if (customerRef !== undefined && (typeof customerRef !== 'string' || !customerRef.trim() || customerRef.length > 160)) {
      return { error: { code: 'INVALID_REQUEST', httpStatus: 400, message: 'La referencia del cliente no es válida.' } };
    }
    try { return { data: await service.customerClustering(prepared.context.authenticated,
      { signal: new AbortController().signal, customerRef }) }; }
    catch (error) { return { error: safeError(error) }; }
  };
  const salesAnomalies = async req => {
    const prepared = await run(req, { frozen: true });
    if (prepared.error) return { error: prepared.error };
    const startDate = req.query?.startDate || V3.earliestDate;
    const endDate = req.query?.endDate || V3.historicalCutoff;
    const limit = parseLimit(req.query?.limit);
    if (!validDate(startDate) || !validDate(endDate) || startDate < V3.earliestDate || startDate > endDate
      || endDate > V3.historicalCutoff) return { error: invalidPeriodError() };
    if (!limit) return { error: invalidLimitError() };
    try { return { data: await service.salesAnomalies(prepared.context.authenticated,
      { signal: new AbortController().signal, startDate, endDate, limit }) }; }
    catch (error) { return { error: safeError(error) }; }
  };
  return Object.freeze({ revision, summary, inventory, sales, customers, customer, suppliers, supplier, associations, productRelated, health, forecastEvaluation, activeForecastModels, customerClustering, salesAnomalies,
    forecast: req => product(req, 'forecast'), productInventory: req => product(req, 'inventory') });
};

const finiteOrNull = value => Number.isFinite(value) ? value : null;
function productIdentityFor(catalogProduct, sku, row = {}) {
  return { sku, name: catalogProduct.name || row.productName || row.name || sku,
    presentation: catalogProduct.presentation || null, brand: catalogProduct.brand || null,
    size: catalogProduct.sizeValue == null ? null : { value: catalogProduct.sizeValue, unit: catalogProduct.sizeUnit || null } };
}
function publicForecastModelMetadata(metadata, horizonDays) {
  if (!metadata || metadata.status !== 'ACTIVE') return { horizonDays, status: 'MODEL_UNAVAILABLE',
    activeModelStatus: 'NONE', reasonCode: 'ACTIVE_MODEL_NOT_FOUND', modelFamily: null, recipeId: null,
    modelVersion: null, trainedAt: null, trainedDataVersion: null, dataCutoff: null,
    featureVersion: null, promotionPolicyVersion: null };
  return { horizonDays, status: 'ACTIVE', activeModelStatus: 'ACTIVE', modelFamily: metadata.modelFamily,
    recipeId: metadata.recipeId, modelVersion: metadata.modelVersion,
    trainedAt: metadata.trainedAt instanceof Date ? metadata.trainedAt.toISOString() : metadata.trainedAt || null,
    trainedDataVersion: metadata.trainedDataVersion, dataCutoff: metadata.dataCutoff,
    featureVersion: metadata.featureVersion, promotionPolicyVersion: metadata.promotionPolicyVersion,
    metrics: { wape: finiteOrNull(metadata.globalWape), mae: finiteOrNull(metadata.globalMae),
      bias: finiteOrNull(metadata.globalBias) } };
}
function trustedForecastEnvelope(active, scope) {
  const metadata = active?.metadata, bytes = active?.artifactData;
  if (!metadata || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 262_144
      || metadata.status !== 'ACTIVE' || metadata.businessId !== scope.businessId
      || metadata.scenarioId !== scope.scenarioId || metadata.horizonDays !== scope.horizonDays) {
    const error = new Error('Active model artifact does not match the requested scope.');
    error.functionalCode = 'ARTIFACT_UNAVAILABLE'; throw error;
  }
  const fields = ['businessId', 'scenarioId', 'horizonDays', 'modelFamily', 'recipeId', 'modelVersion',
    'status', 'trainedAt', 'trainedDataVersion', 'dataCutoff', 'featureVersion', 'featureHash',
    'promotionPolicyVersion', 'promotionPolicyHash', 'artifactHash', 'artifactBytes'];
  return { metadata: Object.fromEntries(fields.map(key => [key,
    metadata[key] instanceof Date ? metadata[key].toISOString() : metadata[key]])),
    artifactDataBase64: bytes.toString('base64') };
}
function liveRidgeResponse(row, context, product, horizonDays, metadata) {
  const trainedDataVersion = typeof row.trainedDataVersion === 'string' ? row.trainedDataVersion : null;
  const dataVersion = typeof row.dataVersion === 'string' ? row.dataVersion : metadata.dataVersion || null;
  const isTrainingPending = dataVersion && trainedDataVersion
    ? decimalVersionGreater(dataVersion, trainedDataVersion) : null;
  const prediction = row.status === 'READY' ? finiteOrNull(row.predictionUnits) : null;
  return { status: row.status, reasonCode: row.reasonCode || null, horizonDays,
    predictionUnits: prediction, targetDefinition: row.targetDefinition || null,
    forecastStartDate: row.forecastStartDate || null, forecastEndDate: row.forecastEndDate || null,
    observationsThrough: row.observationsThrough || null, modelFamily: row.modelFamily || null,
    recipeId: row.recipeId || null, modelVersion: Number.isSafeInteger(row.modelVersion) ? row.modelVersion : null,
    trainedAt: row.trainedAt || null, trainedDataVersion, dataCutoff: row.dataCutoff || null,
    featureVersion: row.featureVersion || null, promotionPolicyVersion: row.promotionPolicyVersion || null,
    activeModelStatus: row.activeModelStatus || 'NONE', dataVersion,
    snapshotHash: typeof row.snapshotHash === 'string' ? row.snapshotHash : metadata.snapshotHash || null,
    isTrainingPending, baselineUnits: finiteOrNull(row.baselineUnits),
    statusAvailability: row.status === 'READY' ? 'AVAILABLE' : row.status,
    asOf: context.asOf, timezone: V3.timezone, mode: 'LIVE', updatedAt: metadata.updatedAt || null,
    dataThrough: metadata.dataThrough || null, product,
    method: row.modelFamily || null, observationCutoff: row.observationsThrough || null,
    horizons: { '1d': horizonDays === 1 ? prediction : null, '7d': horizonDays === 7 ? prediction : null,
      '14d': horizonDays === 14 ? prediction : null },
    observedSeries: Array.isArray(row.observedSeries) ? row.observedSeries : [],
    forecastPeriod: { startDate: row.forecastStartDate || null, selectedHorizonDays: horizonDays, units: prediction } };
}
function emptyLiveRidgeResponse(context, product, horizonDays, metadata) {
  return liveRidgeResponse({ status: 'MODEL_UNAVAILABLE', reasonCode: 'FORECAST_RESULT_MISSING',
    dataVersion: metadata.dataVersion, snapshotHash: metadata.snapshotHash }, context, product, horizonDays, metadata);
}
function decimalVersionGreater(left, right) {
  if (!/^(0|[1-9]\d*)$/.test(left) || !/^(0|[1-9]\d*)$/.test(right)) return null;
  return left.length !== right.length ? left.length > right.length : left > right;
}
const parseLimit = value => value === undefined ? 20 : /^\d{1,2}$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 20 ? Number(value) : null;
const parseOffset = value => value === undefined ? 0 : /^\d{1,5}$/.test(String(value)) && Number(value) <= 10000 ? Number(value) : null;
const addDays = (value, amount) => { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };
const daysBetween = (start, end) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
const invalidPeriodError = () => ({ code: 'INVALID_PERIOD', httpStatus: 400, message: 'El período solicitado no es válido.' });
const invalidRequestError = () => ({ code: 'INVALID_REQUEST', httpStatus: 400, message: 'Los filtros solicitados no son válidos.' });
const invalidLimitError = (message = 'El límite o desplazamiento solicitado no es válido.') => ({ code: 'INVALID_REQUEST', httpStatus: 400, message });
const moneyFromCents = cents => Number.isFinite(cents) ? { value: cents / 100, currency: 'PEN' } : null;
const customerRow = row => ({ customerId: row.customerCode || null, displayName: row.displayName || null,
  segment: row.segment || null, recency: finiteOrNull(row.rfm90d?.raw?.recencyDays ?? row.recencyDays),
  frequency: finiteOrNull(row.rfm90d?.raw?.frequency90d ?? row.ticketCount),
  monetary: moneyFromCents(row.rfm90d?.raw?.monetary90dCents ?? row.totalSpentCents),
  spend: moneyFromCents(row.totalSpentCents), lifetimeTicketCount: finiteOrNull(row.ticketCount), rfm90d: row.rfm90d || null,
  averageTicket: moneyFromCents(Number.isFinite(row.averageTicketCents) ? Math.round(row.averageTicketCents) : null),
  lastPurchaseDate: row.lastPurchaseDate || null, firstPurchaseDate: row.firstPurchaseDate || null,
  reasonCodes: Array.isArray(row.reasonCodes) ? row.reasonCodes : [], preferences: row.preferences || null,
  trends: row.trends30d || null, windows: row.windows || null, freshness: row.freshness || null });
const supplierRow = row => ({ supplierId: row.supplierCode || null, name: row.displayName || null,
  orders: finiteOrNull(row.purchaseOrderCount), spend: moneyFromCents(row.receivedSpendCents), pending: finiteOrNull(row.pendingOrderCount),
  received: finiteOrNull(row.receivedOrderCount), leadTime: row.leadTime || null, punctuality: row.punctuality || null,
  leadTimeAvailability: Number.isFinite(row.leadTime?.averageDays) && Number.isFinite(row.leadTime?.sampleSize) && row.leadTime.sampleSize > 0
    ? 'AVAILABLE' : 'INSUFFICIENT_HISTORY',
  dependency: { exclusiveOfferedSkuCount: finiteOrNull(row.exclusiveOfferedSkuCount),
    offeredSkuCount: finiteOrNull(row.offeredSkuCount), spendSharePct: finiteOrNull(row.purchaseSpendSharePct) },
  products: Array.isArray(row.productsSupplied) ? row.productsSupplied : [], status: row.status || 'AVAILABLE' });
const ruleRow = row => ({ antecedent: row.antecedentSkus || row.antecedentCodes || [],
  antecedentProducts: row.antecedentProducts || [], consequent: row.consequentSkus || row.consequentCodes || [],
  consequentProducts: row.consequentProducts || [], support: finiteOrNull(row.support),
  confidence: finiteOrNull(row.confidence), lift: finiteOrNull(row.lift), ticketCount: finiteOrNull(row.ticketCount),
  stability: row.stability?.status || row.stability || null, status: row.status || row.classification || null });
const domainStatus = section => section.status || (section.freshness?.status === 'AVAILABLE' ? 'AVAILABLE'
  : section.freshness?.status || (section.available === false ? 'UNAVAILABLE' : 'AVAILABLE'));
const stripAlerts = section => Object.fromEntries(Object.entries(section).filter(([key]) => !['alerts', 'freshness', 'status'].includes(key)));
module.exports = { createV3BusinessIntelligenceDashboard, validDate, safeError };
