const { deepFreeze } = require('./contracts');
// Code-based definitions; no scheduled/event subscriptions are activated in AUTO-R1.
const AUTOMATION_DEFINITIONS = deepFreeze([{ id: 'low_stock_internal_alerts', name: 'Alertas internas de stock bajo', enabled: false,
  trigger: { type: 'MANUAL', config: { name: 'dashboard' } }, conditions: ['has_low_stock'],
  reads: [{ agentId: 'operations', skillId: 'get_low_stock_products', args: { limit: 3 } }],
  actions: [{ agentId: 'operations', skillId: 'create_inventory_alert' }],
  riskPolicy: { allowedRiskLevels: ['READ_ONLY', 'SAFE_AUTOMATIC'], maxReadCalls: 1, maxActionCalls: 3 } }]);
module.exports = { AUTOMATION_DEFINITIONS };
