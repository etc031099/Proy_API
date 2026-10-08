const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentError, createAgentExecution, createAgentRequestContext, createGeminiProvider,
  getToolDeclarations, executeRequestedSkill, classifyAgentIntent, validateRoutingOutput, SKILLS
} = require('../src/agents');
const { GeminiProviderError, providerError } = require('../src/agents/providers/geminiProvider');

const id = '507f1f77bcf86cd799439011';
const context = () => createAgentRequestContext({ user: { _id: id, businessId: 'AG-DEMO', role: 'user', isActive: true }, businessId: 'AG-DEMO' });
const usageMetadata = { promptTokenCount: 41, candidatesTokenCount: 8, thoughtsTokenCount: 3,
  cachedContentTokenCount: 4, toolUsePromptTokenCount: 5, totalTokenCount: 63 };
const response = (text = '{"intent":"business_query","targetAgent":"analyst","requiresClarification":false}', overrides = {}) => ({
  text, usageMetadata, ...overrides
});
const providerErrorCode = expected => error => error instanceof GeminiProviderError && error.code === expected;
const agentErrorCode = expected => error => error instanceof AgentError && error.code === expected;
const call = (fakeResponse, captured = {}) => ({ models: { async generateContent(request) {
  captured.request = request;
  if (fakeResponse instanceof Error) throw fakeResponse;
  if (typeof fakeResponse === 'function') return fakeResponse(request);
  return fakeResponse;
} }, tokens: { async count() { captured.tokenCountCalls = (captured.tokenCountCalls || 0) + 1; } } });
const llmRecord = (usage = {}) => ({ model: 'gemini-3.8-flash', latencyMs: 12, usage });

test('Gemini client is lazily created with one request attempt, output budgets and low thinking', async () => {
  const captured = {};
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call(response(), captured), now: (() => { let value = 10; return () => value++; })() });
  const result = await provider.generateStructured({ agentId: 'analyst',
    systemInstruction: 'Clasificador compacto.', messages: [{ role: 'user', text: '¿Cuánto vendimos este mes?' }],
    schema: { type: 'OBJECT', properties: { intent: { type: 'STRING' } }, required: ['intent'] } });
  assert.deepEqual(result.output, { intent: 'business_query', targetAgent: 'analyst', requiresClarification: false });
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(result.latencyMs, 1);
  assert.equal(captured.request.model, 'gemini-3.8-flash');
  assert.equal(captured.request.config.maxOutputTokens, 1024);
  assert.deepEqual(captured.request.config.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(captured.request.config.automaticFunctionCalling.disable, true);
  assert.equal(captured.request.config.httpOptions.timeout, 15000);
  assert.equal(captured.request.config.httpOptions.retryOptions.attempts, 1);
  assert.equal(captured.tokenCountCalls || 0, 0);
});

test('Gemini provider hard output ceilings are separate from visible response targets', async () => {
  const cases = [
    ['coordinator', 100, 512],
    ['operations', 200, 768],
    ['analyst', 450, 1024]
  ];
  for (const [agentId, responseTargetTokens, providerMaxOutputTokens] of cases) {
    const captured = {};
    const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call(response('OK'), captured) });
    await provider.generate({ agentId, systemInstruction: 'Breve.', messages: [{ role: 'user', text: 'Estado?' }] });
    assert.equal(captured.request.config.maxOutputTokens, providerMaxOutputTokens);
    assert.deepEqual(captured.request.config.thinkingConfig, { thinkingLevel: 'low' });
    const { getAgentDefinition } = require('../src/agents/definitions');
    assert.equal(getAgentDefinition(agentId).limits.responseTargetTokens, responseTargetTokens);
    assert.equal(getAgentDefinition(agentId).limits.providerMaxOutputTokens, providerMaxOutputTokens);
  }
});

