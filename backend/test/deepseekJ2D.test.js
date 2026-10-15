'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
const { buildGroundedContext, validateGroundedOutput } = require('../src/agents/groundedContext');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { handleGrounded } = require('../src/agents/grounded');
const { createAgentExecution } = require('../src/agents/execution');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { V3 } = require('../src/services/v3IntelligenceService');
const question = '¿Qué productos debería reponer esta semana y por qué?';
const binding = { ...V3, operationalDate: '2026-10-15' };
const plan = buildGroundedPlan(question, binding);
const inventory = [
  ['ABA-ACE-001', 'Aceite Vegetal Primor Premium 900 ml', 11, 0, 7.16, 'MEDIUM', 18],
  ['ABA-ACE-002', 'Aceite Vegetal Cocinero 900 ml', 7, 0, 5.03, 'HIGH', 24],
  ['ABA-ARR-001', 'Arroz Costeño Añejo Extra 750 g', 17, 57, 3.42, 'MEDIUM', 12]
].map(([sku, productName, stock, incoming, daysCover, level, recommendedQty]) => ({ sku, productName,
  stock: { onHand: stock, incoming }, coverage: { daysCover }, risk: { level }, recommendation: { recommendedQty, shouldReorder: true } }));
const results = [
  { skillId: 'get_inventory_intelligence', result: { status: 'READY', data: { items: inventory }, metadata: {} } },
  { skillId: 'get_product_forecast', result: { status: 'READY', data: { forecastSource: 'MOVING_AVERAGE_28', items: [
    { sku: 'ABA-ARR-001', expectedUnitsNext7d: 34.75 }, { sku: 'ABA-ACE-001', expectedUnitsNext7d: 10.75 },
    { sku: 'ABA-ACE-002', expectedUnitsNext7d: 9.75 }] }, metadata: {} } },
  // Existing synthetic J2B supplier fixture; not claimed to be the cloud supplier response.
  { skillId: 'get_supplier_intelligence', result: { status: 'READY', data: { items: [
    { supplierCode: 'SUP-05', displayName: 'Proveedor ficticio', pendingOrderCount: 29,
      productsSupplied: [{ sku: 'ABA-ACE-002' }] }] }, metadata: {} } }
];
results.forEach(row => { row.result.metadata = { asOf: binding.operationalDate, dataMode: 'LIVE' }; });
const compact = buildGroundedContext({ question, plan, results, binding });
const output = () => ({ observations: [
  { evidenceRefs: ['E1', 'E2'], interpretation: 'Cocinero tiene riesgo HIGH, cobertura de 5,0 días y ninguna entrada pendiente.',
    advisoryRecommendation: 'Prioriza revisar ABA-ACE-002: la cantidad sugerida es 24 y MA28 espera 9,75 unidades.' },
  { evidenceRefs: ['E1', 'E2', 'E3'], interpretation: 'Primor tiene cobertura de 7,2 días; Arroz tiene 57 unidades pendientes y demanda esperada de 34,75.',
    advisoryRecommendation: 'Revisa las entradas de Arroz antes de pedir; consulta las condiciones de SUP-05 antes de decidir.' }
], limitations: [] });
const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
  prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600,
  prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 0 } };
const envelope = patch => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: {
  role: 'assistant', content: JSON.stringify(output()), reasoning_content: 'PRIVATE-REASONING' } }], usage, ...patch });
const request = { route: 'GROUNDED_LLM', messages: [{ role: 'user', content: '{}' }], maxTokens: 300, temperature: 0 };
const provider = data => createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'fictional-only' }, fetchImpl: async (_url, options) => {
  const body = JSON.parse(options.body);
  assert.equal(body.reasoning_effort, 'none'); assert.equal(body.max_tokens, 300);
  return { ok: true, status: 200, json: async () => data };
} });
test('J2D exact inventory/forecast + fixture supplier: paraphrase, combined evidence, decimal rounding accepted', async () => {
  const result = await provider(envelope()).generate(request);
  assert.ok(validateGroundedOutput(result.text, compact));
  assert.equal(result.responseDiagnostic.finishReason, 'stop');
  assert.equal(result.responseDiagnostic.usageParseResult, 'COMPLETE');
  assert.equal(result.usage.totalTokens, 1200); assert.equal(result.usage.cachedInputTokens, 400);
  assert.equal(result.usage.cacheMissInputTokens, 600); assert.equal(result.usage.reasoningTokens, 0);
  assert.ok(result.estimatedCostRangeUsd.max > 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-REASONING|fictional-only/);
});
for (const [claim, reason] of [['Pide 9999 unidades.', 'UNSUPPORTED_NUMBER'], ['Revisa ABA-FAKE-999.', 'UNKNOWN_ENTITY'],
  ['Hay fraude confirmado.', 'UNSUPPORTED_SEMANTIC_CLAIM'], ['FP-Growth demuestra causalidad confirmada.', 'UNSUPPORTED_SEMANTIC_CLAIM']])
  test(`J2D unsupported claim denied: ${reason} ${claim}`, () => {
    const bad = output(); bad.observations[0].interpretation = claim;
    assert.throws(() => validateGroundedOutput(JSON.stringify(bad), compact), error => error.validationReason === reason);
  });
