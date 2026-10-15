'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
const { buildGroundedContext, contextMetrics, validateGroundedOutput, projectFacts } = require('../src/agents/groundedContext');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { handleGrounded } = require('../src/agents/grounded');
const { V3 } = require('../src/services/v3IntelligenceService');
const I = 'get_inventory_intelligence', F = 'get_product_forecast', S = 'get_supplier_intelligence';
const question = '¿Qué productos debería reponer esta semana y por qué?';
const binding = { ...V3, operationalDate: '2026-10-15' }, plan = buildGroundedPlan(question, binding);
const inventory = [
  ['ABA-ACE-001', 'Aceite Primor', 11, 0, 7.16, 'MEDIUM', 18],
  ['ABA-ACE-002', 'Aceite Cocinero', 7, 0, 5.03, 'HIGH', 24],
  ['ABA-ARR-001', 'Arroz Costeño', 17, 57, 3.42, 'MEDIUM', 12]
].map(([sku, productName, onHand, incoming, daysCover, level, recommendedQty]) => ({ sku, productName,
  stock: { onHand, incoming }, coverage: { daysCover }, risk: { level }, recommendation: { recommendedQty, shouldReorder: true } }));
const unrelated = ['Nevado Bebidas', 'Meseta Bebidas', 'Amanecer Lácteos'].map((displayName, n) => ({
  supplierCode: `SUP-0${n + 1}`, displayName, pendingOrderCount: 29, purchaseOrderCount: 200,
  productsSupplied: Array.from({ length: 12 }, (_, j) => ({ sku: `BEB-GAS-${j + 1}`, name: `Bebida catálogo ${j + 1}` })) }));
const related = { supplierCode: 'SUP-05', displayName: 'Proveedor relacionado ficticio', leadTime: { averageDays: 4, sampleSize: 20 },
  productsSupplied: [{ sku: 'BEB-GAS-001' }, { sku: 'BEB-GAS-002' }, { sku: 'BEB-GAS-003' }, { sku: 'ABA-ACE-002' }] };
const resultRows = (suppliers = unrelated) => [
  { skillId: I, result: { status: 'READY', data: { items: inventory, total: 80, summary: { products: 80 } }, metadata: { asOf: binding.operationalDate, dataMode: 'LIVE' } } },
  { skillId: F, result: { status: 'READY', data: { method: 'MOVING_AVERAGE_28', items: [
    { sku: 'ABA-ARR-001', expectedUnitsNext7d: 34.75 }, { sku: 'ABA-ACE-001', expectedUnitsNext7d: 10.75 },
    { sku: 'ABA-ACE-002', expectedUnitsNext7d: 9.75 }, { sku: 'BEB-GAS-001', expectedUnitsNext7d: 100 }] }, metadata: { asOf: binding.operationalDate, dataMode: 'LIVE' } } },
  { skillId: S, result: { status: 'READY', data: { items: suppliers, total: 10 }, metadata: { asOf: binding.operationalDate, dataMode: 'LIVE' } } }
];
const compactFor = rows => buildGroundedContext({ question, plan, results: rows, binding });
// Visible text targets roughly 120–180 tokens; this is a prose-size fixture, not
// a tokenizer measurement or a real provider response.
const synthesis = () => ({ observations: [
  { evidenceRefs: ['E1', 'E2'], interpretation: 'Priorizaría Cocinero: tiene riesgo alto, cobertura de 5,03 días y ninguna entrada pendiente.',
    advisoryRecommendation: 'Revisa reponer las 24 unidades sugeridas; su demanda prevista es 9,75. Primor también merece atención: tiene 11 unidades, sin entradas y una sugerencia de 18; confirma la necesidad antes de preparar otra compra.' },
  { evidenceRefs: ['E1', 'E2'], interpretation: 'Con Arroz Costeño sería prudente considerar las entradas: ya hay 57 unidades pendientes, aunque la demanda prevista es 34,75.',
    advisoryRecommendation: 'Revisa esas entradas y su recepción antes de decidir otra compra. Estas son prioridades para evaluar, no operaciones ejecutadas.' }
], limitations: [] });
const usage = { prompt_tokens: 2085, completion_tokens: 150, total_tokens: 2235,
  prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2085 };
const envelope = (finish = 'stop', patch = {}) => ({ model: 'deepseek-flash', choices: [{ finish_reason: finish,
  message: { role: 'assistant', content: JSON.stringify(synthesis()) } }], usage, ...patch });
