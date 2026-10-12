const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { read, products } = require('./audit/p3bFixtures');
const { productCandidateSelection } = require('../src/agents/orchestrator');
const createAgentRoutes = require('../src/routes/agent');
const { withActionAssistant } = require('../src/automations/assistant');

const visibleName = 'Alimentos M5 · FOODS_2 · Ítem 096';
const sku = 'M5-FOODS_2_096';
const fixture = () => read.fixture({ products: [{ ...products[0], minStockLevel: 3 }, products[1], products[2]] });
const zero = result => {
  assert.ok(result.code == null, result.code);
  assert.equal(result.requiresClarification, false);
  assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.pendingAction, undefined);
};

for (const name of [visibleName, visibleName.normalize('NFD'), 'Alimentos M5 · FOODS_2 · Item 096',
  'Alimentos M5 FOODS_2 Item 096', 'Alimentos  M5 · FOODS_2 · Ítem 096',
  'Alimentos M5 · FOODS_2 · Ítem 0096', sku, 'food 96']) {
  test(`P3C.3.1 search → visible selection → retry → minimum: ${name}`, async () => {
    const f = fixture(), conversationId = randomUUID();
    const found = await f.run('Busca food 96', conversationId); zero(found);
    assert.equal(found.intent, 'search_product');
    const snapshot = await f.orchestrator.getContextSnapshot(read.req(), conversationId);
    assert.equal(snapshot.lastProductSelection.items.length, 1);
    assert.equal(snapshot.lastProductSelection.items[0].label, visibleName);
    for (let attempt = 0; attempt < 2; attempt++) {
      // A short alias is a selection within the current search snapshot. Full
      // display names and exact SKUs also resolve after that snapshot is consumed.
      if (attempt && name === 'food 96') await f.run('Busca food 96', conversationId);
      const selected = await f.run(name, conversationId); zero(selected);
      assert.deepEqual(selected.actions.map(row => row.skillId), ['get_product_details']);
      assert.match(selected.answer, /M5-FOODS_2_096/);
      const state = await f.orchestrator.getContextSnapshot(read.req(), conversationId);
      assert.equal(state.selectedProductReference.sku, sku);
      assert.equal(state.lastEntity.sku, sku);
    }
    const minimum = await f.run('¿Y el stock mínimo?', conversationId); zero(minimum);
    assert.match(minimum.answer, /M5-FOODS_2_096.*es 3 unidades/);
    assert.equal(f.calls.length, 0);
  });
}

test('P3C.3.1 standalone exact visible name uses a tenant-scoped detail skill without previous state', async () => {
  const f = fixture();
  zero(await f.run(visibleName));
  assert.ok(f.reads.some(row => row.model === 'Product' && row.match?.sku === sku && row.match.businessId === 'A'));
  assert.equal(f.calls.length, 0);
});

test('P3C.3.1 compact label selection preserves READ intent, product and period', () => {
  const period = { startDate: '2026-10-08', endDate: '2026-10-08' };
  const state = { lastProductSelection: { sourceIntent: 'search_product', continuationIntent: 'product_sales_summary',
    continuationPeriod: period, items: [{ id: products[0]._id, label: visibleName, sku },
      { id: products[1]._id, label: products[1].name, sku: products[1].sku }] } };
  const selected = productCandidateSelection(visibleName, state).plan;
  assert.equal(selected.intent, 'product_sales_summary');
  assert.deepEqual(selected.period, period);
  assert.equal(selected.selector.productId, products[0]._id);
  assert.equal(selected.selectedProduct.label, visibleName);
});

test('P3C.3.1 mismatched item identifiers never select 096 from a cached search', async () => {
  for (const item of ['196', '960', '97']) {
    const f = fixture(), conversationId = randomUUID();
    await f.run('Busca food 96', conversationId);
    const result = await f.run(`food ${item}`, conversationId);
    assert.equal(result.requiresClarification, true);
    assert.equal(result.usage.totalLlmCalls, 0);
    assert.equal(result.usage.totalSkillCalls, 0);
    assert.equal((await f.orchestrator.getContextSnapshot(read.req(), conversationId)).selectedProductReference, null);
  }
});

test('P3C.3.1 exact cloud sequence and same-message retry pass through the production HTTP route', async t => {
  const f = fixture();
  const forbid = () => assert.fail('READ sequence must never invoke action service');
  const actionService = { prepare: forbid, confirmPendingAction: forbid, cancelPendingAction: forbid };
  const runtime = withActionAssistant(f.orchestrator, actionService);
  const app = express(); app.use(express.json());
  app.use('/api/agent', createAgentRoutes({ enabled: true, orchestrator: f.orchestrator, actionService,
    authenticateMiddleware(req, res, next) { req.user = read.req().user; next(); },
    businessAccessMiddleware(req, res, next) { req.businessId = req.user.businessId; next(); },
    historyService: { send: (req, input) => runtime.handle(req, input) } }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  let conversationId;
  for (const message of ['Busca food 96', visibleName, visibleName, '¿Y el stock mínimo?']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }) });
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.success, true); zero(body.data);
    if (conversationId) assert.equal(body.data.conversationId, conversationId);
    conversationId = body.data.conversationId;
    if (message === '¿Y el stock mínimo?') assert.match(body.data.answer, /M5-FOODS_2_096.*es 3 unidades/);
  }
  assert.equal(f.calls.length, 0);
});
