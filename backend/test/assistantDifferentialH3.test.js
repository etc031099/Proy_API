'use strict';

// A deliberately bounded H.3 battery: selected V2 cases, new V3/ML routing,
// critical WRITE handoffs, contextual sequences and fail-closed requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { routeV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { actionIntent, parseAction } = require('../src/automations/actionInput');
const { actionDecision } = require('../src/automations/actionDecision');

const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'CONV-AUDIT-P3B.json'), 'utf8'));
const legacyIds = [
  'U-0001','U-0002','U-0004','U-0009','U-0010','U-0013','U-0014','U-0015',
  'U-0127','U-0128','U-0132','U-0134','U-0136','U-0142',
  'U-0155','U-0156','U-0157','U-0162','U-0165','U-0166','U-0170','U-0172',
  'U-0197','U-0198','U-0204','U-0205','U-0206',
  'U-0239','U-0240','U-0241','U-0248',
  'U-0309','U-0310','U-0313','U-0315',
  'U-0351','U-0352','U-0353','U-0356','U-0358',
  'U-0407','U-0408','U-0412','U-0421','U-0422',
  // Previously failing P1 oracles, retained as regression targets after fixes.
  'U-0034','U-0158','U-0194','U-0242','U-0439',
  // WRITE quantity parser cases: preview inputs only; no action service is invoked.
  'U-0519','U-0520','U-0521','U-0522','U-0533','U-0534','U-0535','U-0536','U-0537','U-0540',
];
const legacyById = new Map(baseline.cases.map(row => [row.id, row]));
const legacyCases = legacyIds.map(id => {
  const row = legacyById.get(id);
  assert.ok(row, `Missing V2 baseline ${id}`);
  return row;
});
const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const route = (input, state = {}) => {
  try { return routeV3(input, state, binding); }
  catch (error) { return { __error: error?.name || 'Error' }; }
};
const skillIds = plan => [...new Set((plan?.tasks || []).map(row => row.skillId))].sort();
const readCase = (id, text, skills, category = 'ROUTING') => ({ id, text, skills: [...skills].sort(), category });

const academic = [
  readCase('AC-01','¿Qué método usa para predecir demanda?',['get_product_forecast'],'ML_SEMANTICS'),
  readCase('AC-02','¿Por qué opera MA28 después de entrenar HGB?',['get_product_forecast'],'ML_SEMANTICS'),
  readCase('AC-03','¿Cuál WAPE obtuvo el forecast?',['get_product_forecast'],'ML_SEMANTICS'),
  readCase('AC-04','¿Qué baseline se comparó?',['get_product_forecast'],'ML_SEMANTICS'),
  readCase('AC-05','¿Cuántos días permite el pronóstico?',['get_product_forecast'],'ML_SEMANTICS'),
  readCase('AC-06','¿Qué horizonte de forecast está aprobado?',['get_product_forecast'],'ML_SEMANTICS'),
  readCase('AC-07','¿Qué significa RFM para segmentar clientes?',['get_customer_intelligence'],'ML_SEMANTICS'),
  readCase('AC-08','¿Qué significa silhouette?',['get_customer_intelligence'],'ML_SEMANTICS'),
  readCase('AC-09','¿Qué significa ARI en el clustering?',['get_customer_intelligence'],'ML_SEMANTICS'),
  readCase('AC-10','¿Cómo se eligió K-Means?',['get_customer_intelligence'],'ML_SEMANTICS'),
  readCase('AC-11','¿Cuántos clientes hay en cada cluster?',['get_customer_intelligence'],'ML_SEMANTICS'),
  readCase('AC-12','¿Qué muestra K-Means para un cliente sin historial?',['get_customer_intelligence'],'ML_SEMANTICS'),
  readCase('AC-13','¿Qué significa una anomalía de ventas?',['get_business_analytics'],'ML_SEMANTICS'),
  readCase('AC-14','¿El Isolation Forest detecta fraude?',['get_business_analytics'],'ML_SEMANTICS'),
  readCase('AC-15','¿Qué es contamination?',['get_business_analytics'],'ML_SEMANTICS'),
  readCase('AC-16','¿Qué significa el anomaly score?',['get_business_analytics'],'ML_SEMANTICS'),
  readCase('AC-17','¿Qué significa Jaccard para anomalías?',['get_business_analytics'],'ML_SEMANTICS'),
  readCase('AC-18','¿Qué días fueron atípicos en las ventas?',['get_business_analytics'],'ML_SEMANTICS'),
  readCase('AC-19','¿Qué es support en una regla FP-Growth?',['get_cross_sell_recommendations'],'ML_SEMANTICS'),
  readCase('AC-20','¿Qué significa confidence en asociaciones?',['get_cross_sell_recommendations'],'ML_SEMANTICS'),
  readCase('AC-21','¿El lift prueba causalidad?',['get_cross_sell_recommendations'],'ML_SEMANTICS'),
  readCase('AC-22','¿Qué productos suelen comprarse juntos?',['get_cross_sell_recommendations'],'ML_SEMANTICS'),
  readCase('AC-23','¿Hasta cuándo llega el artifact de asociaciones?',['get_cross_sell_recommendations'],'ML_SEMANTICS'),
  readCase('AC-24','¿Qué algoritmo genera las asociaciones?',['get_cross_sell_recommendations'],'ML_SEMANTICS'),
  readCase('AC-25','¿Salud del negocio tiene un score global?',['get_business_health'],'ML_SEMANTICS'),
  readCase('AC-26','¿Cómo va la salud general del negocio?',['get_business_health'],'ML_SEMANTICS'),
  readCase('AC-27','¿El inventario usa Machine Learning?',['get_inventory_intelligence'],'ML_SEMANTICS'),
  readCase('AC-28','¿ABC y XYZ son modelos de Machine Learning?',['get_inventory_intelligence'],'ML_SEMANTICS'),
  readCase('AC-29','¿Qué significa safety stock para el modelo?',['get_inventory_intelligence'],'ML_SEMANTICS'),
  readCase('AC-30','¿Los proveedores se modelan con K-Means?',['get_supplier_intelligence'],'ML_SEMANTICS'),
];

