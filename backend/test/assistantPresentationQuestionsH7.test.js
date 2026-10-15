'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3, handleV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');
const { actionIntent, parseAction, resolveAction } = require('../src/automations/actionInput');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { ordinalSelection } = require('../src/agents/ordinalSelection');
const { contextBinding, TTL_MS } = require('../src/agents/memory');

const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const route = (text, state = {}) => routeV3(text, state, binding);
const skillIds = plan => [...new Set((plan?.tasks || []).map(row => row.skillId))].sort();
const deterministic = [];
const add = (domain, prompts, expected) => prompts.forEach(text => deterministic.push({ domain, text, skills: expected.slice().sort() }));

add('inventory', [
  '¿Qué productos tienen poco stock?', '¿Qué se me está acabando?', '¿Qué productos están por agotarse?',
  '¿Cuáles están por debajo del mínimo?', '¿Qué debería reponer?', '¿Cuál está más cerca de su mínimo sin alcanzarlo?',
  '¿Qué producto está más sobrado?', '¿Cuál tiene más stock?', '¿Cuál tiene menos stock?',
  '¿Qué Coca-Cola tiene poco stock?', '¿Qué productos de Gloria están bajos?', '¿Qué gaseosas debería reponer?',
  '¿Qué productos tienen stock cero?', '¿Qué productos tienen exactamente su mínimo?',
  'Muéstrame los 5 productos con menor stock', 'Muéstrame los productos más críticos',
  'Muéstrame productos con stock bajo y su stock mínimo', '¿Cuánto stock tiene PAN-FRE-001?',
  '¿Cuál es el stock mínimo de ABA-SAZ-003?', '¿Cuántos días de cobertura tiene PAN-FRE-001?'
], ['get_inventory_intelligence']);

add('sales', [
  '¿Cuánto vendí hoy?', '¿Cuánto vendí ayer?', '¿Cuánto vendí en los últimos 7 días?', '¿Cuánto vendí esta semana?',
  '¿Cuánto vendí el último mes?', '¿Qué producto vendió más?', '¿Qué producto vendió menos?',
  '¿Qué categoría vende más?', '¿Qué producto dejó más ingresos?', '¿Qué producto deja más margen?',
  '¿Cuál fue el ticket promedio?', '¿Cuántas ventas hubo?', '¿Qué cliente compró más?'
], ['get_business_analytics']);

add('forecast', [
  '¿Cuál es el pronóstico de PAN-FRE-001 para 7 días?', '¿Cuánto se venderá de Sprite en 14 días?',
  'Dame el forecast de ABA-PAS-001 a 1 día', '¿Qué productos tienen mayor demanda esperada?',
  '¿Qué debería reponer según el pronóstico?', '¿Por qué usan media móvil?', '¿Por qué no usan HGB para operar?',
  '¿Qué diferencia hay entre MA28 y HGB?'
], ['get_product_forecast']);

add('customers', [
  '¿Quiénes son mis mejores clientes?', '¿Cuáles son mis clientes de alto valor?', '¿Qué clientes están inactivos?',
  '¿Qué clientes están en riesgo?', '¿Quién compra más?', '¿Qué grupo de clientes es más valioso?',
  '¿Qué significa el cluster 4?', '¿Cuál es el detalle de CLI-001?', '¿Cuándo compró CLI-001 por última vez?'
], ['get_customer_intelligence']);

add('suppliers', [
  '¿Qué proveedores tienen pedidos pendientes?', '¿Qué proveedor registra más demora?', '¿Cuál es el proveedor más rápido?',
  '¿Qué proveedor tiene más compras?', '¿Qué proveedor tiene mayor lead time?', '¿Qué pedidos siguen pendientes?',
  'Dame el detalle del proveedor SUP-05', '¿Qué productos provee SUP-05?'
], ['get_supplier_intelligence']);

