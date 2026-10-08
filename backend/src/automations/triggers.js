const { fail, scopeOf, isTraceId, deepFreeze } = require('./contracts');
const { isPlainObject, isTimestamp, isObjectId } = require('../agents/contracts');
const TRIGGER_TYPES = deepFreeze(['EVENT', 'SCHEDULE', 'CONDITION', 'MANUAL']);
const EVENT_TYPES = deepFreeze(['SALE_CREATED', 'PURCHASE_CREATED', 'INVENTORY_CHANGED', 'PRODUCT_CREATED', 'PAYMENT_REGISTERED', 'TRANSACTION_CANCELLED']);
const SCHEDULE_TYPES = deepFreeze(['daily_business_summary', 'daily_replenishment_check', 'credit_due_check']);
const CONDITION_TYPES = deepFreeze(['stock_below_minimum', 'recommended_qty_positive']);
const createBusinessEvent = (context, input) => {
  scopeOf(context);
  if (!isPlainObject(input) || Object.keys(input).some(key => !['eventId', 'type', 'timestamp', 'entityType', 'entityId', 'metadata'].includes(key))
    || !isTraceId(input.eventId) || !EVENT_TYPES.includes(input.type) || !isTimestamp(input.timestamp)
    || !['product', 'transaction', 'payment'].includes(input.entityType) || !isObjectId(input.entityId)) fail('ACTION_VALIDATION_FAILED');
  const metadata = input.metadata || {};
  if (!isPlainObject(metadata) || Object.keys(metadata).some(key => !['stock', 'minStockLevel', 'recommendedQty'].includes(key))
    || Object.values(metadata).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail('ACTION_VALIDATION_FAILED');
  return deepFreeze({ ...input, businessId: context.businessId, metadata: { ...metadata } });
};
const validateTrigger = (trigger, context) => {
  scopeOf(context);
  if (!isPlainObject(trigger) || Object.keys(trigger).some(key => !['eventId', 'type', 'name', 'sourceChannel', 'event'].includes(key))
    || !isTraceId(trigger.eventId) || !TRIGGER_TYPES.includes(trigger.type) || trigger.sourceChannel !== context.sourceChannel) fail('ACTION_VALIDATION_FAILED');
  if (trigger.type === 'EVENT') {
    if (trigger.event?.businessId !== context.businessId || trigger.event.eventId !== trigger.eventId) fail('ACTION_NOT_ALLOWED');
    const { businessId, ...input } = trigger.event; createBusinessEvent(context, input);
  } else if (trigger.event !== undefined || trigger.type === 'SCHEDULE' && !SCHEDULE_TYPES.includes(trigger.name)
    || trigger.type === 'CONDITION' && !CONDITION_TYPES.includes(trigger.name)
    || trigger.type === 'MANUAL' && !['assistant', 'telegram', 'dashboard'].includes(trigger.name)) fail('ACTION_VALIDATION_FAILED');
  return trigger;
};
module.exports = { TRIGGER_TYPES, EVENT_TYPES, SCHEDULE_TYPES, CONDITION_TYPES, createBusinessEvent, validateTrigger };
