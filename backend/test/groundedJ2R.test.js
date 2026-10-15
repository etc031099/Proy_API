'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyGrounded, buildGroundedPlan } = require('../src/agents/groundedRouting');
const { fixture, binding } = require('./helpers/j2nGroundedFixture');
const { B } = require('./fixtures/j2nAcceptanceMatrix');

const interpretiveQueries = [
  '¿Cómo han evolucionado las ventas recientemente?',
  '¿Cómo vienen las ventas?',
  '¿Qué tendencia observas en las ventas?',
  '¿Las ventas subieron?',
  '¿Qué debería vigilar en las ventas?',
  '¿Qué debería revisar en las ventas?',
  '¿Cómo han evolucionado las ventas y qué debería vigilar?',
  '¿Qué tendencias observas?'
];

for (const query of interpretiveQueries) test(`J2R interpretive sales query uses grounded comparison: ${query}`, () => {
  const classification = classifyGrounded(query);
  assert.equal(classification.route, 'GROUNDED_LLM');
  assert.equal(classification.responseIntent, 'sales_evolution');
  assert.deepEqual(classification.skills, [B]);
  const plan = buildGroundedPlan(query, binding);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].skillId, B);
  assert.equal(plan.tasks[0].args.mode, 'compare');
  assert.deepEqual({ startDate: plan.tasks[0].args.startDate, endDate: plan.tasks[0].args.endDate },
    { startDate: '2026-09-16', endDate: '2026-10-15' });
});

for (const query of ['¿Cuánto vendí?', '¿Cuáles son mis ventas?', 'Dame el resumen de ventas.', '¿Cuántos tickets tuve?']) {
  test(`J2R descriptive sales query remains deterministic: ${query}`, async t => {
    const f = fixture(), result = await f.run(query);
    assert.equal(classifyGrounded(query).route, 'DETERMINISTIC');
    assert.equal(f.requests.length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].skill, B);
    assert.equal(f.calls[0].args.mode, 'summary');
    assert.equal(result.usage.llmCalls, 0);
    assert.equal(result.usage.totalTokens, 0);
    assert.match(result.answer, /Ventas|ventas/);
  });
}

for (const query of [
  '¿Cómo han evolucionado las ventas recientemente y qué debería vigilar?',
  '¿Qué debería vigilar en las ventas?',
  '¿Las ventas subieron?'
]) test(`J2R uses comparable revenue and ticket evidence for interpretation: ${query}`, async t => {
  const f = fixture(), result = await f.run(query);
  assert.deepEqual(f.calls.map(row => row.skill), [B]);
  assert.equal(f.calls[0].args.mode, 'compare');
  assert.equal(f.requests.length, 1);
  assert.equal(result.grounded.responseDiagnostic.validationResult, 'ACCEPTED');
  assert.match(result.answer, /mayores que en el período comparable/);
  if (/vigilar/.test(query)) assert.match(result.answer, /Vigila ventas, unidades, tickets y ticket promedio/);
  assert.equal(result.usage.llmCalls, 1);
});

test('J2R does not call a provider or assert direction when equivalent-period comparison is unavailable', async t => {
  const f = fixture({ modifyResult(result, skill) {
    if (skill !== B) return;
    result.data.comparisonMode = 'NONE';
    result.data.previousPeriod = null;
    result.data.trends = Object.fromEntries(['revenue', 'unitsSold', 'ticketCount', 'averageTicket']
      .map(key => [key, { value: null, previousValue: null, comparisonAvailable: false, comparableDurations: true }]));
  } });
  const result = await f.run('¿Cómo han evolucionado las ventas recientemente y qué debería vigilar?');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.mode, 'compare');
  assert.equal(f.requests.length, 0); assert.equal(result.usage.llmCalls, 0); assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.grounded.interpretationMode, 'DETERMINISTIC_LIMITATION');
  assert.match(result.answer, /S\/ 5000\.00/);
  assert.match(result.answer, /no permite afirmar si las ventas subieron o bajaron/);
  assert.match(result.answer, /Para vigilar, puedes seguir ventas, unidades, tickets y ticket promedio/);
  assert.doesNotMatch(result.answer, /crecieron|cayeron|aumentaron|disminuyeron/);
});

test('J2R preserves usable sales comparison when only gross-margin cost coverage is partial', async t => {
  const f = fixture({ status: 'PARTIAL', modifyResult(result, skill) {
    if (skill !== B) return;
    result.data.availabilityStatus = 'PARTIAL';
    result.data.costCoverage = { unknownSaleLines: 3, unsupportedCurrency: false };
    result.data.comparisonCostCoverage = { knownSaleLines: 4, unknownSaleLines: 1, unsupportedCurrency: false };
    result.data.kpis.grossMarginPct = null;
  } });
  const result = await f.run('¿Cómo vienen las ventas y qué debería vigilar?');
  assert.equal(f.requests.length, 1);
  const context = JSON.parse(f.requests[0].messages[1].content);
  assert.ok(context.allowedLimitations.some(row => row.code === 'ANALYTICS_PARTIAL'));
  assert.match(result.answer, /mayores que en el período comparable/);
  assert.equal(result.usage.llmCalls, 1);
});

test('J2R comparison without equal windows is treated as insufficient evidence', async t => {
  const f = fixture({ modifyResult(result, skill) {
    if (skill !== B) return;
    result.data.previousPeriod.equalDuration = false;
    for (const trend of Object.values(result.data.trends)) trend.comparableDurations = false;
  } });
  const result = await f.run('¿Las ventas subieron?');
  assert.equal(f.requests.length, 0);
  assert.equal(result.usage.llmCalls, 0);
  assert.match(result.answer, /no permite afirmar si las ventas subieron o bajaron/);
});
