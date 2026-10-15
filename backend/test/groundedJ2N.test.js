'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matrix, I, F, S } = require('./fixtures/j2nAcceptanceMatrix');
const { fixture } = require('./helpers/j2nGroundedFixture');
const { classifyGrounded } = require('../src/agents/groundedRouting');
const { publicResponse } = require('../src/services/agentHistoryProjection');
test('N-MATRIX manifest has 80 independent query expectations across all seven domains', () => {
  assert.equal(matrix.length, 80); assert.equal(new Set(matrix.map(row => row.query)).size, 80);
  assert.deepEqual(Object.fromEntries(['GROUNDED_LLM', 'DETERMINISTIC', 'OUT_OF_DOMAIN', 'WRITE_AMBIGUOUS']
    .map(kind => [kind, matrix.filter(row => row.kind === kind).length])),
  { GROUNDED_LLM: 50, DETERMINISTIC: 15, OUT_OF_DOMAIN: 10, WRITE_AMBIGUOUS: 5 });
  assert.equal(new Set(matrix.flatMap(row => row.skills)).size, 7);
});
for (const row of matrix) test(`${row.id} ${row.kind}: ${row.query}`, async t => {
  t.mock.method(console, 'info', () => {});
  const f = fixture(), result = await (row.kind === 'WRITE_AMBIGUOUS' ? f.runWrite(row.query) : f.run(row.query));
  assert.equal(f.requests.length, row.providerCalls, JSON.stringify({ result, calls: f.calls, generic: f.genericCalls() }));
  assert.equal(f.genericCalls(), 0); assert.deepEqual(f.calls.map(item => item.skill), row.skills);
  assert.ok(result.answer.trim().length > 15); assert.ok(result.answer.length < 2200);
  if (row.kind === 'GROUNDED_LLM') {
    assert.equal(classifyGrounded(row.query).route, row.kind);
    assert.equal(result.grounded.responseDiagnostic.validationResult, row.validationExpected, JSON.stringify(result.grounded));
    assert.equal(result.grounded.responseDiagnostic.finishReason, 'stop');
    assert.equal(result.usage.llmCalls, 1); assert.equal(result.usage.outputTokens, 250);
    assert.equal(result.usage.totalTokens, 2050); assert.ok(result.usage.estimatedCostRangeUsd.max > 0);
    assert.ok(result.grounded.contextMetrics.bytes <= 6400);
    const compact = JSON.parse(f.requests[0].messages[1].content);
    assert.deepEqual(compact.evidence.map(item => item.skillId), row.skills);
    assert.doesNotMatch(result.answer, /observations|evidenceRefs|"facts"|PRIVATE/);
  } else {
    assert.equal(result.usage.totalTokens, 0); assert.equal(result.usage.estimatedCostUsd, 0);
    if (row.kind === 'OUT_OF_DOMAIN') { assert.equal(result.intent, 'out_of_domain'); assert.equal(result.usage.totalSkillCalls, 0); }
    if (row.kind === 'WRITE_AMBIGUOUS') assert.ok(result.requiresClarification || /no .*|indica|confirm|qu[eé]|ayudar|especifica/i.test(result.answer));
  }
  assert.doesNotMatch(JSON.stringify(publicResponse(result)), /fictional-only|PRIVATE-REASONING|Authorization/);
});
test('N-QUALITY exact inventory/forecast fixture produces useful priorities and candidate-scoped forecast', async t => {
  t.mock.method(console, 'info', () => {});
  const f = fixture(), result = await f.run(matrix[0].query);
  assert.deepEqual(f.calls.map(row => row.skill), [I, F, S]);
  assert.equal(f.calls[1].args.productRefs, 'ABA-ACE-001|ABA-ACE-002|ABA-ARR-001');
  for (const pattern of [/Cocinero/, /24/, /Primor/, /18/, /Arroz/, /57/, /34,75/, /antes de preparar/]) assert.match(result.answer, pattern);
  assert.doesNotMatch(result.answer, /Inventario:|Proveedores:|PRIVATE|Proveedor no relacionado/);
});
