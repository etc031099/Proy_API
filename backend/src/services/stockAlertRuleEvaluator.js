const StockAlertRule = require('../models/StockAlertRule');
const InventoryAlert = require('../models/InventoryAlert');
const { recordAlertEvent } = require('./inventoryAlertOutbox');

const conditionMatches = (operator, threshold, stock) => {
  if (operator === '<=') return stock <= threshold;
  if (operator === '<') return stock < threshold;
  throw new Error('Unsupported stock alert operator');
};

/** Internal transactional evaluator. Call only for a persisted inventory movement.
 * No network effects, PendingAction, user text or notification delivery here.
 * Repeated evaluation retains the original event (including RESOLVED status).
 */
const createStockAlertRuleEvaluator = ({ rules = StockAlertRule, alerts = InventoryAlert, recordEvent = recordAlertEvent } = {}) => async ({
  businessId, productId, previousStock, newStock, inventoryMovementId, product, session
}) => {
  if (!session?.inTransaction() || !businessId || !productId || !inventoryMovementId
    || !Number.isSafeInteger(previousStock) || previousStock < 0
    || !Number.isSafeInteger(newStock) || newStock < 0) throw new Error('Invalid transactional stock alert context');
  if (previousStock === newStock) return;
  const active = await rules.find({ businessId, productId, enabled: true })
    .select('_id operator threshold').session(session).lean().maxTimeMS(5000).exec();
  for (const rule of active) {
    const before = conditionMatches(rule.operator, rule.threshold, previousStock);
    const after = conditionMatches(rule.operator, rule.threshold, newStock);
    const scope = { businessId, productId, source: 'stock_alert_rule', ruleId: rule._id };
    if (!before && after) {
      const timestamp = new Date();
      // Stable action identity also preserves the legacy businessId/actionId index.
      const inserted = await alerts.updateOne({ ...scope, inventoryMovementId }, { $setOnInsert: {
        ...scope, inventoryMovementId, actionId: `stock-rule:${rule._id}:${inventoryMovementId}`,
        type: 'LOW_STOCK', status: 'OPEN', label: `Regla de stock: ${rule.operator} ${rule.threshold} unidades.`,
        condition: { operator: rule.operator, threshold: rule.threshold }, previousStock, newStock,
        createdAt: timestamp, updatedAt: timestamp
      } }, { upsert: true, session, runValidators: true, timestamps: false }).exec();
      if (inserted.upsertedId) await recordEvent({ alert: { _id: inserted.upsertedId, ...scope,
        condition: { operator: rule.operator, threshold: rule.threshold } }, eventType: 'inventory.alert.opened',
        previousStock, newStock, product, occurredAt: timestamp, session });
    } else if (before && !after) {
      // Resolve only events belonging to this tenant/product/rule; legacy alerts stay intact.
      const open = await alerts.find({ ...scope, status: 'OPEN' }).session(session).lean().maxTimeMS(5000).exec();
      await alerts.updateMany({ ...scope, status: 'OPEN' }, { $set: { status: 'RESOLVED' } },
        { session, runValidators: true }).exec();
      const occurredAt = new Date();
      for (const alert of open) await recordEvent({ alert, eventType: 'inventory.alert.resolved',
        previousStock, newStock, product, occurredAt, session });
    }
  }
};

const evaluateStockAlertRules = createStockAlertRuleEvaluator();
module.exports = { createStockAlertRuleEvaluator, evaluateStockAlertRules, conditionMatches };