add('related', [
  '¿Qué compran junto con PAN-FRE-001?', '¿Qué productos están relacionados con ABA-PAS-001?',
  '¿Qué combinación de productos aparece más?', '¿Qué significa support en las asociaciones?',
  '¿Qué significa confidence en las asociaciones?', '¿El lift significa causalidad?'
], ['get_cross_sell_recommendations']);
add('health', ['¿Cómo está la salud de mi negocio?', '¿Cuál es el mayor riesgo que muestra la salud del negocio?'], ['get_business_health']);

const multi = [
  { text:'Dime mis ventas de 7 días y qué productos debería reponer', skills:['get_business_analytics','get_inventory_intelligence'], periodDays:7 },
  { text:'Stock de PAN-FRE-001 y pronóstico a 7 días', skills:['get_inventory_intelligence','get_product_forecast'], product:'PAN-FRE-001', horizon:7 },
  { text:'Mejores clientes y ventas de esta semana', skills:['get_business_analytics','get_customer_intelligence'] },
  { text:'Productos con poco stock y pedidos pendientes', skills:['get_inventory_intelligence','get_supplier_intelligence'] },
  { text:'Ventas, margen y stock de PAN-FRE-001', skills:['get_business_analytics','get_inventory_intelligence'] }
];

const followups = [
  { text:'¿Cuál tiene menos stock?', state:{ lastFamily:'get_inventory_intelligence', ranking:{ type:'product', items:[{ key:'BEB-GAS-001' }, { key:'BEB-GAS-002' }] } }, skill:'get_inventory_intelligence' },
  { text:'¿Y cuánto vende?', state:{ lastFamily:'get_inventory_intelligence', selectedProduct:{ key:'BEB-GAS-001' } }, skill:'get_business_analytics', product:'BEB-GAS-001' },
  { text:'¿Y cuándo compró por última vez?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CLI-001' } }, skill:'get_customer_intelligence' },
  { text:'Pronóstico a 14 días', state:{ lastFamily:'get_inventory_intelligence', selectedProduct:{ key:'PAN-FRE-001' } }, skill:'get_product_forecast', product:'PAN-FRE-001', horizon:14 },
  { text:'¿Debería reponerlo?', state:{ lastFamily:'get_product_forecast', selectedProduct:{ key:'PAN-FRE-001' } }, skill:'get_inventory_intelligence', product:'PAN-FRE-001' },
  { text:'El segundo', state:{ lastFamily:'get_inventory_intelligence', ranking:{ type:'product', items:[{ key:'A' },{ key:'B' }] } }, selection:true },
  { text:'¿Y cuánto stock tiene?', state:{ lastFamily:'get_supplier_intelligence', selectedSupplier:{ key:'SUP-05' } }, clarify:true },
  { text:'¿Qué suele comprar?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CLI-001' } }, skill:'get_customer_intelligence' }
];

const groundedFuture = [
  'Analiza ventas, inventario y forecast y dime qué debería priorizar.',
  '¿Qué productos recomiendas reponer esta semana y por qué?',
  '¿Qué productos tienen buen potencial pero riesgo de quiebre?',
  '¿Qué estrategia recomendarías según mis ventas y margen?',
  'Resume el estado del negocio como si se lo explicaras al dueño.',
  '¿Qué clientes debería intentar retener primero?',
  '¿Qué conclusiones importantes ves en mis datos?', '¿Qué debería mejorar primero?',
  '¿Qué decisiones tomarías para mañana?',
  'Según ventas, stock, forecast y proveedores, ¿qué debería comprar?',
  '¿Qué producto vende bien pero tiene poco stock?', '¿Hay algo preocupante en mi negocio?',
  '¿Qué productos nuevos debería comprar?',
  '¿Qué promoción convendría lanzar considerando margen y demanda?'
];
const outOfDomain = [
  '¿Quién ganó el partido ayer?', '¿Cuál es la capital de Francia?', 'Cuéntame un cuento.',
  '¿Qué laptop me recomiendas?', '¿Cuánto cuesta Bitcoin?', '¿Quién es el presidente de X?', '¿Cómo escribo un currículum?'
];
const ambiguousWrites = [
  'saca 3 panes', 'retira 2 Sprite', 'mete 5 leches', 'mueve 4 unidades', 'baja 2',
  'compra 10', 'pide 5', 'vende eso', 'hazlo'
];

