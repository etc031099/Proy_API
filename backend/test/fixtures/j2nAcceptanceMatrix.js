'use strict';
const B = 'get_business_analytics', I = 'get_inventory_intelligence', F = 'get_product_forecast';
const C = 'get_customer_intelligence', S = 'get_supplier_intelligence', M = 'get_cross_sell_recommendations', H = 'get_business_health';
// Explicit expectations: this is a query matrix, not generated assertions from routing.
const grounded = [
  [[I, F, S], [
    '¿Qué productos debería reponer esta semana y por qué?', 'Prioriza mi inventario de hoy',
    'Recomienda prioridades de reposición', 'Qué debería priorizar en inventario',
    '¿Debería reponer ABA-ACE-002 y por qué?', 'Recomienda reposición para ABA-ACE-001',
    'q deberia reponer y por que', 'q productos recomiendas reponer esta semana y porq']],
  [[I, F], ['¿Qué productos deberían preocuparme según stock y demanda?', 'Prioriza el inventario según la demanda']],
  [[I, F, S], ['Qué producto conviene reponer y con qué proveedor', 'Recomienda reponer y dime con qué proveedor']],
  [[H], ['Resume el estado del negocio', 'Analiza mi negocio', 'Interpreta la salud del negocio',
    '¿Qué debería priorizar hoy en el negocio?', '¿Qué debería revisar primero en el negocio?', '¿Hay alguna señal preocupante en el negocio?']],
  [[B], ['Qué estrategia de ventas recomiendas', 'Qué debería mejorar en mis ventas',
    'Dame conclusiones de ventas', 'Interpreta la tendencia de ventas', 'Analiza mis ventas recientes']],
  [[C], ['¿Qué clientes debería intentar retener?', 'Prioriza los clientes para contactar',
    'que clientes deberia recuperar', 'clientes q deberia retener', 'Ayúdame a priorizar clientes inactivos']],
  [[S, I], ['Qué proveedor recomiendas elegir', 'Qué proveedores conviene revisar',
    'Recomienda un proveedor', 'Ayúdame a priorizar proveedores', 'Qué proveedor debería elegir']],
  [[F], ['Interpreta qué implica WAPE', 'Qué conclusiones obtienes del modelo HGB', 'Interpreta las métricas del modelo',
    'Qué implica MA28 para mis decisiones', 'Interpreta la evaluación HGB']],
  [[B, F, M, I], ['Qué promoción recomiendas lanzar', 'Qué promociones convendría revisar',
    'Recomienda una promoción para el negocio', 'Qué promoción convendría lanzar esta semana']],
  [[B, M, I], ['Qué productos nuevos recomiendas incorporar', 'Conviene incorporar productos nuevos',
    'Recomienda comprar productos nuevos']],
  [[B, I], ['Qué vende bien y tiene poco stock', 'Analiza qué vende bien con poco stock', 'Qué vende bien pero tiene poco stock']],
  [[B, I, F], ['Qué potencial ves ante un quiebre', 'Analiza el potencial comercial y el quiebre de stock']]
];
const deterministic = [
  ['stock del pan', [I]], ['¿Cuánto stock tiene ABA-ACE-002?', [I]], ['Dime mis ventas de 7 días', [B]],
  ['Pronóstico de ABA-ACE-002 para 7 días', [F]], ['Pronóstico de PAN-FRE-001 para 14 días', [F]],
  ['¿Cuáles son mis clientes de alto valor?', [C]], ['¿Qué clientes están inactivos?', [C]],
  ['¿Qué proveedores tienen pedidos pendientes?', [S]], ['Muéstrame productos con stock bajo', [I]],
  ['¿Por qué usan MA28 si evaluaron HGB?', [F]], ['¿Qué significa K-Means?', [C]], ['¿Qué significa WAPE?', [F]],
  ['¿Qué productos suelen comprarse juntos?', [M]], ['¿Cómo está el negocio?', [H]],
  ['Pronóstico de PAN-FRE-001 para 28 días', []]
];
const external = ['cuéntame un cuento', 'quien juega mañana', 'precio del bitcoin', 'qué clima hay mañana',
  'quién es el presidente del Perú', 'dame una receta de cocina', 'capital de Francia',
  'qué partidos hay esta semana', 'quién ganó ayer', 'cómo escribo un curriculum'];
const writes = ['saca 1', 'registra una compra', 'cambia stock', 'elimina producto', 'confirma'];
let next = 0;
const matrix = [
  ...grounded.flatMap(([skills, queries]) => queries.map(query => ({ id: `N-G${String(++next).padStart(2, '0')}`,
    query, kind: 'GROUNDED_LLM', skills, providerCalls: 1, schemaExpected: 'VALID', validationExpected: 'ACCEPTED', resultExpected: 'GROUNDED_SYNTHESIS' }))),
  ...deterministic.map(([query, skills], i) => ({ id: `N-D${i + 1}`, query, kind: 'DETERMINISTIC', skills,
    providerCalls: 0, schemaExpected: 'NOT_REQUESTED', validationExpected: 'NOT_REQUESTED', resultExpected: skills.length ? 'READ' : 'SAFE_REJECTION' })),
  ...external.map((query, i) => ({ id: `N-O${i + 1}`, query, kind: 'OUT_OF_DOMAIN', skills: [], providerCalls: 0,
    schemaExpected: 'NOT_REQUESTED', validationExpected: 'NOT_REQUESTED', resultExpected: 'OUT_OF_DOMAIN' })),
  ...writes.map((query, i) => ({ id: `N-W${i + 1}`, query, kind: 'WRITE_AMBIGUOUS', skills: [], providerCalls: 0,
    schemaExpected: 'NOT_REQUESTED', validationExpected: 'NOT_REQUESTED', resultExpected: 'CLARIFICATION_OR_SAFE_REJECTION' }))
];
module.exports = { matrix, B, I, F, C, S, M, H };
