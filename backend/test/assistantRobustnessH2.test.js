'use strict';

// Intermediate conversational battery: routing contracts plus sequence/guard
// probes. Runtime, entity-service, fail-closed and WRITE integration cases also
// remain covered by the focused suites listed in the H.2 report.
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');

const binding = { ...V3, asOfDate: V3.referenceDate };
const domainBySkill = {
  get_business_analytics: 'sales', get_inventory_intelligence: 'inventory', get_product_forecast: 'forecast',
  get_customer_intelligence: 'customers', get_supplier_intelligence: 'suppliers',
  get_cross_sell_recommendations: 'market_basket', get_business_health: 'health'
};
const cases = [];
const add = (category, input, expectedSkills, state = {}) => cases.push({ caseId: `H2-${String(cases.length + 1).padStart(3, '0')}`,
  category, input, expectedDomain: expectedSkills.map(skill => domainBySkill[skill]), expectedSkills, state });
const group = (category, skill, inputs) => inputs.forEach(input => add(category, input, [skill]));

group('sales', 'get_business_analytics', [
  '¿Cuánto vendí hoy?', 'Cuánto vendimos ayer', 'Ventas anteayer', 'Cuántas ventas hubo esta semana',
  '¿Cuánto ingresó este mes?', 'Resumen de ventas', 'Margen bruto de ventas esta semana',
  '¿Qué producto vendí más?', 'Top 5 productos por ventas', 'Ventas por categoría',
  '¿Qué periodo tuvo más ventas, esta semana o la pasada?', '¿Cuánto vendí del producto PAN-FRE-001 ayer?'
]);
group('inventory', 'get_inventory_intelligence', [
  '¿Qué productos debo reponer?', 'Qué se está acabando', 'Productos críticos', 'Productos de alto riesgo',
  'Inventario con sobrestock', 'Productos de movimiento lento', 'Productos sin movimiento', 'ABC de productos',
  'XYZ del inventario', 'Cuánto pedir de PAN-FRE-001', 'Productos críticos del proveedor SUP-05',
  '¿Qué stock tiene PAN-FRE-001?'
]);
group('forecast', 'get_product_forecast', [
  'Predicción de PAN-FRE-001', 'Pronóstico de Inca Kola 500 ml', 'Demanda próxima semana',
  'Qué demanda espero los próximos 14 días', 'Pronóstico para mañana', 'Forecast de PAN-FRE-001 por 7 días',
  'Mayor demanda de productos', 'Resumen del forecast', 'Pronóstico de pan francés los próximos 14 días',
  'Cómo calculas el pronóstico', '¿Cuánto venderé mañana?', 'Pronóstico de BEB-GAS-003'
]);
group('customers', 'get_customer_intelligence', [
  'Quiénes son mis mejores clientes', 'Qué clientes están en riesgo', 'Qué suele comprar Víctor Poma',
  'Cuánto gastó Elena en los últimos 30 días', 'Clientes inactivos', 'Clientes nuevos',
  'Clientes por frecuencia', 'Ranking de clientes', 'Clientes por recencia',
  'Preferencias del cliente CLI-001', 'Quién me compra más', 'Detalle del cliente CLI-002'
]);
group('suppliers', 'get_supplier_intelligence', [
  'Qué proveedor tarda más', 'Quién me abastece más', 'Qué productos me vende SUP-05',
  'De qué proveedor dependo más', 'Proveedores por compras', 'Proveedores por órdenes',
  'Proveedor con retrasos', 'Proveedores por puntualidad', 'Lead time de SUP-05',
  'Puntualidad de SUP-05', 'Dependencia de proveedores', 'Gasto del proveedor SUP-02'
]);
group('market_basket', 'get_cross_sell_recommendations', [
  'Qué puedo vender junto con PAN-FRE-001', 'Qué productos se compran juntos', 'Productos juntos',
  'Cross sell de pan francés', 'Asociaciones de productos', 'Qué puedo ofrecer junto a pan francés',
  'Qué venden junto con BEB-GAS-003', 'Qué se compra junto con PAN-FRE-001', 'Canasta de productos',
  'Asociaciones para PAN-FRE-001', 'Compras conjuntas de productos', 'Productos que suelen ir juntos'
]);
group('health', 'get_business_health', [
  'Cómo está mi negocio', 'Cómo va el negocio', 'Dame un resumen general', 'Diagnóstico general',
  'Qué debería revisar hoy', 'Salud del negocio', 'Cuáles son los principales problemas',
  'Resumen general del negocio', 'Diagnóstico general de mi negocio', 'Estado del negocio',
  'Dame una vista general de mi negocio', '¿Cómo está la salud general del negocio?'
]);
group('colloquial_typos', 'get_business_analytics', ['cuanto vendi oy']);
group('colloquial_typos', 'get_inventory_intelligence', ['q productos estan en riesgo']);
group('colloquial_typos', 'get_customer_intelligence', [
  'dime los clietnes del grupo mas alto', 'q algoritmo usa para los clientes'
]);
group('colloquial_typos', 'get_product_forecast', ['cual fue el wape']);
group('colloquial_typos', 'get_cross_sell_recommendations', ['q productos se compran juntos']);

