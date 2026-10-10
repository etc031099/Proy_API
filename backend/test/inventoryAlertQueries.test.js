const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createAgentOrchestrator, createConversationMemory, createAgentRequestContext } = require('../src/agents');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { validateSkillInvocation } = require('../src/agents/skills');

const sku = 'M5-FOODS_3_511', productId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const foreignProductId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
const ruleId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439013');
const movementId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439014');
const eventId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439015');
const at = date => new Date(`2026-10-${date}T12:00:00.000Z`);
const products = [
  { _id: productId, businessId: 'A', sku, name: 'Producto demo' },
  { _id: foreignProductId, businessId: 'B', sku, name: 'Producto tenant B' }
];
const events = [
  { _id: eventId, businessId: 'A', productId, source: 'stock_alert_rule', ruleId, inventoryMovementId: movementId,
    condition: { operator: '<=', threshold: 3 }, previousStock: 4, newStock: 3, status: 'OPEN', createdAt: at('10') },
  { _id: new mongoose.Types.ObjectId(), businessId: 'A', productId, source: 'stock_alert_rule', ruleId,
    inventoryMovementId: new mongoose.Types.ObjectId(), condition: { operator: '<', threshold: 1 },
    previousStock: 1, newStock: 0, status: 'RESOLVED', createdAt: at('09') },
  { _id: new mongoose.Types.ObjectId(), businessId: 'A', productId, actionId: 'legacy-action',
    status: 'OPEN', createdAt: at('08') },
  { _id: new mongoose.Types.ObjectId(), businessId: 'B', productId: foreignProductId, source: 'stock_alert_rule',
    ruleId, inventoryMovementId: movementId, condition: { operator: '<=', threshold: 3 },
    previousStock: 4, newStock: 3, status: 'OPEN', createdAt: at('11') }
];
const matches = (row, filter) => Object.entries(filter).every(([key, value]) =>
  value instanceof mongoose.Types.ObjectId ? String(row[key]) === String(value) : row[key] === value);

const fixture = () => {
  const calls = { eventFilters: [], productReads: [] };
  const Product = {
    collection: { name: 'products' },
    findOne(filter) {
      calls.productReads.push(filter);
      return { select() { return this; }, maxTimeMS() { return this; }, lean() { return this; },
        exec: async () => products.find(row => matches(row, filter)) || null };
    },
    find(filter) {
      calls.productReads.push(filter);
      return { select() { return this; }, maxTimeMS() { return this; }, lean() { return this; },
        exec: async () => products.filter(row => matches(row, filter) || (filter._id?.$in
          && filter._id.$in.some(id => String(id) === String(row._id)) && row.businessId === filter.businessId)) };
    }
  };
  const Alert = {
    find(filter) {
      calls.eventFilters.push(filter);
      const query = { order: null, count: 20, select() { return this; }, sort(value) { this.order = value; return this; },
        limit(value) { this.count = value; return this; }, maxTimeMS(value) { assert.ok(value > 0); return this; },
        lean() { return this; }, exec: async function () {
          const selected = events.filter(row => matches(row, filter));
          selected.sort((a, b) => b.createdAt - a.createdAt || String(b._id).localeCompare(String(a._id)));
          return selected.slice(0, this.count);
        } };
      return query;
    },
    countDocuments(filter) {
      calls.eventFilters.push(filter);
      return { maxTimeMS(value) { assert.ok(value > 0); return this; }, exec: async () => events.filter(row => matches(row, filter)).length };
    }
  };
  const context = createAgentRequestContext({ businessId: 'A', user: {
    _id: new mongoose.Types.ObjectId(), businessId: 'A', role: 'user', isActive: true
  } });
  const provider = { generateStructured() { assert.fail('Read-only alert queries must not call Gemini'); },
    generateWithTools() { assert.fail('Read-only alert queries must not call Gemini'); } };
  const orchestrator = createAgentOrchestrator({ memory: createConversationMemory(), provider,
    dependencies: { models: { Product, InventoryAlert: Alert }, clock: () => at('10') } });
  const req = { businessId: 'A', user: { _id: context.userId, businessId: 'A', role: 'user', isActive: true } };
  return { calls, context, orchestrator, req };
};

test('inventory alert requests route separately from configured stock alert rules', () => {
  const cases = [
    ['¿Qué alertas de inventario se han generado?', {}],
    ['¿Qué alertas generaron mis reglas de stock?', { source: 'stock_alert_rule' }],
    [`¿Qué alertas de reglas de stock se generaron para ${sku}?`, { source: 'stock_alert_rule', sku }],
    ['¿Qué alertas están abiertas?', { status: 'OPEN' }],
    ['¿Qué alertas ya se resolvieron?', { status: 'RESOLVED' }]
  ];
  for (const [message, selector] of cases) {
    const plan = routeDeterministically(message, {}, at('10'));
    assert.equal(plan.intent, 'inventory_alert_events', message); assert.equal(plan.agent, 'operations');
    assert.deepEqual(plan.selector, selector);
  }
  assert.equal(routeDeterministically('¿Qué alertas de stock tengo configuradas?', {}, at('10')).intent, 'stock_alert_rules');
});

