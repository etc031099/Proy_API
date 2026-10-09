const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSkillAnswer, llmObservation } = require('../src/agents/responses');

const period = { startDate: '2026-10-01', endDate: '2026-10-31' };
const product = { sku: 'SKU-001', name: 'Producto 1', stock: 8, minStockLevel: 18 };
const list = (data, metadata = {}) => ({ status: data.length ? 'READY' : 'NO_DATA', data,
  metadata: { totalMatches: data.length, returnedCount: data.length, truncated: false, ...metadata } });
const finance = (count = 0, amountsByCurrency = []) => ({ completedTransactionsCount: count, amountsByCurrency });
const business = (overrides = {}, metadata = {}) => ({ status: 'READY', data: {
  activeProducts: 60, lowStockProducts: 2, completedTransactionsCount: 0,
  sales: finance(), purchases: finance(), ...overrides
}, metadata: { asOf: '2026-10-08T12:00:00Z', period, periodMode: 'current', inventoryBasis: 'current_active_products', ...metadata } });

test('low-stock wording explains the verified shortage and handles stock equal to minimum', () => {
  const answer = buildSkillAnswer('get_low_stock_products', list([
    { ...product, shortage: 10 }, { sku: 'SKU-002', stock: 5, minStockLevel: 5, shortage: 0 }
  ]));
  assert.match(answer, /Encontré 2 productos/);
  assert.match(answer, /8 unidades disponibles.*10 más.*mínimo de 18/);
  assert.match(answer, /SKU-002.*justo en su mínimo de 5/);
  assert.doesNotMatch(answer, /déficit|Mostrando|necesita 0/);
});

test('empty sales are a normal answer for the requested calendar month', () => {
  const answer = buildSkillAnswer('get_sales_summary', { status: 'NO_DATA',
    data: { completedSalesCount: 0, totalUnitsSold: 0, amountsByCurrency: [] }, metadata: { period } });
  assert.match(answer, /No se registraron ventas completadas durante octubre de 2026/);
  assert.doesNotMatch(answer, /error|sin importes|2026-10-01/i);
});

test('sales wording keeps native currencies separate and never claims profit', () => {
  const answer = buildSkillAnswer('get_sales_summary', { status: 'READY',
    data: { completedSalesCount: 2, totalUnitsSold: 7, amountsByCurrency: [
      { amount: 63, currency: 'PEN' }, { amount: 7, currency: 'USD' }
    ] }, metadata: { period } });
  assert.match(answer, /2 ventas completadas.*7 unidades/);
  assert.match(answer, /63 PEN; 7 USD/);
  assert.doesNotMatch(answer, /70|utilidad|ganancia|profit/i);
});

test('product sales with no records and product details with zero stock stay clear', () => {
  const answer = buildSkillAnswer('get_product_sales_summary', { status: 'NO_DATA',
    data: { product, totalUnitsSold: 0, amountsByCurrency: [] }, metadata: { period } });
  assert.match(answer, /SKU-001.*no registra ventas completadas.*octubre de 2026/);
  const details = buildSkillAnswer('get_product_details', { status: 'READY',
    data: { ...product, stock: 0, price: 9, currency: 'PEN', isActive: true }, metadata: {} });
  assert.match(details, /0 unidades disponibles/);
  assert.match(details, /precio es 9 PEN/);
  assert.match(details, /está activo/);
});

test('ranking labels full history, optional periods and a bounded list conversationally', () => {
  const rows = [{ ...product, unitsSold: 37 }];
  const answer = buildSkillAnswer('get_top_selling_products', list(rows, { totalMatches: 20, truncated: true }));
  assert.match(answer, /más unidades vendidas en todo el historial disponible/);
  assert.match(answer, /SKU-001.*37 unidades vendidas/);
  assert.match(answer, /Te muestro el primer resultado/);
  assert.doesNotMatch(answer, /Mostrando|lista limitada|2026/);
  assert.match(buildSkillAnswer('get_top_selling_products', list(rows, { period })), /octubre de 2026/);
  assert.match(buildSkillAnswer('get_top_selling_products', list([])), /No encontré ventas completadas.*todo el historial/);
});

const forecastRow = { ...product, mlStatus: 'READY', predictedDemand7d: 8.25, stockAtAnchor: 2,
  salesLast7Days: 3, safetyStock: 5, recommendedQty: 12, inventoryStatus: 'REPONER', anchor: '2025-07-01' };
test('replenishment prioritizes existing quantities and explains the historical reference once', () => {
  const result = list([forecastRow, { ...forecastRow, sku: 'SKU-002', recommendedQty: 6 }]);
  const before = structuredClone(result);
  const answer = buildSkillAnswer('get_replenishment_candidates', result);
  assert.match(answer, /priorizar 2 productos/);
  assert.match(answer, /mayor cantidad sugerida.*SKU-001.*12 unidades/);
  assert.match(answer, /SKU-002.*reponer 6 unidades/);
  assert.match(answer, /demanda estimada de 8\.25 unidades.*stock disponible de 2/);
  assert.equal(answer.match(/1 de julio de 2025/g).length, 1);
  assert.deepEqual(result, before);
});

