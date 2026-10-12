const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { readFixture, products } = require('./audit/p3bFixtures');

const now = new Date('2026-10-09T12:00:00Z');
const assertDeterministic = result => {
  assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(result.usage.totalTokens, 0);
};
const sku096 = 'M5-FOODS_2_096';

for (const [id, message] of [
  ['U-0034', 'cuánto es el stock mínimo de food 2 96'],
  ['U-0037', 'food 96 stock mínimo']
]) {
  test(`P3C.3 ${id}: explicit minimum attribute is a product detail, not low stock`, async () => {
    const plan = routeDeterministically(message, {}, now);
    assert.equal(plan.intent, 'product_details');
    assert.equal(plan.agent, 'operations');
    assert.notEqual(plan.intent, 'low_stock');

    const f = readFixture();
    const result = await f.run(message, randomUUID());
    assertDeterministic(result);
    assert.equal(result.intent, 'product_details');
    assert.ok(result.actions.some(action => action.skillId === 'get_product_details'));
    assert.ok(result.actions.every(action => ['search_products', 'get_product_details'].includes(action.skillId)));
    assert.match(result.answer, /stock mínimo.*es 5 unidades/i);
    assert.match(result.answer, new RegExp(sku096));
    assert.ok(!f.reads.some(row => row.model === 'Product' && row.pipeline?.[0]?.$match?.$expr));
  });
}

test('P3C.3 U-0432: OPEN remains an InventoryAlert status filter with product scope', async () => {
  const message = 'alertas OPEN del food 096';
  const plan = routeDeterministically(message, {}, now);
  assert.equal(plan.intent, 'inventory_alert_events');
  assert.equal(plan.selector.status, 'OPEN');
  assert.equal(plan.lookupQuery, 'food 096');

  const f = readFixture();
  const result = await f.run(message, randomUUID());
  assertDeterministic(result);
  assert.deepEqual(result.actions.map(action => action.skillId), ['search_products', 'list_inventory_alerts']);
  assert.ok(f.reads.some(row => row.model === 'InventoryAlert' && row.match?.status === 'OPEN'));
});

for (const [id, message, status] of [
  ['U-0439', 'alertas pendientes de reintento', 'PENDING'],
  ['U-0440', 'outbox de alertas', undefined]
]) {
  test(`P3C.3 ${id}: outbox language uses delivery records, not alert events`, async () => {
    const plan = routeDeterministically(message, {}, now);
    assert.equal(plan.intent, 'inventory_alert_deliveries');
    assert.equal(plan.selector.status, status);
    const f = readFixture();
    const result = await f.run(message, randomUUID());
    assertDeterministic(result);
    assert.deepEqual(result.actions.map(action => action.skillId), ['list_inventory_alert_outbox_events']);
    assert.ok(f.reads.some(row => row.model === 'InventoryAlertOutboxEvent'));
    assert.ok(!f.reads.some(row => row.model === 'InventoryAlert'));
    if (status === 'PENDING') {
      assert.match(result.answer, /pendientes de entrega o reintento|pendientes/i);
      assert.ok(f.reads.some(row => row.model === 'InventoryAlertOutboxEvent'
        && (row.match?.status === 'PENDING' || row.match?.$or?.some(branch => branch.status === 'PENDING'))));
    }
  });
}

test('P3C.3 S-076: structured product display name establishes follow-up context', async () => {
  const f = readFixture();
  const conversationId = randomUUID();
  const first = await f.run('¿Cuánto stock tiene Alimentos M5 · FOODS_2 · Ítem 096?', conversationId);
  assertDeterministic(first);
  assert.equal(first.intent, 'product_details');
  assert.equal(first.requiresClarification, false);
  assert.deepEqual(first.actions.map(action => action.skillId), ['get_product_details']);
  assert.match(first.answer, new RegExp(sku096));
  assert.ok(f.reads.some(row => row.model === 'Product' && row.match?.sku === sku096));

  const second = await f.run('¿Y el stock mínimo?', conversationId);
  assertDeterministic(second);
  assert.equal(second.intent, 'product_details');
  assert.equal(second.requiresClarification, false);
  assert.deepEqual(second.actions.map(action => action.skillId), ['get_product_details']);
  assert.match(second.answer, new RegExp(sku096));
  assert.match(second.answer, /stock mínimo.*es 5 unidades/i);
});

test('P3C.3 structured-label SKU extraction is limited to catalog display syntax', () => {
  const valid = routeDeterministically('¿Cuánto stock tiene Alimentos M5 · FOODS_2 · Ítem 096?', {}, now);
  assert.equal(valid.selector.sku, sku096);
  const unstructured = routeDeterministically('¿Cuánto stock tiene el producto 096 de alimentos?', {}, now);
  assert.notEqual(unstructured.selector?.sku, sku096);
});
