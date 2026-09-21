#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const { Product, InventoryMovement } = require('../src/models');
const { applyStockChange } = require('../src/services/inventoryService');

const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, '').split('=');
  return [key, value.join('=') || true];
}));

const main = async () => {
  const businessId = args['business-id'];
  if (!businessId || args.confirm !== true) {
    throw new Error('Usage: --business-id=TENANT --confirm');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  let created = 0;
  for await (const product of Product.find({ businessId, stock: { $gt: 0 } })) {
    if (await InventoryMovement.exists({ businessId, productId: product._id })) continue;
    const currentStock = product.stock;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      product.stock = 0;
      await product.save({ session });
      await applyStockChange({
        product,
        quantityDelta: currentStock,
        type: 'opening',
        occurredAt: product.createdAt,
        source: 'backfill',
        sourceEventId: `backfill:${product._id}`,
        session
      });
      await session.commitTransaction();
      created += 1;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }
  console.log(JSON.stringify({ businessId, created }, null, 2));
};

main()
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
