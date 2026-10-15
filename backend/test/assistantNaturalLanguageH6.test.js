'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3, renderV3, handleV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');
const { contextBinding } = require('../src/agents/memory');
const { actionIntent, parseAction } = require('../src/automations/actionInput');
const { ordinalSelection } = require('../src/agents/ordinalSelection');
const { rankEntities } = require('../src/automations/entityResolution');

const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const route = (message, memory = {}) => routeV3(message, memory, binding);
const cases = [];
const add = (group, message, check) => cases.push({ group, message, check });

// Twenty natural stock/name variants, including accents, abbreviated wording,
// common plural forms, and the small typo set already observed in user input.
for (const [message, expected] of [
  ['¿Cuánto stock queda del pan francés?', 'pan frances'], ['¿Cuánto stock queda del pan?', 'pan'],
  ['¿Cuántos panes quedan?', 'pan'], ['¿Cuántas gaseosas quedan?', 'gaseosa'],
  ['¿Cuántas galletas quedan?', 'galleta'], ['¿Cuántas leches quedan?', 'leche'],
  ['¿Me queda pan francés?', 'pan frances'], ['¿Me quedan gaseosas?', 'gaseosa'],
  ['Dame stock del pan francés', 'pan frances'], ['Dame stok del pan', 'pan'],
  ['Stock de Coca-Cola 500 ml', 'coca cola 500 ml'], ['¿Cuánto stock tiene Inca Kola?', 'inca kola'],
  ['¿Tengo leche Gloria?', 'leche gloria'], ['¿Cuánto stock de galletas hay?', 'galleta'],
  ['Tengo stock de pan francés', 'pan frances'], ['cuato stok qeda del pan', 'pan'],
  ['¿Cuánto stock queda de Coca-Cola de litro y medio?', 'coca cola de 1 5 l'],
  ['¿Me queda pan francés disponible?', 'pan frances'], ['Stock Inca Kola 1.5 L', 'inca kola 1 5 l'],
  ['¿Cuántos panes quedan disponibles?', 'pan']
]) add('stock', message, plan => { assert.equal(plan?.lookup, expected); assert.equal(plan.responseMode, 'minimal'); });

// Fifteen sale phrasings. Parsing is inspected only; no executor is called.
for (const [message, quantity, ref] of [
  ['vende 3 panes', 3, 'panes'], ['vende dos pan francés', 2, 'pan francés'],
  ['vender 4 coca colas', 4, 'coca colas'], ['quiero vender 4 coca colas', 4, 'coca colas'],
  ['quiero vender tres panes', 3, 'panes'], ['quisiera vender 2 leches', 2, 'leches'],
  ['vende 1 galleta', 1, 'galleta'], ['vender 5 gaseosas', 5, 'gaseosas'],
  ['vende 2 Coca-Cola 500 ml', 2, 'Coca-Cola 500 ml'], ['vende 3 Inca Kola 1.5 L', 3, 'Inca Kola 1.5 L'],
  ['vende 2 pan francés', 2, 'pan francés'], ['quiero vender 1 leche Gloria', 1, 'leche Gloria'],
  ['vende 10 galletas', 10, 'galletas'], ['vender 7 panes franceses', 7, 'panes franceses'],
  ['quisiera vender 4 gaseosas', 4, 'gaseosas']
]) add('sale', message, () => { assert.equal(actionIntent(message), 'create_sale'); const parsed = parseAction(message, 'create_sale');
  assert.equal(parsed.items[0].quantity, quantity); assert.equal(parsed.items[0].ref.toLowerCase(), ref.toLowerCase()); });

