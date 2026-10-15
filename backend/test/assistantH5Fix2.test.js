'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3, renderV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');

const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const route = message => routeV3(message, {}, binding);
const days = (task, start, end) => assert.deepEqual([task.args.startDate, task.args.endDate], [start, end]);

test('H5-FIX2 multi-intent applies bare explicit sales period only to sales', () => {
  const plan = route('Dime mis ventas de 7 días y qué productos debería reponer.');
  assert.deepEqual(plan.tasks.map(row => row.skillId), ['get_business_analytics', 'get_inventory_intelligence']);
  days(plan.tasks[0], '2026-10-08', '2026-10-14');
  assert.equal(plan.tasks[1].args.mode, 'rank');
  assert.equal(plan.tasks[1].args.startDate, undefined);
});

test('H5-FIX2 multi-intent preserves 30 days and today without applying them to inventory', () => {
  const thirty = route('Dime mis ventas de 30 días y qué productos debería reponer.');
  assert.deepEqual(thirty.tasks.map(row => row.skillId), ['get_business_analytics', 'get_inventory_intelligence']);
  days(thirty.tasks[0], '2026-09-15', '2026-10-14');
  const today = route('Dime mis ventas de hoy y qué productos debería reponer.');
  days(today.tasks[0], '2026-10-14', '2026-10-14');
  assert.equal(today.tasks[1].args.startDate, undefined);
});

test('H5-FIX2 multi-intent keeps the sales default and preserves product/provider context', () => {
  const defaultPlan = route('Dime mis ventas y qué productos debería reponer.');
  assert.deepEqual(defaultPlan.tasks.map(row => row.skillId), ['get_business_analytics', 'get_inventory_intelligence']);
  days(defaultPlan.tasks[0], '2026-09-15', '2026-10-14');

  const stock = route('Dime mis ventas de 7 días y el stock de PAN-FRE-001.');
  assert.deepEqual(stock.tasks.map(row => row.skillId), ['get_business_analytics', 'get_inventory_intelligence']);
  days(stock.tasks[0], '2026-10-08', '2026-10-14');
  assert.equal(stock.tasks[1].args.productRef, 'PAN-FRE-001');
  assert.equal(stock.tasks[1].args.startDate, undefined);

  const supplier = route('¿Cuánto vendí en 7 días y qué proveedores tienen pedidos pendientes?');
  assert.deepEqual(supplier.tasks.map(row => row.skillId), ['get_business_analytics', 'get_supplier_intelligence']);
  days(supplier.tasks[0], '2026-10-08', '2026-10-14');
  assert.equal(supplier.tasks[1].pendingOnly, true);
  assert.equal(supplier.tasks[1].args.startDate, undefined);
});

test('H5-FIX2 single-intent explicit 7/30-day periods and today remain exact', () => {
  days(route('¿Cuánto vendí en los últimos 7 días?').tasks[0], '2026-10-08', '2026-10-14');
  days(route('¿Cuánto vendí en 30 días?').tasks[0], '2026-09-15', '2026-10-14');
  days(route('¿Cuánto vendí hoy?').tasks[0], '2026-10-14', '2026-10-14');
});

test('H5-FIX2 high-value query uses the approved segment filter and explains its independence from risk', () => {
  const plan = route('¿Cuáles son mis clientes de alto valor?');
  assert.equal(plan.tasks[0].skillId, 'get_customer_intelligence');
  assert.equal(plan.tasks[0].args.metric, 'spend');
  assert.equal(plan.tasks[0].args.segment, 'TOP_HIGH_VALUE');
  const answer = renderV3('get_customer_intelligence', { metadata: { asOf: '2026-10-12', dataMode: 'HISTORICAL' },
    data: { items: [{ customerCode: 'CLI-001', displayName: 'Cliente Uno', segment: 'TOP_HIGH_VALUE', totalSpentCents: 10000 }] } }, plan.tasks[0].args);
  assert.match(answer, /alto valor/i);
  assert.match(answer, /riesgo de inactividad.*categor[ií]a distinta/i);
  assert.doesNotMatch(answer, /AT_RISK|TOP_HIGH_VALUE/);
});
