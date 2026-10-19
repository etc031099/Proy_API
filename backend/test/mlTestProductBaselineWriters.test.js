'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const models = require('../src/models');
const baselines = require('../src/services/mlTestProductBaselineService');
const inventory = require('../src/services/inventoryService');
const snapshots = require('../src/services/v3OperationalSnapshotService');
const external = require('../src/services/externalApiService');

test('real writeTransaction coordinates prepare before transaction, persist before stock, commit/abort and caller sessions', async t => {
  for (const outcome of ['commit', 'invalid-payment', 'commit-failure', 'caller-session']) await t.test(outcome, async t => {
    const calls = [], durableBaselines = [];
    let active = outcome === 'caller-session', staged = null;
    const session = { startTransaction() { calls.push('start'); active = true; }, inTransaction: () => active,
      async commitTransaction() { calls.push('commit'); if (outcome === 'commit-failure') throw new Error('commit failed');
        active = false; if (staged) durableBaselines.push(staged); },
      async abortTransaction() { calls.push('abort'); staged = null; active = false; }, async endSession() { calls.push('end'); } };
    const product = { _id: new mongoose.Types.ObjectId(), sku: 'A', name: 'A', stock: 10, price: 2, currency: 'PEN' };
    const plan = { synthetic: true };
    t.mock.method(mongoose, 'startSession', async () => session);
    t.mock.method(models.Product, 'findOne', () => ({ session: async () => product }));
    t.mock.method(baselines, 'prepareSale', async request => { calls.push('prepare');
      assert.equal(request.input.products[0].productId, product._id); assert.equal(product.stock, 10); return plan; });
    t.mock.method(baselines, 'persist', async input => { calls.push('persist'); assert.equal(input.plan, plan);
      assert.equal(input.session, session); assert(active); assert.equal(product.stock, 10); staged = { stock: 10 }; });
    t.mock.method(inventory, 'applyStockChange', async input => { calls.push('stock'); assert.equal(input.session, session); product.stock--; });
    t.mock.method(models.Transaction, 'create', async (values, options) => { calls.push('sale'); assert.equal(options.session, session); return values; });
    t.mock.method(snapshots, 'recordV3Transaction', async options => { calls.push('journal'); assert.equal(options.session, session); });
    t.mock.method(external, 'getExchangeRate', async () => ({ rate: 1 }));
    t.mock.method(external, 'validatePaymentMethod', async () => ({ valid: outcome !== 'invalid-payment', supported: true, message: 'invalid' }));
    delete require.cache[require.resolve('../src/services/transactionWriteService')];
    const writer = require('../src/services/transactionWriteService');
    const invocation = () => writer.writeTransaction({ businessId: 'ordinary-offline-fixture',
      ...(outcome === 'caller-session' ? { session } : {}), input: { type: 'sale', paymentMethod: 'cash', currency: 'PEN',
        products: [{ productId: product._id, quantity: 1 }] } });
    if (['invalid-payment', 'commit-failure'].includes(outcome)) {
      await assert.rejects(invocation()); assert.equal(durableBaselines.length, 0); assert(calls.includes('abort'));
    } else {
      await invocation();
      if (outcome === 'caller-session') { assert(!calls.includes('commit')); assert(!calls.includes('end'));
        assert.equal(durableBaselines.length, 0); await session.commitTransaction(); }
      assert.equal(durableBaselines.length, 1); assert.equal(durableBaselines[0].stock, 10);
    }
    assert(calls.indexOf('prepare') < calls.indexOf('persist'));
    assert(calls.indexOf('persist') < calls.indexOf('stock'));
    if (outcome !== 'caller-session') assert(calls.indexOf('prepare') < calls.indexOf('start'));
  });
});

test('real cancellation handler persists prepared baseline before reversal and leaves commit ownership unchanged', async t => {
  const calls = [], session = { startTransaction() {}, inTransaction: () => true, async abortTransaction() {},
    async commitTransaction() { calls.push('commit'); }, async endSession() {} };
  const product = { _id: new mongoose.Types.ObjectId(), sku: 'A', name: 'A', stock: 7 };
  const sale = { _id: new mongoose.Types.ObjectId(), businessId: 'ordinary-offline-fixture', type: 'sale', status: 'completed',
    createdAt: new Date('2026-10-01'), date: new Date('2026-10-01'), products: [{ productId: product._id, quantity: 3 }],
    async save({ session: actual }) { assert.equal(actual, session); } };
  const plan = {};
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(models.Transaction, 'findOne', () => ({ session: async () => sale }));
  t.mock.method(models.Product, 'findOne', () => ({ session: async () => product }));
  t.mock.method(baselines, 'prepareCancellation', async () => { calls.push('prepare'); assert.equal(product.stock, 7); return plan; });
  t.mock.method(baselines, 'persist', async input => { calls.push('persist'); assert.equal(input.plan, plan); assert.equal(input.session, session); assert.equal(product.stock, 7); });
  t.mock.method(inventory, 'applyStockChange', async () => { calls.push('reverse'); product.stock = 10; });
  t.mock.method(snapshots, 'recordV3Transaction', async () => {});
  delete require.cache[require.resolve('../src/controllers/transactionController')];
  const controller = require('../src/controllers/transactionController');
  const result = await new Promise((resolve, reject) => controller.updateTransactionStatus({ businessId: sale.businessId,
    params: { id: sale._id }, body: { status: 'cancelled' } }, { json: resolve }, reject));
  assert.equal(result.success, true); assert.deepEqual(calls, ['prepare', 'persist', 'reverse', 'commit']);
});
