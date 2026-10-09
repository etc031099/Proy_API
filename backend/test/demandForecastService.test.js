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
const { Product, Transaction, InventoryMovement } = require('../src/models');
const SCENARIOS = require('../src/config/mlScenarios.json');
const fs = require('node:fs');
const path = require('node:path');

test('closed registry contains exactly v1/v2 with identical frozen model contract', () => {
  assert.deepEqual(Object.keys(SCENARIOS), ['v1', 'v2']);
  assert.equal(SCENARIOS.v1.modelSha256, SCENARIOS.v2.modelSha256);
  for (const scenario of Object.values(SCENARIOS)) {
    assert.equal(scenario.productsCount, 60);
    assert.equal(scenario.featuresCount, 31);
    assert.equal(scenario.horizonDays, 7);
  }
});

test('full/minimal local v2 replay preserves actual backend histories and recommendations', async t => {
  const operational = path.resolve(__dirname, '../../ml/data/operational');
  const files = ['scenario_cloud_demo_v2.ndjson', 'scenario_cloud_demo_v2_minimal.ndjson'];
  if (!files.every(file => fs.existsSync(path.join(operational, file)))) {
    return t.skip('Full/minimal local v2 datasets unavailable; no download or regeneration');
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../ml/reports/scenario_cloud_demo_v2_manifest.json'), 'utf8'));
  const expected = new Map(manifest.products.map(row => [row.productId, row]));
  const results = [], requests = [];
  for (const file of files) {
    const events = fs.readFileSync(path.join(operational, file), 'utf8').trim().split('\n').map(JSON.parse);
    const products = events.filter(e => e.eventType === 'product.created').map(e => ({ ...e.payload, _id: e.payload._id }))
      .sort((a, b) => a.sku.localeCompare(b.sku));
    const transactions = new Map();
    const stocks = new Map(products.map(p => [p._id, p.stock]));
    for (const e of events) {
      const p = e.payload;
      if (e.eventType === 'transaction.completed') {
        transactions.set(p._id, { ...p, date: new Date(e.occurredAt), status: 'completed' });
        for (const line of p.products) stocks.set(line.productId, stocks.get(line.productId) + line.quantity * (p.type === 'purchase' ? 1 : -1));
      } else if (e.eventType === 'transaction.cancelled') {
        const tx = transactions.get(p.transactionId);
        tx.status = 'cancelled';
        for (const line of tx.products) stocks.set(line.productId, stocks.get(line.productId) + line.quantity);
      }
    }
    const service = createDemandForecastService({ repositories: {
      findScenario: async () => ({ status: 'completed' }),
      findScenarioStart: async () => ({ occurredAt: new Date(events.find(e => e.eventType === 'product.created').occurredAt) }),
      findProducts: async () => products,
      findSales: async q => [...transactions.values()].filter(tx => tx.type === 'sale' && tx.status === 'completed' && tx.date >= q.date.$gte && tx.date <= q.date.$lte),
      reconstructStockAt: async (business, id) => stocks.get(String(id))
    }, mlClient: { predictDemand: async request => {
      requests.push(request.items);
      return { model: 'demand_forecast_v1', modelVersion: '1.0.0', featureSetVersion: 'demand-v1',
        results: request.items.map(item => ({ productId: item.productId, sku: item.sku, status: 'READY',
          predictedDemand7d: expected.get(item.productId).predictedDemand7d })) };
    } } });
    results.push(await service.getDemandForecast({ businessId: 'ML-CLOUD-DEMO-V2' }));
  }
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[1].products.length, 60);
  for (const product of results[1].products) {
    const row = expected.get(product.productId);
    assert.equal(product.mlStatus, 'READY');
    assert.equal(product.stockAtAnchor, row.stock);
    assert.equal(product.safetyStock, row.safetyStock);
    assert.equal(product.recommendedQty, row.recommendedQty);
    assert.equal(product.inventoryStatus, row.inventoryStatus);
  }
});

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