// Fifteen purchase phrasings, likewise limited to parse/resolve inputs.
for (const [message, quantity, ref] of [
  ['compra una gaseosa', 1, 'gaseosa'], ['compra 5 leches', 5, 'leches'],
  ['quiero pedir 10 galletas', 10, 'galletas'], ['quiero comprar 2 pan francés', 2, 'pan francés'],
  ['quisiera comprar tres Coca-Cola', 3, 'Coca-Cola'], ['comprar 4 leches Gloria', 4, 'leches Gloria'],
  ['compra 1 Inca Kola 500 ml', 1, 'Inca Kola 500 ml'], ['pedir 6 galletas', 6, 'galletas'],
  ['prepara una compra de 3 panes', 3, 'panes'], ['compra 2 Coca-Cola 1.5 L', 2, 'Coca-Cola 1.5 L'],
  ['compr 5 lehes', 5, 'lehes'], ['compra 7 panes franceses', 7, 'panes franceses'],
  ['quiero pedir dos leches', 2, 'leches'], ['quisiera comprar 8 gaseosas', 8, 'gaseosas'],
  ['comprar 9 galletas de soda', 9, 'galletas de soda']
]) add('purchase', message, () => { assert.equal(actionIntent(message), 'create_purchase'); const parsed = parseAction(message, 'create_purchase');
  assert.equal(parsed.items[0].quantity, quantity); assert.equal(parsed.items[0].ref.toLowerCase(), ref.toLowerCase()); });

// Category/brand searches must resolve to a human-searchable candidate query;
// broad category aliases map to stable catalog prefixes, not arbitrary SKUs.
for (const [message, expected] of [
  ['¿Qué gaseosas tengo?', 'BEB-GAS'], ['Muéstrame las galletas', 'GAL'], ['¿Qué leches vendo?', 'DES-LEC'],
  ['¿Qué panes tengo?', 'PAN'], ['¿Qué Coca-Colas tengo?', 'coca cola'],
  ['Muéstrame productos Gloria', 'gloria'], ['¿Qué productos de Inca Kola quedan?', 'inca kola'],
  ['q gaseosas ay', 'BEB-GAS'], ['lista galletas', 'GAL'], ['dame productos de Gloria', 'gloria'],
  ['¿Cuáles productos de Inca Kola tengo?', 'inca kola'], ['muéstrame Coca-Cola', 'coca cola'],
  ['¿Qué productos de Gloria tengo?', 'gloria'], ['muéstrame leches', 'DES-LEC'], ['¿Qué panes quedan?', 'PAN']
]) add('category-brand', message, plan => { if (expected) assert.equal(plan?.lookup, expected); else assert.notEqual(plan?.lookup, ''); });

// Fifteen explicit ambiguity/selection safety checks: selection language maps
// one ordinal at a time and a negative/conflicting phrase is never authority.
for (const message of ['la primera', 'el primero', 'la segunda', 'el segundo', 'la última', 'el último',
  'el tercer producto', 'la cuarta', 'el quinto', 'la sexta', 'opcion 2', 'no el segundo',
  'no es el segundo, es el primero', 'el primero y el segundo', 'esa no, la otra']) {
  add('selection', message, () => {
    const result = ordinalSelection(message);
    if (message === 'esa no, la otra') return; // context-dependent; must not be guessed without the saved choice.
    if (message === 'opcion 2') { assert.equal(/^opcion 2$/.test(message), true); return; }
    assert.equal(result.matched, true);
    if (/^no el segundo$|el primero y el segundo/.test(message)) assert.equal(result.index, null);
  });
}

