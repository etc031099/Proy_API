const { AgentError, TOKEN_BUDGETS, EXECUTION_LIMITS, deepFreeze } = require('./contracts');

const AGENTS = deepFreeze([
  {
    id: 'coordinator', version: '1.0.0', displayName: 'Coordinador de consultas',
    description: 'Interpreta la solicitud y delega al especialista adecuado.',
    responsibilities: ['Interpretar intención', 'Pedir aclaraciones', 'Delegar tareas'],
    allowedSkills: [], allowedActionSkills: [],
    llmPolicy: { preferredMode: 'deterministic-first', providerEnabled: true },
    limits: { ...TOKEN_BUDGETS.coordinator, maxSkillCalls: 0, maxLlmCalls: EXECUTION_LIMITS.maxLlmCalls }
  },
  {
    id: 'operations', version: '1.0.0', displayName: 'Especialista de operaciones',
    allowedActionSkills: ['create_product', 'create_sale', 'create_purchase', 'create_inventory_alert', 'create_stock_alert_rule'],
    description: 'Consulta hechos del catálogo, inventario y operaciones comerciales.',
    responsibilities: ['Productos e inventario', 'Proveedores', 'Transacciones', 'Ventas y compras factuales'],
    allowedSkills: ['search_products', 'get_product_details', 'get_low_stock_products', 'get_inventory_summary',
      'get_recent_transactions', 'get_sales_summary', 'get_purchase_summary', 'get_supplier_details', 'get_product_sales_summary',
      'get_supplier_products', 'list_stock_alert_rules', 'list_inventory_alerts'],
    llmPolicy: { preferredMode: 'deterministic-first', providerEnabled: true },
    limits: { ...TOKEN_BUDGETS.operations, maxSkillCalls: EXECUTION_LIMITS.maxSkillCalls, maxLlmCalls: EXECUTION_LIMITS.maxLlmCalls }
  },
  {
    id: 'analyst', version: '1.0.0', displayName: 'Analista de negocio y demanda',
    allowedActionSkills: [],
    description: 'Interpreta agregados, rankings y resultados estructurados del forecast existente.',
    responsibilities: ['Agregados y resumen del negocio', 'Rankings', 'Forecast y reposición', 'Interpretación de resultados'],
    allowedSkills: ['search_products', 'get_product_details', 'get_low_stock_products', 'get_inventory_summary',
      'get_sales_summary', 'get_purchase_summary', 'get_business_summary', 'get_top_selling_products',
      'get_product_sales_summary', 'get_demand_forecast', 'get_replenishment_candidates', 'analyze_demand_forecast',
      'get_replenishment_cost', 'plan_replenishment_budget', 'compare_supplier_costs'],
    llmPolicy: { preferredMode: 'hybrid', providerEnabled: true },
    limits: { ...TOKEN_BUDGETS.analyst, maxSkillCalls: EXECUTION_LIMITS.maxSkillCalls, maxLlmCalls: EXECUTION_LIMITS.maxLlmCalls }
  }
]);

const getAgentDefinition = id => {
  const agent = AGENTS.find(entry => entry.id === id);
  if (!agent) throw new AgentError('AGENT_INVALID_REQUEST');
  return agent;
};

module.exports = { AGENTS, getAgentDefinition };