test('descriptive lineage travels with READY/non-READY rows without changing numerical forecasts', async () => {
  const baselineClient = readyMlClient();
  const descriptiveClient = { predictDemand: async request => {
    const result = await baselineClient.predictDemand(request);
    return { ...result, results: result.results.map(row => ({ ...row, category: 'FOODS', department: 'FOODS_1' })) };
  } };
  const baseline = await createDemandForecastService({ repositories: makeRepositories(), mlClient: baselineClient })
    .getDemandForecast({ businessId: 'ML-CLOUD-DEMO' });
  const extended = await createDemandForecastService({ repositories: makeRepositories(), mlClient: descriptiveClient })
    .getDemandForecast({ businessId: 'ML-CLOUD-DEMO' });
  for (let index = 0; index < extended.products.length; index++) {
    assert.equal(extended.products[index].category, 'FOODS');
    assert.equal(extended.products[index].department, 'FOODS_1');
    for (const field of ['predictedDemand7d', 'recommendedQty', 'safetyStock', 'stockAtAnchor', 'inventoryStatus', 'mlStatus']) {
      assert.equal(extended.products[index][field], baseline.products[index][field]);
    }
  }
});

test('v2 is selected by server business and uses a bounded 197-day history', async () => {
  const requests = [];
  const repositories = makeRepositories({ findScenarioStart: async () => ({ occurredAt: new Date('2025-11-01') }) });
  const service = createDemandForecastService({ repositories, mlClient: readyMlClient(requests) });
  const result = await service.getDemandForecast({ businessId: 'ML-CLOUD-DEMO-V2',
    scenarioId: 'evil', anchor: '2099-01-01' });
  assert.equal(result.status, 'READY');
  assert.equal(result.anchorOperationalDate, '2026-05-17');
  assert.equal(requests[0].context.scenarioId, 'm5-ca3-cloud-demo-v2');
  assert.equal(requests[0].items[0].dailySales.length, 197);
  assert.equal(requests[0].items[0].historyCoverage.start, '2025-11-02');
  for (const [, query] of repositories.calls.queries) {
    assert.equal(query.businessId, 'ML-CLOUD-DEMO-V2');
    assert.equal(query.scenarioId, 'm5-ca3-cloud-demo-v2');
  }
});

