'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { rankEntities, resolveReference } = require('../src/automations/entityResolution');
const { Product } = require('../src/models');
const { publicResponse, snapshot: projectSnapshot } = require('../src/services/agentHistoryProjection');
const { TTL_MS } = require('../src/agents/memory');
const { fixture, rows, productFind, id } = require('./helpers/j2sProductFixture');
const selected = result => result.value || (result.confidence === 'HIGH_CONFIDENCE' ? result.candidates[0] : null);
const zero = (f, result) => {
  assert.equal(result.code ?? null, null, result.answer);
  assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalTokens, 0);
  assert.ok(!result.actions?.some(row => row.status === 'FAILED'), result.answer);
  assert.deepEqual(f.providerCalls, []);
};

for (const [reference, sku] of [
  ['PAN-FRE-001', 'PAN-FRE-001'], ['pan-fre-001', 'PAN-FRE-001'], ['PAN-FRE', 'PAN-FRE-001'],
  ['ACE-002', 'ABA-ACE-002'], ['Pan Francés fresco paquete 4 unidades', 'PAN-FRE-001'],
  [' EL  PAN FRANCÉS FRESCO PAQUETE 4 UNIDADES!!!', 'PAN-FRE-001'],
  ['pan frances', 'PAN-FRE-001'], ['panes franceses', 'PAN-FRE-001'], ['el pan frances', 'PAN-FRE-001'],
  ['«el pan francés»', 'PAN-FRE-001'],
  ['bimbo', 'PAN-ENV-001'], ['la bimbo', 'PAN-ENV-001'], ['cocinero', 'ABA-ACE-002'],
  ['cocineros', 'ABA-ACE-002'], ['cocienro', 'ABA-ACE-002'], ['primro', 'ABA-ACE-001'],
  ['franses', 'PAN-FRE-001'], ['primor', 'ABA-ACE-001'], ['aceite primor', 'ABA-ACE-001']
]) test(`J2S common matching: ${reference}`, () => assert.equal(selected(rankEntities(rows, reference))?.sku, sku));

for (const [reference, expected] of [['pan', 2], ['el pan', 2], ['panes', 2], ['coca', 2], ['Coca-Cola', 2]])
  test(`J2S ambiguity is retained: ${reference}`, () => {
    const result = rankEntities(rows, reference); assert.equal(result.resolutionStatus, 'MULTIPLE_MATCHES');
    assert.equal(result.pagination.totalMatches, expected); assert.equal(selected(result), null);
  });

for (const reference of ['producto fantasma zzz', 'asdfghjkl', 'negocio', 'riesgo', 'ventas', 'clientes', 'bi', 'fr'])
  test(`J2S no plausible product: ${reference}`, () => assert.equal(rankEntities(rows, reference).pagination.totalMatches, 0));

test('J2S an exact SKU outranks a colliding product name', () => {
  const result = rankEntities([...rows, { _id: id(80), sku: 'ZZZ-001', name: 'PAN-FRE-001' }], 'PAN-FRE-001');
  assert.equal(result.resolutionStatus, 'EXACT'); assert.equal(result.value.sku, 'PAN-FRE-001');
});

test('J2S real 80-product catalog preserves brand ambiguity instead of inventing a Primor alias', () => {
  const catalog = require('../../data/minimarket-pasco-v3/products.json').catalog.map((row, i) => ({ ...row, _id: id(i + 1) }));
  const result = rankEntities(catalog, 'primor'); assert.equal(result.confidence, 'AMBIGUOUS');
  assert.ok(result.candidates.some(row => row.sku === 'ABA-ACE-001'));
  assert.ok(result.candidates.some(row => row.sku === 'CON-ATU-003'));
  assert.equal(rankEntities(catalog, 'aceite primor').confidence, 'AMBIGUOUS');
  assert.equal(selected(rankEntities(catalog, 'aceite vegetal primor premium'))?.sku, 'ABA-ACE-001');
});

