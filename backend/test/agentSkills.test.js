const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentExecution, createAgentRequestContext, AgentError, SKILLS } = require('../src/agents');
const { withSkillTimeout } = require('../src/agents/execution');

const id = n => n.toString(16).padStart(24, '0');
const dates = { startDate: '2025-01-01', endDate: '2025-01-31' };
const context = (businessId = 'A') => createAgentRequestContext({
  user: { _id: id(999), businessId, role: 'user', isActive: true }, businessId
});
const code = expected => error => error instanceof AgentError && error.code === expected;

// Small, deliberately limited Mongo read fake: unsupported stages/operators fail.
// It evaluates fixture rows, rather than returning canned aggregate totals, so
// tenant/date/status/group/limit regressions change the results of these tests.
const field = (row, path) => path.split('.').reduce((value, key) => Array.isArray(value)
  ? value.map(item => item?.[key]) : value?.[key], row);
const expression = (value, row) => {
  if (typeof value === 'string' && value.startsWith('$')) return field(row, value.slice(1));
  if (Array.isArray(value)) return value.map(item => expression(item, row));
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const [operator] = Object.keys(value);
  if (!operator.startsWith('$')) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expression(item, row)]));
  const operands = expression(value[operator], row);
  switch (operator) {
    case '$lte': return operands[0] <= operands[1];
    case '$ifNull': return operands[0] ?? operands[1];
    case '$subtract': return operands[0] - operands[1];
    case '$cond': return operands[0] ? operands[1] : operands[2];
    case '$size': return operands.length;
    case '$sum': return operands.reduce((sum, item) => sum + item, 0);
    default: throw new Error(`Unsupported fake expression ${operator}`);
  }
};
const matches = (row, query) => Object.entries(query).every(([key, value]) => {
  if (key === '$or') return value.some(part => matches(row, part));
  if (key === '$expr') return expression(value, row);
  const actual = field(row, key);
  if (value instanceof RegExp) return typeof actual === 'string' && value.test(actual);
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([op, operand]) => {
    switch (op) {
      case '$gte': return actual >= operand;
      case '$lt': return actual < operand;
      case '$in': return operand.includes(actual);
      default: throw new Error(`Unsupported fake filter ${op}`);
    }
  });
  return actual === value;
});
const project = (row, selection) => Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== 0)
  .map(([key, value]) => [key, value === 1 ? row[key] : expression(value, row)]));
const sort = (rows, order) => [...rows].sort((a, b) => {
  for (const [key, direction] of Object.entries(order)) {
    const left = field(a, key), right = field(b, key);
    if (left < right) return -direction;
    if (left > right) return direction;
  }
  return 0;
});
const evaluate = (rows, pipeline) => pipeline.reduce((data, stage) => {
  const [op, arg] = Object.entries(stage)[0];
  switch (op) {
    case '$match': return data.filter(row => matches(row, arg));
    case '$sort': return sort(data, arg);
    case '$limit': return data.slice(0, arg);
    case '$project': return data.map(row => project(row, arg));
    case '$set': return data.map(row => ({ ...row, ...Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, expression(value, row)])) }));
    case '$count': return data.length ? [{ [arg]: data.length }] : [];
    case '$unwind': return data.flatMap(row => row[arg.slice(1)].map(item => ({ ...row, [arg.slice(1)]: item })));
    case '$facet': return [Object.fromEntries(Object.entries(arg).map(([key, stages]) => [key, evaluate(data, stages)]))];
    case '$group': {
      const groups = new Map();
      for (const row of data) {
        const groupId = expression(arg._id, row);
        const key = JSON.stringify(groupId);
        const first = !groups.has(key);
        if (first) groups.set(key, { _id: groupId });
        const group = groups.get(key);
        for (const [name, accumulator] of Object.entries(arg).filter(([name]) => name !== '_id')) {
          if ('$sum' in accumulator) group[name] = (group[name] || 0) + expression(accumulator.$sum, row);
          else if ('$first' in accumulator) { if (first) group[name] = expression(accumulator.$first, row); }
          else throw new Error('Unsupported fake accumulator');
        }
      }
      return [...groups.values()];
    }
    default: throw new Error(`Unsupported fake stage ${op}`);
  }
}, rows);

