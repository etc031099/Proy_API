'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGroundedContext, validateGroundedOutput } = require('../src/agents/groundedContext');
const { safeGroundedDiagnostic } = require('../src/agents/groundedDiagnostic');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { handleGrounded } = require('../src/agents/grounded');
const I = 'get_inventory_intelligence', F = 'get_product_forecast';
const binding = { operationalDate: '2026-10-21' };
const results = () => [
  { skillId: I, result: { status: 'PARTIAL', metadata: { asOf: binding.operationalDate, dataMode: 'LIVE' }, data: { items: [{ sku: 'BEB-GAS-001',
    productName: 'Coca-Cola Sabor Original 500 ml', stock: { onHand: 13, incoming: 0 },
    coverage: { daysCover: 1.67 }, risk: { level: 'HIGH' },
    recommendation: { recommendedQty: 102, shouldReorder: true } }] } } },
  { skillId: F, result: { status: 'READY', metadata: { asOf: binding.operationalDate, dataMode: 'LIVE' }, data: { method: 'RIDGE_REGRESSION', horizonDays: 7,
    items: [{ sku: 'BEB-GAS-001', predictionUnits: 55.36, horizonDays: 7, activeModelStatus: 'ACTIVE',
      modelVersion: 1, featureVersion: 'RIDGE_CAUSAL27_V1' }] } } }
];
const plan = { skills: [I, F], tasks: [{ agent: 'inventory', skillId: I, args: {} },
  { agent: 'forecast', skillId: F, args: {} }], responseIntent: 'product_interpretation', route: 'GROUNDED_LLM' };
const contextFor = (evidence = results()) => buildGroundedContext({ question: 'Interpreta el producto', plan, results: evidence, binding });
const output = (interpretation, advisoryRecommendation = 'Revisa la reposición sugerida.') => JSON.stringify({
  observations: [{ evidenceRefs: ['E1', 'E2'], interpretation, advisoryRecommendation }], limitations: [] });
const validate = (phrase, context = contextFor()) => validateGroundedOutput(output(phrase), context);
const validateAdvice = (advice, context = contextFor()) => validateGroundedOutput(output('Tienes 13 unidades.', advice), context);

for (const advice of ['Conviene priorizar la reposición.', 'Deberías prestar atención a este producto.',
  'Conviene evitar una cobertura insuficiente.', 'Prioriza Reposición antes de decidir.', 'Consulta Inventario antes de decidir.',
  'Revisa Cobertura antes de decidir.']) test(`A6.2.2 advisory inference is not a catalogue entity: ${advice}`,
  () => assert.doesNotThrow(() => validateAdvice(advice)));

for (const [advice, reason, entityReason] of [
  ['Compra a Distribuidora X mañana.', 'UNKNOWN_ENTITY', 'UNKNOWN_PURCHASE_ENTITY'],
  ['Compra 150 unidades.', 'UNSUPPORTED_NUMBER'],
  ['El proveedor tarda 2 días.', 'UNSUPPORTED_NUMBER'],
  ['Revisa SKU-UNKNOWN-999.', 'UNKNOWN_ENTITY', 'UNKNOWN_IDENTIFIER'],
  ['Prioriza Fantasía.', 'UNKNOWN_ENTITY', 'UNKNOWN_NAME_AFTER_ACTION'],
  ['Prioriza Reposición Fantasía.', 'UNKNOWN_ENTITY', 'UNKNOWN_NAME_AFTER_ACTION'],
  ['El cliente fantasía necesita atención.', 'UNKNOWN_ENTITY', 'UNKNOWN_LABELLED_ENTITY'],
  ['El producto fantasía necesita atención.', 'UNKNOWN_ENTITY', 'UNKNOWN_LABELLED_ENTITY']
]) test(`A6.2.2 advisory still rejects unsupported entities/numbers: ${advice}`, () => {
  assert.throws(() => validateAdvice(advice), error => {
    assert.equal(error.validationReason, reason);
    assert.equal(error.validationField, 'observations[0].advisoryRecommendation');
    if (entityReason) assert.equal(error.entityReason, entityReason);
    return true;
  });
});
test('A6.2.2 generic advisory exception requires support and never exempts factual names', () => {
  const evidence = results(); evidence[0].result.data.items[0].recommendation.recommendedQty = null;
  assert.throws(() => validateAdvice('Prioriza Reposición.', contextFor(evidence)), error => error.validationReason === 'UNKNOWN_ENTITY');
  assert.throws(() => validate('Prioriza Reposición.'), error => error.validationReason === 'UNKNOWN_ENTITY');
});
test('A6.2.2 entity diagnostics use closed enums only, never the rejected name', () => {
  let error;
  try { validateAdvice('Compra a Distribuidora X mañana.'); } catch (rejection) { error = rejection; }
  const diagnostic = safeGroundedDiagnostic({ ...error, validationResult: 'REJECTED' });
  assert.equal(diagnostic.entityReason, 'UNKNOWN_PURCHASE_ENTITY');
  assert.equal(publicResponse({ grounded: { responseDiagnostic: diagnostic } }).grounded.responseDiagnostic.entityReason, 'UNKNOWN_PURCHASE_ENTITY');
  assert.doesNotMatch(JSON.stringify(diagnostic), /Distribuidora|mañana/);
  assert.equal(safeGroundedDiagnostic({ validationReason: 'UNKNOWN_ENTITY', entityReason: 'private arbitrary name' }).entityReason, undefined);
});
test('A6.2.2 rejected advisory category survives actual synthesis and history with factual fallback', async () => {
  const evidence = results(); let calls = 0;
  const response = await handleGrounded({ message: 'Interpreta el producto', context: {}, service: {}, resolvedPlan: plan,
    resolvedBinding: binding, run: async (_agent, skill) => evidence.find(row => row.skillId === skill).result,
    execution: { hasGroundedProvider: () => true, generateGrounded: async () => {
      calls++; return { text: output('Tienes 13 unidades.', 'Compra a Distribuidora X mañana.'), provider: 'deepseek', model: 'offline' };
    }, recordGroundedSynthesis: accepted => assert.equal(accepted, false) } });
  assert.equal(calls, 1); assert.equal(response.grounded.generation.status, 'REJECTED');
  assert.equal(response.grounded.responseDiagnostic.entityReason, 'UNKNOWN_PURCHASE_ENTITY');
  assert.equal(publicResponse(response).grounded.responseDiagnostic.entityReason, 'UNKNOWN_PURCHASE_ENTITY');
  assert.doesNotMatch(response.answer, /Distribuidora/);
  assert.match(response.answer, /se conservan los hechos/);
});

