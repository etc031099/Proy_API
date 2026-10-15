'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./helpers/j2sProductFixture');
const createAgentRoutes = require('../src/routes/agent');
test('J3 real Express assistant route keeps OOD/clarification successful and invalid inputs controlled', async t => {
  const f = fixture(), app = express(); app.use(express.json());
  app.use('/api/agent', createAgentRoutes({ enabled: true, orchestrator: f.runtime,
    authenticateMiddleware: (req, res, next) => { req.user = f.request.user; next(); },
    businessAccessMiddleware: (req, res, next) => { req.businessId = f.request.businessId; next(); },
    actionService: { resolvePending: async () => undefined },
    historyService: { send: (req, input) => f.actions.handle(req, input) } }));
  const server = await new Promise((resolve, reject) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value)); value.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [message, status] of [['de q equipo eres hincha?', 200], ['cuentame un chiste', 200], ['1', 200],
    ['🔥🔥🔥', 200], ['', 400], [' ', 400], ['?', 400], ['x'.repeat(2001), 400]]) {
    await t.test(`HTTP length=${message.length} ${message.slice(0, 30)}`, async () => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
      const body = await res.json(); assert.equal(res.status, status); assert.equal(body.success, status === 200);
      if (status === 200) { assert.equal(body.data.usage.totalLlmCalls, 0); assert.equal(body.data.usage.totalTokens, 0);
        if (message.includes('hincha')) assert.equal(body.data.intent, 'out_of_domain'); }
      else assert.equal(body.code, 'AGENT_INVALID_REQUEST');
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE|reasoning_content|No fue posible consultar el asistente/);
    });
  }
  assert.equal(f.calls.length, 0); assert.equal(f.providerCalls.length, 0); assert.equal(f.mutations.length, 0);
});
