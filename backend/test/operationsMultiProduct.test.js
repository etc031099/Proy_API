'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Product, Contact, Transaction } = require('../src/models');
const { withActionAssistant } = require('../src/automations/assistant');
const { actionIntent, parseAction } = require('../src/automations/actionInput');
const { rankEntities, configuredSuppliers } = require('../src/automations/entityResolution');
const { writeTransaction } = require('../src/services/transactionWriteService');
const id = n => n.toString(16).padStart(24, '0');
const vendorRows = [1, 2].map(n => ({ _id: id(100 + n), name: `Distribuidora ${n}`, type: 'vendor', isActive: true }));
const catalog = [
  ['Coca-Cola Original', 'COLA-001', 3], ['Coca-Cola Sin Azúcar', 'COLA-002', 4],
  ['Papas Lays', 'LAYS-001', 2], ['Leche Gloria', 'LECHE-001', 5], ['Leche Ideal', 'LECHE-002', 6]
].map(([name, sku, price], index) => ({ _id: id(index + 1), name, sku, price, currency: 'PEN', stock: 20, isActive: true,
  supplierPrices: vendorRows.map((vendor, n) => ({ supplierId: vendor._id, purchasePrice: price - 1 + n })) }));

function fixture(t, { products = catalog, vendors = vendorRows } = {}) {
  const prepared = [], confirmations = [], resolutions = [], pending = new Map();
  const copy = value => value ? structuredClone(value) : null;
  const req = { businessId: 'SYNTHETIC-MULTI', user: { _id: id(999), businessId: 'SYNTHETIC-MULTI', role: 'user', isActive: true } };
  t.mock.method(Product, 'findOne', filter => {
    assert.equal(filter.businessId, req.businessId);
    return { session: async () => copy(products.find(row => String(row._id) === String(filter._id))) };
  });
  t.mock.method(Contact, 'findOne', filter => {
    assert.equal(filter.businessId, req.businessId);
    return { session: async () => copy(vendors.find(row => String(row._id) === String(filter._id))) };
  });
  t.mock.method(Contact, 'find', filter => {
    assert.equal(filter.businessId, req.businessId); assert.equal(filter.type, 'vendor');
    return { select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; },
      maxTimeMS: async () => copy(vendors.filter(row => filter._id.$in.includes(row._id))) };
  });
  t.mock.method(Transaction, 'create', () => assert.fail('No real transaction may be written by these tests'));
  const resolver = async (model, context, ref, type, offset = 0) => {
    assert.equal(context.businessId, req.businessId);
    resolutions.push(ref);
    const rows = model === Product ? products : vendors;
    const exact = rows.find(row => row._id === ref || row.sku === ref);
    if (exact) return { value: copy(exact), confidence: 'EXACT' };
    const ranked = rankEntities(copy(rows), ref, offset, model !== Product);
    return ranked.value ? ranked : { ...ranked, clarification: ranked.candidates.length ? 'Elige una coincidencia.' : 'No encontré esa entidad.' };
  };
  const service = {
    async prepare(input) {
      // Exercise the actual shared pricing/stock/contact validator, with fixture
      // reads and a fixed historical FX rate to prohibit network/DB side effects.
      const { snapshot } = await writeTransaction({ businessId: req.businessId, preview: true, session: {},
        historical: { date: '2026-10-20T12:00:00Z', exchangeRates: { 'USD/PEN': 3.8 } },
        input: { ...input.args, type: input.skillId === 'create_sale' ? 'sale' : 'purchase' } });
      prepared.push(copy(input.args));
      const row = { pendingActionId: randomUUID(), action: input.skillId, status: 'PENDING', requiresConfirmation: true,
        expiresAt: new Date(Date.now() + 600000).toISOString(), summary: `Registrar ${snapshot.items.length} productos`,
        fields: { total: snapshot.totalAmount, currency: snapshot.currency, contact: snapshot.contactName },
        items: snapshot.items.map(item => ({ name: item.name, sku: item.sku, quantity: item.quantity, price: item.convertedPrice,
          total: item.quantity * item.convertedPrice, stock: item.stock, resultingStock: item.resultingStock })) };
      pending.set(row.pendingActionId, row); return row;
    },
    async get(_context, key) { return pending.get(key); },
    async resolvePending() { return [...pending.values()].find(row => row.status === 'PENDING'); },
    async cancelPendingAction(_context, key) { const row = pending.get(key); row.status = 'CANCELLED'; return row; },
    async confirmPendingAction(_context, key) {
      const row = pending.get(key); if (row.status === 'EXECUTED') return row;
      assert.equal(row.status, 'PENDING'); confirmations.push(key); row.status = 'EXECUTED';
      row.result = { type: row.action === 'create_sale' ? 'sale' : 'purchase', total: row.fields.total, currency: row.fields.currency,
        items: row.items.map(item => ({ name: item.name, sku: item.sku, quantity: item.quantity, stock: item.resultingStock })) };
      return row;
    }
  };
  const runtime = { handle: async () => ({ answer: 'Lectura', usage: { totalLlmCalls: 0 } }), getContextSnapshot: async () => ({}) };
  const adapter = withActionAssistant(runtime, service, { resolver, supplierLookup: configuredSuppliers });
  const conversationId = randomUUID();
  return { prepared, confirmations, resolutions, pending, send: message => adapter.handle(req, { message, conversationId }),
    snapshot: () => adapter.getContextSnapshot(req, conversationId),
    restore: state => adapter.restoreContext(req, conversationId, state), products };
}