const v3Domains = [
  readCase('V3-01','¿Cuánto sumaron mis ventas en los últimos 7 días?',['get_business_analytics'],'DATA_SEMANTICS'),
  readCase('V3-02','Compara el ingreso de los últimos 30 días con los 30 anteriores.',['get_business_analytics'],'DATA_SEMANTICS'),
  readCase('V3-03','¿Cuál fue mi margen bruto esta semana?',['get_business_analytics'],'DATA_SEMANTICS'),
  readCase('V3-04','Enumera mis productos con más ingresos del mes.',['get_business_analytics'],'ROUTING'),
  readCase('V3-05','¿Qué inventario tiene riesgo CRITICAL?',['get_inventory_intelligence'],'ROUTING'),
  readCase('V3-06','¿Qué productos tienen riesgo crítico?',['get_inventory_intelligence'],'ROUTING'),
  readCase('V3-07','¿Qué productos requieren reposición?',['get_inventory_intelligence'],'ROUTING'),
  readCase('V3-08','Clasifica el inventario por ABC y XYZ.',['get_inventory_intelligence'],'ROUTING'),
  readCase('V3-09','Muestra el pronóstico de PAN-FRE-001 para los próximos 14 días.',['get_product_forecast'],'ROUTING'),
  readCase('V3-10','¿Cuál es la predicción de mañana para PAN-FRE-001?',['get_product_forecast'],'ERROR_HANDLING'),
  readCase('V3-11','¿Qué clientes tienen mayor recencia?',['get_customer_intelligence'],'ROUTING'),
  readCase('V3-12','Lista los clientes en riesgo de inactividad.',['get_customer_intelligence'],'ROUTING'),
  readCase('V3-13','¿Qué clientes tienen mayor gasto?',['get_customer_intelligence'],'DATA_SEMANTICS'),
  readCase('V3-14','Busca CUS-001',['get_customer_intelligence'],'ENTITY_RESOLUTION'),
  readCase('V3-15','¿Cuál proveedor acumula más gasto recibido?',['get_supplier_intelligence'],'ROUTING'),
  readCase('V3-16','Compara lead time de SUP-05.',['get_supplier_intelligence'],'DATA_SEMANTICS'),
  readCase('V3-17','¿Qué proveedor concentra más compras pendientes?',['get_supplier_intelligence'],'ROUTING'),
  readCase('V3-18','Busca alternativas de proveedor para PAN-FRE-001.',['get_supplier_intelligence'],'ENTITY_RESOLUTION'),
  readCase('V3-19','¿Con qué productos se compra PAN-FRE-001?',['get_cross_sell_recommendations'],'ROUTING'),
  readCase('V3-20','Muestra las asociaciones estables entre categorías.',['get_cross_sell_recommendations'],'DATA_SEMANTICS'),
  readCase('V3-21','¿Cómo va la salud general del negocio?',['get_business_health'],'ROUTING'),
  readCase('V3-22','Dame el resumen general del negocio.',['get_business_health'],'ROUTING'),
  readCase('V3-23','Amplía el inventario.',['get_inventory_intelligence'],'CONTEXT'),
  readCase('V3-24','Amplía los clientes.',['get_customer_intelligence'],'CONTEXT'),
  readCase('V3-25','¿Qué anomalías de ventas deberían revisarse?',['get_business_analytics'],'ML_SEMANTICS'),
  readCase('V3-26','¿Cuál es el estado de mis reglas de asociación?',['get_cross_sell_recommendations'],'ROUTING'),
  readCase('V3-27','¿Hay clientes nuevos en el período actual?',['get_customer_intelligence'],'DATA_SEMANTICS'),
  readCase('V3-28','¿Qué proveedores registran demoras?',['get_supplier_intelligence'],'DATA_SEMANTICS'),
  readCase('V3-29','¿Cómo se interpreta la cobertura de inventario?',['get_inventory_intelligence'],'ML_SEMANTICS'),
  readCase('V3-30','¿Cuál es el margen bruto disponible esta semana?',['get_business_analytics'],'DATA_SEMANTICS'),
];