test('v1 cannot be switched to v2 by client-provided scenario or anchor', async () => {
  const requests = [];
  await createDemandForecastService({ repositories: makeRepositories(), mlClient: readyMlClient(requests) })
    .getDemandForecast({ businessId: 'ML-CLOUD-DEMO', scenarioId: SCENARIOS.v2.scenarioId, anchor: SCENARIOS.v2.anchorOperationalDate });
  assert.equal(requests[0].context.scenarioId, SCENARIOS.v1.scenarioId);
  assert.equal(requests[0].context.anchorOperationalDate, SCENARIOS.v1.anchorOperationalDate);
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

const isInvalidMlResult = error => error.code === 'ML_SERVICE_UNAVAILABLE'
  && error.statusCode === 503 && error.message === 'ML result is invalid';

const invalidPredictions = [
  ['null', null], ['undefined', undefined], ['numeric string', '12.5'],
  ['zero string', '0'], ['text', 'abc'], ['NaN', NaN], ['Infinity', Infinity],
  ['-Infinity', -Infinity], ['negative', -1], ['object', {}], ['array', [5]],
  ['empty array', []], ['boolean', false]
];

test('READY predictions reject non-numbers, nonfinite and negative values without coercion', async t => {
  for (const [name, prediction] of invalidPredictions) {
    await t.test(name, () => {
      assert.throws(() => calculateRecommendation({
        predictedDemand7d: prediction, minStockLevel: 0, stockAtAnchor: 0
      }), isInvalidMlResult);
    });
  }
});

test('zero and CLOUD-DEMO decimal predictions preserve the recommendation formula', () => {
  assert.deepEqual(calculateRecommendation({ predictedDemand7d: 0, minStockLevel: 0, stockAtAnchor: 0 }), {
    safetyStock: 0, recommendedQty: 0, inventoryStatus: 'VIGILAR'
  });
  const prediction = 0.802037;
  const result = calculateRecommendation({ predictedDemand7d: prediction, minStockLevel: 0, stockAtAnchor: 0 });
  assert.deepEqual(result, {
    safetyStock: prediction * 0.20,
    recommendedQty: Math.ceil(Math.max(0, prediction + prediction * 0.20)),
    inventoryStatus: 'REPONER'
  });
});

test('minimum and historical stock require finite nonnegative numbers with only a nullish minimum default', async t => {
  for (const minimum of [undefined, null, 0]) {
    assert.equal(calculateRecommendation({ predictedDemand7d: 10, minStockLevel: minimum, stockAtAnchor: 20 }).safetyStock, 2);
  }
  const invalid = [null, undefined, '', '3', false, {}, [], NaN, Infinity, -Infinity, -1];
  for (const field of ['minStockLevel', 'stockAtAnchor']) {
    for (const value of invalid) {
      if (field === 'minStockLevel' && value == null) continue;
      await t.test(`${field}: ${String(value)}`, () => {
        assert.throws(() => calculateRecommendation({
          predictedDemand7d: 10, minStockLevel: 0, stockAtAnchor: 20, [field]: value
        }), isInvalidMlResult);
      });
    }
  }
});

test('finite extreme values are rejected on overflow without imposing an arbitrary cap', () => {
  assert.throws(() => calculateRecommendation({
    predictedDemand7d: Number.MAX_VALUE, minStockLevel: 0, stockAtAnchor: Number.MAX_VALUE
  }), isInvalidMlResult);
  assert.throws(() => calculateRecommendation({
    predictedDemand7d: Number.MAX_VALUE / 2, minStockLevel: Number.MAX_VALUE, stockAtAnchor: 0
  }), isInvalidMlResult);
  assert.throws(() => calculateRecommendation({
    predictedDemand7d: Number.MAX_VALUE * 0.7, minStockLevel: 0, stockAtAnchor: Number.MAX_VALUE
  }), isInvalidMlResult);
  assert.ok(Number.isFinite(calculateRecommendation({
    predictedDemand7d: Number.MAX_VALUE / 2, minStockLevel: 0, stockAtAnchor: 0
  }).recommendedQty));
});

test('a READY-invalid batch fails safely and forecast repositories remain read-only', async t => {
  const writeSpies = [
    t.mock.method(Product, 'updateOne', () => { throw new Error('unexpected stock write'); }),
    t.mock.method(Product.prototype, 'save', () => { throw new Error('unexpected stock save'); }),
    t.mock.method(Transaction, 'create', () => { throw new Error('unexpected sale/purchase'); }),
    t.mock.method(Transaction.prototype, 'save', () => { throw new Error('unexpected transaction save'); }),
    t.mock.method(InventoryMovement, 'create', () => { throw new Error('unexpected movement'); }),
    t.mock.method(InventoryMovement.prototype, 'save', () => { throw new Error('unexpected movement save'); })
  ];
  const products = [Object.freeze({ ...productA, stock: 8 }), Object.freeze({ ...productB, stock: 20 })];
  const before = JSON.stringify(products);
  for (const [name, value] of [...invalidPredictions, ['absent', undefined], ['overflow', Number.MAX_VALUE]]) {
    await t.test(name, async () => {
      const valid = readyMlClient();
      const service = createDemandForecastService({
        repositories: makeRepositories({ findProducts: async () => products }),
        mlClient: {
          predictDemand: async request => {
            const response = await valid.predictDemand(request);
            const invalid = { ...response.results[1], status: 'READY', predictedDemand7d: value };
            if (name === 'absent') delete invalid.predictedDemand7d;
            return { ...response, results: [response.results[0], invalid] };
          }
        }
      });
      await assert.rejects(service.getDemandForecast({ businessId: CLOUD_DEMO_BUSINESS_ID }), isInvalidMlResult);
    });
  }
  assert.equal(JSON.stringify(products), before);
  for (const spy of writeSpies) assert.equal(spy.mock.callCount(), 0);
});

test('legitimate non-READY results need no prediction and preserve mixed batches', async () => {
  for (const status of ['INSUFFICIENT_HISTORY', 'MISSING_LINEAGE', 'MISSING_PRICE_HISTORY', 'MISSING_CALENDAR', 'INVALID_HISTORY', 'INVALID_FEATURES']) {
    const valid = readyMlClient();
    const service = createDemandForecastService({
      repositories: makeRepositories(),
      mlClient: {
        predictDemand: async request => {
          const response = await valid.predictDemand(request);
          return { ...response, results: [response.results[0], {
            productId: response.results[1].productId, sku: response.results[1].sku, status
          }] };
        }
      }
    });
    const result = await service.getDemandForecast({ businessId: CLOUD_DEMO_BUSINESS_ID });
    assert.equal(result.status, 'READY');
    assert.equal(result.products[0].mlStatus, 'READY');
    assert.equal(result.products[0].recommendedQty, 13);
    assert.deepEqual({
      status: result.products[1].mlStatus, prediction: result.products[1].predictedDemand7d,
      safety: result.products[1].safetyStock, quantity: result.products[1].recommendedQty
    }, { status, prediction: null, safety: null, quantity: null });
  }
});
