const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createAgentOrchestrator, createConversationMemory, createAgentRequestContext } = require('../src/agents');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { validateSkillInvocation } = require('../src/agents/skills');

const sku = 'M5-FOODS_3_511';
const productId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const foreignProductId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
const at = minutes => new Date(Date.UTC(2026, 9, 10, 12, minutes));
const products = [
  { _id: productId, businessId: 'A', sku },
  { _id: foreignProductId, businessId: 'B', sku }
];
const outbox = [
  { _id: new mongoose.Types.ObjectId(), eventId: 'private-event-a', businessId: 'A', productId,
    eventType: 'inventory.alert.opened', status: 'PENDING', attempts: 0, createdAt: at(0),
    payload: { secret: 'must-not-escape' }, leaseToken: 'private-lease' },
  { _id: new mongoose.Types.ObjectId(), eventId: 'private-event-b', businessId: 'A', productId,
    eventType: 'inventory.alert.resolved', status: 'FAILED', attempts: 2, nextAttemptAt: at(20),
    lastErrorCategory: 'TIMEOUT', createdAt: at(1), deliveredAt: null,
    payload: { webhook: 'https://internal.invalid', headers: { Authorization: 'hidden' } } },
  { _id: new mongoose.Types.ObjectId(), eventId: 'private-event-c', businessId: 'A', productId,
    eventType: 'inventory.alert.opened', status: 'FAILED', attempts: 4, nextAttemptAt: null,
    lastErrorCategory: 'AUTH', createdAt: at(2) },
  { _id: new mongoose.Types.ObjectId(), eventId: 'private-event-d', businessId: 'A', productId,
    eventType: 'inventory.alert.opened', status: 'DELIVERED', attempts: 1, deliveredAt: at(4), createdAt: at(3) },
  { _id: new mongoose.Types.ObjectId(), eventId: 'private-event-e', businessId: 'A', productId,
    eventType: 'inventory.alert.resolved', status: 'IN_FLIGHT', attempts: 3, createdAt: at(5) },
  { _id: new mongoose.Types.ObjectId(), eventId: 'tenant-b-event', businessId: 'B', productId: foreignProductId,
    eventType: 'inventory.alert.opened', status: 'DELIVERED', attempts: 1, deliveredAt: at(6), createdAt: at(6) }
];

const equals = (left, right) => String(left) === String(right);
const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
  if (key === '$or') return expected.some(branch => matches(row, branch));
  const actual = row[key];
  if (expected && typeof expected === 'object' && !(expected instanceof mongoose.Types.ObjectId)) {
    return Object.entries(expected).every(([operator, value]) => operator === '$ne' ? actual !== value : false);
  }
  return expected instanceof mongoose.Types.ObjectId ? equals(actual, expected) : actual === expected;
});

const fixture = () => {
  const calls = { productFilters: [], outboxFilters: [], projections: [], limits: [], sorts: [] };
  const Product = {
    findOne(filter) {
      calls.productFilters.push(filter);
      return { select() { return this; }, maxTimeMS() { return this; }, lean() { return this; },
        exec: async () => products.find(row => matches(row, filter)) || null };
    },
    find(filter) {
      calls.productFilters.push(filter);
      return { select() { return this; }, maxTimeMS() { return this; }, lean() { return this; },
        exec: async () => products.filter(row => matches(row, filter)) };
    }
  };
  const Outbox = {
    find(filter) {
      calls.outboxFilters.push(filter);
      const query = { order: null, count: 20,
        select(fields) { calls.projections.push(fields); return this; },
        sort(value) { this.order = value; calls.sorts.push(value); return this; },
        limit(value) { this.count = value; calls.limits.push(value); return this; },
        maxTimeMS(value) { assert.ok(value > 0); return this; }, lean() { return this; },
        exec: async function () {
          const selected = outbox.filter(row => matches(row, filter));
          selected.sort((a, b) => b.createdAt - a.createdAt || String(b._id).localeCompare(String(a._id)));
          return selected.slice(0, this.count);
        }
      };
      return query;
    },
    countDocuments(filter) {
      calls.outboxFilters.push(filter);
      return { maxTimeMS(value) { assert.ok(value > 0); return this; }, exec: async () => outbox.filter(row => matches(row, filter)).length };
    }
  };
  const req = { user: { _id: new mongoose.Types.ObjectId(), businessId: 'A', role: 'user', isActive: true } };
  const context = createAgentRequestContext(req);
  const provider = { generateStructured() { assert.fail('Outbox read must not call Gemini'); },
    generateWithTools() { assert.fail('Outbox read must not call Gemini'); } };
  const orchestrator = createAgentOrchestrator({ memory: createConversationMemory(), provider,
    dependencies: { models: { Product, InventoryAlertOutboxEvent: Outbox }, clock: () => at(10) } });
  return { calls, context, orchestrator, req };
};

