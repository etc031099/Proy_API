const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { withActionAssistant } = require('../src/automations/assistant');
const { rankEntities, normalize } = require('../src/automations/entityResolution');
const { Product } = require('../src/models');
const { compactDraft, TTL_MS } = require('../src/automations/operationDraft');
const { snapshot, publicResponse } = require('../src/services/agentHistoryProjection');
const { parseAction } = require('../src/automations/actionInput');
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
    const result = rankEntities(rows, ref, offset);
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
  assert.match(foreign.answer, /No hay una búsqueda/); assert.equal(foreign.usage.totalLlmCalls, 0);
  const otherUser = await restart.handle(request('SYNTHETIC', 'eeeeeeeeeeeeeeeeeeeeeeee'), { message: '1', conversationId: f.conversationId });
  assert.equal(otherUser.answer, 'Lectura');
  now += TTL_MS + 1;
  const expired = await restart.handle(request(), { message: 'Ver más', conversationId: f.conversationId });
  assert.match(expired.answer, /No hay una búsqueda/); assert.equal(expired.usage.totalLlmCalls, 0);
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
test('purchase omitted supplier prompts with actual costs then requires selection', async () => {
  const f = fixture({ configured: [{ ...vendor, costs: [{ sku: p1.sku, currency: 'PEN', purchasePrice: 2.8 }] }] });
  const result = await f.send('Compré 2 COC500'); assert.match(result.suggestions[0].detail, /2.8 PEN/); assert.equal(f.prepared.length, 0);
  await f.send('sí'); assert.equal(f.prepared[0].vendorId, vendor._id);
});
test('multiple configured suppliers require a choice', async () => {
  const second = { ...vendor, _id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Proveedor Central' };
  const f = fixture({ suppliers: [vendor, second], configured: [vendor, second] }); await f.send('Compra 2 COC500');
  await f.send('la segunda'); assert.equal(f.prepared[0].vendorId, second._id);
});
test('supplier typo becomes a confirmed real candidate, not an invented supplier', async () => {
  const f = fixture(); const result = await f.send('Compra 2 COC500 de proveedor distribudora inka');
  assert.equal(f.prepared.length, 0); assert.equal(result.suggestions.length, 1);
  await f.send('sí'); assert.equal(f.prepared[0].vendorId, vendor._id);
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
  const f = fixture(); await f.send(creation); await f.send('Elegir proveedor'); await f.send('1'); await f.send('2.80');
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
  const first = await f.send('Vende 2 COC500 a Juan'); assert.equal(first.suggestions.length, 2); assert.equal(f.prepared.length, 0);
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
  const f = fixture(); await f.send('Compra 2 COC500 y 3 COC1500'); await f.send('Cambiar cantidad del producto 2 a 5');
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
  const f = fixture(); await f.send(creation); await f.send('Elegir proveedor'); await f.send('1');
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