test('Gemini captures provider usage fields and preserves totalTokenCount verbatim', async () => {
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call(response()) });
  const result = await provider.generateStructured({ agentId: 'coordinator', systemInstruction: 'Classify safely.',
    messages: [{ role: 'user', text: '¿Cuánto vendimos este mes?' }], schema: { type: 'OBJECT' } });
  assert.deepEqual(result.usage, { usageAvailable: true, inputTokens: 41, outputTokens: 8, thoughtTokens: 3,
    cachedInputTokens: 4, toolUseTokens: 5, totalTokens: 63 });
  assert.notEqual(result.usage.totalTokens, result.usage.inputTokens + result.usage.outputTokens);
});

test('partial and absent usage metadata remain unknown, never estimated', async () => {
  for (const [metadata, expected] of [[{ promptTokenCount: 9, totalTokenCount: 14 },
    { usageAvailable: true, inputTokens: 9, outputTokens: null, thoughtTokens: null, cachedInputTokens: null, toolUseTokens: null, totalTokens: 14 }],
  [undefined, { usageAvailable: false, inputTokens: null, outputTokens: null, thoughtTokens: null, cachedInputTokens: null, toolUseTokens: null, totalTokens: null }]]) {
    const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call(response(undefined, { usageMetadata: metadata })) });
    const result = await provider.generateStructured({ agentId: 'operations', systemInstruction: 'Route safely.',
      messages: [{ role: 'user', text: 'Busca arroz.' }], schema: { type: 'OBJECT' } });
    assert.deepEqual(result.usage, expected);
  }
});

test('Gemini distinguishes invalid JSON, schema mismatch, empty and truncated structured responses', async () => {
  const noKey = createGeminiProvider({});
  await assert.rejects(noKey.generate({ agentId: 'analyst', systemInstruction: 'Safe.', messages: [{ role: 'user', text: 'Hola' }] }),
    providerErrorCode('GEMINI_NOT_CONFIGURED'));
  const structuredInput = { agentId: 'coordinator', systemInstruction: 'Safe.',
    messages: [{ role: 'user', text: 'Hola' }], schema: { type: 'OBJECT', properties: { status: { type: 'STRING', enum: ['ok'] } }, required: ['status'], additionalProperties: false } };
  const cases = [
    [response('not json'), 'GEMINI_INVALID_JSON', 'structured'],
    [response('{}'), 'GEMINI_SCHEMA_VALIDATION_FAILED', 'structured'],
    [response(''), 'GEMINI_EMPTY_RESPONSE', 'empty'],
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }], usageMetadata }, 'GEMINI_OUTPUT_TRUNCATED', 'empty']
  ];
  for (const [sdkResponse, expected, expectedKind] of cases) {
    const p = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call(sdkResponse) });
    await assert.rejects(p.generateStructured(structuredInput), error => error.code === expected
      && error.diagnostics?.responseKind === expectedKind);
  }
  const p = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call(response()) });
  for (const text of ['contacta a persona@example.com', 'mi teléfono 987654321', `id ${id}`, 'x'.repeat(2001)]) {
    await assert.rejects(p.generate({ agentId: 'analyst', systemInstruction: 'Safe.', messages: [{ role: 'user', text }] }),
      agentErrorCode('AGENT_INVALID_REQUEST'));
  }
  await assert.rejects(p.generate({ agentId: 'analyst', systemInstruction: 'x'.repeat(2000),
    messages: [{ role: 'user', text: 'y'.repeat(2000) }, { role: 'model', text: 'z'.repeat(2000) }, { role: 'user', text: 'w' }] }),
  providerErrorCode('GEMINI_BUDGET_EXCEEDED'));
});

test('SDK candidate parts provide usable text when response.text is absent and STOP is normal', async () => {
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call({ candidates: [
    { finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }
  ], usageMetadata }) });
  const result = await provider.generate({ agentId: 'operations', systemInstruction: 'Short.', messages: [{ role: 'user', text: 'Status?' }] });
  assert.equal(result.text, 'OK');
  assert.deepEqual(result.diagnostics, { responseKind: 'text', candidateCount: 1, finishReason: ['STOP'],
    hasText: true, hasFunctionCall: false, hasUsageMetadata: true });
});

