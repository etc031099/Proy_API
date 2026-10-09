const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentOrchestrator } = require('../src/agents/orchestrator');
const { createConversationMemory } = require('../src/agents/memory');
const { createAgentExecution } = require('../src/agents/execution');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { withActionAssistant } = require('../src/automations/assistant');
const { snapshot, publicResponse } = require('../src/services/agentHistoryProjection');
const id = n => n.toString(16).padStart(24, '0');
const req = (businessId = 'ML-CLOUD-DEMO-V2', user = 99) => ({ businessId,
  user: { _id: id(user), businessId, role: 'user', isActive: true } });
const rows = Array.from({ length: 12 }, (_, n) => ({ productId: id(n + 1), sku: `M5-FOODS_3_${String(n).padStart(3, '0')}`,
  name: `Alimento ${n}`, department: n < 8 ? 'FOODS_3' : 'HOBBIES_1', category: n < 8 ? 'FOODS' : 'HOBBIES',
  stockAtAnchor: n + 1, predictedDemand7d: n * 2, recommendedQty: n === 0 ? 2 : n,
  inventoryStatus: n === 0 ? 'REPONER' : 'OK', mlStatus: 'READY', safetyStock: 2, salesLast7Days: 1 }));
function fixture({ products = rows, status = 'READY', memory = createConversationMemory(), serviceError } = {}) {
  const calls = [], events = [];
  const runtime = createAgentOrchestrator({ memory, clock: () => new Date('2026-10-09T00:00:00Z'), onEvent: event => events.push(event),
    provider: { generateStructured() { throw Error('Unexpected Gemini'); }, generateWithTools() { throw Error('Unexpected Gemini'); } },
    dependencies: { forecastService: { async getDemandForecast(input) {
      calls.push(input); if (serviceError) throw serviceError;
      return { status, anchorOperationalDate: '2026-05-17', model: { name: 'demand_forecast_v1', horizonDays: 7 },
        products: input.businessId === 'ML-CLOUD-DEMO-V2' ? structuredClone(products) : [] };
    } } } });
  const send = (message, conversationId, request = req()) => runtime.handle(request, { message, ...(conversationId ? { conversationId } : {}) });
  return { runtime, send, calls, events };
}
const zero = response => { assert.equal(response.code, null); assert.equal(response.usage.totalLlmCalls, 0);
  assert.equal(response.usage.totalTokens, 0); assert.equal(response.usage.metricsComplete, true); };
