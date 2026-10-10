const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const InventoryAlert = require('../src/models/InventoryAlert');
const StockAlertRule = require('../src/models/StockAlertRule');
const { createStockAlertRuleEvaluator, conditionMatches } = require('../src/services/stockAlertRuleEvaluator');
const session = { inTransaction: () => true };
const fixture = (operators = [['<=', 3]]) => {
  const events = new Map(), reads = [], writes = [];
  const activeRules = operators.map(([operator, threshold], i) => ({ _id: `rule-${i}`, operator, threshold }));
  const rules = { find(filter) {
    reads.push(filter);
    return { select() { return this; }, session(given) { assert.equal(given, session); return this; },
      lean() { return this; }, maxTimeMS() { return this; }, exec: async () => activeRules };
  } };
  const alerts = { updateOne(filter, update, options) {
    assert.equal(options.session, session); assert.equal(options.upsert, true);
    writes.push(filter); return { exec: async () => {
      const key = `${filter.businessId}:${filter.ruleId}:${filter.inventoryMovementId}`;
      if (!events.has(key)) events.set(key, structuredClone(update.$setOnInsert));
    } };
  }, updateMany(filter, update, options) {
    assert.equal(options.session, session); writes.push(filter);
    return { exec: async () => {
      for (const row of events.values()) if (Object.entries(filter).every(([k, v]) => row[k] === v)) Object.assign(row, update.$set);
    } };
  } };
  const evaluate = createStockAlertRuleEvaluator({ rules, alerts });
  return { events, reads, writes, run: (before, after, movement = 'movement-1') => evaluate({
    businessId: 'A', productId: 'product-1', previousStock: before, newStock: after,
    inventoryMovementId: movement, session
  }) };
};

test('<= crossing, continued low stock, recovery and new crossing form distinct event cycles', async () => {
  const f = fixture();
  await f.run(4, 3); assert.equal(f.events.size, 1);
  await f.run(3, 2, 'movement-2'); assert.equal(f.events.size, 1);
  await f.run(2, 5, 'movement-3'); assert.equal([...f.events.values()][0].status, 'RESOLVED');
  await f.run(5, 3, 'movement-4'); assert.equal(f.events.size, 2);
  assert.equal([...f.events.values()][1].status, 'OPEN');
  assert.ok(f.reads.every(filter => filter.businessId === 'A' && filter.productId === 'product-1' && filter.enabled));
});
test('< crossing includes equal-to-threshold as the previous state, but not as the new state', async () => {
  const f = fixture([['<', 3]]);
  await f.run(4, 3); assert.equal(f.events.size, 0);
  await f.run(3, 2, 'movement-2'); assert.equal(f.events.size, 1);
  await f.run(2, 1, 'movement-3'); assert.equal(f.events.size, 1);
});
test('two different rules crossed by the same movement generate separate condition snapshots', async () => {
  const f = fixture([['<=', 3], ['<', 1]]); await f.run(4, 0);
  assert.equal(f.events.size, 2);
  assert.deepEqual([...f.events.values()].map(r => r.condition), [{ operator: '<=', threshold: 3 }, { operator: '<', threshold: 1 }]);
  assert.ok([...f.events.values()].every(r => r.inventoryMovementId === 'movement-1' && r.previousStock === 4 && r.newStock === 0));
});
test('repeated crossing evaluation never duplicates or reopens an already resolved event', async () => {
  const f = fixture(); await f.run(4, 3); await f.run(4, 3); assert.equal(f.events.size, 1);
  await f.run(3, 5, 'recovery'); await f.run(4, 3);
  assert.equal(f.events.size, 1); assert.equal([...f.events.values()][0].status, 'RESOLVED');
});
test('recovery scopes strictly by tenant, product, source and rule', async () => {
  const f = fixture(); await f.run(4, 3);
  for (const [key, fields] of [['legacy', { source: 'automatic' }], ['foreign', { businessId: 'B' }],
    ['other-rule', { ruleId: 'other' }], ['other-product', { productId: 'other' }]]) {
    f.events.set(key, { ...[...f.events.values()][0], ...fields });
  }
  await f.run(3, 5, 'recovery');
  assert.equal([...f.events.values()][0].status, 'RESOLVED');
  assert.ok(['legacy', 'foreign', 'other-rule', 'other-product'].every(key => f.events.get(key).status === 'OPEN'));
});
test('no stock change produces no evaluator reads or writes', async () => {
  const f = fixture(); await f.run(3, 3); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});
test('evaluator rejects a non-transactional or invalid stock context', async () => {
  const evaluate = createStockAlertRuleEvaluator();
  await assert.rejects(evaluate({ session: { inTransaction: () => false } }), /transactional/);
  assert.throws(() => conditionMatches('>', 3, 4), /Unsupported/);
});
test('InventoryAlert remains backward compatible and requires complete custom-rule evidence', async () => {
  const legacy = new InventoryAlert({ businessId: 'A', actionId: 'legacy', type: 'LOW_STOCK', label: 'Legacy' });
  await legacy.validate(); assert.equal(legacy.source, 'automatic');
  await assert.rejects(new InventoryAlert({ businessId: 'A', actionId: 'custom', type: 'LOW_STOCK', source: 'stock_alert_rule' }).validate(), /evidence/);
  const indexes = InventoryAlert.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.ruleId && keys.inventoryMovementId && options.unique
    && options.partialFilterExpression.source === 'stock_alert_rule'));
  assert.ok(indexes.some(([keys, options]) => keys.actionId && options.unique));
  assert.ok(StockAlertRule.schema.indexes().some(([keys]) => keys.businessId && keys.productId && keys.enabled));
  const invalid = new InventoryAlert({ businessId: 'A', actionId: 'bad', type: 'LOW_STOCK', source: 'stock_alert_rule',
    productId: new mongoose.Types.ObjectId(), ruleId: new mongoose.Types.ObjectId(), inventoryMovementId: new mongoose.Types.ObjectId(),
    condition: { operator: '<=', threshold: 1.5 }, previousStock: 4, newStock: 3 });
  await assert.rejects(invalid.validate(), /threshold/);
});
