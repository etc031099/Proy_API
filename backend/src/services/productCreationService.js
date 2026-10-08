const { Product } = require('../models');
const { applyStockChange } = require('./inventoryService');

// Shared transactional core. The caller owns the session and performs validation.
// Used by normal CRUD and confirmed actions; no controller simulation/self-HTTP.
const createProductRecord = async ({ productData, initialStock, historical = null, session }) => {
  const [product] = await Product.create([{ ...productData, stock: 0 }], { session });
  if (initialStock > 0) await applyStockChange({ product, quantityDelta: initialStock, type: 'opening',
    occurredAt: historical?.createdAt, source: historical ? 'historical_import' : 'api',
    scenarioId: historical?.scenarioId || null, sourceEventId: historical ? `${historical.sourceEventId}:inventory` : null, session });
  return product;
};
module.exports = { createProductRecord };
