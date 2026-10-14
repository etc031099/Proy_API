const { Product } = require('../models');
const { applyStockChange } = require('./inventoryService');
const { recordV3ProductChange } = require('./v3OperationalSnapshotService');

// Shared transactional core. The caller owns the session and performs validation.
// Used by normal CRUD and confirmed actions; no controller simulation/self-HTTP.
const createProductRecord = async ({ productData, initialStock, historical = null, session }) => {
  const [product] = await Product.create([{ ...productData, stock: 0 }], { session });
  const movement = initialStock > 0 ? await applyStockChange({ product, quantityDelta: initialStock, type: 'opening',
    occurredAt: historical?.createdAt, source: historical ? 'historical_import' : 'api',
    scenarioId: historical?.scenarioId || null, sourceEventId: historical ? `${historical.sourceEventId}:inventory` : null, session }) : null;
  if (!historical) await recordV3ProductChange({ businessId: product.businessId, session, after: product, operation: 'CREATE',
    extraChanges: movement ? [{ entityType: 'movement', entityKey: String(movement._id), operation: 'ADJUST',
      projection: { type: 'opening', productId: String(product._id), quantityDelta: movement.quantityDelta } }] : [] });
  return product;
};
module.exports = { createProductRecord };