for (const message of ['vendi 3 papas lays', 'vendí 3 papas lays', 'ya vendi 3 papas lays', 'acabo de vender 3 papas lays'])
  test(`A6.1 narrative sale asks registration intent before resolver/preview: ${message}`, async t => {
    const f = fixture(t);
    const result = await f.send(message);
    assert.equal(result.agent, 'operations'); assert.equal(result.requiresClarification, true);
    assert.equal(result.usage.totalLlmCalls, 0); assert.match(result.answer, /registrar una venta de 3 unidades de papas lays/i);
    assert.equal(result.pendingAction, undefined); assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0);
    assert.equal(f.resolutions.length, 0);
    const state = await f.snapshot();
    assert.deepEqual(state.operationDraft.items, [{ quantity: 3, ref: 'papas lays' }]);
    assert.deepEqual(state.operationDraft.missingFields, ['registrationIntent']);
    await f.send('confirmar'); assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0);
    await f.send('sí'); assert.equal(f.prepared.length, 0);
    const preview = await f.send('sí, registra esta venta');
    assert.equal(preview.pendingAction.status, 'PENDING'); assert.equal(f.prepared.length, 1);
    assert.equal(preview.pendingAction.items[0].sku, 'LAYS-001'); assert.equal(preview.pendingAction.items[0].quantity, 3);
    assert.equal(f.confirmations.length, 0);
    await f.send('confirmar'); assert.equal(f.confirmations.length, 1);
  });

for (const message of ['vende 3 papas lays', 'registra 3 papas lays', 'registra la venta de 3 papas lays', 'quiero vender 3 papas lays'])
  test(`A6.1 explicit sale still prepares only a preview: ${message}`, async t => {
    const f = fixture(t), result = await f.send(message);
    assert.equal(result.agent, 'operations'); assert.equal(result.pendingAction.status, 'PENDING');
    assert.equal(result.pendingAction.items[0].quantity, 3); assert.equal(result.pendingAction.items[0].sku, 'LAYS-001');
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.confirmations.length, 0);
  });

test('A6.1 narrative draft remains restorable and cancellable without a preview', async t => {
  const f = fixture(t); await f.send('vendí 3 papas lays');
  const state = JSON.parse(JSON.stringify(await f.snapshot()));
  const resumed = fixture(t); await resumed.restore(state);
  const result = await resumed.send('registra esta venta');
  assert.equal(result.pendingAction.items[0].quantity, 3); assert.equal(resumed.confirmations.length, 0);
  const cancelled = fixture(t); await cancelled.send('vendí 3 papas lays');
  await cancelled.send('cancelar'); assert.equal((await cancelled.snapshot()).operationDraft, null);
  assert.equal(cancelled.prepared.length, 0);
});

