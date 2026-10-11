const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { withActionAssistant } = require('../src/automations/assistant');
const { rankEntities, normalize } = require('../src/automations/entityResolution');
const { Product } = require('../src/models');
const { compactDraft, TTL_MS } = require('../src/automations/operationDraft');
const { snapshot, publicResponse } = require('../src/services/agentHistoryProjection');
const { parseAction, resolveAction } = require('../src/automations/actionInput');
const p1 = { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Coca-Cola 500ML', sku: 'COC500', currency: 'PEN', stock: 10, isActive: true };
const p2 = { ...p1, _id: 'cccccccccccccccccccccccc', name: 'Coca Cola 1.5 litros', sku: 'COC1500' };
const vendor = { _id: 'dddddddddddddddddddddddd', name: 'Distribuidora Inka SAC' };
const request = (businessId = 'SYNTHETIC', userId = 'aaaaaaaaaaaaaaaaaaaaaaaa') => ({ businessId,
  user: { _id: userId, businessId, role: 'user', isActive: true } });
function fixture({ products = [p1, p2], suppliers = [vendor], configured = [vendor], clock = Date.now } = {}) {
  const prepared = [], cancelled = [], pending = new Map();
  const resolver = async (model, context, ref, type, offset = 0) => {
    assert.equal(context.businessId, 'SYNTHETIC');
    const rows = model === Product ? products : suppliers;
    const exact = rows.find(row => row._id === ref || row.sku === ref);
    if (exact) return { value: structuredClone(exact), confidence: 'EXACT' };
    const result = rankEntities(rows, ref, offset, type === 'vendor');
    return result.value ? result : { ...result, clarification: result.candidates.length ? 'Elige una coincidencia.' : 'No encontré esa entidad.' };
  };
  const service = {
    async prepare(value) { prepared.push(structuredClone(value.args));
      const row = { summary: 'Revisa la operación', status: 'PENDING', pendingActionId: randomUUID() }; pending.set(row.pendingActionId, row); return row; },
    async get(ctx, id) { return pending.get(id); },
    async cancelPendingAction(ctx, id) { cancelled.push(id); const row = pending.get(id); row.status = 'CANCELLED'; return row; },
    async resolvePending() { return [...pending.values()].find(row => row.status === 'PENDING'); }
  };
  const options = { resolver, supplierLookup: async () => configured, listSuppliers: async () => suppliers, clock };
  const runtime = { handle: async () => ({ answer: 'Lectura', usage: { totalTokens: 0 } }), getContextSnapshot: async () => ({}) };
  const adapter = withActionAssistant(runtime, service, options), conversationId = randomUUID();
  const send = message => adapter.handle(request(), { message, conversationId });
  return { adapter, runtime, service, options, conversationId, send, prepared, cancelled };
}
const pagedProducts = () => Array.from({ length: 28 }, (_, i) => ({ ...p1, _id: (i + 1).toString(16).padStart(24, '0'),
  name: `Food ${i % 4} variant ${i}`, sku: `PAGE-${i}` }));
const identityProducts = [2, 3].map((group, i) => ({ ...p1, _id: String(i + 2).repeat(24),
  name: `Alimentos M5 · FOODS_${group} · Ítem 210`, sku: `M5-FOODS_${group}_210` }));
const paddedProducts = identityProducts.map(row => ({ ...row, name: row.name.replace('210', '096'), sku: row.sku.replace('210', '096') }));
const p2bVendors = () => ['San Martin Norte', 'San Martin Sur'].map((name, index) => ({
  _id: String(index + 6).repeat(24), name, isActive: true }));
const p2bPurchaseProduct = () => ({ ...paddedProducts[0], supplierPrices: p2bVendors().map((row, index) => ({ supplierId: row._id, purchasePrice: 10 + index })) });
for (const choice of ['Opción 1', '1', 'el primero', 'San Martin Norte', 'Ver más']) {
  test(`P2B.1 newer READ owns ${choice} without mutating pending purchase`, async () => {
    const f = fixture({ products: [p2bPurchaseProduct()], suppliers: p2bVendors() });
    const purchase = await f.send('compra 3 del food 96 al proveedor San Martin Norte');
    assert.equal(purchase.pendingAction.status, 'PENDING');
    const before = (await f.adapter.getContextSnapshot(request(), f.conversationId)).operationDraft;
    const reads = [];
    f.runtime.handle = async (req, input) => { reads.push(input.message); return { answer: 'Lectura', usage: { totalLlmCalls: 0, totalTokens: 0 } }; };
    await f.send('Dame todos los detalles del proveedor food'); await f.send(choice);
    assert.deepEqual(reads, ['Dame todos los detalles del proveedor food', choice]);
    assert.equal(f.prepared.length, 1); assert.equal(f.cancelled.length, 0);
    assert.equal((await f.service.get(null, purchase.pendingAction.pendingActionId)).status, 'PENDING');
    const after = (await f.adapter.getContextSnapshot(request(), f.conversationId)).operationDraft;
    assert.deepEqual(after, { ...before, readSuspended: true });
    const restored = withActionAssistant(f.runtime, f.service, f.options);
    await restored.restoreContext(request(), f.conversationId, { operationDraft: after });
    await restored.handle(request(), { message: choice, conversationId: f.conversationId });
    assert.equal(f.cancelled.length, 0); assert.equal(f.prepared.length, 1);
  });
}
test('P2B.1 active WRITE supplier selection and correction preserve exactly three units', async () => {
  const f = fixture({ products: [p2bPurchaseProduct()], suppliers: p2bVendors() });
  await f.send('compra 3 del food 96 al proveedor San Martin');
  await f.send('el primero');
  const result = await f.send('no ese proveedor, el segundo');
  assert.equal(result.pendingAction.status, 'PENDING'); assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(f.prepared.length, 2); assert.equal(f.prepared[1].vendorId, p2bVendors()[1]._id);
  assert.deepEqual(f.prepared[1].products, [{ productId: p2bPurchaseProduct()._id, quantity: 3 }]);
});
for (const choice of ['Opción 2', 'el segundo', 'San Martin Sur']) test(`P2B purchase supplier ${choice} keeps quantity/product and only prepares`, async () => {
  const f = fixture({ products: [p2bPurchaseProduct()], suppliers: p2bVendors() });
  const first = await f.send('compra 5 del food 96 al proveedor San Martin');
  assert.equal(first.suggestionsEntityType, 'supplier'); assert.equal(first.suggestions.length, 2);
  assert.equal(f.prepared.length, 0); assert.equal(first.usage.totalTokens, 0);
  const picked = await f.send(choice);
  assert.equal(picked.pendingAction.status, 'PENDING'); assert.equal(picked.usage.totalLlmCalls, 0);
  assert.equal(f.prepared[0].vendorId, p2bVendors()[1]._id);
  assert.deepEqual(f.prepared[0].products, [{ productId: p2bPurchaseProduct()._id, quantity: 5 }]);
});
test('P2B supplier correction after preview cancels frozen action and revalidates supplier offer', async () => {
  const f = fixture({ products: [p2bPurchaseProduct()], suppliers: p2bVendors() });
  await f.send('compra 5 del food 96 al proveedor San Martin'); await f.send('el primero');
  const corrected = await f.send('no ese proveedor, el segundo');
  assert.equal(f.cancelled.length, 1); assert.equal(f.prepared.length, 2);
  assert.equal(f.prepared[1].vendorId, p2bVendors()[1]._id); assert.equal(corrected.pendingAction.status, 'PENDING');
  assert.equal(f.prepared[1].products[0].quantity, 5);
  assert.equal(corrected.usage.totalLlmCalls, 0);
  const draft = (await f.adapter.getContextSnapshot(request(), f.conversationId)).operationDraft;
  assert.equal(draft.selectedSupplier.id, p2bVendors()[1]._id);
  f.options.resolver = async (model, ctx, ref, type, offset) => model === Product
    ? { value: { ...p2bPurchaseProduct(), supplierPrices: [p2bPurchaseProduct().supplierPrices[0]] } }
    : { value: p2bVendors()[1] };
  const invalid = await f.send('proveedor San Martin Sur');
  assert.equal(invalid.requiresClarification, true); assert.equal(invalid.pendingAction, undefined);
  assert.equal(f.prepared.length, 2); assert.match(invalid.answer, /no tiene un precio/);
});
test('P2B supplier pages and restored visible-page choice preserve purchase draft', async () => {
  const suppliers = Array.from({ length: 12 }, (_, index) => ({ _id: (index + 20).toString(16).padStart(24, '0'), name: `San Martin ${String.fromCharCode(65 + index)}` }));
  const row = { ...paddedProducts[0], supplierPrices: suppliers.map((supplier, index) => ({ supplierId: supplier._id, purchasePrice: 10 + index })) };
  const f = fixture({ products: [row], suppliers });
  let result = await f.send('compra 5 del food 96 al proveedor San Martin');
  assert.equal(result.suggestionsPagination.totalMatches, 12);
  result = await f.send('Ver más'); assert.equal(result.suggestionsPagination.offset, 5); assert.equal(result.suggestionsEntityType, 'supplier');
  const saved = snapshot(await f.adapter.getContextSnapshot(request(), f.conversationId));
  const restored = withActionAssistant(f.runtime, f.service, f.options);
  await restored.restoreContext(request(), f.conversationId, saved);
  result = await restored.handle(request(), { message: 'Anterior', conversationId: f.conversationId });
  assert.equal(result.suggestionsPagination.offset, 0);
  await restored.handle(request(), { message: 'Ver más', conversationId: f.conversationId });
  result = await restored.handle(request(), { message: 'el primero', conversationId: f.conversationId });
  assert.equal(result.pendingAction.status, 'PENDING'); assert.equal(f.prepared[0].vendorId, suppliers[5]._id);
  assert.equal(f.prepared[0].products[0].quantity, 5); assert.equal(result.usage.totalTokens, 0);
});
test('P2B supplier WRITE aliases, unique/high confidence, weak and numeric incompatibility', async () => {
  const supplier = { _id: vendor._id, name: 'Proveedor sintético 001 San Martin' };
  const row = { ...paddedProducts[0], supplierPrices: [{ supplierId: supplier._id, purchasePrice: 12 }] };
  for (const alias of ['prov 1 san martin', 'proveedro 01 san martn', 'proveedor 001 san martin']) {
    const f = fixture({ products: [row], suppliers: [supplier] });
    const result = await f.send(`compra 5 del food 96 al ${alias}`);
    assert.equal(result.pendingAction.status, 'PENDING', alias); assert.equal(result.suggestions, undefined);
    assert.equal(f.prepared[0].vendorId, supplier._id); assert.equal(result.usage.totalLlmCalls, 0);
  }
  const missing = fixture({ products: [row], suppliers: [supplier] });
  assert.equal((await missing.send('compra 5 del food 96 al proveedor 2 san martin')).pendingAction, undefined);
  assert.equal(missing.prepared.length, 0);
  const weak = fixture({ products: [row], suppliers: [supplier] });
  weak.options.resolver = async (model, ctx) => model === Product ? { value: row }
    : { confidence: 'AMBIGUOUS', candidates: [supplier], pagination: { query: 'san', offset: 0, limit: 5, totalMatches: 1 } };
  const clarification = await weak.send('compra 5 del food 96 al proveedor san');
  assert.equal(clarification.requiresClarification, true); assert.equal(clarification.suggestions, undefined);
  assert.equal(weak.prepared.length, 0);
});
test('P2B purchase selected supplier updates runtime context without changing product context', async () => {
  const f = fixture({ products: [p2bPurchaseProduct()], suppliers: p2bVendors() });
  const { createAgentOrchestrator, createConversationMemory } = require('../src/agents');
  const runtime = createAgentOrchestrator({ memory: createConversationMemory() });
  await runtime.restoreContext(request(), f.conversationId, { selectedProductReference: { id: p2bPurchaseProduct()._id, sku: p2bPurchaseProduct().sku, name: p2bPurchaseProduct().name } });
  const adapter = withActionAssistant(runtime, f.service, f.options);
  await adapter.handle(request(), { message: 'compra 5 del food 96 al proveedor San Martin', conversationId: f.conversationId });
  await adapter.handle(request(), { message: 'Opción 2', conversationId: f.conversationId });
  const saved = await runtime.getContextSnapshot(request(), f.conversationId);
  assert.equal(saved.lastSupplier.id, p2bVendors()[1]._id); assert.equal(saved.selectedProductReference.sku, p2bPurchaseProduct().sku);
  assert.equal(saved.lastEntity.sku, p2bPurchaseProduct().sku);
  const clarification = await adapter.handle(request('OTHER'), { message: 'compra 5 del food 96 al mismo proveedor', conversationId: f.conversationId });
  assert.equal(clarification.requiresClarification, true); assert.match(clarification.answer, /no tengo uno/);
});
test('P2B product supplier correction drops the previous purchase price and revalidates contact', async () => {
  const f = fixture({ suppliers: p2bVendors() });
  await f.send('Agrega un producto Demo, SKU DEMO-1, precio S/ 3.50, stock 20, mínimo 2, categoría DEMO, proveedor San Martin, precio de compra S/ 2');
  const preview = await f.send('el primero'); assert.equal(preview.pendingAction.status, 'PENDING');
  assert.equal(f.prepared[0].supplierPrices[0].purchasePrice, 2);
  const corrected = await f.send('no ese proveedor, el segundo');
  assert.equal(corrected.requiresClarification, true); assert.equal(corrected.pendingAction, undefined);
  assert.match(corrected.answer, /precio de compra/); assert.equal(f.cancelled.length, 1);
  const next = await f.send('S/ 2.50'); assert.equal(next.pendingAction.status, 'PENDING');
  assert.deepEqual(f.prepared[1].supplierPrices, [{ supplierId: p2bVendors()[1]._id, purchasePrice: 2.5 }]);
});
test('P2B supplier refinement and TTL preserve quantity but cannot revive an expired draft', async () => {
  let time = Date.now(); const f = fixture({ products: [p2bPurchaseProduct()], suppliers: p2bVendors(), clock: () => time });
  await f.send('compra 5 del food 96 al proveedor San Martin');
  const refine = await f.send('Refinar búsqueda'); assert.equal(refine.requiresClarification, true);
  const chosen = await f.send('buscar San Martin Sur'); assert.equal(chosen.pendingAction.status, 'PENDING');
  assert.equal(f.prepared[0].products[0].quantity, 5); assert.equal(f.prepared[0].vendorId, p2bVendors()[1]._id);
  const snapshot = await f.adapter.getContextSnapshot(request(), f.conversationId);
  time += TTL_MS + 1;
  await f.adapter.restoreContext(request(), f.conversationId, snapshot);
  const expired = await f.send('Ver más'); assert.equal(expired.requiresClarification, true);
  assert.equal(expired.pendingAction, undefined); assert.equal(f.prepared.length, 1);
});
for (const reference of ['food 96', 'food 096', 'food 0096', 'item 96', 'item 00096']) test(`P2A.1 padded identity ${reference}`, () => {
  const wrong = [196, 960, 97].map(number => ({ ...p1, name: `Foods 2 Item ${number}`, sku: `M5-FOODS_2_${number}` }));
  const result = rankEntities([...paddedProducts, ...wrong], reference);
  assert.equal(result.confidence, 'AMBIGUOUS'); assert.equal(result.pagination.totalMatches, 2);
  assert.deepEqual(result.candidates.map(row => row.sku).sort(), paddedProducts.map(row => row.sku).sort());
  for (const row of wrong) assert.equal(rankEntities([row], reference).confidence, 'NOT_FOUND');
});
test('P2A.1 structured and exact SKU identities retain canonical display', () => {
  assert.equal(rankEntities(paddedProducts, 'food 02 0096').value.sku, 'M5-FOODS_2_096');
  assert.equal(rankEntities(paddedProducts, 'M5-FOODS_2_096').confidence, 'EXACT');
  const normalized = rankEntities(paddedProducts, 'M5-FOODS_2_96');
  assert.equal(normalized.confidence, 'NORMALIZED'); assert.equal(normalized.value.sku, 'M5-FOODS_2_096');
  const { normalizeProductMatchText } = require('../src/utils/entityIdentity');
  assert.equal(normalizeProductMatchText('CODE0096'), 'code 0096');
  assert.equal(normalizeProductMatchText('precio 0096'), 'precio 0096');
  assert.equal(normalizeProductMatchText('cantidad 003'), 'cantidad 003');
  assert.equal(normalizeProductMatchText('2026-05-09'), '2026 05 09');
});
for (const action of ['vende 3 del food 96', 'compra 3 del food 96', 'avísame cuando food 96 baje de 3']) {
  test(`P2A.1 padded WRITE keeps operation fields: ${action}`, async () => {
    const f = fixture({ products: paddedProducts }); const first = await f.send(action);
    assert.equal(first.suggestions.length, 2); assert.equal(f.prepared.length, 0);
    let result = await f.send(paddedProducts[0].sku);
    if (action.startsWith('compra') && !result.pendingAction) result = await f.send('1');
    assert.equal(f.prepared.length, 1); assert.equal(result.pendingAction.status, 'PENDING');
    if (action.startsWith('avísame')) {
      assert.equal(f.prepared[0].productId, paddedProducts[0]._id); assert.equal(f.prepared[0].operator, '<'); assert.equal(f.prepared[0].threshold, 3);
    } else { assert.equal(f.prepared[0].products[0].productId, paddedProducts[0]._id); assert.equal(f.prepared[0].products[0].quantity, 3); }
    assert.equal(result.usage.totalLlmCalls, 0);
  });
}
for (const reference of ['food 210', 'foods 210', 'food-210', 'item 210', 'ítem 210', 'item210', 'fods 210', 'fooods 210', 'itme 210']) {
  test(`P2A product identity ${reference} preserves both valid candidates`, () => {
    const impostors = [211, 1210, 2100].map(number => ({ ...p1, name: `Alimentos M5 FOODS_3 Item ${number}`, sku: `M5-FOODS_3_${number}` }));
    const result = rankEntities([...identityProducts, ...impostors], reference);
    assert.equal(result.confidence, 'AMBIGUOUS'); assert.equal(result.pagination.totalMatches, 2);
    assert.deepEqual(result.candidates.map(row => row.sku).sort(), identityProducts.map(row => row.sku).sort());
  });
}
for (const reference of ['food 3 210', 'foods 3 210', 'M5-FOODS_3_210']) test(`P2A structured identity ${reference} respects subgroup`, () => {
  const result = rankEntities(identityProducts, reference);
  assert.deepEqual(result.value ? [result.value.sku] : result.candidates.map(row => row.sku), ['M5-FOODS_3_210']);
});
test('P2A incompatible numbers never become HIGH_CONFIDENCE even with nearly identical names', () => {
  for (const number of [211, 1210, 2100]) {
    const row = { ...p1, name: `Item ${number}`, sku: `M5-FOODS_3_${number}` };
    assert.equal(rankEntities([row], 'item 210').confidence, 'NOT_FOUND');
  }
  assert.equal(rankEntities([{ ...identityProducts[1], name: 'Item 210', sku: 'M5-FOODS_3_211' }], 'item 210').confidence, 'NOT_FOUND');
});
test('P2A write selection retains quantity and only prepares; wrong item prepares nothing', async () => {
  const f = fixture({ products: identityProducts });
  const first = await f.send('vende 3 del food 210');
  assert.equal(first.suggestions.length, 2); assert.equal(f.prepared.length, 0);
  const second = await f.send(identityProducts[1].sku);
  assert.equal(second.pendingAction.status, 'PENDING'); assert.equal(f.prepared[0].products[0].quantity, 3);
  assert.equal(f.prepared[0].products[0].productId, identityProducts[1]._id); assert.equal(second.usage.totalLlmCalls, 0);
  const missing = fixture({ products: identityProducts }); const result = await missing.send('vende 3 del food 211');
  assert.equal(missing.prepared.length, 0); assert.equal(result.pendingAction, undefined); assert.equal(result.suggestions?.length || 0, 0);
});
test('P2A.2 one trusted padded product resolves into a preview without suggestions or confirmation', async () => {
  for (const action of ['vende 3 del food 96', 'avísame cuando food 96 baje de 3']) {
    const f = fixture({ products: [paddedProducts[0]] });
    const result = await f.send(action);
    assert.equal(result.suggestions, undefined);
    assert.equal(result.pendingAction.status, 'PENDING');
    assert.equal(f.prepared.length, 1);
    if (action.startsWith('vende')) {
      assert.equal(f.prepared[0].products[0].quantity, 3);
      assert.equal(f.prepared[0].products[0].productId, paddedProducts[0]._id);
    } else {
      assert.equal(f.prepared[0].operator, '<'); assert.equal(f.prepared[0].threshold, 3);
      assert.equal(f.prepared[0].productId, paddedProducts[0]._id);
    }
    assert.equal(result.usage.totalLlmCalls, 0);
  }
});
test('P2A.2 one fuzzy high-confidence product resolves automatically but still requires confirmation', async () => {
  const f = fixture({ products: [p1] });
  const result = await f.send('vende 3 coca cola 500m');
  assert.equal(result.suggestions, undefined);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.prepared[0].products[0].productId, p1._id);
  assert.equal(f.prepared[0].products[0].quantity, 3);
  assert.equal(result.pendingAction.status, 'PENDING');
  assert.equal(result.usage.totalLlmCalls, 0);
});
test('P2A.2 a weak single candidate asks for a more precise reference and does not render one suggestion', async () => {
  const result = await resolveAction({ action: 'create_sale', items: [{ ref: 'coc' , quantity: 3 }] }, request(),
    async () => ({ confidence: 'AMBIGUOUS', candidates: [p1], pagination: { totalMatches: 1 } }));
  assert.match(result.clarification, /suficiente seguridad/);
  assert.equal(result.selection, undefined);
});
test('P2A alert disambiguation keeps threshold and operator without creating a rule', async () => {
  const f = fixture({ products: identityProducts });
  const first = await f.send('avísame cuando food 210 baje de 3');
  assert.equal(first.suggestions.length, 2); assert.equal(f.prepared.length, 0);
  const second = await f.send('el segundo');
  assert.equal(f.prepared[0].productId, identityProducts[1]._id); assert.equal(f.prepared[0].threshold, 3);
  assert.equal(f.prepared[0].operator, '<'); assert.equal(second.pendingAction.status, 'PENDING');
});
for (const choice of ['no es el segundo, es el primero', 'no el segundo, el primero',
  'el primero, no el segundo', 'me equivoqué, era el primero', 'mejor el primero', 'no, el primero']) {
  test(`write correction selects first, keeps quantity, and only prepares: ${choice}`, async () => {
    const f = fixture();
    const ambiguous = await f.send('vende 3 coca');
    assert.equal(ambiguous.suggestions.length, 2); assert.equal(f.prepared.length, 0);
    const result = await f.send(choice);
    assert.equal(f.prepared.length, 1); assert.equal(f.prepared[0].products[0].productId, p1._id);
    assert.equal(f.prepared[0].products[0].quantity, 3); assert.equal(result.pendingAction.status, 'PENDING');
    assert.equal(f.cancelled.length, 0); assert.equal(result.usage.totalLlmCalls, 0);
  });
}
for (const choice of ['no el segundo', 'no quiero el segundo', 'el primero y el segundo']) {
  test(`negative draft choice stays clickable and never prepares: ${choice}`, async () => {
    const f = fixture(); await f.send('vende 3 coca');
    const result = await f.send(choice);
    assert.equal(f.prepared.length, 0); assert.equal(result.suggestions.length, 2);
    assert.equal(result.requiresClarification, true); assert.equal(result.usage.totalLlmCalls, 0);
    await f.send('el primero'); assert.equal(f.prepared[0].products[0].quantity, 3);
  });
}
test('supplier draft contrast chooses the corrected provider and never confirms the purchase', async () => {
  const other = { ...vendor, _id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Proveedor Central' };
  const f = fixture({ suppliers: [vendor, other], configured: [vendor, other] });
  await f.send('compra 3 COC500');
  const result = await f.send('no es el segundo, es el primero');
  assert.equal(f.prepared[0].vendorId, vendor._id); assert.equal(f.prepared[0].products[0].quantity, 3);
  assert.equal(result.pendingAction.status, 'PENDING');
});
test('rule draft contrast revalidates the corrected product without creating a rule', async () => {
  const f = fixture(); await f.send('Crea una alerta para coca cuando llegue a 3');
  const result = await f.send('no es el segundo, es el primero');
  assert.equal(f.prepared[0].productId, p1._id); assert.equal(f.prepared[0].threshold, 3);
  assert.equal(result.pendingAction.status, 'PENDING'); assert.equal(result.usage.totalLlmCalls, 0);
});
test('an explicit unsafe new quantity cannot bypass P0 while candidates are active', async () => {
  for (const token of ['-3', '3.5', '0']) {
    const f = fixture(); await f.send('vende 3 coca');
    const result = await f.send(`vende ${token} el primero`);
    assert.equal(result.requiresClarification, true); assert.equal(f.prepared.length, 0);
    assert.equal(result.pendingAction, undefined); assert.equal(result.usage.totalLlmCalls, 0);
  }
});

test('mixed ordinal and quantity corrections cannot silently discard unsafe numbers', async () => {
  for (const message of ['mejor el primero, cantidad -3', 'el primero cantidad 3.5', 'el primero, cantidad 0']) {
    const f = fixture(); await f.send('vende 3 coca');
    const result = await f.send(message);
    assert.equal(result.requiresClarification, true); assert.equal(f.prepared.length, 0);
    assert.equal(result.pendingAction, undefined); assert.equal(result.usage.totalLlmCalls, 0);
    await f.send('el primero'); assert.equal(f.prepared[0].products[0].quantity, 3);
  }
});
test('28 matches are counted exactly with stable five-item pages, no duplicates and a short last page', () => {
  const rows = pagedProducts(), seen = [];
  for (let offset = 0; offset < 28; offset += 5) {
    const result = rankEntities(rows.slice().reverse(), 'food', offset);
    assert.equal(result.pagination.totalMatches, 28); assert.equal(result.pagination.offset, offset);
    assert.equal(result.pagination.hasMore, offset < 25); assert.equal(result.pagination.hasPrevious, offset > 0);
    assert.equal(result.candidates.length, offset === 25 ? 3 : 5);
    assert.deepEqual(result.candidates.map(row => row._id), rows.slice(offset, offset + 5).map(row => row._id));
    seen.push(...result.candidates.map(row => row._id));
  }
  assert.equal(new Set(seen).size, 28);
  assert.throws(() => rankEntities(rows, 'food', -5)); assert.throws(() => rankEntities(rows, 'food', 3));
});
test('supplier candidate commands are delegated to the supplier context, never the product-draft fallback', async () => {
  const conversationId = randomUUID(), otherConversation = randomUUID(); let delegated = 0;
  const runtime = { handle: async (_req, input) => { delegated++; return { answer: input.message, intent: 'supplier_products' }; },
    getContextSnapshot: async (_req, id) => id === conversationId ? { supplierResolution: { candidateType: 'supplier', offset: 0 } } : {} };
  const adapter = withActionAssistant(runtime, {}, {});
  const result = await adapter.handle(request(), { message: 'Ver más', conversationId });
  assert.equal(delegated, 1); assert.equal(result.intent, 'supplier_products'); assert.equal(result.answer, 'Ver más');
  const isolated = await adapter.handle(request(), { message: 'Ver más', conversationId: otherConversation });
  assert.equal(delegated, 1); assert.match(isolated.answer, /lista de opciones vigente/i); assert.equal(isolated.usage.totalTokens, 0);
});
test('candidate navigation without a conversation-local list asks a neutral zero-cost clarification', async () => {
  const f = fixture(); const result = await f.send('Ver más');
  assert.match(result.answer, /lista de opciones vigente/i);
  assert.doesNotMatch(result.answer, /búsqueda de productos/i);
  assert.equal(result.usage.totalTokens, 0);
});
for (const choice of ['1', 'el primero', 'el segundo', 'PAGE-5']) test(`page 2 selection ${choice} retains two units and consumes zero tokens`, async () => {
  const f = fixture({ products: pagedProducts() });
  const first = publicResponse(await f.send('vende 2 food'));
  assert.equal(first.suggestionsPagination.totalMatches, 28); assert.match(first.answer, /Mostrando 1–5/);
  const second = await f.send('Ver más');
  assert.match(second.answer, /Mostrando 6–10/); assert.equal(second.suggestionsPagination.offset, 5);
  assert.equal(second.usage.totalLlmCalls, 0); assert.equal(second.usage.totalTokens, 0);
  await f.send(choice);
  assert.equal(f.prepared[0].products[0].productId, pagedProducts()[choice === 'el segundo' ? 6 : 5]._id);
  assert.equal(f.prepared[0].products[0].quantity, 2);
});
test('previous and next pages preserve draft, ordering and final-page boundary', async () => {
  const f = fixture({ products: pagedProducts() });
  const first = await f.send('vende 2 food'); await f.send('Ver más');
  assert.deepEqual((await f.send('Anterior')).suggestions, first.suggestions);
  for (let i = 0; i < 5; i++) await f.send('Ver más');
  const last = await f.send('Ver más');
  assert.equal(last.suggestionsPagination.offset, 25); assert.equal(last.suggestions.length, 3);
  assert.equal(last.suggestionsPagination.hasMore, false); assert.equal(f.prepared.length, 0);
});
for (const query of ['buscar food 3', 'food 3']) test(`refinement ${query} resets page and preserves quantity`, async () => {
  const f = fixture({ products: pagedProducts() }); await f.send('vende 2 food'); await f.send('Ver más');
  await f.send('Refinar búsqueda'); const result = await f.send(query);
  assert.equal(result.suggestionsPagination.query, 'food 3'); assert.equal(result.suggestionsPagination.offset, 0);
  assert.ok(result.suggestionsPagination.totalMatches < 28);
  assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalTokens, 0);
  await f.send('1'); assert.equal(f.prepared[0].products[0].quantity, 2);
});
test('page metadata restores on restart, stays tenant/user scoped and expires without revival', async () => {
  let now = Date.now(); const f = fixture({ products: pagedProducts(), clock: () => now });
  await f.send('vende 2 food'); await f.send('Ver más');
  const state = snapshot(await f.adapter.getContextSnapshot(request(), f.conversationId));
  assert.equal(state.operationDraft.selection.offset, 5); assert.equal(state.operationDraft.selection.query, 'food');
  const restart = withActionAssistant(f.runtime, f.service, f.options);
  await restart.restoreContext(request(), f.conversationId, state);
  const next = await restart.handle(request(), { message: 'Anterior', conversationId: f.conversationId });
  assert.equal(next.suggestionsPagination.offset, 0);
  const foreign = await restart.handle(request('OTHER'), { message: 'Ver más', conversationId: f.conversationId });
  assert.match(foreign.answer, /No hay una lista de opciones/); assert.equal(foreign.usage.totalLlmCalls, 0);
  const otherUser = await restart.handle(request('SYNTHETIC', 'eeeeeeeeeeeeeeeeeeeeeeee'), { message: '1', conversationId: f.conversationId });
  assert.equal(otherUser.answer, 'Lectura');
  now += TTL_MS + 1;
  const expired = await restart.handle(request(), { message: 'Ver más', conversationId: f.conversationId });
  assert.match(expired.answer, /No hay una lista de opciones/); assert.equal(expired.usage.totalLlmCalls, 0);
  assert.equal(f.prepared.length, 0);
});