for (const [message, domain, sku] of [
  ['stock del pan frances', 'inventory', 'PAN-FRE-001'], ['stock del cocinero', 'inventory', 'ABA-ACE-002'],
  ['stock del cocienro', 'inventory', 'ABA-ACE-002'], ['pronóstico del primor', 'forecast', 'ABA-ACE-001'],
  ['pronóstico de la bimbo', 'forecast', 'PAN-ENV-001'], ['pronóstico de PAN-FRE-001', 'forecast', 'PAN-FRE-001'],
  ['qué se compra con el bimbo', 'cross-sell', 'PAN-ENV-001'], ['qué se compra con PAN-FRE', 'cross-sell', 'PAN-FRE-001'],
  ['cuánto vendí de pan frances ayer', 'business', 'PAN-FRE-001'], ['reponer el aceite primor', 'inventory', 'ABA-ACE-001']
]) test(`J2S READ resolves before analytics: ${message}`, async () => {
  const f = fixture(), response = await f.run(message); zero(f, response);
  assert.equal(f.calls.length, 1, response.answer); assert.equal(f.calls[0].domain, domain);
  const payload = f.calls[0].payload;
  assert.equal(payload.sku || payload.productSku || payload.skus?.[0], sku);
  assert.equal((await f.snapshot()).v3Context.selectedProduct.key, sku);
});

for (const [choice, sku] of [['1', 'PAN-ENV-001'], ['2', 'PAN-FRE-001'], ['el primero', 'PAN-ENV-001'],
  ['primero', 'PAN-ENV-001'], ['el segundo', 'PAN-FRE-001'], ['segundo', 'PAN-FRE-001'],
  ['PAN-FRE-001', 'PAN-FRE-001'], ['pan frances', 'PAN-FRE-001']])
  test(`J2S visible selection resumes the pending READ: ${choice}`, async () => {
    const f = fixture(), candidates = await f.run('stock del pan'); zero(f, candidates);
    assert.equal(f.calls.length, 0); assert.equal(candidates.usage.totalSkillCalls, 0);
    assert.deepEqual(candidates.suggestions.map(row => row.detail), ['PAN-ENV-001', 'PAN-FRE-001']);
    const response = await f.run(choice); zero(f, response);
    assert.equal(f.calls.length, 1, response.answer); assert.equal(f.calls[0].payload.skus[0], sku);
    assert.equal((await f.snapshot()).v3Context.pending, null);
  });

test('J2S original cloud Pan question continues cross-sell immediately after numeric selection', async () => {
  const f = fixture(), candidates = await f.run('¿Qué productos suelen comprarse junto con el Pan y cuáles me conviene recomendar?');
  zero(f, candidates); assert.equal(candidates.suggestions.length, 2); assert.equal(f.calls.length, 0);
  const state = await f.snapshot(); assert.equal(state.v3Context.pending.tasks[0].skillId, 'get_cross_sell_recommendations');
  const response = await f.run('2'); zero(f, response); assert.equal(f.calls[0].domain, 'cross-sell');
  assert.equal(f.calls[0].payload.sku, 'PAN-FRE-001'); assert.equal(f.calls[0].payload.context.asOfDate, '2026-10-12');
  assert.match(response.answer, /Coca-Cola/); assert.equal(response.productResolution.resumedSkillId, 'get_cross_sell_recommendations');
  assert.equal(publicResponse(response).productResolution.sku, 'PAN-FRE-001');
});

for (const choice of ['el primero', '1']) test(`J2S simple cross-sell pending intent survives ${choice}`, async () => {
  const f = fixture(); zero(f, await f.run('qué se compra con el pan'));
  zero(f, await f.run(choice)); assert.equal(f.calls[0].payload.sku, 'PAN-ENV-001');
});