test('delivery observability routes separately from configured rules and generated alert events', () => {
  const cases = [
    ['¿Cuál es el estado de entrega de mis alertas de inventario?', { limit: 20 }],
    [`¿Cuál es el estado de entrega de las alertas de ${sku}?`, { sku, limit: 20 }],
    ['¿Qué alertas están pendientes de entrega?', { status: 'PENDING', limit: 20 }],
    [`¿Se entregó la alerta de ${sku}?`, { sku, status: 'DELIVERED', limit: 20 }],
    ['¿Qué entregas están pendientes?', { status: 'PENDING', limit: 20 }],
    ['¿Qué entregas fueron completadas?', { status: 'DELIVERED', limit: 20 }],
    ['¿Qué entregas fallaron?', { status: 'FAILED', limit: 20 }],
    ['¿Qué entregas están en proceso?', { status: 'IN_FLIGHT', limit: 20 }]
  ];
  for (const [message, selector] of cases) {
    const plan = routeDeterministically(message, {}, at(10));
    assert.equal(plan.intent, 'inventory_alert_deliveries', message);
    assert.equal(plan.agent, 'operations');
    assert.deepEqual(plan.selector, selector);
  }
  assert.equal(routeDeterministically('¿Qué alertas de stock tengo configuradas?', {}, at(10)).intent, 'stock_alert_rules');
  assert.equal(routeDeterministically('¿Qué alertas de inventario se han generado?', {}, at(10)).intent, 'inventory_alert_events');
});

test('natural-language alert delivery status phrases remain deterministic outbox queries', async () => {
  const cases = [
    ['¿Cuál es el estado de entrega de mis alertas de inventario?', undefined],
    ['¿Qué alertas están pendientes de entrega?', 'PENDING'],
    [`¿Se entregó la alerta de ${sku}?`, 'DELIVERED']
  ];
  for (const [message, expectedStatus] of cases) {
    const f = fixture();
    const result = await f.orchestrator.handle(f.req, { message });
    assert.equal(result.intent, 'inventory_alert_deliveries', message);
    assert.equal(result.actions[0].skillId, 'list_inventory_alert_outbox_events', message);
    assert.equal(result.usage.totalLlmCalls, 0, message);
    assert.equal(result.usage.totalTokens, 0, message);
    assert.equal(result.usage.totalSkillCalls, 1, message);
    if (expectedStatus === 'PENDING') {
      assert.ok(f.calls.outboxFilters.some(filter => filter.$or?.some(branch => branch.status === 'PENDING')), message);
    } else if (expectedStatus) {
      assert.ok(f.calls.outboxFilters.some(filter => filter.status === expectedStatus), message);
    }
  }
});

