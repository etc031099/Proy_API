'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGroundedContext, validateGroundedOutput } = require('../src/agents/groundedContext');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { binding } = require('./helpers/j2nGroundedFixture');

const customerQuery = '¿Qué clientes debería intentar recuperar y por qué?';
const customers = { items: [
  { customerCode: 'CLI-ELENA', customerName: 'Elena Rojas Quispe', lastPurchaseDate: '2026-08-22', ticketCount: 96,
    spendCents: 186261, averageTicketCents: 1940 },
  { customerCode: 'CLI-SAMUEL', customerName: 'Samuel Vargas León', lastPurchaseDate: '2026-09-02', ticketCount: 41,
    spendCents: 78846, averageTicketCents: 1923 },
  { customerCode: 'CLI-MARTIN', customerName: 'Martín Salazar Huamán', lastPurchaseDate: '2026-09-10', ticketCount: 105,
    spendCents: 212624, averageTicketCents: 2025 }
] };
const makeContext = (period, facts = customers) => {
  const plan = buildGroundedPlan(customerQuery, binding);
  return buildGroundedContext({ question: customerQuery, plan, binding, results: [{ skillId: 'get_customer_intelligence', result: {
    status: 'READY', data: facts, metadata: { asOf: '2026-10-15', ...(period ? { period } : {}) }
  } }] });
};
const validate = (context, interpretation) => validateGroundedOutput(JSON.stringify({ observations: [{ evidenceRefs: ['E1'],
  interpretation, advisoryRecommendation: 'Revisa la evidencia antes de decidir.' }], limitations: [] }), context);

test('J2O: no explicit customer period resolves to the backend rolling 30-day inclusive range', () => {
  const plan = buildGroundedPlan(customerQuery, binding);
  const task = plan.tasks.find(row => row.skillId === 'get_customer_intelligence');
  assert.deepEqual({ startDate: task.args.startDate, endDate: task.args.endDate },
    { startDate: '2026-09-16', endDate: '2026-10-15' });
});

test('J2O: customer interpretation may cite 30 days when the cited metadata spans 30 inclusive days', () => {
  const context = makeContext({ startDate: '2026-09-16', endDate: '2026-10-15' });
  assert.equal(context.evidence[0].scope.analysisWindowDays, 30);
  assert.doesNotThrow(() => validate(context, 'En los últimos 30 días, estos clientes muestran señales de inactividad observada.'));
});

for (const days of [60, 90]) test(`J2O: unsupported ${days}-day window remains rejected`, () => {
  const context = makeContext({ startDate: '2026-09-16', endDate: '2026-10-15' });
  assert.throws(() => validate(context, `En los últimos ${days} días, estos clientes muestran señales de inactividad observada.`),
    error => error.validationReason === 'UNSUPPORTED_NUMBER' && error.unsupportedNumberDetails[0].pattern === 'QUANTITY_WITH_UNIT');
});

test('J2O: period duration is typed evidence and cannot authorize an unrelated unit quantity', () => {
  const context = makeContext({ startDate: '2026-09-16', endDate: '2026-10-15' });
  assert.throws(() => validate(context, 'Se recomienda recuperar 30 unidades.'),
    error => error.validationReason === 'UNSUPPORTED_NUMBER');
});

test('J2O: unsupported percentages remain rejected', () => {
  const context = makeContext({ startDate: '2026-09-16', endDate: '2026-10-15' });
  assert.throws(() => validate(context, 'La tasa de abandono observada es 80 %.'),
    error => error.validationReason === 'UNSUPPORTED_NUMBER');
  assert.throws(() => validate(context, 'Recupera estos clientes con un descuento del 25 %.'),
    error => error.validationReason === 'UNSUPPORTED_NUMBER');
  assert.throws(() => validate(context, 'Hay probabilidad de abandono del 80 %.'),
    error => error.validationReason === 'UNSUPPORTED_SEMANTIC_CLAIM');
});

test('J2O: exact customer dates remain supported, while calendar components are not business metrics', () => {
  const context = makeContext({ startDate: '2026-09-16', endDate: '2026-10-15' });
  assert.doesNotThrow(() => validate(context,
    'Las últimas compras fueron 2026-08-22, 2026-09-02 y 2026-09-10; la consulta llega al 2026-10-15.'));
  assert.throws(() => validate(context, 'El año 2026, el mes 10 y el día 15 representan compras observadas.'),
    error => error.validationReason === 'UNSUPPORTED_NUMBER');
});

test('J2O: only valid date metadata produces an analysis window', () => {
  assert.equal(makeContext(null).evidence[0].scope.analysisWindowDays, undefined);
  assert.equal(makeContext({ startDate: '2026-10-16', endDate: '2026-10-15' }).evidence[0].scope.analysisWindowDays, undefined);
  assert.equal(makeContext({ startDate: '2026-02-30', endDate: '2026-03-01' }).evidence[0].scope.analysisWindowDays, undefined);
});

for (const days of [1, 7, 14]) test(`J2O: forecast horizon ${days} days remains grounded`, () => {
  const context = buildGroundedContext({ question: `Pronóstico para ${days} días`, binding,
    plan: { skills: ['get_product_forecast'], responseIntent: 'forecast' }, results: [{ skillId: 'get_product_forecast', result: {
      status: 'READY', data: { horizonDays: days, method: 'MOVING_AVERAGE_28' }, metadata: { asOf: '2026-10-15' }
    } }] });
  assert.doesNotThrow(() => validateGroundedOutput(JSON.stringify({ observations: [{ evidenceRefs: ['E1'],
    interpretation: `El pronóstico cubre ${days} días.`, advisoryRecommendation: 'Revisa la proyección antes de planificar.' }], limitations: [] }), context));
});

test('J2O: unsupported 28-day operational forecast retains the existing clarification policy', () => {
  const plan = buildGroundedPlan('Analiza ventas, inventario y forecast para 28 días', binding);
  assert.deepEqual(plan.tasks, []);
  assert.match(plan.clarificationQuestion, /1, 7 o 14/);
});
