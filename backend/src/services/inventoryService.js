const { InventoryMovement } = require('../models');
const { toFiniteNumber } = require('../utils/numbers');

const normalizeDate = (value, field = 'occurredAt') => {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error(`${field} must be a valid date`), { statusCode: 400 });
  }
  return date;
};

const applyStockChange = async ({
  product,
  quantityDelta,
  type,
  transactionId = null,
  occurredAt,
  source = 'api',
  scenarioId = null,
  sourceEventId = null,
  session
}) => {
  if (!session) throw new Error('A MongoDB session is required for stock changes');
  const stockBefore = toFiniteNumber(product.stock, {
    field: 'Current stock', min: 0, integer: true
  });
  const delta = toFiniteNumber(quantityDelta, {
    field: 'Stock delta', integer: true
  });
  if (delta === 0) return null;
  const stockAfter = toFiniteNumber(stockBefore + delta, {
    field: 'Resulting stock', min: 0, integer: true
  });

  product.stock = stockAfter;
  await product.save({ session });
  const [movement] = await InventoryMovement.create([{
    businessId: product.businessId,
    productId: product._id,
    transactionId,
    type,
    quantityDelta: delta,
    stockBefore,
    stockAfter,
    occurredAt: normalizeDate(occurredAt),
    source,
    scenarioId,
    sourceEventId
  }], { session });
  return movement;
};

const reconstructStockAt = async (businessId, productId, date, session = null) => {
  const occurredAt = normalizeDate(date, 'date');
  const aggregate = InventoryMovement.aggregate([
    { $match: { businessId, productId, occurredAt: { $lte: occurredAt } } },
    { $group: { _id: null, stock: { $sum: '$quantityDelta' } } }
  ]);
  if (session) aggregate.session(session);
  const [result] = await aggregate;
  return result?.stock || 0;
};

module.exports = { applyStockChange, reconstructStockAt, normalizeDate };
