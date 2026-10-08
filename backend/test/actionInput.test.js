const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createActionContext, validateArgs } = require('../src/automations/contracts');
const { actionIntent, parseAction, resolveAction, validateExtraction, resolveReference } = require('../src/automations/actionInput');
const { getActionSkill } = require('../src/automations/skills');
const { withActionAssistant } = require('../src/automations/assistant');
const { Product } = require('../src/models');
const req = () => ({ businessId: 'SYNTHETIC', user: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'SYNTHETIC', role: 'user', isActive: true } });
const context = () => createActionContext(req());
const resolver = async (model, ctx, ref) => { assert.equal(ctx.businessId, 'SYNTHETIC');
  return { value: { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', sku: ref, currency: 'PEN' } }; };
test('natural product is deterministic, complete and prices stay numeric', async () => {
  const text = 'Agrega un producto Coca Cola 500 ml, SKU COC-500, precio S/ 3.50, stock 50 y mínimo 10, categoría Bebidas';
  const extracted = parseAction(text, actionIntent(text)); const result = await resolveAction(extracted, context());
  assert.deepEqual(result.args, { name: 'Coca Cola 500 ml', sku: 'COC-500', price: 3.5, stock: 50, minStockLevel: 10, category: 'Bebidas', currency: 'PEN' });
  validateArgs(getActionSkill('create_product').inputSchema, result.args);
});
for (const text of ['Vende 3 unidades de M5-FOODS_3_499.', 'Registra una venta de 3 del SKU M5-FOODS_3_499']) test(`deterministic sale: ${text}`, async () => {
  const result = await resolveAction(parseAction(text, actionIntent(text)), context(), resolver);
  assert.deepEqual(result.args, { products: [{ productId: 'bbbbbbbbbbbbbbbbbbbbbbbb', quantity: 3 }], currency: 'PEN', paymentMethod: 'cash' });
});
test('multi-item sale keeps all requested items, purchase requires supplier', async () => {
  assert.equal(parseAction('Vende 3 unidades de SKU-001 y 2 de SKU-002', 'create_sale').items.length, 2);
  const extraction = parseAction('Compré 50 unidades del producto SKU-001 al proveedor Distribuidor Demo.', 'create_purchase');
  assert.equal(extraction.supplierRef, 'Distribuidor Demo');
  const result = await resolveAction(extraction, context(), resolver);
  assert.equal(result.args.vendorId, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  delete extraction.supplierRef; assert.match((await resolveAction(extraction, context(), resolver, async () => [])).clarification, /proveedor/);
});
test('credit without registered customer asks rather than creating a contact', async () => {
  const result = await resolveAction(parseAction('Vende 3 unidades de SKU-001 a crédito', 'create_sale'), context(), resolver);
  assert.match(result.clarification, /cliente registrado/);
});
test('ambiguous reference never prepares a write', async () => {
  const result = await resolveAction({ action: 'create_sale', items: [{ ref: 'Agua', quantity: 1 }] }, context(), async () => ({ clarification: 'Indica SKU' }));
  assert.equal(result.clarification, 'Indica SKU');
});
test('reference queries are tenant scoped and regex is literal', async () => {
  const original = Product.find; let filter;
  Product.find = value => { if (value.$or) filter = value; return { select() { return this; }, sort() { return this; },
    limit(n) { assert.equal(n, 2); return this; }, lean() { return this; }, maxTimeMS() { return this; },
    then(resolve) { resolve([]); }, async *cursor() {} }; };
  try { assert.ok((await resolveReference(Product, context(), '.*')).clarification);
    assert.equal(filter.businessId, 'SYNTHETIC'); assert.equal(filter.$or[1].name.source, '^\\.\\*$');
  } finally { Product.find = original; }
});
test('closed extraction and action schemas forbid tenant, prices and Mongo input', () => {
  assert.throws(() => parseAction('Vende -3 unidades de SKU-001', 'create_sale'));
  for (const key of ['businessId', 'userId', 'model', 'apiKey', '$where']) assert.throws(() => validateExtraction({ action: 'create_sale', [key]: 'x' }));
  assert.throws(() => validateArgs(getActionSkill('create_sale').inputSchema, { products: [{ productId: 'bbbbbbbbbbbbbbbbbbbbbbbb', quantity: 1, price: 0.01 }], currency: 'PEN' }));
});
test('assistant sale preparation and hazlo/no lo hagas are zero LLM', async () => {
  let calls = 0, confirmed = 0, cancelled = 0;
  const service = { async prepare(value) { calls++; assert.equal(value.skillId, 'create_sale'); return { summary: 'Venta', pendingActionId: randomUUID(), status: 'PENDING' }; },
    async resolvePending() { return { pendingActionId: randomUUID() }; },
    async confirmPendingAction() { confirmed++; return { status: 'EXECUTED', result: { type: 'sale', id: 'op', total: 10, currency: 'PEN', items: [{ sku: 'SKU-001', quantity: 1, stock: 4 }] } }; },
    async cancelPendingAction() { cancelled++; return { status: 'CANCELLED' }; } };
  const adapter = withActionAssistant({ handle() { throw Error('unexpected LLM'); } }, service, { resolver });
  const conversationId = randomUUID();
  for (const message of ['Vende 1 unidad de SKU-001', 'hazlo', 'no lo hagas']) {
    const result = await adapter.handle(req(), { message, conversationId }); assert.equal(result.usage.totalTokens, 0); assert.equal(result.usage.totalLlmCalls, 0);
  }
  assert.deepEqual([calls, confirmed, cancelled], [1, 1, 1]);
});
test('missing product category is requested, never inferred; bounded draft accepts follow-up', async () => {
  let prepared;
  const adapter = withActionAssistant({}, { prepare: async value => { prepared = value.args; return { summary: 'Producto' }; } });
  const conversationId = randomUUID();
  const first = await adapter.handle(req(), { conversationId, message: 'Agrega un producto Agua, SKU AGUA, precio S/ 3, stock 50, mínimo 10' });
  assert.match(first.answer, /categoría/); assert.equal(prepared, undefined);
  await adapter.handle(req(), { conversationId, message: 'Categoría Bebidas' }); assert.equal(prepared, undefined);
  await adapter.handle(req(), { conversationId, message: 'Continuar sin proveedor' }); assert.equal(prepared.category, 'Bebidas');
});
test('ambiguous extraction uses structured provider and preserves official token total', async () => {
  const provider = { generateWithTools() { throw Error('tools forbidden'); }, async generateStructured() {
    return { output: { action: 'create_sale', items: [{ ref: 'SKU-001', quantity: 3 }], currency: 'PEN' },
      model: process.env.GEMINI_MODEL || require('../src/config/env').DEFAULT_GEMINI_MODEL, latencyMs: 2,
      usage: { inputTokens: 10, outputTokens: 15, thoughtTokens: 20, cachedInputTokens: null, toolUseTokens: null, totalTokens: 46, usageAvailable: true } }; } };
  const adapter = withActionAssistant({}, { prepare: async () => ({ summary: 'Venta' }) }, { provider, resolver });
  const result = await adapter.handle(req(), { conversationId: randomUUID(), message: 'Registra una venta de tres botellas de Agua' });
  assert.equal(result.usage.totalLlmCalls, 1); assert.equal(result.usage.totalTokens, 46); assert.equal(result.usage.metricsComplete, false);
});
test('ambiguous product name clarification accepts SKU follow-up without another Gemini call', async () => {
  const adapter = withActionAssistant({}, { prepare: async value => ({ summary: value.args.products[0].productId }) }, {
    resolver: async (model, ctx, ref) => ref === 'Agua' ? { clarification: 'Indica SKU' } : resolver(model, ctx, ref) });
  const conversationId = randomUUID();
  assert.equal((await adapter.handle(req(), { conversationId, message: 'Vende 2 unidades de Agua' })).requiresClarification, true);
  const result = await adapter.handle(req(), { conversationId, message: 'SKU SKU-001' });
  assert.ok(result.pendingAction); assert.equal(result.usage.totalTokens, 0);
});
test('drafts remain isolated by authenticated user and business', async () => {
  let delegated = 0;
  const adapter = withActionAssistant({ handle: async () => { delegated++; return {}; } }, {});
  const conversationId = randomUUID();
  await adapter.handle(req(), { conversationId, message: 'Agrega un producto Agua, SKU AGUA, precio S/ 3, stock 50, mínimo 10' });
  const foreign = { businessId: 'FOREIGN', user: { ...req().user, businessId: 'FOREIGN' } };
  await adapter.handle(foreign, { conversationId, message: 'Categoría Bebidas' }); assert.equal(delegated, 1);
});
