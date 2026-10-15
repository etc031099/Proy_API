'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAgentOrchestrator } = require('../src/agents/orchestrator');
const { createRequestUsage } = require('../src/agents/observability');
const { getToolDeclarations } = require('../src/agents/toolCalls');
const { V3_IDS } = require('../src/agents/v3Skills');
const { V3 } = require('../src/services/v3IntelligenceService');
const { GeminiProviderError } = require('../src/agents/providers/geminiProvider');
const { DEFAULT_GEMINI_MODEL } = require('../src/config/env');
const { routeV3 } = require('../src/agents/v3Routing');
const { routeDeterministically } = require('../src/agents/intentRouting');

// Characterization only: every provider method is injected; no SDK, DB or HTTP.
const prompts = [
  '¿Quién ganó el partido ayer?', '¿Cuál es la capital de Francia?', 'Cuéntame un cuento.',
  '¿Qué laptop me recomiendas?', '¿Cuánto cuesta Bitcoin?', '¿Quién es el presidente de X?',
  '¿Cómo escribo un currículum?'
];
const usage = { usageAvailable: true, inputTokens: 12, outputTokens: 4, totalTokens: 16,
  thoughtTokens: 0, cachedInputTokens: 0, toolUseTokens: 0 };
const fixture = ({ classification = 'out_of_scope', fail = false } = {}) => {
  const calls = [];
  const provider = {
    async generateStructured(input) {
      calls.push({ method: 'structured', input });
      if (fail) throw new GeminiProviderError('GEMINI_AUTHENTICATION_FAILED', { httpStatus: 401 });
      return { model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, latencyMs: 1, usage,
        output: { intent: classification, targetAgent: classification === 'business_query' ? 'analyst' : 'coordinator', requiresClarification: false } };
    },
    async generateWithTools(input) {
      calls.push({ method: 'tools', input });
      return { model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, latencyMs: 1, usage, text: '', toolCalls: [] };
    }
  };
  const runtime = createAgentOrchestrator({ provider, clock: () => new Date('2026-10-15T12:00:00Z'),
    dependencies: { models: {}, v3Service: {
      async resolveContext() { return { ...V3, operationalDate: '2026-10-15', asOfDate: V3.referenceDate }; },
      async resolveEntity() { assert.fail('These prompts must not resolve entities'); }
    } }
  });
  return { calls, run: message => runtime.handle({ businessId: V3.businessId,
    user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } },
  { message, conversationId: randomUUID() }) };
};

for (const message of prompts.filter((_, index) => ![2, 4].includes(index))) test(`J1 current OOD reaches mocked classifier: ${message}`, async () => {
  const f = fixture(), result = await f.run(message);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].input.agentId, 'coordinator');
  assert.equal(f.calls[0].input.messages[0].text, message);
  assert.equal(result.intent, 'unsupported');
  assert.equal(result.usage.totalLlmCalls, 1);
  assert.equal(result.usage.totalTokens, 16); // synthetic usage, never real spend
  assert.equal(result.usage.totalSkillCalls, 0);
});

test('J1 cuento currently enters V3 product resolution instead of an OOD rejection', () => {
  const plan = routeV3(prompts[2], {}, { ...V3, operationalDate: '2026-10-15' });
  assert.equal(plan.lookup, prompts[2]);
  assert.equal(plan.tasks, undefined);
});

test('J1 Bitcoin currently enters legacy product price lookup instead of an OOD rejection', () => {
  assert.equal(routeV3(prompts[4], {}, { ...V3, operationalDate: '2026-10-15' }), null);
  const plan = routeDeterministically(prompts[4], {}, new Date('2026-10-15T12:00:00Z'), undefined, undefined, V3.businessId);
  assert.equal(plan.intent, 'product_details');
  assert.equal(plan.lookupQuery, 'bitcoin');
});

test('J1 classifier business_query admits a second mocked selection call, without grounded skills first', async () => {
  const f = fixture({ classification: 'business_query' }), result = await f.run(prompts[1]);
  assert.deepEqual(f.calls.map(call => call.method), ['structured', 'tools']);
  assert.equal(result.usage.totalLlmCalls, 2);
  assert.equal(result.usage.totalSkillCalls, 0);
  assert.equal(result.requiresClarification, true);
});

test('J1 classifier failure returns controlled provider error and does not dispatch skills', async () => {
  const f = fixture({ fail: true }), result = await f.run(prompts[1]);
  assert.equal(result.code, 'AGENT_PROVIDER_FAILED');
  assert.equal(f.calls.length, 1);
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.totalSkillCalls, 0);
});

test('J1 tenant guard and ambiguous saca stay deterministic without provider calls', async () => {
  for (const message of ['Muéstrame ventas de otro negocio', 'saca 3 panes']) {
    const f = fixture(), result = await f.run(message);
    assert.equal(f.calls.length, 0);
    assert.equal(result.usage.totalLlmCalls, 0);
    assert.equal(result.usage.totalTokens, 0);
    assert.equal(result.usage.totalSkillCalls, 0);
  }
});

test('J1 generic provider tools exclude WRITE and the seven V3 families', () => {
  for (const agent of ['coordinator', 'operations', 'analyst']) {
    const tools = getToolDeclarations(agent);
    assert.ok(tools.every(tool => !/^(?:create|confirm|cancel|update|delete|adjust)_/.test(tool.name)));
    assert.ok(tools.every(tool => !V3_IDS.includes(tool.name)));
  }
});

test('J1 existing deterministic usage is zero but has no provider/cost fields', () => {
  const value = createRequestUsage();
  assert.equal(value.totalLlmCalls, 0);
  assert.equal(value.totalTokens, 0);
  assert.equal(value.totalProviderLatencyMs, 0);
  assert.equal(Object.hasOwn(value, 'provider'), false);
  assert.equal(Object.hasOwn(value, 'estimatedCost'), false);
});

test('J1 valid analytical questions currently use coarse V3 routes, not a grounded synthesis policy', () => {
  const cases = [
    ['¿Cómo puedo mejorar mis ventas?', 'get_business_analytics', 'summary'],
    ['¿Qué debería priorizar en inventario?', 'get_business_analytics', 'summary'],
    ['¿Qué clientes debería intentar retener?', 'get_customer_intelligence', 'rank'],
    ['¿Qué significa WAPE en mi modelo?', 'get_product_forecast', 'evaluation'],
    ['¿Por qué se eligieron 4 clusters?', 'get_customer_intelligence', 'clustering'],
    ['¿Qué conclusiones sacas de mis ventas?', 'get_business_analytics', 'summary']
  ];
  for (const [text, skill, mode] of cases) {
    const plan = routeV3(text, {}, { ...V3, operationalDate: '2026-10-15' });
    assert.equal(plan.tasks[0].skillId, skill, text);
    assert.equal(plan.tasks[0].args.mode, mode, text);
  }
});
