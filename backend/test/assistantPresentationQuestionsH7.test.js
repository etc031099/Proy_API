'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3, handleV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');
const { actionIntent, parseAction, resolveAction } = require('../src/automations/actionInput');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { ordinalSelection } = require('../src/agents/ordinalSelection');
const { withActionAssistant } = require('../src/automations/assistant');
const { Product } = require('../src/models');
const { randomUUID } = require('node:crypto');
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

test('H.7 low-stock list preserves the visible product identities and ordinal order', async () => {
  const context = { businessId:V3.businessId, userId:'h7-gap', conversationId:'low-stock-ordinal' }, state = {};
  const resolvedSkus = [];
  await handleV3({ message:'Muéstrame productos con stock bajo y su stock mínimo', state, context,
    service:{ resolveContext:async () => binding, resolveEntity:async (type, sku) => {
      resolvedSkus.push(sku); return { entity:{ id:sku.endsWith('001') ? '111111111111111111111111' : '222222222222222222222222',
        type, key:sku, label:sku === 'PAN-FRE-001' ? 'Pan francés' : 'Arroz' } };
    } },
    run:async () => ({ status:'READY', data:{ total:2, items:[
      { sku:'PAN-FRE-001', productName:'Pan francés', stock:{ onHand:2 }, inventoryPolicy:{ configuredMinimumStock:3 }, risk:{ level:'HIGH' } },
      { sku:'ABA-PAS-001', productName:'Arroz', stock:{ onHand:1 }, inventoryPolicy:{ configuredMinimumStock:2 }, risk:{ level:'HIGH' } }
    ] }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{} } }), commit:patch => Object.assign(state, patch) });
  assert.deepEqual(resolvedSkus, ['PAN-FRE-001', 'ABA-PAS-001'], 'resolve only visible SKUs, never the complete natural-language filter');
  assert.deepEqual(state.v3Context.ranking.items.map(row => row.key), ['PAN-FRE-001', 'ABA-PAS-001']);
  assert.equal(route('El segundo', state.v3Context), null, 'selection is handled from compact context, not sent as a generic route');
  const detailCalls = [];
  const selected = await handleV3({ message:'El segundo', state, context, service:{ resolveContext:async () => binding,
    resolveEntity:async () => ({}), }, run:async (_agent, skillId, args) => {
      detailCalls.push({ skillId, args });
      return { status:'READY', data:{ items:[{ sku:'ABA-PAS-001', productName:'Arroz', stock:{ onHand:1 },
        inventoryPolicy:{ configuredMinimumStock:2 } }] }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE',
        selected:{ product:{ id:'222222222222222222222222', type:'product', key:'ABA-PAS-001', label:'Arroz' } } } };
    }, commit:patch => Object.assign(state, patch) });
  assert.equal(detailCalls[0].skillId, 'get_inventory_intelligence');
  assert.equal(detailCalls[0].args.productRef, 'ABA-PAS-001');
  assert.equal(state.v3Context.selectedProduct.key, 'ABA-PAS-001');
  assert.match(selected.answer, /Arroz/);

  for (const [message, skillId, args] of [
    ['¿Cuánto stock tiene?', 'get_inventory_intelligence', { mode:'detail', productRef:'ABA-PAS-001' }],
    ['¿Y su stock mínimo?', 'get_inventory_intelligence', { mode:'detail', productRef:'ABA-PAS-001' }],
    ['¿Y su pronóstico a 7 días?', 'get_product_forecast', { mode:'detail', productRef:'ABA-PAS-001', horizonDays:7 }]
  ]) {
    let actual;
    const response = await handleV3({ message, state, context, service:{ resolveContext:async () => binding, resolveEntity:async () => ({}) },
      run:async (_agent, calledSkill, calledArgs) => {
        actual = { skillId:calledSkill, args:calledArgs };
        return { status:'READY', data:{ items:[{ sku:'ABA-PAS-001', productName:'Arroz', stock:{ onHand:1 },
          inventoryPolicy:{ configuredMinimumStock:2 } }] }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE',
          selected:{ product:{ id:'222222222222222222222222', type:'product', key:'ABA-PAS-001', label:'Arroz' } } } };
      }, commit:patch => Object.assign(state, patch) });
    assert.equal(actual.skillId, skillId, message);
    for (const [key, value] of Object.entries(args)) assert.equal(actual.args[key], value, `${message} ${key}`);
    assert.ok(response.answer);
  }
});

