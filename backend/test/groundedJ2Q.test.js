'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGroundedContext, validateGroundedOutput } = require('../src/agents/groundedContext');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const binding = { operationalDate: '2026-10-15', historicalCutoff: '2026-10-12', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'fixture' };
const C = 'get_customer_intelligence', B = 'get_business_analytics', F = 'get_product_forecast';
const result = (skillId, data, period) => ({ skillId, result: { status: 'READY', data, metadata: { asOf: binding.operationalDate, ...(period ? { period } : {}) } } });
const contextFor = (results = [result(C, { items: [{ customerName: 'Elena Rojas Quispe', ticketCount: 96 }] },
  { startDate: '2026-09-16', endDate: '2026-10-15' })]) => buildGroundedContext({ question: 'Interpreta los datos',
  plan: { skills: results.map(row => row.skillId), responseIntent: 'fixture' }, binding, results });
const validate = (interpretation, context = contextFor(), evidenceRefs = ['E1']) => validateGroundedOutput(JSON.stringify({
  observations: [{ evidenceRefs, interpretation, advisoryRecommendation: 'Revisa los hechos antes de decidir.' }], limitations: [] }), context);

for (const phrase of ['En los últimos 30 días, revisa los datos.', 'Durante 30 días, revisa los datos.',
  'El período analizado comprende 30 días.', 'En una ventana de 30 días, revisa los datos.',
  'El análisis cubre un período de 30 días.', 'El período analizado es de 30 días.', 'El análisis corresponde a 30 días.',
  'La revisión comprende 30 dias.', 'Una duración de 30días.']) {
  test(`J2Q value + day unit accepts: ${phrase}`, () => assert.doesNotThrow(() => validate(phrase)));
}
for (const phrase of ['Durante 60 días.', 'Una ventana de 90 días.', 'Se requieren 30 unidades.', 'Se observan 30 clientes.',
  'Un descuento del 30 %.', 'Importe S/ 30.', 'Stock 30.', 'Un peso de 30 kg.', 'Un volumen de 30 ml.',
  'El período comprende 30 semanas.', 'Importe S/ 30 días.', 'Proporción 30 % días.']) {
  test(`J2Q typed duration never authorizes: ${phrase}`, () => assert.throws(() => validate(phrase),
    error => error.validationReason === 'UNSUPPORTED_NUMBER'));
}
test('J2Q unrelated numeric facts cannot authorize a duration, and unknown temporal numbers retain sanitized diagnostics', () => {
  const context = contextFor([result(C, { items: [{ ticketCount: 60, spendCents: 9000 }] }, { startDate: '2026-09-16', endDate: '2026-10-15' })]);
  for (const phrase of ['Durante 60 días.', 'Durante 90 días.']) assert.throws(() => validate(phrase, context), error => {
    assert.equal(error.validationReason, 'UNSUPPORTED_NUMBER');
    assert.equal(error.unsupportedNumberDetails[0].pattern, 'QUANTITY_WITH_UNIT'); return true;
  });
});
test('J2Q only the cited evidence may authorize a temporal duration', () => {
  const context = contextFor([
    result(C, { items: [{ ticketCount: 96 }] }, { startDate: '2026-09-16', endDate: '2026-10-15' }),
    result(B, { kpis: { unitsSold: 45 } }, { startDate: '2026-07-18', endDate: '2026-10-15' })
  ]);
  assert.equal(context.evidence[1].scope.analysisWindowDays, 90);
  assert.throws(() => validate('Una ventana de 90 días.', context), error => error.validationReason === 'UNSUPPORTED_NUMBER');
  assert.doesNotThrow(() => validate('Una ventana de 90 días.', context, ['E2']));
  assert.throws(() => validate('Una ventana de 30 días.', context, ['E2']), error => error.validationReason === 'UNSUPPORTED_NUMBER');
});
for (const [days, phrase] of [[1, 'Horizonte de 1 día.'], [7, 'Horizonte de 7 días.'], [14, 'Durante 14 días.']]) {
  test(`J2Q cited forecast horizon ${days} is grounded`, () => {
    const context = contextFor([result(F, { horizonDays: days, method: 'MOVING_AVERAGE_28' })]);
    assert.doesNotThrow(() => validate(phrase, context));
    assert.throws(() => validate('Horizonte de 28 días.', context), error => error.validationReason === 'UNSUPPORTED_NUMBER');
  });
}
test('J2Q day-valued coverage, recency and supplier metrics preserve approved decimal rounding', () => {
  const context = contextFor([result(C, { recencyDays: 35, items: [] })]);
  assert.doesNotThrow(() => validate('Recencia de 35 días.', context));
  const measured = { evidence: [{ ref: 'E1', facts: { coverage: { daysCover: 7.16 }, leadTime: { averageDays: 4.25 } } }], allowedLimitations: [] };
  assert.doesNotThrow(() => validate('Cobertura de 7,2 días y plazo de 4,25 días.', measured));
  assert.throws(() => validate('Cobertura de 7 días.', measured), error => error.validationReason === 'UNSUPPORTED_NUMBER');
});
test('J2Q leaves the operational 28-day routing policy unchanged', () => {
  const plan = buildGroundedPlan('Analiza ventas, inventario y forecast para 28 días', binding);
  assert.deepEqual(plan.tasks, []); assert.match(plan.clarificationQuestion, /1, 7 o 14/);
});