const multiIntent = [
  readCase('MI-01','¿Cuánto vendí en los últimos 7 días y qué productos están en riesgo?',['get_business_analytics','get_inventory_intelligence'],'ROUTING'),
  readCase('MI-02','Resume las ventas de ayer y dime qué productos debo reponer.',['get_business_analytics','get_inventory_intelligence'],'ROUTING'),
  readCase('MI-03','¿Qué stock tiene PAN-FRE-001 y cuál es su pronóstico de 7 días?',['get_inventory_intelligence','get_product_forecast'],'ROUTING'),
  readCase('MI-04','Compara WAPE del forecast y estabilidad del clustering.',['get_customer_intelligence','get_product_forecast'],'ML_SEMANTICS'),
  readCase('MI-05','Muéstrame señales atípicas de ventas y productos relacionados con PAN-FRE-001.',['get_business_analytics','get_cross_sell_recommendations'],'ROUTING'),
  readCase('MI-06','¿Cómo va la salud general del negocio y qué proveedores tienen retrasos?',['get_business_health','get_supplier_intelligence'],'ROUTING'),
  readCase('MI-07','¿Cómo va el inventario y qué proveedores tienen pedidos pendientes?',['get_inventory_intelligence','get_supplier_intelligence'],'ROUTING'),
  readCase('MI-08','¿Qué modelo de predicción uso y cuáles son mis clusters de clientes?',['get_customer_intelligence','get_product_forecast'],'ML_SEMANTICS'),
  readCase('MI-09','Compara K-Means e Isolation Forest.',['get_business_analytics','get_customer_intelligence'],'ML_SEMANTICS'),
  readCase('MI-10','Compara el modelo de predicción con FP-Growth.',['get_cross_sell_recommendations','get_product_forecast'],'ML_SEMANTICS'),
  readCase('MI-11','¿Qué algoritmos ML usa el sistema y cómo está la salud del negocio?',['get_business_health','get_customer_intelligence','get_business_analytics','get_product_forecast'],'ML_SEMANTICS'),
  readCase('MI-12','¿Qué clusters hay y hubo días atípicos en ventas?',['get_business_analytics','get_customer_intelligence'],'ROUTING'),
];

const writes = [
  { id:'WS-01', text:'vende 2 unidades de PAN-FRE-001' },
  { id:'WS-02', text:'compra 3 del PAN-FRE-001 con SUP-05' },
  { id:'WS-03', text:'avísame cuando PAN-FRE-001 baje de 3' },
  { id:'WS-04', text:'vende 0 del PAN-FRE-001' },
  { id:'WS-05', text:'vende -2 del PAN-FRE-001' },
  { id:'WS-06', text:'vende 2.5 del PAN-FRE-001' },
  { id:'WS-07', text:'vende 2,5 del PAN-FRE-001' },
  { id:'WS-08', text:'compra 3 del producto ambiguo' },
  { id:'WS-09', text:'confirma', decision:'confirm' },
  { id:'WS-10', text:'sí, hazlo', decision:'confirm' },
  { id:'WS-11', text:'mejor no', decision:'cancel' },
  { id:'WS-12', text:'no lo hagas', decision:'cancel' },
  { id:'WS-13', text:'¿puedes confirmar la compra?', decision:'hold' },
  { id:'WS-14', text:'el segundo', decision:null },
  { id:'WS-15', text:'no, procede', decision:'hold' },
];

