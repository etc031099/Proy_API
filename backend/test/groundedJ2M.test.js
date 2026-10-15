'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGroundedContext, validateGroundedOutput, HALLUCINATION_CONTRACT } = require('../src/agents/groundedContext');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { LIMITATION_MESSAGES, buildAllowedLimitations, renderLimitations } = require('../src/agents/groundedLimitations');
const { safeGroundedDiagnostic, logGroundedValidation } = require('../src/agents/groundedDiagnostic');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { handleGrounded } = require('../src/agents/grounded');
const { V3 } = require('../src/services/v3IntelligenceService');
const I = 'get_inventory_intelligence', F = 'get_product_forecast', S = 'get_supplier_intelligence';
const question = '¿Qué productos debería reponer esta semana y por qué?';
const binding = { ...V3, operationalDate: '2026-10-15' }, plan = buildGroundedPlan(question, binding);
const products = [
  ['ABA-ACE-002', 'Aceite Vegetal Cocinero 900 ml', 7, 24, 9.75],
  ['ABA-ACE-001', 'Aceite Vegetal Primor 900 ml', 11, 18, 10.75],
  ['ABA-ARR-001', 'Arroz Costeño 750 g', 17, 12, 34.75]
];
const rowsFor = () => [
  { skillId: I, result: { status: 'READY', data: { availabilityStatus: 'AVAILABLE', items: products.map(([sku, productName, stock, qty]) =>
    ({ sku, productName, stock: { onHand: stock, incoming: 0 }, risk: { level: 'HIGH' },
      recommendation: { recommendedQty: qty, shouldReorder: true } })) }, metadata: {} } },
  { skillId: F, result: { status: 'READY', data: { availabilityStatus: 'AVAILABLE', items: products.map(([sku, productName, , , forecast]) =>
    ({ sku, productName, status: 'READY', expectedUnitsNext7d: forecast })) }, metadata: {} } },
  { skillId: S, result: { status: 'READY', data: { availabilityStatus: 'AVAILABLE', items: [{ supplierCode: 'SUP-05',
    displayName: 'Proveedor de prueba', productsSupplied: products.map(([sku]) => ({ sku })) }] }, metadata: {} } }
];
const fixture = (change = () => {}) => {
  const results = rowsFor();
  results.forEach(row => { row.result.metadata = { asOf: binding.operationalDate, dataMode: 'LIVE' }; });
  change(results);
  return { results, context: buildGroundedContext({ question, plan, binding, results }) };
};
const output = codes => JSON.stringify({ observations: [{ evidenceRefs: ['E1'],
  interpretation: 'Aceite Cocinero requiere revisión.', advisoryRecommendation: 'Revisa los hechos antes de decidir.' }], limitations: codes });
const forecastUnavailable = rows => { rows[1].result.status = 'NO_DATA'; rows[1].result.data = { items: [] }; };
const partialQuantity = rows => {
  rows[0].result.status = 'PARTIAL'; rows[0].result.data.availabilityStatus = 'PARTIAL';
  rows[0].result.data.items[0].recommendation = { recommendedQty: null, shouldReorder: null, status: 'LIVE_FORECAST_REQUIRED' };
};

test('J2M all three complete skills and three products authorize no limitations', () => {
  const { context } = fixture();
  assert.equal(context.evidence.length, 3);
  assert.equal(context.evidence[0].facts.items.length, 3);
  assert.deepEqual(context.allowedLimitations, []);
  assert.doesNotThrow(() => validateGroundedOutput(output([]), context));
  assert.ok(Object.isFrozen(context.allowedLimitations));
});
for (const text of ['La recomendación depende de la demanda futura.', 'Los datos pueden cambiar.',
  'No se consideran factores externos.', 'Se recomienda revisar proveedores.', 'El pronóstico puede variar.',
  'No se dispone de suficiente información.', HALLUCINATION_CONTRACT[0]])
  test(`J2M rejects generic/policy text without a factual limitation: ${text}`, () => {
    assert.throws(() => validateGroundedOutput(output([text]), fixture().context), error => {
      assert.equal(error.validationReason, 'LIMITATION_NOT_ALLOWED');
      assert.equal(error.validationField, 'limitations[0]');
      assert.equal(error.limitationReason, 'NO_ALLOWED_LIMITATION_CONTEXT');
      assert.equal(error.limitationCode, undefined); return true;
    });
  });
