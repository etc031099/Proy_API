'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { buildGroundedContext, validateGroundedOutput } = require('../src/agents/groundedContext');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { handleGrounded } = require('../src/agents/grounded');
const { safeGroundedDiagnostic, logGroundedValidation } = require('../src/agents/groundedDiagnostic');
const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
const { createAgentExecution } = require('../src/agents/execution');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { createAgentMessagesHandler } = require('../src/controllers/agentMessagesController');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { V3 } = require('../src/services/v3IntelligenceService');
const question = '¿Qué productos debería reponer esta semana y por qué?';
const binding = { ...V3, operationalDate: '2026-10-15' };
const inventory = [
  ['ABA-ACE-001', 'Primor', 11, 0, 7.16, 'MEDIUM', 18],
  ['ABA-ACE-002', 'Cocinero', 7, 0, 5.03, 'HIGH', 24],
  ['ABA-ARR-001', 'Arroz Costeño', 17, 57, 3.42, 'MEDIUM', 12]
].map(([sku, productName, onHand, incoming, daysCover, level, recommendedQty]) => ({ sku, productName,
  stock: { onHand, incoming }, coverage: { daysCover }, risk: { level }, recommendation: { recommendedQty } }));
const rows = [
  { skillId: 'get_inventory_intelligence', result: { status: 'READY', data: { items: inventory } } },
  { skillId: 'get_product_forecast', result: { status: 'READY', data: { forecastSource: 'MOVING_AVERAGE_28', items: [
    { sku: 'ABA-ACE-001', expectedUnitsNext7d: 10.75 }, { sku: 'ABA-ACE-002', expectedUnitsNext7d: 9.75 },
    { sku: 'ABA-ARR-001', expectedUnitsNext7d: 34.75 }] } } },
  { skillId: 'get_supplier_intelligence', result: { status: 'READY', data: { items: [
    { supplierCode: 'SUP-05', displayName: 'Proveedor de prueba', productsSupplied: [{ sku: 'ABA-ACE-002' }] }] } } }
];
rows.forEach(row => { row.result.metadata = { asOf: binding.operationalDate, dataMode: 'LIVE' }; });
const context = buildGroundedContext({ question, plan: buildGroundedPlan(question, binding), results: rows, binding });
const output = (interpretation = 'Priorizaría Cocinero.', advisoryRecommendation = 'Revisa las 24 unidades sugeridas.') => ({
  observations: [{ evidenceRefs: ['E1', 'E2', 'E3'], interpretation, advisoryRecommendation }], limitations: []
});
const validate = value => validateGroundedOutput(JSON.stringify(value), context);

test('J2G grounded recommendation and nonliteral interpretation pass', () => {
  assert.ok(validate(output()));
  assert.ok(validate(output('Cocinero requiere atención por su riesgo alto y ausencia de entradas.', 'Priorizaría Cocinero.')));
});
for (const qty of [18, 24, 12]) test(`J2G Inventory recommendedQty ${qty} is authorized`, () => {
  assert.ok(validate(output('Hay candidatos para revisión.', `Revisa la cantidad sugerida de ${qty} unidades.`)));
});
test('J2G exact facts, rounded decimals, derived comparisons and linguistic cardinals pass', () => {
  assert.ok(validate(output('Cocinero tiene cobertura de 5,03 días, menor que los 7,16 días de Primor; su riesgo HIGH supera MEDIUM.',
    'Arroz tiene 57 entradas pendientes, más que 0; revisaría primero los productos sin entradas.')));
  assert.ok(validate(output('Primor tiene 7,2 días de cobertura.', 'Revisaría dos productos entre los tres candidatos.')));
  assert.ok(validate(output('Stock: 11, 7 y 17. Cobertura: 7.16, 5.03 y 3.42 días.', 'La demanda prevista es 10.75, 9.75 y 34.75 unidades.')));
});
for (const [claim, reason] of [
  ['Compra 9999 unidades.', 'UNSUPPORTED_NUMBER'], ['Prioriza ABA-FAKE-999.', 'UNKNOWN_ENTITY'],
  ['El proveedor SUP-99 abastece Cocinero.', 'UNKNOWN_ENTITY'],
  ['FP-Growth demuestra causalidad confirmada.', 'UNSUPPORTED_SEMANTIC_CLAIM']
]) test(`J2G unsupported claim rejected: ${reason}`, () => {
  assert.throws(() => validate(output(claim)), error => error.validationReason === reason
    && error.validationField === 'observations[0].interpretation');
});
test('J2G supplier claims require the actually cited supplier evidence', () => {
  const missing = output('Consulta las condiciones de SUP-05 antes de decidir.');
  missing.observations[0].evidenceRefs = ['E1', 'E2'];
  assert.throws(() => validate(missing), error => error.validationReason === 'UNKNOWN_ENTITY');
});

// Synthetic prose/usage, not a recovered cloud response or tokenizer measurement.
const grouped = 'Cocinero tiene riesgo alto y cobertura de 5,03 días, frente a los 7,16 días de Primor, cuyo riesgo es medio. '
  + 'Ambos carecen de entradas pendientes y sus cantidades sugeridas son 24 y 18 unidades. '
  + 'Arroz Costeño tiene riesgo medio, cobertura de 3,42 días y 57 unidades pendientes; su cantidad sugerida es 12. '
  + 'La demanda esperada es 9,75 para Cocinero, 10,75 para Primor y 34,75 para Arroz. '
  + 'Estas diferencias permiten revisar prioridades considerando las entradas de cada candidato.';
