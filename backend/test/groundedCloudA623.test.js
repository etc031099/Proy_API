'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGroundedOutput } = require('../src/agents/groundedContext');
const { safeGroundedDiagnostic } = require('../src/agents/groundedDiagnostic');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const contextFor = () => ({ evidence: [{ ref: 'E1', skillId: 'get_inventory_intelligence', facts: { items: [{
  sku: 'BEB-GAS-001', productName: 'Coca-Cola Sabor Original 500 ml', stock: { onHand: 13 },
  coverage: { daysCover: 1.67 }, risk: { level: 'HIGH' }, recommendation: { recommendedQty: 102 }
}] } }], allowedLimitations: [] });
const validate = (text, context = contextFor(), field = 'advisoryRecommendation') => validateGroundedOutput(JSON.stringify({
  observations: [{ evidenceRefs: ['E1'], interpretation: 'Tienes 13 unidades.', advisoryRecommendation: 'Revisa los hechos.', [field]: text }],
  limitations: [] }), context);

for (const text of ['Prioriza la reposición.', 'Conviene vigilar el inventario.', 'El riesgo es alto.',
  'La cobertura es insuficiente.', 'Presta atención a este producto.', 'El sistema recomienda reponer 102 unidades.',
  'Vale la pena vigilar este producto y revisar su cobertura.', 'Conviene vigilar este producto por su riesgo alto.',
  'Presta atención a este producto. Considera reponer.', 'Presta atención a este producto! Considera reponer.',
  'El producto merece atención por su cobertura baja y riesgo alto.',
  'Conviene vigilar este producto porque tiene riesgo alto.', 'Vale la pena vigilar este producto; considera la reposición.'
]) test(`A6.2.3 operational prose is not a labelled identity: ${text}`, () => assert.doesNotThrow(() => validate(text)));

for (const [text, reason] of [
  ['Compra a Distribuidora Fantasma.', 'UNKNOWN_ENTITY'], ['Compra Coca-Cola Premium X.', 'UNKNOWN_ENTITY'],
  ['Vende Coca-Cola XYZ.', 'UNKNOWN_ENTITY'], ['El cliente Juan Desconocido compra esto.', 'UNKNOWN_ENTITY'],
  ['Compra 150 unidades.', 'UNSUPPORTED_NUMBER'], ['El proveedor entrega mañana.', 'UNKNOWN_ENTITY'],
  ['Te quedarás sin stock mañana.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['Revisa BEB-GAS-999.', 'UNKNOWN_ENTITY'], ['El producto Fantasma es importante.', 'UNKNOWN_ENTITY'],
  ['Vigila este producto y compra a Distribuidora Fantasma.', 'UNKNOWN_ENTITY'],
  ['Presta atención a este producto. El cliente Juan Desconocido compra esto.', 'UNKNOWN_ENTITY'],
  ['El producto «Fantasma» requiere atención.', 'UNKNOWN_ENTITY'], ['El producto "Y" requiere atención.', 'UNKNOWN_ENTITY']
]) test(`A6.2.3 commercial entities and unsupported claims remain protected: ${text}`, () =>
  assert.throws(() => validate(text), error => error.validationReason === reason));

test('A6.2.3 names must come from cited evidence, not a known word prefix', () => {
  assert.doesNotThrow(() => validate('Compra Coca-Cola.'));
  assert.doesNotThrow(() => validate('Compra Coca-Cola Sabor Original 500 ml.'));
  assert.throws(() => validate('Compra Coca-Cola Premium X.'), error => error.validationReason === 'UNKNOWN_ENTITY');
  const context = contextFor();
  context.evidence.push({ ref: 'E2', skillId: 'get_inventory_intelligence', facts: { items: [{ productName: 'Fantasma Premium' }] } });
  assert.throws(() => validate('Compra Fantasma Premium.', context), error => error.validationReason === 'UNKNOWN_ENTITY');
});
for (const [label, type] of [['producto', 'PRODUCT'], ['cliente', 'CUSTOMER'], ['proveedor', 'SUPPLIER'], ['marca', 'UNKNOWN']])
  test(`A6.2.3 labelled ${label} rejection exposes closed type, never name`, () => {
    let rejection;
    try { validate(`El ${label} fantasía necesita atención.`); } catch (error) { rejection = error; }
    assert.equal(rejection.entityReason, 'UNKNOWN_LABELLED_ENTITY');
    assert.equal(rejection.labelledEntityType, type);
    const diagnostic = safeGroundedDiagnostic({ ...rejection, validationResult: 'REJECTED' });
    const projected = publicResponse({ grounded: { responseDiagnostic: diagnostic } }).grounded.responseDiagnostic;
    assert.equal(projected.labelledEntityType, type);
    assert.equal(projected.validationField, 'observations[0].advisoryRecommendation');
    assert.doesNotMatch(JSON.stringify(projected), /fantasía|necesita/);
  });
test('A6.2.3 arbitrary diagnostic types are discarded', () => {
  assert.equal(safeGroundedDiagnostic({ validationReason: 'UNKNOWN_ENTITY', entityReason: 'UNKNOWN_LABELLED_ENTITY',
    labelledEntityType: 'PRIVATE_NAME' }).labelledEntityType, undefined);
});
test('A6.2.3 labelled rejection type survives real synthesis fallback without storing generated prose', async () => {
  const { handleGrounded } = require('../src/agents/grounded');
  const inventory = { status: 'PARTIAL', metadata: {}, data: contextFor().evidence[0].facts };
  const forecast = { status: 'READY', metadata: {}, data: { method: 'RIDGE_REGRESSION', horizonDays: 7,
    items: [{ sku: 'BEB-GAS-001', predictionUnits: 55.36, horizonDays: 7 }] } };
  let calls = 0;
  const response = await handleGrounded({ message: 'Interpreta el producto', context: {}, service: {},
    resolvedBinding: { operationalDate: '2026-10-21' }, resolvedPlan: { route: 'GROUNDED_LLM',
      responseIntent: 'product_interpretation', skills: ['get_inventory_intelligence', 'get_product_forecast'], tasks: [
        { agent: 'inventory', skillId: 'get_inventory_intelligence', args: {} },
        { agent: 'forecast', skillId: 'get_product_forecast', args: {} }] },
    run: async agent => agent === 'inventory' ? inventory : forecast,
    execution: { hasGroundedProvider: () => true, generateGrounded: async () => {
      calls++; return { text: JSON.stringify({ observations: [{ evidenceRefs: ['E1'], interpretation: 'Tienes 13 unidades.',
        advisoryRecommendation: 'El proveedor entrega mañana.' }], limitations: [] }), provider: 'deepseek', model: 'offline' };
    }, recordGroundedSynthesis: accepted => assert.equal(accepted, false) } });
  assert.equal(calls, 1);
  assert.equal(response.grounded.generation.status, 'REJECTED');
  assert.equal(response.grounded.responseDiagnostic.labelledEntityType, 'SUPPLIER');
  assert.doesNotMatch(response.answer, /proveedor entrega mañana/);
  assert.equal(publicResponse(response).grounded.responseDiagnostic.labelledEntityType, 'SUPPLIER');
});