for (const choice of ['el tercero', '3', '0', '6', '-1', '+1', '2.5', '99999999999999999999999', 'no el segundo', 'el primero y el segundo'])
  test(`J2S invalid selection never dispatches: ${choice}`, async () => {
    const f = fixture(); await f.run('qué se compra con el pan'); const response = await f.run(choice);
    zero(f, response); assert.equal(response.requiresClarification, true, response.answer); assert.equal(f.calls.length, 0);
  });

for (const pronoun of ['ese', 'esa', 'ese producto', 'este', 'este producto', 'el anterior', 'el mismo'])
  test(`J2S cross-skill contextual reference: ${pronoun}`, async () => {
    const f = fixture(); await f.run('stock del pan'); await f.run('2');
    const response = await f.run(`y qué se compra con ${pronoun}`); zero(f, response);
    assert.equal(f.calls.at(-1).domain, 'cross-sell'); assert.equal(f.calls.at(-1).payload.sku, 'PAN-FRE-001');
  });

for (const message of ['ese', 'el anterior', 'stock de ese', 'qué se compra con ese', 'pronóstico de ese'])
  test(`J2S missing context asks instead of guessing: ${message}`, async () => {
    const f = fixture(), response = await f.run(message); zero(f, response);
    assert.equal(response.requiresClarification, true); assert.equal(f.calls.length, 0);
  });

test('J2S contextual forecast uses seven days and an explicit override replaces the active product', async () => {
  const f = fixture(); await f.run('stock del pan'); await f.run('2');
  zero(f, await f.run('y cuánto se venderá esta semana'));
  assert.equal(f.calls.at(-1).domain, 'forecast'); assert.equal(f.calls.at(-1).payload.horizonDays, 7);
  assert.deepEqual(f.calls.at(-1).payload.skus, ['PAN-FRE-001']);
  zero(f, await f.run('y del aceite primor?'));
  assert.deepEqual(f.calls.at(-1).payload.skus, ['ABA-ACE-001']);
  assert.equal((await f.snapshot()).v3Context.selectedProduct.key, 'ABA-ACE-001');
});

test('J2S a newer visible list replaces the older list and its pending intent', async () => {
  const f = fixture(); await f.run('stock del pan'); await f.run('pronóstico de la coca');
  zero(f, await f.run('el segundo')); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].domain, 'forecast');
  assert.deepEqual(f.calls[0].payload.skus, ['BEB-GAS-002']);
});

test('J2S expired conversation context cannot revive a selected product', async () => {
  let instant = Date.now(); const f = fixture({ now: () => instant, memoryTtl: 10 });
  await f.run('stock del pan'); await f.run('2'); instant += 11;
  const before = f.calls.length, response = await f.run('qué se compra con ese'); zero(f, response);
  assert.equal(response.requiresClarification, true); assert.equal(f.calls.length, before);
});

test('J2S restored expired V3 and product references are both discarded', async () => {
  const f = fixture(); await f.run('stock del pan frances'); const old = structuredClone(await f.snapshot());
  old.v3Context.expiresAt = Date.now() - 1; old.selectedProductReference.createdAt = Date.now() - TTL_MS - 1;
  const other = randomUUID(); await f.runtime.restoreContext(f.request, other, old);
  const before = f.calls.length, response = await f.run('qué se compra con ese', other); zero(f, response);
  assert.equal(response.requiresClarification, true); assert.equal(f.calls.length, before);
});

test('J2S compact snapshot preserves pending parameters and keeps tenant/conversation binding', async () => {
  const f = fixture(); await f.run('pronóstico del pan para 14 días');
  const saved = projectSnapshot(await f.snapshot()); assert.equal(saved.v3Context.pending.tasks[0].args.horizonDays, 14);
  const other = randomUUID(); await f.runtime.restoreContext(f.request, other, saved);
  const response = await f.run('el segundo', other); zero(f, response); assert.equal(response.requiresClarification, true); assert.equal(f.calls.length, 0);
  zero(f, await f.run('el segundo')); assert.equal(f.calls[0].payload.horizonDays, 14);
});

