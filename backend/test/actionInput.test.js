const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createActionContext, validateArgs } = require('../src/automations/contracts');
const { actionIntent, parseAction, resolveAction, validateExtraction, resolveReference } = require('../src/automations/actionInput');
const { getActionSkill } = require('../src/automations/skills');
const { withActionAssistant } = require('../src/automations/assistant');
const { Product } = require('../src/models');
const req = () => ({ businessId: 'SYNTHETIC', user: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'SYNTHETIC', role: 'user', isActive: true } });
const context = () => createActionContext(req());
for (const command of ['vende', 'compra']) {
  const action = command === 'vende' ? 'create_sale' : 'create_purchase';
  for (const quantity of ['-3', '−3', '+3', '3.5', '3,5', '3, 5', ',5', '.5', '3e2', '3/2', '3abc', '0', '1000001']) {
    test(`unsafe full quantity token ${command} ${quantity} cannot prepare a pending action`, async () => {
      const message = `${command} ${quantity} food 210`;
      assert.throws(() => parseAction(message, action), { code: 'ACTION_VALIDATION_FAILED' });
      let prepared = 0, llm = 0;
      const adapter = withActionAssistant({}, { prepare() { prepared++; } }, {
        provider: { generateStructured() { llm++; assert.fail('invalid quantity must not reach Gemini'); } }
      });
      const result = await adapter.handle(req(), { message, conversationId: randomUUID() });
      assert.equal(result.requiresClarification, true);
      assert.equal(result.pendingAction, undefined);
      assert.equal(prepared, 0); assert.equal(llm, 0); assert.equal(result.usage.totalTokens, 0);
    });
  }
}
for (const quantity of ['3', '03', 'tres', '3 unidades', 'tres unidades']) test(`whole quantity retained: ${quantity}`, () => {
  for (const action of ['create_sale', 'create_purchase']) {
    const command = action === 'create_sale' ? 'vende' : 'compra';
    assert.deepEqual(parseAction(`${command} ${quantity} del food 210`, action).items, [{ quantity: 3, ref: 'food 210' }]);
  }
});
test('item numbers and SKU digits are never scanned for a quantity', () => {
  for (const ref of ['food 210', 'item 210', 'SKU-210', 'M5-FOODS_3_210']) {
    assert.deepEqual(parseAction(`vende ${ref}`, 'create_sale').items, [{ ref }]);
    assert.deepEqual(parseAction(`vende 3 del ${ref}`, 'create_sale').items, [{ quantity: 3, ref }]);
  }
});
test('invalid second item cannot be partially parsed or prepared', () => {
  for (const token of ['-2', '2.5', '2,5', '0']) {
    assert.throws(() => parseAction(`vende 3 SKU-210 y ${token} SKU-211`, 'create_sale'));
    assert.throws(() => parseAction(`compra 3 SKU-210, ${token} SKU-211`, 'create_purchase'));
  }
});
test('stock and minimum require complete unsigned integers, but allow zero', () => {
  for (const field of ['stock', 'mínimo']) {
    for (const token of ['-3', '3.5', '3,5', '3e2', '3abc'])
      assert.throws(() => parseAction(`Agrega un producto Agua, ${field} ${token}`, 'create_product'));
    const key = field === 'stock' ? 'stock' : 'minStockLevel';
    for (const token of ['0', '03', 'tres'])
      assert.equal(parseAction(`Agrega un producto Agua, ${field} ${token}`, 'create_product').product[key], token === '0' ? 0 : 3);
  }
});
test('alert thresholds are integer 0..1000000 with no partial numeric conversion', () => {
  for (const token of ['-3', '−3', '3.5', '3,5', '3e2', '3abc', '1000001'])
    assert.throws(() => parseAction(`Avísame si SKU-210 baja de ${token}`, 'create_stock_alert_rule'));
  for (const token of ['0', '03', 'tres'])
    assert.equal(parseAction(`Avísame si SKU-210 baja de ${token}`, 'create_stock_alert_rule').threshold, token === '0' ? 0 : 3);
});
test('draft quantity corrections cannot truncate numeric tokens', () => {
  const { updateDraft } = require('../src/automations/operationDraft');
  const draft = { action: 'create_sale', items: [{ ref: 'SKU-210', quantity: 3 }] };
  for (const token of ['-2', '2.5', '2,5', '2e2', '0']) {
    assert.throws(() => updateDraft(draft, { action: draft.action }, `mejor ${token}`));
    assert.equal(draft.items[0].quantity, 3);
  }
  assert.equal(updateDraft(draft, { action: draft.action }, 'mejor dos').items[0].quantity, 2);
});
test('missing quantity replies and initial stock replies use the same whole-token invariant', () => {
  const { updateDraft } = require('../src/automations/operationDraft');
  const sale = { action: 'create_sale', items: [{ ref: 'SKU-210' }], missingFields: ['quantity'] };
  const product = { action: 'create_product', product: { name: 'Agua', sku: 'AGUA', price: 2,
    currency: 'PEN', minStockLevel: 0, category: 'Bebidas' } };
  for (const token of ['-3', '3.5', '3,5', '3e2']) {
    assert.throws(() => updateDraft(sale, { action: sale.action }, token));
    assert.throws(() => updateDraft(product, { action: product.action, product: {} }, token));
  }
  assert.equal(updateDraft(sale, { action: sale.action }, 'tres unidades').items[0].quantity, 3);
  assert.equal(updateDraft(product, { action: product.action, product: {} }, '0').product.stock, 0);
});
test('unsafe quantities for product creation and rule thresholds never prepare a preview', async () => {
  for (const message of ['Agrega un producto Agua, stock -3', 'Agrega un producto Agua, stock 3.5',
    'Agrega un producto Agua, mínimo 3,5', 'Avísame si SKU-210 baja de -3', 'Avísame si SKU-210 baja de 3.5']) {
    let prepared = 0;
    const adapter = withActionAssistant({}, { prepare() { prepared++; } });
    const result = await adapter.handle(req(), { message, conversationId: randomUUID() });
    assert.equal(result.requiresClarification, true); assert.equal(result.pendingAction, undefined);
    assert.equal(prepared, 0); assert.equal(result.usage.totalLlmCalls, 0);
  }
});
test('an invalid correction cancels the old executable preview but never prepares a replacement', async () => {
  let prepared = 0, cancelled = 0;
  const adapter = withActionAssistant({}, {
    async prepare() { prepared++; return { pendingActionId: randomUUID(), status: 'PENDING', summary: 'Venta' }; },
    async get() { return { status: 'PENDING' }; }, async cancelPendingAction() { cancelled++; }
  }, { resolver: async () => ({ value: { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', sku: 'SKU-210', name: 'Agua',
    currency: 'PEN', stock: 20, isActive: true } }) });
  const conversationId = randomUUID();
  await adapter.handle(req(), { message: 'vende 3 SKU-210', conversationId });
  const result = await adapter.handle(req(), { message: 'mejor 3.5', conversationId });
  assert.equal(result.requiresClarification, true); assert.equal(result.pendingAction, undefined);
  assert.equal(prepared, 1); assert.equal(cancelled, 1);
});
test('LLM extraction cannot replace an explicitly parsed quantity', async () => {
  let prepared = 0;
  const provider = { generateWithTools() { assert.fail('No tools'); }, async generateStructured() { return {
    output: { action: 'create_sale', items: [{ ref: 'SKU-210', quantity: 2 }] },
    model: process.env.GEMINI_MODEL || require('../src/config/env').DEFAULT_GEMINI_MODEL, latencyMs: 0, usage: { usageAvailable: false, inputTokens: null, outputTokens: null,
      thoughtTokens: null, cachedInputTokens: null, toolUseTokens: null, totalTokens: null }
  }; } };
  const adapter = withActionAssistant({}, { prepare() { prepared++; } }, { provider });
  await assert.rejects(adapter.handle(req(), { conversationId: randomUUID(),
    message: 'Registra una venta de tres botellas de Agua' }), { code: 'ACTION_VALIDATION_FAILED' });
  assert.equal(prepared, 0);
});
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