test('J2M explicit forecast unavailability authorizes its code', () => {
  const { context } = fixture(forecastUnavailable);
  assert.deepEqual(context.allowedLimitations, [{ code: 'FORECAST_UNAVAILABLE',
    message: LIMITATION_MESSAGES.FORECAST_UNAVAILABLE, evidenceRefs: ['E2'] }]);
  assert.doesNotThrow(() => validateGroundedOutput(output(['FORECAST_UNAVAILABLE']), context));
});
test('J2M an available forecast cannot be labelled unavailable', () => {
  assert.throws(() => validateGroundedOutput(output(['FORECAST_UNAVAILABLE']), fixture().context), error =>
    error.limitationReason === 'NO_ALLOWED_LIMITATION_CONTEXT' && error.limitationCode === 'FORECAST_UNAVAILABLE');
});
test('J2M null recommendation with explicit partial provenance authorizes quantity limitation', () => {
  const { context } = fixture(partialQuantity);
  assert.equal(context.evidence[0].facts.items[0].recommendation.recommendedQty, null);
  assert.equal(context.allowedLimitations[0].code, 'RECOMMENDED_QUANTITY_UNAVAILABLE');
  assert.doesNotThrow(() => validateGroundedOutput(output(['RECOMMENDED_QUANTITY_UNAVAILABLE']), context));
});
test('J2M null recommendation alone does not invent partial provenance', () => {
  const { context } = fixture(rows => { rows[0].result.data.items[0].recommendation.recommendedQty = null; });
  assert.deepEqual(context.allowedLimitations, []);
});
test('J2M unknown code and known but unauthorized code have distinct safe reasons', () => {
  const { context } = fixture(partialQuantity);
  assert.throws(() => validateGroundedOutput(output(['PRIVATE-UNKNOWN-CODE']), context), error =>
    error.limitationReason === 'UNKNOWN_LIMITATION_CODE' && error.limitationCode === undefined);
  assert.throws(() => validateGroundedOutput(output(['FORECAST_UNAVAILABLE']), context), error =>
    error.limitationReason === 'LIMITATION_NOT_AUTHORIZED' && error.limitationCode === 'FORECAST_UNAVAILABLE');
});
test('J2M two authorized limitations pass; three still fail J2H cardinality', () => {
  const { context } = fixture(rows => {
    partialQuantity(rows); forecastUnavailable(rows); rows[2].result.data.items[0].productsSupplied = [];
  });
  const codes = context.allowedLimitations.map(row => row.code);
  assert.equal(codes.length, 3);
  assert.doesNotThrow(() => validateGroundedOutput(output(codes.slice(0, 2)), context));
  assert.throws(() => validateGroundedOutput(output(codes), context), error =>
    error.validationLayer === 'SCHEMA' && error.schemaReason === 'TOO_MANY_ITEMS' && error.schemaField === 'limitations');
});
test('J2M literal prose cannot replace an authorized code even when it matches the backend message', () => {
  const { context } = fixture(forecastUnavailable);
  assert.throws(() => validateGroundedOutput(output([LIMITATION_MESSAGES.FORECAST_UNAVAILABLE]), context),
    error => error.limitationReason === 'UNKNOWN_LIMITATION_CODE');
});
test('J2M range limits and supplier aggregate scope alone do not mean data is partial', () => {
  const { context } = fixture(rows => { rows.forEach(row => { row.result.metadata.truncated = true; }); });
  assert.ok(context.evidence.every(row => row.limited));
  assert.deepEqual(context.allowedLimitations, []);
});
test('J2M missing candidate supplier relation is explicit and does not imply no supplier exists', () => {
  const { context } = fixture(rows => { rows[2].result.data.items[0].productsSupplied = [{ sku: 'BEB-GAS-001' }]; });
  assert.equal(context.allowedLimitations[0].code, 'SUPPLIER_RELATION_UNAVAILABLE');
  assert.doesNotThrow(() => validateGroundedOutput(output(['SUPPLIER_RELATION_UNAVAILABLE']), context));
  assert.match(renderLimitations(['SUPPLIER_RELATION_UNAVAILABLE'])[0], /evidencia consultada/);
});
test('J2M actual forecast cold start/history gaps and generic explicit partial states authorize fixed codes', () => {
  for (const status of ['COLD_START', 'INSUFFICIENT_HISTORY']) {
    const { context } = fixture(rows => { rows[1].result.data.items[0].status = status; });
    assert.equal(context.allowedLimitations[0].code, 'FORECAST_UNAVAILABLE');
  }
  const { context } = fixture(rows => { rows[0].result.data.availabilityStatus = 'PARTIAL'; });
  assert.equal(context.allowedLimitations[0].code, 'ANALYTICS_PARTIAL');
});
test('J2M context budget omissions authorize only the fixed omitted-evidence message', () => {
  const evidence = [{ ref: 'E1', skillId: I, status: 'READY', facts: null, omission: 'CONTEXT_BUDGET' }];
  assert.deepEqual(buildAllowedLimitations(evidence), [{ code: 'CONTEXT_EVIDENCE_OMITTED',
    message: LIMITATION_MESSAGES.CONTEXT_EVIDENCE_OMITTED, evidenceRefs: ['E1'] }]);
});
test('J2M a stale/forged allowlist cannot authorize a limitation unsupported by current facts', () => {
  const { context } = fixture();
  const forged = { ...context, allowedLimitations: [{ code: 'FORECAST_UNAVAILABLE', message: 'PRIVATE' }] };
  assert.throws(() => validateGroundedOutput(output(['FORECAST_UNAVAILABLE']), forged), error =>
    error.limitationReason === 'NO_ALLOWED_LIMITATION_CONTEXT');
});
for (const absentRelation of [false, true]) test(`J2M handler uses codes and renders backend Spanish messages: ${absentRelation}`, async t => {
  t.mock.method(console, 'info', () => {});
  const { results } = fixture(rows => { if (absentRelation) rows[2].result.data.items[0].productsSupplied = []; });
  let calls = 0, accepted;
  const response = await handleGrounded({ message: question, context: {}, service: { resolveContext: async () => binding },
    run: async (_agent, id) => results.find(row => row.skillId === id).result,
    execution: { hasGroundedProvider: () => true, recordGroundedSynthesis: value => { accepted = value; },
      generateGrounded: async input => {
        calls++; const compact = JSON.parse(input.messages[1].content);
        assert.equal(input.maxTokens, 600);
        assert.match(input.messages[0].content, /No agregues limitaciones por precaución/);
        assert.deepEqual(compact.allowedLimitations.map(row => row.code), absentRelation ? ['SUPPLIER_RELATION_UNAVAILABLE'] : []);
        return { text: output(absentRelation ? ['SUPPLIER_RELATION_UNAVAILABLE'] : []),
          responseDiagnostic: { finishReason: 'stop', usagePresent: true } };
      } } });
  assert.equal(accepted, true); assert.equal(calls, 1);
  assert.doesNotMatch(response.answer, /SUPPLIER_RELATION_UNAVAILABLE|allowedLimitations/);
  if (absentRelation) assert.match(response.answer, /evidencia consultada no permite vincular proveedores/);
});
test('J2M rejected limitation diagnostics never expose raw text or unrecognized codes', t => {
  const logs = []; t.mock.method(console, 'info', (...args) => logs.push(args.join(' ')));
  let error;
  try { validateGroundedOutput(output(['PRIVATE-TEXT']), fixture(partialQuantity).context); } catch (caught) { error = caught; }
  const source = { ...error, raw: 'PRIVATE-RAW', prompt: 'PRIVATE-PROMPT', limitationCode: 'PRIVATE-CODE' };
  logGroundedValidation(source);
  const safe = publicResponse({ grounded: { responseDiagnostic: source } }).grounded.responseDiagnostic;
  assert.equal(safe.limitationReason, 'UNKNOWN_LIMITATION_CODE');
  assert.equal(safe.limitationCode, undefined);
  assert.doesNotMatch(JSON.stringify({ safe, logs }), /PRIVATE/);
  assert.equal(safeGroundedDiagnostic({ validationReason: 'LIMITATION_NOT_ALLOWED', limitationReason: 'PRIVATE' }).limitationReason, undefined);
  assert.equal(safeGroundedDiagnostic({ validationReason: 'NONE', limitationCode: 'FORECAST_UNAVAILABLE' }).limitationCode, undefined);
});
test('J2M handler preserves safe limitation reason/code and verified fallback after rejection', async t => {
  t.mock.method(console, 'info', () => {});
  const { results } = fixture(); let calls = 0, accepted;
  const response = await handleGrounded({ message: question, context: {}, service: { resolveContext: async () => binding },
    run: async (_agent, id) => results.find(row => row.skillId === id).result,
    execution: { hasGroundedProvider: () => true, recordGroundedSynthesis: value => { accepted = value; },
      generateGrounded: async () => { calls++; return { text: output(['FORECAST_UNAVAILABLE']),
        responseDiagnostic: { finishReason: 'stop', usagePresent: true } }; } } });
  const diagnostic = publicResponse(response).grounded.responseDiagnostic;
  assert.equal(calls, 1); assert.equal(accepted, false);
  assert.equal(diagnostic.validationReason, 'LIMITATION_NOT_ALLOWED');
  assert.equal(diagnostic.limitationReason, 'NO_ALLOWED_LIMITATION_CONTEXT');
  assert.equal(diagnostic.limitationCode, 'FORECAST_UNAVAILABLE');
  assert.equal(diagnostic.validationField, 'limitations[0]');
  assert.equal(diagnostic.finishReason, 'stop');
  assert.match(response.answer, /se conservan los hechos/);
  assert.match(response.answer, /Cocinero/);
  assert.doesNotMatch(response.answer, /FORECAST_UNAVAILABLE/);
});
