'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGroundedOutput } = require('../src/agents/groundedContext');
const { safeGroundedDiagnostic, logGroundedValidation } = require('../src/agents/groundedDiagnostic');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const context = { question: '¿Qué productos debería reponer esta semana y por qué?', evidence: [
  { ref: 'E1', facts: { items: [
    { sku: 'ABA-ACE-001', productName: 'Aceite Vegetal Primor Premium 900 ml', stock: 11, pending: 0, coverageDays: 7.16, recommendedQty: 18 },
    { sku: 'ABA-ACE-002', productName: 'Aceite Vegetal Cocinero 900 ml', stock: 7, pending: 0, coverageDays: 5.03, recommendedQty: 24 },
    { sku: 'ABA-ARR-001', productName: 'Arroz Costeño Añejo Extra 750 g', stock: 17, pending: 57, coverageDays: 3.42, recommendedQty: 12 }
  ] } },
  { ref: 'E2', facts: { horizonDays: 7, items: [{ sku: 'ABA-ARR-001', expectedUnitsNext7d: 34.75 },
    { sku: 'ABA-ACE-001', expectedUnitsNext7d: 10.75 }, { sku: 'ABA-ACE-002', expectedUnitsNext7d: 9.75 }] } }
] };
const output = (interpretation, refs = ['E1', 'E2']) => JSON.stringify({ observations: [{ evidenceRefs: refs,
  interpretation, advisoryRecommendation: 'Priorizaría Cocinero.' }], limitations: [] });
const validate = (text, ctx = context, refs) => validateGroundedOutput(output(text, refs), ctx);
for (const text of ['Cocinero tiene 5,03 días de cobertura.', 'Cocinero tiene 5.03 días de cobertura.',
  'Primor tiene 7,2 días de cobertura.', 'La demanda es 34,8 unidades.', 'El sistema sugiere 24 unidades.',
  'Las cantidades sugeridas son 18, 24 y 12.', 'Para los próximos 7 días revisaría los candidatos.',
  'Aceite Vegetal Primor Premium 900 ml requiere revisión.', 'Aceite Cocinero 900 ml requiere revisión.',
  'Arroz Costeño 750 g tiene entradas pendientes.']) test(`J2I supported: ${text}`, () => {
  assert.ok(validate(text));
});
test('J2I integer rounding remains rejected under approved existing policy', () => {
  assert.throws(() => validate('Cocinero tiene aproximadamente 5 días de cobertura.'), { validationReason: 'UNSUPPORTED_NUMBER' });
});
for (const text of ['Se requieren 40 unidades.', 'Riesgo de 80 %.', 'Incremento de 25 %.',
  'Cocinero necesita 900 unidades.', 'Arroz requiere 750 unidades.', 'Aceite Cocinero 800 ml requiere revisión.',
  'Producto inventado 900 ml requiere revisión.']) test(`J2I unsupported: ${text}`, () => {
  assert.throws(() => validate(text), { validationReason: 'UNSUPPORTED_NUMBER' });
});
test('J2I temporal claim uses cited horizon, never arbitrary query numbers', () => {
  const isolated = { ...context, question: 'Analiza 9999 unidades', evidence: [
    { ref: 'E2', facts: { horizonDays: 13, items: [] } }
  ] };
  assert.ok(validate('Para los próximos 13 días revisaría los candidatos.', isolated, ['E2']));
  assert.throws(() => validate('Se requieren 9999 unidades.', isolated, ['E2']), { validationReason: 'UNSUPPORTED_NUMBER' });
});
test('J2I evidence references constrain presentation and metric numbers', () => {
  assert.throws(() => validate('Aceite Cocinero 900 ml requiere revisión.', context, ['E2']), { validationReason: 'UNSUPPORTED_NUMBER' });
  assert.throws(() => validate('El sistema sugiere 24 unidades.', context, ['E2']), { validationReason: 'UNSUPPORTED_NUMBER' });
});
test('J2I names generalize to other quantities, units and diacritics without authorizing metrics', () => {
  const ctx = { evidence: [{ ref: 'E1', facts: { sku: 'BEB-AGU-001',
    name: 'Agua Mineral Nevado 1.5 L', stock: 2 } }] };
  assert.ok(validate('Agua Nevado 1,5 L requiere revisión.', ctx, ['E1']));
  assert.throws(() => validate('Agua Nevado necesita 1,5 unidades.', ctx, ['E1']), { validationReason: 'UNSUPPORTED_NUMBER' });
  assert.throws(() => validate('Agua Nevado 1,5 kg requiere revisión.', ctx, ['E1']), { validationReason: 'UNSUPPORTED_NUMBER' });
  assert.ok(validate('Arroz Costeno 750 g requiere revisión.'));
  assert.throws(() => validate('Aceite Cocinero 900 ml; compra 900 unidades.'), { validationReason: 'UNSUPPORTED_NUMBER' });
});
test('J2I safe rejected-number diagnostic survives log/public projection without prose', t => {
  const logs = []; t.mock.method(console, 'info', (...args) => logs.push(args.join(' ')));
  let error;
  try { validate('Se requieren 40 unidades y un incremento de 25 %.'); } catch (caught) { error = caught; }
  assert.deepEqual(error.unsupportedNumbers, [40, 25]);
  const source = { ...error, finishReason: 'stop', contentPresent: true, contentLength: 200,
    raw: 'PRIVATE-RAW', prompt: 'PRIVATE-PROMPT', reasoning_content: 'PRIVATE-REASONING' };
  logGroundedValidation(source);
  const projected = publicResponse({ grounded: { route: 'GROUNDED_LLM', responseDiagnostic: source } });
  assert.deepEqual(projected.grounded.responseDiagnostic.unsupportedNumbers, [40, 25]);
  assert.equal(projected.grounded.responseDiagnostic.validationField, 'observations[0].interpretation');
  assert.doesNotMatch(JSON.stringify({ logs, projected }), /PRIVATE|Se requieren|incremento/);
  const safe = safeGroundedDiagnostic({ validationReason: 'UNSUPPORTED_NUMBER',
    unsupportedNumbers: [40, 'PRIVATE', Infinity, 25, 1e99] });
  assert.deepEqual(safe.unsupportedNumbers, [40]);
  assert.equal(safeGroundedDiagnostic({ validationReason: 'NONE', unsupportedNumbers: [40] }).unsupportedNumbers, undefined);
  assert.deepEqual(safeGroundedDiagnostic({ validationReason: 'UNSUPPORTED_NUMBER', unsupportedNumbers: [40, 25, 80, 99] })
    .unsupportedNumbers, [40, 25, 80]);
});
test('J2I advisory quantities still validated; cardinal words add no numeric permission', () => {
  const value = JSON.parse(output('Priorizaría dos productos.'));
  value.observations[0].advisoryRecommendation = 'Reponer 40 unidades.';
  assert.throws(() => validateGroundedOutput(JSON.stringify(value), context), error =>
    error.validationField === 'observations[0].advisoryRecommendation' && error.unsupportedNumbers[0] === 40);
  assert.throws(() => validate('Cocinero requiere 001 unidades.', context, ['E2']), { validationReason: 'UNSUPPORTED_NUMBER' });
});