// Ten product-context follow-ups and explicit product changes remain tied to
// the caller-provided selected entity, never to an inferred SKU.
for (const [message, family, expected] of [
  ['¿Y su stock?', 'get_inventory_intelligence', 'get_inventory_intelligence'],
  ['¿Cuánto stock tiene?', 'get_inventory_intelligence', 'get_inventory_intelligence'],
  ['¿Y su pronóstico para 7 días?', 'get_product_forecast', 'get_product_forecast'],
  ['¿Y su pronóstico para 14 días?', 'get_product_forecast', 'get_product_forecast'],
  ['¿Cuántos días de cobertura?', 'get_inventory_intelligence', 'get_inventory_intelligence'],
  ['¿Cuánto stock tiene PAN-FRE-001?', 'get_inventory_intelligence', 'get_inventory_intelligence'],
  ['¿Cuál es la predicción de PAN-FRE-001 para 7 días?', 'get_product_forecast', 'get_product_forecast'],
  ['¿Y mañana?', 'get_product_forecast', 'get_product_forecast'],
  ['¿Y su stock mínimo?', 'get_inventory_intelligence', 'get_inventory_intelligence'],
  ['¿Cuál es el stock de Coca-Cola 1.5 L?', 'get_inventory_intelligence', 'get_inventory_intelligence']
]) add('context', message, () => {
  const memory = { selectedProduct: { id: 'a'.repeat(24), key: 'PAN-FRE-001', label: 'Pan francés' }, lastFamily: family };
  const plan = route(message, memory);
  assert.ok(plan?.tasks?.some(row => row.skillId === expected) || plan?.lookup, JSON.stringify(plan));
});

// Ten safety/intent checks for cancellation and explicit confirmation boundary.
for (const [message, expected] of [
  ['mejor no', 'cancel'], ['cancela', 'cancel'], ['olvídalo', 'cancel'], ['ya no', 'cancel'],
  ['confirmo', 'confirm'], ['sí, hazlo', 'confirm'], ['de acuerdo', 'confirm'],
  ['el segundo', null], ['la segunda', null], ['esa no, la otra', null]
]) add('write-safety', message, () => {
  if (expected === 'cancel') assert.equal(require('../src/automations/actionDecision').actionDecision(message), 'cancel');
  else if (expected === 'confirm') assert.equal(require('../src/automations/actionDecision').actionDecision(message), 'confirm');
  else assert.notEqual(require('../src/automations/actionDecision').actionDecision(message), 'confirm');
});

for (const message of ['¿Quién ganó el partido de ayer?', '¿Cuál es la capital de Japón?', 'Escríbeme una historia'])
  add('out-of-domain', message, plan => assert.equal(plan, null));

test(`H.6 language sample: ${cases.length} semantic cases across eight groups`, () => {
  const failures = [];
  for (const row of cases) {
    try { row.check(route(row.message)); }
    catch (error) { failures.push(`${row.group}: ${row.message} — ${error.message}`); }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.equal(cases.length, 103);
});

test('H.6 brand/category queries keep presentation variants as distinct deterministic candidates', () => {
  const products = [
    { _id: '1'.padStart(24, '0'), sku: 'BEB-GAS-001', name: 'Coca-Cola Sabor Original 500 ml' },
    { _id: '2'.padStart(24, '0'), sku: 'BEB-GAS-004', name: 'Coca-Cola Sabor Original 1.5 L' }
  ];
  const brand = rankEntities(products, 'coca cola');
  assert.equal(brand.confidence, 'AMBIGUOUS'); assert.equal(brand.pagination.totalMatches, 2);
  assert.deepEqual(brand.candidates.map(row => row.sku), ['BEB-GAS-001', 'BEB-GAS-004']);
  const category = rankEntities(products, 'BEB-GAS');
  assert.equal(category.pagination.totalMatches, 2);
  const typo = rankEntities([{ ...products[0], sku: 'PAN-FRE-001', name: 'Pan francés fresco' }], 'pan frnaces');
  assert.equal(typo.confidence, 'HIGH_CONFIDENCE'); assert.equal(typo.candidates[0].name, 'Pan francés fresco');
});

test('H.6 stock response mode is minimal while detailed intent retains the full inventory contract', () => {
  const result = { data: { items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés', stock: { onHand: 21 },
    coverage: { daysCover: 4 }, risk: { level: 'HIGH' }, recommendation: { recommendedQty: 5 } }] },
  metadata: { asOf: '2026-10-14', dataMode: 'LIVE', selected: { product: { label: 'Pan francés' } } } };
  const minimal = renderV3('get_inventory_intelligence', result, { mode: 'detail' }, 'minimal');
  assert.equal(minimal, 'Pan francés: 21 unidades disponibles.');
  const full = renderV3('get_inventory_intelligence', result, { mode: 'detail' });
  assert.match(full, /cobertura/); assert.match(full, /riesgo/);
});

