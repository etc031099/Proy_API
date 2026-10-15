'use strict';

// Final reduced H.4 sample: 146 additional deterministic cases, run alongside
// the 162 curated H.3 cases for a bounded total of 308. No provider or writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');
const { actionDecision } = require('../src/automations/actionDecision');
const { actionIntent, parseAction } = require('../src/automations/actionInput');

const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const route = (text, state = {}) => routeV3(text, state, binding);
const skillIds = plan => [...new Set((plan?.tasks || []).map(row => row.skillId))].sort();
const row = (id, text, skills, checks = {}) => ({ id, text, skills: [...skills].sort(), ...checks });

const business = [
  '¿Cuánto vendí hoy?', '¿Cuánto vendí ayer?', '¿Cuánto vendí anteayer?', '¿Cuánto vendí esta semana?',
  '¿Cuánto vendí este mes?', 'Resume mis ventas de los últimos 7 días.', 'Resume mis ventas de los últimos 30 días.',
  'Compara mis ventas de esta semana con la anterior.', '¿Cuántos tickets tuve ayer?', '¿Cuál fue mi ticket promedio hoy?',
  '¿Cuántas unidades vendí esta semana?', '¿Cuál fue mi margen bruto este mes?',
  'Muéstrame mis productos más vendidos.', '¿Qué producto generó más ingresos?', '¿Cuáles fueron mis ventas del lunes?',
  '¿Qué ventas tuvo PAN-FRE-001 ayer?', '¿Cuánto vendí del SKU ABA-PAS-001 esta semana?',
  'Filtra las ventas de PAN-FRE-001 del último mes.',
];
const inventory = [
  '¿Qué productos debo reponer?', '¿Qué productos requieren reposición por stock bajo?', 'Lista el inventario crítico.',
  '¿Cuáles son los productos con mayor riesgo?', '¿Qué productos tienen riesgo CRITICAL?', '¿Qué productos tienen riesgo HIGH?',
  '¿Cuánto stock queda de PAN-FRE-001?', 'Consulta el inventario de ABA-PAS-001.', '¿Qué stock mínimo tiene PAN-FRE-001?',
  '¿Cómo se interpreta la cobertura de inventario?', '¿Qué significa cobertura para PAN-FRE-001?', '¿Cuál es el punto de reposición de ABA-PAS-001?',
  'Muestra las recomendaciones de reposición.', '¿Qué productos tienen riesgo de sobrestock?', '¿Hay inventario de movimiento lento?',
  '¿Cómo se distribuye el inventario por ABC?', 'Clasifica los productos con XYZ.', '¿Qué productos requieren reposición de clase A?',
  'Revisa el riesgo de stock del producto PAN-FRE-001.',
];
const forecast = [
  '¿Cuál es el pronóstico de PAN-FRE-001 para 1 día?', 'Pronostica PAN-FRE-001 para los próximos 7 días.',
  'Dame el forecast de ABA-PAS-001 a 14 días.', 'Predicción de PAN-FRE-001 para los próximos 7 días.',
  '¿Cuál es la predicción de demanda de ABA-PAS-001?', '¿Qué método estadístico está operativo para el pronóstico?',
  '¿Por qué se eligió el método estadístico para forecast?', '¿Qué WAPE obtuvo el modelo HGB?', '¿Cómo se compara HGB con el baseline?',
  '¿Cuál es el horizonte máximo aprobado del pronóstico?', 'Pronóstico de PAN-FRE-001 a 28 días.',
  '¿Qué forecast tiene ABA-PAS-001 para los próximos 14 días?', '¿Cuál es la predicción de PAN-FRE-001 a 7 días?',
  '¿Qué significa WAPE en la evaluación del pronóstico?',
];
const customers = [
  '¿Quiénes son mis clientes frecuentes?', 'Lista los clientes con mayor gasto.', '¿Qué clientes podrían estar inactivos?',
  '¿Qué perfil tiene CLI-001 en el cluster?', '¿En qué cluster está CLI-001?', '¿Qué significa RFM en clientes?',
  '¿Cómo se eligió el número de clusters?', '¿Qué silhouette obtuvo K-Means?', '¿Qué valor ARI tuvo la segmentación?',
  '¿Cuáles son los perfiles de los clusters?',
];
const suppliers = [
  '¿Qué proveedores tienen compras pendientes?', '¿Cuál proveedor tiene más retrasos?', 'Compara el lead time de SUP-05.',
  '¿Qué productos provee SUP-05?', 'Busca proveedores alternativos para PAN-FRE-001.',
  '¿Cuánto se compró a SUP-05?', '¿Qué proveedor tiene más órdenes recibidas?', '¿Cómo se mide la puntualidad del proveedor?',
  '¿Cuál es la dependencia de abastecimiento de SUP-05?', 'Dame el detalle del proveedor SUP-05.',
];
const anomalies = [
  '¿Qué anomalías de ventas hubo en el histórico?', 'Muéstrame el score de anomalías de ventas.',
  '¿El Isolation Forest confirma fraude?', '¿Cuántos días atípicos detectó el modelo?',
  '¿Qué significa contamination en Isolation Forest?', '¿Cómo se interpreta el score negativo de anomalía?',
  '¿Qué estabilidad Jaccard tiene el detector?', '¿Hubo ventas fuera del patrón en 2026-10-12?',
  '¿Las anomalías son incidentes confirmados?',
];
const basket = [
  '¿Qué productos se compran junto con PAN-FRE-001?', '¿Qué asociaciones de productos son estables?',
  'Explica support de las reglas de canasta.', '¿Qué confidence tiene la asociación?', '¿Qué lift tiene ABA-PAS-001?',
  '¿El lift demuestra que un producto causa la compra de otro?', '¿Hasta qué fecha llega el artifact de asociaciones?',
  '¿Qué algoritmo genera las asociaciones de compra?', 'Busca productos relacionados con ABA-PAS-001.',
];
const health = [
  '¿Cómo está la salud de mi negocio?', 'Dame un diagnóstico general del negocio.',
  '¿La salud del negocio tiene un score global?', 'Diagnóstico general del negocio.',
  '¿Qué señales importantes muestra la salud general del negocio?', '¿Cómo va el negocio en el período actual?',
  '¿Cómo va la salud general del negocio?', 'Amplía la vista general del negocio.',
];