test('A6.1 narrative clarification still resolves ambiguity before preview and cannot confirm another action', async t => {
  const f = fixture(t); await f.send('vendí 3 coca cola');
  assert.equal(f.resolutions.length, 0);
  const selection = await f.send('registra esta venta');
  assert.equal(selection.requiresClarification, true); assert.equal(f.prepared.length, 0);
  const preview = await f.send('opción 1');
  assert.equal(preview.pendingAction.items[0].quantity, 3); assert.equal(f.confirmations.length, 0);
  await f.send('vendí 2 papas lays');
  assert.equal(f.prepared.length, 1); assert.equal(f.confirmations.length, 0);
  assert.equal((await f.snapshot()).operationDraft.pendingActionId, preview.pendingAction.pendingActionId);
});

test('A6.2.1 comprame keeps PURCHASE through product choice, quantity and supplier without asking SALE', async t => {
  const f = fixture(t);
  let result = await f.send('cómprame coca');
  assert.equal(result.agent, 'operations'); assert.equal(result.requiresClarification, true);
  assert.doesNotMatch(result.answer, /venta o una compra/);
  assert.equal((await f.snapshot()).operationDraft.action, 'create_purchase');
  assert.equal(f.prepared.length, 0);
  result = await f.send('opción 1');
  assert.match(result.answer, /Cuántas unidades/);
  assert.deepEqual((await f.snapshot()).operationDraft.missingFields, ['quantity']);
  result = await f.send('10');
  if (!result.pendingAction) result = await f.send('opción 1');
  assert.equal(result.pendingAction.action, 'create_purchase');
  assert.equal(result.pendingAction.items[0].quantity, 10);
  assert.equal(f.confirmations.length, 0);
});

test('A6.2.1 yesterday movement is a SALE narrative with exact quantity/reference, not a historical write', async t => {
  const f = fixture(t), result = await f.send('ayer salieron 4 lays');
  assert.equal(result.agent, 'operations'); assert.equal(result.requiresClarification, true);
  assert.match(result.answer, /registrar una venta de 4 unidades de lays/);
  assert.doesNotMatch(result.answer, /venta o una compra/);
  const draft = (await f.snapshot()).operationDraft;
  assert.equal(draft.action, 'create_sale'); assert.deepEqual(draft.items, [{ ref: 'lays', quantity: 4 }]);
  assert.deepEqual(draft.missingFields, ['registrationIntent']);
  assert.equal(draft.date, undefined); assert.equal(f.resolutions.length, 0);
  await f.send('confirmar'); assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0);
});

for (const [message, quantities, refs] of [
  ['vende 1 coca cola, 1 papas lays y 2 leches', [1, 1, 2], ['coca cola', 'papas lays', 'leches']],
  ['registra una venta de 2 coca colas, 3 aguas y 1 paquete de galletas', [2, 3, 1], ['coca colas', 'aguas', 'paquete de galletas']],
  ['compra 10 coca colas y 5 leches', [10, 5], ['coca colas', 'leches']],
  ['compra diez coca colas y cinco leches', [10, 5], ['coca colas', 'leches']]
]) test(`A5.3 parse preserves line order and quantities: ${message}`, () => {
  const parsed = parseAction(message, actionIntent(message));
  assert.deepEqual(parsed.items.map(item => item.quantity), quantities); assert.deepEqual(parsed.items.map(item => item.ref), refs);
});

test('A5.3 exact plus two ambiguous sale lines resolve sequentially to one canonical preview', async t => {
  const f = fixture(t); let result = await f.send('vende 1 LAYS-001, 1 coca cola y 2 leches');
  assert.match(result.answer, /Línea 2 de 3.*coca cola.*1 unidad/);
  assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0);
  result = await f.send('opción 1');
  assert.match(result.answer, /Línea 3 de 3.*leches.*2 unidades/); assert.equal(f.prepared.length, 0);
  const draft = (await f.snapshot()).operationDraft;
  assert.deepEqual(draft.items.map(item => item.quantity), [1, 1, 2]);
  assert.equal(draft.items[1].requestedRef, 'coca cola'); assert.equal(draft.items[0].ref, id(3));
  result = await f.send('la segunda');
  assert.equal(f.prepared.length, 1); assert.deepEqual(f.prepared[0].products.map(row => row.quantity), [1, 1, 2]);
  assert.deepEqual(result.pendingAction.items.map(row => row.sku), ['LAYS-001', 'COLA-001', 'LECHE-002']);
  assert.equal(result.pendingAction.fields.total, 17);
  assert.deepEqual(result.pendingAction.items.map(row => [row.stock, row.resultingStock]), [[20, 19], [20, 19], [20, 18]]);
  assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.confirmations.length, 0);
  await f.send('confirmar'); await f.send('confirmar'); assert.equal(f.confirmations.length, 1);
});