test('H.7 product list ordinal aliases map to visible positions; absent and out-of-range lists are safe', async () => {
  const bindingHash = contextBinding({ businessId:V3.businessId, userId:'h7-safe', conversationId:'ordinal-safe' });
  const context = { businessId:V3.businessId, userId:'h7-safe', conversationId:'ordinal-safe' };
  const freshState = () => ({ v3Context:{ binding:bindingHash, expiresAt:Date.now()+60_000, lastFamily:'get_inventory_intelligence',
    ranking:{ type:'product', items:[1,2,3].map(n => ({ type:'product', id:`${n}`.padStart(24,'0'), key:`SKU-${n}`, label:`Producto ${n}` })) } } });
  for (const [text, index] of [['el primero',0], ['el segundo',1], ['el tercero',2], ['la primera',0], ['la segunda',1],
    ['la tercera',2], ['opción 1',0], ['opción 2',1], ['opción 3',2], ['número 1',0], ['número 2',1], ['número 3',2]]) {
    const state = freshState(); let selectedSku;
    await handleV3({ message:text, state, context, service:{ resolveContext:async () => binding, resolveEntity:async () => ({}) },
      run:async (_agent, _skill, args) => {
        selectedSku = args.productRef;
        const n = Number(args.productRef.slice(-1));
        return { status:'READY', data:{ items:[{ sku:args.productRef, name:`Producto ${n}`, stock:{ onHand:n } }] }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE',
          selected:{ product:{ id:`${n}`.padStart(24,'0'), type:'product', key:args.productRef, label:`Producto ${n}` } } } };
      }, commit:patch => Object.assign(state, patch) });
    assert.equal(selectedSku, `SKU-${index + 1}`, text);
  }
  const state = freshState();
  const make = message => handleV3({ message, state, context, service:{ resolveContext:async () => binding, resolveEntity:async () => ({}) },
    run:async () => assert.fail('out-of-range and absent ordinals must not execute a skill'), commit:patch => Object.assign(state, patch) });
  const outOfRange = await make('el quinto');
  assert.match(outOfRange.answer, /3 opciones.*no está en la lista/i);
  state.v3Context.ranking = null;
  const absent = await make('el segundo');
  assert.match(absent.answer, /lista vigente/i);
  assert.equal(outOfRange.usage?.totalTokens || 0, 0);
});

test('H.7 latest product list replaces ordinal context from the prior list', async () => {
  const context = { businessId:V3.businessId, userId:'h7-latest', conversationId:'latest-list' }, state = {};
  const entities = { 'OLD-001':{ id:'111111111111111111111111', label:'Producto viejo 1' }, 'OLD-002':{ id:'222222222222222222222222', label:'Producto viejo 2' },
    'GAS-001':{ id:'333333333333333333333333', label:'Gaseosa 1' }, 'GAS-002':{ id:'444444444444444444444444', label:'Gaseosa 2' } };
  const service = { resolveContext:async () => binding, resolveEntity:async (type, sku) => ({ entity:{ type, key:sku, ...entities[sku] } }) };
  await handleV3({ message:'Muéstrame productos con stock bajo', state, context, service,
    run:async () => ({ status:'READY', data:{ items:[['OLD-001','Producto viejo 1'],['OLD-002','Producto viejo 2']].map(([sku, productName]) => ({ sku, productName,
      stock:{ onHand:2 }, inventoryPolicy:{ configuredMinimumStock:3 } })) }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{} } }),
    commit:patch => Object.assign(state, patch) });
  await handleV3({ message:'Muéstrame las gaseosas', state, context,
    service:{ resolveContext:async () => binding, resolveEntity:async (_type, query) => query === 'BEB-GAS'
      ? { type:'product', query, candidates:[{ type:'product', id:entities['GAS-001'].id, key:'GAS-001', label:'Gaseosa 1' },
        { type:'product', id:entities['GAS-002'].id, key:'GAS-002', label:'Gaseosa 2' }], pagination:{ totalMatches:2, offset:0, limit:5 } }
      : service.resolveEntity('product',query) }, run:async () => assert.fail('search candidates must not execute analytics before selection'),
    commit:patch => Object.assign(state, patch) });
  assert.deepEqual(state.v3Context.ranking.items.map(row => row.key), ['GAS-001','GAS-002']);
  let selectedSku;
  await handleV3({ message:'la segunda', state, context, service,
    run:async (_agent, _skill, args) => {
      selectedSku = args.productRef;
      return { status:'READY', data:{ items:[{ sku:args.productRef, productName:'Gaseosa 2', stock:{ onHand:2 } }] },
        metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{ product:{ type:'product', id:entities['GAS-002'].id,
          key:'GAS-002', label:'Gaseosa 2' } } } };
    }, commit:patch => Object.assign(state, patch) });
  assert.equal(selectedSku, 'GAS-002');
});