test('general event listing is recent-first, bounded, tenant-scoped, evidence-backed and deterministic', async () => {
  const f = fixture();
  const result = await f.orchestrator.handle(f.req, { message: '¿Qué alertas de inventario se han generado?' });
  assert.equal(result.intent, 'inventory_alert_events');
  assert.equal(result.actions[0].skillId, 'list_inventory_alerts');
  assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.usage.totalSkillCalls, 1);
  assert.equal(result.evidence[0].label, 'Alertas de inventario generadas'); assert.equal(result.evidence[0].recordCount, 3);
  assert.match(result.answer, /M5-FOODS_3_511 \(Producto demo\).*Abierta/);
  assert.match(result.answer, /stock <= 3/); assert.match(result.answer, /4 → 3 unidades/);
  assert.match(result.answer, /Origen: evento de inventario/);
  assert.ok(f.calls.eventFilters.every(filter => filter.businessId === 'A'));
  assert.ok(!result.answer.includes(String(productId)) && !JSON.stringify(result.actions).includes(String(ruleId))
    && !JSON.stringify(result.evidence).includes(String(movementId)));
  assert.equal(JSON.stringify(result).includes(String(eventId)), false);
});

test('source, SKU and OPEN/RESOLVED filters apply on tenant events only', async () => {
  const f = fixture();
  const ruleEvents = await f.orchestrator.handle(f.req, { message: `¿Qué alertas generaron mis reglas de stock para ${sku}?` });
  assert.match(ruleEvents.answer, /Origen: regla de stock/); assert.match(ruleEvents.answer, /stock <= 3/);
  assert.equal(ruleEvents.evidence[0].recordCount, 2);
  const open = await f.orchestrator.handle(f.req, { message: '¿Qué alertas están abiertas?' });
  assert.match(open.answer, /Abierta/); assert.doesNotMatch(open.answer, /Resuelta/);
  const resolved = await f.orchestrator.handle(f.req, { message: '¿Qué alertas ya se resolvieron?' });
  assert.match(resolved.answer, /Resuelta/); assert.doesNotMatch(resolved.answer, /Abierta/);
  for (const result of [ruleEvents, open, resolved]) {
    assert.equal(result.usage.totalLlmCalls, 0);
    assert.equal(result.usage.totalTokens, 0);
    assert.equal(result.usage.totalSkillCalls, 1);
  }
  for (const filter of f.calls.eventFilters) assert.equal(filter.businessId, 'A');
  assert.ok(f.calls.eventFilters.some(filter => filter.source === 'stock_alert_rule' && filter.productId));
  assert.ok(f.calls.eventFilters.some(filter => filter.status === 'OPEN'));
  assert.ok(f.calls.eventFilters.some(filter => filter.status === 'RESOLVED'));
});

test('legacy events without custom-rule evidence remain readable and missing SKU returns accurate empty answer', async () => {
  const f = fixture();
  const missing = await f.orchestrator.handle(f.req, { message: '¿Qué alertas de inventario se generaron para SKU-NO-EXISTE?' });
  assert.equal(missing.evidence[0].recordCount, 0);
  assert.match(missing.answer, /No se han generado alertas de inventario para SKU-NO-EXISTE/);
  assert.doesNotMatch(missing.answer, /reglas configuradas/);
  const legacy = await f.orchestrator.handle(f.req, { message: '¿Qué alertas de inventario se generaron?' });
  assert.match(legacy.answer, /Origen: evento de inventario/);
});

test('inventory event skill limits args, hides tenant selectors, and is operations-only', () => {
  const args = { status: 'OPEN', source: 'stock_alert_rule', limit: 20 };
  const valid = validateSkillInvocation({ agentId: 'operations', skillId: 'list_inventory_alerts', args,
    context: fixture().context });
  assert.deepEqual(valid.args, args);
  for (const invalid of [{ businessId: 'B' }, { limit: 21 }, { status: 'PENDING' }, { url: 'https://example.test' }]) {
    assert.throws(() => validateSkillInvocation({ agentId: 'operations', skillId: 'list_inventory_alerts', args: invalid,
      context: fixture().context }), { code: 'AGENT_INVALID_SKILL_ARGS' });
  }
  assert.throws(() => validateSkillInvocation({ agentId: 'coordinator', skillId: 'list_inventory_alerts', args: {},
    context: fixture().context }), { code: 'AGENT_SKILL_NOT_ALLOWED' });
});
