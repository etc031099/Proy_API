const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const baseline = require('../../docs/CONV-AUDIT-P3B.json');
const { readFixture, products, read } = require('./audit/p3bFixtures');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { routeForecastTemporalQuery } = require('../src/agents/forecastRouting');
const affected = baseline.cases.filter(row => row.severity === 'P1' && row.area === 'forecast');
const zero = result => { assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalTokens, 0); };
for (const row of affected) test(`P3C.1 P3B ${row.id}: ${row.input}`, async () => {
  const f = readFixture(), result = await f.run(row.input); zero(result); assert.equal(f.calls.length, 0);
  if (row.family === 'forecast_temporal_guard') { assert.equal(result.requiresClarification, true); assert.equal(result.usage.totalSkillCalls, 0); }
  else if (row.family === 'forecast_historical') {
    assert.equal(result.requiresClarification, false); assert.match(result.answer, /M5-FOODS_2_096/);
    assert.equal(result.evidence.find(row => row.skillId === 'get_demand_forecast').recordCount, 1);
    assert.ok(!products.slice(1).some(product => result.answer.includes(product.sku)));
  } else { assert.equal(result.intent, 'ml_analytics'); assert.ok(result.actions.some(row => row.skillId === 'analyze_demand_forecast')); }
});
for (const period of ['próximo mes', 'el mes que viene', 'mes siguiente', 'la próxima semana', 'semana que viene',
  'mañana', 'pasado mañana', 'en 7 días', 'en un mes']) test(`P3C.1 future ${period} preserves explicit/context product without skills`, async () => {
  const f = readFixture(), conversationId = randomUUID();
  await f.run('¿Cuál es la predicción de food 96?', conversationId);
  for (const query of [`¿Y ${period}?`, `¿Cuál es la predicción ${period} de M5-FOODS_3_511?`]) {
    const result = await f.run(query, conversationId); zero(result);
    assert.equal(result.requiresClarification, true); assert.equal(result.usage.totalSkillCalls, 0);
    assert.match(result.answer, /histórico|replay/);
    assert.match(result.answer, query.includes('511') ? /M5-FOODS_3_511/ : /M5-FOODS_2_096/);
  }
});
test('P3C.1 general forecast allows batch while contextual and ambiguous references never silently use it', async () => {
  const f = readFixture(), id = randomUUID();
  const general = await f.run('forecast de todos los productos'); zero(general);
  assert.equal(general.evidence.find(row => row.skillId === 'get_demand_forecast').recordCount, 6);
  const explicit = await f.run('forecast general de food 96'); zero(explicit);
  assert.equal(explicit.evidence.find(row => row.skillId === 'get_demand_forecast').recordCount, 1);
  await f.run('¿Cuál es la predicción de food 96?', id);
  const followup = await f.run('¿y para ese producto?', id); zero(followup);
  assert.equal(followup.evidence.find(row => row.skillId === 'get_demand_forecast').recordCount, 1);
  const ambiguous = await f.run('demanda prevista de food 210'); zero(ambiguous);
  assert.equal(ambiguous.suggestions.length, 2); assert.ok(!ambiguous.actions.some(row => row.skillId === 'get_demand_forecast'));
  const absent = await f.run('demanda prevista de food 196'); zero(absent);
  assert.equal(absent.requiresClarification, true); assert.ok(!absent.actions.some(row => row.skillId === 'get_demand_forecast'));
});
for (const date of ['2026-10-15', '15 de octubre de 2026', '2026-05-20']) test(`P3C.1 explicit date ${date} never invents daily forecast`, () => {
  const plan = routeForecastTemporalQuery(`predicción para ${date} de M5-FOODS_2_096`, {}, new Date('2026-10-09T00:00:00Z'), 'ML-CLOUD-DEMO-V2');
  assert.ok(plan.clarificationQuestion); assert.equal(plan.agent, 'coordinator');
});
test('P3C.1 historical anchor request remains supported and foreign tenant stays scoped', async () => {
  const plan = routeDeterministically('forecast histórico de M5-FOODS_2_096 escenario 2026-05-17', {}, new Date('2026-10-09T00:00:00Z'), undefined, undefined, 'ML-CLOUD-DEMO-V2');
  assert.equal(plan.intent, 'demand_forecast'); assert.equal(plan.selector.sku, products[0].sku);
  const f = readFixture(), response = await f.run('demanda prevista de food 96', randomUUID(), read.req('B'));
  zero(response); assert.ok(!response.answer.includes(products[0].name));
});
