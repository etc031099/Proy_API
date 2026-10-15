'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
const { fixture, rows } = require('./helpers/j2sProductFixture');
const language = require('../src/agents/languageNlu');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const value = (intent, patch = {}) => ({ intent, productQuery: null, metric: null, period: null,
  quantity: null, horizonDays: null, needsClarification: false, clarificationReason: null, ...patch });
function setup(intent, patch = {}, transport, productRows) {
  const requests = [];
  const provider = createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'offline-only' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (transport) return transport(body);
      return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value(intent, patch)) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) };
    } });
  return { ...fixture({ neutralProvider: provider, ...(productRows ? { productRows } : {}) }), requests };
}
const sales = [
  'si tuvieras q decirme qué cosas se están moviendo bastante últimamente, cuáles serían?',
  'qué anda saliendo bastante por acá', 'q cosas se mueve mas ultimamente',
  'cuales estan saliendo un monton', 'que es lo que la gente se lleva mas', 'ando perdido q es lo q mas sale',
  'ando medio perdido, qué cosas están saliendo bastante por acá últimamente?'
];
for (const message of sales) test(`J41 sales language: ${message}`, async () => {
  const f = setup('TOP_SELLING_PRODUCTS'); const result = await f.run(message);
  assert.equal(result.requiresClarification, false, result.answer);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].domain, 'business');
  assert.equal(f.calls[0].payload.mode, 'rank'); assert.equal(f.calls[0].payload.metric, 'units');
  assert.ok(f.requests.length <= 1); assert.equal(f.mutations.length, 0);
  if (message.startsWith('si tuvieras')) assert.equal(f.requests.length, 1);
});
for (const message of ['si pudieras viajar a cualquier país cual elegirías', 'cuál es tu animal favorito',
  'qué harías si ganaras la lotería', 'quien ganará el mundial', 'recomiendame una pelicula', 'que musica te gusta'])
  test(`J41 OOD precedence: ${message}`, async () => {
    const f = setup('TOP_SELLING_PRODUCTS'); const r = await f.run(message);
    assert.equal(r.intent, 'out_of_domain'); assert.match(r.answer, /fuera de ese ámbito/);
    assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0); assert.equal(r.usage.totalLlmCalls, 0);
    assert.equal(r.usage.totalTokens, 0);
  });
for (const message of ['pan', 'primor', 'eso', 'hazlo']) test(`J41 genuine ambiguity: ${message}`, async () => {
  const f = setup('TOP_SELLING_PRODUCTS'); const r = await f.run(message);
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.mutations.length, 0);
  assert.ok(r.requiresClarification || r.suggestions?.length, r.answer);
});
test('J41 A: Cocinero implicit forecast keeps exact SKU through service and server-side state', async () => {
  const f = setup('FORECAST', { horizonDays: 7 }); await f.run('stock del cocinero');
  const before = (await f.snapshot()).v3Context.selectedProduct;
  assert.equal(before.key, 'ABA-ACE-002');
  const plan = language.nluPlan(value('FORECAST', { horizonDays: 7 }), 'y cuanto crees que salga esta semana?',
    (await f.snapshot()).v3Context, { operationalDate: '2026-10-15' });
  assert.deepEqual(plan.tasks[0].args, { limit: 5, mode: 'detail', horizonDays: 7, productRef: 'ABA-ACE-002' });
  const r = await f.run('y cuanto crees q salga esta semana?');
  assert.equal(f.requests.length, 1); assert.equal(r.requiresClarification, false, r.answer);
  const action = f.events.findLast(e => e.skillId === 'get_product_forecast'); assert.ok(action);
  const request = f.calls.at(-1); assert.equal(request.domain, 'forecast');
  assert.equal(request.payload.mode, 'detail'); assert.equal(request.payload.horizonDays, 7);
  assert.deepEqual(request.payload.skus, ['ABA-ACE-002']);
  assert.equal((await f.snapshot()).v3Context.selectedProduct.key, before.key);
  assert.match(r.answer, /14/); // Fake product forecast is 14; no aggregate response is allowed.
  assert.deepEqual(r.languageDecision, { detectedIntent: 'FORECAST', entitySource: 'active_context',
    contextEntityType: 'product', contextEntityId: 'ABA-ACE-002', semanticFallbackUsed: true });
  assert.deepEqual(publicResponse(r).languageDecision, r.languageDecision);
  assert.doesNotMatch(JSON.stringify(f.requests), /ABA-ACE-002|Aceite Vegetal/);
  assert.equal(f.mutations.length, 0);
});
test('J41 B: selected pan remains the target of an elliptical weekly forecast', async () => {
  const f = setup('FORECAST', { horizonDays: 7 });
  let r = await f.run('stock del pan'); assert.ok(r.suggestions?.length);
  const index = r.suggestions.findIndex(row => row.detail === 'PAN-FRE-001'); assert.ok(index >= 0);
  await f.run(String(index + 1)); r = await f.run('y como viene esta semana');
  assert.deepEqual(f.calls.at(-1).payload.skus, ['PAN-FRE-001']);
  assert.equal(f.calls.at(-1).payload.mode, 'detail'); assert.equal(f.requests.length, 1);
  assert.equal(f.mutations.length, 0); assert.equal(r.requiresClarification, false, r.answer);
});
test('J41 C: selected Gloria remains cross-sell target with frozen contract', async () => {
  const products = [...rows, { ...rows[0], _id: '0000000000000000000000ff', sku: 'DES-LEC-001', name: 'Leche Gloria 750 g' },
    { ...rows[0], _id: '0000000000000000000000fe', sku: 'DES-LEC-002', name: 'Leche Gloria Light' }];
  const f = setup('CROSS_SELL', {}, undefined, products);
  const list = await f.run('stock de leche gloria'); assert.ok(list.suggestions?.length, list.answer);
  const index = list.suggestions.findIndex(row => row.detail === 'DES-LEC-001'); assert.ok(index >= 0);
  await f.run(String(index + 1)); const r = await f.run('q se compra con ese');
  assert.equal(f.calls.at(-1).domain, 'cross-sell'); assert.equal(f.calls.at(-1).payload.sku, 'DES-LEC-001');
  assert.match(r.answer, /2026-10-12/); assert.equal(f.mutations.length, 0);
});
test('J41 D: customer intent never inherits active product filters', async () => {
  const f = setup('CUSTOMER_VALUE'); await f.run('stock del cocinero');
  const r = await f.run('como van mis clientes'); const request = f.calls.at(-1);
  assert.equal(request.domain, 'customers', r.answer);
  for (const key of ['skus', 'productSku', 'productSkus', 'productRef']) assert.equal(request.payload[key], undefined);
  assert.equal(f.mutations.length, 0);
});
test('J41 E: product does not invent supplier identity', async () => {
  const f = setup('SUPPLIER_PERFORMANCE'); await f.run('stock del cocinero');
  const count = f.calls.length, r = await f.run('y ese proveedor como anda');
  assert.equal(f.calls.length, count); assert.ok(r.requiresClarification); assert.match(r.answer, /proveedor/);
  assert.equal(f.mutations.length, 0);
});
test('J41 current explicit product wins over active product', async () => {
  const f = setup('FORECAST', { productQuery: 'primor', horizonDays: 7 }); await f.run('stock del cocinero');
  const r = await f.run('cuanto crees que salga primor esta semana');
  assert.deepEqual(f.calls.at(-1).payload.skus, ['ABA-ACE-001']);
  assert.equal((await f.snapshot()).v3Context.selectedProduct.key, 'ABA-ACE-001');
  assert.equal(r.languageDecision.entitySource, 'resolver');
});
for (const message of ['y cuanto crees q salga esta semana', 'cuanto crees q salga ese'])
  test(`J41 missing contextual target never executes aggregate: ${message}`, async () => {
    const f = setup('FORECAST'); const r = await f.run(message);
    assert.ok(r.requiresClarification, r.answer); assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 1);
  });