const contexts = [
  { id:'CTX-01', turns:[
    { text:'¿Cuánto stock tiene PAN-FRE-001?', skills:['get_inventory_intelligence'] },
    { text:'¿Y su pronóstico para los próximos 7 días?', state:{ lastFamily:'get_inventory_intelligence', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_product_forecast'], product:'PAN-FRE-001' },
    { text:'¿Cuánto vendí de PAN-FRE-001 ayer?', state:{ lastFamily:'get_product_forecast', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_business_analytics'], product:'PAN-FRE-001' },
  ]},
  { id:'CTX-02', turns:[
    { text:'¿Cuánto vendí esta semana?', skills:['get_business_analytics'] },
    { text:'¿Y ayer?', state:{ lastFamily:'get_business_analytics', selectedPeriod:{ startDate:'2026-10-13', endDate:'2026-10-14' } }, skills:['get_business_analytics'] },
    { text:'¿Qué productos están en riesgo crítico?', state:{ lastFamily:'get_business_analytics' }, skills:['get_inventory_intelligence'] },
  ]},
  { id:'CTX-03', turns:[
    { text:'¿Quiénes son mis clientes de mayor gasto?', skills:['get_customer_intelligence'] },
    { text:'¿Y su riesgo?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CUS-003' } }, skills:['get_customer_intelligence'] },
    { text:'¿Qué suele comprar ese cliente?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CUS-003' } }, skills:['get_customer_intelligence'] },
  ]},
  { id:'CTX-04', turns:[
    { text:'¿Qué proveedor acumula más gasto?', skills:['get_supplier_intelligence'] },
    { text:'¿Y su lead time?', state:{ lastFamily:'get_supplier_intelligence', selectedSupplier:{ key:'SUP-05' } }, skills:['get_supplier_intelligence'] },
    { text:'¿Y sus retrasos?', state:{ lastFamily:'get_supplier_intelligence', selectedSupplier:{ key:'SUP-05' } }, skills:['get_supplier_intelligence'] },
  ]},
  { id:'CTX-05', turns:[
    { text:'¿Cómo se calcula el pronóstico de PAN-FRE-001?', skills:['get_product_forecast'] },
    { text:'¿Y para 14 días?', state:{ lastFamily:'get_product_forecast', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_product_forecast'], product:'PAN-FRE-001' },
    { text:'¿Cómo se compara con HGB?', state:{ lastFamily:'get_product_forecast', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_product_forecast'] },
  ]},
  { id:'CTX-06', turns:[
    { text:'¿Con qué productos se compra PAN-FRE-001?', skills:['get_cross_sell_recommendations'] },
    { text:'¿El lift demuestra causalidad?', state:{ lastFamily:'get_cross_sell_recommendations', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_cross_sell_recommendations'] },
    { text:'¿Qué ventas tuvo CUS-003?', state:{ lastFamily:'get_cross_sell_recommendations', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_business_analytics'] },
  ]},
  { id:'CTX-07', turns:[
    { text:'¿Cómo está la salud del negocio?', skills:['get_business_health'] },
    { text:'Amplía inventario', state:{ lastFamily:'get_business_health' }, skills:['get_inventory_intelligence'] },
    { text:'Amplía clientes', state:{ lastFamily:'get_inventory_intelligence' }, skills:['get_customer_intelligence'] },
  ]},
  { id:'CTX-08', turns:[
    { text:'¿Qué predicción está operativa?', skills:['get_product_forecast'] },
    { text:'¿Y la estabilidad de anomalías?', state:{ lastFamily:'get_product_forecast' }, skills:['get_business_analytics'] },
    { text:'¿Qué reglas de canasta hay?', state:{ lastFamily:'get_business_analytics' }, skills:['get_cross_sell_recommendations'] },
  ]},
  { id:'CTX-09', turns:[
    { text:'¿Qué productos hay con riesgo alto?', skills:['get_inventory_intelligence'] },
    { text:'¿Y proveedores alternativos para PAN-FRE-001?', state:{ lastFamily:'get_inventory_intelligence', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_supplier_intelligence'] },
    { text:'¿Qué stock tiene ese producto?', state:{ lastFamily:'get_supplier_intelligence', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_inventory_intelligence'], product:'PAN-FRE-001' },
  ]},
  { id:'CTX-10', turns:[
    { text:'¿Qué clientes compraron más este mes?', skills:['get_customer_intelligence'] },
    { text:'¿Y el clustering?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CUS-003' } }, skills:['get_customer_intelligence'] },
    { text:'¿Qué ventas tuvo PAN-FRE-001 ayer?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CUS-003' } }, skills:['get_business_analytics'], product:'PAN-FRE-001' },
  ]},
];

const errors = [
  { id:'ER-01', text:'Pronóstico de PAN-FRE-001 a 28 días' },
  { id:'ER-02', text:'¿Cuál es la predicción del próximo mes?' },
  { id:'ER-03', text:'Ventas entre el 1 y el 5' },
  { id:'ER-04', text:'¿Cuánto stock tiene ese producto?' },
  { id:'ER-05', text:'¿Cuál es el mejor proveedor?' },
];

const totalCases = legacyCases.length + academic.length + v3Domains.length + multiIntent.length + writes.length + contexts.length + errors.length;

test('H.3 differential assistant battery: V2 subset + new V3/H.1/H.2 coverage', () => {
  assert.equal(legacyCases.length, 60, 'Curated V2 regression subset changed unexpectedly');
  assert.equal(academic.length, 30);
  assert.equal(multiIntent.length, 12);
  assert.equal(contexts.length, 10);
  assert.equal(contexts.every(row => row.turns.length >= 3 && row.turns.length <= 6), true);
  assert.equal(totalCases, 162);
  const failures = [];
  const legacyCategories = {};
  for (const row of legacyCases) {
    if (row.expected.level === 'action') {
      const parsedIntent = actionIntent(row.input);
      let parsed;
      let parseFailed = false;
      try { parsed = parseAction(row.input); } catch { parseFailed = true; }
      if (parsedIntent !== row.expected.action || Boolean(row.expected.invalid) !== parseFailed || (!row.expected.invalid && parsed?.items?.[0]?.quantity !== row.expected.quantity)) {
        failures.push({ id:row.id, category:'WRITE_SAFETY', input:row.input, expected:row.expected, observed:{ action:parsedIntent, quantity:parsed?.items?.[0]?.quantity, parseFailed } });
      }
      legacyCategories[row.area] = (legacyCategories[row.area] || 0) + 1;
      continue;
    }
    const expected = row.expected.intents || [];
    const plan = routeDeterministically(row.input, {}, new Date('2026-10-09T12:00:00Z'), undefined, undefined, 'A');
    const expectedIntents = expected.map(intent => ({ forecast_analytics:'ml_analytics', clarification:'ambiguous_query', forecast_temporal_limitation:'ml_historical_clarification' })[intent] || intent);
    const adjustedV2 = {
      'U-0004':['ambiguous_query'], 'U-0009':['ambiguous_query'],
      'U-0310':['replenishment_budget_required'], 'U-0313':['replenishment_budget_required'], 'U-0315':['replenishment_budget_required'],
    }[row.id];
    const acceptable = adjustedV2 || expectedIntents;
    if (!acceptable.includes(plan?.intent)) failures.push({ id:row.id, category:'ROUTING', input:row.input, expected:acceptable, observed:plan?.intent || null });
    legacyCategories[row.area] = (legacyCategories[row.area] || 0) + 1;
  }
  const v3Rows = [...academic, ...v3Domains, ...multiIntent];
  for (const row of v3Rows) {
    const plan = route(row.text);
    if (plan?.__error) failures.push({ id:row.id, category:row.category, input:row.text, thrown:plan.__error });
    if (row.id === 'V3-14') {
      if (plan?.lookup !== 'CUS-001') failures.push({ id:row.id, category:'ENTITY_RESOLUTION', input:row.text, expectedLookup:'CUS-001', observedLookup:plan?.lookup || null });
      continue;
    }
    if (row.id === 'AC-18') {
      if (!plan?.clarificationQuestion || plan.tasks?.length) failures.push({ id:row.id, category:'ERROR_HANDLING', input:row.text, expected:'historical cutoff clarification', observed:skillIds(plan), clarification:plan?.clarificationQuestion || null });
      continue;
    }
    const observed = skillIds(plan);
    if (JSON.stringify(row.skills) !== JSON.stringify(observed)) failures.push({ id:row.id, category:row.category, input:row.text, expected:row.skills, observed, clarification:plan?.clarificationQuestion || null });
    if (row.id === 'V3-29' && plan?.tasks?.[0]?.args?.concept !== 'coverage') failures.push({ id:row.id, category:'DATA_SEMANTICS', input:row.text, expectedConcept:'coverage', observedConcept:plan?.tasks?.[0]?.args?.concept || null });
    if (row.id === 'V3-30' && (plan?.tasks?.[0]?.args?.metric !== 'gross_margin' || plan?.tasks?.[0]?.args?.mode !== 'summary')) failures.push({ id:row.id, category:'DATA_SEMANTICS', input:row.text, expected:{ mode:'summary', metric:'gross_margin' }, observed:plan?.tasks?.[0]?.args || null });
    if (row.id === 'MI-03') {
      const forecast = plan?.tasks?.find(task => task.skillId === 'get_product_forecast');
      if (forecast?.args?.productRef !== 'PAN-FRE-001' || forecast?.args?.horizonDays !== 7) failures.push({ id:row.id, category:'DATA_SEMANTICS', input:row.text, expectedForecast:{ productRef:'PAN-FRE-001', horizonDays:7 }, observedForecast:forecast?.args || null });
    }
  }
  for (const row of writes) {
    const plan = route(row.text);
    if (plan?.tasks?.length) failures.push({ id:row.id, category:'WRITE_SAFETY', input:row.text, observed:skillIds(plan) });
    if (row.decision !== undefined) {
      const observed = actionDecision(row.text);
      if (observed !== row.decision) failures.push({ id:row.id, category:'WRITE_SAFETY', input:row.text, expectedDecision:row.decision, observedDecision:observed });
    }
  }
  let contextTurns = 0;
  for (const conversation of contexts) {
    for (const [turnIndex, turn] of conversation.turns.entries()) {
      contextTurns++;
      const plan = route(turn.text, turn.state || {});
      if (plan?.__error) failures.push({ id:conversation.id, turn:turnIndex + 1, category:'CONTEXT', input:turn.text, thrown:plan.__error });
      const observed = skillIds(plan);
      if (JSON.stringify([...turn.skills].sort()) !== JSON.stringify(observed)) failures.push({ id:conversation.id, turn:turnIndex + 1, category:'CONTEXT', input:turn.text, expected:turn.skills, observed, clarification:plan?.clarificationQuestion || null });
      if (turn.product) {
        const productArgs = plan?.tasks?.find(task => ['get_inventory_intelligence','get_product_forecast','get_business_analytics'].includes(task.skillId))?.args || {};
        if (productArgs.productRef !== turn.product) failures.push({ id:conversation.id, turn:turnIndex + 1, category:'CONTEXT', input:turn.text, expectedProduct:turn.product, observedProduct:productArgs.productRef || null });
      }
    }
  }
  for (const row of errors) {
    const plan = route(row.text);
    if (plan?.__error) failures.push({ id:row.id, category:'ERROR_HANDLING', input:row.text, thrown:plan.__error });
    if (!plan?.clarificationQuestion || plan.tasks?.length) failures.push({ id:row.id, category:'ERROR_HANDLING', input:row.text, expected:'safe clarification', observed:skillIds(plan), clarification:plan?.clarificationQuestion || null });
  }
  const counts = { total:totalCases, v2Reused:legacyCases.length, v2Adjusted:5, v3New:v3Rows.length, academicQuestions:academic.length,
    multiIntent:multiIntent.length, writeSafety:writes.length + legacyCases.filter(row => row.expected.level === 'action').length, contextConversations:contexts.length,
    contextTurns, errorCases:errors.length, failures:failures.length };
  console.log(`H3_BATTERY ${JSON.stringify({ counts, v2ByArea:legacyCategories, deterministicLLMCalls:0, deterministicTokens:0, failures })}`);
  assert.equal(failures.length, 0, `H.3 differential failures: ${JSON.stringify(failures, null, 2)}`);
});