test('A5.3 unknown line can be corrected without discarding the other quantities', async t => {
  const f = fixture(t); let result = await f.send('vende 1 LAYS-001, 2 Inexistente y 3 LECHE-001');
  assert.match(result.answer, /Línea 2 de 3/); assert.equal(f.prepared.length, 0);
  await f.send('opción 1');
  const draft = (await f.snapshot()).operationDraft;
  assert.equal(draft.items[1].ref, 'Inexistente'); assert.equal(draft.items[1].quantity, 2);
  result = await f.send('SKU COLA-001');
  assert.equal(f.prepared.length, 1, result.answer);
  assert.deepEqual(f.prepared[0].products.map(row => row.quantity), [1, 2, 3]);
  assert.deepEqual(result.pendingAction.items.map(row => row.sku), ['LAYS-001', 'COLA-001', 'LECHE-001']);
  assert.equal(f.confirmations.length, 0);
});

test('A5.3 human quantities and ambiguous products remain distinct through every selection', async t => {
  const f = fixture(t); let result = await f.send('vende una coca cola, unas lays y dos leches');
  assert.equal(f.prepared.length, 0); result = await f.send('opción 1');
  assert.match(result.answer, /Línea 2 de 3.*cantidad por indicar/);
  result = await f.send('3'); assert.match(result.answer, /Línea 3 de 3.*2 unidades/);
  result = await f.send('opción 2');
  assert.equal(f.prepared.length, 1, result.answer);
  assert.deepEqual(f.prepared[0].products.map(row => row.quantity), [1, 3, 2]); assert.equal(f.confirmations.length, 0);
  assert.equal(result.usage.totalLlmCalls, 0);
});

test('A5.3 indefinite plural asks for its own quantity rather than inventing one', async t => {
  const f = fixture(t); let result = await f.send('vende una COLA-001, unas LAYS-001 y dos LECHE-001');
  assert.equal(f.prepared.length, 0); assert.match(result.answer, /Línea 2 de 3.*cantidad por indicar/);
  result = await f.send('3'); assert.equal(f.prepared.length, 1, result.answer);
  assert.deepEqual(f.prepared[0].products.map(row => row.quantity), [1, 3, 2]); assert.equal(f.confirmations.length, 0);
});

test('A5.3 common supplier and each configured cost survive multi-product purchase selections', async t => {
  const f = fixture(t); let result = await f.send('compra diez coca colas y cinco leches');
  assert.equal(f.prepared.length, 0); result = await f.send('opción 2');
  assert.match(result.answer, /Línea 2 de 2.*5 unidades/);
  result = await f.send('opción 1');
  assert.equal(f.prepared.length, 0); assert.equal(result.suggestionsEntityType, 'supplier');
  assert.match(result.suggestions[0].detail, /COLA-002: 3 PEN.*LECHE-001: 4 PEN/);
  result = await f.send('opción 1'); assert.equal(f.prepared.length, 1, result.answer);
  assert.equal(f.prepared[0].vendorId, id(101));
  assert.deepEqual(result.pendingAction.items.map(row => [row.quantity, row.price, row.resultingStock]), [[10, 3, 30], [5, 4, 25]]);
  assert.equal(result.pendingAction.fields.total, 50); assert.equal(f.confirmations.length, 0);
  await f.send('confirmar'); await f.send('confirmar'); assert.equal(f.confirmations.length, 1);
});

