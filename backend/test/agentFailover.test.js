const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createAgentExecution, createAgentRequestContext, createGeminiProvider } = require('../src/agents');
const { GeminiProviderError } = require('../src/agents/providers/geminiProvider');
const { parseFallbackModels } = require('../src/agents/providers/failover');
const PRIMARY = 'gemini-3.8-flash';
const FALLBACKS = ['gemini-3.7-flash', 'gemini-3.6-flash'];
const input = { agentId: 'analyst', systemInstruction: 'Respuesta breve.', messages: [{ role: 'user', text: 'Consulta ficticia.' }],
  schema: { type: 'OBJECT', properties: { sections: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['sections'] } };
const usage = { usageAvailable: true, inputTokens: 10, outputTokens: 3, thoughtTokens: 2,
  cachedInputTokens: null, toolUseTokens: null, totalTokens: 15 };
const transient = () => new GeminiProviderError('GEMINI_UNAVAILABLE', { httpStatus: 503, retryable: true });
const setup = (t, outcomes) => {
  const original = process.env.GEMINI_FALLBACK_MODELS;
  process.env.GEMINI_FALLBACK_MODELS = FALLBACKS.join(',');
  t.after(() => original === undefined ? delete process.env.GEMINI_FALLBACK_MODELS : process.env.GEMINI_FALLBACK_MODELS = original);
  const calls = [], events = [];
  const generate = async model => {
    calls.push(model);
    const outcome = outcomes.shift();
    if (typeof outcome === 'function') return outcome(model);
    if (outcome instanceof Error) throw outcome;
    return { output: { sections: [0] }, model, latencyMs: 1, usage };
  };
  const provider = { generateStructured: () => generate(PRIMARY), generateWithTools: () => generate(PRIMARY),
    forModel: model => ({ generateStructured: () => generate(model), generateWithTools: () => generate(model) }) };
  const context = createAgentRequestContext({ user: { _id: '507f1f77bcf86cd799439011', businessId: 'DEMO', role: 'user', isActive: true }, businessId: 'DEMO' });
  return { calls, events, execution: createAgentExecution({ context, provider, onEvent: event => events.push(event) }) };
};

test('fallback config trims, removes blanks, duplicates and primary; rejects arbitrary names/excess models', () => {
  assert.deepEqual(parseFallbackModels(` , ${FALLBACKS[0]},${PRIMARY},${FALLBACKS[0]},${FALLBACKS[1]}, `, PRIMARY), FALLBACKS);
  assert.deepEqual(parseFallbackModels(undefined, PRIMARY), []);
  for (const value of ['https://internal', 'a,b,c', 'model secret', 1]) assert.throws(() => parseFallbackModels(value, PRIMARY));
});

for (const [label, outcomes, expected] of [
  ['principal success', [null], [PRIMARY]],
  ['principal retry success', [transient(), null], [PRIMARY, PRIMARY]],
  ['first fallback success', [transient(), transient(), null], [PRIMARY, PRIMARY, FALLBACKS[0]]],
  ['second fallback success', [transient(), transient(), transient(), null], [PRIMARY, PRIMARY, ...FALLBACKS]]
]) test(label + ' preserves one logical call and actual final model', async t => {
  const { execution, calls, events } = setup(t, [...outcomes]);
  const result = await execution.generateStructured(input);
  const totals = execution.finish();
  assert.deepEqual(calls, expected);
  assert.equal(result.model, expected.at(-1));
  assert.equal(totals.totalLlmCalls, 1);
  assert.equal(totals.totalTokens, 15);
  const generation = totals.providerGenerations[0];
  assert.equal(generation.providerAttempts, expected.length);
  assert.equal(generation.requestedModel, PRIMARY);
  assert.equal(generation.finalModel, expected.at(-1));
  assert.equal(generation.fallbackUsed, expected.length > 2);
  assert.equal(generation.fallbackIndex, Math.max(0, expected.length - 2));
  assert.equal(generation.totalKnownUsage.totalTokens, 15);
  assert.equal(generation.providerAttemptUsage[0].usage.totalTokens, expected.length === 1 ? 15 : null);
  assert.equal(events.filter(event => event.type === 'provider_attempt').length, expected.length);
  assert.equal(events.filter(event => event.type === 'llm_started').length, 1);
  assert.equal(events.at(-3).finalModel, result.model);
});

test('four transient failures stop and remain one logical failed generation', async t => {
  const { execution, calls, events } = setup(t, Array.from({ length: 4 }, transient));
  await assert.rejects(execution.generateStructured(input), error => error.code === 'GEMINI_UNAVAILABLE');
  const total = execution.finish();
  assert.equal(calls.length, 4); assert.equal(total.totalLlmCalls, 1);
  assert.equal(total.totalTokens, null);
  assert.equal(total.providerGenerations[0].totalKnownUsage.totalTokens, null);
  assert.equal(events.findLast(event => event.type === 'error').publicCode, 'AGENT_PROVIDER_FAILED');
});

for (const code of ['GEMINI_AUTHENTICATION_FAILED', 'GEMINI_PERMISSION_DENIED', 'GEMINI_RATE_LIMITED',
  'GEMINI_MODEL_NOT_FOUND', 'GEMINI_INVALID_RESPONSE', 'GEMINI_INVALID_JSON', 'GEMINI_SCHEMA_VALIDATION_FAILED',
  'GEMINI_OUTPUT_TRUNCATED', 'GEMINI_BUDGET_EXCEEDED']) test(code + ' never retries or falls back', async t => {
  const { execution, calls } = setup(t, [new GeminiProviderError(code, { retryable: true })]);
  await assert.rejects(execution.generateStructured(input), error => error.code === code);
  assert.equal(calls.length, 1); assert.equal(execution.finish().totalLlmCalls, 1);
});

test('missing fallback stops without trying the next model or rotating credentials', async t => {
  const { execution, calls } = setup(t, [transient(), transient(), new GeminiProviderError('GEMINI_MODEL_NOT_FOUND')]);
  await assert.rejects(execution.generateStructured(input), error => error.code === 'GEMINI_MODEL_NOT_FOUND');
  assert.deepEqual(calls, [PRIMARY, PRIMARY, FALLBACKS[0]]); execution.finish();
});
test('non-allowlisted HTTP 501 never retries or falls back', async t => {
  const { execution, calls } = setup(t, [new GeminiProviderError('GEMINI_UNAVAILABLE', { httpStatus: 501, retryable: true })]);
  await assert.rejects(execution.generateStructured(input));
  assert.equal(calls.length, 1); execution.finish();
});

test('deadline refuses another fallback when less than two useful seconds remain', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const fail = duration => () => { now += duration; throw transient(); };
  const { execution, calls } = setup(t, [fail(14000), fail(14000), fail(11000), null]);
  await assert.rejects(execution.generateStructured(input));
  assert.deepEqual(calls, [PRIMARY, PRIMARY, FALLBACKS[0]]);
  assert.equal(execution.finish().providerGenerations[0].deadlineMs, 40000);
});