const product = (n, overrides = {}) => ({ _id: id(n), businessId: 'A', sku: `SKU-${n}`, name: `Product ${n}`,
  category: 'Food', stock: 5, minStockLevel: 8, price: 3, currency: 'PEN', isActive: true,
  email: 'do-not-return', description: 'internal', __v: 4, ...overrides });
const sale = (n, overrides = {}) => ({ _id: id(100 + n), businessId: 'A', type: 'sale', status: 'completed',
  date: new Date('2025-01-15T12:00:00Z'), totalAmount: 12, currency: 'PEN',
  products: [{ productId: id(1), productName: 'Historical product', quantity: 2, total: 12 }],
  contactName: 'private', contactEmail: 'private', ...overrides });
const fixture = (options = {}) => {
  const rows = {
    Product: options.products ?? [product(1), product(2, { stock: 8 }), product(3, { stock: 2 }),
      product(4, { isActive: false }), product(5, { businessId: 'B', sku: 'ONLY-B' })],
    Transaction: options.transactions ?? [sale(1), sale(2, { status: 'cancelled' }), sale(3, { status: 'pending' }),
      sale(4, { businessId: 'B', totalAmount: 9999 }), sale(5, { type: 'purchase', totalAmount: 20 }),
      sale(6, { currency: 'USD', totalAmount: 7, date: new Date('2025-01-31T23:59:59.999Z') }),
      sale(7, { date: new Date('2025-02-01T00:00:00Z') })],
    Contact: [], CreditPayment: [], InventoryMovement: []
  };
  const before = structuredClone(rows);
  const calls = [];
  let mutations = 0;
  const models = Object.fromEntries(Object.entries(rows).map(([name, records]) => {
    const query = (filter, single) => {
      calls.push({ name, filter });
      let selection, ordering, maximum;
      const builder = {
        select(value) { selection = typeof value === 'string' ? Object.fromEntries(value.split(' ').map(key => [key, 1])) : value; return this; },
        sort(value) { ordering = value; return this; }, limit(value) { maximum = value; return this; },
        maxTimeMS(value) { assert.ok(value > 0 && value <= 10000); return this; }, lean() { return this; },
        async exec() {
          let found = records.filter(row => matches(row, filter));
          if (ordering) found = sort(found, ordering);
          if (maximum) found = found.slice(0, maximum);
          if (selection) found = found.map(row => project(row, selection));
          return structuredClone(single ? found[0] || null : found);
        }
      };
      return builder;
    };
    return [name, {
      find: filter => query(filter, false), findOne: filter => query(filter, true),
      aggregate(pipeline) {
        calls.push({ name, pipeline });
        assert.ok(pipeline[0].$match.businessId, 'every aggregation must begin with the tenant filter');
        return { option(value) { assert.ok(value.maxTimeMS > 0 && value.maxTimeMS <= 10000); return this; },
          async exec() { return structuredClone(evaluate(records, pipeline)); } };
      },
      ...Object.fromEntries(['save', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne',
        'deleteMany', 'create', 'insertMany', 'bulkWrite'].map(method => [method, () => { mutations++; throw new Error('Mutation forbidden'); }]))
    }];
  }));
  const execution = createAgentExecution({ context: context(options.tenant ?? 'A'),
    dependencies: { models, toObjectId: value => value, clock: () => new Date('2025-01-20T00:00:00Z'),
      ...(options.forecastService ? { forecastService: options.forecastService } : {}) } });
  return { execution, calls, models, run: (skillId, args = {}, agentId = skillId === 'get_recent_transactions' ? 'operations' : 'analyst') =>
    execution.executeSkill({ agentId, skillId, args }),
  assertNoMutation() { assert.equal(mutations, 0); assert.deepEqual(rows, before); } };
};