test('J41 explicitly global forecast remains global even with active product', () => {
  const plan = language.nluPlan(value('FORECAST'), 'y cuanto salga global del negocio esta semana',
    { selectedProduct: { key: 'ABA-ACE-002' } }, { operationalDate: '2026-10-15' });
  assert.equal(plan.tasks[0].args.mode, 'summary'); assert.equal(plan.tasks[0].args.productRef, undefined);
});
for (const failure of ['network', 'invalid']) test(`J41 uncertainty failure is bounded: ${failure}`, async () => {
  const f = setup('TOP_SELLING_PRODUCTS', {}, async () => {
    if (failure === 'network') throw new Error('offline network');
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }) };
  });
  const r = await f.run(sales[0]); assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.providerCalls.length, 0); assert.equal(f.mutations.length, 0); assert.ok(r.requiresClarification);
});
test('J41 hypothetical business phrasing is uncertainty, short approval remains protected', () => {
  assert.equal(language.fallbackDecision(sales[0], null), true);
  for (const message of ['si', 'sí', 'si ese', 'si hazlo', 'no', 'ya dale', 'hazlo'])
    assert.equal(language.fallbackDecision(message, null), false);
  assert.equal(language.fallbackDecision('pronostico 28 dias', { clarificationQuestion: 'Horizonte no aprobado' }), false);
});
test('J41 semantic OOD outside the lexical gate is public scope rejection, not business ambiguity', async () => {
  const f = setup('OUT_OF_DOMAIN'); const r = await f.run('si pudieras vivir en otro planeta cual escogerias');
  assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0); assert.equal(r.intent, 'out_of_domain');
  assert.match(r.answer, /fuera de ese ámbito/); assert.equal(r.languageDecision.detectedIntent, 'OUT_OF_DOMAIN');
});
test('J41 provider failure keeps active product intact and executes no aggregate', async () => {
  const f = setup('FORECAST', {}, async () => { throw new Error('offline'); });
  await f.run('stock del cocinero'); const r = await f.run('y cuanto crees q salga esta semana');
  assert.ok(r.requiresClarification); assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 1);
  assert.equal((await f.snapshot()).v3Context.selectedProduct.key, 'ABA-ACE-002');
  assert.equal(f.mutations.length, 0);
});
test('J41 WRITE selection is still preview and cancellation with zero execution', async t => {
  const { Product } = require('../src/models'); const { productFind } = require('./helpers/j2sProductFixture');
  t.mock.method(Product, 'find', productFind);
  const f = setup('CREATE_SALE'); const list = await f.run('vende 2 panes');
  assert.ok(list.suggestions?.length, list.answer);
  const r = await f.run('el segundo'); assert.equal(r.pendingAction.status, 'PENDING');
  assert.equal(f.mutations.length, 0); assert.equal(f.requests.length, 0);
  assert.equal((await f.run('mejor no')).pendingAction.status, 'CANCELLED');
  assert.equal(f.mutations.length, 0);
});