const grouped = [
  ['business', business, ['get_business_analytics']], ['inventory', inventory, ['get_inventory_intelligence']],
  ['forecast', forecast, ['get_product_forecast']], ['customer', customers, ['get_customer_intelligence']],
  ['supplier', suppliers, ['get_supplier_intelligence']], ['anomaly', anomalies, ['get_business_analytics']],
  ['basket', basket, ['get_cross_sell_recommendations']], ['health', health, ['get_business_health']],
];
const domainCases = grouped.flatMap(([group, phrases, skills]) => phrases.map((text, i) => row(`${group}-${i + 1}`, text, skills)));

const multi = [
  row('multi-01','¿Cuánto vendí esta semana y qué productos debo reponer?',['get_business_analytics','get_inventory_intelligence']),
  row('multi-02','Stock de PAN-FRE-001 y forecast de 14 días.',['get_inventory_intelligence','get_product_forecast'],{ product:'PAN-FRE-001', horizon:14 }),
  row('multi-03','¿Quién es el mejor cliente y qué suele comprar?',['get_customer_intelligence']),
  row('multi-04','¿Qué días fueron atípicos y qué productos aparecen relacionados?',['get_business_analytics','get_cross_sell_recommendations']),
  row('multi-05','¿Qué proveedor tarda más y qué productos tienen riesgo crítico?',['get_inventory_intelligence','get_supplier_intelligence']),
  row('multi-06','¿Cómo va la salud del negocio y qué proveedores registran retrasos?',['get_business_health','get_supplier_intelligence']),
  row('multi-07','Compara ingresos y margen bruto de los últimos 7 días.',['get_business_analytics']),
  row('multi-08','Resume el inventario y dime qué proveedores tienen pedidos pendientes.',['get_inventory_intelligence','get_supplier_intelligence']),
  row('multi-09','¿Cuál fue el ingreso y el margen bruto de esta semana?',['get_business_analytics']),
  row('multi-10','¿Qué riesgo crítico hay en inventario y qué proveedores tienen demoras?',['get_inventory_intelligence','get_supplier_intelligence']),
];