test('AG-R3 skills and AG-R5 product sales are ready; three remain pending', () => {
  assert.deepEqual(SKILLS.filter(skill => skill.executorStatus === 'READY').map(skill => skill.id), [
    'search_products', 'get_product_details', 'get_low_stock_products', 'get_recent_transactions',
    'get_sales_summary', 'get_business_summary', 'get_top_selling_products', 'get_product_sales_summary', 'get_demand_forecast', 'get_replenishment_candidates'
  ]);
  assert.deepEqual(SKILLS.filter(skill => skill.executorStatus !== 'READY').map(skill => skill.id), [
    'get_inventory_summary', 'get_purchase_summary', 'get_supplier_details'
  ]);
});
test('product search caps active tenant matches, projects DTOs and reports truncation', async () => {
  const f = fixture();
  const result = await f.run('search_products', { query: 'Product', limit: 2, category: 'Food' });
  assert.equal(result.metadata.totalMatches, 3);
  assert.equal(result.metadata.returnedCount, 2);
  assert.equal(result.metadata.truncated, true);
  assert.deepEqual(result.data.map(row => row.id), [id(1), id(2)]);
  assert.deepEqual(Object.keys(result.data[0]), ['id', 'sku', 'name', 'category', 'stock', 'minStockLevel']);
  assert.equal(result.evidence.skillId, 'search_products');
  assert.ok(Object.isFrozen(result.data[0]));
  f.assertNoMutation();
});
test('search treats regex metacharacters and control input as literal text', async () => {
  const f = fixture({ products: [product(1, { name: 'Literal .* [a] $where\n' }), product(2)] });
  assert.equal((await f.run('search_products', { query: '.* [a] $where\n' })).metadata.totalMatches, 1);
  assert.equal((await f.run('search_products', { query: '(a+)+$' })).metadata.totalMatches, 0);
  assert.equal((await f.run('search_products', { query: '.*' })).data[0].id, id(1));
  f.assertNoMutation();
});
test('search by SKU/category excludes foreign and inactive products', async () => {
  assert.equal((await fixture().run('search_products', { query: 'ONLY-B' })).status, 'NO_DATA');
  assert.equal((await fixture({ tenant: 'B' }).run('search_products', { query: 'ONLY-B' })).data[0].id, id(5));
  assert.equal((await fixture().run('search_products', { query: 'SKU-1', category: 'Other' })).metadata.totalMatches, 0);
});
test('product details resolves ID and SKU under the tenant, including inactive records', async () => {
  const f = fixture();
  const byId = await f.run('get_product_details', { productId: id(1) });
  assert.deepEqual((await f.run('get_product_details', { sku: ' SKU-1 ' })).data, byId.data);
  assert.equal(byId.data.currency, 'PEN');
  assert.equal(byId.data.price, 3);
  assert.equal(byId.data.email, undefined);
  assert.equal((await f.run('get_product_details', { productId: id(4) })).data.isActive, false);
  f.assertNoMutation();
});
test('foreign IDs and SKUs are indistinguishable from missing products', async () => {
  for (const selector of [{ productId: id(5) }, { sku: 'ONLY-B' }, { productId: id(99999) }]) {
    await assert.rejects(fixture().run('get_product_details', selector), code('AGENT_RESOURCE_NOT_FOUND'));
  }
  assert.equal((await fixture({ tenant: 'B' }).run('get_product_details', { productId: id(5) })).data.id, id(5));
});
test('product sales totals cover all completed lines in the period and never another tenant', async () => {
  const f = fixture();
  const result = await f.run('get_product_sales_summary', { sku: 'SKU-1', ...dates }, 'operations');
  assert.equal(result.data.product.id, id(1));
  assert.equal(result.data.totalUnitsSold, 4);
  assert.deepEqual(result.data.amountsByCurrency, [
    { currency: 'PEN', amount: 12, label: 'Importe de líneas vendidas' },
    { currency: 'USD', amount: 12, label: 'Importe de líneas vendidas' }
  ]);
  await assert.rejects(f.run('get_product_sales_summary', { sku: 'ONLY-B', ...dates }), code('AGENT_RESOURCE_NOT_FOUND'));
  f.assertNoMutation();
});
test('low stock includes equality, orders greatest deficit first and counts beyond limit', async () => {
  const f = fixture();
  const result = await f.run('get_low_stock_products', { limit: 2 });
  assert.deepEqual(result.data.map(row => [row.id, row.shortage]), [[id(3), 6], [id(1), 3]]);
  assert.equal(result.metadata.totalMatches, 3);
  assert.equal(result.metadata.truncated, true);
  assert.equal((await f.run('get_low_stock_products')).data.at(-1).shortage, 0);
  f.assertNoMutation();
});
test('recent transactions applies tenant/type/status/full UTC end-day filters and descending order', async () => {
  const f = fixture();
  const result = await f.run('get_recent_transactions', { ...dates, type: 'sale', status: 'completed', limit: 1 });
  assert.equal(result.data[0].id, id(106));
  assert.equal(result.metadata.totalMatches, 2);
  assert.deepEqual(result.data[0], { id: id(106), type: 'sale', status: 'completed',
    date: '2025-01-31T23:59:59.999Z', total: 7, currency: 'USD', itemCount: 1 });
  assert.equal((await f.run('get_recent_transactions', { status: 'cancelled' })).data[0].id, id(102));
  f.assertNoMutation();
});
test('sales summary uses all completed tenant sales, separate currencies and units, not profit', async () => {
  const f = fixture();
  const result = await f.run('get_sales_summary', dates);
  assert.equal(result.data.completedSalesCount, 2);
  assert.equal(result.data.totalUnitsSold, 4);
  assert.deepEqual(result.data.amountsByCurrency, [
    { currency: 'PEN', amount: 12, label: 'Ventas completadas' },
    { currency: 'USD', amount: 7, label: 'Ventas completadas' }
  ]);
  assert.deepEqual(result.evidence.period, dates);
  assert.equal(result.data.profit, undefined);
  const other = await fixture({ tenant: 'B' }).run('get_sales_summary', dates);
  assert.equal(other.data.amountsByCurrency[0].amount, 9999);
  f.assertNoMutation();
});
test('sales period without data returns known zero counts and no invented currency amount', async () => {
  const result = await fixture().run('get_sales_summary', { startDate: '2024-01-01', endDate: '2024-01-31' });
  assert.equal(result.status, 'NO_DATA');
  assert.deepEqual(result.data, { completedSalesCount: 0, totalUnitsSold: 0, amountsByCurrency: [] });
});
test('top selling groups all sales beyond page one by units, not revenue, with one scoped product lookup', async () => {
  const transactions = Array.from({ length: 30 }, (_, n) => sale(n, {
    products: [{ productId: id(n < 25 ? 1 : 3), productName: 'Historic', quantity: n < 25 ? 2 : 20 }]
  }));
  transactions.push(sale(99, { businessId: 'B', products: [{ productId: id(2), quantity: 9000 }] }));
  transactions.push(sale(98, { status: 'pending', products: [{ productId: id(2), quantity: 9000 }] }));
  const f = fixture({ transactions });
  const result = await f.run('get_top_selling_products', { ...dates, limit: 1 });
  assert.deepEqual(result.data, [{ productId: id(3), sku: 'SKU-3', name: 'Product 3', unitsSold: 100 }]);
  assert.equal(result.metadata.totalMatches, 2);
  assert.equal(result.metadata.truncated, true);
  assert.equal(f.calls.filter(call => call.name === 'Product').length, 1);
  assert.equal(f.calls[1].filter.businessId, 'A');
  f.assertNoMutation();
});
test('top selling cannot load another tenant product through a malformed historical reference', async () => {
  const result = await fixture({ transactions: [sale(1, { products: [{ productId: id(5), quantity: 1, productName: 'Local snapshot' }] })] })
    .run('get_top_selling_products', dates);
  assert.equal(result.data[0].sku, null);
  assert.equal(result.data[0].name, 'Local snapshot');
});
test('business summary labels current inventory and completed monthly amounts by native currency', async () => {
  const f = fixture();
  const result = await f.run('get_business_summary', { period: 'current' });
  assert.equal(result.data.activeProducts, 3);
  assert.equal(result.data.lowStockProducts, 3);
  assert.equal(result.data.sales.completedTransactionsCount, 2);
  assert.equal(result.data.purchases.completedTransactionsCount, 1);
  assert.equal(result.data.completedTransactionsCount, 3);
  assert.deepEqual(result.data.purchases.amountsByCurrency, [{ currency: 'PEN', amount: 20, label: 'Compras completadas' }]);
  assert.deepEqual(result.metadata.period, dates);
  assert.equal(result.metadata.inventoryBasis, 'current_active_products');
  assert.equal(result.metadata.amountBasis, 'transaction_total_native_currency');
  f.assertNoMutation();
});
test('business latest month is selected only from completed tenant history', async () => {
  const result = await fixture({ transactions: [sale(1, { date: new Date('2024-03-02Z') }),
    sale(2, { businessId: 'B', date: new Date('2027-04-02Z') }), sale(3, { status: 'pending', date: new Date('2027-04-02Z') })] })
    .run('get_business_summary', { period: 'latest' });
  assert.deepEqual(result.metadata.period, { startDate: '2024-03-01', endDate: '2024-03-31' });
  assert.equal(result.data.sales.completedTransactionsCount, 1);
});
test('the same aggregate skills expose only the authenticated tenant in both directions', async () => {
  const f = fixture({ tenant: 'B' });
  const stock = await f.run('get_low_stock_products');
  assert.deepEqual(stock.data.map(row => row.id), [id(5)]);
  const recent = await f.run('get_recent_transactions', dates);
  assert.deepEqual(recent.data.map(row => row.id), [id(104)]);
  const business = await f.run('get_business_summary');
  assert.equal(business.data.activeProducts, 1);
  assert.equal(business.data.sales.completedTransactionsCount, 1);
  assert.equal(business.data.sales.amountsByCurrency[0].amount, 9999);
  assert.ok(f.calls.every(call => (call.filter ?? call.pipeline[0].$match).businessId === 'B'));
  f.assertNoMutation();
});
test('database failures do not expose queries, secrets or driver internals', async () => {
  const f = fixture();
  f.models.Product.aggregate = () => { throw new Error('Mongo URI password and private query'); };
  await assert.rejects(f.run('search_products', { query: 'private' }), error => {
    assert.ok(code('AGENT_SKILL_EXECUTION_FAILED')(error));
    assert.deepEqual(error.toJSON(), { code: 'AGENT_SKILL_EXECUTION_FAILED', message: 'Skill execution failed' });
    return true;
  });
  assert.equal(JSON.stringify(f.execution.getEvents()).includes('private'), false);
  f.assertNoMutation();
});