test('structured output validates parsed JSON semantically against the supplied schema', async () => {
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"status":"ok","agent":"operations"}' }] } }], usageMetadata
  }) });
  const result = await provider.generateStructured({ agentId: 'coordinator', systemInstruction: 'Compact.',
    messages: [{ role: 'user', text: 'Classify.' }], schema: { type: 'OBJECT', properties: {
      status: { type: 'STRING', enum: ['ok'] }, agent: { type: 'STRING', enum: ['operations'] }
    }, required: ['status', 'agent'], additionalProperties: false } });
  assert.deepEqual(result.output, { status: 'ok', agent: 'operations' });
  assert.equal(result.diagnostics.responseKind, 'structured');
});

test('function call response is accepted without text and diagnostics stay structural', async () => {
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'get_low_stock_products', args: { limit: 3 } } }] } }],
    usageMetadata
  }) });
  const result = await provider.generateWithTools({ agentId: 'operations', systemInstruction: 'Use permitted tools.',
    messages: [{ role: 'user', text: 'Low stock?' }] });
  assert.deepEqual(result.toolCalls, [{ name: 'get_low_stock_products', args: { limit: 3 } }]);
  assert.equal(result.text, '');
  assert.deepEqual(result.diagnostics, { responseKind: 'function_call', candidateCount: 1, finishReason: ['STOP'],
    hasText: false, hasFunctionCall: true, hasUsageMetadata: true });
});

test('tool selection with text but no call preserves an empty toolCalls array', async () => {
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call(response('Necesito aclaración.')) });
  const result = await provider.generateWithTools({ agentId: 'operations', systemInstruction: 'Solo tools permitidas.',
    messages: [{ role: 'user', text: 'Ayuda.' }] });
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.text, 'Necesito aclaración.');
});

test('malformed function calls fail safely with structural diagnostics', async () => {
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'invalid name', args: {} } }] } }]
  }) });
  await assert.rejects(provider.generateWithTools({ agentId: 'operations', systemInstruction: 'Use permitted tools.',
    messages: [{ role: 'user', text: 'Low stock?' }] }), error => error.code === 'GEMINI_INVALID_RESPONSE'
      && error.diagnostics?.responseKind === 'function_call' && error.diagnostics.hasFunctionCall);
});

test('tool declarations contain only READY skills allowed in both registries', () => {
  const operations = getToolDeclarations('operations');
  const analyst = getToolDeclarations('analyst');
  assert.ok(operations.length > 0);
  assert.equal(getToolDeclarations('coordinator').length, 0);
  for (const [agentId, declarations] of [['operations', operations], ['analyst', analyst]]) {
    for (const tool of declarations) {
      const skill = SKILLS.find(row => row.id === tool.name);
      assert.ok(skill);
      assert.equal(skill.executorStatus, 'READY');
      assert.equal(skill.readOnly, true);
      assert.ok(skill.allowedAgents.includes(agentId));
      assert.ok(!['businessId', 'userId', 'role', 'filter', 'url'].some(key => Object.hasOwn(tool.parametersJsonSchema.properties, key)));
      assert.equal(tool.parametersJsonSchema.additionalProperties, false);
    }
  }
  assert.ok(operations.some(tool => tool.name === 'get_low_stock_products'));
  assert.ok(!operations.some(tool => tool.name === 'get_demand_forecast'));
  assert.ok(analyst.some(tool => tool.name === 'get_demand_forecast'));
  assert.ok(!analyst.some(tool => tool.name === 'get_supplier_details'));
  assert.ok(Object.isFrozen(operations));
});