group('academic_ml', 'get_product_forecast', [
  '¿Qué modelo usaste para predecir demanda?',
  '¿Cuál fue el WAPE del modelo?', '¿Cuál fue el baseline?', '¿Qué es aprendizaje supervisado?',
  '¿Qué significa WAPE?', '¿Qué features usa el modelo de predicción?', '¿Por qué MA28 es operativo si se entrenó HGB?',
  '¿Qué modelo estadístico opera el forecast?',
  '¿HistGradientBoosting es el método productivo?', '¿Qué parte de forecast es ML y cuál no?'
]);
group('academic_ml', 'get_customer_intelligence', [
  '¿Cómo segmentaste a los clientes?', '¿Por qué eligió K-Means?', '¿Cómo evaluó el clustering?',
  '¿Qué significa silhouette?', '¿Qué significa ARI?', '¿Qué diferencia hay entre RFM y K-Means?',
  '¿Cuántos clientes hay en cada cluster?', '¿Qué features usa K-Means?', '¿Qué es un cluster de clientes?',
  '¿Cómo interpreto cuatro grupos de clientes?', '¿El clustering asigna probabilidades?', '¿Cuál es el cutoff del entrenamiento K-Means?'
]);
group('academic_ml', 'get_business_analytics', [
  '¿Qué algoritmo detecta anomalías en ventas?', '¿Por qué no usó accuracy en Isolation Forest?',
  '¿Qué significa anomaly score?', '¿Qué significa contamination?', '¿Isolation Forest detecta fraude?',
  '¿Cuáles fueron los días de venta más atípicos?', '¿Cuántos días evaluó el detector?',
  '¿Qué significa el score negativo?', '¿Qué significa estabilidad Jaccard?',
  '¿Cuáles son las variables del detector de anomalías?', '¿El modelo confirma incidentes?',
  '¿Hasta qué fecha está congelado Isolation Forest?'
]);
group('academic_ml', 'get_cross_sell_recommendations', [
  '¿Por qué FP-Growth no es un modelo predictivo?', '¿Qué significa support?', '¿Qué significa confidence?',
  '¿Qué significa lift?', '¿FP-Growth demuestra causalidad?', '¿Qué productos suelen comprarse juntos?',
  '¿Hasta cuándo llega el artifact de asociaciones?', '¿Cómo interpreto una regla de asociación?',
  '¿Lift mayor a uno significa que un producto causa otro?', '¿Cuántos tickets respaldan la regla?',
  '¿Qué es minería de patrones frecuentes?', '¿Qué algoritmo genera las asociaciones de compra?'
]);
group('academic_ml', 'get_inventory_intelligence', [
  '¿El inventario usa Machine Learning?', '¿Coverage es una predicción del modelo?',
  '¿Qué es el punto de reposición?', '¿Qué significa safety stock?',
  '¿ABC y XYZ son algoritmos de Machine Learning?', '¿HGB decide cuánto reponer?',
  '¿El riesgo CRITICAL es una probabilidad?', '¿Qué significa cobertura de inventario?',
  '¿La cantidad sugerida confirma una compra?', '¿Cómo se calcula una recomendación operativa?',
  '¿Usan ML para el stock mínimo?', '¿La reposición se ejecuta automáticamente?'
]);
group('academic_ml', 'get_supplier_intelligence', [
  '¿Por qué no aplicó ML a proveedores?', '¿Qué significa lead time?', '¿Qué significa puntualidad del proveedor?',
  '¿Existe un score de mejor proveedor?', '¿Cómo se mide la dependencia de proveedores?',
  '¿Qué proveedor tiene pedidos pendientes?', '¿El proveedor tiene una probabilidad de retraso?',
  '¿Qué representa el gasto recibido del proveedor?', '¿Qué datos descriptivos se usan para proveedores?',
  '¿Los proveedores se clasifican con K-Means?', '¿Qué significa proveedor de fuente única?',
  '¿La puntualidad demuestra calidad causalmente?'
]);
add('academic_ml', '¿Qué algoritmos de Machine Learning utiliza el sistema?', ['get_product_forecast',
  'get_customer_intelligence', 'get_business_analytics', 'get_cross_sell_recommendations']);
