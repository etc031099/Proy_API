'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGroundedOutput } = require('../src/agents/groundedContext');
const { safeGroundedDiagnostic, logGroundedValidation } = require('../src/agents/groundedDiagnostic');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const context = { evidence: [{ ref: 'E1', facts: { sku: 'ABA-ACE-002',
  productName: 'Aceite Vegetal Cocinero 900 ml', stock: 7, recommendedQty: 24, coverageDays: 5.03 } }] };
const output = text => JSON.stringify({ observations: [{ evidenceRefs: ['E1'], interpretation: text,
  advisoryRecommendation: 'Revisar Cocinero.' }], limitations: [] });
for (const marker of ['(1)', '(2)', '[1]', '[2]', '#1', '#2'])
  test(`J2K leading structural index ${marker}`, () => {
    assert.ok(validateGroundedOutput(output(`${marker} Priorizar Aceite Cocinero.`), context));
  });
for (const text of ['Según el punto 1, revisar Cocinero.', 'Los productos 1 y 2 requieren revisión.',
  'opción 1', 'producto 2', 'los puntos 1 y 2', '1 y 2', '1º', '2º', 'n.º 1', 'n.º 2',
  'primera opción (1)', 'según evidencia 1', 'fuente 2', 'Revisar [1] y [2].', 'items[1]', 'Según E1 y E2.',
  'Reponer 1 unidad.', 'Hay 2 proveedores.', 'stock 2', '40 unidades.', '80 %.', '25 %.'])
  test(`J2K ambiguous/metric numbers remain grounded: ${text}`, () => {
    assert.throws(() => validateGroundedOutput(output(text), context), { validationReason: 'UNSUPPORTED_NUMBER' });
  });
test('J2K cited package and coverage still pass', () => {
  assert.ok(validateGroundedOutput(output('Aceite Cocinero 900 ml tiene cobertura de 5.03 días.'), context));
});
for (const [text, pattern] of [
  ['Revisar (1).', 'PAREN_INDEX'], ['Revisar [2].', 'BRACKET_INDEX'], ['Revisar #1.', 'HASH_INDEX'],
  ['Primera opción 2.', 'ORDINAL_INDEX'], ['2º', 'ORDINAL_INDEX'], ['Reponer 1 unidad.', 'QUANTITY_WITH_UNIT'],
  ['Hay 2 proveedores.', 'QUANTITY_WITH_UNIT'], ['80 %.', 'PERCENTAGE'], ['8,99 días.', 'QUANTITY_WITH_UNIT'],
  ['Valor 8.99.', 'DECIMAL_METRIC'], ['1 y 2', 'STANDALONE_NUMBER'], ['stock 2', 'UNKNOWN_CONTEXT'],
  ['99. Revisar producto.', 'LINE_LIST_MARKER'],
  ['Según E1 y E2.', 'EVIDENCE_REFERENCE'], ['Según fuente 2.', 'EVIDENCE_REFERENCE']
]) test(`J2K sanitized category ${pattern}: ${text}`, () => {
  assert.throws(() => validateGroundedOutput(output(text), context), error => {
    assert.equal(error.unsupportedNumberDetails[0].pattern, pattern);
    const safe = safeGroundedDiagnostic(error);
    assert.deepEqual(safe.unsupportedNumberDetails, error.unsupportedNumberDetails);
    assert.deepEqual(publicResponse({ grounded: { responseDiagnostic: safe } }).grounded.responseDiagnostic, safe);
    return true;
  });
});
test('J2K labels do not authorize inline citations, quantified entities or body amounts', () => {
  for (const text of ['(1) unidad pendiente.', '[2] proveedores.', '#2 productos.', '(1) 40 unidades.',
    '(1) Revisar Cocinero; reponer 2 unidades.', '(1) Revisar [2].'])
    assert.throws(() => validateGroundedOutput(output(text), context), { validationReason: 'UNSUPPORTED_NUMBER' });
  const out = JSON.parse(output('Revisar Cocinero.'));
  out.observations[0].advisoryRecommendation = '[1] Priorizar Cocinero.';
  assert.doesNotThrow(() => validateGroundedOutput(JSON.stringify(out), context));
  out.observations[0].advisoryRecommendation = '#2 Reponer 40 unidades.';
  assert.throws(() => validateGroundedOutput(JSON.stringify(out), context), error => error.unsupportedNumbers.includes(40));
  const supported = { evidence: [{ ref: 'E1', facts: { productName: 'Cocinero', stock: 2, supplierCount: 1 } }] };
  assert.doesNotThrow(() => validateGroundedOutput(output('Stock 2; hay 1 proveedor.'), supported));
});
test('J2K logs/public diagnostics contain only bounded numbers and allowlisted categories', t => {
  const logs = []; t.mock.method(console, 'info', (...args) => logs.push(args.join(' ')));
  const source = { validationReason: 'UNSUPPORTED_NUMBER', unsupportedNumbers: [1, 2, 40],
    unsupportedNumberDetails: [{ value: 1, pattern: 'PAREN_INDEX', raw: 'PRIVATE-RAW' },
      { value: 2, pattern: 'PRIVATE-PATTERN' }, { value: 40, pattern: 'QUANTITY_WITH_UNIT' },
      { value: 80, pattern: 'PERCENTAGE' }], prompt: 'PRIVATE-PROMPT', reasoning: 'PRIVATE-REASONING' };
  logGroundedValidation(source);
  const safe = publicResponse({ grounded: { responseDiagnostic: source } }).grounded.responseDiagnostic;
  assert.deepEqual(safe.unsupportedNumberDetails, [{ value: 1, pattern: 'PAREN_INDEX' }, { value: 40, pattern: 'QUANTITY_WITH_UNIT' }]);
  assert.doesNotMatch(JSON.stringify({ safe, logs }), /PRIVATE/);
  assert.doesNotThrow(() => safeGroundedDiagnostic({ ...source, unsupportedNumbers: 2 }));
  assert.equal(safeGroundedDiagnostic({ ...source, validationReason: 'NONE' }).unsupportedNumberDetails, undefined);
});
