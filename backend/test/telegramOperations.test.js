const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, update, callback } = require('./helpers/telegramOperationsFixture');
const { formatTelegramResponse } = require('../src/services/telegramFormatter');

test('Operations OFF rejects writes before preview and PendingAction', async () => {
  const x = fixture({ operationsEnabled: false }); await x.deliver(update(1, 'vende 2 COLA-001'));
  assert.equal(x.rows.size, 0); assert.match(x.response().answer, /todavía no están habilitadas/);
});
for (const [text, action, length] of [
  ['vende 2 COLA-001', 'create_sale', 1], ['vende 2 COLA-001 y 3 LAYS-001', 'create_sale', 2],
  ['compra 2 COLA-001 y 3 LAYS-001', 'create_purchase', 2], ['vende 2 COLA-001 y 3 COLA-001', 'create_sale', 1]
]) test(`existing Operations + gateway prepare preview only: ${text}`, async () => {
  const x = fixture(); await x.deliver(update(1, text));
  const pending = x.response()?.pendingAction; assert.ok(pending, JSON.stringify(x.f.state.receipts));
  assert.equal(pending.action, action); assert.equal(pending.items.length, length); assert.equal(x.executions.length, 0);
  if (text.endsWith('3 COLA-001')) assert.equal(pending.items[0].quantity, 5);
  const stored = x.rows.get(pending.pendingActionId);
  assert.equal(stored.sourceChannel, 'telegram'); assert.equal(stored.userId, x.f.state.conversations[0].userId);
  assert.equal(stored.conversationId, x.f.state.bindings[0].conversationId);
  const token = x.token('CONFIRM_ACTION'); assert.equal(token.pendingActionId, pending.pendingActionId);
  assert.equal(token.selectionMessage, undefined); assert.equal(token.sourceChannel, 'telegram');
  assert.match(x.f.sent.map(row => row.text).join('\n'), /Cantidad: (2|5) · (Precio|Costo): 2 PEN/);
  assert.match(x.f.sent.at(-1).text, /Stock: 20 →/);
  assert.ok(x.token('CANCEL_ACTION')); assert.ok(Buffer.byteLength(token.token) <= 64);
  await x.deliver(update(2, 'confirmar')); assert.equal(x.executions.length, 0);
});

test('one insufficient line blocks the entire sale before PendingAction/buttons', async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001 y 99 LAYS-001'));
  assert.equal(x.rows.size, 0); assert.match(x.response().answer, /solo hay 20/); assert.equal(x.token('CONFIRM_ACTION'), undefined);
});
test('no common supplier blocks purchase without splitting it', async () => {
  const x = fixture({ noSupplier: true }); await x.deliver(update(1, 'compra 2 COLA-001 y 3 LAYS-001'));
  assert.equal(x.rows.size, 0); assert.match(x.response().answer, /proveedor común/); assert.equal(x.executions.length, 0);
});
test('ambiguous multi-line choice uses opaque buttons and durable shared draft across restart', async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 1 coca y 2 leches'));
  assert.equal(x.rows.size, 0);
  let token = x.f.state.tokens.find(row => row.purpose === 'candidate' && /COLA-001/.test(row.label)); assert.ok(token);
  await x.deliver(callback(2, token)); assert.equal(x.rows.size, 0);
  token = x.f.state.tokens.find(row => row.purpose === 'candidate' && /LECHE-001/.test(row.label)); assert.ok(token);
  await x.deliver(callback(3, token));
  assert.deepEqual(x.response().pendingAction.items.map(i => [i.sku, i.quantity]), [['COLA-001', 1], ['LECHE-001', 2]]);
});
test('narrative clarifies registration; LLM/text never confirms a preview', async () => {
  const x = fixture(); await x.deliver(update(1, 'ayer salieron 4 lays'));
  assert.equal(x.rows.size, 0); assert.match(x.response().answer, /registrar una venta de 4/);
  await x.deliver(update(2, 'registra esta venta'));
  assert.equal(x.response().pendingAction.items[0].quantity, 4); assert.equal(x.executions.length, 0);
});
test('sale requires an explicit customer choice and preserves Consumer Final in the preview', async () => {
  const x = fixture({ actionOptions: { requireCustomerDecision: true } });
  await x.deliver(update(1, 'vende 2 COLA-001'));
  assert.equal(x.rows.size, 0); assert.match(x.response().answer, /Consumidor Final/);
  await x.deliver(update(2, 'venta normal'));
  assert.equal(x.response().pendingAction.customerId, null);
  assert.equal(x.response().pendingAction.fields.contact, 'Consumidor final');
  assert.equal(x.executions.length, 0);
});
test('cómprame coca preserves PURCHASE through selection and missing quantity', async () => {
  const x = fixture(); await x.deliver(update(1, 'cómprame coca'));
  assert.doesNotMatch(x.response().answer, /venta o una compra/);
  const token = x.f.state.tokens.find(row => row.purpose === 'candidate' && /COLA-001/.test(row.label)); assert.ok(token);
  await x.deliver(callback(2, token)); assert.match(x.response().answer, /Cuántas unidades/);
  await x.deliver(update(3, '10')); assert.equal(x.response().pendingAction.action, 'create_purchase');
  assert.equal(x.response().pendingAction.items[0].quantity, 10); assert.equal(x.executions.length, 0);
});

