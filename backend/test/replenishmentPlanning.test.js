const test = require('node:test');
const assert = require('node:assert/strict');
const { selectOffer, buildBudgetPlan, normalizeSupplier, resolveSupplier } = require('../src/agents/replenishmentPlanning');
const { createAgentExecution } = require('../src/agents/execution');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { getSkillDefinition } = require('../src/agents/skills');
const { buildSkillAnswer } = require('../src/agents/responses');

const oid = n => n.toString(16).padStart(24, '0');
const vendors = [
  { _id: oid(101), businessId: 'V2', type: 'vendor', isActive: true, name: 'Proveedor Z' },
  { _id: oid(102), businessId: 'V2', type: 'vendor', isActive: true, name: 'Proveedor A' },
  { _id: oid(103), businessId: 'OTHER', type: 'vendor', isActive: true, name: 'Externo' },
  { _id: oid(104), businessId: 'V2', type: 'vendor', isActive: false, name: 'Inactivo' }
];
const product = (n, { cost = 10, recommendedQty = 3, stockAtAnchor = 0, demand = 8, status = 'REPONER',
  supplier = oid(101), preferred = supplier, currency = 'PEN', department = 'FOODS_3' } = {}) => ({
  productId: oid(n), sku: `SKU-${n}`, name: `Producto ${n}`, businessId: 'V2', currency, isActive: true,
  preferredSupplierId: preferred, supplierPrices: [{ supplierId: supplier, purchasePrice: cost }], mlStatus: 'READY',
  recommendedQty, stockAtAnchor, predictedDemand7d: demand, inventoryStatus: status, department, anchor: '2026-05-17'
});

test('offer uses preferred supplier before cheaper and user selection must be valid', () => {
  const row = { ...product(1, { cost: 12 }), supplierPrices: [
    { supplierId: oid(101), purchasePrice: 12 }, { supplierId: oid(102), purchasePrice: 8 },
    { supplierId: oid(103), purchasePrice: 1 }, { supplierId: oid(104), purchasePrice: 2 },
    { supplierId: oid(102), purchasePrice: 0 }, { supplierId: oid(101), purchasePrice: -1 }
  ] };
  assert.equal(selectOffer(row, vendors).selected.supplierName, 'Proveedor Z');
  assert.equal(selectOffer(row, vendors).selectionRule, 'PREFERRED_SUPPLIER');
  assert.equal(selectOffer(row, vendors, 'Proveedor A').selected.supplierName, 'Proveedor A');
  assert.equal(selectOffer(row, vendors, 'Externo').selected, null);
  assert.equal(selectOffer({ ...row, preferredSupplierId: oid(999) }, vendors).selected.supplierName, 'Proveedor A');
});

test('greedy priority, exact-cent partial quantities, continuation, stable tie and global-before-page totals', () => {
  const rows = [product(1, { cost: 3.50, recommendedQty: 3, demand: 10, stockAtAnchor: 0 }),
    product(2, { cost: 1, recommendedQty: 2, demand: 5, stockAtAnchor: 3, status: 'VIGILAR', supplier: oid(102), preferred: oid(102) }),
    product(3, { cost: 1.25, recommendedQty: 2, demand: 0, stockAtAnchor: 0, supplier: oid(102), preferred: oid(102) })]
    .map(row => ({ ...row, selected: selectOffer(row, vendors).selected,
      coverage: row.predictedDemand7d > 0 ? row.stockAtAnchor / row.predictedDemand7d : null,
      shortage: Math.max(row.predictedDemand7d - row.stockAtAnchor, 0) }));
  const first = buildBudgetPlan({ rows, budget: 14.5, limit: 1, offset: 0 });
  const next = buildBudgetPlan({ rows, budget: 14.5, limit: 1, offset: 1 });
  assert.equal(first.items[0].sku, 'SKU-1');
  assert.equal(first.items[0].plannedQty, 3);
  assert.equal(first.items[0].plannedCost, 10.5);
  assert.equal(first.spent, 14);
  assert.equal(first.remaining, 0.5);
  const full = buildBudgetPlan({ rows, budget: 14.5, limit: 20, offset: 0 });
  assert.equal(next.items[0].sku, full.items[1].sku);
  assert.equal(next.spent, full.spent);
  assert.equal(next.remaining, full.remaining);
  assert.equal(full.items.some(row => row.plannedQty < row.recommendedQty), true);
});