const providerFor = content => createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'fictional-only' },
  fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_tokens, 300);
    return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content, reasoning_content: 'PRIVATE-REASONING' } }],
      usage: { prompt_tokens: 1374, completion_tokens: 242, total_tokens: 1616,
        prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1374 } }) };
  } });
test('J2G valid grouped prose above former 360-character cap is accepted with 242 tokens/stop', async () => {
  assert.ok(grouped.length > 360 && grouped.length < 900);
  const generated = await providerFor(JSON.stringify(output(grouped))).generate({ route: 'GROUNDED_LLM',
    messages: [{ role: 'user', content: '{}' }], maxTokens: 300, temperature: 0 });
  assert.equal(generated.responseDiagnostic.finishReason, 'stop');
  assert.equal(generated.usage.outputTokens, 242); assert.equal(generated.usage.totalTokens, 1616);
  assert.ok(validateGroundedOutput(generated.text, context));
});
test('J2G length and safety bounds remain enforced with distinct reasons', () => {
  assert.throws(() => validate(output('x'.repeat(901))), error => error.validationReason === 'OUTPUT_TEXT_TOO_LONG');
  const oversized = output('x'.repeat(400), 'y'.repeat(400));
  oversized.observations = Array.from({ length: 3 }, () => structuredClone(oversized.observations[0]));
  assert.throws(() => validate(oversized), error => error.validationReason === 'OUTPUT_TEXT_TOO_LONG');
  assert.throws(() => validate(output('Lee https://example.test/private')), error => error.validationReason === 'UNSAFE_CONTENT');
  const invalidLimit = output(); invalidLimit.limitations = ['Una limitación no verificada.'];
  assert.throws(() => validate(invalidLimit), error => error.validationReason === 'LIMITATION_NOT_ALLOWED'
    && error.validationField === 'limitations[0]');
  assert.throws(() => validateGroundedOutput('{', context), error => error.validationReason === 'CONTENT_JSON_INVALID');
  assert.throws(() => validate({}), error => error.validationReason === 'OUTPUT_SCHEMA_INVALID');
});
test('J2G rejected synthesis logs and projects only safe diagnostics; known paid usage survives', async t => {
  const logs = []; t.mock.method(console, 'info', (...values) => logs.push(values.join(' ')));
  const provider = providerFor(JSON.stringify(output('Compra 9999 unidades.')));
  const execution = createAgentExecution({ context: createAgentRequestContext({ businessId: V3.businessId,
    user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } },
  { conversationId: randomUUID() }), neutralProvider: provider, dependencies: { models: {} } });
  const response = await handleGrounded({ message: question, context: {}, service: { resolveContext: async () => binding },
    run: async (_agent, id) => rows.find(row => row.skillId === id).result, execution });
  const diagnostic = publicResponse(response).grounded.responseDiagnostic;
  assert.equal(diagnostic.validationReason, 'UNSUPPORTED_NUMBER');
  assert.equal(diagnostic.validationField, 'observations[0].interpretation');
  assert.equal(diagnostic.validationPassed, false); assert.equal(diagnostic.finishReason, 'stop');
  assert.equal(diagnostic.contentPresent, true); assert.equal(diagnostic.usagePresent, true);
  assert.equal(diagnostic.provider, 'deepseek'); assert.equal(diagnostic.model, 'deepseek-flash');
  assert.equal(execution.getUsage().totalTokens, 1616);
  const logged = JSON.parse(logs.find(line => line.startsWith('[GroundedValidation]')).slice('[GroundedValidation] '.length));
  assert.deepEqual(logged.groundedValidation, diagnostic);
  assert.doesNotMatch(JSON.stringify(logged), /PRIVATE-REASONING|fictional-only|Compra 9999|observations":/);
  assert.doesNotMatch(response.answer, /9999/);
});
test('J2G unexpected diagnostic payload is sanitized for logs and public HTTP response', async t => {
  const logs = []; t.mock.method(console, 'info', (...values) => logs.push(values.join(' ')));
  const source = { validationResult: 'REJECTED', validationReason: 'PRIVATE-SECRET', validationField: 'PRIVATE-FIELD',
    contentPresent: true, contentLength: 100, finishReason: 'stop', usagePresent: true,
    prompt: 'PRIVATE-PROMPT', raw: 'PRIVATE-RAW', reasoning_content: 'PRIVATE-REASONING', validationValue: 'PRIVATE-VALUE' };
  logGroundedValidation(source);
  let body;
  await createAgentMessagesHandler({ enabled: true, orchestrator: { handle: async () => ({ answer: 'Hechos conservados.',
    grounded: { route: 'GROUNDED_LLM', responseDiagnostic: source, prompt: 'PRIVATE-PROMPT' } }) } })(
  { body: { message: question }, get: () => undefined }, { json: value => { body = value; } });
  assert.equal(body.data.grounded.responseDiagnostic.validationReason, 'OTHER');
  assert.equal(body.data.grounded.responseDiagnostic.contentPresent, true);
  assert.equal(body.data.grounded.responseDiagnostic.validationField, undefined);
  assert.doesNotMatch(JSON.stringify({ body, logs }), /PRIVATE-/);
  assert.deepEqual(safeGroundedDiagnostic(source), body.data.grounded.responseDiagnostic);
});
