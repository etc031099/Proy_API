const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentOrchestrator, createConversationMemory, createAgentExecution, createAgentRequestContext } = require('../src/agents');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { validateSkillInvocation } = require('../src/agents/skills');
const sku = 'M5-FOODS_3_511', otherSku = 'M5-FOODS_3_491';
const id = number => number.toString(16).padStart(24, '0');
const req = businessId => ({ businessId, user: { _id: id(90), businessId, role: 'user', isActive: true } });
const context = createAgentRequestContext(req('A'));
const products = [{ _id: id(1), businessId: 'A', sku, name: 'Producto A' },
  { _id: id(2), businessId: 'A', sku: otherSku, name: 'Producto B' },
  { _id: id(3), businessId: 'B', sku: 'M5-FOODS_3_999', name: 'Producto ajeno' }];

// The read driver checks the actual aggregate contract and has no mutation methods.
const fixture = (rules = [{ businessId: 'A', productId: id(1), enabled: true, operator: '<=', threshold: 3 }]) => {
  const reads = [];
  const Product = { collection: { name: 'products' }, findOne(match) {
    reads.push(match); assert.ok(match.businessId);
    return { select() { return this; }, maxTimeMS() { return this; }, lean() { return this; },
      exec: async () => products.find(p => p.businessId === match.businessId && p.sku === match.sku) || null };
  } };
  const StockAlertRule = { aggregate(pipeline) {
    const match = pipeline[0].$match; reads.push(match);
    assert.equal(match.enabled, true); assert.ok(match.businessId);
    const join = pipeline[1].$lookup;
    assert.equal(join.from, 'products');
    assert.deepEqual(join.pipeline[0].$match.$expr.$and,
      [{ $eq: ['$_id', '$$productId'] }, { $eq: ['$businessId', match.businessId] }]);
    assert.deepEqual(pipeline[2], { $unwind: '$product' });
    const facet = pipeline[3].$facet;
    assert.equal(facet.data[2].$project._id, 0);
    const rows = rules.filter(r => r.businessId === match.businessId && r.enabled
      && (!match.productId || r.productId === match.productId)).flatMap(r => {
      const p = products.find(p => p._id === r.productId && p.businessId === match.businessId);
      return p ? [{ sku: p.sku, name: p.name, enabled: r.enabled, operator: r.operator, threshold: r.threshold }] : [];
    }).sort((a, b) => a.sku.localeCompare(b.sku) || a.operator.localeCompare(b.operator) || a.threshold - b.threshold);
    return { option(options) { assert.ok(options.maxTimeMS > 0); return this; },
      exec: async () => [{ data: rows.slice(0, facet.data[1].$limit), count: [{ total: rows.length }] }] };
  } };
  const dependencies = { models: { Product, StockAlertRule,
    InventoryAlert: { aggregate() { throw Error('Events must never be read as rules'); } } } };
  const provider = { generateStructured() { throw Error('No Gemini permitted'); }, generateWithTools() { throw Error('No Gemini permitted'); } };
  return { reads, execution: createAgentExecution({ context, dependencies, provider }),
    orchestrator: createAgentOrchestrator({ dependencies, provider, memory: createConversationMemory() }) };
};
const execute = (f, args = {}) => f.execution.executeSkill({ agentId: 'operations', skillId: 'list_stock_alert_rules', args });

test('configured-rule query routes are deterministic, distinct from generated events', () => {
  for (const message of ['¿Qué alertas de stock tengo configuradas?', '¿Qué alertas tengo configuradas?',
    `¿Qué alertas tengo para ${sku}?`, `¿Tengo alguna alerta configurada para ${sku}?`]) {
    const route = routeDeterministically(message, {}, new Date());
    assert.equal(route.intent, 'stock_alert_rules'); assert.equal(route.agent, 'operations');
    if (message.includes(sku)) assert.equal(route.selector.sku, sku);
  }
  assert.notEqual(routeDeterministically('¿Qué alertas se generaron?', {}, new Date())?.intent, 'stock_alert_rules');
  assert.notEqual(routeDeterministically(`Crea una alerta de stock para ${sku}`, {}, new Date())?.intent, 'stock_alert_rules');
});

