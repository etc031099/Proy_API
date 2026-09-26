const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  ANCHOR_OPERATIONAL_DATE,
  CLOUD_DEMO_BUSINESS_ID,
  CLOUD_DEMO_SCENARIO_ID,
  buildContinuousHistory,
  calculateRecommendation,
  createDemandForecastService
} = require('../src/services/demandForecastService');
const { MlServiceUnavailableError } = require('../src/services/mlServiceClient');

const productA = {
  _id: new mongoose.Types.ObjectId(),
  sku: 'M5-FOODS_1_033',
  name: 'Product A',
  minStockLevel: 3
};
const productB = {
  _id: new mongoose.Types.ObjectId(),
  sku: 'M5-FOODS_1_063',
  name: 'Product B',
  minStockLevel: 1
};

const makeRepositories = (overrides = {}) => {
  const calls = { queries: [], stocks: [] };
  return {
    calls,
    findScenario: async query => { calls.queries.push(['scenario', query]); return { status: 'completed' }; },
    findScenarioStart: async query => {
      calls.queries.push(['start', query]);
      return { occurredAt: new Date('2025-01-02T00:00:00.000Z') };
    },
    findProducts: async query => { calls.queries.push(['products', query]); return [productA, productB]; },
    findSales: async query => {
      calls.queries.push(['sales', query]);
      return [{
        type: 'sale', status: 'completed', date: new Date('2025-06-30T12:00:00.000Z'),
        products: [{ productId: productA._id, quantity: 2 }, { productId: productA._id, quantity: 3 }]
      }];
    },
    reconstructStockAt: async (businessId, productId, date) => {
      calls.stocks.push({ businessId, productId: String(productId), date });
      return String(productId) === String(productA._id) ? 8 : 20;
    },
    ...overrides
  };
};

const readyMlClient = (capture = []) => ({
  predictDemand: async request => {
    capture.push(request);
    return {
      model: 'demand_forecast_v1',
      modelVersion: '1.0.0',
      featureSetVersion: 'demand-v1',
      results: request.items.map((item, index) => ({
        productId: item.productId,
        sku: item.sku,
        status: index === 0 ? 'READY' : 'MISSING_LINEAGE',
        predictedDemand7d: index === 0 ? 17.36 : undefined
      }))
    };
  }
});

test('daily history sums completed sale units and fills zero-sale days', () => {
  const histories = buildContinuousHistory({
    startDate: '2025-06-28',
    anchorDate: '2025-07-01',
    productIds: [productA._id],
    transactions: [
      { type: 'sale', status: 'completed', date: '2025-06-29', products: [{ productId: productA._id, quantity: 2 }] },
      { type: 'sale', status: 'completed', date: '2025-06-29', products: [{ productId: productA._id, quantity: 3 }] },
      { type: 'sale', status: 'cancelled', date: '2025-06-30', products: [{ productId: productA._id, quantity: 99 }] },
      { type: 'sale', status: 'pending', date: '2025-06-30', products: [{ productId: productA._id, quantity: 99 }] },
      { type: 'purchase', status: 'completed', date: '2025-07-01', products: [{ productId: productA._id, quantity: 99 }] }
    ]
  });
  assert.deepEqual(histories.get(String(productA._id)), [
    { date: '2025-06-28', unitsSold: 0 },
    { date: '2025-06-29', unitsSold: 5 },
    { date: '2025-06-30', unitsSold: 0 },
    { date: '2025-07-01', unitsSold: 0 }
  ]);
});

test('forecast is tenant isolated and unsupported tenants do not call repositories or ML', async () => {
  let repositoryCalls = 0;
  let mlCalls = 0;
  const service = createDemandForecastService({
    repositories: new Proxy({}, { get: () => async () => { repositoryCalls += 1; } }),
    mlClient: { predictDemand: async () => { mlCalls += 1; } }
  });
  const result = await service.getDemandForecast({ businessId: 'OTHER-TENANT' });
  assert.equal(result.status, 'ML_NOT_READY');
  assert.equal(repositoryCalls, 0);
  assert.equal(mlCalls, 0);
});