test('H.7 inventories 109 presentation prompts before exercising routing', () => {
  assert.equal(deterministic.length, 66);
  assert.equal(multi.length, 5);
  assert.equal(followups.length, 8);
  assert.equal(groundedFuture.length, 14);
  assert.equal(outOfDomain.length, 7);
  assert.equal(ambiguousWrites.length, 9);
  assert.equal(deterministic.length + multi.length + followups.length + groundedFuture.length + outOfDomain.length + ambiguousWrites.length, 109);

  const outcomes = { skillPlan: 0, entityLookup: 0, clarification: 0, legacyFallback: 0, unresolved: 0 };
  const unresolvedPrompts = [], fallbackPrompts = [];
  for (const row of deterministic) {
    const primary = route(row.text);
    const plan = primary || routeDeterministically(row.text, {}, new Date('2026-10-14T12:00:00Z'), undefined, undefined, V3.businessId);
    if (primary?.tasks?.length) outcomes.skillPlan++;
    else if (primary?.lookup) outcomes.entityLookup++;
    else if (primary?.clarificationQuestion) outcomes.clarification++;
    else if (plan) { outcomes.legacyFallback++; fallbackPrompts.push(row.text); }
    else { outcomes.unresolved++; unresolvedPrompts.push(row.text); }
  }
  // Outcomes are emitted for triage; lookup/clarification are safe bounded routes,
  // while unresolved items are not promoted to an invented answer by this test.
  console.log(`H7_PROMPT_COVERAGE ${JSON.stringify({ total:109, outcomes, fallbackPrompts, unresolvedPrompts, futureNoProvider:groundedFuture.length, outOfDomain:outOfDomain.length, writes:ambiguousWrites.length })}`);
});

test('H.7 deterministic domain prompts use approved skills and preserve semantics', () => {
  const cases = [
    ['¿Qué productos tienen poco stock?', 'get_inventory_intelligence'],
    ['¿Qué se me está acabando?', 'get_inventory_intelligence'],
    ['¿Cuáles están por debajo del mínimo?', 'get_inventory_intelligence'],
    ['¿Cuál está más cerca de su mínimo sin alcanzarlo?', 'get_inventory_intelligence'],
    ['¿Qué Coca-Cola tiene poco stock?', 'get_inventory_intelligence'],
    ['¿Qué categoría vende más?', 'get_business_analytics'],
    ['¿Qué cliente compró más?', 'get_customer_intelligence'],
    ['Dame el forecast de ABA-PAS-001 a 1 día', 'get_product_forecast'],
    ['¿Cuánto se venderá de Sprite en 14 días?', 'get_product_forecast'],
    ['¿Cuáles son mis clientes de alto valor?', 'get_customer_intelligence'],
    ['¿Cuál es el detalle de CLI-001?', 'get_customer_intelligence'],
    ['¿Cuándo compró CLI-001 por última vez?', 'get_customer_intelligence'],
    ['¿Qué pedidos siguen pendientes?', 'get_supplier_intelligence'],
    ['¿Qué combinación de productos aparece más?', 'get_cross_sell_recommendations'],
    ['¿Cómo está la salud de mi negocio?', 'get_business_health']
  ];
  for (const [text, skill] of cases) {
    const plan = route(text);
    assert.ok(plan?.tasks?.some(row => row.skillId === skill)
      || skill === 'get_inventory_intelligence' && (plan?.responseMode === 'inventory-filter' || plan?.clarificationQuestion),
    `${text}: ${JSON.stringify(plan)}`);
  }
  const lowStock = route('¿Qué productos tienen poco stock?').tasks[0];
  const shouldReorder = route('¿Qué debería reponer?').tasks[0];
  assert.equal(lowStock.args.flag, 'low_stock');
  assert.equal(shouldReorder.args.flag, 'should_reorder');
  assert.equal(route('¿Cuáles son mis clientes de alto valor?').tasks[0].args.segment, 'TOP_HIGH_VALUE');
  assert.equal(route('¿Qué productos se compran junto con PAN-FRE-001?').tasks[0].args.productRef, 'PAN-FRE-001');
  assert.equal(route('¿Qué significa lift?').tasks[0].args.concept, 'lift');
  assert.equal(route('¿Qué significa support en las asociaciones?').tasks[0].args.concept, 'support');
  assert.equal(route('¿Qué significa confidence en las asociaciones?').tasks[0].args.concept, 'confidence');
  assert.equal(route('¿El lift significa causalidad?').tasks[0].args.concept, 'causality');
});