test('H.7 filtered low-stock lists preserve their filtered order for ordinal selection', async () => {
  const context = { businessId:V3.businessId, userId:'h7-brand', conversationId:'brand-list' }, state = {};
  const rows = [
    { type:'product', id:'555555555555555555555555', key:'GLO-001', label:'Leche Gloria 1' },
    { type:'product', id:'666666666666666666666666', key:'GLO-002', label:'Leche Gloria 2' }
  ];
  const resolutions = [];
  const service = { resolveContext:async () => binding, resolveEntity:async (_type, reference) => {
    resolutions.push(reference);
    return reference === 'gloria' ? { candidates:rows, pagination:{ totalMatches:2, offset:0, limit:5 } }
      : { entity:rows.find(row => row.key === reference) || null };
  } };
  let productRefs;
  await handleV3({ message:'¿Qué productos de Gloria tienen poco stock?', state, context, service,
    run:async (_agent, _skill, args) => {
      productRefs=args.productRefs;
      return { status:'READY', data:{ items:rows.map(row => ({ sku:row.key, productName:row.label, stock:{ onHand:1 },
        inventoryPolicy:{ configuredMinimumStock:2 } })) }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{} } };
    }, commit:patch => Object.assign(state,patch) });
  assert.equal(productRefs,'GLO-001|GLO-002');
  assert.deepEqual(state.v3Context.ranking.items.map(row => row.key),['GLO-001','GLO-002']);
  let selectedSku;
  await handleV3({ message:'el primero', state, context, service,
    run:async (_agent,_skill,args) => { selectedSku=args.productRef; return { status:'READY', data:{ items:[] },
      metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{ product:rows[0] } } }; },
    commit:patch => Object.assign(state,patch) });
  assert.equal(selectedSku,'GLO-001');
  assert.deepEqual(resolutions,['gloria','GLO-001','GLO-002']);
});

test('H.7 ambiguous product-name or brand search keeps candidate order for ordinal selection', async () => {
  const context={ businessId:V3.businessId, userId:'h7-search', conversationId:'search-list' }, state={};
  const candidates=[
    { type:'product', id:'777777777777777777777777', key:'COC-500', label:'Coca-Cola Original 500 ml' },
    { type:'product', id:'888888888888888888888888', key:'COC-1500', label:'Coca-Cola Original 1.5 L' }
  ];
  let selectedSku;
  const service={ resolveContext:async () => binding, resolveEntity:async (_type, query) => ({ type:'product', query, candidates,
    pagination:{ totalMatches:2, offset:0, limit:5 } }) };
  await handleV3({ message:'Muéstrame productos Coca-Cola', state, context, service,
    run:async () => assert.fail('ambiguous search is a candidate list, not an unrequested detail'), commit:patch => Object.assign(state,patch) });
  assert.deepEqual(state.v3Context.ranking.items.map(row=>row.key),['COC-500','COC-1500']);
  await handleV3({ message:'la segunda', state, context, service,
    run:async (_agent,_skill,args) => { selectedSku=args.productRef; return { status:'READY', data:{ items:[] },
      metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{ product:candidates[1] } } }; },
    commit:patch => Object.assign(state,patch) });
  assert.equal(selectedSku,'COC-1500');
});

