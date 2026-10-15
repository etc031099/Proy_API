'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, productFind, id } = require('./helpers/j2sProductFixture');
const { Product } = require('../src/models');
test('J51 cloud exact: preview2 -> stock READ -> mejor quiero3', async t => {
  t.mock.method(Product, 'find', productFind);
  const f = fixture();
  await f.run('vende 2 panes'); const initial = await f.run('Opción 2');
  assert.equal(f.prepared.at(-1).products[0].quantity, 2);
  await f.run('cuanto stock tiene ese?');
  const changed = await f.run('mejor quiero 3');
  assert.equal(f.prepared.at(-1).products[0].quantity, 3, changed.answer);
  assert.notEqual(initial.pendingAction.pendingActionId, changed.pendingAction.pendingActionId);
  await f.run('cancelar'); assert.equal(f.mutations.length, 0);
});
const variants = ['mejor quiero 3', 'mejor 3', 'pon 3', 'cambialo a 3', 'en realidad 3', 'me equivoque quiero 3', 'no 2, mejor 3', 'hazlo por 3'];
for (const change of variants) for (const reads of [[], ['cuanto stock tiene ese?'], ['pronostico de PAN-FRE-001'],
  ['cuanto stock tiene ese?', 'pronostico de PAN-FRE-001'], ['clientes en riesgo']]) {
  test(`J51 WRITE ${change} after ${reads.join(';') || 'preview'}`, async t => {
    t.mock.method(Product, 'find', productFind);
    const f = fixture(); await f.run('vende 2 panes'); const initial = await f.run('Opción 2');
    const before = await f.snapshot();
    for (const read of reads) await f.run(read);
    const suspended = await f.snapshot();
    assert.equal(suspended.operationDraft.pendingActionId, before.operationDraft.pendingActionId);
    assert.equal(suspended.operationDraft.items[0].quantity, 2);
    const changed = await f.run(change);
    assert.equal(changed.pendingAction?.items[0].quantity, 3, changed.answer);
    assert.equal(changed.pendingAction.fields.total, 6); assert.equal(changed.pendingAction.items[0].resultingStock, 18);
    assert.equal(changed.pendingAction.items[0].sku, 'PAN-FRE-001');
    assert.equal(f.pending.get(initial.pendingAction.pendingActionId).status, 'CANCELLED');
    await assert.rejects(f.actionService.confirmPendingAction(null, initial.pendingAction.pendingActionId), { code: 'ACTION_CANCELLED' });
    const confirmed = await f.run('confirmar'); assert.equal(f.confirmations.length, 1);
    assert.equal(confirmed.pendingAction.result.items[0].quantity, 3); assert.equal(confirmed.pendingAction.result.total, 6);
    assert.equal(f.confirmations[0].id, changed.pendingAction.pendingActionId);
    assert.equal(f.confirmations[0].args.products[0].quantity, 3);
    assert.equal(f.providerCalls.length, 0);
  });
}
for (const change of variants) for (const state of ['missing', 'cancelled', 'expired']) test(`J51 ${state} cannot revive: ${change}`, async t => {
  t.mock.method(Product, 'find', productFind);
  let time = Date.now(); const f = fixture({ now: () => time, neutralProvider: null });
  if (state !== 'missing') { await f.run('vende 2 PAN-FRE-001'); if (state === 'cancelled') await f.run('cancelar'); else time += 21 * 60000; }
  const count = f.prepared.length;
  await f.run(change); await f.run('confirmar');
  assert.equal(f.prepared.length, count); assert.equal(f.mutations.length, 0);
});
test('J51 change after READ then cancel and explicit withdrawal do not execute', async t => {
  t.mock.method(Product, 'find', productFind);
  const f = fixture(); await f.run('vende 2 PAN-FRE-001'); await f.run('cuanto stock tiene ese?');
  await f.run('mejor quiero 3'); await f.run('cancelar');
  assert.equal((await f.snapshot()).operationDraft, null);
  await f.run('vende 2 PAN-FRE-001'); await f.run('no quiero vender, solo quería saber stock');
  assert.equal((await f.snapshot()).operationDraft, null); assert.equal(f.mutations.length, 0);
});
test('J51 new explicit sale invalidates old preview and replaces product', async t => {
  t.mock.method(Product, 'find', productFind);
  const f = fixture(); const old = await f.run('vende 2 PAN-FRE-001');
  const next = await f.run('vende 4 ABA-ACE-001');
  assert.equal(f.pending.get(old.pendingAction.pendingActionId).status, 'CANCELLED');
  assert.equal(next.pendingAction.items[0].sku, 'ABA-ACE-001'); assert.equal(next.pendingAction.items[0].quantity, 4);
  await f.run('cancelar'); assert.equal(f.mutations.length, 0);
});
test('J51 pending action expiry cannot be bypassed while the draft TTL remains active', async t => {
  t.mock.method(Product, 'find', productFind); let time = Date.now(); const f = fixture({ now: () => time, neutralProvider: null });
  await f.run('vende 2 PAN-FRE-001'); time += 61000;
  const r = await f.run('mejor quiero 3'); assert.equal(r.requiresClarification, true);
  assert.equal(f.prepared.length, 1); await f.run('confirmar'); assert.equal(f.mutations.length, 0);
});
const contacts = [1, 2].map(n => ({ _id: id(700 + n), businessId: 'MINIMARKET-PASCO-V3', scenarioId: 'minimarket-pasco-v3',
  type: 'customer', isActive: true, stableCode: `CLI-00${n}`, name: n === 1 ? 'Ana' : 'Rosa' }));