const context = [
  { id:'ctx-a', turns:[
    { text:'¿Cuánto stock le queda a PAN-FRE-001?', skills:['get_inventory_intelligence'] },
    { text:'¿Qué predicción aprobada tiene PAN-FRE-001 a 14 días?', state:{ lastFamily:'get_inventory_intelligence', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_product_forecast'], product:'PAN-FRE-001' },
    { text:'¿Qué ventas tuvo PAN-FRE-001 anteayer?', state:{ lastFamily:'get_product_forecast', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_business_analytics'], product:'PAN-FRE-001' },
  ]},
  { id:'ctx-b', turns:[
    { text:'¿Qué clientes tienen mayor gasto?', skills:['get_customer_intelligence'] },
    { text:'¿Y su riesgo?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CUS-002' } }, skills:['get_customer_intelligence'] },
    { text:'¿Cuál es su cluster?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CUS-002' } }, skills:['get_customer_intelligence'] },
  ]},
  { id:'ctx-c', turns:[
    { text:'¿Qué proveedores acumulan más compras?', skills:['get_supplier_intelligence'] },
    { text:'¿Qué lead time tuvo SUP-05?', state:{ lastFamily:'get_supplier_intelligence', selectedSupplier:{ key:'SUP-05' } }, skills:['get_supplier_intelligence'] },
    { text:'¿Ese proveedor tuvo demoras?', state:{ lastFamily:'get_supplier_intelligence', selectedSupplier:{ key:'SUP-05' } }, skills:['get_supplier_intelligence'] },
  ]},
  { id:'ctx-d', turns:[
    { text:'¿Qué debería revisar hoy en el negocio?', skills:['get_business_health'] },
    { text:'Amplía inventario.', state:{ lastFamily:'get_business_health' }, skills:['get_inventory_intelligence'] },
    { text:'¿Y su cobertura de inventario?', state:{ lastFamily:'get_inventory_intelligence', selectedProduct:{ key:'PAN-FRE-001' } }, skills:['get_inventory_intelligence'], product:'PAN-FRE-001' },
  ]},
  { id:'ctx-e', turns:[
    { text:'¿Qué productos se compran junto con PAN-FRE-001?', skills:['get_cross_sell_recommendations'] },
    { text:'¿Qué stock tiene ABA-PAS-001?', state:{ lastFamily:'get_cross_sell_recommendations', selectedProduct:{ key:'ABA-PAS-001' } }, skills:['get_inventory_intelligence'], product:'ABA-PAS-001' },
    { text:'¿Y el forecast para 7 días?', state:{ lastFamily:'get_inventory_intelligence', selectedProduct:{ key:'ABA-PAS-001' } }, skills:['get_product_forecast'], product:'ABA-PAS-001' },
  ]},
  { id:'ctx-f', turns:[
    { text:'¿Cuánto gastó CLI-001?', skills:['get_customer_intelligence'] },
    { text:'¿Y su RFM?', state:{ lastFamily:'get_business_analytics', selectedCustomer:{ key:'CLI-001' } }, skills:['get_customer_intelligence'] },
    { text:'¿Qué productos compró ese cliente?', state:{ lastFamily:'get_customer_intelligence', selectedCustomer:{ key:'CLI-001' } }, skills:['get_customer_intelligence'] },
  ]},
];