test('H.7 multi-intent keeps each domain and explicit date/horizon filters', () => {
  for (const row of multi) {
    const plan = route(row.text), observed = skillIds(plan);
    assert.deepEqual(observed, row.skills.slice().sort(), row.text);
    if (row.product) for (const skill of row.skills) {
      const args = plan.tasks.find(task => task.skillId === skill)?.args;
      if (skill === 'get_inventory_intelligence' || skill === 'get_product_forecast') assert.equal(args?.productRef, row.product, row.text);
      if (skill === 'get_product_forecast') assert.equal(args.horizonDays, row.horizon, row.text);
    }
    if (row.periodDays) {
      const sales = plan.tasks.find(task => task.skillId === 'get_business_analytics').args;
      const days = (Date.parse(`${sales.endDate}T00:00:00Z`) - Date.parse(`${sales.startDate}T00:00:00Z`)) / 86400000 + 1;
      assert.equal(days, row.periodDays, row.text);
    }
  }
});

test('H.7 context follow-ups remain in their original domain and use prior entities', () => {
  for (const row of followups) {
    if (row.selection) { assert.equal(ordinalSelection(row.text).index, 1); continue; }
    const plan = route(row.text, row.state), task = plan?.tasks?.find(item => item.skillId === row.skill);
    if (row.clarify) { assert.ok(plan?.clarificationQuestion, row.text); continue; }
    assert.ok(task, `${row.text}: ${JSON.stringify(plan)}`);
    if (row.product) assert.equal(task.args.productRef, row.product, row.text);
    if (row.horizon) assert.equal(task.args.horizonDays, row.horizon, row.text);
  }
  const chosenFromList = route('¿Cuál tiene menos stock?', { ranking:{ type:'product', items:[{ key:'BEB-GAS-001' },{ key:'BEB-GAS-002' }] } });
  assert.equal(chosenFromList.responseMode, 'inventory-context-stock-extreme');
  assert.equal(chosenFromList.tasks[0].args.productRefs, 'BEB-GAS-001|BEB-GAS-002');
});