add('academic_ml', '¿Qué significa aprendizaje no supervisado?', ['get_customer_intelligence', 'get_business_analytics']);

const multi = [
  ['¿Cuánto vendí esta semana y qué productos están en riesgo?', ['get_business_analytics', 'get_inventory_intelligence']],
  ['Dime qué modelo de predicción uso y cuáles son mis clusters de clientes', ['get_product_forecast', 'get_customer_intelligence']],
  ['Compara K-Means e Isolation Forest', ['get_customer_intelligence', 'get_business_analytics']],
  ['Compara el modelo de predicción con FP-Growth', ['get_product_forecast', 'get_cross_sell_recommendations']],
  ['¿Qué algoritmo ML usa el sistema y cómo está la salud del negocio?', ['get_product_forecast', 'get_customer_intelligence', 'get_business_analytics', 'get_business_health']],
  ['¿Qué proveedor tarda más y qué productos están críticos?', ['get_supplier_intelligence', 'get_inventory_intelligence']],
  ['¿Quién es mi mejor cliente y qué suele comprar?', ['get_customer_intelligence']],
  ['Muéstrame anomalías y reglas de productos relacionados', ['get_business_analytics', 'get_cross_sell_recommendations']],
  ['¿Qué productos debo reponer y cuánto vendí esta semana?', ['get_business_analytics', 'get_inventory_intelligence']],
  ['¿Cuál es la salud del negocio y qué proveedores tienen retrasos?', ['get_business_health', 'get_supplier_intelligence']],
  ['¿Cómo va el inventario y qué proveedores tienen pedidos pendientes?', ['get_inventory_intelligence', 'get_supplier_intelligence']],
  ['¿Qué modelo usas y cuál es el WAPE del pronóstico?', ['get_product_forecast']]
];
for (const [input, skills] of multi) add('multi_intent', input, skills);

const followups = [
  ['¿y ayer?', 'get_business_analytics', { lastFamily: 'get_business_analytics' }],
  ['¿y su detalle de cliente?', 'get_customer_intelligence', { selectedCustomer: { key: 'CLI-001' } }],
  ['¿y su riesgo?', 'get_inventory_intelligence', { selectedProduct: { key: 'PAN-FRE-001' } }],
  ['¿y su lead time?', 'get_supplier_intelligence', { selectedSupplier: { key: 'SUP-05' } }],
  ['¿y los próximos 14 días?', 'get_product_forecast', { lastFamily: 'get_product_forecast', selectedProduct: { key: 'PAN-FRE-001' } }],
  ['¿qué compra habitualmente ese cliente?', 'get_customer_intelligence', { lastFamily: 'get_customer_intelligence', selectedCustomer: { key: 'CLI-001' } }],
  ['muéstrame el detalle del cliente CLI-001', 'get_customer_intelligence', {}],
  ['stock del PAN-FRE-001', 'get_inventory_intelligence', {}],
  ['ventas de PAN-FRE-001 ayer', 'get_business_analytics', {}],
  ['pronóstico del PAN-FRE-001', 'get_product_forecast', {}],
  ['productos relacionados a PAN-FRE-001', 'get_cross_sell_recommendations', {}],
  ['gasto del proveedor SUP-05', 'get_supplier_intelligence', {}],
  ['ese proveedor llego tarde?', 'get_supplier_intelligence', { lastFamily: 'get_supplier_intelligence', selectedSupplier: { key: 'SUP-05' } }]
];
for (const [input, skill, state] of followups) add('followup_context', input, [skill], state);
add('followup_context', '¿Cuál de esos compra más?', ['get_customer_intelligence'], {
  lastFamily: 'get_customer_intelligence', ranking: { type: 'customer', items: [{ key: 'CLI-001' }] }
});
cases.push({ caseId: `H2-${String(cases.length + 1).padStart(3, '0')}`, category: 'followup_context',
  input: '¿Cuál de esos compra más?', expectedDomain: ['clarification'], expectedSkills: [],
  expectedDisposition: 'clarification', state: {} });

