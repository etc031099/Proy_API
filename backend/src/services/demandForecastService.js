const crypto = require('node:crypto');
const mongoose = require('mongoose');

const {
  HistoricalScenario,
  InventoryMovement,
  Product,
  Transaction
} = require('../models');
const { reconstructStockAt } = require('./inventoryService');
const { createMlServiceClient, MlServiceUnavailableError } = require('./mlServiceClient');

const CLOUD_DEMO_BUSINESS_ID = 'ML-CLOUD-DEMO';
const CLOUD_DEMO_SCENARIO_ID = 'm5-ca3-cloud-demo-v1';
const ANCHOR_OPERATIONAL_DATE = '2025-07-01';
const ANCHOR_STRATEGY = 'latest_eligible_historical_anchor';
const MAX_BATCH_SIZE = 60;
const HORIZON_DAYS = 7;
const DEFAULT_SAFETY_STOCK_RATE = 0.20;

class DemandForecastError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = 'DemandForecastError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const dayKey = value => new Date(value).toISOString().slice(0, 10);

const buildContinuousHistory = ({ startDate, anchorDate, transactions, productIds }) => {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${anchorDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new DemandForecastError('ML_NOT_READY', 'Historical scenario range is invalid', 409);
  }

  const totals = new Map(productIds.map(id => [String(id), new Map()]));
  for (const transaction of transactions) {
    if (
      transaction.type !== 'sale'
      || transaction.status !== 'completed'
      || dayKey(transaction.date) > anchorDate
    ) continue;
    const date = dayKey(transaction.date);
    for (const item of transaction.products || []) {
      const productId = String(item.productId);
      const productTotals = totals.get(productId);
      if (!productTotals) continue;
      const quantity = Number(item.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 0) {
        throw new DemandForecastError('ML_NOT_READY', 'Historical sale quantity is invalid', 409);
      }
      const next = (productTotals.get(date) || 0) + quantity;
      if (!Number.isSafeInteger(next)) {
        throw new DemandForecastError('ML_NOT_READY', 'Historical daily units are invalid', 409);
      }
      productTotals.set(date, next);
    }
  }

  const histories = new Map();
  for (const productId of productIds.map(String)) {
    const dailySales = [];
    for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      dailySales.push({ date, unitsSold: totals.get(productId).get(date) || 0 });
    }
    histories.set(productId, dailySales);
  }
  return histories;
};

const calculateRecommendation = ({ predictedDemand7d, minStockLevel, stockAtAnchor }) => {
  const prediction = Number(predictedDemand7d);
  const minimum = Number(minStockLevel || 0);
  const stock = Number(stockAtAnchor);
  if (![prediction, minimum, stock].every(Number.isFinite) || prediction < 0 || minimum < 0 || stock < 0) {
    throw new DemandForecastError('ML_SERVICE_UNAVAILABLE', 'ML result is invalid', 503);
  }
  const safetyStock = Math.max(minimum, prediction * DEFAULT_SAFETY_STOCK_RATE);
  const recommendedQty = Math.ceil(Math.max(0, prediction + safetyStock - stock));
  const inventoryStatus = recommendedQty > 0
    ? 'REPONER'
    : stock <= 1.5 * prediction ? 'VIGILAR' : 'OK';
  return { safetyStock, recommendedQty, inventoryStatus };
};

const defaultRepositories = {
  findScenario: query => HistoricalScenario.findOne(query).lean(),
  findScenarioStart: query => InventoryMovement.findOne(query)
    .select('occurredAt')
    .sort({ occurredAt: 1, createdAt: 1 })
    .lean(),
  findProducts: query => Product.find(query).select('_id sku name minStockLevel').limit(MAX_BATCH_SIZE + 1).lean(),
  findSales: query => Transaction.find(query).select('date type status products.productId products.quantity').sort({ date: 1 }).lean(),
  reconstructStockAt
};