for (const choice of ['Opción 1', '1', 'el primero', 'el segundo', 'FOOD-0']) test(`food candidates survive public projection and select ${choice}`, async () => {
  const products = Array.from({ length: 7 }, (_, i) => ({ ...p1, _id: String(i + 1).padStart(24, '0'), name: `Foods ${i}`, sku: `FOOD-${i}` }));
  const f = fixture({ products });
  assert.equal(rankEntities(products, 'food').confidence, 'AMBIGUOUS');
  const first = publicResponse(await f.send('vende 2 food'));
  assert.equal(first.suggestions.length, 5);
  assert.match(first.answer, /1\. Foods 0 — FOOD-0/);
  assert.match(first.clarificationQuestion, /5\. Foods 4 — FOOD-4/);
  assert.equal(first.suggestionsExpiresAt, (await f.adapter.getContextSnapshot(request(), f.conversationId)).operationDraft.expiresAt);
  assert.ok(!JSON.stringify(first).includes(products[0]._id));
  const selected = await f.send(choice);
  assert.equal(f.prepared[0].products[0].quantity, 2);
  assert.equal(selected.usage.totalLlmCalls, 0); assert.equal(selected.usage.totalTokens, 0);
});

test('raw ID of a real tenant product outside candidate list cannot bypass selection', async () => {
  const other = { ...p1, _id: 'ffffffffffffffffffffffff', name: 'Other', sku: 'OTHER' };
  const f = fixture({ products: [p1, p2, other] });
  await f.send('vende 2 coca'); await f.send(other._id);
  assert.equal(f.prepared.length, 0);
});