test('provider tool response is only a suggestion; server validates and invokes read-only executor', async () => {
  const product = { _id: id, businessId: 'AG-DEMO', sku: 'AG-SKU-1', name: 'Synthetic arroz',
    category: 'Abarrotes', stock: 1, minStockLevel: 5, isActive: true };
  let pipelineSeen;
  const models = { Product: { aggregate(pipeline) {
    pipelineSeen = pipeline;
    return { option({ maxTimeMS }) { assert.equal(maxTimeMS, 5000); return this; }, async exec() {
      assert.equal(pipeline[0].$match.businessId, 'AG-DEMO');
      return [{ data: [{ ...product, shortage: 4 }], count: [{ total: 1 }] }];
    } };
  } } };
  const fakeProvider = { async generateStructured() { throw new Error('unused'); }, async generateWithTools() {
    return { toolCalls: [{ name: 'get_low_stock_products', args: { limit: 1 } }], ...llmRecord({ usageAvailable: true,
      inputTokens: 41, outputTokens: 8, thoughtTokens: 3, cachedInputTokens: 4, toolUseTokens: 5, totalTokens: 63 }) };
  } };
  const execution = createAgentExecution({ context: context(), provider: fakeProvider, dependencies: { models } });
  const generated = await execution.generateWithTools({ agentId: 'operations', systemInstruction: 'Use only listed read tools.',
    messages: [{ role: 'user', text: '¿Qué producto tiene poco stock?' }] });
  assert.deepEqual(generated.toolCalls[0].args, { limit: 1 });
  const result = await executeRequestedSkill(execution, 'operations', generated.toolCalls[0]);
  assert.equal(result.data[0].shortage, 4);
  assert.equal(pipelineSeen[0].$match.businessId, 'AG-DEMO');
  const usage = execution.finish();
  assert.equal(usage.totalLlmCalls, 1);
  assert.equal(usage.totalSkillCalls, 1);
  assert.equal(usage.totalInputTokens, 41);
  assert.equal(usage.totalOutputTokens, 8);
  assert.equal(usage.totalTokens, 63);
  assert.equal(usage.totalToolUseTokens, 5);
  assert.equal(usage.agents[0].llmCalls, 1);
});

test('tool arguments still pass the skill schema, and unauthorized/pending calls never execute', async () => {
  for (const [name, args, agentId, expected] of [
    ['get_low_stock_products', { limit: 999 }, 'operations', 'AGENT_INVALID_SKILL_ARGS'],
    ['get_demand_forecast', {}, 'operations', 'AGENT_SKILL_NOT_ALLOWED'],
    ['get_inventory_summary', {}, 'operations', 'AGENT_EXECUTOR_NOT_READY']
  ]) {
    const provider = { generateStructured: async () => ({}), generateWithTools: async () => ({ toolCalls: [{ name, args }],
      ...llmRecord({ usageAvailable: false, inputTokens: null, outputTokens: null, thoughtTokens: null, cachedInputTokens: null, toolUseTokens: null, totalTokens: null }) }) };
    const execution = createAgentExecution({ context: context(), provider });
    const result = await execution.generateWithTools({ agentId, systemInstruction: 'Use approved tools only.',
      messages: [{ role: 'user', text: 'Consulta inventario.' }] });
    await assert.rejects(executeRequestedSkill(execution, agentId, result.toolCalls[0]), agentErrorCode(expected));
    assert.equal(execution.getUsage().totalSkillCalls, 0);
    assert.equal(execution.finish().totalLlmCalls, 1);
  }
});

test('tool request payloads and client diagnostics never reach events', async () => {
  const seen = [];
  const provider = { generateStructured: async () => ({}), generateWithTools: async () => ({ toolCalls: [],
    ...llmRecord({ usageAvailable: false, inputTokens: null, outputTokens: null, thoughtTokens: null, cachedInputTokens: null, toolUseTokens: null, totalTokens: null }) }) };
  const execution = createAgentExecution({ context: context(), provider, onEvent: event => seen.push(event) });
  await execution.generateWithTools({ agentId: 'operations', systemInstruction: 'Keep data minimal.',
    messages: [{ role: 'user', text: 'Consulta ventas.' }] });
  assert.equal(JSON.stringify(seen).includes('Consulta ventas'), false);
  assert.equal(JSON.stringify(seen).includes('synthetic-test-key'), false);
  assert.equal(seen.filter(event => event.type === 'llm_started').length, 1);
  assert.equal(seen.filter(event => event.type === 'llm_finished')[0].totalTokens, null);
  assert.equal(execution.finish().metricsComplete, false);
});

