const { AgentError } = require('./contracts');
const { performance } = require('node:perf_hooks');

const escapeLiteral = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const productFields = { _id: 1, sku: 1, name: 1, category: 1, stock: 1, minStockLevel: 1 };
const productDto = row => ({
  id: String(row._id), sku: row.sku ?? null, name: row.name, category: row.category,
  stock: row.stock, minStockLevel: row.minStockLevel ?? 0
});
// Date arguments are inclusive UTC calendar days, including the entire end day.
const dateFilter = args => args.startDate ? {
  $gte: new Date(`${args.startDate}T00:00:00.000Z`),
  $lt: new Date(new Date(`${args.endDate}T00:00:00.000Z`).getTime() + 86400000)
} : undefined;
const listResult = (data, totalMatches, metadata = {}) => ({
  status: data.length ? 'READY' : 'NO_DATA', data,
  metadata: { ...metadata, totalMatches, returnedCount: data.length, truncated: totalMatches > data.length }
});

/** Trusted dependency injection for tests; arguments never select a model or query.
 * Each execution owns this factory, so forecast promises are only shared within
 * one authenticated request. Failed/timed-out calls are not cached globally.
 */
const createSkillExecutors = ({ models, forecastService, clock = () => new Date(), toObjectId } = {}) => {
  let readModels = models;
  let forecast = forecastService;
  const forecastPromises = new Map();
  const getModels = () => readModels ||= require('../models');
  const objectId = value => toObjectId ? toObjectId(value) : new (require('mongoose').Types.ObjectId)(value);
  const asOf = () => clock().toISOString();
  const aggregate = (model, pipeline, invocation) => {
    invocation.signal.throwIfAborted();
    // Bound server-side work as well as the request-level wall-clock deadline.
    return model.aggregate(pipeline).option({ maxTimeMS: invocation.skill.timeoutMs }).exec();
  };
  const paged = async (model, stages, projection, sort, invocation) => {
    const rows = await aggregate(model, [...stages, { $facet: {
      data: [{ $sort: sort }, { $limit: invocation.args.limit ?? invocation.skill.maxRecords }, { $project: projection }],
      count: [{ $count: 'total' }]
    } }], invocation);
    return { rows: rows[0]?.data || [], total: rows[0]?.count[0]?.total || 0 };
  };
  const financialRows = async (match, invocation) => aggregate(getModels().Transaction, [
    { $match: match },
    { $group: { _id: { type: '$type', currency: '$currency' }, count: { $sum: 1 },
      amount: { $sum: '$totalAmount' },
      units: { $sum: { $sum: '$products.quantity' } } } },
    { $sort: { '_id.type': 1, '_id.currency': 1 } }
  ], invocation);
  // Native transaction currencies stay separate. No FX conversion or profit claim.
  const financialDto = (rows, type) => {
    const selected = rows.filter(row => row._id.type === type);
    return {
      completedTransactionsCount: selected.reduce((sum, row) => sum + row.count, 0),
      totalUnits: selected.reduce((sum, row) => sum + row.units, 0),
      amountsByCurrency: selected.map(row => ({ currency: row._id.currency, amount: row.amount,
        label: type === 'sale' ? 'Ventas completadas' : 'Compras completadas' }))
    };
  };
  const readForecast = async invocation => {
    invocation.signal.throwIfAborted();
    const { args, context } = invocation;
    const key = `${context.businessId}\0${args.productId || 'batch'}`;
    if (!forecastPromises.has(key)) {
      forecast ||= require('../services/demandForecastService').createDemandForecastService();
      const pending = Promise.resolve().then(() => forecast.getDemandForecast({
        businessId: context.businessId, ...(args.productId ? { productId: args.productId } : {})
      }));
      forecastPromises.set(key, pending);
      pending.catch(() => forecastPromises.delete(key));
    }
    let result;
    const mlCallStartedAt = performance.now();
    try { result = await forecastPromises.get(key); } catch (error) {
      const mlCallDurationMs = performance.now() - mlCallStartedAt;
      if (error.code === 'PRODUCT_NOT_FOUND') throw new AgentError('AGENT_RESOURCE_NOT_FOUND');
      if (error.code === 'ML_NOT_READY') return { status: 'ML_NOT_READY' };
      if (error.code === 'AGENT_SKILL_TIMEOUT') {
        const safeError = new AgentError('AGENT_SKILL_TIMEOUT');
        safeError.diagnostic = Object.freeze({ internalCause: 'AGENT_SKILL_TIMEOUT', mlCallDurationMs });
        throw safeError;
      }
      const internalCause = error.code === 'ML_SERVICE_UNAVAILABLE' ? 'ML_SERVICE_UNAVAILABLE' : 'AGENT_EXECUTION_ERROR';
      const safeError = new AgentError(internalCause === 'ML_SERVICE_UNAVAILABLE'
        ? 'ML_SERVICE_UNAVAILABLE' : 'AGENT_SKILL_EXECUTION_FAILED');
      safeError.diagnostic = Object.freeze({ internalCause, mlCallDurationMs });
      throw safeError;
    }
    return result;
  };
  const forecastResult = (result, invocation, candidates = false) => {
    if (result.status === 'ML_NOT_READY') return {
      status: 'ML_NOT_READY', data: [], metadata: {
        asOf: asOf(), returnedCount: 0, totalMatches: 0, truncated: false,
        reason: 'Historial o configuración insuficiente para el replay ML'
      }
    };
    if (result.status !== 'READY' || !Array.isArray(result.products)
      || result.products.length > 60) throw new AgentError('AGENT_SKILL_EXECUTION_FAILED');
    const mapped = result.products.map(row => ({
      productId: row.productId, sku: row.sku, name: row.name, mlStatus: row.mlStatus,
      category: row.category ?? null, department: row.department ?? null,
      predictedDemand7d: row.mlStatus === 'READY' ? row.predictedDemand7d : null,
      stockAtAnchor: row.stockAtAnchor, salesLast7Days: row.salesLast7Days,
      safetyStock: row.mlStatus === 'READY' ? row.safetyStock : null,
      recommendedQty: row.mlStatus === 'READY' ? row.recommendedQty : null,
      inventoryStatus: row.inventoryStatus, anchor: result.anchorOperationalDate
    }));
    const selected = candidates ? mapped.filter(row => row.mlStatus === 'READY' && row.recommendedQty > 0)
      .sort((a, b) => b.recommendedQty - a.recommendedQty || a.productId.localeCompare(b.productId)) : mapped;
    const limit = invocation.args.limit ?? invocation.skill.maxRecords;
    return listResult(selected.slice(0, limit), selected.length, {
      asOf: result.anchorOperationalDate, anchor: result.anchorOperationalDate,
      interpretation: 'historical_replay',
      model: result.model ? { name: result.model.name, version: result.model.version,
        horizonDays: result.model.horizonDays } : undefined
    });
  };

  return Object.freeze({
    async search_products(invocation) {
      const { args, context } = invocation;
      const literal = new RegExp(escapeLiteral(args.query.trim()), 'i');
      const match = { businessId: context.businessId, isActive: true, $or: [{ name: literal }, { sku: literal }] };
      if (args.category) match.category = args.category.trim();
      const result = await paged(getModels().Product, [{ $match: match }], productFields, { name: 1, _id: 1 }, invocation);
      return listResult(result.rows.map(productDto), result.total, { asOf: asOf() });
    },
    async get_product_details(invocation) {
      const { args, context, signal, skill } = invocation;
      signal.throwIfAborted();
      const row = await getModels().Product.findOne({ businessId: context.businessId,
        ...(args.productId ? { _id: objectId(args.productId) } : { sku: args.sku.trim() }) })
        .select({ ...productFields, price: 1, currency: 1, isActive: 1 }).maxTimeMS(skill.timeoutMs).lean().exec();
      if (!row) throw new AgentError('AGENT_RESOURCE_NOT_FOUND');
      return { status: 'READY', data: { ...productDto(row), price: row.price, currency: row.currency, isActive: row.isActive },
        metadata: { asOf: asOf(), returnedCount: 1 } };
    },
    async get_low_stock_products(invocation) {
      const result = await paged(getModels().Product, [
        { $match: { businessId: invocation.context.businessId, isActive: true,
          $expr: { $lte: ['$stock', { $ifNull: ['$minStockLevel', 0] }] } } },
        { $set: { shortage: { $subtract: [{ $ifNull: ['$minStockLevel', 0] }, '$stock'] } } }
      ], { ...productFields, shortage: 1 }, { shortage: -1, _id: 1 }, invocation);
      return listResult(result.rows.map(row => ({ ...productDto(row), shortage: row.shortage })), result.total, { asOf: asOf() });
    },
    async get_recent_transactions(invocation) {
      const { args, context } = invocation;
      const match = { businessId: context.businessId };
      for (const key of ['type', 'status']) if (args[key]) match[key] = args[key];
      if (args.startDate) match.date = dateFilter(args);
      const result = await paged(getModels().Transaction, [{ $match: match }], {
        _id: 1, type: 1, status: 1, date: 1, totalAmount: 1, currency: 1,
        itemCount: { $size: '$products' }
      }, { date: -1, _id: -1 }, invocation);
      return listResult(result.rows.map(row => ({ id: String(row._id), type: row.type, status: row.status,
        date: row.date.toISOString(), total: row.totalAmount, currency: row.currency, itemCount: row.itemCount })),
      result.total, { asOf: asOf(), ...(args.startDate ? { period: { startDate: args.startDate, endDate: args.endDate } } : {}) });
    },
    async get_sales_summary(invocation) {
      const rows = await financialRows({ businessId: invocation.context.businessId, type: 'sale', status: 'completed',
        date: dateFilter(invocation.args) }, invocation);
      const totals = financialDto(rows, 'sale');
      return { status: totals.completedTransactionsCount ? 'READY' : 'NO_DATA', data: {
        completedSalesCount: totals.completedTransactionsCount, totalUnitsSold: totals.totalUnits,
        amountsByCurrency: totals.amountsByCurrency
      }, metadata: { asOf: asOf(), period: { startDate: invocation.args.startDate, endDate: invocation.args.endDate },
        amountBasis: 'transaction_total_native_currency', returnedCount: 1 } };
    },
    async get_top_selling_products(invocation) {
      const models = getModels();
      const hasPeriod = Boolean(invocation.args.startDate);
      const limit = invocation.args.limit ?? invocation.skill.maxRecords;
      const rows = await aggregate(models.Transaction, [
        { $match: { businessId: invocation.context.businessId, type: 'sale', status: 'completed',
          ...(hasPeriod ? { date: dateFilter(invocation.args) } : {}) } },
        { $facet: {
          ranking: [{ $unwind: '$products' },
            { $group: { _id: '$products.productId', unitsSold: { $sum: '$products.quantity' }, historicalName: { $first: '$products.productName' } } },
            { $sort: { unitsSold: -1, _id: 1 } },
            { $limit: limit }, { $project: { _id: 1, unitsSold: 1, historicalName: 1 } }],
          totalProducts: [{ $unwind: '$products' },
            { $group: { _id: '$products.productId' } }, { $count: 'total' }],
          dateRange: [{ $group: { _id: null, minDate: { $min: '$date' }, maxDate: { $max: '$date' } } }]
        } }
      ], invocation);
      const ranking = rows[0]?.ranking || [];
      const dateRange = rows[0]?.dateRange?.[0];
      const totalMatches = rows[0]?.totalProducts?.[0]?.total || 0;
      // One bounded lookup for the top-N, including inactive historical products.
      invocation.signal.throwIfAborted();
      const ids = ranking.map(row => row._id);
      const products = ids.length ? await models.Product.find({ businessId: invocation.context.businessId, _id: { $in: ids } })
        .select('_id sku name').limit(invocation.skill.maxRecords).maxTimeMS(invocation.skill.timeoutMs).lean().exec() : [];
      const byId = new Map(products.map(row => [String(row._id), row]));
      const isValidDate = value => value instanceof Date && Number.isFinite(value.getTime());
      const hasDateRange = isValidDate(dateRange?.minDate) && isValidDate(dateRange?.maxDate);
      const periodLabel = hasPeriod ? `${invocation.args.startDate} a ${invocation.args.endDate}`
        : `Todo el historial disponible${hasDateRange
          ? ` (${dateRange.minDate.toISOString().slice(0, 10)} a ${dateRange.maxDate.toISOString().slice(0, 10)})` : ''}`;
      return listResult(ranking.map(row => ({ productId: String(row._id), sku: byId.get(String(row._id))?.sku ?? null,
        name: byId.get(String(row._id))?.name ?? row.historicalName, unitsSold: row.unitsSold })), totalMatches,
      { asOf: asOf(), periodLabel, evidenceLabel: `Productos más vendidos · ${periodLabel}`,
        ...(hasPeriod ? { period: { startDate: invocation.args.startDate, endDate: invocation.args.endDate } } : {}) });
    },
    async get_product_sales_summary(invocation) {
      invocation.signal.throwIfAborted();
      const { args, context, skill } = invocation;
      const product = await getModels().Product.findOne({ businessId: context.businessId,
        ...(args.productId ? { _id: objectId(args.productId) } : { sku: args.sku.trim() }) })
        .select(productFields).maxTimeMS(skill.timeoutMs).lean().exec();
      if (!product) throw new AgentError('AGENT_RESOURCE_NOT_FOUND');
      const rows = await aggregate(getModels().Transaction, [
        { $match: { businessId: context.businessId, type: 'sale', status: 'completed', date: dateFilter(args) } },
        { $unwind: '$products' }, { $match: { 'products.productId': product._id } },
        { $group: { _id: '$currency', units: { $sum: '$products.quantity' }, amount: { $sum: '$products.total' } } }
      ], invocation);
      return { status: rows.length ? 'READY' : 'NO_DATA', data: { product: productDto(product),
        totalUnitsSold: rows.reduce((sum, row) => sum + row.units, 0),
        amountsByCurrency: rows.map(row => ({ currency: row._id, amount: row.amount, label: 'Importe de líneas vendidas' })) },
      metadata: { asOf: asOf(), period: { startDate: args.startDate, endDate: args.endDate },
        amountBasis: 'completed_product_line_total_native_currency', returnedCount: 1 } };
    },
    async get_business_summary(invocation) {
      const { Product, Transaction } = getModels();
      let anchor = clock();
      if (invocation.args.period === 'latest') {
        const latest = await Transaction.findOne({ businessId: invocation.context.businessId, status: 'completed' })
          .select('date').sort({ date: -1, _id: -1 }).maxTimeMS(invocation.skill.timeoutMs).lean().exec();
        if (latest) anchor = latest.date;
      }
      const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
      const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
      const period = { startDate: start.toISOString().slice(0, 10), endDate: new Date(end.getTime() - 86400000).toISOString().slice(0, 10) };
      const [counts, finances] = await Promise.all([
        aggregate(Product, [ { $match: { businessId: invocation.context.businessId, isActive: true } },
          { $group: { _id: null, activeProducts: { $sum: 1 }, lowStockProducts: { $sum: {
            $cond: [{ $lte: ['$stock', { $ifNull: ['$minStockLevel', 0] }] }, 1, 0]
          } } } } ], invocation),
        financialRows({ businessId: invocation.context.businessId, status: 'completed', date: { $gte: start, $lt: end } }, invocation)
      ]);
      return { status: 'READY', data: { activeProducts: counts[0]?.activeProducts || 0,
        lowStockProducts: counts[0]?.lowStockProducts || 0,
        completedTransactionsCount: finances.reduce((sum, row) => sum + row.count, 0),
        sales: financialDto(finances, 'sale'), purchases: financialDto(finances, 'purchase') },
      metadata: { asOf: asOf(), period, periodMode: invocation.args.period ?? 'current',
        amountBasis: 'transaction_total_native_currency', inventoryBasis: 'current_active_products', returnedCount: 1 } };
    },
    async analyze_demand_forecast(invocation) {
      const batch = forecastResult(await readForecast({ ...invocation, args: {} }),
        { ...invocation, args: {}, skill: { ...invocation.skill, maxRecords: 60 } });
      if (batch.status === 'ML_NOT_READY') return batch;
      const configuration = Object.values(require('../config/mlScenarios.json')).find(row => row.businessId === invocation.context.businessId);
      return require('./forecastAnalytics').analyzeForecast(batch, invocation.args, configuration?.scenarioId);
    },
    async get_demand_forecast(invocation) { return forecastResult(await readForecast(invocation), invocation); },
    async get_replenishment_candidates(invocation) { return forecastResult(await readForecast(invocation), invocation, true); }
  });
};

module.exports = { createSkillExecutors };