test('J2D valid paraphrase need not copy evidence fields verbatim', () => {
  const paraphrase = output(); paraphrase.observations[0].interpretation = 'Cocinero merece atención prioritaria por su riesgo alto y ausencia de entradas.';
  assert.ok(validateGroundedOutput(JSON.stringify(paraphrase), compact));
});
test('J2D missing usage is unknown, not zero, distinct from invalid usage', async () => {
  const absent = await provider(envelope({ usage: undefined })).generate(request);
  assert.equal(absent.responseDiagnostic.usagePresent, false); assert.equal(absent.responseDiagnostic.usageParseResult, 'ABSENT');
  assert.equal(absent.usage.totalTokens, null); assert.equal(absent.estimatedCostUsd, null);
  assert.equal(absent.estimatedCostRangeUsd, undefined);
  await assert.rejects(provider(envelope({ usage: { ...usage, total_tokens: 9999 } })).generate(request), error =>
    error.responseDiagnostic.usageParseResult === 'INVALID' && error.responseDiagnostic.validationReason === 'USAGE_INVALID');
});
test('J2D incomplete cache breakdown leaves cost unknown while retaining known token totals', async () => {
  const result = await provider(envelope({ usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } })).generate(request);
  assert.equal(result.usage.inputTokens, 1000); assert.equal(result.usage.cachedInputTokens, null);
  assert.equal(result.estimatedCostUsd, null); assert.equal(result.estimatedCostRangeUsd, undefined);
});
test('J2D malformed usage is distinguished from absent usage, without retaining provider fields', async () => {
  for (const bad of ['private-invalid-usage', { ...usage, prompt_tokens: '1000' }])
    await assert.rejects(provider(envelope({ usage: bad })).generate(request), error => {
      assert.equal(error.responseDiagnostic.usagePresent, true);
      assert.equal(error.responseDiagnostic.usageParseResult, 'INVALID');
      assert.doesNotMatch(JSON.stringify(error), /private-invalid-usage/); return true;
    });
});
test('J2D model mismatch has an explicit reason and does not discard known consumption', async () => {
  await assert.rejects(provider(envelope({ model: 'unknown-model' })).generate(request), error => {
    assert.equal(error.responseDiagnostic.validationReason, 'MODEL_MISMATCH');
    assert.equal(error.usage.totalTokens, 1200); return true;
  });
});
test('J2D presentation rounding does not allow arbitrary decimals or integer rounding', () => {
  for (const value of ['La cobertura es 7,3 días.', 'La cobertura es 5 días.']) {
    const bad = output(); bad.observations = [bad.observations[0]]; bad.observations[0].interpretation = value;
    assert.throws(() => validateGroundedOutput(JSON.stringify(bad), compact), error => error.validationReason === 'UNSUPPORTED_NUMBER');
  }
});
for (const [finish, content, reason] of [['length', '{"observations":', 'OUTPUT_TRUNCATED'], ['stop', '', 'CONTENT_EMPTY']])
  test(`J2D ${reason} rejects synthesis but preserves paid usage through execution`, async () => {
    const data = envelope({ choices: [{ finish_reason: finish, message: { role: 'assistant', content, reasoning_content: 'PRIVATE-REASONING' } }] });
    const execution = createAgentExecution({ context: createAgentRequestContext({ businessId: V3.businessId,
      user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } }, { conversationId: randomUUID() }),
    neutralProvider: provider(data), dependencies: { models: {} } });
    await assert.rejects(execution.generateGrounded(request), error => error.responseDiagnostic.validationReason === reason);
    const recorded = execution.getUsage(); assert.equal(recorded.totalTokens, 1200);
    assert.ok(recorded.estimatedCostRangeUsd.max > 0); assert.equal(recorded.llmCalls, 1);
    assert.doesNotMatch(JSON.stringify(recorded), /PRIVATE-REASONING/);
  });
test('J2D JSON error differs from schema mismatch and invented number', () => {
  for (const [text, reason] of [['not json', 'CONTENT_JSON_INVALID'], ['{}', 'OUTPUT_SCHEMA_INVALID']])
    assert.throws(() => validateGroundedOutput(text, compact), error => error.validationReason === reason);
});
test('J2D accepted synthesis is the main answer; sanitized diagnostics survive public projection', async () => {
  const p = provider(envelope()); let accepted;
  const response = await handleGrounded({ message: question, context: {}, service: { resolveContext: async () => binding },
    run: async (_agent, skillId) => results.find(row => row.skillId === skillId).result,
    execution: { hasGroundedProvider: () => true, generateGrounded: input => p.generate({ ...input, route: 'GROUNDED_LLM' }),
      recordGroundedSynthesis: value => { accepted = value; } } });
  assert.equal(accepted, true, JSON.stringify(response)); assert.ok(response.answer.startsWith('Cocinero'));
  assert.doesNotMatch(response.answer, /Inventario:|Interpretación y recomendaciones:|PRIVATE-REASONING/);
  const projected = publicResponse(response);
  assert.equal(projected.grounded.responseDiagnostic.validationResult, 'ACCEPTED');
  assert.equal(projected.grounded.responseDiagnostic.httpStatus, 200);
});
test('J2D grounding rejection retains safe adapter diagnostic and compact verified fallback', async () => {
  const bad = output(); bad.observations[0].interpretation = 'Compra 9999 unidades.';
  const p = provider(envelope({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(bad) } }] }));
  const response = await handleGrounded({ message: question, context: {}, service: { resolveContext: async () => binding },
    run: async (_agent, skillId) => results.find(row => row.skillId === skillId).result,
    execution: { hasGroundedProvider: () => true, generateGrounded: input => p.generate({ ...input, route: 'GROUNDED_LLM' }), recordGroundedSynthesis() {} } });
  assert.equal(response.grounded.responseDiagnostic.validationReason, 'UNSUPPORTED_NUMBER');
  assert.equal(response.grounded.responseDiagnostic.usageParseResult, 'COMPLETE');
  assert.match(response.answer, /se conservan los hechos/); assert.doesNotMatch(response.answer, /9999/);
});