test('J2S no-match clears an obsolete candidate list', async () => {
  const f = fixture(); await f.run('stock del pan'); const response = await f.run('pronóstico de producto fantasma zzz');
  zero(f, response); assert.match(response.answer, /No encontré productos similares/);
  assert.equal((await f.snapshot()).v3Context.ranking, null); zero(f, await f.run('el segundo')); assert.equal(f.calls.length, 0);
});

for (const message of ['cómo está el negocio', 'qué clientes están en riesgo', 'Dame un resumen general'])
  test(`J2S non-product intent never scans the product catalog: ${message}`, async () => {
    const f = fixture(), response = await f.run(message); zero(f, response); assert.equal(f.catalogReads.length, 0, response.answer);
  });

test('J2S WRITE shares the tenant-scoped matching implementation and does not execute on selection', async t => {
  t.mock.method(Product, 'find', productFind);
  const f = fixture(), candidates = await f.run('vende 2 panes'); zero(f, candidates);
  assert.equal(candidates.suggestions.length, 2); assert.equal(f.prepared.length, 0); assert.equal(f.mutations.length, 0);
  const preview = await f.run('el segundo'); zero(f, preview); assert.ok(preview.pendingAction);
  assert.deepEqual(f.prepared[0].products, [{ productId: rows.find(row => row.sku === 'PAN-FRE-001')._id, quantity: 2 }]);
  assert.equal(f.mutations.length, 0); assert.equal((await f.snapshot()).v3Context.selectedProduct.key, 'PAN-FRE-001');
  const response = await f.run('confirmo'); zero(f, response); assert.equal(f.mutations.length, 1, 'mock execution only');
  await f.run('confirmo'); assert.equal(f.mutations.length, 1, 'repeated confirmation cannot execute again');
});

test('J2S numeric candidate selection differs from a missing quantity reply', async t => {
  t.mock.method(Product, 'find', productFind);
  const f = fixture(); await f.run('vende pan'); zero(f, await f.run('2'));
  assert.equal(f.prepared.length, 0); assert.ok((await f.snapshot()).operationDraft.missingFields.includes('quantity'));
  zero(f, await f.run('2')); assert.equal(f.prepared[0].products[0].quantity, 2);
  assert.equal(f.prepared[0].products[0].productId, rows.find(row => row.sku === 'PAN-FRE-001')._id); assert.equal(f.mutations.length, 0);
});

for (const message of ['vende 2 cocineros', 'vende 2 cocienro', 'compra 5 aceites', 'compra 5 cocineros'])
  test(`J2S WRITE uses common matching and remains a preview: ${message}`, async t => {
    t.mock.method(Product, 'find', productFind); const f = fixture(); let response = await f.run(message); zero(f, response);
    if (response.suggestions?.length) response = await f.run('1');
    zero(f, response); assert.ok(response.pendingAction, response.answer); assert.equal(f.mutations.length, 0);
    const cancelled = await f.run('cancela'); zero(f, cancelled); assert.equal(cancelled.pendingAction.status, 'CANCELLED'); assert.equal(f.mutations.length, 0);
  });

test('J2S explicit contextual WRITE prepares the active product and cancellation makes no mutation', async t => {
  t.mock.method(Product, 'find', productFind); const f = fixture(); await f.run('stock del pan'); await f.run('2');
  const response = await f.run('vende 2 de ese'); zero(f, response); assert.ok(response.pendingAction);
  assert.equal(f.prepared[0].products[0].productId, rows.find(row => row.sku === 'PAN-FRE-001')._id);
  await f.run('cancela'); assert.equal(f.mutations.length, 0);
});

test('J2S READ and WRITE resolver results agree for names, partial SKU and typos', async t => {
  t.mock.method(Product, 'find', productFind); const f = fixture();
  for (const reference of ['PAN-FRE-001', 'PAN-FRE', 'pan frances', 'bimbo', 'el cocinero', 'cocienro', 'primro']) {
    const read = await f.service.resolveEntity('product', reference, { businessId: f.request.businessId, requestId: randomUUID() });
    const write = await resolveReference(Product, { businessId: f.request.businessId }, reference);
    assert.equal(read.entity.key, selected(write).sku, reference);
  }
});