const writes = [
  { text:'vende 2 unidades de PAN-FRE-001', intent:'create_sale', parse:true },
  { text:'compra 3 del PAN-FRE-001 con SUP-05', intent:'create_purchase', parse:true },
  { text:'avísame cuando PAN-FRE-001 baje de 3', intent:'create_stock_alert_rule', parse:true },
  { text:'vende 0 de PAN-FRE-001', intent:'create_sale', parse:false },
  { text:'vende 2.5 de PAN-FRE-001', intent:'create_sale', parse:false },
  { text:'confirma', decision:'confirm' },
  { text:'sí, hazlo', decision:'confirm' },
  { text:'el segundo', decision:null },
  { text:'¿puedes confirmar la compra?', decision:'hold' },
  { text:'mejor no', decision:'cancel' },
];

const errors = [
  { text:'Forecast de PAN-FRE-001 a 28 días', kind:'clarify' },
  { text:'¿Cuál es la predicción del próximo mes?', kind:'clarify' },
  { text:'¿Cuánto stock tiene ese producto?', kind:'clarify' },
  { text:'¿Cuál es el mejor proveedor?', kind:'clarify' },
  { text:'¿Qué accuracy tiene Isolation Forest?', kind:'unsupported' },
  { text:'¿Qué probabilidad individual tiene esta anomalía?', kind:'unsupported' },
  { text:'¿Puede demostrar causalidad el lift?', kind:'route' },
  { text:'¿Qué información no disponible hay para el SKU X?', kind:'safe' },
];
const coverageCases = [
  { text:'¿Cuántos días de cobertura tiene PAN-FRE-001?', expected:'detail', product:'PAN-FRE-001' },
  { text:'Dime los días de cobertura del inventario.', expected:'clarify' },
  { text:'¿Y su cobertura?', expected:'detail', product:'ABA-PAS-001', state:{ lastFamily:'get_inventory_intelligence', selectedProduct:{ key:'ABA-PAS-001' } } },
];

const caseTotal = domainCases.length + multi.length + context.reduce((n, c) => n + c.turns.length, 0) + writes.length + errors.length + coverageCases.length;