test('429, 5xx, timeout and missing metadata become bounded errors and real call accounting', async () => {
  for (const [error, expected] of [[Object.assign(new Error('raw key'), { status: 429 }), 'GEMINI_RATE_LIMITED'],
    [Object.assign(new Error('raw provider body'), { status: 503 }), 'GEMINI_UNAVAILABLE'],
    [Object.assign(new Error('request timeout'), { name: 'TimeoutError' }), 'GEMINI_TIMEOUT']]) {
    const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: call(error) });
    const execution = createAgentExecution({ context: context(), provider });
    await assert.rejects(execution.generateStructured({ agentId: 'coordinator', systemInstruction: 'Classify only.',
      messages: [{ role: 'user', text: 'Consulta simple.' }], schema: { type: 'OBJECT' } }), agentErrorCode(expected));
    const usage = execution.finish();
    assert.equal(usage.totalLlmCalls, 1);
    assert.equal(usage.totalTokens, null);
    assert.equal(usage.metricsComplete, false);
    assert.equal(JSON.stringify(execution.getEvents()).includes('raw'), false);
  }
});

test('provider errors preserve only safe status, category, provider code and retryability', () => {
  const cases = [
    [Object.assign(new Error('private key detail'), { status: 401 }), 'GEMINI_AUTHENTICATION_FAILED', 401, false],
    [Object.assign(new Error('permission denied'), { status: 403, error: { status: 'PERMISSION_DENIED' } }), 'GEMINI_PERMISSION_DENIED', 403, false],
    [Object.assign(new Error('models/gemini-3.8-flash not found'), { status: 404 }), 'GEMINI_MODEL_NOT_FOUND', 404, false],
    [Object.assign(new Error('quota exhausted'), { status: 429, error: { status: 'RESOURCE_EXHAUSTED' } }), 'GEMINI_RATE_LIMITED', 429, true],
    [Object.assign(new Error('upstream failure'), { status: 503 }), 'GEMINI_UNAVAILABLE', 503, true],
    [Object.assign(new Error('request timeout'), { name: 'TimeoutError' }), 'GEMINI_TIMEOUT', null, true],
    [Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }), 'GEMINI_NETWORK_ERROR', null, true]
  ];
  for (const [rawError, category, httpStatus, retryable] of cases) {
    const normalized = providerError(rawError);
    assert.equal(normalized.code, category);
    assert.equal(normalized.category, category);
    assert.equal(normalized.httpStatus, httpStatus);
    assert.equal(normalized.retryable, retryable);
    assert.equal(JSON.stringify(normalized).includes('private key detail'), false);
    if (rawError.error?.status) assert.equal(normalized.providerCode, rawError.error.status);
  }
});

