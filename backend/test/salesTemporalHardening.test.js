const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const baseline = require('../../docs/CONV-AUDIT-P3B.json');
const { readFixture, writeFixture, products } = require('./audit/p3bFixtures');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { parseAction, actionIntent } = require('../src/automations/actionInput');
const now = new Date('2026-10-09T12:00:00Z');
const route = (message, memory = {}) => routeDeterministically(message, memory, now);
const zero = response => { assert.equal(response.usage.totalLlmCalls, 0); assert.equal(response.usage.totalTokens, 0); };
const affected = baseline.cases.filter(row => row.severity === 'P1' && (row.area === 'sales' || row.id === 'U-0523'));
for (const row of affected) test(`P3C.2 P3B ${row.id}: ${row.input}`, async () => {
  if (row.id === 'U-0523') {
    const f = writeFixture(), response = await f.send(row.input); zero(response);
    assert.equal(f.prepared.length, 1); assert.equal(f.prepared[0].products[0].quantity, 3); assert.equal(f.confirmed.length, 0);
  } else {
    const f = readFixture(), response = await f.run(row.input); zero(response);
    assert.equal(response.intent, row.expected.intents[0]); assert.equal(response.requiresClarification, false);
    assert.equal(f.calls.length, 0);
    if (row.id === 'U-0194') assert.ok(response.actions.some(row => row.skillId === 'get_product_sales_summary'));
  }
});
const periods = [
  ['ayer', '2026-10-08', '2026-10-08'], ['hoy', '2026-10-09', '2026-10-09'],
  ['anteayer', '2026-10-07', '2026-10-07'], ['esta semana', '2026-10-05', '2026-10-09'],
  ['en los últimos 7 días', '2026-10-03', '2026-10-09'],
  ['desde ayer hasta hoy', '2026-10-08', '2026-10-09'],
  ['entre 1 de octubre y 5 de octubre', '2026-10-01', '2026-10-05'],
  ['octubre de 2025', '2025-10-01', '2025-10-31'],
  ['10 de octubre', '2026-10-10', '2026-10-10']
];
for (const [period, startDate, endDate] of periods) test(`P3C.2 preserves product + ${period} in actual executor filters`, async () => {
  const f = readFixture(), response = await f.run(`¿Cuánto vendí de food 96 ${period}?`); zero(response);
  assert.equal(response.requiresClarification, false); assert.equal(response.intent, 'product_sales_summary');
  const plan = route(`¿Cuánto vendí de food 96 ${period}?`);
  assert.equal(plan.lookupQuery, 'food 96'); assert.deepEqual(plan.period, { startDate, endDate });
  const saleRead = f.reads.find(row => row.model === 'Transaction');
  const match = saleRead.pipeline[0].$match;
  assert.equal(match.businessId, 'A'); assert.equal(match.type, 'sale'); assert.equal(match.status, 'completed');
  assert.equal(String(saleRead.pipeline[2].$match['products.productId']), products[0]._id);
  assert.equal(new Date(match.date.$gte).toISOString().slice(0, 10), startDate);
  assert.equal(new Date(new Date(match.date.$lt).getTime() - 86400000).toISOString().slice(0, 10), endDate);
});
test('P3C.2 ambiguous product keeps yesterday through clickable/ordinal selection', async () => {
  for (const selection of ['el segundo', 'M5-FOODS_3_210']) {
    const f = readFixture(), id = randomUUID();
    const choices = await f.run('¿Cuánto vendí de food 210 ayer?', id); zero(choices);
    assert.equal(choices.suggestions.length, 2);
    const result = await f.run(selection, id); zero(result);
    assert.equal(result.intent, 'product_sales_summary');
    const pipeline = f.reads.find(row => row.model === 'Transaction').pipeline;
    const match = pipeline[0].$match;
    assert.equal(String(pipeline[2].$match['products.productId']), products[2]._id);
    assert.equal(new Date(match.date.$gte).toISOString().slice(0, 10), '2026-10-08');
  }
});
test('P3C.2 complete natural-date range formerly unsupported reaches general sales with both bounds', async () => {
  const f = readFixture(), result = await f.run('ventas desde el 9 de octubre de 2026 hasta el 10 de octubre de 2026'); zero(result);
  assert.equal(result.intent, 'sales_summary'); assert.equal(result.requiresClarification, false);
  const match = f.reads.find(row => row.model === 'Transaction').pipeline[0].$match;
  assert.equal(new Date(match.date.$gte).toISOString(), '2026-10-09T00:00:00.000Z');
  assert.equal(new Date(match.date.$lt).toISOString(), '2026-10-11T00:00:00.000Z');
});
test('P3C.2 period followups keep product; explicit new product wins; general sales discard entity', async () => {
  const f = readFixture(), id = randomUUID();
  await f.run('¿Cuánto vendí de food 96 ayer?', id);
  for (const [period] of periods.slice(0, 5)) {
    const result = await f.run(`¿Y ${period}?`, id); zero(result);
    assert.equal(result.intent, 'product_sales_summary');
    assert.match(JSON.stringify(f.reads.at(-1)), new RegExp(products[0]._id));
  }
  const next = await f.run('¿Y food 210 ayer?', id); zero(next); assert.equal(next.suggestions.length, 2);
  const general = await f.run('¿Cuánto vendí ayer?', randomUUID()); zero(general);
  assert.equal(general.intent, 'sales_summary');
  const plan = route('¿Cuánto vendí ayer?', { lastIntent: 'product_sales_summary', lastEntity: { id: products[0]._id } });
  assert.equal(plan.intent, 'sales_summary'); assert.equal(plan.selector, undefined);
});
for (const period of ['ayer', 'hoy', 'anteayer', 'esta semana', 'últimos 7 días', 'desde ayer hasta hoy', 'octubre', '10 de octubre'])
  test(`P3C.2 pure sales period ${period} never searches a product`, async () => {
    const f = readFixture(), result = await f.run(`ventas de ${period}`); zero(result);
    assert.equal(result.intent, 'sales_summary'); assert.ok(!result.actions.some(row => row.skillId === 'search_products'));
  });
test('P3C.2 infinitive and supplier phrase keep separate quantity/product/supplier slots', () => {
  for (const command of ['vende', 'vender']) for (const supplier of ['', ' con proveedor food 13', ' con el proveedor food 13']) {
    const message = `${command} 3 del food 96${supplier}`, parsed = parseAction(message, actionIntent(message));
    assert.deepEqual(parsed.items, [{ quantity: 3, ref: 'food 96' }]);
    assert.equal(parsed.supplierRef, supplier ? 'food 13' : undefined);
  }
  const purchase = parseAction('compra 3 del food 96 con proveedor food 13', 'create_purchase');
  assert.equal(purchase.items[0].ref, 'food 96'); assert.equal(purchase.supplierRef, 'food 13');
});
test('P3C.2 conflicting month and relative date clarify before any query', async () => {
  const f = readFixture(), response = await f.run('ventas de food 96 ayer en octubre de 2026'); zero(response);
  assert.equal(response.requiresClarification, true); assert.equal(f.reads.length, 0);
});
for (const quantity of ['-3', '3.5', '0']) test(`P3C.2 infinitive rejects unsafe quantity ${quantity} before any preview`, async () => {
  const f = writeFixture(), result = await f.send(`vender ${quantity} del food 96 con proveedor food 13`); zero(result);
  assert.equal(f.prepared.length, 0); assert.equal(f.confirmed.length, 0); assert.ok(!result.pendingAction);
});