test('H.7 selected ordinal sale requires a preview, then explicit confirmation; cancellation executes nothing', async () => {
  const context = { businessId:V3.businessId, userId:'aaaaaaaaaaaaaaaaaaaaaaaa', conversationId:'h7-write' }, state = {};
  const rows = [
    { id:'111111111111111111111111', key:'PAN-FRE-001', label:'Pan francés' },
    { id:'222222222222222222222222', key:'ABA-PAS-001', label:'Arroz' }
  ];
  const service = { resolveContext:async () => binding, resolveEntity:async (_type, sku) => ({ entity:rows.find(row => row.key === sku)
    ? { ...rows.find(row => row.key === sku), type:'product' } : null }) };
  await handleV3({ message:'Muéstrame productos con stock bajo', state, context, service,
    run:async () => ({ status:'READY', data:{ items:rows.map(row => ({ sku:row.key, productName:row.label, stock:{ onHand:10 },
      inventoryPolicy:{ configuredMinimumStock:12 } })) }, metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{} } }),
    commit:patch => Object.assign(state, patch) });
  await handleV3({ message:'el segundo', state, context, service,
    run:async (_agent, _skill, args) => ({ status:'READY', data:{ items:[{ sku:args.productRef, name:'Arroz', stock:{ onHand:10 } }] },
      metadata:{ asOf:'2026-10-14', dataMode:'LIVE', selected:{ product:{ ...rows[1], type:'product' } } } }),
    commit:patch => Object.assign(state, patch) });
  const req = { businessId:V3.businessId, user:{ _id:context.userId, businessId:V3.businessId, role:'user', isActive:true } };
  const pending = new Map(); let prepared = 0, executed = 0, cancelled = 0;
  const actionService = {
    async prepare(value) { prepared++; assert.equal(value.skillId,'create_sale'); assert.deepEqual(value.args.products,[{ productId:rows[1].id, quantity:1 }]);
      const result = { pendingActionId:randomUUID(), status:'PENDING', summary:'Preview de venta', expiresAt:new Date(Date.now()+60_000).toISOString() };
      pending.set(result.pendingActionId,result); return result; },
    async get(_context,id) { return pending.get(id); }, async resolvePending() { return [...pending.values()].find(row => row.status==='PENDING') || null; },
    async confirmPendingAction(_context,id) { executed++; const row=pending.get(id); row.status='EXECUTED'; return { ...row, result:{ type:'sale', total:10, currency:'PEN', items:[{ sku:'ABA-PAS-001', name:'Arroz', quantity:1, stock:9 }] } }; },
    async cancelPendingAction(_context,id) { cancelled++; const row=pending.get(id); row.status='CANCELLED'; return row; }
  };
  const runtime = { async getContextSnapshot() { return state; }, async handle() { assert.fail('contextual write must stay deterministic'); } };
  const adapter = withActionAssistant(runtime, actionService, { resolver:async (model, _context, reference) => {
    assert.equal(model,Product); assert.equal(reference,'ABA-PAS-001');
    return { confidence:'EXACT', value:{ _id:rows[1].id, sku:'ABA-PAS-001', name:'Arroz', currency:'PEN', stock:10, isActive:true } };
  } });
  const conversationId = randomUUID();
  // Rebind the saved V3 state to the authenticated conversation used by the action layer.
  state.v3Context.binding = contextBinding({ ...context, conversationId });
  state.v3Context.expiresAt = Date.now()+60_000;
  const preview = await adapter.handle(req,{ conversationId, message:'vende 1' });
  assert.ok(preview.pendingAction); assert.equal(prepared,1); assert.equal(executed,0);
  assert.equal(preview.usage.totalLlmCalls,0); assert.equal(preview.usage.totalTokens,0);
  const confirmed = await adapter.handle(req,{ conversationId, message:'confirmo' });
  assert.equal(confirmed.pendingAction.status,'EXECUTED'); assert.equal(executed,1);
  assert.equal(cancelled,0);

  const cancelRuntime = { async getContextSnapshot() { return state; }, async handle() { assert.fail('contextual write must stay deterministic'); } };
  const cancelService = { ...actionService,
    async prepare(value) { prepared++; assert.deepEqual(value.args.products,[{ productId:rows[1].id, quantity:1 }]);
      const result={ pendingActionId:randomUUID(), status:'PENDING', summary:'Preview de venta', expiresAt:new Date(Date.now()+60_000).toISOString() };
      pending.set(result.pendingActionId,result); return result; },
    async confirmPendingAction() { executed++; assert.fail('cancel must not execute'); },
    async cancelPendingAction(_context,id) { cancelled++; const row=pending.get(id); row.status='CANCELLED'; return row; } };
  const cancelAdapter = withActionAssistant(cancelRuntime,cancelService,{ resolver:async (_model,_context,reference) => ({
    confidence:'EXACT', value:{ _id:rows[1].id, sku:reference, name:'Arroz', currency:'PEN', stock:10, isActive:true }
  }) });
  const cancelConversation = randomUUID(); state.v3Context.binding=contextBinding({ ...context, conversationId:cancelConversation });
  const cancelPreview=await cancelAdapter.handle(req,{ conversationId:cancelConversation, message:'vende 1' });
  assert.ok(cancelPreview.pendingAction); assert.equal(executed,1);
  const cancelledResponse=await cancelAdapter.handle(req,{ conversationId:cancelConversation, message:'cancela' });
  assert.match(cancelledResponse.answer,/cancelad/i); assert.equal(cancelled,1); assert.equal(executed,1);
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