test('supplier cost and comparison responses humanize selection rules and hide internal enums', () => {
  const cost = buildSkillAnswer('get_replenishment_cost', { status: 'READY', data: { sku: 'SKU-001', productName: 'Producto',
    recommendedQty: 2, unitCost: 15.67, replenishmentCost: 31.34, currency: 'PEN', selectedSupplier: 'Proveedor 055 Foods',
    selectionRule: 'USER_SPECIFIED', supplierMatch: { requested: '55 foods', resolved: 'Proveedor 055 Foods' },
    stockAtAnchor: 1, predictedDemand7d: 2, inventoryStatus: 'REPONER', mlStatus: 'READY' },
  metadata: { anchor: '2026-05-17', pricingAsOf: '2026-10-09T00:00:00.000Z', interpretation: 'historical_replay' } });
  assert.match(cost, /Tomé «55 foods» como Proveedor 055 Foods/);
  assert.match(cost, /Se utilizó el proveedor que indicaste/);
  assert.doesNotMatch(cost, /USER_SPECIFIED|USER_SPECIFIED_UNAVAILABLE|PREFERRED_SUPPLIER|LOWEST_VALID_PRICE/);
  const comparison = buildSkillAnswer('compare_supplier_costs', { status: 'READY', data: [
    { sku: 'SKU-001', productName: 'Producto', supplier: 'Proveedor 055 Foods', unitCost: 15.67, currency: 'PEN', preferred: true, selected: true },
    { sku: 'SKU-001', productName: 'Producto', supplier: 'Proveedor 058 Foods', unitCost: 15.99, currency: 'PEN', preferred: false, selected: false }
  ], metadata: { selectionRule: 'PREFERRED_SUPPLIER', selectedSupplier: 'Proveedor 055 Foods', pricingAsOf: '2026-10-09' } });
  assert.match(comparison, /2 proveedores con ofertas válidas/);
  assert.match(comparison, /Proveedor 055 Foods: 15\.67 PEN por unidad/);
  assert.match(comparison, /porque es el proveedor preferido configurado/);
  assert.doesNotMatch(comparison, /PREFERRED_SUPPLIER|USER_SPECIFIED/);
});

test('individual forecast separates demand, security stock and recommendation, including zero and non-READY', () => {
  const answer = buildSkillAnswer('get_demand_forecast', list([forecastRow]));
  assert.match(answer, /estima 8\.25 unidades para 7 días/);
  assert.match(answer, /vendido 3 en los 7 días anteriores/);
  assert.match(answer, /5 unidades de stock de seguridad.*reponer 12 unidades/);
  assert.match(answer, /escenario histórico.*1 de julio de 2025/);
  const zero = buildSkillAnswer('get_demand_forecast', list([{ ...forecastRow, predictedDemand7d: 0, recommendedQty: 0 }]));
  assert.match(zero, /estima 0 unidades/);
  assert.match(zero, /no se recomienda reposición/);
  const notReady = buildSkillAnswer('get_demand_forecast', list([{ ...product, mlStatus: 'INSUFFICIENT_HISTORY', anchor: '2025-07-01' }]));
  assert.match(notReady, /suficiente historial/);
  assert.doesNotMatch(notReady, /INSUFFICIENT_HISTORY|estima \d/);
});

test('recent transactions show readable dates and Spanish status labels', () => {
  const answer = buildSkillAnswer('get_recent_transactions', list([
    { type: 'sale', status: 'completed', date: '2025-07-01T23:00:00Z', total: 21, currency: 'PEN', itemCount: 2 }
  ]));
  assert.match(answer, /1 de julio de 2025.*venta completada por 21 PEN/);
  assert.match(answer, /2 líneas de productos/);
  assert.doesNotMatch(answer, /completed|2025-07-01/);
});

test('business summary distinguishes current inventory, no current activity and verified historical activity', () => {
  const current = buildSkillAnswer('get_business_summary', business());
  assert.match(current, /60 productos activos/);
  assert.match(current, /2 están en el mínimo/);
  assert.match(current, /No se registran ventas o compras completadas durante octubre de 2026/);
  const historical = business({ completedTransactionsCount: 1, sales: finance(1, [{ amount: 80, currency: 'PEN' }]) },
    { periodMode: 'latest', period: { startDate: '2025-07-01', endDate: '2025-07-31' } });
  const answer = buildSkillAnswer('get_business_summary', historical);
  assert.match(answer, /datos de ventas y compras completadas disponibles son históricos/);
  assert.match(answer, /último periodo con actividad completada registrada es julio de 2025/);
  assert.match(answer, /1 venta completada por 80 PEN/);
  assert.doesNotMatch(answer, /60 productos|este mes/);
  const empty = buildSkillAnswer('get_business_summary', business({}, { periodMode: 'latest' }));
  assert.match(empty, /No encontré ventas ni compras completadas en el historial/);
  assert.doesNotMatch(empty, /julio|último periodo/);
});

test('compact synthesis observations retain current-versus-history metadata without documents', () => {
  const observation = llmObservation('get_business_summary', business());
  assert.equal(observation.periodMode, 'current');
  assert.equal(observation.inventoryBasis, 'current_active_products');
  assert.deepEqual(observation.period, period);
  assert.equal(observation.asOf, '2026-10-08T12:00:00Z');
});