function explanationFixture(options = {}) {
  return fixture({ neutralProvider: null, contactRows: [...contacts, { ...contacts[0], _id: id(800), type: 'vendor', stableCode: 'SUP-001', name: 'Proveedor simulado' }], mlTransform(domain, _payload, response) {
    if (domain === 'suppliers') response.data = { items: [{ supplierCode: 'SUP-001', displayName: 'Proveedor simulado',
      purchaseOrderCount: 5, pendingOrderCount: 1, receivedSpendCents: 1000, leadTime: { averageDays: 4, sampleSize: 5 },
      punctuality: { onTimeRatePct: 80 }, productsSupplied: [] }], total: 1 };
    return response;
  }, ...options });
}
for (const [query, followup, expected] of [
  ['q debo reponer?', 'por q?', /reposici[oó]n|stock/i], ['stock de PAN-FRE-001', 'por que?', /21 unidades disponibles/],
  ['cuanto venderemos de cocinero?', 'como sabes?', /media m[oó]vil de 28 d[ií]as/],
  ['quienes estan en riesgo?', 'por que el primero?', /Ana[\s\S]*35 d[ií]as/],
  ['quien es el menos puntual?', 'por q?', /puntualidad 80%/],
  ['q se compra con PAN-FRE-001?', 'por qué?', /FP-Growth[\s\S]*no implica causalidad/],
  ['como va el negocio?', 'que significa eso?', /señales|indicadores/i]
]) test(`J51 explanation ${query} -> ${followup}`, async () => {
  const f = explanationFixture(); const first = await f.run(query);
  assert.equal(first.requiresClarification, false, first.answer);
  const count = f.calls.length; const r = await f.run(followup);
  assert.equal(r.intent, 'explain_previous'); assert.equal(r.requiresClarification, false, r.answer);
  assert.match(r.answer, expected); assert.equal(f.calls.length, count); assert.equal(r.usage.totalLlmCalls, 0);
  assert.doesNotMatch(r.answer, /probabilidad.*\d+\s*%/); assert.equal(f.providerCalls.length, 0);
});
for (const followup of ['por que?', 'por qué?', 'como sabes?', 'de donde sale eso?', 'por que dices eso?', 'explicame eso', 'por qué ese?', 'estas seguro?'])
  test(`J51 short explanation alias: ${followup}`, async () => {
    const f = explanationFixture(); await f.run('stock de PAN-FRE-001'); const r = await f.run(followup);
    assert.equal(r.intent, 'explain_previous'); assert.equal(r.requiresClarification, false, r.answer); assert.equal(r.usage.totalLlmCalls, 0);
  });