test('J2S cloud bread sequence also works with all 80 canonical product names', async () => {
  const productRows = [...require('../../data/minimarket-pasco-v3/products.json').catalog]
    .sort((a, b) => a.sku.localeCompare(b.sku)).map((row, index) => ({ ...row, _id: id(index + 1),
      businessId: rows[0].businessId, scenarioId: rows[0].scenarioId, isActive: true }));
  const f = fixture({ productRows });
  const candidates = await f.run('¿Qué productos suelen comprarse junto con el Pan y cuáles me conviene recomendar?'); zero(f, candidates);
  assert.deepEqual(candidates.suggestions.map(row => row.detail), ['PAN-ENV-001', 'PAN-FRE-001']);
  assert.equal(f.calls.length, 0); zero(f, await f.run('2')); assert.equal(f.calls[0].payload.sku, 'PAN-FRE-001');
});

test('J2S two ambiguous product slots preserve the forecast comparison and both choices', async () => {
  const f = fixture(); zero(f, await f.run('compara pronóstico de pan y coca'));
  assert.equal(f.calls.length, 0); zero(f, await f.run('2')); assert.equal(f.calls.length, 0);
  zero(f, await f.run('1')); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.mode, 'compare'); assert.deepEqual(f.calls[0].payload.skus, ['PAN-FRE-001', 'BEB-GAS-001']);
});

for (const message of ['quién juega mañana', 'cuéntame un cuento', 'cuánto cuesta Bitcoin'])
  test(`J2S OUT_OF_DOMAIN stays zero-cost without product resolution: ${message}`, async () => {
    const f = fixture(), response = await f.run(message); zero(f, response);
    assert.equal(response.intent, 'out_of_domain'); assert.equal(f.calls.length, 0); assert.equal(f.catalogReads.length, 0);
  });

test('J2S an unknown exact-looking SKU never dispatches a business skill', async () => {
  const f = fixture(), response = await f.run('pronóstico de ZZZ-UNKNOWN-999'); zero(f, response);
  assert.equal(response.requiresClarification, true); assert.equal(f.calls.length, 0); assert.equal(response.usage.totalSkillCalls, 0);
});

test('J2S ambiguity in a later task retains every unexecuted intention and its period', async () => {
  const f = fixture(); const candidates = await f.run('ventas de bimbo ayer y cuál es el stock del pan'); zero(f, candidates);
  assert.equal(candidates.requiresClarification, true); assert.equal(f.calls.length, 0);
  const state = await f.snapshot(); assert.equal(state.v3Context.pending.taskIndex, 1);
  zero(f, await f.run('2')); assert.deepEqual(f.calls.map(row => row.domain), ['business', 'inventory']);
  assert.equal(f.calls[0].payload.productSku, 'PAN-ENV-001'); assert.equal(f.calls[0].payload.period.startDate, '2026-10-14');
  assert.deepEqual(f.calls[1].payload.skus, ['PAN-FRE-001']);
});

test('J2S public resolution telemetry omits unknown private fields', () => {
  const result = publicResponse({ productResolution: { status: 'EXACT', sku: 'PAN-FRE-001', prompt: 'private', reasoning: 'private', rawResponse: 'private' } });
  assert.deepEqual(result.productResolution, { status: 'EXACT', sku: 'PAN-FRE-001' });
});

test('J2S unsupported stock adjustments ask safely without resolving or invoking a provider', async () => {
  const f = fixture(), response = await f.run('ajusta stock del pan'); zero(f, response);
  assert.equal(response.requiresClarification, true); assert.equal(f.prepared.length, 0); assert.equal(f.calls.length, 0);
  assert.match(response.answer, /ajuste de stock/);
});