test('known failed-attempt usage stays separate from logical output usage; absent fields stay null', async t => {
  const failure = new GeminiProviderError('GEMINI_UNAVAILABLE', { httpStatus: 503, retryable: true,
    usage: { ...usage, totalTokens: 7, inputTokens: 4, outputTokens: 1, thoughtTokens: 2 } });
  const { execution } = setup(t, [failure, transient(), null]);
  await execution.generateStructured(input);
  const generation = execution.finish().providerGenerations[0];
  assert.equal(generation.logicalGenerationUsage.totalTokens, 15);
  assert.equal(generation.providerAttemptUsage[0].usage.totalTokens, 7);
  assert.equal(generation.providerAttemptUsage[1].usage.totalTokens, null);
  assert.equal(generation.totalKnownUsage.totalTokens, 22);
  assert.equal(generation.totalKnownUsage.cachedInputTokens, null);
  assert.equal(generation.attemptMetricsComplete, false);
});

test('all models use the same SDK client with low thinking, structured/tools capabilities and ceilings', async () => {
  const requests = [];
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: { models: {
    generateContent: async request => { requests.push(request); return { text: '{"sections":[0]}', usageMetadata: { totalTokenCount: 1 } }; }
  } } });
  for (const model of [PRIMARY, ...FALLBACKS]) {
    await provider.forModel(model).generateStructured(input);
    await provider.forModel(model).generateWithTools({ agentId: 'operations', systemInstruction: 'Elige una skill.', messages: input.messages });
  }
  for (const request of requests) {
    assert.equal(request.config.thinkingConfig.thinkingLevel, 'low');
    assert.equal(request.config.httpOptions.retryOptions.attempts, 1);
    assert.ok(request.config.responseSchema || request.config.tools);
    assert.equal(request.config.maxOutputTokens, request.config.tools ? 768 : 1024);
    assert.equal(request.config.httpOptions.timeout, 15000);
  }
});