for (const kind of ['CONFIRM_ACTION', 'CANCEL_ACTION']) test(`${kind} targets the exact scoped gateway action`, async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001')); const token = x.token(kind);
  await x.deliver(callback(2, token));
  assert.equal(x.response().pendingAction.status, kind === 'CONFIRM_ACTION' ? 'EXECUTED' : 'CANCELLED');
  assert.equal(x.executions.length, kind === 'CONFIRM_ACTION' ? 1 : 0);
  assert.equal(x.response().pendingAction.pendingActionId, token.pendingActionId);
  assert.deepEqual(x.audits, [kind === 'CONFIRM_ACTION' ? 'EXECUTED' : 'CANCELLED']);
  if (kind === 'CONFIRM_ACTION') {
    assert.match(x.f.sent.at(-1).text, /Venta registrada correctamente/);
    assert.match(x.f.sent.at(-1).text, /ID de transacción: [a-f\d]{24}/i);
  }
});
test('concurrent double click and callback/update retries execute once and reuse the receipt', async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001')); const token = x.token('CONFIRM_ACTION'), t = x.f.make();
  const admitted = await Promise.all([t.admit(callback(2, token)), t.admit(callback(3, token))]);
  assert.equal(admitted[0].requestKey, admitted[1].requestKey);
  await Promise.all([t.recover(), x.f.make().recover()]);
  const messages = x.f.sent.length;
  await t.admit(callback(2, token)); await t.recover();
  assert.equal(x.executions.length, 1); assert.equal(x.f.sent.length, messages); assert.equal(x.rows.size, 1);
});
test('expired PendingAction closes clearly without revival even if callback TTL is later', async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001')); const token = x.token('CONFIRM_ACTION');
  x.rows.get(token.pendingActionId).expiresAt = new Date(0);
  await x.deliver(callback(2, token)); assert.equal(x.executions.length, 0);
  assert.match(x.f.sent.at(-1).text, /ya expiró/); assert.equal(x.response().pendingAction.status, 'EXPIRED');
});
for (const variant of ['old generation', 'foreign chat', 'foreign business', 'disabled user', 'ordinary user', 'manipulated token', 'wrong message', 'preview undelivered'])
  test(`${variant} cannot confirm an action`, async () => {
    const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001')); const token = x.token('CONFIRM_ACTION');
    let input = callback(2, token);
    if (variant === 'old generation') x.f.state.bindings[0].bindingGeneration++;
    if (variant === 'foreign chat') input = callback(2, token, token.messageId, 456);
    if (variant === 'foreign business') x.f.state.tokens.find(row => row.token === token.token).businessId = 'FOREIGN';
    if (variant === 'disabled user') x.f.user({ _id: token.systemUserId, businessId: token.businessId, role: 'user', isActive: false });
    if (variant === 'ordinary user') x.f.user({ _id: token.systemUserId, businessId: token.businessId, role: 'user', isActive: true });
    if (variant === 'manipulated token') input.callback_query.data = `t1:${'z'.repeat(22)}`;
    if (variant === 'wrong message') input.callback_query.message.message_id++;
    if (variant === 'preview undelivered') delete x.f.state.tokens.find(row => row.token === token.token).messageId;
    if (variant === 'ordinary user') {
      await x.deliver(input);
      assert.equal(x.f.state.receipts.at(-1).status, 'FAILED');
    } else await assert.rejects(x.f.make().admit(input));
    assert.equal(x.executions.length, 0);
  });