for (const query of ['¿Qué productos tendrán mayor demanda?', 'Muéstrame los productos con mayor demanda prevista',
  'Top 5 por demanda', '¿Cuál tiene la mayor predicción?']) test(`deterministic top: ${query}`, async () => {
  const f = fixture(), result = await f.send(query); zero(result);
  assert.match(result.answer, /M5-FOODS_3_011/); assert.equal(result.agent, 'analyst'); assert.equal(f.calls.length, 1);
  assert.equal(result.actions[0].skillId, 'analyze_demand_forecast'); assert.match(result.evidence[0].label, /m5-ca3-cloud-demo-v2/);
  assert.equal(result.evidence[0].asOf, '2026-05-17');
});
test('top N, sorted results, bounded pages and ordinal selection snapshot', async () => {
  const f = fixture(), first = await f.send('Top 3 por demanda'); zero(first);
  assert.match(first.answer, /Mostrando 1–3 de 12/);
  const next = await f.send('otros 3', first.conversationId); zero(next);
  assert.match(next.answer, /Mostrando 4–6 de 12/); assert.doesNotMatch(next.answer, /M5-FOODS_3_011/);
});
test('demand exceeding stock does not substitute recommended quantity', async () => {
  const f = fixture(), result = await f.send('¿En cuáles la demanda prevista supera el inventario?'); zero(result);
  assert.match(result.answer, /diferencia demanda−stock/); assert.doesNotMatch(result.answer, /M5-FOODS_3_000/);
});
for (const query of ['¿Qué productos tendrán más demanda que stock?', 'Productos donde no alcanza el stock']) {
  test(`stock comparison phrasing: ${query}`, async () => {
    const result = await fixture().send(query); zero(result);
    assert.match(result.answer, /diferencia demanda−stock/);
  });
}
test('no missing predictions is explicit, not an invented error', async () => {
  const result = await fixture().send('¿Qué productos no tienen predicción?'); zero(result);
  assert.match(result.answer, /12 READY; no encontré productos sin predicción/);
});
test('non READY is preserved without fabricated numeric prediction', async () => {
  const products = [...rows, { ...rows[0], sku: 'NOT-READY', mlStatus: 'INSUFFICIENT_HISTORY', predictedDemand7d: null, recommendedQty: null }];
  const result = await fixture({ products }).send('Muéstrame los productos sin forecast'); zero(result);
  assert.match(result.answer, /NOT-READY.*INSUFFICIENT_HISTORY/);
});
test('comparison of SKUs and priority follow-up are deterministic', async () => {
  const f = fixture(); const first = await f.send(`Compara ${rows[0].sku} con ${rows[1].sku}`); zero(first);
  assert.match(first.answer, /Mayor demanda prevista:.*001/); assert.match(first.answer, /Mayor necesidad de reposición:.*000/);
  const next = await f.send('¿Cuál debería comprar primero?', first.conversationId); zero(next);
  assert.equal(next.intent, 'ml_analytics'); assert.match(next.answer, /no evalúa costos/);
});
test('comparison resolves exact names from tenant batch', async () => {
  const result = await fixture().send('Compara Alimento 0 y Alimento 1'); zero(result); assert.match(result.answer, /Mayor demanda prevista/);
});
test('ambiguous comparison gives bounded SKU candidates, no guessing or Gemini', async () => {
  const result = await fixture().send('Compara Alimento y Alimento 1');
  assert.equal(result.requiresClarification, true); assert.match(result.answer, /varias coincidencias/);
  assert.ok(result.suggestions.length <= 5); assert.match(result.suggestions[0].message, /^Compara M5-/);
  assert.ok(!JSON.stringify(result.suggestions).includes(id(1)));
  assert.equal(result.usage.totalTokens, 0); assert.equal(result.usage.totalLlmCalls, 0);
});
test('unknown SKU cannot reveal another tenant product', async () => {
  const result = await fixture().send('Compara M5-OTHER_001 con Alimento 1');
  assert.equal(result.requiresClarification, true); assert.match(result.answer, /No encontré/);
});
test('department filters before sorting and category uses structured lineage', async () => {
  const f = fixture(); const result = await f.send('Top 5 del departamento FOODS_3'); zero(result);
  assert.match(result.answer, /Mostrando 1–5 de 8/); assert.match(result.answer, /M5-FOODS_3_007/);
  assert.doesNotMatch(result.answer, /M5-FOODS_3_011/);
  const category = await f.send('Top 5 por demanda de HOBBIES'); zero(category);
  assert.match(category.answer, /Mostrando 1–4 de 4/);
});
test('unknown department is empty, no inference from SKU', async () => {
  const result = await fixture().send('Top 5 del departamento FOODS_99'); zero(result);
  assert.match(result.answer, /No encontré productos/);
});
test('unrecognized department and oversized top ask safe deterministic results', async () => {
  zero(await fixture().send('Top 5 del departamento UNKNOWN'));
  const result = await fixture().send('Top 100 por demanda');
  assert.equal(result.requiresClarification, true); assert.equal(result.usage.totalTokens, 0);
});
test('comparison with non READY never chooses a numerical winner', async () => {
  const result = await fixture({ products: [{ ...rows[0], mlStatus: 'MISSING_LINEAGE' }, rows[1]] })
    .send(`Compara ${rows[0].sku} y ${rows[1].sku}`); zero(result);
  assert.match(result.answer, /No puedo comparar demanda/); assert.doesNotMatch(result.answer, /Mayor demanda prevista:/);
});
test('costs remain explicitly out of scope without provider calls', async () => {
  const f = fixture(); const result = await f.send('¿Cuánto cuesta reponer?');
  assert.equal(result.requiresClarification, true); assert.equal(f.calls.length, 0); assert.equal(result.usage.totalTokens, 0);
});
test('missing department metadata asks clarification rather than parsing SKU', async () => {
  const result = await fixture({ products: rows.map(row => ({ ...row, department: null })) }).send('Top 5 FOODS_3');
  assert.equal(result.requiresClarification, true); assert.match(result.answer, /lineage/);
});
test('summary computes totals only from actual response and preserves anchor', async () => {
  const result = await fixture().send('Resúmeme el forecast'); zero(result);
  assert.match(result.answer, /12 productos; 12 READY/); assert.match(result.answer, /Stock al corte: 78/);
  assert.match(result.answer, /Demanda prevista: 132/); assert.match(result.answer, /17 de mayo de 2026/);
  assert.doesNotMatch(result.answer, /octubre|actualmente|hoy/);
});
for (const query of ['forecast actual', '¿qué pasará hoy?', 'predicción de esta semana']) test(`historical clarification: ${query}`, async () => {
  const f = fixture(), result = await f.send(query); assert.equal(result.requiresClarification, true);
  assert.match(result.answer, /replay histórico/); assert.equal(f.calls.length, 0); assert.equal(result.usage.totalTokens, 0);
});
test('follow-up department + persisted snapshot + paging through action wrapper', async () => {
  const f = fixture(); const first = await f.send('Muéstrame los 5 con mayor demanda');
  const filtered = await f.send('¿Y solo de FOODS_3?', first.conversationId); zero(filtered);
  const state = snapshot(await f.runtime.getContextSnapshot(req(), first.conversationId));
  const restored = fixture(); await restored.runtime.restoreContext(req(), first.conversationId, state);
  const wrapper = withActionAssistant(restored.runtime, { prepare() { throw Error('unexpected write'); } });
  const next = await wrapper.handle(req(), { message: 'ver más', conversationId: first.conversationId }); zero(next);
  assert.match(next.answer, /Mostrando 6–8 de 8/);
});
test('expired context asks clarification instead of guessing comparison', async () => {
  let now = 0; const f = fixture({ memory: createConversationMemory({ now: () => now, ttlMs: 10 }) });
  const first = await f.send('Compara Alimento 0 y Alimento 1'); now = 11;
  const next = await f.send('¿Cuál de estos dos tendrá mayor demanda?', first.conversationId);
  assert.equal(next.requiresClarification, true); assert.equal(next.usage.totalTokens, 0);
});
test('V1/V2 batch and memory isolation, body/message cannot change business', async () => {
  const f = fixture(), first = await f.send('Top 3 por demanda');
  const other = await f.send('Resúmeme el forecast', first.conversationId, req('ML-CLOUD-DEMO'));
  zero(other); assert.match(other.answer, /0 productos/);
  assert.equal((await f.runtime.getContextSnapshot(req('ML-CLOUD-DEMO'), first.conversationId)).lastForecastAnalytics.mode, 'summary');
  await f.send('Muéstrame mayor demanda del forecast de ML-CLOUD-DEMO');
  assert.equal(f.calls.at(-1).businessId, 'ML-CLOUD-DEMO-V2');
});
test('invalid args, business injection, unauthorized agent rejected before read', async () => {
  for (const [agentId, args] of [['analyst', { mode: 'top', businessId: 'OTHER' }], ['analyst', { mode: 'top', limit: 21 }],
    ['operations', { mode: 'top' }], ['coordinator', { mode: 'summary' }]]) {
    const execution = createAgentExecution({ context: createAgentRequestContext(req()) });
    await assert.rejects(execution.executeSkill({ agentId, skillId: 'analyze_demand_forecast', args }));
  }
});
test('empty forecast and ML_NOT_READY stay safe', async () => {
  zero(await fixture({ products: [] }).send('Top 5 por demanda'));
  const result = await fixture({ status: 'ML_NOT_READY' }).send('Resúmeme el forecast'); zero(result);
  assert.match(result.answer, /no tiene un escenario ML listo/);
});
test('service unavailable is sanitized and never synthesizes', async () => {
  const result = await fixture({ serviceError: { code: 'ML_SERVICE_UNAVAILABLE', message: 'secret' } }).send('Top 5 por demanda');
  assert.equal(result.code, 'AGENT_SKILL_FAILED'); assert.doesNotMatch(result.answer, /secret/);
  assert.equal(result.usage.totalTokens, 0);
});
test('public/history projection preserves evidence without adding private data', async () => {
  const f = fixture(); const result = await f.send('Top 5 por demanda');
  const projected = publicResponse(result); assert.equal(projected.evidence[0].asOf, '2026-05-17');
  assert.match(projected.evidence[0].label, /escenario|m5-ca3/);
  assert.ok(f.events.some(event => event.type === 'skill_finished'));
});
test('candidate button resolves an ambiguous comparison through the existing safe public contract', async () => {
  const f = fixture(); const result = await f.send('Compara Alimento y Alimento 1');
  const visible = publicResponse(result); assert.ok(visible.suggestions.length);
  const selected = await f.send(visible.suggestions.find(row => row.detail !== rows[1].sku).message, result.conversationId);
  zero(selected); assert.match(selected.answer, /Mayor demanda prevista/);
});
test('new request does not inherit a previous department filter', async () => {
  const f = fixture(); const first = await f.send('Top 3 del departamento FOODS_3');
  const next = await f.send('Top 3 por demanda', first.conversationId); zero(next);
  assert.match(next.answer, /Mostrando 1–3 de 12/);
});
test('trusted local V2 fixture summary agrees with validated replay without production constants', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../ml/reports/scenario_cloud_demo_v2_manifest.json'), 'utf8'));
  const products = manifest.products.map(row => ({ productId: row.productId, sku: `M5-${row.item_id}`, name: row.displayName,
    category: row.cat_id, department: row.dept_id, stockAtAnchor: row.stock, predictedDemand7d: row.predictedDemand7d,
    recommendedQty: row.recommendedQty, inventoryStatus: row.inventoryStatus, mlStatus: 'READY' }));
  const result = await fixture({ products }).send('Resumen de predicción y reposición'); zero(result);
  assert.match(result.answer, /60 productos; 60 READY/);
  assert.match(result.answer, /OK: 24; VIGILAR: 3; REPONER: 33/);
  assert.match(result.answer, /Stock al corte: 815/);
});