test('response parsing failures carry safe response metadata into the correlated error event', async () => {
  const events = [];
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', model: 'gemini-3.8-flash', timeoutMs: 12000,
    client: call(response('not-json', { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not-json' }] } }] })) });
  const execution = createAgentExecution({ context: context(), provider, onEvent: event => events.push(event) });
  await assert.rejects(execution.generateStructured({ agentId: 'analyst', systemInstruction: 'Clasificación breve.',
    messages: [{ role: 'user', text: '¿Cuánto vendimos?' }], schema: { type: 'OBJECT', properties: { intent: { type: 'STRING' } }, required: ['intent'] } }),
  agentErrorCode('GEMINI_INVALID_JSON'));
  execution.finish();
  const diagnostic = events.find(event => event.type === 'error' && event.internalCause === 'GEMINI_INVALID_JSON');
  assert.ok(diagnostic); assert.equal(diagnostic.publicCode, 'AGENT_PROVIDER_FAILED');
  assert.equal(diagnostic.model, 'gemini-3.8-flash'); assert.equal(diagnostic.timeoutMs, 12000);
  assert.equal(diagnostic.responseKind, 'structured'); assert.equal(diagnostic.candidateCount, 1);
  assert.equal(diagnostic.finishReason, 'STOP'); assert.equal(diagnostic.hasText, true);
  assert.equal(diagnostic.hasUsageMetadata, true); assert.equal(diagnostic.usageAvailable, true);
  assert.equal(diagnostic.metricsComplete, true); assert.ok(Number.isFinite(diagnostic.llmDurationMs));
  const serialized = JSON.stringify(events);
  for (const forbidden of ['synthetic-test-key', 'not-json', 'Clasificación breve', '¿Cuánto vendimos?']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('one 503 retry stays one logical LLM call and counts only successful-attempt usage', async () => {
  let calls = 0;
  const events = [];
  const provider = { async generateStructured() {
    calls++;
    if (calls === 1) throw Object.assign(new Error('temporary provider failure'), { status: 503 });
    return { output: { intent: 'business_query', targetAgent: 'analyst', requiresClarification: false },
      ...llmRecord({ usageAvailable: true, inputTokens: 41, outputTokens: 8, thoughtTokens: 3,
        cachedInputTokens: 4, toolUseTokens: 5, totalTokens: 63 }) };
  }, async generateWithTools() { throw new Error('unused'); } };
  const execution = createAgentExecution({ context: context(), provider, onEvent: event => events.push(event) });
  const result = await execution.generateStructured({ agentId: 'coordinator', systemInstruction: 'Classify.',
    messages: [{ role: 'user', text: 'Synthetic question.' }], schema: { type: 'OBJECT' } });
  const usage = execution.finish();
  assert.equal(calls, 2); assert.equal(result.output.intent, 'business_query');
  assert.equal(usage.totalLlmCalls, 1); assert.equal(usage.totalTokens, 63);
  assert.equal(usage.totalInputTokens, 41); assert.equal(usage.totalOutputTokens, 8);
  assert.ok(usage.totalProviderLatencyMs >= 1000);
  const attempts = events.filter(event => event.type === 'provider_attempt');
  assert.equal(attempts.length, 2); assert.equal(attempts[0].providerAttempt, 1);
  assert.equal(attempts[0].status, 'FAILED'); assert.equal(attempts[0].providerStatus, 503);
  assert.equal(attempts[0].internalCause, 'GEMINI_UNAVAILABLE'); assert.equal(attempts[0].retryScheduled, true);
  assert.equal(attempts[0].retryReason, 'GEMINI_UNAVAILABLE'); assert.equal(attempts[0].retryDelayMs, 1000);
  assert.equal(attempts[1].providerAttempt, 2); assert.equal(attempts[1].status, 'SUCCEEDED');
  assert.equal(attempts[1].retryReason, 'GEMINI_UNAVAILABLE'); assert.equal(attempts[1].providerAttempts, 2);
  assert.ok(Number.isFinite(attempts[0].firstAttemptDurationMs));
  assert.ok(Number.isFinite(attempts[1].secondAttemptDurationMs));
  assert.ok(attempts[1].totalProviderDurationMs >= 1000);
  const finished = events.find(event => event.type === 'llm_finished');
  assert.equal(finished.providerAttempts, 2); assert.equal(finished.totalTokens, 63);
  assert.equal(events.filter(event => event.type === 'llm_started').length, 1);
});

test('a second transient failure returns the final provider error with two attempts and one logical call', async () => {
  let calls = 0;
  const events = [];
  const execution = createAgentExecution({ context: context(), onEvent: event => events.push(event), provider: {
    async generateStructured() { calls++; throw Object.assign(new Error('temporary'), { status: 503 }); },
    async generateWithTools() { throw new Error('unused'); }
  } });
  await assert.rejects(execution.generateStructured({ agentId: 'coordinator', systemInstruction: 'Classify.',
    messages: [{ role: 'user', text: 'Synthetic question.' }], schema: { type: 'OBJECT' } }), agentErrorCode('GEMINI_UNAVAILABLE'));
  const usage = execution.finish();
  assert.equal(calls, 2); assert.equal(usage.totalLlmCalls, 1); assert.equal(usage.totalTokens, null);
  const attempts = events.filter(event => event.type === 'provider_attempt');
  assert.equal(attempts.length, 2); assert.equal(attempts[0].retryScheduled, true);
  assert.equal(attempts[1].providerAttempt, 2); assert.equal(attempts[1].status, 'FAILED');
  assert.equal(attempts[1].retryScheduled, false); assert.equal(attempts[1].publicCode, 'AGENT_PROVIDER_FAILED');
  assert.equal(attempts[1].providerStatus, 503);
});

test('normalized timeout and network failures may each use the single bounded retry', async () => {
  for (const transient of [
    new GeminiProviderError('GEMINI_TIMEOUT', { retryable: true, timeoutMs: 15000 }),
    new GeminiProviderError('GEMINI_NETWORK_ERROR', { retryable: true })
  ]) {
    let calls = 0;
    const events = [];
    const execution = createAgentExecution({ context: context(), onEvent: event => events.push(event), provider: {
      async generateStructured() {
        calls++;
        if (calls === 1) throw transient;
        return { output: { intent: 'business_query', targetAgent: 'analyst', requiresClarification: false },
          ...llmRecord({ usageAvailable: true, inputTokens: 41, outputTokens: 8, thoughtTokens: null,
            cachedInputTokens: null, toolUseTokens: null, totalTokens: 49 }) };
      },
      async generateWithTools() { throw new Error('unused'); }
    } });
    const result = await execution.generateStructured({ agentId: 'coordinator', systemInstruction: 'Classify.',
      messages: [{ role: 'user', text: 'Synthetic question.' }], schema: { type: 'OBJECT' } });
    const usage = execution.finish();
    assert.equal(result.output.intent, 'business_query');
    assert.equal(calls, 2);
    assert.equal(usage.totalLlmCalls, 1);
    assert.equal(usage.totalTokens, 49);
    const attempts = events.filter(event => event.type === 'provider_attempt');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].internalCause, transient.code);
    assert.equal(attempts[0].retryScheduled, true);
    assert.equal(attempts[1].providerAttempt, 2);
    assert.equal(attempts[1].status, 'SUCCEEDED');
  }
});

test('auth, permission, model, 429 and invalid response failures never retry', async () => {
  const cases = [
    [Object.assign(new Error('auth'), { status: 401 }), 'GEMINI_AUTHENTICATION_FAILED'],
    [Object.assign(new Error('permission'), { status: 403 }), 'GEMINI_PERMISSION_DENIED'],
    [Object.assign(new Error('missing model'), { status: 404 }), 'GEMINI_MODEL_NOT_FOUND'],
    [Object.assign(new Error('quota'), { status: 429 }), 'GEMINI_RATE_LIMITED'],
    [new GeminiProviderError('GEMINI_INVALID_JSON'), 'GEMINI_INVALID_JSON']
  ];
  for (const [providerErrorValue, expected] of cases) {
    let calls = 0;
    const events = [];
    const execution = createAgentExecution({ context: context(), onEvent: event => events.push(event), provider: {
      async generateStructured() { calls++; throw providerErrorValue; }, async generateWithTools() { throw new Error('unused'); }
    } });
    await assert.rejects(execution.generateStructured({ agentId: 'coordinator', systemInstruction: 'Classify.',
      messages: [{ role: 'user', text: 'Synthetic question.' }], schema: { type: 'OBJECT' } }), agentErrorCode(expected));
    assert.equal(execution.finish().totalLlmCalls, 1);
    assert.equal(calls, 1, expected);
    assert.equal(events.filter(event => event.type === 'provider_attempt').length, 1);
    assert.equal(events.find(event => event.type === 'provider_attempt').retryScheduled, false);
  }
});

test('the SDK timeout abort signal fires and the error is sanitized', async () => {
  let signal;
  const client = { models: { async generateContent({ config }) {
    signal = config.abortSignal;
    return new Promise(() => {});
  } } };
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', timeoutMs: 1000, client });
  await assert.rejects(provider.generate({ agentId: 'operations', systemInstruction: 'Short.',
    messages: [{ role: 'user', text: 'Resume ventas.' }] }), providerErrorCode('GEMINI_TIMEOUT'));
  assert.equal(signal.aborted, true);
});

test('LLM budget stops the fourth attempt before provider call; skills remain separately counted', async () => {
  let calls = 0;
  const provider = { async generateStructured() { calls++; return { output: { intent: 'clarification', targetAgent: 'coordinator',
    requiresClarification: true }, ...llmRecord({ usageAvailable: false, inputTokens: null, outputTokens: null, thoughtTokens: null,
      cachedInputTokens: null, toolUseTokens: null, totalTokens: null }) }; }, async generateWithTools() { throw new Error('unexpected'); } };
  const execution = createAgentExecution({ context: context(), provider });
  for (let n = 0; n < 3; n++) await execution.generateStructured({ agentId: 'coordinator', systemInstruction: 'Route.',
    messages: [{ role: 'user', text: 'Necesito ayuda.' }], schema: { type: 'OBJECT' } });
  await assert.rejects(execution.generateStructured({ agentId: 'coordinator', systemInstruction: 'Route.',
    messages: [{ role: 'user', text: 'Necesito ayuda.' }], schema: { type: 'OBJECT' } }), agentErrorCode('AGENT_BUDGET_EXCEEDED'));
  assert.equal(calls, 3);
  assert.equal(execution.finish().totalLlmCalls, 3);
});

test('routing output requires semantic consistency after syntactically valid JSON', async () => {
  assert.deepEqual(validateRoutingOutput({ intent: 'business_query', targetAgent: 'operations', requiresClarification: false }),
    { intent: 'business_query', targetAgent: 'operations', requiresClarification: false });
  for (const value of [null, [], { intent: 'business_query', targetAgent: 'coordinator', requiresClarification: false },
    { intent: 'clarification', targetAgent: 'analyst', requiresClarification: true },
    { intent: 'clarification', targetAgent: 'coordinator', requiresClarification: false },
    { intent: 'business_query', targetAgent: 'operations', requiresClarification: 'false' },
    { intent: 'business_query', targetAgent: 'operations', requiresClarification: false, businessId: 'TENANT-B' }]) {
    assert.throws(() => validateRoutingOutput(value), agentErrorCode('GEMINI_INVALID_RESPONSE'));
  }
  const provider = { async generateStructured() { return { output: { intent: 'business_query', targetAgent: 'coordinator', requiresClarification: false },
    ...llmRecord({ usageAvailable: false, inputTokens: null, outputTokens: null, thoughtTokens: null, cachedInputTokens: null,
      toolUseTokens: null, totalTokens: null }) }; }, async generateWithTools() { throw new Error('unused'); } };
  const execution = createAgentExecution({ context: context(), provider });
  await assert.rejects(classifyAgentIntent(execution, '¿Cuánto vendimos?'), agentErrorCode('GEMINI_INVALID_RESPONSE'));
  assert.equal(execution.finish().totalLlmCalls, 1);
});

test('structured classifier returns validated intent and exact real usage', async () => {
  const provider = { async generateStructured() { return { output: { intent: 'clarification', targetAgent: 'coordinator', requiresClarification: true },
    ...llmRecord({ usageAvailable: true, inputTokens: 10, outputTokens: 4, thoughtTokens: 0, cachedInputTokens: 0, toolUseTokens: 0, totalTokens: 19 }) }; },
  async generateWithTools() { throw new Error('unused'); } };
  const execution = createAgentExecution({ context: context(), provider });
  assert.deepEqual(await classifyAgentIntent(execution, 'Necesito un reporte.'),
    { intent: 'clarification', targetAgent: 'coordinator', requiresClarification: true });
  assert.equal(execution.finish().totalTokens, 19);
});