test('forecast builds one canonical full-history batch and historical stock', async () => {
  const repositories = makeRepositories();
  const requests = [];
  const service = createDemandForecastService({ repositories, mlClient: readyMlClient(requests) });
  const result = await service.getDemandForecast({ businessId: CLOUD_DEMO_BUSINESS_ID });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].context.businessId, CLOUD_DEMO_BUSINESS_ID);
  assert.equal(requests[0].context.scenarioId, CLOUD_DEMO_SCENARIO_ID);
  assert.equal(requests[0].context.anchorOperationalDate, ANCHOR_OPERATIONAL_DATE);
  assert.equal(requests[0].items.length, 2);
  assert.equal(requests[0].items[0].historyCoverage.start, '2025-01-02');
  assert.equal(requests[0].items[0].historyCoverage.end, '2025-07-01');
  assert.equal(requests[0].items[0].dailySales.length, 181);
  assert.equal(repositories.calls.stocks.length, 2);
  assert.ok(repositories.calls.stocks.every(call => call.businessId === CLOUD_DEMO_BUSINESS_ID));
  const salesQuery = repositories.calls.queries.find(([name]) => name === 'sales')[1];
  const scenarioQuery = repositories.calls.queries.find(([name]) => name === 'scenario')[1];
  assert.equal(scenarioQuery.status, 'completed');
  assert.deepEqual(
    [salesQuery.businessId, salesQuery.scenarioId, salesQuery.type, salesQuery.status],
    [CLOUD_DEMO_BUSINESS_ID, CLOUD_DEMO_SCENARIO_ID, 'sale', 'completed']
  );
  assert.equal(result.products[0].stockAtAnchor, 8);
  assert.equal(result.products[0].salesLast7Days, 5);
  assert.equal(result.products[1].mlStatus, 'MISSING_LINEAGE');
  assert.equal(result.products[1].inventoryStatus, 'ML_NO_DISPONIBLE');
});

test('sixty eligible products use one FastAPI batch request', async () => {
  const products = Array.from({ length: 60 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(),
    sku: `M5-ITEM_${String(index).padStart(3, '0')}`,
    name: `Product ${index}`,
    minStockLevel: 0
  }));
  const requests = [];
  const repositories = makeRepositories({
    findProducts: async () => products,
    findSales: async () => [],
    reconstructStockAt: async () => 0
  });
  const mlClient = {
    predictDemand: async request => {
      requests.push(request);
      return {
        model: 'demand_forecast_v1', modelVersion: '1.0.0', featureSetVersion: 'demand-v1',
        results: request.items.map(item => ({
          productId: item.productId, sku: item.sku, status: 'READY', predictedDemand7d: 1
        }))
      };
    }
  };
  const service = createDemandForecastService({ repositories, mlClient });
  const result = await service.getDemandForecast({ businessId: CLOUD_DEMO_BUSINESS_ID });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].items.length, 60);
  assert.equal(result.products.length, 60);
  assert.equal(new Set(requests[0].items.map(item => item.productId)).size, 60);
  assert.equal(new Set(requests[0].items.map(item => item.sku)).size, 60);
});

test('product lookup remains scoped to authenticated tenant and scenario', async () => {
  let productQuery;
  const repositories = makeRepositories({
    findProducts: async query => { productQuery = query; return []; }
  });
  const service = createDemandForecastService({ repositories, mlClient: readyMlClient() });
  await assert.rejects(
    service.getDemandForecast({ businessId: CLOUD_DEMO_BUSINESS_ID, productId: String(productA._id) }),
    error => error.code === 'PRODUCT_NOT_FOUND' && error.statusCode === 404
  );
  assert.equal(productQuery.businessId, CLOUD_DEMO_BUSINESS_ID);
  assert.equal(productQuery.scenarioId, CLOUD_DEMO_SCENARIO_ID);
  assert.equal(String(productQuery._id), String(productA._id));
});

test('recommendation implements REPONER, VIGILAR and OK without mutation', () => {
  const input = { predictedDemand7d: 10, minStockLevel: 3, stockAtAnchor: 8 };
  assert.deepEqual(calculateRecommendation(input), {
    safetyStock: 3, recommendedQty: 5, inventoryStatus: 'REPONER'
  });
  assert.equal(calculateRecommendation({ predictedDemand7d: 10, minStockLevel: 0, stockAtAnchor: 14 }).inventoryStatus, 'VIGILAR');
  assert.equal(calculateRecommendation({ predictedDemand7d: 10, minStockLevel: 0, stockAtAnchor: 20 }).inventoryStatus, 'OK');
  assert.deepEqual(input, { predictedDemand7d: 10, minStockLevel: 3, stockAtAnchor: 8 });
});

test('ML unavailable is mapped to a sanitized 503 service error', async () => {
  const service = createDemandForecastService({
    repositories: makeRepositories(),
    mlClient: { predictDemand: async () => { throw new MlServiceUnavailableError('internal URL leaked'); } }
  });
  await assert.rejects(
    service.getDemandForecast({ businessId: CLOUD_DEMO_BUSINESS_ID }),
    error => error.code === 'ML_SERVICE_UNAVAILABLE'
      && error.statusCode === 503
      && !error.message.includes('URL')
  );
});