for (const input of [
  'Busca pan francés', 'Busca Inca Kola 500 ml', 'Busca PAN-FRE-001', 'Busca cliente CLI-001', 'Busca proveedor SUP-05',
  'Busca arroz Costeño', 'Busca aceite Primor', 'Busca detergente Bolívar', 'Busca leche evaporada',
  'Busca proveedor Foods', 'Busca cliente Elena', 'Busca galletas'
]) {
  const expectedSkills = input.startsWith('Busca cliente') ? ['get_customer_intelligence']
    : input.startsWith('Busca proveedor') ? ['get_supplier_intelligence'] : [];
  cases.push({ caseId: `H2-${String(cases.length + 1).padStart(3, '0')}`, category: 'entity_resolution', input,
    expectedDomain: expectedSkills.length ? expectedSkills.map(skill => domainBySkill[skill]) : ['lookup'], expectedSkills,
    expectedDisposition: expectedSkills.length ? 'skills' : 'lookup', state: {} });
}

const clarifications = [
  '¿Qué producto es el más importante?', '¿Cuánto stock tiene este producto?', '¿Cuánto pedir?',
  '¿Qué clientes están en el cluster de Consumidor Final?', '¿Qué predicción hubo ayer?',
  '¿Qué suele comprar el cliente sin identificar?', '¿Cuál es el mejor proveedor?', '¿Qué significa confianza de predicción?',
  'Pronóstico de PAN-FRE-001 a 28 días', 'Muéstrame el top 0 de anomalías',
  '¿Qué anomalías hubo mañana?', '¿Cuánto vendí entre el 1 y el 5?'
];
for (const input of clarifications) cases.push({ caseId: `H2-${String(cases.length + 1).padStart(3, '0')}`, category: 'errors_fail_closed', input,
  expectedDomain: ['clarification'], expectedSkills: [], expectedDisposition: 'clarification', state: {} });

for (const input of [
  'vende 5 del producto PAN-FRE-001', 'compra 3 del producto PAN-FRE-001 con SUP-05',
  'crea una alerta de stock para PAN-FRE-001', 'avísame cuando PAN-FRE-001 baje de 3',
  'vende 5 de ese producto', 'sí', 'confirmo', 'hazlo', 'ese', 'el segundo', 'correcto', 'no hagas nada'
]) cases.push({ caseId: `H2-${String(cases.length + 1).padStart(3, '0')}`, category: 'write_safety', input,
  expectedDomain: ['write_handoff'], expectedSkills: [], expectedDisposition: 'write_handoff', state: {} });

function observedDisposition(plan) {
  if (plan?.tasks?.length) {
    const skills = [...new Set(plan.tasks.map(row => row.skillId))].sort();
    return { type: 'skills', skills, domains: [...new Set(skills.map(skill => domainBySkill[skill]))].sort() };
  }
  if (plan?.lookup) return { type: 'lookup', skills: [], domains: ['lookup'] };
  if (plan?.clarificationQuestion) return { type: 'clarification', skills: [], domains: ['clarification'] };
  return { type: 'write_handoff', skills: [], domains: ['write_handoff'] };
}

test('H.2 intermediate conversational battery (225 cases, structured audit records)', () => {
  assert.equal(cases.length, 225);
  const failureCategory = category => ({ academic_ml: 'ML_SEMANTICS', followup_context: 'CONTEXT',
    entity_resolution: 'ENTITY_RESOLUTION', errors_fail_closed: 'ERROR_HANDLING', write_safety: 'WRITE_SAFETY' })[category] || 'ROUTING';
  const report = cases.map(row => {
    let plan, failureReason = null;
    try { plan = routeV3(row.input, row.state, binding); }
    catch (error) { failureReason = error.message; }
    const observed = observedDisposition(plan);
    const expectedType = row.expectedDisposition || 'skills';
    const expected = { type: expectedType, skills: [...row.expectedSkills].sort() };
    const expectedDomains = [...row.expectedDomain].sort();
    const status = failureReason || observed.type !== expected.type || JSON.stringify(observed.skills) !== JSON.stringify(expected.skills)
      || JSON.stringify(observed.domains) !== JSON.stringify(expectedDomains) ? 'FAIL' : 'PASS';
    return { caseId: row.caseId, input: row.input, category: row.category, expectedDomain: row.expectedDomain,
      failureCategory: status === 'FAIL' ? failureCategory(row.category) : null,
      expectedSkills: row.expectedSkills, observedDomain: observed.domains, observedSkills: observed.skills, llmCalls: 0, totalTokens: 0, status,
      failureReason: failureReason || (status === 'FAIL' ? `expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}` : null) };
  });
  const failures = report.filter(row => row.status !== 'PASS');
  assert.equal(failures.length, 0, `H.2 failures: ${JSON.stringify(failures.map(({ caseId, input, failureCategory, expectedDomain, observedDomain, expectedSkills, observedSkills, failureReason }) =>
    ({ caseId, input, failureCategory, expectedDomain, observedDomain, expectedSkills, observedSkills, failureReason })), null, 2)}`);
});