test('J51 ambiguous singular after client list asks which; ordinal explains only first', async () => {
  const f = explanationFixture(); await f.run('clientes en riesgo'); const ambiguous = await f.run('por que el?');
  assert.equal(ambiguous.requiresClarification, true);
  const r = await f.run('por que el primero?'); assert.match(r.answer, /Ana/); assert.doesNotMatch(r.answer, /Rosa/);
});
test('J51 OOD and skill failure erase prior explanation; provider failure preserves only safe facts', async () => {
  const f = explanationFixture(); await f.run('stock de PAN-FRE-001'); await f.run('cuentame un cuento');
  assert.equal((await f.run('por q?')).requiresClarification, true);
  const failed = explanationFixture({ mlTransform() { throw new Error('PRIVATE offline failure'); } });
  await failed.run('stock de PAN-FRE-001'); const r = await failed.run('por q?');
  assert.equal(r.requiresClarification, true); assert.doesNotMatch(r.answer, /PRIVATE|stock 21/);
  const partial = explanationFixture(); await partial.run('q debo reponer esta semana y por que?');
  assert.equal((await partial.snapshot()).lastExplanation.responseType, 'FALLBACK_FACTS');
  assert.match((await partial.run('por q?')).answer, /solo puedo explicar los hechos/);
});
test('J51 explanation snapshot is bounded, restorable, expires, and is bound to conversation', async () => {
  let time = Date.now(); const f = explanationFixture({ now: () => time });
  const originalNow = Date.now; Date.now = () => time;
  try {
    await f.run('clientes en riesgo');
    const snapshot = require('../src/services/agentHistoryProjection').snapshot(await f.snapshot());
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.lastExplanation)) <= 6400);
    assert.doesNotMatch(JSON.stringify(snapshot.lastExplanation), /reasoning_content|systemPrompt|messages|rawResponse/);
    const restored = explanationFixture({ now: () => time });
    await restored.actions.restoreContext(restored.request, f.conversationId, snapshot);
    assert.equal((await restored.run('por q?', f.conversationId)).requiresClarification, false);
    const other = explanationFixture({ now: () => time }); await other.actions.restoreContext(other.request, other.conversationId, snapshot);
    assert.equal((await other.run('por q?')).requiresClarification, true);
    time += 31 * 60000; assert.equal((await f.run('por q?')).requiresClarification, true);
  } finally { Date.now = originalNow; }
});
for (const valid of [true, false]) test(`J51 explanation reuses facts after mocked provider ${valid ? 'accepted synthesis' : 'invalid response'}`, async t => {
  t.mock.method(console, 'info', () => {});
  let calls = 0;
  const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
  const neutralProvider = createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'fictional-offline-only' }, fetchImpl: async (_url, options) => {
    calls++;
    const compact = JSON.parse(JSON.parse(options.body).messages[1].content);
    const content = valid ? JSON.stringify(require('./helpers/j2nGroundedFixture').synthesisFor(compact)) : '{"invalid":true}';
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) };
  } });
  const f = explanationFixture({ neutralProvider });
  await f.run('q debo reponer esta semana y por que?'); assert.equal(calls, 1);
  const count = f.calls.length, r = await f.run('por q?');
  assert.equal(r.requiresClarification, false); assert.equal(calls, 1); assert.equal(f.calls.length, count);
  assert.equal(r.usage.totalLlmCalls, 0); assert.equal(r.usage.totalTokens, 0);
  if (!valid) assert.match(r.answer, /solo puedo explicar los hechos/);
});
test('J51 action preview supersedes READ explanation and never explains a stale recommendation', async t => {
  t.mock.method(Product, 'find', productFind); const f = explanationFixture();
  await f.run('stock de PAN-FRE-001'); await f.run('vende 2 PAN-FRE-001');
  assert.equal((await f.snapshot()).lastExplanation, null);
  await f.run('cancelar'); assert.equal(f.mutations.length, 0);
});
test('J51 cloud exact: supported replenishment answer -> por q?', async () => {
  const f = fixture({ neutralProvider: null });
  await f.run('q debo reponer esta semana y por que?');
  const before = f.calls.length;
  const r = await f.run('por q?');
  assert.equal(r.intent, 'explain_previous', r.answer);
  assert.equal(r.usage.totalLlmCalls, 0);
  assert.equal(f.calls.length, before);
  assert.match(r.answer, /stock|cobertura|reposici[oó]n/i);
});
