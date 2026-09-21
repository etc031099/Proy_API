const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { InventoryMovement } = require('../src/models');

const validMovement = (overrides = {}) => new InventoryMovement({
  businessId: 'unit-tenant',
  productId: new mongoose.Types.ObjectId(),
  type: 'opening',
  quantityDelta: 5,
  stockBefore: 0,
  stockAfter: 5,
  source: 'api',
  ...overrides
});

test('InventoryMovement accepts a valid safe-integer stock equation', async () => {
  await validMovement().validate();
});

test('InventoryMovement rejects a broken stock equation', async () => {
  await assert.rejects(validMovement({ stockAfter: 6 }).validate(), /stockAfter/);
});

test('InventoryMovement rejects zero and non-integer deltas', async () => {
  await assert.rejects(validMovement({ quantityDelta: 0, stockAfter: 0 }).validate(), /Zero-quantity/);
  await assert.rejects(validMovement({ quantityDelta: 1.5, stockAfter: 1.5 }).validate(), /safe integers/);
});

test('InventoryMovement rejects negative resulting stock', async () => {
  await assert.rejects(
    validMovement({ type: 'sale', quantityDelta: -2, stockBefore: 1, stockAfter: -1 }).validate(),
    /stockAfter/
  );
});