test('A5.3 disjoint supplier offers cannot prepare a split or partial purchase', async t => {
  const products = structuredClone(catalog);
  products[0].supplierPrices = [products[0].supplierPrices[0]]; products[3].supplierPrices = [products[3].supplierPrices[1]];
  const f = fixture(t, { products }), result = await f.send('compra 10 COLA-001 y 5 LECHE-001');
  assert.match(result.answer, /proveedor común/); assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0);
  await f.send('confirmar'); assert.equal(f.confirmations.length, 0);
});

for (const message of ['vende 1 coca cola y 2 leches', 'vende 1 COLA-001 y 2 LECHE-001'])
  test(`A5.3 cancel stops the whole draft without writes: ${message}`, async t => {
    const f = fixture(t); await f.send(message); await f.send('cancelar'); await f.send('confirmar');
    assert.equal(f.confirmations.length, 0); assert.equal((await f.snapshot()).operationDraft, null);
    assert.ok([...f.pending.values()].every(row => row.status === 'CANCELLED'));
  });

test('A5.3 insufficient stock rejects the complete sale before preparation', async t => {
  const products = structuredClone(catalog); products[3].stock = 1;
  const f = fixture(t, { products }), result = await f.send('vende 1 COLA-001 y 2 LECHE-001');
  assert.match(result.answer, /Solicitaste 2 unidades.*solo hay 1 unidad/);
  assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0);
  assert.equal(products[0].stock, 20); assert.equal(products[3].stock, 1);
  const corrected = await f.send('Cambiar cantidad del producto 2 a 1');
  assert.equal(f.prepared.length, 1, corrected.answer); assert.equal(f.confirmations.length, 0);
  assert.deepEqual(f.prepared[0].products.map(row => row.quantity), [1, 1]);
});

test('A5.3 draft restoration preserves resolved lines, requested references and remaining quantities', async t => {
  const f = fixture(t); await f.send('vende 1 coca cola y 2 leches'); await f.send('opción 1');
  const state = await f.snapshot();
  assert.deepEqual(state.operationDraft.items.map(row => row.quantity), [1, 2]);
  const resumed = fixture(t); await resumed.restore(state);
  const result = await resumed.send('opción 2');
  assert.equal(resumed.prepared.length, 1, result.answer);
  assert.deepEqual(resumed.prepared[0].products, [{ productId: id(1), quantity: 1 }, { productId: id(5), quantity: 2 }]);
  assert.equal(resumed.confirmations.length, 0);
});

test('A5.3 operation type cannot be inferred from an unspecified registration', async t => {
  const f = fixture(t), result = await f.send('quiero registrar 2 cocacolas y 3 aguas');
  assert.equal(result.requiresClarification, true); assert.match(result.answer, /venta o una compra/);
  assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0); assert.equal(result.usage.totalLlmCalls, 0);
});

test('A5.3 repeated SKU quantities are validated together, not as independent available stock', async t => {
  const f = fixture(t), result = await f.send('vende 2 COLA-001 y 19 COLA-001');
  assert.match(result.answer, /Solicitaste 21 unidades/); assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0);
});

test('A5.3 cancellation while choosing common supplier leaves no preview or execution', async t => {
  const f = fixture(t); const result = await f.send('compra 10 COLA-001 y 5 LECHE-001');
  assert.equal(result.suggestionsEntityType, 'supplier'); await f.send('cancelar'); await f.send('confirmar');
  assert.equal(f.prepared.length, 0); assert.equal(f.confirmations.length, 0);
});

test('A5.3 service preview rejects a complete multi-product sale when any later line lacks stock', async t => {
  const products = structuredClone(catalog); products[3].stock = 1;
  fixture(t, { products });
  await assert.rejects(writeTransaction({ businessId: 'SYNTHETIC-MULTI', preview: true, session: {},
    historical: { date: '2026-10-20T12:00:00Z', exchangeRates: { 'USD/PEN': 3.8 } },
    input: { type: 'sale', currency: 'PEN', paymentMethod: 'cash',
      products: [{ productId: id(1), quantity: 1 }, { productId: id(4), quantity: 2 }] } }), /Insufficient stock/);
  assert.equal(products[0].stock, 20); assert.equal(products[3].stock, 1);
});
