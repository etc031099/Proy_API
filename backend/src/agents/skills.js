const { AgentError, deepFreeze, isPlainObject, validateSkillArgs, assertAgentRequestContext } = require('./contracts');
const { getAgentDefinition } = require('./definitions');
const { skillTimeoutMs } = require('./timeouts');

const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const id = { ...text(24), format: 'object-id' };
const date = { ...text(10), format: 'date' };
const limit = maximum => ({ type: 'integer', minimum: 1, maximum });
const schema = (properties = {}, required = [], oneOf) => ({
  type: 'object', additionalProperties: false, properties, required,
  ...(oneOf ? { oneOf: oneOf.map(key => ({ required: [key] })) } : {})
});
const period = { startDate: date, endDate: date };
const product = { productId: id, sku: text(100) };
const both = ['operations', 'analyst'];
const READY_SKILL_IDS = Object.freeze([
  'search_products', 'get_product_details', 'get_low_stock_products', 'get_recent_transactions',
  'get_sales_summary', 'get_top_selling_products', 'get_business_summary',
  'get_demand_forecast', 'get_replenishment_candidates', 'get_product_sales_summary', 'analyze_demand_forecast',
  'get_replenishment_cost', 'plan_replenishment_budget', 'compare_supplier_costs', 'get_supplier_products', 'list_stock_alert_rules',
  'list_inventory_alerts'
]);
const entry = (skillId, description, allowedAgents, inputSchema, maxRecords, dataSensitivity, outputDescription) => ({
  id: skillId, version: '1.0.0', description, readOnly: true, allowedAgents, inputSchema,
  outputSchema: {
    type: 'object', description: outputDescription,
    fields: { data: 'Projected records or summary', metadata: 'Period/asOf, currency when applicable, returnedCount, totalMatches and truncated' }
  },
  maxRecords, timeoutMs: skillTimeoutMs(skillId),
  dataSensitivity, executorStatus: READY_SKILL_IDS.includes(skillId) ? 'READY' : 'PENDING_IMPLEMENTATION'
});

