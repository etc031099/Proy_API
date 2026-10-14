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
    ['INSUFFICIENT_HISTORY', [200, '']],
    ['UNSUPPORTED_HORIZON', [400, 'El horizonte solicitado no está disponible.']],
    ['INVALID_PERIOD', [400, 'La fecha solicitada no es válida.']],
    ['SCENARIO_NOT_SUPPORTED', [403, 'Este negocio no tiene acceso a la analítica V3.']],
    ['ARTIFACT_UNAVAILABLE', [503, 'La analítica solicitada no está disponible temporalmente.']],
  ]);
  const [httpStatus, message] = known.get(code) || [status, 'No se pudo cargar la analítica del negocio.'];
  return { code, httpStatus, message };
};

const createV3BusinessIntelligenceDashboard = ({ models, intelligenceService, clock = () => new Date() } = {}) => {
  const service = intelligenceService || createV3IntelligenceService({ models, clock });
  const getModels = () => models || require('../models');
  const loadCatalogProducts = async (businessId, skus, fields) => {
    if (!skus.length) return new Map();
    const rows = await getModels().Product.find({ businessId, scenarioId: V3.scenarioId, isActive: true, sku: { $in: skus } })
      .select(fields).lean().maxTimeMS(3000);
    return new Map(rows.map(row => [row.sku, row]));
  };
  const contextFor = async req => {
    const businessId = req.user?.businessId;
    if (!businessId || req.businessId && req.businessId !== businessId) {
      const error = new Error('Tenant context mismatch'); error.functionalCode = 'TENANT_MISMATCH'; throw error;
    }
    const requestId = randomUUID();
    const authenticated = { businessId, requestId, userId: String(req.user?._id || req.user?.id || '') };
    const binding = await service.resolveContext(authenticated);
    if (!binding) { const error = new Error('Scenario not supported'); error.functionalCode = 'SCENARIO_NOT_SUPPORTED'; throw error; }
    const asOf = req.query?.asOf || binding.operationalDate;
    if (!validDate(asOf) || asOf > binding.operationalDate || asOf < V3.earliestDate) {
      const error = new Error('Invalid period'); error.functionalCode = 'INVALID_PERIOD'; throw error;
    }
    return { authenticated, binding, asOf };
  };
  const execute = (context, skillId, args = {}, maxRecords = 20) => service.execute({
    context: context.authenticated,
    skill: { id: skillId, maxRecords },
    args: { ...args, asOfDate: context.asOf },
    signal: new AbortController().signal,
  });
  const run = async req => {
    try { return { context: await contextFor(req), error: null }; }
    catch (error) { return { context: null, error: safeError(error) }; }
  };
  const summary = async req => {
    const prepared = await run(req); if (prepared.error) return { error: prepared.error };
    const { context } = prepared, today = context.asOf;
    try {
      const [business, inventory, suppliers] = await Promise.all([
        execute(context, 'get_business_analytics', { mode: 'summary', startDate: today, endDate: today }),
        execute(context, 'get_inventory_intelligence', { mode: 'summary' }),
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
    try {
      const [summaryResult, rankResult] = await Promise.all([
        execute(context, 'get_inventory_intelligence', { mode: 'summary' }),
        execute(context, 'get_inventory_intelligence', { mode: 'rank', metric: 'stockout_risk', limit }),
      ]);
      const summary = summaryResult.data?.summary || {};
      const rankedItems = rankResult.data?.items || [];
      const catalog = await loadCatalogProducts(context.authenticated.businessId, rankedItems.map(row => row.sku), 'name presentation');
      return { data: { asOf: context.asOf, timezone: V3.timezone, mode: rankResult.metadata.dataMode,
        updatedAt: rankResult.metadata.updatedAt || null, dataThrough: rankResult.metadata.dataThrough || null,
        summary: { totalProducts: finiteOrNull(summary.products), riskCounts: { critical: finiteOrNull(summary.critical),
          high: finiteOrNull(summary.high), medium: finiteOrNull(summary.medium), low: finiteOrNull(summary.low) },
          reorderCount: finiteOrNull(summary.shouldReorder), lowStockCount: finiteOrNull(summary.lowStock),
          overstockCount: finiteOrNull(summary.overstock), incomingUnits: finiteOrNull(summary.incomingUnits) },
        items: rankedItems.map(row => {
          const catalogProduct = catalog.get(row.sku);
          return { sku: row.sku, productName: catalogProduct?.name || row.productName || row.sku,
            presentation: catalogProduct?.presentation || null, stock: finiteOrNull(row.stock?.onHand),
            coverageDays: finiteOrNull(row.coverage?.daysCover), risk: row.risk?.level || null,
            riskReasonCodes: row.risk?.reasonCodes || [], recommendedQty: finiteOrNull(row.recommendation?.recommendedQty),
            reorderNow: row.recommendation?.shouldReorder ?? null };
        }), total: rankResult.data?.total ?? 0 } };
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
      const args = type === 'forecast'
        ? { mode: 'detail', productRef: sku, horizonDays: horizon, includeObservedSeries: true }
        : { mode: 'detail', productRef: sku };
      const result = await execute(context, type === 'forecast' ? 'get_product_forecast' : 'get_inventory_intelligence', args);
      if (result.status === 'NO_DATA' || !result.data?.items?.length) {
        return { data: { status: 'NOT_AVAILABLE', asOf: context.asOf, timezone: V3.timezone,
          mode: result.metadata?.dataMode || null, reason: 'INSUFFICIENT_HISTORY', product: { sku } } };
      }
      const row = result.data.items[0];
      const productIdentity = { sku, name: catalogProduct.name || row.productName || row.name || sku,
        presentation: catalogProduct.presentation || null, brand: catalogProduct.brand || null,
        size: catalogProduct.sizeValue == null ? null : { value: catalogProduct.sizeValue, unit: catalogProduct.sizeUnit || null } };
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
        coverage: { daysCover: finiteOrNull(row.coverage?.daysCover), status: row.coverage?.status || null },
        inventoryPolicy: { safetyStock: finiteOrNull(row.inventoryPolicy?.safetyStock), reorderPoint: finiteOrNull(row.inventoryPolicy?.reorderPoint) },
        recommendation: { reorderNow: row.recommendation?.shouldReorder ?? null,
          preventiveRecommendation: null,
          recommendedQty: finiteOrNull(row.recommendation?.recommendedQty) },
        risk: { level: row.risk?.level || null, reasonCodes: row.risk?.reasonCodes || [] },
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
  return Object.freeze({ summary, inventory, forecast: req => product(req, 'forecast'), productInventory: req => product(req, 'inventory') });
};

const finiteOrNull = value => Number.isFinite(value) ? value : null;
const parseLimit = value => value === undefined ? 20 : /^\d{1,2}$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 20 ? Number(value) : null;
module.exports = { createV3BusinessIntelligenceDashboard, validDate, safeError };
