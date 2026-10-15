'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { parseGroundedSchema } = require('../src/agents/groundedOutputSchema');
const { buildGroundedContext, validateGroundedOutput } = require('../src/agents/groundedContext');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { safeGroundedDiagnostic } = require('../src/agents/groundedDiagnostic');
const { estimateCostUsd } = require('../src/agents/providers/neutralProvider');
const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { fixture, binding, dataFor } = require('./helpers/j2nGroundedFixture');
const { I, F, S, B } = require('./fixtures/j2nAcceptanceMatrix');
const query = '¿Qué productos debería reponer esta semana y por qué?';
const plan = buildGroundedPlan(query, binding);
const context = buildGroundedContext({ question: query, plan, binding, results: [I, F, S].map(skillId => ({ skillId,
  result: { status: 'READY', data: dataFor(skillId, {}), metadata: { asOf: '2026-10-15', frozenCutoff: '2026-10-12' } } })) });
const valid = () => ({ observations: [{ evidenceRefs: ['E1', 'E2'], interpretation: 'Cocinero tiene cobertura de 5,03 días.',
  advisoryRecommendation: 'Revisa la reposición sugerida de 24 unidades.' }], limitations: [] });
const validate = value => validateGroundedOutput(typeof value === 'string' ? value : JSON.stringify(value), context);
for (const count of [1, 2, 3]) test(`N-SCHEMA-${count} valid observations`, () => {
  const out = valid(); out.observations = Array.from({ length: count }, () => valid().observations[0]); assert.doesNotThrow(() => validate(out));
});
for (const [id, mutate, expected] of [
  ['EMPTY', x => { x.observations = []; }, 'EMPTY_RECOMMENDATIONS'],
  ['FOUR', x => { x.observations = Array(4).fill(x.observations[0]); }, 'TOO_MANY_RECOMMENDATIONS'],
  ['MISSING', x => { delete x.observations[0].interpretation; }, 'REQUIRED_FIELD_MISSING'],
  ['TYPE', x => { x.observations = {}; }, 'WRONG_TYPE'], ['NULL', x => { x.limitations = null; }, 'WRONG_TYPE'],
  ['EXTRA', x => { x.observations[0].private = 'sentinel'; }, 'UNKNOWN_FIELD'],
  ['BLANK', x => { x.observations[0].interpretation = ' '; }, 'EMPTY_TEXT'],
  ['LONG', x => { x.observations[0].interpretation = 'x'.repeat(901); }, 'FIELD_TOO_LONG'],
  ['REFS-EMPTY', x => { x.observations[0].evidenceRefs = []; }, 'EMPTY_ARRAY'],
  ['REFS-DUP', x => { x.observations[0].evidenceRefs = ['E1', 'E1']; }, 'DUPLICATE_ITEMS'],
  ['LIMITS-DUP', x => { x.limitations = ['FORECAST_UNAVAILABLE', 'FORECAST_UNAVAILABLE']; }, 'DUPLICATE_ITEMS'],
  ['THREE-LIMITS', x => { x.limitations = ['A', 'B', 'C']; }, 'TOO_MANY_ITEMS']
]) test(`N-SCHEMA-${id}`, () => {
  const out = valid(); mutate(out);
  assert.throws(() => validate(out), error => error.validationLayer === 'SCHEMA' && error.schemaReason === expected);
});
test('N-SCHEMA combined text bound remains 2160', () => {
  const out = valid(); out.observations = Array.from({ length: 3 }, () => ({ evidenceRefs: ['E1'], interpretation: 'x'.repeat(400), advisoryRecommendation: 'y'.repeat(400) }));
  assert.throws(() => validate(out), error => error.validationReason === 'OUTPUT_TEXT_TOO_LONG');
});
for (const [id, wrap, pass] of [
  ['PURE', x => x, true], ['FENCED', x => '```json\n' + x + '\n```', true],
  ['PREFIX', x => 'Aquí está: ' + x, false], ['SUFFIX', x => x + ' fin', false],
  ['PARTIAL', x => x.slice(0, -2), false], ['INVALID', () => '{no}', false],
  ['TRAILING', x => x + '{}', false], ['ARRAY', x => '[' + x + ']', false], ['EMPTY', () => '{}', false]
]) test(`N-JSON-${id}`, () => {
  if (pass) assert.doesNotThrow(() => validate(wrap(JSON.stringify(valid()))));
  else assert.throws(() => validate(wrap(JSON.stringify(valid()))));
});
for (const [id, text, refs, pass] of [
  ['INTEGER', 'Stock 11, entradas 57 y sugerencia de 18 unidades.', ['E1'], true],
  ['DECIMAL', 'Cobertura 7.16 días.', ['E1'], true], ['COMMA', 'Cobertura 7,16 días.', ['E1'], true],
  ['ROUND-1', 'Cobertura 7,2 días.', ['E1'], true], ['ROUND-2', 'Demanda 34,8 unidades.', ['E2'], true],
  ['ROUND-INTEGER', 'Cobertura 5 días.', ['E1'], false], ['INVENTED', 'Reponer 999 unidades.', ['E1'], false],
  ['PERCENT', 'Puntualidad de 80 %. Plazo observado de 4 días.', ['E3'], true],
  ['MONEY', 'Ingresos S/ 5000,00.', ['E1'], true],
  ['MONEY-NO-CENTS-PERMISSION', 'Reponer 5000 unidades.', ['E1'], false],
  ['DATE', 'El corte corresponde a 2026-10-12.', ['E1'], true],
  ['UNKNOWN-DATE', 'El corte corresponde a 2025-10-12.', ['E1'], false],
  ['DATE-NO-QUANTITY', 'Reponer 2026 unidades.', ['E1'], false],
  ['PACKAGE', 'Aceite Cocinero 900 ml y Arroz Costeño 750 g requieren revisión.', ['E1'], true],
  ['PACKAGE-QUANTITY', 'Aceite Cocinero requiere 900 unidades.', ['E1'], false],
  ['SKU', 'Revisar ABA-ACE-002.', ['E1'], true], ['UNKNOWN-SKU', 'Revisar ABA-FAKE-999.', ['E1'], false],
  ['STRUCTURAL', '(1) Revisar Cocinero.\n[2] Revisar Primor.', ['E1'], true],
  ['EVIDENCE-PROSE', 'Según E1 y E2, revisa Cocinero.', ['E1'], false],
  ['WRONG-DOMAIN', 'Reposición sugerida de 24 unidades.', ['E3'], false]
]) test(`N-NUM-${id}`, () => {
  const local = structuredClone(context);
  if (id === 'ROUND-INTEGER') local.evidence[0].facts = { coverage: { daysCover: 5.03 } };
  if (id.startsWith('MONEY')) local.evidence[0].facts = { revenueCents: 500000 };
  const out = valid(); out.observations[0] = { evidenceRefs: refs, interpretation: text, advisoryRecommendation: 'Revisa los hechos.' };
  const run = () => validateGroundedOutput(JSON.stringify(out), local);
  if (pass) assert.doesNotThrow(run); else assert.throws(run);
});
test('N-NUM-CROSS-SELL percentage presentation comes from a cited ratio, not an unrelated stock', () => {
  const local = { evidence: [{ ref: 'E1', facts: { support: .08, confidence: .3, stock: 25 } }], allowedLimitations: [] };
  const out = valid(); out.observations[0].evidenceRefs = ['E1']; out.observations[0].advisoryRecommendation = 'Revisa las asociaciones.';
  out.observations[0].interpretation = 'Support 8 % y confidence 30 %.';
  assert.doesNotThrow(() => validateGroundedOutput(JSON.stringify(out), local));
  out.observations[0].interpretation = 'Crecimiento de 25 %.';
  assert.throws(() => validateGroundedOutput(JSON.stringify(out), local));
});
test('N-NUM money formatting does not authorize bare amounts, unrelated stock or ambiguous grouping', () => {
  const local = { evidence: [{ ref: 'E1', facts: { revenueCents: 500, stock: 25, incoming: 0 } }], allowedLimitations: [] };
  const out = valid(); out.observations[0].evidenceRefs = ['E1']; out.observations[0].advisoryRecommendation = 'Revisa los hechos.';
  out.observations[0].interpretation = 'Importe S/ 5,00.';
  assert.doesNotThrow(() => validateGroundedOutput(JSON.stringify(out), local));
  for (const text of ['Importe S/ 25.', 'Importe S/ 5,000.00.']) {
    out.observations[0].interpretation = text;
    assert.throws(() => validateGroundedOutput(JSON.stringify(out), local), error => error.validationReason === 'UNSUPPORTED_NUMBER');
  }
});
test('N-NUM an unknown ISO date cannot be assembled from independently authorized numeric components', () => {
  const local = { evidence: [{ ref: 'E1', facts: { values: [2025, -10, -12], date: '2026-10-12' } }], allowedLimitations: [] };
  const out = valid(); out.observations[0] = { evidenceRefs: ['E1'], interpretation: 'Corte 2025-10-12.', advisoryRecommendation: 'Revisa los hechos.' };
  assert.throws(() => validateGroundedOutput(JSON.stringify(out), local), error => error.unsupportedNumberDetails[0].pattern === 'DATE_VALUE');
});
test('N-NUM PEN representation never converts nested USD amounts into soles', () => {
  const local = { evidence: [{ ref: 'E1', facts: { currency: 'USD', kpis: { revenueCents: 500 } } }], allowedLimitations: [] };
  const out = valid(); out.observations[0] = { evidenceRefs: ['E1'], interpretation: 'Ingresos S/ 5,00.', advisoryRecommendation: 'Revisa los hechos.' };
  assert.throws(() => validateGroundedOutput(JSON.stringify(out), local), error => error.validationReason === 'UNSUPPORTED_NUMBER');
});
for (const text of ['Hay fraude confirmado.', 'Existe probabilidad de abandono.', 'MA28 es machine learning.',
  'FP-Growth demuestra causalidad confirmada.', 'Confirmo una compra.', 'Ejecuté una venta.'])
  test(`N-SEMANTIC rejects ${text}`, () => { const out = valid(); out.observations[0].interpretation = text;
    assert.throws(() => validate(out), error => error.validationReason === 'UNSUPPORTED_SEMANTIC_CLAIM'); });