const forecastRow = (n, overrides = {}) => ({ productId: id(n), sku: `M5-${n}`, name: `Product ${n}`,
  mlStatus: 'READY', predictedDemand7d: 0.802037, stockAtAnchor: 1, salesLast7Days: 2,
  safetyStock: 0.2, recommendedQty: 5, inventoryStatus: 'REPONER', secret: 'do-not-return', ...overrides });
const forecastPayload = products => ({ status: 'READY', products, anchorOperationalDate: '2025-07-01',
  model: { name: 'demand_forecast_v1', version: '1.0.0', horizonDays: 7, internal: 'do-not-return' } });
test('forecast reuses the tenant-scoped existing service, preserves values, anchor and individual NO READY', async () => {
  const calls = [];
  const f = fixture({ forecastService: { async getDemandForecast(args) {
    calls.push(args);
    return forecastPayload([forecastRow(1), forecastRow(2, { mlStatus: 'INSUFFICIENT_HISTORY', predictedDemand7d: null,
      recommendedQty: null, inventoryStatus: 'ML_NO_DISPONIBLE' })]);
  } } });
  const result = await f.run('get_demand_forecast');
  assert.deepEqual(calls, [{ businessId: 'A' }]);
  assert.equal(result.data[0].predictedDemand7d, 0.802037);
  assert.equal(result.data[0].recommendedQty, 5);
  assert.equal(result.data[1].mlStatus, 'INSUFFICIENT_HISTORY');
  assert.equal(result.data[1].predictedDemand7d, null);
  assert.equal(result.metadata.interpretation, 'historical_replay');
  assert.equal(result.evidence.asOf, '2025-07-01');
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
  await f.run('get_demand_forecast', { productId: id(1) });
  assert.deepEqual(calls[1], { businessId: 'A', productId: id(1) });
  f.assertNoMutation();
});
test('forecast ML_NOT_READY stays a sanitized preparation result, not service failure', async () => {
  for (const getDemandForecast of [async () => ({ status: 'ML_NOT_READY', reason: 'private details' }),
    async () => { throw Object.assign(new Error('private details'), { code: 'ML_NOT_READY' }); }]) {
    const f = fixture({ forecastService: { getDemandForecast } });
    const result = await f.run('get_demand_forecast');
    assert.equal(result.status, 'ML_NOT_READY');
    assert.deepEqual(result.data, []);
    assert.equal(JSON.stringify(result).includes('private'), false);
    f.assertNoMutation();
  }
});
test('ML unavailable, product not found and executor errors use controlled sanitized codes', async () => {
  for (const [upstreamCode, expected] of [['ML_SERVICE_UNAVAILABLE', 'ML_SERVICE_UNAVAILABLE'],
    ['PRODUCT_NOT_FOUND', 'AGENT_RESOURCE_NOT_FOUND'], ['UNKNOWN', 'AGENT_SKILL_EXECUTION_FAILED']]) {
    const f = fixture({ forecastService: { async getDemandForecast() { throw Object.assign(new Error('secret URL password'), { code: upstreamCode }); } } });
    await assert.rejects(f.run('get_demand_forecast'), error => {
      assert.ok(code(expected)(error));
      assert.equal(JSON.stringify(error).includes('secret'), false);
      return true;
    });
    assert.equal(JSON.stringify(f.execution.getEvents()).includes('password'), false);
    f.assertNoMutation();
  }
});
test('replenishment selects READY positive quantities, orders top-N and shares one request-local batch', async () => {
  let calls = 0;
  const f = fixture({ forecastService: { async getDemandForecast() {
    calls++;
    return forecastPayload([forecastRow(1, { recommendedQty: 0 }), forecastRow(2, { recommendedQty: 8 }),
      forecastRow(3, { recommendedQty: 15 }), forecastRow(4, { mlStatus: 'MISSING_LINEAGE', recommendedQty: 99 })]);
  } } });
  await f.run('get_demand_forecast');
  const result = await f.run('get_replenishment_candidates', { limit: 1 });
  assert.deepEqual(result.data.map(row => row.productId), [id(3)]);
  assert.equal(result.data[0].recommendedQty, 15);
  assert.equal(result.metadata.totalMatches, 2);
  assert.equal(result.metadata.truncated, true);
  assert.equal(calls, 1);
  const secondRequest = fixture({ forecastService: { async getDemandForecast() { calls++; return forecastPayload([]); } } });
  await secondRequest.run('get_demand_forecast');
  assert.equal(calls, 2);
  f.assertNoMutation();
});
test('validation and bidirectional permissions fail before reads', async () => {
  const cases = [
    ['search_products', { query: 'x', businessId: 'B' }, 'analyst', 'AGENT_INVALID_SKILL_ARGS'],
    ['get_low_stock_products', { limit: 21 }, 'analyst', 'AGENT_INVALID_SKILL_ARGS'],
    ['get_sales_summary', { ...dates, endDate: '2025-02-30' }, 'analyst', 'AGENT_INVALID_SKILL_ARGS'],
    ['get_sales_summary', { startDate: '2025-02-01', endDate: '2025-01-01' }, 'analyst', 'AGENT_INVALID_SKILL_ARGS'],
    ['executeMongoQuery', {}, 'analyst', 'AGENT_SKILL_NOT_FOUND'],
    ['get_replenishment_candidates', {}, 'operations', 'AGENT_SKILL_NOT_ALLOWED'],
    ['search_products', { query: 'x' }, 'coordinator', 'AGENT_SKILL_NOT_ALLOWED']
  ];
  for (const [skillId, args, agent, expected] of cases) {
    const f = fixture();
    await assert.rejects(f.run(skillId, args, agent), code(expected));
    assert.equal(f.calls.length, 0);
    assert.equal(f.execution.finish().totalSkillCalls, 0);
    f.assertNoMutation();
  }
});
test('successful skills generate bounded evidence, safe lifecycle events and known zero token usage', async () => {
  const f = fixture();
  await f.run('search_products', { query: 'Product', limit: 1 });
  await f.run('get_sales_summary', dates);
  const usage = f.execution.finish();
  assert.equal(usage.totalSkillCalls, 2);
  assert.equal(usage.totalLlmCalls, 0);
  assert.equal(usage.totalInputTokens, 0);
  assert.equal(usage.totalOutputTokens, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.metricsComplete, true);
  assert.equal(usage.agents[0].usageAvailable, true);
  const finished = f.execution.getEvents().filter(event => event.type === 'skill_finished');
  assert.equal(finished.length, 2);
  assert.equal(finished[0].returnedCount, 1);
  assert.ok(finished.every(event => event.status === 'SUCCEEDED' && event.durationMs >= 0));
  assert.equal(JSON.stringify(f.execution.getEvents()).includes('Product 1'), false);
  f.assertNoMutation();
});
test('real skill calls respect the four-call budget and cannot finish while work is active', async () => {
  const f = fixture();
  const pending = f.run('get_low_stock_products');
  assert.throws(() => f.execution.finish(), code('AGENT_INVALID_REQUEST'));
  await pending;
  for (let n = 0; n < 3; n++) await f.run('get_low_stock_products');
  await assert.rejects(f.run('get_low_stock_products'), code('AGENT_BUDGET_EXCEEDED'));
  assert.equal(f.execution.finish().totalSkillCalls, 4);
  assert.equal(f.calls.length, 4);
});
test('wall-clock timeout aborts subsequent work without retries or exposing raw errors', async () => {
  let signal;
  let calls = 0;
  await assert.rejects(withSkillTimeout(received => { calls++; signal = received; return new Promise(() => {}); }, 10), code('AGENT_SKILL_TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.throws(() => signal.throwIfAborted(), code('AGENT_SKILL_TIMEOUT'));
  assert.equal(calls, 1);
});
test('empty lists and empty business history have explicit safe results', async () => {
  const f = fixture({ products: [], transactions: [] });
  for (const skillId of ['search_products', 'get_low_stock_products', 'get_recent_transactions']) {
    const result = await f.run(skillId, skillId === 'search_products' ? { query: 'Product' } : {});
    assert.equal(result.status, 'NO_DATA');
    assert.deepEqual(result.data, []);
    assert.equal(result.metadata.totalMatches, 0);
    assert.equal(result.metadata.returnedCount, 0);
    assert.equal(result.metadata.truncated, false);
  }
  const result = await f.run('get_business_summary', { period: 'latest' });
  assert.equal(result.data.activeProducts, 0);
  assert.equal(result.data.completedTransactionsCount, 0);
  assert.deepEqual(result.data.sales.amountsByCurrency, []);
  assert.deepEqual(result.metadata.period, dates);
  f.assertNoMutation();
});
test('sixty forecast results are bounded projections without per-product ML calls', async () => {
  let calls = 0;
  const f = fixture({ forecastService: { async getDemandForecast() {
    calls++;
    return forecastPayload(Array.from({ length: 60 }, (_, n) => forecastRow(n + 1)));
  } } });
  const result = await f.run('get_demand_forecast');
  assert.equal(result.data.length, 60);
  assert.equal(result.metadata.returnedCount, 60);
  assert.equal(result.data.filter(row => row.mlStatus === 'READY').length, 60);
  assert.equal(calls, 1);
  assert.equal(f.calls.length, 0);
  f.assertNoMutation();
});
test('forecast rejects a batch larger than its registry cap rather than sending excess context', async () => {
  const f = fixture({ forecastService: { async getDemandForecast() {
    return forecastPayload(Array.from({ length: 61 }, (_, n) => forecastRow(n + 1)));
  } } });
  await assert.rejects(f.run('get_demand_forecast'), code('AGENT_SKILL_EXECUTION_FAILED'));
  f.assertNoMutation();
});
test('the real execution wrapper enforces the registry deadline and records a single timed-out call', async () => {
  const f = fixture();
  let calls = 0;
  f.models.Product.aggregate = () => ({
    option({ maxTimeMS }) { assert.equal(maxTimeMS, 5000); return this; },
    exec() { calls++; return new Promise(() => {}); }
  });
  await assert.rejects(f.run('get_low_stock_products'), code('AGENT_SKILL_TIMEOUT'));
  const usage = f.execution.finish();
  assert.equal(calls, 1);
  assert.equal(usage.totalSkillCalls, 1);
  assert.equal(usage.totalTokens, 0);
  const events = f.execution.getEvents();
  assert.equal(events.find(event => event.type === 'error').code, 'AGENT_SKILL_TIMEOUT');
  assert.equal(events.find(event => event.type === 'skill_finished').status, 'FAILED');
  assert.equal(events.at(-1).status, 'FAILED');
  f.assertNoMutation();
});