for (const phrase of [
  'Tienes 13 unidades y una cobertura de 1.67 días; Ridge LIVE proyecta 55.36 unidades en 7 días.',
  'El riesgo es alto y el sistema recomienda reponer 102 unidades.',
  'Hay un riesgo elevado.', 'Sí, conviene prestarle atención. Existe riesgo de quedarse corto.',
  'El stock cubre menos de dos días.', 'El stock cubre menos de 2 días.',
  'La cobertura estimada es de menos de 2 días.',
  'La cobertura es menos de 1.7 días.'
]) test(`A6.2.2 supported fact/paraphrase/inference: ${phrase}`, () => assert.doesNotThrow(() => validate(phrase)));

for (const [phrase, reason] of [
  ['Quedan 50 unidades.', 'UNSUPPORTED_NUMBER'],
  ['El proveedor garantiza la entrega mañana.', 'UNKNOWN_ENTITY'],
  ['Te quedarás sin stock mañana.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['Ridge LIVE pronostica 1 día.', 'UNSUPPORTED_NUMBER'],
  ['Isolation Forest confirma el fraude.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['La regla de asociación demuestra causalidad.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['Probabilidad de abandono.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['El stock cubre menos de 1 día.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['La cobertura es menos de un día.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['El stock cubre menos de 2 días y quedan 2 unidades.', 'UNSUPPORTED_NUMBER'],
  ['La cobertura es de 2 días.', 'UNSUPPORTED_NUMBER'],
  ['El riesgo es bajo.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['No tienes razón: el stock cubre menos de 2 días.', 'UNSUPPORTED_SEMANTIC_CLAIM']
]) test(`A6.2.2 rejects unsupported claim: ${phrase}`, () => assert.throws(() => validate(phrase), error => error.validationReason === reason));

for (const coverage of [null, undefined, -1, '1.67']) test(`A6.2.2 unknown/invalid coverage never licenses an inference: ${coverage}`, () => {
  const evidence = results(); evidence[0].result.data.items[0].coverage.daysCover = coverage;
  assert.throws(() => validate('El stock cubre menos de dos días.', contextFor(evidence)),
    error => error.validationReason === 'UNSUPPORTED_SEMANTIC_CLAIM');
});
test('A6.2.2 comparison requires cited single-product inventory, not unrelated numbers or another SKU', () => {
  const context = contextFor();
  const uncited = JSON.parse(output('El stock cubre menos de 2 días.')); uncited.observations[0].evidenceRefs = ['E2'];
  assert.throws(() => validateGroundedOutput(JSON.stringify(uncited), context), error => error.validationReason === 'UNSUPPORTED_SEMANTIC_CLAIM');
  const evidence = results(); evidence[0].result.data.items.push({ sku: 'OTHER-SKU', coverage: { daysCover: 10 } });
  assert.throws(() => validate('El stock cubre menos de dos días.', contextFor(evidence)), error => error.validationReason === 'UNSUPPORTED_SEMANTIC_CLAIM');
});
test('A6.2.2 missing material limitation is still rendered by the real synthesis path', async () => {
  const evidence = results(); let calls = 0;
  const response = await handleGrounded({ message: 'Interpreta el producto', context: {}, service: {}, resolvedPlan: plan,
    resolvedBinding: binding, run: async (_agent, skill) => evidence.find(row => row.skillId === skill).result,
    execution: { hasGroundedProvider: () => true, generateGrounded: async () => {
      calls++; return { text: output('El stock cubre menos de 2 días.'), provider: 'deepseek', model: 'offline' };
    }, recordGroundedSynthesis: accepted => assert.equal(accepted, true) } });
  assert.equal(calls, 1); assert.equal(response.grounded.generation.status, 'SUCCEEDED');
  assert.match(response.answer, /información analítica consultada está marcada como parcial/);
});
test('A6.2.2 rejection diagnostics retain exact stage/check through history without generated prose', () => {
  let rejected;
  try { validate('Te quedarás sin stock mañana.'); } catch (error) { rejected = error; }
  const diagnostic = safeGroundedDiagnostic({ ...rejected, validationResult: 'REJECTED', prompt: 'PRIVATE', input: 'PRIVATE' });
  const projected = publicResponse({ grounded: { responseDiagnostic: diagnostic } });
  assert.equal(projected.grounded.responseDiagnostic.validationReason, 'UNSUPPORTED_SEMANTIC_CLAIM');
  assert.equal(projected.grounded.responseDiagnostic.validationLayer, 'GROUNDING');
  assert.equal(projected.grounded.responseDiagnostic.validationField, 'observations[0].interpretation');
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|mañana/);
});