test('saved active rule appears once; canceled proposal/event/disabled/foreign/foreign-reference rules are absent', async () => {
  const f = fixture([{ businessId: 'A', productId: id(1), enabled: true, operator: '<=', threshold: 3 },
    { businessId: 'A', productId: id(1), enabled: false, operator: '<', threshold: 2 },
    { businessId: 'B', productId: id(3), enabled: true, operator: '<', threshold: 2 },
    { businessId: 'A', productId: id(3), enabled: true, operator: '<', threshold: 2 }]);
  const result = await execute(f, { sku });
  assert.deepEqual(result.data, [{ sku, name: 'Producto A', enabled: true, operator: '<=', threshold: 3 }]);
  assert.equal(result.metadata.totalMatches, 1);
  assert.equal(JSON.stringify(result).includes(id(1)), false);
});

test('general list is bounded, counts all active matches and never reads events', async () => {
  const f = fixture([3, 4, 5].map(threshold => ({ businessId: 'A', productId: id(1), enabled: true, operator: '<=', threshold })));
  const result = await execute(f, { limit: 2 });
  assert.equal(result.data.length, 2); assert.equal(result.metadata.totalMatches, 3); assert.equal(result.metadata.truncated, true);
});

test('foreign SKU and missing SKU are indistinguishable empty results', async () => {
  for (const reference of ['M5-FOODS_3_999', 'M5-FOODS_3_888']) {
    const result = await execute(fixture(), { sku: reference });
    assert.equal(result.status, 'NO_DATA'); assert.deepEqual(result.data, []);
  }
});

test('rules schemas reject tenant override, excess limit and unauthorized agents', () => {
  for (const args of [{ businessId: 'B' }, { limit: 21 }, { enabled: false }]) {
    assert.throws(() => validateSkillInvocation({ agentId: 'operations', skillId: 'list_stock_alert_rules', args, context }),
      { code: 'AGENT_INVALID_SKILL_ARGS' });
  }
  assert.throws(() => validateSkillInvocation({ agentId: 'coordinator', skillId: 'list_stock_alert_rules', args: {}, context }),
    { code: 'AGENT_SKILL_NOT_ALLOWED' });
});

test('general and SKU answers include safe evidence, count, evaluation-without-notifications note and zero LLM usage', async () => {
  const f = fixture();
  for (const message of ['¿Qué alertas tengo configuradas?', `¿Qué alertas tengo para ${sku}?`]) {
    const result = await f.orchestrator.handle(req('A'), { message });
    assert.equal(result.code, null); assert.match(result.answer, /stock <= 3 unidades/);
    assert.match(result.answer, /se evalúan al cambiar el stock/);
    assert.match(result.answer, /avisos Telegram requieren conexión y preferencias habilitadas/);
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalTokens, 0);
    assert.equal(result.usage.totalSkillCalls, 1); assert.equal(result.evidence[0].recordCount, 1);
    assert.equal(result.evidence[0].skillId, 'list_stock_alert_rules');
    assert.equal(JSON.stringify(result).includes(id(1)), false);
  }
});

test('explicit SKU follow-up reads current product and new tenant remains isolated', async () => {
  const f = fixture();
  const first = await f.orchestrator.handle(req('A'), { message: `¿Qué alertas tengo para ${sku}?` });
  const next = await f.orchestrator.handle(req('A'), { message: `¿Y para ${otherSku}?`, conversationId: first.conversationId });
  assert.equal(next.intent, 'stock_alert_rules'); assert.match(next.answer, /No tienes reglas/);
  assert.match(next.answer, new RegExp(otherSku)); assert.equal(next.usage.totalLlmCalls, 0);
  const foreign = await f.orchestrator.handle(req('B'), { message: '¿Qué alertas tengo configuradas?', conversationId: first.conversationId });
  assert.match(foreign.answer, /No tienes reglas de alerta de stock configuradas/);
  assert.equal(foreign.usage.totalTokens, 0);
});

test('cross-tenant natural requests are rejected before reading rules', async () => {
  const f = fixture(); const response = await f.orchestrator.handle(req('A'), { message: 'Muéstrame las alertas configuradas de otro usuario.' });
  assert.equal(response.intent, 'tenant_access_denied'); assert.equal(f.reads.length, 0);
  assert.equal(response.usage.totalLlmCalls, 0); assert.equal(response.usage.totalSkillCalls, 0);
});