test('general outbox listing is recent-first, bounded, tenant-scoped, privacy-safe and deterministic', async () => {
  const f = fixture();
  const result = await f.orchestrator.handle(f.req, { message: '¿Cuál es el estado de entrega de mis alertas de inventario?' });
  assert.equal(result.intent, 'inventory_alert_deliveries');
  assert.equal(result.actions[0].skillId, 'list_inventory_alert_outbox_events');
  assert.equal(result.actions[0].status, 'SUCCEEDED');
  assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.usage.totalSkillCalls, 1);
  assert.equal(result.evidence[0].label, 'Eventos de distribución de alertas');
  assert.equal(result.evidence[0].recordCount, 5);
  assert.match(result.answer, /Alerta abierta.*Entregada/);
  assert.match(result.answer, /Intentos: 1/);
  assert.match(result.answer, /Entregada:/);
  assert.ok(f.calls.outboxFilters.every(filter => filter.businessId === 'A'));
  assert.deepEqual(f.calls.sorts[0], { createdAt: -1, _id: -1 });
  assert.equal(f.calls.limits[0], 20);
  assert.ok(!JSON.stringify(result).includes('private-event'));
  assert.ok(!JSON.stringify(result).includes('507f1f77bcf86cd799439011'));
  assert.ok(!JSON.stringify(result).includes('private-lease'));
  assert.ok(!JSON.stringify(result).includes('must-not-escape'));
  assert.ok(!JSON.stringify(result).includes('internal.invalid'));
  assert.ok(!JSON.stringify(result).includes('Authorization'));
});

test('SKU and delivery-state filters include only this tenant and pending retry semantics', async () => {
  const f = fixture();
  const bySku = await f.orchestrator.handle(f.req, { message: `¿Cuál es el estado de entrega de las alertas de ${sku}?` });
  assert.equal(bySku.evidence[0].recordCount, 5);
  assert.ok(f.calls.productFilters.some(filter => filter.businessId === 'A' && filter.sku === sku));
  assert.ok(f.calls.outboxFilters.some(filter => filter.businessId === 'A' && filter.productId));

  const pending = await f.orchestrator.handle(f.req, { message: '¿Qué entregas están pendientes?' });
  assert.equal(pending.evidence[0].recordCount, 2);
  assert.match(pending.answer, /Pendiente/);
  assert.match(pending.answer, /reintento pendiente/i);
  const completed = await f.orchestrator.handle(f.req, { message: '¿Qué entregas fueron completadas?' });
  assert.equal(completed.evidence[0].recordCount, 1);
  assert.match(completed.answer, /Entregada/);
  const failed = await f.orchestrator.handle(f.req, { message: '¿Qué entregas fallaron?' });
  assert.equal(failed.evidence[0].recordCount, 2);
  assert.match(failed.answer, /Categoría del último error: AUTH/);
  const inFlight = await f.orchestrator.handle(f.req, { message: '¿Qué entregas están en proceso?' });
  assert.equal(inFlight.evidence[0].recordCount, 1);
  assert.match(inFlight.answer, /En proceso/);
  for (const response of [bySku, pending, completed, failed, inFlight]) {
    assert.equal(response.usage.totalLlmCalls, 0);
    assert.equal(response.usage.totalTokens, 0);
    assert.equal(response.usage.totalSkillCalls, 1);
  }
  assert.ok(f.calls.outboxFilters.every(filter => filter.businessId === 'A'));
  assert.ok(f.calls.outboxFilters.some(filter => filter.status === 'DELIVERED'));
  assert.ok(f.calls.outboxFilters.some(filter => filter.status === 'FAILED'));
  assert.ok(f.calls.outboxFilters.some(filter => filter.status === 'IN_FLIGHT'));
  assert.ok(f.calls.outboxFilters.some(filter => filter.$or?.some(branch => branch.status === 'FAILED'
    && branch.nextAttemptAt?.$ne === null)));
});

test('delivery query skill rejects tenant selectors, invalid filters and unauthorized agents', () => {
  const context = fixture().context;
  const valid = { status: 'FAILED', limit: 20 };
  assert.deepEqual(validateSkillInvocation({ agentId: 'operations', skillId: 'list_inventory_alert_outbox_events', args: valid, context }).args, valid);
  for (const args of [{ businessId: 'B' }, { limit: 21 }, { status: 'OPEN' }, { url: 'https://example.test' }]) {
    assert.throws(() => validateSkillInvocation({ agentId: 'operations', skillId: 'list_inventory_alert_outbox_events', args, context }),
      { code: 'AGENT_INVALID_SKILL_ARGS' });
  }
  assert.throws(() => validateSkillInvocation({ agentId: 'coordinator', skillId: 'list_inventory_alert_outbox_events', args: {}, context }),
    { code: 'AGENT_SKILL_NOT_ALLOWED' });
});