const makeExecution = ({ businessId = 'V2', forecastRows, products, contacts, reads } = {}) => {
  const context = createAgentRequestContext({ businessId, user: { _id: oid(900), businessId, role: 'user', isActive: true } });
  const find = (rows, query) => ({ select() { return this; }, maxTimeMS() { return this; }, limit() { return this; }, lean() { return this; },
    async exec() { reads.push(query); return rows.filter(row => row.businessId === query.businessId
      && (!query.type || row.type === query.type) && (!query.isActive || row.isActive === query.isActive)
      && (!query._id || query._id.$in.some(id => String(id) === String(row._id)))
      && (!query.sku || query.sku.$in.includes(row.sku))); } });
  const models = { Product: { find: query => find(products, query) }, Contact: { find: query => find(contacts, query) } };
  const execution = createAgentExecution({ context, dependencies: { models, forecastService: {
    async getDemandForecast(input) { assert.equal(input.businessId, businessId); return { status: 'READY', anchorOperationalDate: '2026-05-17',
      model: { name: 'demand_forecast_v1', version: '1.0.0', horizonDays: 7 }, products: forecastRows }; }
  }, clock: () => new Date('2026-10-09T12:00:00.000Z') } });
  return { context, execution, reads };
};

test('plan skill stays tenant-scoped, read-only, paginates after allocation and uses forecast values', async () => {
  const rows = [product(1, { cost: 2.50, recommendedQty: 4 }), product(2, { cost: 3, recommendedQty: 2, supplier: oid(102), preferred: oid(102) })];
  const readLog = [];
  const { execution } = makeExecution({ forecastRows: rows, products: rows.map((row, i) => ({ ...row, _id: oid(i + 1) })), contacts: vendors, reads: readLog });
  const result = await execution.executeSkill({ agentId: 'analyst', skillId: 'plan_replenishment_budget',
    args: { budget: 16, currency: 'PEN', limit: 1, offset: 1 } });
  assert.equal(result.data.anchor, '2026-05-17');
  assert.equal(result.data.consideredProducts, 2);
  assert.equal(result.data.spent, 16);
  assert.equal(result.data.plannedUnits, 6);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.metadata.returnedCount, 1);
  assert.match(result.evidence.label, /2026-05-17.*PEN/);
  assert.equal(execution.finish().totalTokens, 0);
  assert.equal(readLog.every(query => query.businessId === 'V2'), true);
  assert.equal(getSkillDefinition('plan_replenishment_budget').readOnly, true);
});

test('single and total costs honor preferred offers, exclude zero cost and preserve honest coverage', async () => {
  const ready = product(1, { cost: 5, recommendedQty: 2 });
  ready.supplierPrices = [{ supplierId: oid(101), purchasePrice: 5 }, { supplierId: oid(102), purchasePrice: 3 }];
  const zeroCost = product(2, { cost: 0, recommendedQty: 3, supplier: oid(102), preferred: oid(102) });
  const notReady = { ...product(3, { recommendedQty: null }), mlStatus: 'INSUFFICIENT_HISTORY',
    predictedDemand7d: null, recommendedQty: null, inventoryStatus: null };
  const forecastRows = [ready, zeroCost, notReady];
  const products = forecastRows.map((row, index) => ({ ...row, _id: oid(index + 1) }));
  const reads = [];
  const { execution } = makeExecution({ forecastRows, products, contacts: vendors, reads });
  const single = await execution.executeSkill({ agentId: 'analyst', skillId: 'get_replenishment_cost',
    args: { mode: 'single', productRef: 'SKU-1', supplierRef: 'Proveedor A' } });
  assert.equal(single.data.selectedSupplier, 'Proveedor A');
  assert.equal(single.data.selectionRule, 'USER_SPECIFIED');
  assert.equal(single.data.replenishmentCost, 6);
  const total = await execution.executeSkill({ agentId: 'analyst', skillId: 'get_replenishment_cost', args: { mode: 'total' } });
  assert.equal(total.data.knownCostSubtotal, 10);
  assert.equal(total.data.costedProducts, 1);
  assert.equal(total.data.excludedProducts, 2);
  assert.equal(total.data.nonReadyProducts, 1);
  assert.equal(total.data.recommendedUnits, 5);
  assert.equal(total.data.coverageProducts.eligible, 2);
  assert.equal(execution.finish().totalTokens, 0);
  assert.equal(reads.every(query => query.businessId === 'V2'), true);
});