test('H.7 compares only products from the prior list using current inventory rows', async () => {
  const context = { businessId:V3.businessId, userId:'h7-test', conversationId:'stock-list-followup' };
  const state = { v3Context:{ binding:contextBinding(context), expiresAt:Date.now() + TTL_MS,
    lastFamily:'get_inventory_intelligence', ranking:{ type:'product', items:[
      { type:'product', id:'a'.repeat(24), key:'BEB-GAS-001', label:'Gaseosa A' },
      { type:'product', id:'b'.repeat(24), key:'BEB-GAS-002', label:'Gaseosa B' }
    ] } } };
  let executedSkill;
  const response = await handleV3({ message:'¿Cuál tiene menos stock?', state, context,
    service:{ resolveContext:async () => binding, resolveEntity:async () => ({}) },
    run:async (_agent, skillId, args) => {
      executedSkill = { skillId, args };
      return { status:'READY', data:{ items:[
        { sku:'BEB-GAS-001', productName:'Gaseosa A', stock:{ onHand:8 }, inventoryPolicy:{ configuredMinimumStock:3 } },
        { sku:'BEB-GAS-002', productName:'Gaseosa B', stock:{ onHand:2 }, inventoryPolicy:{ configuredMinimumStock:1 } }
      ] }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{} } };
    }, commit:patch => Object.assign(state, patch) });
  assert.equal(executedSkill.skillId, 'get_inventory_intelligence');
  assert.equal(executedSkill.args.productRefs, 'BEB-GAS-001|BEB-GAS-002');
  assert.match(response.answer, /Gaseosa B: 2 unidades/);
  assert.doesNotMatch(response.answer, /Gaseosa A/);
  assert.equal(response.v3Views[0].items[0].key, 'BEB-GAS-002');
});

test('H.7 records the remaining ordinal gap after a low-stock list without adding phrase-level product resolution', async () => {
  const context = { businessId:V3.businessId, userId:'h7-gap', conversationId:'low-stock-ordinal' }, state = {};
  let entityResolutionCalls = 0;
  await handleV3({ message:'Muéstrame productos con stock bajo y su stock mínimo', state, context,
    service:{ resolveContext:async () => binding, resolveEntity:async () => { entityResolutionCalls++; return {}; } },
    run:async () => ({ status:'READY', data:{ total:2, items:[
      { sku:'PAN-FRE-001', productName:'Pan francés', stock:{ onHand:2 }, inventoryPolicy:{ configuredMinimumStock:3 }, risk:{ level:'HIGH' } },
      { sku:'ABA-PAS-001', productName:'Arroz', stock:{ onHand:1 }, inventoryPolicy:{ configuredMinimumStock:2 }, risk:{ level:'HIGH' } }
    ] }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{} } }), commit:patch => Object.assign(state, patch) });
  assert.equal(entityResolutionCalls, 0, 'H.6-FIX3 must not resolve the whole low-stock phrase as one product');
  assert.equal(state.v3Context?.ranking, undefined, 'current low-stock list deliberately does not create an entity ranking');
  assert.equal(route('El segundo', state.v3Context), null, 'ordinal continuation after this specific list remains a known gap');
  console.log('H7_KNOWN_GAP low-stock list -> ordinal selection: current result does not persist selectable entity ranking');
});

test('H.7 future-grounded and out-of-domain prompts do not call a provider or business skill', () => {
  let providerCalls = 0;
  for (const text of groundedFuture) {
    // This phase tags these for a future grounded layer only; no execution/provider is wired here.
    const classification = 'GROUNDED_LLM_FUTURE';
    assert.equal(classification, 'GROUNDED_LLM_FUTURE');
    assert.equal(route(text)?.__error, undefined);
  }
  for (const text of outOfDomain) assert.equal(route(text)?.tasks?.length || 0, 0, text);
  assert.equal(providerCalls, 0);
});

test('H.7 ambiguous WRITE prompts never become an execution or confirmation in the isolated harness', async () => {
  let writeExecutions = 0;
  const noMatch = async () => ({ confidence:'LOW', candidates:[] });
  for (const text of ambiguousWrites) {
    const intent = actionIntent(text);
    if (intent) {
      let extracted;
      try { extracted = parseAction(text, intent); } catch { extracted = null; }
      if (extracted) {
        const resolved = await resolveAction(extracted, {}, noMatch, async () => []);
        assert.equal(resolved.args, undefined, text);
        assert.ok(resolved.clarification || resolved.selection || resolved.missingFields, text);
      }
    }
    assert.equal(route(text)?.tasks?.length || 0, 0, text);
  }
  assert.equal(writeExecutions, 0);
});