const createDemandForecastService = ({
  repositories = defaultRepositories,
  mlClient = createMlServiceClient()
} = {}) => {
  const getDemandForecast = async ({ businessId, productId = null }) => {
    if (businessId !== CLOUD_DEMO_BUSINESS_ID) {
      return { status: 'ML_NOT_READY', reason: 'Demand model is not available for this tenant' };
    }

    const scenario = await repositories.findScenario({
      businessId,
      scenarioId: CLOUD_DEMO_SCENARIO_ID,
      status: 'completed'
    });
    if (!scenario) {
      return { status: 'ML_NOT_READY', reason: 'Historical scenario is not ready' };
    }

    const productQuery = {
      businessId,
      scenarioId: CLOUD_DEMO_SCENARIO_ID,
      isActive: true
    };
    if (productId) productQuery._id = new mongoose.Types.ObjectId(productId);
    const products = await repositories.findProducts(productQuery);
    if (productId && products.length === 0) {
      throw new DemandForecastError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    }
    if (products.length === 0 || products.length > MAX_BATCH_SIZE) {
      return { status: 'ML_NOT_READY', reason: 'Eligible product batch is unavailable' };
    }
    if (products.some(product => typeof product.sku !== 'string' || !product.sku.startsWith('M5-'))) {
      return { status: 'ML_NOT_READY', reason: 'Product lineage is incomplete' };
    }

    const scenarioStart = await repositories.findScenarioStart({
      businessId,
      scenarioId: CLOUD_DEMO_SCENARIO_ID
    });
    if (!scenarioStart) return { status: 'ML_NOT_READY', reason: 'Historical range is unavailable' };
    const historyStart = dayKey(scenarioStart.occurredAt);
    const anchorEnd = new Date(`${ANCHOR_OPERATIONAL_DATE}T23:59:59.999Z`);
    const productIds = products.map(product => product._id);
    const transactions = await repositories.findSales({
      businessId,
      scenarioId: CLOUD_DEMO_SCENARIO_ID,
      type: 'sale',
      status: 'completed',
      date: { $lte: anchorEnd },
      'products.productId': { $in: productIds }
    });
    const histories = buildContinuousHistory({
      startDate: historyStart,
      anchorDate: ANCHOR_OPERATIONAL_DATE,
      transactions,
      productIds
    });
    const stocks = await Promise.all(products.map(product => repositories.reconstructStockAt(
      businessId,
      product._id,
      anchorEnd
    )));

    const items = products.map((product, index) => {
      const dailySales = histories.get(String(product._id));
      return {
        productId: String(product._id),
        sku: product.sku,
        stockAtAnchor: stocks[index],
        minStockLevel: product.minStockLevel || 0,
        historyCoverage: {
          start: dailySales[0].date,
          end: dailySales[dailySales.length - 1].date,
          complete: true
        },
        dailySales
      };
    });

    let prediction;
    try {
      prediction = await mlClient.predictDemand({
        requestId: crypto.randomUUID(),
        context: {
          businessId,
          scenarioId: CLOUD_DEMO_SCENARIO_ID,
          anchorStrategy: ANCHOR_STRATEGY,
          anchorOperationalDate: ANCHOR_OPERATIONAL_DATE,
          timezone: 'UTC'
        },
        items
      });
    } catch (error) {
      if (error instanceof MlServiceUnavailableError || error.code === 'ML_SERVICE_UNAVAILABLE') {
        throw new DemandForecastError('ML_SERVICE_UNAVAILABLE', 'ML service is unavailable', 503);
      }
      throw error;
    }

    if (
      prediction.model !== 'demand_forecast_v1'
      || prediction.modelVersion !== '1.0.0'
      || prediction.featureSetVersion !== 'demand-v1'
      || prediction.results.length !== items.length
    ) {
      throw new DemandForecastError('ML_SERVICE_UNAVAILABLE', 'ML response is invalid', 503);
    }
    const expectedResults = new Set(items.map(item => `${item.productId}\0${item.sku}`));
    const resultMap = new Map();
    for (const result of prediction.results) {
      const key = `${result.productId}\0${result.sku}`;
      if (!expectedResults.has(key) || resultMap.has(key)) {
        throw new DemandForecastError('ML_SERVICE_UNAVAILABLE', 'ML response is invalid', 503);
      }
      resultMap.set(key, result);
    }

    const outputProducts = products.map((product, index) => {
      const result = resultMap.get(`${String(product._id)}\0${product.sku}`);
      const dailySales = items[index].dailySales;
      const base = {
        productId: String(product._id),
        sku: product.sku,
        name: product.name,
        stockAtAnchor: stocks[index],
        salesLast7Days: dailySales.slice(-7).reduce((sum, day) => sum + day.unitsSold, 0)
      };
      if (result.status !== 'READY') {
        return {
          ...base,
          predictedDemand7d: null,
          safetyStock: null,
          recommendedQty: null,
          inventoryStatus: 'ML_NO_DISPONIBLE',
          mlStatus: result?.status || 'ML_NO_DISPONIBLE'
        };
      }
      const recommendation = calculateRecommendation({
        predictedDemand7d: result.predictedDemand7d,
        minStockLevel: product.minStockLevel,
        stockAtAnchor: stocks[index]
      });
      return {
        ...base,
        predictedDemand7d: result.predictedDemand7d,
        ...recommendation,
        mlStatus: 'READY'
      };
    });

    return {
      status: 'READY',
      model: {
        name: prediction.model,
        version: prediction.modelVersion,
        featureSetVersion: prediction.featureSetVersion,
        algorithm: 'HistGradientBoostingRegressor',
        featuresCount: 31,
        horizonDays: HORIZON_DAYS,
        execution: 'cloud'
      },
      anchorOperationalDate: ANCHOR_OPERATIONAL_DATE,
      products: outputProducts
    };
  };

  return { getDemandForecast };
};

module.exports = {
  ANCHOR_OPERATIONAL_DATE,
  CLOUD_DEMO_BUSINESS_ID,
  CLOUD_DEMO_SCENARIO_ID,
  DemandForecastError,
  buildContinuousHistory,
  calculateRecommendation,
  createDemandForecastService
};