test('invalid currency and unauthorized operations invocation are rejected before reads', async () => {
  assert.equal(routeDeterministically('Tengo USD 500, ¿qué puedo reponer?', {}).intent, 'replenishment_budget_required');
  const reads = [], rows = [product(1)];
  const { execution } = makeExecution({ forecastRows: rows, products: rows.map((row, i) => ({ ...row, _id: oid(i + 1) })), contacts: vendors, reads });
  await assert.rejects(execution.executeSkill({ agentId: 'operations', skillId: 'plan_replenishment_budget',
    args: { budget: 50, currency: 'PEN' } }), error => error.code === 'AGENT_SKILL_NOT_ALLOWED');
  assert.equal(reads.length, 0);
  assert.deepEqual(routeDeterministically('Tengo S/ 500, ¿qué productos debería comprar primero?', {}), {
    intent: 'replenishment_commercial', agent: 'analyst', skillId: 'plan_replenishment_budget',
    args: { budget: 500, currency: 'PEN' }
  });
});

test('cost routing is deterministic and never inherits another skill or current-month period', () => {
  const routes = [
    ['¿Cuánto cuesta reponer M5-FOODS_3_511?', 'get_replenishment_cost'],
    ['¿Cuánto costaría reponer todo lo recomendado?', 'get_replenishment_cost'],
    ['¿Qué proveedor debería usar para M5-FOODS_3_511?', 'compare_supplier_costs'],
    ['¿Cuánto cuesta reponer M5-FOODS_3_511 con proveedor Proveedor A?', 'get_replenishment_cost'],
    ['Tengo S/ 1000, ¿qué productos debería comprar primero?', 'plan_replenishment_budget']
  ];
  for (const [message, skillId] of routes) assert.equal(routeDeterministically(message, {}).skillId, skillId);
  assert.equal(routeDeterministically('¿Cuánto cuesta reponer M5-FOODS_3_511 con proveedor Proveedor A?', {})
    .args.supplierRef, 'Proveedor A');
  for (const phrase of ['con proveedor 55 foods', 'usando proveedor 055 foods', 'con el 55 de foods', 'proveedor 55 foods']) {
    assert.equal(routeDeterministically(`¿Cuánto cuesta reponer M5-FOODS_3_511 ${phrase}?`, {}).args.supplierRef
      .replace(/\s+/g, ' ').trim(), phrase.includes('el 55') ? '55 de foods' : phrase.includes('055') ? '055 foods' : '55 foods');
  }
  const compare = routeDeterministically('¿Qué proveedor debería usar para M5-FOODS_3_511?', {});
  assert.equal(compare.skillId, 'compare_supplier_costs'); assert.equal(compare.args.supplierRef, undefined);
  const needBudget = routeDeterministically('Prioriza mis compras según demanda prevista y stock', {});
  assert.equal(needBudget.intent, 'replenishment_budget_required');
  assert.match(needBudget.clarificationQuestion, /presupuesto/);
  const answer = buildSkillAnswer('plan_replenishment_budget', { status: 'READY', data: { budget: 500, spent: 0,
    remaining: 500, items: [], plannedUnits: 0, unplannedUnits: 2, excludedProducts: 0 },
  metadata: { anchor: '2026-05-17' } });
  assert.match(answer, /forecast histórico/);
  assert.match(answer, /deja S\/ 500/);
});

test('supplier matching normalizes descriptors, accents, punctuation, case and leading zeros', () => {
  const offers = [{ supplierId: oid(101), supplierName: 'Proveedor sintético 055 FOODS', unitCost: 15.67 },
    { supplierId: oid(102), supplierName: 'Proveedor sintético 058 FOODS', unitCost: 15.99 }];
  for (const query of ['55 foods', '055 foods', 'proveedor 55 foods', 'proveedor 055 foods',
    'Proveedor sintético 055 FOODS', '055   foods!', 'el 55 de foods']) {
    assert.equal(resolveSupplier(query, offers).offer?.supplierId, oid(101), query);
  }
  assert.equal(normalizeSupplier('Proveedor sintético 055 FOODS'), normalizeSupplier('55 foods'));
  assert.equal(resolveSupplier('55 foodz', offers).confidence, 'FUZZY_CLEAR');
  const ambiguous = resolveSupplier('55 foo', [offers[0], { ...offers[0], supplierId: oid(103), supplierName: 'Proveedor sintético 055 FOOD' }]);
  assert.equal(ambiguous.status, 'AMBIGUOUS'); assert.equal(ambiguous.candidates.length, 2);
  assert.equal(resolveSupplier('Proveedor ajeno', offers).status, 'NOT_FOUND');
});