const providerFor = data => createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'fictional-only' }, fetchImpl: async (_url, options) => {
  assert.equal(JSON.parse(options.body).max_tokens, 300);
  return { ok: true, status: 200, json: async () => data };
} });
const request = { route: 'GROUNDED_LLM', messages: [{ role: 'user', content: '{}' }], maxTokens: 300, temperature: 0 };
test('J2E short natural synthesis passes without repeating all skill blocks', async () => {
  const result = await providerFor(envelope()).generate(request);
  const output = validateGroundedOutput(result.text, compactFor(resultRows()));
  const visible = output.observations.map(row => `${row.interpretation} ${row.advisoryRecommendation}`).join(' ');
  const words = visible.split(/\s+/).length;
  assert.ok(words >= 80 && words <= 120); assert.equal(result.responseDiagnostic.finishReason, 'stop');
  assert.doesNotMatch(visible, /Nevado|Meseta|Amanecer|Escenario V3|MOVING_AVERAGE_28/);
});
test('J2E reported 300-output usage plus explicit length rejects truncation and keeps usage/cost', async () => {
  const data = envelope('length', { usage: { ...usage, completion_tokens: 300, total_tokens: 2385 } });
  await assert.rejects(providerFor(data).generate(request), error => {
    assert.equal(error.responseDiagnostic.validationReason, 'OUTPUT_TRUNCATED');
    assert.equal(error.responseDiagnostic.finishReason, 'length'); assert.equal(error.usage.totalTokens, 2385);
    assert.ok(error.estimatedCostRangeUsd.max > 0); return true;
  });
});
test('J2E exactly 300 reported output tokens alone does not imply truncation', async () => {
  const result = await providerFor(envelope('stop', { usage: { ...usage, completion_tokens: 300, total_tokens: 2385 } })).generate(request);
  assert.ok(validateGroundedOutput(result.text, compactFor(resultRows())));
  assert.equal(result.responseDiagnostic.finishReason, 'stop');
});
test('J2E supplier relation is checked before array truncation and keeps only candidate products', () => {
  const rows = resultRows([...unrelated, related]), frozenBefore = JSON.stringify(rows), compact = compactFor(rows);
  const supplier = compact.evidence[2];
  assert.equal(supplier.facts.items.length, 1); assert.equal(supplier.facts.items[0].supplierCode, 'SUP-05');
  assert.deepEqual(supplier.facts.items[0].productsSupplied, [{ sku: 'ABA-ACE-002' }]);
  assert.equal(supplier.scope.supplierMetricScope, 'SUPPLIER_AGGREGATE');
  assert.equal(JSON.stringify(rows), frozenBefore); assert.ok(Object.isFrozen(supplier.facts.items));
});
test('J2E LIVE observed-SKU relation is usable without an entire catalogue', () => {
  const compact = compactFor(resultRows([{ supplierCode: 'SUP-05', productsSuppliedObserved: ['BEB-GAS-001', 'ABA-ACE-001'] }]));
  assert.deepEqual(compact.evidence[2].facts.items[0].productsSupplied, [{ sku: 'ABA-ACE-001' }]);
});
test('J2E unrelated global suppliers omitted explicitly; no claim that suppliers do not exist', () => {
  const compact = compactFor(resultRows()), supplier = compact.evidence[2];
  assert.equal(supplier.facts, null); assert.equal(supplier.omission, 'NO_CANDIDATE_SUPPLIER_EVIDENCE');
  assert.doesNotMatch(JSON.stringify(compact), /Nevado|Meseta|Amanecer|BEB-GAS-001/);
  const bad = synthesis(); bad.observations[0].evidenceRefs.push('E3');
  assert.throws(() => validateGroundedOutput(JSON.stringify(bad), compact));
});
test('J2E candidate context is smaller than original projection and keeps inventory/forecast facts', () => {
  const rows = resultRows(), compact = compactFor(rows);
  const original = JSON.parse(JSON.stringify(compact));
  original.evidence.forEach((row, index) => { row.facts = projectFacts(rows[index].result.data, row.skillId); delete row.omission; });
  const before = contextMetrics(original).bytes, after = contextMetrics(compact).bytes;
  assert.ok(after < before); assert.equal(compact.evidence[0].facts.items[2].stock.incoming, 57);
  assert.equal(compact.evidence[1].facts.items[0].expectedUnitsNext7d, 34.75);
  console.log('J2E_CONTEXT_BYTES', JSON.stringify({ before, after, saved: before - after, tokenCountIsEstimate: true }));
});
for (const claim of ['Pide 9999 unidades.', 'Revisa ABA-FAKE-999.']) test(`J2E still rejects unsupported claim: ${claim}`, () => {
  const bad = synthesis(); bad.observations[0].interpretation = claim;
  assert.throws(() => validateGroundedOutput(JSON.stringify(bad), compactFor(resultRows())));
});
for (const fail of [false, true]) test(`J2E compact prompt, same three READ skills, primary answer/fallback: ${fail}`, async () => {
  const rows = resultRows(), calls = []; let recorded;
  const p = providerFor(envelope(fail ? 'length' : 'stop'));
  const response = await handleGrounded({ message: question, context: {}, service: { resolveContext: async () => binding },
    run: async (_agent, skillId) => { calls.push(skillId); return rows.find(row => row.skillId === skillId).result; },
    execution: { hasGroundedProvider: () => true, recordGroundedSynthesis: accepted => { recorded = accepted; },
      generateGrounded: async input => {
        assert.match(input.messages[0].content, /Máximo 3 recomendaciones/); assert.match(input.messages[0].content, /100–180 tokens/);
        assert.match(input.messages[0].content, /no promesas para un SKU/);
        return p.generate({ ...input, route: 'GROUNDED_LLM' });
      } } });
  assert.deepEqual(calls, [I, F, S]); assert.equal(recorded, !fail);
  if (fail) { assert.ok(response.answer.startsWith('No pude generar')); assert.ok(response.answer.length < 700); assert.match(response.answer, /57/); }
  else { assert.ok(response.answer.startsWith('Priorizaría')); assert.doesNotMatch(response.answer, /stock 11|Escenario V3/); }
  assert.doesNotMatch(response.answer, /Nevado|Meseta|Amanecer/); assert.equal(response.pendingAction, undefined);
});