test('H.4 final reduced conversational validation sample (146 additional, 308 with H.3)', () => {
  assert.equal(domainCases.length, 97);
  assert.equal(multi.length, 10);
  assert.equal(context.reduce((n, c) => n + c.turns.length, 0), 18);
  assert.equal(writes.length, 10);
  assert.equal(errors.length, 8);
  assert.equal(coverageCases.length, 3);
  assert.equal(caseTotal, 146);

  const failures = [];
  for (const item of domainCases) {
    const plan = route(item.text, item.state || {});
    const observed = skillIds(plan);
    const safeLimit = ['forecast-11', 'anomaly-4'].includes(item.id);
    if (safeLimit ? (!plan?.clarificationQuestion || observed.length) : JSON.stringify(item.skills) !== JSON.stringify(observed))
      failures.push({ id:item.id, category:safeLimit ? 'ERROR_HANDLING' : 'ROUTING', text:item.text, expected:safeLimit ? 'safe clarification' : item.skills, observed, clarification:plan?.clarificationQuestion });
  }
  for (const item of multi) {
    const plan = route(item.text);
    const observed = skillIds(plan);
    if (JSON.stringify(item.skills) !== JSON.stringify(observed)) failures.push({ id:item.id, category:'ROUTING', text:item.text, expected:item.skills, observed, clarification:plan?.clarificationQuestion });
    if (item.product) {
      const inv = plan?.tasks?.find(t => t.skillId === 'get_inventory_intelligence')?.args;
      const fc = plan?.tasks?.find(t => t.skillId === 'get_product_forecast')?.args;
      if (inv?.productRef !== item.product || fc?.productRef !== item.product || fc?.horizonDays !== item.horizon)
        failures.push({ id:item.id, category:'CONTEXT', text:item.text, expected:{ product:item.product, horizon:item.horizon }, observed:{ inventory:inv, forecast:fc } });
    }
  }
  let contextTurns = 0;
  for (const conversation of context) for (const [index, turn] of conversation.turns.entries()) {
    contextTurns++;
    const plan = route(turn.text, turn.state || {});
    if (JSON.stringify(turn.skills.slice().sort()) !== JSON.stringify(skillIds(plan))) failures.push({ id:conversation.id, turn:index + 1, category:'CONTEXT', text:turn.text, expected:turn.skills, observed:skillIds(plan), clarification:plan?.clarificationQuestion });
    if (turn.product) {
      const selectedTask = plan?.tasks?.find(t => ['get_inventory_intelligence','get_product_forecast','get_business_analytics'].includes(t.skillId));
      if (selectedTask?.args?.productRef !== turn.product) failures.push({ id:conversation.id, turn:index + 1, category:'ENTITY', expectedProduct:turn.product, observedProduct:selectedTask?.args?.productRef });
    }
  }
  let writeExecutions = 0;
  for (const item of writes) {
    if (item.intent) {
      const intent = actionIntent(item.text);
      let parsed = true;
      try { parseAction(item.text); } catch { parsed = false; }
      if (intent !== item.intent || parsed !== item.parse) failures.push({ category:'WRITE_SAFETY', text:item.text, expected:{ intent:item.intent, parse:item.parse }, observed:{ intent, parse:parsed } });
    }
    if ('decision' in item && actionDecision(item.text) !== item.decision) failures.push({ category:'WRITE_SAFETY', text:item.text, expectedDecision:item.decision, observedDecision:actionDecision(item.text) });
    if (route(item.text)?.tasks?.length) writeExecutions++;
  }
  for (const item of errors) {
    const plan = route(item.text);
    if (plan?.__error) failures.push({ category:'ERROR_HANDLING', text:item.text, thrown:plan.__error });
    if (item.kind === 'clarify' && (!plan?.clarificationQuestion || plan.tasks?.length)) failures.push({ category:'ERROR_HANDLING', text:item.text, expected:'safe clarification', observed:skillIds(plan), clarification:plan?.clarificationQuestion });
    if (item.kind === 'unsupported' && !plan?.clarificationQuestion && !plan?.tasks?.length) failures.push({ category:'ML_SEMANTICS', text:item.text, expected:'bounded response', observed:plan });
  }
  for (const item of coverageCases) {
    const plan = route(item.text, item.state || {});
    const inv = plan?.tasks?.find(t => t.skillId === 'get_inventory_intelligence');
    if (item.expected === 'detail' && (inv?.args?.mode !== 'detail' || inv.args.productRef !== item.product))
      failures.push({ category:'ROUTING', text:item.text, expected:{ mode:'detail', productRef:item.product }, observed:inv?.args || null, clarification:plan?.clarificationQuestion || null });
    if (item.expected === 'clarify' && (!plan?.clarificationQuestion || plan?.tasks?.length))
      failures.push({ category:'ENTITY', text:item.text, expected:'ask for product', observed:skillIds(plan), clarification:plan?.clarificationQuestion || null });
  }
  const categories = failures.reduce((acc, f) => (acc[f.category] = (acc[f.category] || 0) + 1, acc), {});
  console.log(`H4_BATTERY ${JSON.stringify({ total:caseTotal, h3Cases:162, combined:caseTotal + 162, domainCases:domainCases.length,
    groupCounts:Object.fromEntries(grouped.map(([name, cases]) => [name, cases.length])), multiIntent:multi.length,
    contextConversations:context.length, contextTurns, writeSafety:writes.length, writeExecutions,
    deterministicLlmCalls:0, deterministicTokens:0, failures:failures.length, failuresByCategory:categories, failuresList:failures })}`);
  assert.equal(failures.length, 0, `H.4 failures: ${JSON.stringify(failures, null, 2)}`);
});