test('vende 2 food reaches the HTTP envelope with candidates and keeps quantity after selection', async () => {
  const { createAgentMessagesHandler } = require('../src/controllers/agentMessagesController');
  const products = [p1, p2].map((row, i) => ({ ...row, name: `Foods ${i}`, sku: `FOOD-${i}` }));
  const f = fixture({ products });
  const handler = createAgentMessagesHandler({ enabled: true, orchestrator: f.adapter });
  const call = async message => {
    let body, status = 200;
    await handler({ ...request(), body: { message, conversationId: f.conversationId }, get: () => undefined },
      { status(value) { status = value; return this; }, json(value) { body = value; } });
    assert.equal(status, 200); return body.data;
  };
  const first = await call('vende 2 food');
  assert.equal(first.suggestions.length, 2); assert.match(first.answer, /FOOD-0/);
  assert.deepEqual(publicResponse(first).suggestions, first.suggestions);
  await call('1'); assert.equal(f.prepared[0].products[0].quantity, 2);
});
for (const ref of ['coca cola 500 ml', 'COCA-COLA 500ML', 'cocacola 500ml']) test(`normalised exact product ${ref}`, () => {
  assert.equal(rankEntities([p1, p2], ref).value._id, p1._id);
});
test('accents and unit spelling normalize without modifying canonical data', () => {
  assert.equal(normalize(' Ázúcar   500ML '), 'azucar 500 ml');
  assert.equal(normalize('litro y medio'), normalize('1.5 litros'));
});
for (const [ref, confidence] of [['coca', 'AMBIGUOUS'], ['cocacola 500m', 'HIGH_CONFIDENCE'], ['detergente rojo', 'NOT_FOUND']]) test(`matching ${confidence}`, () => {
  assert.equal(rankEntities([p1, p2], ref).confidence, confidence);
});
for (const ref of ['Distribuidora Inka SAC', 'distribudora inka', 'Inka', 'Distribuidora Inca SAC']) test(`supplier search: ${ref}`, () => {
  assert.ok(rankEntities([vendor], ref).value || rankEntities([vendor], ref).candidates.length);
});
test('multiple supplier candidates and not found remain unselected', () => {
  assert.equal(rankEntities([vendor, { ...vendor, _id: p2._id, name: 'Distribuidora Inka Centro' }], 'inka').confidence, 'AMBIGUOUS');
  assert.equal(rankEntities([vendor], 'ZZZ desconocido').confidence, 'NOT_FOUND');
});
for (const selection of ['1', 'el primero', 'Opción 1']) test(`vague sale and selection ${selection} use zero LLM`, async () => {
  const f = fixture();
  const first = await f.send('Vende dos de coca');
  assert.equal(f.prepared.length, 0); assert.equal(first.suggestions.length, 2);
  const result = await f.send(selection);
  assert.equal(f.prepared[0].products[0].quantity, 2); assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalTokens, 0);
});
test('out-of-range and forged candidate IDs never create a pending action', async () => {
  const f = fixture(); await f.send('Vende 2 coca'); await f.send('99'); await f.send('ffffffffffffffffffffffff');
  assert.equal(f.prepared.length, 0);
});
test('omitted quantity is filled without repeating the product', async () => {
  const f = fixture(); await f.send('Vende COC500'); const result = await f.send('cinco');
  assert.equal(f.prepared[0].products[0].quantity, 5); assert.equal(result.usage.totalTokens, 0);
});
test('insufficient stock offers a quantity but never shrinks automatically', async () => {
  const f = fixture(); const result = await f.send('Vende 20 COC500');
  assert.match(result.answer, /10 unidades/); assert.equal(f.prepared.length, 0);
  await f.send(result.suggestions[0].message); assert.equal(f.prepared[0].products[0].quantity, 10);
});
test('inactive products cannot be prepared', async () => {
  const f = fixture({ products: [{ ...p1, isActive: false }] }); const result = await f.send('Vende 1 COC500');
  assert.match(result.answer, /inactivo/); assert.equal(f.prepared.length, 0);
});
test('resolved multi-item slots survive an ambiguous later product', async () => {
  const f = fixture(); await f.send('Vende 2 COC500 y 3 coca'); await f.send('la segunda');
  assert.equal(f.prepared[0].products.length, 2); assert.equal(f.prepared[0].products[0].productId, p1._id);
  assert.equal(f.prepared[0].products[1].productId, p2._id);
});
test('purchase with one configured supplier resolves it automatically and prepares a preview', async () => {
  const f = fixture({ configured: [{ ...vendor, costs: [{ sku: p1.sku, currency: 'PEN', purchasePrice: 2.8 }] }] });
  const result = await f.send('Compré 2 COC500');
  assert.equal(result.suggestions, undefined); assert.equal(f.prepared.length, 1);
  assert.equal(result.pendingAction.status, 'PENDING'); assert.equal(f.prepared[0].vendorId, vendor._id);
  assert.deepEqual(f.prepared[0].products[0], { productId: p1._id, quantity: 2 });
});
test('multiple configured suppliers require a choice', async () => {
  const second = { ...vendor, _id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Proveedor Central' };
  const f = fixture({ suppliers: [vendor, second], configured: [vendor, second] }); await f.send('Compra 2 COC500');
  await f.send('la segunda'); assert.equal(f.prepared[0].vendorId, second._id);
});
test('one high-confidence supplier typo resolves to a real supplier and remains pending confirmation', async () => {
  const f = fixture(); const result = await f.send('Compra 2 COC500 de proveedor distribudora inka');
  assert.equal(f.prepared.length, 1); assert.equal(result.suggestions, undefined);
  assert.equal(result.pendingAction.status, 'PENDING'); assert.equal(f.prepared[0].vendorId, vendor._id);
});
test('missing supplier association explains manual configuration and no write', async () => {
  const f = fixture({ products: [{ ...p1, supplierPrices: [] }], configured: [] });
  assert.match((await f.send('Compra 2 COC500')).answer, /precio de compra/);
  assert.equal(f.prepared.length, 0);
});
const creation = 'Agrega un producto Agua, SKU AGUA, precio S/ 3, stock 5, mínimo 1, categoría Bebidas';
test('product enrichment is optional, asked once, and can be skipped', async () => {
  const f = fixture(); const result = await f.send(creation); assert.match(result.answer, /asociar un proveedor/); assert.equal(f.prepared.length, 0);
  await f.send('Continuar sin proveedor'); assert.equal(f.prepared.length, 1); assert.equal(f.prepared[0].supplierPrices, undefined);
});
test('existing vendor selection and purchase price create a real association in args', async () => {
  const f = fixture(); await f.send(creation); await f.send('Elegir proveedor'); await f.send('2.80');
  assert.deepEqual(f.prepared[0].supplierPrices, [{ supplierId: vendor._id, purchasePrice: 2.8 }]);
});
test('pending supplier creation is not enabled and keeps product draft', async () => {
  const f = fixture(); await f.send(creation); assert.match((await f.send('Crear proveedor nuevo')).answer, /todavía no está habilitado/);
  await f.send('Continuar sin proveedor'); assert.equal(f.prepared.length, 1);
});
test('quantity correction cancels old frozen pending and prepares new arguments', async () => {
  const f = fixture(); const old = await f.send('Vende 2 COC500'); await f.send('en vez de 2 pon 8');
  assert.deepEqual(f.prepared.map(args => args.products[0].quantity), [2, 8]); assert.deepEqual(f.cancelled, [old.pendingAction.pendingActionId]);
});
test('help preserves draft and cancel clears it', async () => {
  const f = fixture(); await f.send(creation); assert.equal((await f.send('¿qué me falta?')).requiresClarification, true);
  assert.match((await f.send('mejor cancela eso')).answer, /cancelado/);
  assert.equal((await f.adapter.getContextSnapshot(request(), f.conversationId)).operationDraft, null);
});
test('snapshot restoration restores selection without writes or Gemini', async () => {
  const f = fixture(); await f.send('Vende 2 coca');
  const saved = snapshot(await f.adapter.getContextSnapshot(request(), f.conversationId));
  const restored = withActionAssistant(f.runtime, f.service, f.options);
  await restored.restoreContext(request(), f.conversationId, saved); assert.equal(f.prepared.length, 0);
  const result = await restored.handle(request(), { message: '2', conversationId: f.conversationId });
  assert.equal(result.usage.totalTokens, 0); assert.equal(f.prepared[0].products[0].productId, p2._id);
});
test('draft expires; later messages cannot resurrect a stale selection', async () => {
  let time = Date.now(); const f = fixture({ clock: () => time }); await f.send('Vende 2 coca'); time += TTL_MS + 1;
  const result = await f.send('1'); assert.equal(result.answer, 'Lectura'); assert.equal(f.prepared.length, 0);
});
test('draft memory is isolated by user and tenant', async () => {
  const f = fixture(); await f.send('Vende 2 coca');
  for (const req of [request('FOREIGN'), request('SYNTHETIC', 'eeeeeeeeeeeeeeeeeeeeeeee')]) {
    const result = await f.adapter.handle(req, { message: '1', conversationId: f.conversationId }); assert.equal(result.answer, 'Lectura');
  }
  assert.equal(f.prepared.length, 0);
});
test('draft snapshots are closed, secret-free, bounded and stale snapshots rejected', () => {
  const base = { action: 'create_sale', updatedAt: Date.now(), expiresAt: Date.now() + 1000, items: [{ ref: 'COC500', quantity: 1 }] };
  assert.equal(compactDraft({ ...base, businessId: 'FOREIGN' }), null);
  assert.equal(compactDraft({ ...base, supplierRef: 'password=secret' }), null);
  assert.equal(compactDraft({ ...base, expiresAt: Date.now() - 1 }), null);
  assert.equal(publicResponse({ suggestions: [{ label: 'Proveedor', message: 'Opción 1', secret: 'never' }] }).suggestions[0].secret, undefined);
});
test('currency omitted remains required for new products, S/ is explicitly PEN', () => {
  assert.equal(parseAction('Agrega arroz a 4.5', 'create_product').product.currency, undefined);
  assert.equal(parseAction('Agrega arroz a S/ 4.5', 'create_product').product.currency, 'PEN');
});
test('customer ambiguity requires selection and credit omission requires a real customer', async () => {
  const f = fixture({ suppliers: [{ ...vendor, name: 'Juan Pérez' }, { ...vendor, _id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Juan Martínez' }] });
  const first = await f.send('Vende 2 COC500 a Juan'); assert.equal(first.suggestions.length, 2);
  assert.equal(first.suggestionsEntityType, 'customer'); assert.equal(f.prepared.length, 0);
  await f.send('1'); assert.equal(f.prepared[0].customerId, vendor._id);
});
test('credit accepts a registered customer supplied in the next turn', async () => {
  const f = fixture({ suppliers: [{ ...vendor, name: 'Juan Pérez' }] });
  assert.match((await f.send('Vende 2 COC500 fiado')).answer, /cliente registrado/);
  await f.send('Juan Pérez'); assert.equal(f.prepared[0].customerId, vendor._id); assert.equal(f.prepared[0].paymentMethod, 'credit');
});
test('contextual supplier help keeps quantity and does not prepare or cancel', async () => {
  const f = fixture(); await f.send('Vende 20 COC500');
  assert.match((await f.send('¿qué proveedores tiene este producto?')).answer, /Distribuidora Inka/);
  assert.equal(f.prepared.length, 0); await f.send('mejor 8'); assert.equal(f.prepared[0].products[0].quantity, 8);
});
test('corrections preserve a multi-item purchase and replace only selected quantity', async () => {
  const second = { ...vendor, _id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Proveedor Central' };
  const f = fixture({ suppliers: [vendor, second], configured: [vendor, second] });
  await f.send('Compra 2 COC500 y 3 COC1500'); await f.send('Cambiar cantidad del producto 2 a 5');
  await f.send('1'); assert.deepEqual(f.prepared[0].products.map(row => row.quantity), [2, 5]);
});
test('product change before confirmation cancels old pending and asks about new candidate', async () => {
  const f = fixture(); await f.send('Vende 2 COC500'); await f.send('cambia producto a COC1500');
  assert.equal(f.cancelled.length, 1); assert.equal(f.prepared[1].products[0].productId, p2._id);
});
test('a stopped/expired pending cannot be edited or confirmed by a follow-up', async () => {
  const f = fixture(); const old = await f.send('Vende 2 COC500');
  await f.service.cancelPendingAction({}, old.pendingAction.pendingActionId);
  const result = await f.send('mejor 8'); assert.match(result.answer, /terminó o venció/); assert.equal(f.prepared.length, 1);
});
test('a new explicit operation is allowed after previous action ended', async () => {
  const f = fixture(); const old = await f.send('Vende 2 COC500'); await f.service.cancelPendingAction({}, old.pendingAction.pendingActionId);
  await f.send('Vende 3 COC1500'); assert.equal(f.prepared.length, 2);
});
test('purchase cost remains missing until explicitly entered in the product currency', async () => {
  const f = fixture(); await f.send(creation); await f.send('Elegir proveedor');
  await f.send('USD 2.8'); assert.equal(f.prepared.length, 0);
  await f.send('PEN 2.8'); assert.equal(f.prepared[0].supplierPrices[0].purchasePrice, 2.8);
});
test('fully supplied product vendor and cost avoid redundant enrichment questions', async () => {
  const f = fixture(); await f.send(`${creation}, proveedor Distribuidora Inka SAC, precio de compra 2.80`);
  assert.equal(f.prepared.length, 1); assert.equal(f.prepared[0].supplierPrices[0].supplierId, vendor._id);
});
test('literal punctuation is not a wildcard for candidate matching', () => {
  assert.equal(rankEntities([p1, p2], '.*').confidence, 'NOT_FOUND');
});
test('Gemini interpreted invented entity is still resolved against real tenant data', async () => {
  let prepared = 0;
  const provider = { generateWithTools() { assert.fail('No tools'); }, async generateStructured() { return {
    output: { action: 'create_sale', items: [{ ref: 'Producto inventado por LLM', quantity: 3 }] },
    model: require('../src/config/env').DEFAULT_GEMINI_MODEL, latencyMs: 1,
    usage: { inputTokens: 5, outputTokens: 5, thoughtTokens: null, cachedInputTokens: null, toolUseTokens: null, totalTokens: 10, usageAvailable: true }
  }; } };
  const adapter = withActionAssistant({}, { prepare() { prepared++; } }, { provider, resolver: async () => ({ confidence: 'NOT_FOUND', candidates: [], clarification: 'No encontré ese producto.' }) });
  const result = await adapter.handle(request(), { conversationId: randomUUID(), message: 'Registra una venta de tres botellas de Algo' });
  assert.equal(prepared, 0); assert.equal(result.requiresClarification, true); assert.equal(result.usage.totalTokens, 10);
});
test('duplicate product stock offers the remaining quantity without changing the first item', async () => {
  const f = fixture(); const result = await f.send('Vende 2 COC500 y 20 COC500');
  assert.match(result.suggestions[0].message, /producto 2 a 8/); await f.send(result.suggestions[0].message);
  assert.deepEqual(f.prepared[0].products.map(row => row.quantity), [2, 8]);
});
test('candidate phrase can distinguish size and preserve quantity', async () => {
  const f = fixture(); await f.send('Vende 2 coca'); await f.send('el de 1.5 litros');
  assert.equal(f.prepared[0].products[0].productId, p2._id); assert.equal(f.prepared[0].products[0].quantity, 2);
});
test('queued simultaneous draft edits preserve all product fields', async () => {
  const f = fixture(); await f.send('Agrega un producto Agua, SKU AGUA, precio S/ 3, stock 5, mínimo 1');
  await Promise.all([f.send('Categoría Bebidas'), f.send('Continuar sin proveedor')]);
  assert.equal(f.prepared.length, 1); assert.equal(f.prepared[0].category, 'Bebidas');
});