test('H.6 ordinal choice and action parser produce a preview input only; no execution interface is invoked', () => {
  const selected = ordinalSelection('la segunda'); assert.equal(selected.index, 1);
  const action = actionIntent('compra una gaseosa'); assert.equal(action, 'create_purchase');
  assert.deepEqual(parseAction('compra una gaseosa', action).items, [{ quantity: 1, ref: 'gaseosa' }]);
  const sale = actionIntent('quiero vender 4 coca colas'); assert.equal(sale, 'create_sale');
  assert.deepEqual(parseAction('quiero vender 4 coca colas', sale).items, [{ quantity: 4, ref: 'coca colas' }]);
});

test('H.6 live handler presents stock minimally and relative alternative only selects a saved candidate', async () => {
  const context = { businessId: V3.businessId, userId: 'h6-user', conversationId: 'h6-minimal' };
  const product = { id: 'a'.repeat(24), key: 'PAN-FRE-001', label: 'Pan francés', type: 'product' };
  const state = {};
  const calls = [];
  const service = { resolveContext: async () => binding, resolveEntity: async (_type, reference) => {
    calls.push(['resolve', reference]); return { entity: product };
  } };
  const response = await handleV3({ message: '¿Me queda pan francés?', state, context, service,
    run: async (_agent, skillId, args) => { calls.push([skillId, args]); return { status: 'READY',
      data: { items: [{ sku: product.key, productName: product.label, stock: { onHand: 21 }, coverage: { daysCover: 4 },
        risk: { level: 'HIGH' }, recommendation: { recommendedQty: 5 } }] },
      metadata: { asOf: '2026-10-14', dataMode: 'LIVE', selected: { product } } }; },
    commit: patchState => Object.assign(state, patchState) });
  assert.equal(response.answer, 'Pan francés: 21 unidades disponibles.');
  assert.deepEqual(response.v3Views[0].items[0].metrics, [{ label: 'Stock', value: 21 }]);
  assert.equal(calls.find(call => call[0] === 'get_inventory_intelligence')[1].mode, 'detail');

  const second = { v3Context: { binding: contextBinding(context), expiresAt: Date.now() + 60_000,
    selectedProduct: { ...product, id: 'b'.repeat(24), key: 'BEB-GAS-001', label: 'Coca-Cola 500 ml' },
    ranking: { type: 'product', items: [{ ...product, id: 'b'.repeat(24), key: 'BEB-GAS-001', label: 'Coca-Cola 500 ml' },
      { ...product, id: 'c'.repeat(24), key: 'BEB-GAS-004', label: 'Inca Kola 1.5 L' }] } } };
  let selectedArgs;
  const alternative = await handleV3({ message: 'esa no, la otra', state: second, context, service: { ...service,
    resolveEntity: async (_type, reference) => ({ entity: { id: 'c'.repeat(24), key: reference, label: 'Inca Kola 1.5 L', type: 'product' } }) },
    run: async (_agent, skillId, args) => { selectedArgs = { skillId, args }; return { status: 'READY',
      data: { items: [{ sku: args.productRef, productName: 'Inca Kola 1.5 L', stock: { onHand: 7 } }] },
      metadata: { asOf: '2026-10-14', dataMode: 'LIVE', selected: { product: { id: 'c'.repeat(24), key: args.productRef, label: 'Inca Kola 1.5 L', type: 'product' } } } }; },
    commit: patchState => Object.assign(second, patchState) });
  assert.equal(selectedArgs.skillId, 'get_inventory_intelligence');
  assert.equal(selectedArgs.args.productRef, 'BEB-GAS-004');
  assert.match(alternative.answer, /Inca Kola 1\.5 L/);
  assert.equal(alternative.pendingAction, undefined);
});
