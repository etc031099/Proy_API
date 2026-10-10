const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const Connection = require('../src/models/TelegramConnection');
const { updatePreferences, getStatus } = require('../src/controllers/telegramController');
test('preferences reject tenant/destination/token/unknown fields and update only authenticated business', async t => {
  const calls = [];
  t.mock.method(Connection, 'findOneAndUpdate', async (filter, update) => { calls.push({ filter, update }); return update.$set; });
  const app = express(); app.use(express.json());
  app.patch('/preferences', (req, res, next) => { req.businessId = 'A'; next(); }, updatePreferences);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const patch = body => fetch(`http://127.0.0.1:${server.address().port}/preferences`, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const body of [{ businessId: 'B' }, { chatId: '123' }, { token: 'secret' }, { lowStockAlertsEnabled: false },
      { stockRuleAlertsEnabled: 'true' }, {}, []]) assert.equal((await patch(body)).status, 400);
    assert.equal(calls.length, 0);
    const result = await patch({ stockRuleAlertsEnabled: true, stockRuleResolvedAlertsEnabled: false });
    assert.equal(result.status, 200); assert.deepEqual(calls[0].filter, { businessId: 'A' });
    assert.deepEqual(calls[0].update, { $set: { stockRuleAlertsEnabled: true, stockRuleResolvedAlertsEnabled: false } });
    assert.doesNotMatch(await result.text(), /businessId|chatId|token/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('legacy status exposes false opt-ins without chat or connection secrets', async t => {
  t.mock.method(require('../src/services/telegramService'), 'getConnection', async () => ({ enabled: true, lowStockAlertsEnabled: true,
    chatId: 'private-chat', connectionCodeHash: 'private-code' }));
  const result = await new Promise((resolve, reject) => getStatus({ businessId: 'A' }, { json: resolve }, reject));
  assert.equal(result.data.stockRuleAlertsEnabled, false); assert.equal(result.data.stockRuleResolvedAlertsEnabled, false);
  assert.equal(result.data.lowStockAlertsEnabled, true);
  assert.doesNotMatch(JSON.stringify(result), /private-chat|private-code/);
});
test('preferences remain behind existing authenticate and checkBusinessAccess middleware', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/routes/telegram'), 'utf8');
  assert.ok(source.indexOf('router.use(authenticate)') < source.indexOf("router.patch('/preferences'"));
  assert.ok(source.indexOf('router.use(checkBusinessAccess)') < source.indexOf("router.patch('/preferences'"));
});