const SKILLS = deepFreeze([
  entry('list_stock_alert_rules', 'Consultó reglas de alerta de stock configuradas.', ['operations'],
    schema({ sku: text(100), limit: limit(20) }), 20, 'OPERATIONAL', 'Active configured rules with product SKU/name, operator and threshold; excludes alert events and internal IDs'),
  entry('list_inventory_alerts', 'Consultó alertas de inventario generadas.', ['operations'],
    schema({ sku: text(100), status: { type: 'string', enum: ['OPEN', 'RESOLVED'] },
      source: { type: 'string', enum: ['stock_alert_rule'] }, limit: limit(20) }),
    20, 'OPERATIONAL', 'Recent inventory alert events with tenant-scoped product labels and stored stock-rule evidence; excludes internal IDs'),
  entry('analyze_demand_forecast', 'Analiza el batch histórico: demanda, stock, readiness, comparación y resumen.', ['analyst'],
    schema({ mode: { type: 'string', enum: ['top', 'exceeding_stock', 'not_ready', 'compare', 'summary'] },
      limit: limit(20), offset: { type: 'integer', minimum: 0, maximum: 60 }, department: text(50),
      category: text(50), first: text(100), second: text(100) }, ['mode']),
    20, 'OPERATIONAL', 'Bounded forecast DTOs, historical anchor, model, scenario and deterministic totals; comparison references resolve only within tenant batch'),
  entry('search_products', 'Busca productos activos por texto.', both,
    schema({ query: text(100), category: text(50), limit: limit(20) }, ['query']), 20, 'OPERATIONAL', 'Product identity and category matches'),
  entry('get_product_details', 'Consulta un producto por ID o SKU.', both,
    schema({ ...product, productIds: text(125) }, [], ['productId', 'sku', 'productIds']), 5, 'OPERATIONAL', 'Product identity, stock, minimum, price and currency; bounded list lookup accepts at most five comma-separated ObjectIds'),
  entry('get_low_stock_products', 'Consulta productos bajo su stock mínimo.', both,
    schema({ limit: limit(20), offset: { type: 'integer', minimum: 0, maximum: 40 } }), 20, 'OPERATIONAL', 'Product identity, stock and minimum stock'),
  entry('get_inventory_summary', 'Obtiene un resumen acotado del inventario.', both,
    schema({ category: text(50) }), 1, 'FINANCIAL', 'Active product counts and explicitly labelled inventory valuation'),
  entry('get_recent_transactions', 'Consulta transacciones recientes con filtros explícitos.', ['operations'],
    schema({ ...period, type: { ...text(8), enum: ['sale', 'purchase'] },
      status: { ...text(9), enum: ['completed', 'pending', 'cancelled'] }, limit: limit(20) }), 20, 'FINANCIAL', 'Transaction identity, type, date, status, amount and currency'),
  entry('get_sales_summary', 'Resume ventas completadas en un periodo.', both,
    schema(period, ['startDate', 'endDate']), 1, 'FINANCIAL', 'Completed sales count and units; amountsByCurrency in native transaction currencies, inclusive UTC period'),
  entry('get_purchase_summary', 'Resume compras completadas en un periodo.', both,
    schema(period, ['startDate', 'endDate']), 1, 'FINANCIAL', 'Completed purchase amount, currency and transaction count'),
  entry('get_business_summary', 'Obtiene agregados del negocio con periodo explícito.', ['analyst'],
    schema({ period: { ...text(7), enum: ['current', 'latest'] } }), 1, 'FINANCIAL', 'Current active/low-stock counts and completed monthly sales/purchases, native currencies kept separate; no profit or inventory valuation'),
  entry('get_supplier_details', 'Consulta un proveedor o el proveedor configurado de un producto.', ['operations'],
    schema({ supplierId: id, productId: id }, [], ['supplierId', 'productId']), 1, 'CONTACT_REFERENCE', 'Supplier identity and verified relationship; excludes personal contact data'),
  entry('get_supplier_products', 'Consulta productos con ofertas configuradas para un proveedor activo.', ['operations'],
    schema({ supplierRef: text(100), productRef: text(100), limit: limit(5), offset: { type: 'integer', minimum: 0, maximum: 10000 } }, ['supplierRef']),
    5, 'FINANCIAL', 'Tenant-scoped supplier offer list with configured prices, active state and bounded pagination'),
  entry('get_top_selling_products', 'Clasifica productos por unidades vendidas completadas.', ['analyst'],
    schema({ ...period, limit: limit(10) }), 10, 'OPERATIONAL', 'Product identity and completed units sold, descending; optional date range, otherwise all completed history'),
  entry('get_product_sales_summary', 'Resume ventas completadas de un producto.', both,
    schema({ ...product, ...period }, ['startDate', 'endDate'], ['productId', 'sku']), 1, 'FINANCIAL', 'Product units sold and amount with period and currency'),
  entry('get_demand_forecast', 'Consulta el forecast histórico existente sin modificarlo.', ['analyst'],
    schema({ productId: id }), 60, 'OPERATIONAL', 'ML readiness, model metadata, anchor and existing forecast/recommendation values'),
  entry('get_replenishment_candidates', 'Selecciona candidatos desde la recomendación existente.', ['analyst'],
    schema({ limit: limit(20) }), 20, 'OPERATIONAL', 'READY candidates ordered by existing recommendedQty with historical anchor'),
  entry('get_replenishment_cost', 'Calcula el costo configurado para reposición recomendada.', ['analyst'],
    schema({ mode: { type: 'string', enum: ['single', 'total'] }, productRef: text(100), supplierRef: text(100),
      department: text(50), limit: limit(20), offset: { type: 'integer', minimum: 0, maximum: 60 } }, ['mode']),
    20, 'FINANCIAL', 'Read-only replenishment cost using valid tenant supplier offers; PEN only'),
  entry('plan_replenishment_budget', 'Propone una compra parcial priorizada dentro de un presupuesto.', ['analyst'],
    schema({ budget: { type: 'number', minimum: Number.MIN_VALUE, maximum: 1000000000 }, currency: { ...text(3), enum: ['PEN'] },
      department: text(50), limit: limit(20), offset: { type: 'integer', minimum: 0, maximum: 60 } }, ['budget', 'currency']),
    20, 'FINANCIAL', 'Deterministic greedy budget proposal, historical forecast anchor and current configured prices'),
  entry('compare_supplier_costs', 'Compara ofertas configuradas para un producto.', ['analyst'],
    schema({ productRef: text(100), productRefs: text(504), supplierRef: text(100) }, [], ['productRef', 'productRefs']),
    10, 'FINANCIAL', 'Tenant-scoped active vendor offers and deterministic selected supplier; bounded product-list comparison')
]);

const getSkillDefinition = skillId => {
  const skill = SKILLS.find(entry => entry.id === skillId);
  if (!skill) throw new AgentError('AGENT_SKILL_NOT_FOUND');
  return skill;
};

const validateSkillInvocation = invocation => {
  if (!isPlainObject(invocation) || Reflect.ownKeys(invocation).some(key => !['agentId', 'skillId', 'args', 'context'].includes(key))) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  const { agentId, skillId, args = {}, context } = invocation;
  assertAgentRequestContext(context);
  const agent = getAgentDefinition(agentId);
  const skill = getSkillDefinition(skillId);
  if (!agent.allowedSkills.includes(skillId) || !skill.allowedAgents.includes(agentId) || !skill.readOnly) {
    throw new AgentError('AGENT_SKILL_NOT_ALLOWED');
  }
  return Object.freeze({ agent, skill, args: validateSkillArgs(skill.inputSchema, args), context });
};

module.exports = { SKILLS, READY_SKILL_IDS, getSkillDefinition, validateSkillInvocation };
