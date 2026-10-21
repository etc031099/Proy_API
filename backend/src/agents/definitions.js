const { AgentError, TOKEN_BUDGETS, EXECUTION_LIMITS, deepFreeze } = require('./contracts');
const { V3_IDS, V3_SKILLS } = require('./v3Skills');
const { SPECIALIST_IDS } = require('./identity');

const SPECIALIST_CONTRACTS = {
  sales: { displayName: 'Ventas', role: 'Consulta de ventas, transacciones y anomalías.', families: ['sales', 'transactions', 'sales_anomalies'] },
  inventory: { displayName: 'Inventario', role: 'Consulta de stock, riesgo, reposición e historial operacional.', families: ['inventory', 'stock', 'replenishment', 'operational_history'] },
  forecast: { displayName: 'Pronóstico', role: 'Consulta Ridge LIVE aprobado 7d/14d, modelos activos y disponibilidad.', families: ['ridge_live', 'forecast_status'] },
  customers: { displayName: 'Clientes', role: 'Consulta RFM, clustering y actividad de clientes.', families: ['customer_rfm', 'customer_clustering', 'customer_activity'] },
  procurement: { displayName: 'Compras y proveedores', role: 'Consulta proveedores, compras, recepción y desempeño de entrega.', families: ['suppliers', 'purchases', 'transactions', 'receiving', 'supplier_performance'] },
  associations: { displayName: 'Productos relacionados', role: 'Consulta FP-Growth y recomendaciones de cross-sell.', families: ['fp_growth', 'cross_sell'] }
};
const ALL_SKILL_FAMILIES = Object.freeze([...new Set([
  ...Object.values(SPECIALIST_CONTRACTS).flatMap(item => item.families), 'business_summary', 'product_catalog',
  'forecast_evaluation', 'operational_alerts', 'operational_writes', 'destructive_ml'
])]);
const OPERATIONS_FAMILIES = Object.freeze(['sales', 'transactions', 'inventory', 'stock', 'operational_history',
  'suppliers', 'product_catalog', 'operational_alerts', 'operational_writes']);
const ANALYST_FAMILIES = Object.freeze(ALL_SKILL_FAMILIES.filter(family => !['operational_writes', 'destructive_ml'].includes(family)));
const plannedSpecialists = SPECIALIST_IDS.map(id => {
  const contract = SPECIALIST_CONTRACTS[id];
  const active = ['inventory', 'forecast', 'sales', 'customers', 'procurement', 'associations'].includes(id);
  return {
    id, version: '1.0.0', status: active ? 'ACTIVE' : 'PLANNED', displayName: contract.displayName, role: contract.role,
    description: contract.role, responsibilities: [contract.role], capabilities: { readOnly: true, canRead: true, canWrite: false },
    allowedSkillFamilies: contract.families,
    prohibitedSkillFamilies: ALL_SKILL_FAMILIES.filter(family => !contract.families.includes(family)),
    // Implemented specialists use existing READ executors; never action tools.
    allowedSkills: id === 'inventory' ? ['get_inventory_intelligence'] : id === 'forecast' ? ['get_product_forecast']
      : id === 'customers' ? ['get_customer_intelligence'] : id === 'sales'
        ? ['get_business_analytics', 'get_recent_transactions', 'get_sales_summary', 'get_product_sales_summary', 'get_top_selling_products']
        : id === 'procurement' ? ['get_supplier_intelligence', 'get_recent_transactions']
          : id === 'associations' ? ['get_cross_sell_recommendations'] : [],
    allowedActionSkills: [], llmPolicy: { preferredMode: 'deterministic-first', providerEnabled: false },
    limits: { maxInputTokens: 0, responseTargetTokens: 0, providerMaxOutputTokens: 0, maxSkillCalls: active ? EXECUTION_LIMITS.maxSkillCalls : 0, maxLlmCalls: 0 }
  };
});