test('new preview invalidates old action buttons without affecting the current action', async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001')); const old = x.token('CONFIRM_ACTION');
  await x.deliver(update(2, 'vende 3 LAYS-001')); const current = x.token('CONFIRM_ACTION');
  await assert.rejects(x.f.make().admit(callback(3, old)), { code: 'TELEGRAM_CALLBACK_INVALID' });
  await x.deliver(callback(4, current)); assert.equal(x.executions.length, 1);
  assert.equal(x.executions[0].args.products[0].quantity, 3);
});
test('preview spanning multiple frames offers buttons only on the final frame', async () => {
  const x = fixture({ longPreview: true }); await x.deliver(update(1, 'vende 2 COLA-001'));
  assert.ok(x.f.sent.length > 1); assert.ok(x.f.sent.slice(0, -1).every(frame => !frame.reply_markup));
  assert.ok(x.f.sent.at(-1).reply_markup); assert.equal(x.token('CONFIRM_ACTION').messageId, x.f.sent.length);
});
test('incomplete authoritative preview cannot offer executable buttons', async () => {
  const x = fixture(); await x.deliver(update(1, 'compra 2 COLA-001'));
  const response = structuredClone(x.response()); delete response.pendingAction.fields.contact;
  assert.deepEqual(formatTelegramResponse(response).choices, []);
  const sale = structuredClone(response); sale.pendingAction.action = 'create_sale';
  assert.deepEqual(formatTelegramResponse(sale).choices, []);
});
test('restart after execution but before history persistence reconciles durable result without reexecution', async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001')); const token = x.token('CONFIRM_ACTION');
  x.f.crash(true); await x.deliver(callback(2, token)); assert.equal(x.executions.length, 1);
  assert.equal(x.f.state.receipts.at(-1).status, 'UNCERTAIN');
  x.f.crash(false); x.f.advance(121000); await x.f.make().recover();
  assert.equal(x.executions.length, 1); assert.equal(x.f.state.receipts.at(-1).status, 'COMPLETED');
  assert.match(x.f.sent.at(-1).text, /Venta registrada correctamente/);
});
test('restart with PENDING gateway result remains uncertain and never retries execution', async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001')); const token = x.token('CONFIRM_ACTION');
  await x.f.make().admit(callback(2, token)); const receipt = x.f.state.receipts.at(-1);
  const claim = await x.f.repository.claim(receipt._id); await x.f.repository.invoke(claim);
  x.f.state.messages.find(m => m.requestKey === receipt.requestKey).status = 'pending';
  x.f.advance(121000); await x.f.make().recover();
  assert.equal(x.executions.length, 0); assert.equal(x.f.state.receipts.at(-1).status, 'UNCERTAIN');
});
test('delivery UNKNOWN after EXECUTED never repeats the write or the ambiguous send', async () => {
  const x = fixture(); await x.deliver(update(1, 'vende 2 COLA-001')); const token = x.token('CONFIRM_ACTION');
  x.f.failSend(true); await x.deliver(callback(2, token)); assert.equal(x.executions.length, 1);
  const sent = x.f.sent.length; x.f.failSend(false); x.f.advance(121000); await x.f.make().recover();
  assert.equal(x.f.state.receipts.at(-1).status, 'DELIVERY_UNKNOWN');
  await x.f.make().admit(callback(3, token)); await x.f.make().recover();
  assert.equal(x.executions.length, 1); assert.equal(x.f.sent.length, sent);
});