test('explicit supplier alias resolves one tenant offer, preserves the requested name and displays no internal rules', async () => {
  const forecastRow = product(1, { cost: 15.67, recommendedQty: 88 });
  forecastRow.supplierPrices = [{ supplierId: oid(101), purchasePrice: 15.67 }, { supplierId: oid(102), purchasePrice: 15.99 }];
  const contacts = [{ ...vendors[0], name: 'Proveedor sintético 055 FOODS' },
    { ...vendors[1], name: 'Proveedor sintético 058 FOODS' }, ...vendors.slice(2)];
  const reads = [], { execution } = makeExecution({ forecastRows: [forecastRow],
    products: [{ ...forecastRow, _id: oid(1) }], contacts, reads });
  const result = await execution.executeSkill({ agentId: 'analyst', skillId: 'get_replenishment_cost',
    args: { mode: 'single', productRef: 'SKU-1', supplierRef: '55 foods' } });
  assert.equal(result.data.selectedSupplier, 'Proveedor sintético 055 FOODS');
  assert.equal(result.data.supplierMatch.confidence, 'NORMALIZED');
  assert.equal(result.data.unitCost, 15.67); assert.equal(result.data.replenishmentCost, 1378.96);
  assert.equal(result.data.selectionRule, 'USER_SPECIFIED');
  const answer = buildSkillAnswer('get_replenishment_cost', result);
  assert.match(answer, /Tomé «55 foods» como Proveedor sintético 055 FOODS/);
  assert.match(answer, /1,378\.96 PEN/); assert.doesNotMatch(answer, /USER_SPECIFIED|PREFERRED_SUPPLIER/);
  assert.equal(execution.finish().totalTokens, 0);
  assert.equal(reads.every(query => query.businessId === 'V2'), true);
});

test('ambiguous supplier returns bounded safe candidates and a useful clarification without exposing ids', async () => {
  const forecastRow = product(1, { cost: 15.67, recommendedQty: 2 });
  forecastRow.supplierPrices = [{ supplierId: oid(101), purchasePrice: 15.67 }, { supplierId: oid(102), purchasePrice: 15.99 }];
  const contacts = [{ ...vendors[0], name: 'Proveedor sintético 055 FOOD' },
    { ...vendors[1], name: 'Proveedor sintético 055 FOODS' }];
  const reads = [], { execution } = makeExecution({ forecastRows: [forecastRow], products: [{ ...forecastRow, _id: oid(1) }], contacts, reads });
  const result = await execution.executeSkill({ agentId: 'analyst', skillId: 'get_replenishment_cost',
    args: { mode: 'single', productRef: 'SKU-1', supplierRef: '055 foo' } });
  assert.equal(result.status, 'CLARIFICATION'); assert.equal(result.metadata.suggestions.length, 2);
  assert.match(result.metadata.clarificationQuestion, /no estoy seguro/i);
  assert.equal(result.metadata.suggestions.every(row => !row.label.includes(oid(101)) && !row.label.includes(oid(102))), true);
  assert.equal(execution.finish().totalTokens, 0);
});

test('known supplier without this product offer is distinguished and valid alternatives are offered', async () => {
  const forecastRow = product(1, { cost: 15.67, recommendedQty: 2 });
  forecastRow.supplierPrices = [{ supplierId: oid(101), purchasePrice: 15.67 }];
  const reads = [], { execution } = makeExecution({ forecastRows: [forecastRow], products: [{ ...forecastRow, _id: oid(1) }],
    contacts: vendors, reads });
  const result = await execution.executeSkill({ agentId: 'analyst', skillId: 'get_replenishment_cost',
    args: { mode: 'single', productRef: 'SKU-1', supplierRef: 'Proveedor A' } });
  assert.equal(result.status, 'CLARIFICATION');
  assert.match(result.metadata.clarificationQuestion, /Encontré Proveedor A, pero no tiene una oferta/);
  assert.equal(result.metadata.suggestions.length, 1);
  assert.equal(result.metadata.suggestions[0].label, 'Proveedor Z');
  assert.equal(execution.finish().totalTokens, 0);
  assert.equal(reads.filter(query => query.type === 'vendor').every(query => query.businessId === 'V2'), true);
});
