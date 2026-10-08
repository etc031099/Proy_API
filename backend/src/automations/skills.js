const { schema, string, objectId, number, integer, validateArgs, assertContext, fail, deepFreeze } = require('./contracts');
const currency = { ...string(3), enum: ['PEN', 'USD', 'EUR'] };
const productFields = { name: string(100), sku: string(100), price: number(), currency, stock: integer(1000000),
  minStockLevel: integer(1000000), category: string(50), costPrice: number(), description: string(500),
  supplierPrices: { type: 'array', maxItems: 5, items: schema({ supplierId: objectId, purchasePrice: number() }) } };
const transaction = schema({ products: { type: 'array', maxItems: 20, items: schema({ productId: objectId, quantity: { ...integer(1000000), minimum: 1 } }) },
  currency, customerId: objectId, vendorId: objectId, notes: string(500),
  paymentMethod: { ...string(20), enum: ['cash', 'credit', 'bank_transfer', 'card', 'crypto', 'bitcoin', 'tether', 'wallet', 'other'] } }, ['products', 'currency']);
const entry = (id, description, inputSchema, automatic = false, status = 'PENDING_IMPLEMENTATION') => ({
  id, version: '1.0.0', description, allowedAgents: ['operations'], readOnly: false,
  riskLevel: automatic ? 'SAFE_AUTOMATIC' : 'REQUIRES_CONFIRMATION', requiresConfirmation: !automatic,
  inputSchema, outputContract: 'Identificador y resumen seguro del resultado; sin documentos completos.',
  timeoutMs: 10000, sensitivity: 'OPERATIONAL', idempotent: true,
  idempotencyStrategy: 'scoped sourceChannel + externalRequestId; pendingActionId + atomic Mongo commit', auditRequired: true, status
});
// Separate write registry: existing read skills and Gemini declarations remain read-only.
const ACTION_SKILLS = deepFreeze([
  entry('create_product', 'Crea un producto tras confirmación.', schema(productFields, ['name', 'sku', 'price', 'currency', 'stock', 'minStockLevel', 'category']), false, 'READY'),
  entry('update_product', 'Modifica campos de un producto.', schema({ productId: objectId, fields: schema(productFields, []) })),
  entry('create_customer', 'Crea un cliente.', schema({ name: string(100) })),
  entry('create_supplier', 'Crea un proveedor.', schema({ name: string(100) })),
  entry('create_sale', 'Registra una venta con precios canónicos, stock y pago validados.', transaction, false, 'READY'),
  entry('create_purchase', 'Registra una compra con proveedor y costo configurado.', transaction, false, 'READY'),
  entry('cancel_transaction', 'Cancela una transacción validada.', schema({ transactionId: objectId })),
  entry('register_credit_payment', 'Registra un pago de crédito.', schema({ customerId: objectId, amount: { ...number(), minimum: 0.01 }, currency,
    paymentMethod: { ...string(20), enum: ['cash', 'card', 'bank_transfer', 'wallet'] } })),
  entry('create_inventory_adjustment', 'Ajusta inventario con motivo explícito.', schema({ productId: objectId, stock: integer(1000000), reason: string(200) })),
  entry('create_purchase_proposal', 'Prepara una propuesta de compra, no una compra.', schema({ products: transaction.properties.products, currency })),
  entry('approve_purchase_proposal', 'Aprueba una propuesta verificada.', schema({ proposalId: objectId })),
  entry('reject_purchase_proposal', 'Rechaza una propuesta.', schema({ proposalId: objectId })),
  entry('create_inventory_alert', 'Registra una alerta interna sin notificaciones externas.', schema({
    type: { ...string(30), enum: ['LOW_STOCK', 'REPLENISHMENT_REQUIRED', 'TRANSACTION_ANOMALY'] }, productId: objectId,
    label: string(160) }, ['type', 'label']), true, 'READY'),
  entry('send_notification', 'Envía una notificación a un destino previamente configurado.', schema({ label: string(160) }), true)
]);
const getActionSkill = id => { const skill = ACTION_SKILLS.find(row => row.id === id); if (!skill) fail('ACTION_NOT_ALLOWED'); return skill; };
const validateActionInvocation = ({ agentId, skillId, args, context }) => {
  assertContext(context); const skill = getActionSkill(skillId);
  if (agentId !== 'operations' || !require('../agents/definitions').getAgentDefinition(agentId).allowedActionSkills.includes(skillId)
    || !skill.allowedAgents.includes(agentId) || skill.status !== 'READY'
    || skill.riskLevel === 'RESTRICTED') fail('ACTION_NOT_ALLOWED');
  return { skill, args: validateArgs(skill.inputSchema, args) };
};
const getActionDeclarations = agentId => ACTION_SKILLS.filter(skill => skill.status === 'READY' && skill.allowedAgents.includes(agentId)
  && require('../agents/definitions').getAgentDefinition(agentId).allowedActionSkills.includes(skill.id))
  .map(skill => ({ name: skill.id, description: skill.description, parametersJsonSchema: skill.inputSchema }));
module.exports = { ACTION_SKILLS, getActionSkill, validateActionInvocation, getActionDeclarations };
