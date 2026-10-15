'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGroundedSchema, GROUNDED_OUTPUT_SCHEMA } = require('../src/agents/groundedOutputSchema');
const { validateGroundedOutput } = require('../src/agents/groundedContext');
const { safeGroundedDiagnostic } = require('../src/agents/groundedDiagnostic');
const { handleGrounded } = require('../src/agents/grounded');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const context = { evidence: [
  { ref: 'E1', facts: { sku: 'ABA-ACE-002', productName: 'Cocinero', recommendedQty: 24 } },
  { ref: 'E2', facts: { supplierCode: 'SUP-05', productsSupplied: [{ sku: 'ABA-ACE-002' }] } }
] };
const row = () => ({ evidenceRefs: ['E1', 'E2'], interpretation: 'Cocinero requiere revisión.',
  advisoryRecommendation: 'Consulta SUP-05 para ABA-ACE-002; cantidad sugerida 24.' });
const valid = count => ({ observations: Array.from({ length: count }, row), limitations: [] });
const validate = output => validateGroundedOutput(JSON.stringify(output), context);
for (const count of [1, 3]) test(`J2H exact JSON contract ${count} observations`, () => {
  assert.deepEqual(validate(valid(count)), valid(count));
});
for (const [label, mutate, reason, field] of [
  ['missing observations', x => { delete x.observations; }, 'REQUIRED_FIELD_MISSING', 'observations'],
  ['missing limitations', x => { delete x.limitations; }, 'REQUIRED_FIELD_MISSING', 'limitations'],
  ['missing interpretation', x => { delete x.observations[0].interpretation; }, 'REQUIRED_FIELD_MISSING', 'observations[0].interpretation'],
  ['wrong field name', x => { x.recommendations = x.observations; delete x.observations; }, 'REQUIRED_FIELD_MISSING', 'observations'],
  ['wrong type', x => { x.observations[0].interpretation = 24; }, 'WRONG_TYPE', 'observations[0].interpretation'],
  ['null', x => { x.limitations = null; }, 'WRONG_TYPE', 'limitations'],
  ['extra root field', x => { x['PRIVATE-SECRET'] = 'PRIVATE'; }, 'UNKNOWN_FIELD', '$'],
  ['extra row field', x => { x.observations[0].reason = 'extra'; }, 'UNKNOWN_FIELD', 'observations[0]'],
  ['4 observations', x => { x.observations = valid(4).observations; }, 'TOO_MANY_RECOMMENDATIONS', 'observations'],
  ['empty observations', x => { x.observations = []; }, 'EMPTY_RECOMMENDATIONS', 'observations'],
  ['long text', x => { x.observations[0].interpretation = 'x'.repeat(901); }, 'FIELD_TOO_LONG', 'observations[0].interpretation'],
  ['invalid ref type', x => { x.observations[0].evidenceRefs = [null]; }, 'WRONG_TYPE', 'observations[0].evidenceRefs[0]']
]) test(`J2H schema: ${label}`, () => {
  const value = valid(1); mutate(value);
  assert.throws(() => validate(value), error => {
    assert.equal(error.validationLayer, 'SCHEMA'); assert.equal(error.schemaReason, reason);
    assert.equal(error.schemaField, field);
    const diagnostic = safeGroundedDiagnostic(error);
    assert.equal(diagnostic.schemaReason, reason); assert.equal(diagnostic.schemaField, field);
    assert.deepEqual(publicResponse({ grounded: { route: 'GROUNDED_LLM', responseDiagnostic: diagnostic } })
      .grounded.responseDiagnostic, diagnostic);
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE/); return true;
  });
});
test('J2H whole fenced JSON only; prose and arbitrary fragments fail', () => {
  const json = JSON.stringify(valid(1));
  for (const fence of ['```json', '```']) assert.deepEqual(validateGroundedOutput(`${fence}\n${json}\n\`\`\``, context), valid(1));
  for (const text of [`Aquí está: ${json}`, `${json} fin`, `antes\n\`\`\`json\n${json}\n\`\`\``, '{', `${json}\n${json}`])
    assert.throws(() => validateGroundedOutput(text, context), error => error.schemaReason === 'JSON_PARSE_FAILED');
});
for (const [claim, reason] of [
  ['Revisa ABA-FAKE-999.', 'UNKNOWN_ENTITY'], ['Consulta SUP-99.', 'UNKNOWN_ENTITY'],
  ['Compra 9999 unidades.', 'UNSUPPORTED_NUMBER'], ['Fraude confirmado.', 'UNSUPPORTED_SEMANTIC_CLAIM']
]) test(`J2H grounding separated: ${reason}`, () => {
  const value = valid(1); value.observations[0].interpretation = claim;
  assert.doesNotThrow(() => parseGroundedSchema(JSON.stringify(value)));
  assert.throws(() => validate(value), error => error.validationLayer === 'GROUNDING'
    && error.validationReason === reason && error.schemaReason === undefined);
});
test('J2H prompt and validator share exact schema; compact result renders with stop/usage intact', async () => {
  const { V3 } = require('../src/services/v3IntelligenceService');
  let request, accepted;
  const response = await handleGrounded({ message: '¿Qué productos debería reponer esta semana y por qué?', context: {},
    service: { resolveContext: async () => ({ ...V3, operationalDate: '2026-10-15' }) },
    run: async (_agent, skill) => ({ status: 'READY', metadata: { asOf: '2026-10-15' }, data: { items:
      skill === 'get_inventory_intelligence' ? [{ sku: 'ABA-ACE-002', productName: 'Cocinero',
        stock: { onHand: 7, incoming: 0 }, recommendation: { recommendedQty: 24 }, risk: { level: 'HIGH' } }]
        : skill === 'get_supplier_intelligence' ? [{ supplierCode: 'SUP-05', productsSupplied: [{ sku: 'ABA-ACE-002' }] }] : [] } }),
    execution: { hasGroundedProvider: () => true, recordGroundedSynthesis: value => { accepted = value; },
      generateGrounded: async value => { request = value; const out = valid(1); out.observations[0].evidenceRefs = ['E1', 'E3'];
        return { text: JSON.stringify(out), provider: 'deepseek', model: 'deepseek-flash',
          responseDiagnostic: { finishReason: 'stop', usagePresent: true } }; } } });
  assert.ok(request.messages[0].content.includes(JSON.stringify(GROUNDED_OUTPUT_SCHEMA)));
  assert.equal(request.maxTokens, 300); assert.equal(accepted, true);
  assert.equal(response.grounded.responseDiagnostic.finishReason, 'stop');
  assert.equal(response.grounded.responseDiagnostic.usagePresent, true);
  assert.match(response.answer, /Cocinero/); assert.doesNotMatch(response.answer, /observations|evidenceRefs/);
});
test('J2H diagnostic sanitizes unknown fields and reasons', () => {
  const safe = safeGroundedDiagnostic({ schemaReason: 'PRIVATE', schemaField: 'PRIVATE', raw: 'PRIVATE', prompt: 'PRIVATE' });
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE/);
});