test('N-REF nonexistent or omitted evidence cannot authorize claims', () => {
  const out = valid(); out.observations[0].evidenceRefs = ['E99'];
  assert.throws(() => validate(out), error => error.validationReason === 'EVIDENCE_REFERENCE_INVALID');
  const local = structuredClone(context); local.evidence[0].facts = null; out.observations[0].evidenceRefs = ['E1'];
  assert.throws(() => validateGroundedOutput(JSON.stringify(out), local), error => error.validationReason === 'EVIDENCE_REFERENCE_INVALID');
});
for (const tokens of [150, 250, 300, 400, 499, 500]) test(`N-COMPLETION stop with ${tokens} simulated output tokens`, async t => {
  t.mock.method(console, 'info', () => {});
  const f = fixture({ outputTokens: tokens }), result = await f.run(query);
  assert.equal(f.requests.length, 1); assert.equal(result.usage.outputTokens, tokens);
  assert.equal(result.grounded.responseDiagnostic.validationResult, 'ACCEPTED');
});
test('N-COMPLETION length with partial JSON fails without repair or retries, retaining usage', async t => {
  t.mock.method(console, 'info', () => {});
  const f = fixture({ finish: 'length', outputTokens: 500, output: () => '{"observations":' }), result = await f.run(query);
  assert.equal(result.grounded.responseDiagnostic.validationReason, 'OUTPUT_TRUNCATED');
  assert.equal(f.requests.length, 1); assert.equal(f.genericCalls(), 0); assert.equal(result.usage.outputTokens, 500);
  assert.ok(result.answer.length < 750); assert.match(result.answer, /se conservan los hechos/);
});
for (const status of ['PARTIAL', 'NO_DATA', 'UNAVAILABLE']) test(`N-SKILL ${status} never triggers a provider call`, async t => {
  t.mock.method(console, 'info', () => {});
  const f = fixture({ status }), result = await f.run(query);
  assert.equal(f.requests.length, 0); assert.equal(result.usage.totalTokens, 0);
});
test('N-SKILL inventory failure skips forecast, retains supplier and never calls provider', async () => {
  const f = fixture({ failSkill: I }), result = await f.run(query);
  assert.deepEqual(f.calls.map(row => row.skill), [I, S]); assert.equal(f.requests.length, 0);
  assert.match(result.answer, /Proveedor Andino/); assert.doesNotMatch(result.answer, /PRIVATE/);
});
test('N-BUDGET all messages fit the neutral 8000-byte boundary after context projection', async t => {
  t.mock.method(console, 'info', () => {});
  const f = fixture(), result = await f.run('Qué promoción recomiendas lanzar');
  assert.equal(f.requests.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(f.requests[0].messages)) <= 8000);
  assert.equal(result.grounded.responseDiagnostic.validationResult, 'ACCEPTED');
});
test('N-PRIVACY keys, cookies, JWT and connection strings never enter compact provider context', () => {
  const secret = 'sk-' + 'PRIVATESECRET'.repeat(3), jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.PRIVATE_SIGNATURE';
  const local = buildGroundedContext({ question: `Revisa inventario DEEPSEEK_API_KEY=${secret} Cookie=session=PRIVATE_COOKIE ${jwt}`,
    plan, binding, results: [{ skillId: I, result: { status: 'READY', metadata: {}, data: {
      items: [{ sku: 'ABA-ACE-002', productName: `Cocinero ${secret}`, stock: { onHand: 7 } }],
      password: 'PRIVATE_PASSWORD', mongodb: 'mongodb://PRIVATE_URI', telegramToken: '123456789:PRIVATE_TELEGRAM' } } }] });
  assert.doesNotMatch(JSON.stringify(local), /PRIVATE|sk-|eyJhbGci/);
});
test('N-TELEMETRY unknown tariffs remain null', () => {
  assert.equal(estimateCostUsd({ provider: 'fixture', model: 'unknown', usage: { inputTokens: 10, outputTokens: 5 } }).estimatedCostUsd, null);
});
test('N-WRITE production action wrapper preserves preview/selection/cancel with zero executions', async () => {
  const { withActionAssistant } = require('../src/automations/assistant');
  const f = fixture(); let row, previews = 0, executions = 0;
  const wrapper = withActionAssistant(f.runtime, {
    async prepare(input) { previews++; row = { pendingActionId: randomUUID(), action: input.skillId, status: 'PENDING',
      summary: 'Preview fixture', expiresAt: new Date(Date.now() + 600000).toISOString() }; return row; },
    async get() { return row; }, async resolvePending() { return row?.status === 'PENDING' ? row : undefined; },
    async confirmPendingAction() { executions++; assert.fail('No real or simulated execution authorized in this sequence'); },
    async cancelPendingAction() { row.status = 'CANCELLED'; return row; }
  }, { resolver: async () => ({ value: { _id: '507f1f77bcf86cd799439012', sku: 'PAN-FRE-001', name: 'Pan francés', stock: 21,
    currency: 'PEN', isActive: true, supplierPrices: [{ supplierId: '507f1f77bcf86cd799439013', purchasePrice: 1.5 }] }, confidence: 'EXACT' }),
  supplierLookup: async () => [{ _id: '507f1f77bcf86cd799439013', name: 'Proveedor de prueba', isActive: true }] });
  const conversationId = randomUUID(), send = message => wrapper.handle(f.req, { message, conversationId });
  assert.equal((await send('Prepara una compra de 3 unidades de PAN-FRE-001.')).pendingAction.status, 'PENDING');
  await send('el primero'); assert.equal(executions, 0);
  assert.match((await send('Mejor no, cancela.')).answer, /cancelad/i);
  assert.equal(row.status, 'CANCELLED', 'Cancellation must also cancel the prepared action, not only a replacement draft');
  assert.equal(previews, 1); assert.equal(executions, 0); assert.equal(f.requests.length, 0);
});
for (const [id, query, expected] of [
  ['SKU', 'ABA-ACE-002', 'EXACT'], ['NAME', 'Cocinero', 'CANDIDATES'],
  ['TYPO', 'Cocinro', 'CANDIDATES'], ['AMBIGUOUS', 'Aceite', 'MULTIPLE'],
  ['PACK', 'Arroz Costeño 750 g', 'MATCH'], ['WRONG-PACK', 'Arroz Costeño 900 g', 'NONE']
]) test(`N-ENTITY-${id} uses the existing bounded product matcher`, () => {
  const { rankEntities } = require('../src/automations/entityResolution');
  const { products } = require('./helpers/j2nGroundedFixture');
  const result = rankEntities(products.map((row, index) => ({ _id: String(index), sku: row.sku, name: row.productName })), query);
  const matches = result.value ? [result.value] : result.candidates;
  if (expected === 'NONE') assert.equal(matches.length, 0);
  else if (expected === 'MULTIPLE') assert.equal(matches.length, 2);
  else { assert.ok(matches.length > 0); if (expected === 'EXACT') assert.equal(result.confidence, 'EXACT'); }
});
for (const text of ['Bearer PRIVATE_TOKEN', 'Cookie=session=PRIVATE_COOKIE', 'mongodb://PRIVATE_URI',
  'sk-' + 'PRIVATESECRET'.repeat(3), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.PRIVATE_SIGNATURE'])
  test('N-SECURITY unsafe generated credential content is rejected: ' + text.split(/[=:]/)[0].slice(0, 16), () => {
    const out = valid(); out.observations[0].interpretation = text;
    assert.throws(() => validate(out), error => error.validationReason === 'UNSAFE_CONTENT');
  });
test('N-CONTEXT an impossible envelope budget fails in a controlled way before any provider call', () => {
  assert.throws(() => buildGroundedContext({ question: query, plan, binding, results: [], systemPrompt: 'x'.repeat(8000) }),
    { message: 'GROUNDED_CONTEXT_TOO_LARGE' });
});
for (const [id, value, expected] of [['BUDGET', 'x'.repeat(8000), 'CONTEXT_BUDGET_EXCEEDED'],
  ['BUILD', 2n, 'CONTEXT_BUILD_FAILED']]) test(`N-CONTEXT-${id} handler preserves facts and skips the provider`, async t => {
  t.mock.method(console, 'info', () => {});
  const f = fixture({ modifyResult: result => { result.metadata.snapshotHash = value; } }), result = await f.run(query);
  assert.equal(result.grounded.responseDiagnostic.validationReason, expected);
  assert.equal(f.requests.length, 0); assert.equal(result.usage.totalTokens, 0);
  assert.match(result.answer, /se conservan los hechos/);
});
for (const days of [1, 7, 14]) test(`N-PLAN explicit forecast horizon ${days} is preserved`, () => {
  const planned = buildGroundedPlan(`Analiza ventas, inventario y forecast para ${days} días`, binding);
  assert.equal(planned.tasks.find(task => task.skillId === F).args.horizonDays, days);
});
test('N-PLAN 28-day operational forecast is clarified before all skills/provider calls', async () => {
  const f = fixture(), result = await f.run('Analiza ventas stock forecast y qué comprar para 28 días');
  assert.match(result.answer, /1, 7 o 14/); assert.equal(result.requiresClarification, true);
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
});
test('N-PLAN a past sales window never becomes a forecast horizon', () => {
  const planned = buildGroundedPlan('Analiza ventas de últimos 30 días, inventario y forecast', binding);
  assert.equal(planned.tasks.find(task => task.skillId === F).args.horizonDays, 7);
});
test('N-PLAN ML evaluation plus SKU requests a safe clarification rather than changing evaluation to detail', () => {
  const planned = buildGroundedPlan('Interpreta el modelo HGB de ABA-ACE-002', binding);
  assert.deepEqual(planned.tasks, []); assert.match(planned.clarificationQuestion, /evaluación.*global/);
});
test('N-PLAN candidate-scoped context retains approved 1/7/14 forecast fields with their explicit horizon', () => {
  const planned = buildGroundedPlan('Recomienda reposición para 14 días y por qué', binding);
  const local = buildGroundedContext({ question: 'Recomienda reposición para 14 días y por qué', plan: planned, binding,
    results: planned.tasks.map(task => ({ skillId: task.skillId,
      result: { status: 'READY', data: dataFor(task.skillId, task.args), metadata: {} } })) });
  const forecast = local.evidence.find(row => row.skillId === F).facts;
  assert.equal(forecast.horizonDays, 14);
  assert.equal(forecast.items[0].expectedUnitsNext1d, 2.32);
  assert.equal(forecast.items[0].expectedUnitsNext7d, 10.75);
  assert.equal(forecast.items[0].expectedUnitsNext14d, 21.5);
});
for (const [id, patch, reason, kind] of [
  ['HTTP401', { http: 401 }, 'HTTP_ERROR', 'AUTHENTICATION'], ['HTTP429', { http: 429 }, 'HTTP_ERROR', 'RATE_LIMIT'],
  ['HTTP503', { http: 503 }, 'HTTP_ERROR', 'UNAVAILABLE'], ['JSON', { badJson: true }, 'ENVELOPE_JSON_INVALID', 'INVALID_RESPONSE'],
  ['USAGE', { usage: { total_tokens: 'PRIVATE' } }, 'USAGE_INVALID', 'INVALID_RESPONSE'],
  ['TRUNCATED', { finish: 'length' }, 'OUTPUT_TRUNCATED', 'INVALID_RESPONSE'],
  ['EMPTY', { content: '' }, 'CONTENT_EMPTY', 'INVALID_RESPONSE'],
  ['MODEL', { model: 'other' }, 'MODEL_MISMATCH', 'INVALID_RESPONSE'],
  ['FINISH', { finish: 'tool_calls' }, 'FINISH_REASON_UNSUPPORTED', 'INVALID_RESPONSE'],
  ['ENVELOPE', { role: 'user' }, 'ENVELOPE_SCHEMA_INVALID', 'INVALID_RESPONSE'],
  ['NETWORK', { network: true }, undefined, 'NETWORK'], ['TIMEOUT', { timeout: true }, undefined, 'TIMEOUT'],
  ['CONFIG', { noKey: true }, undefined, 'CONFIGURATION']
]) test(`N-PROVIDER-${id} is bounded, sanitized and never retries`, async () => {
  let calls = 0;
  const provider = createDeepSeekProvider({ env: { ...(patch.noKey ? {} : { DEEPSEEK_API_KEY: 'fictional-key' }), DEEPSEEK_TIMEOUT_MS: '10' },
    fetchImpl: async (_url, options) => {
      calls++;
      if (patch.network) throw new Error('PRIVATE-NETWORK');
      if (patch.timeout) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE-TIMEOUT'))));
      return { ok: !patch.http, status: patch.http || 200, json: async () => {
        if (patch.badJson) throw new Error('PRIVATE-JSON');
        return { model: patch.model || 'deepseek-flash', choices: [{ finish_reason: patch.finish || 'stop',
          message: { role: patch.role || 'assistant', content: patch.content ?? JSON.stringify(valid()), reasoning_content: 'PRIVATE-REASONING' } }],
          usage: patch.usage || { prompt_tokens: 1000, completion_tokens: 150, total_tokens: 1150, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 } };
      } };
    } });
  await assert.rejects(provider.generate({ route: 'GROUNDED_LLM', messages: [{ role: 'user', content: '{}' }], maxTokens: 600, temperature: 0 }), error => {
    assert.equal(error.failureKind, kind); assert.equal(error.responseDiagnostic?.validationReason, reason);
    assert.doesNotMatch(JSON.stringify({ error, diagnostic: safeGroundedDiagnostic(error.responseDiagnostic) }), /PRIVATE|fictional-key/);
    return true;
  });
  assert.equal(calls, patch.noKey ? 0 : 1);
});