const AGENTS = deepFreeze([
  {
    id: 'coordinator', version: '1.0.0', status: 'ACTIVE', displayName: 'Coordinador', role: 'Agente Orquestador: entiende intención, resuelve entidades y delega consultas con evidencia.',
    description: 'Interpreta la solicitud y delega al especialista adecuado.',
    responsibilities: ['Interpretar intención', 'Resolver ambigüedad', 'Preservar intención y contexto', 'Delegar al especialista autorizado', 'Combinar evidencia coherente'],
    capabilities: { readOnly: true, canRead: false, canWrite: false },
    allowedSkillFamilies: [], prohibitedSkillFamilies: ALL_SKILL_FAMILIES,
    allowedSkills: [], allowedActionSkills: [],
    llmPolicy: { preferredMode: 'deterministic-first', providerEnabled: true },
    limits: { ...TOKEN_BUDGETS.coordinator, maxSkillCalls: 0, maxLlmCalls: EXECUTION_LIMITS.maxLlmCalls }
  },
  {
    id: 'operations', version: '1.0.0', status: 'ACTIVE', displayName: 'Operaciones', role: 'Consulta y ejecuta operaciones mediante el gateway autorizado.',
    allowedActionSkills: ['create_product', 'create_sale', 'create_purchase', 'create_inventory_alert', 'create_stock_alert_rule'],
    description: 'Consulta hechos del catálogo, inventario y operaciones comerciales.',
    responsibilities: ['Productos e inventario', 'Proveedores', 'Transacciones', 'Ventas y compras factuales'],
    capabilities: { readOnly: false, canRead: true, canWrite: true, writesVia: 'operations_action_gateway' },
    allowedSkillFamilies: OPERATIONS_FAMILIES,
    prohibitedSkillFamilies: ALL_SKILL_FAMILIES.filter(family => !OPERATIONS_FAMILIES.includes(family)),
    allowedSkills: [...V3_IDS.filter(id => V3_SKILLS[id].agents.includes('operations')), 'search_products', 'get_product_details', 'get_low_stock_products',
      'get_recent_transactions', 'get_sales_summary', 'get_product_sales_summary',
      'get_supplier_products', 'list_stock_alert_rules', 'list_inventory_alerts', 'list_inventory_alert_outbox_events', 'list_inventory_alert_channel_deliveries'],
    llmPolicy: { preferredMode: 'deterministic-first', providerEnabled: true },
    limits: { ...TOKEN_BUDGETS.operations, maxSkillCalls: EXECUTION_LIMITS.maxSkillCalls, maxLlmCalls: EXECUTION_LIMITS.maxLlmCalls }
  },
  {
    id: 'analyst', version: '1.0.0', status: 'LEGACY_ACTIVE', displayName: 'Analista (compatibilidad)', role: 'Síntesis narrativa con evidencia, salud global y compatibilidad histórica.',
    allowedActionSkills: [],
    description: 'Interpreta agregados, rankings y resultados estructurados del forecast existente.',
    responsibilities: ['Agregados y resumen del negocio', 'Rankings', 'Forecast y reposición', 'Interpretación de resultados'],
    capabilities: { readOnly: true, canRead: true, canWrite: false },
    allowedSkillFamilies: ANALYST_FAMILIES,
    prohibitedSkillFamilies: ['operational_writes', 'destructive_ml'],
    allowedSkills: [...V3_IDS.filter(id => V3_SKILLS[id].agents.includes('analyst')), 'search_products', 'get_product_details', 'get_low_stock_products',
      'get_sales_summary', 'get_business_summary', 'get_top_selling_products',
      'get_product_sales_summary', 'get_demand_forecast', 'get_replenishment_candidates', 'analyze_demand_forecast',
      'get_replenishment_cost', 'plan_replenishment_budget', 'compare_supplier_costs'],
    llmPolicy: { preferredMode: 'hybrid', providerEnabled: true },
    limits: { ...TOKEN_BUDGETS.analyst, maxSkillCalls: EXECUTION_LIMITS.maxSkillCalls, maxLlmCalls: EXECUTION_LIMITS.maxLlmCalls }
  },
  ...plannedSpecialists
]);

const getAgentDefinition = id => {
  const agent = AGENTS.find(entry => entry.id === id);
  if (!agent) throw new AgentError('AGENT_INVALID_REQUEST');
  return agent;
};

module.exports = { AGENTS, getAgentDefinition };
