const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  AGENTS, SKILLS, EVENT_TYPES, EXECUTION_LIMITS, TOKEN_BUDGETS, AgentError,
  createAgentRequestContext, getAgentDefinition, getSkillDefinition,
  validateSkillInvocation, validateAgentMessage, createExecutionBudget,
  createTraceEvent, createRequestUsage, createEvidence, createAgentExecution
} = require('../src/agents');

const authenticatedRequest = () => ({
  user: { _id: '507f1f77bcf86cd799439011', businessId: 'TENANT-A', role: 'user', isActive: true },
  businessId: 'TENANT-A'
});
const context = () => createAgentRequestContext(authenticatedRequest());
const expectCode = code => error => error instanceof AgentError && error.code === code;
const invoke = (skillId, args, agentId = 'analyst') => validateSkillInvocation({ agentId, skillId, args, context: context() });

test('registry contains exactly three distinct immutable agent definitions', () => {
  assert.deepEqual(AGENTS.map(agent => agent.id), ['coordinator', 'operations', 'analyst']);
  assert.equal(new Set(AGENTS.map(agent => agent.id)).size, 3);
  for (const agent of AGENTS) {
    assert.equal(agent.version, '1.0.0');
    assert.ok(agent.displayName && agent.description && agent.responsibilities.length);
    assert.equal(agent.llmPolicy.providerEnabled, false);
    assert.ok(Object.isFrozen(agent) && Object.isFrozen(agent.allowedSkills));
    assert.equal(Reflect.set(agent, 'version', 'tampered'), false);
  }
  assert.deepEqual(getAgentDefinition('coordinator').allowedSkills, []);
  assert.equal(getAgentDefinition('analyst').llmPolicy.preferredMode, 'hybrid');
});

test('all thirteen skills are unique read-only contracts with nine implemented executors', () => {
  assert.equal(SKILLS.length, 13);
  assert.equal(new Set(SKILLS.map(skill => skill.id)).size, 13);
  for (const skill of SKILLS) {
    assert.equal(skill.readOnly, true);
    assert.ok(['READY', 'PENDING_IMPLEMENTATION'].includes(skill.executorStatus));
    assert.equal(skill.inputSchema.additionalProperties, false);
    assert.ok(Number.isSafeInteger(skill.maxRecords) && skill.maxRecords > 0);
    assert.ok(Number.isSafeInteger(skill.timeoutMs) && skill.timeoutMs > 0);
    assert.ok(skill.dataSensitivity && skill.outputSchema.description);
    assert.ok(Object.isFrozen(skill.inputSchema.properties));
    assert.equal(new Set(skill.allowedAgents).size, skill.allowedAgents.length);
  }
  assert.equal(SKILLS.filter(skill => skill.executorStatus === 'READY').length, 9);
});

test('permissions match in both directions for every agent and skill', () => {
  for (const agent of AGENTS) {
    assert.equal(new Set(agent.allowedSkills).size, agent.allowedSkills.length);
    for (const skillId of agent.allowedSkills) assert.ok(getSkillDefinition(skillId));
    for (const skill of SKILLS) {
      assert.equal(agent.allowedSkills.includes(skill.id), skill.allowedAgents.includes(agent.id), `${agent.id}/${skill.id}`);
    }
  }
});

test('context takes identities only from the authenticated user and freezes the result', () => {
  const req = authenticatedRequest();
  req.body = { businessId: 'TENANT-B', userId: 'different', role: 'admin', requestId: randomUUID(), conversationId: randomUUID() };
  req.query = { businessId: 'TENANT-B' };
  const result = createAgentRequestContext(req);
  assert.equal(result.businessId, 'TENANT-A');
  assert.equal(result.userId, req.user._id);
  assert.equal(result.role, 'user');
  assert.equal(result.conversationId, undefined);
  assert.notEqual(result.requestId, req.body.requestId);
  assert.equal(Reflect.set(result, 'businessId', 'TENANT-B'), false);
  req.user.businessId = 'TENANT-B';
  assert.equal(result.businessId, 'TENANT-A');
});

test('context rejects missing/inactive users, malformed identity and mismatched middleware tenant', () => {
  for (const req of [undefined, {}, { user: { ...authenticatedRequest().user, isActive: false } },
    { user: { ...authenticatedRequest().user, _id: 'bad-id' } },
    { user: { ...authenticatedRequest().user, role: 'superuser' } },
    { user: { ...authenticatedRequest().user, businessId: ' ' } },
    { ...authenticatedRequest(), businessId: 'TENANT-B' }]) {
    assert.throws(() => createAgentRequestContext(req), expectCode('AGENT_INVALID_REQUEST'));
  }
});

test('context accepts only an explicit server conversation ID and cannot be forged or copied', () => {
  const conversationId = randomUUID();
  const result = createAgentRequestContext(authenticatedRequest(), { conversationId });
  assert.equal(result.conversationId, conversationId);
  assert.throws(() => createAgentRequestContext(authenticatedRequest(), { conversationId: 'bad' }), expectCode('AGENT_INVALID_REQUEST'));
  assert.throws(() => validateSkillInvocation({ agentId: 'analyst', skillId: 'get_demand_forecast', args: {},
    context: Object.freeze({ ...result }) }), expectCode('AGENT_INVALID_REQUEST'));
});

test('internal factories reject malformed envelopes with controlled errors', async () => {
  for (const input of [undefined, null, [], true]) {
    assert.throws(() => validateSkillInvocation(input), expectCode('AGENT_INVALID_REQUEST'));
    assert.throws(() => createAgentExecution(input), expectCode('AGENT_INVALID_REQUEST'));
  }
  assert.throws(() => createAgentRequestContext(authenticatedRequest(), null), expectCode('AGENT_INVALID_REQUEST'));
  assert.throws(() => createRequestUsage(null), expectCode('AGENT_INVALID_REQUEST'));
  const execution = createAgentExecution({ context: context() });
  await assert.rejects(execution.executeSkill(null), expectCode('AGENT_INVALID_REQUEST'));
  await assert.rejects(execution.executeSkill({ agentId: 'analyst', skillId: 'get_demand_forecast', context: context() }), expectCode('AGENT_INVALID_REQUEST'));
  assert.equal(execution.finish().totalSkillCalls, 0);
});

test('all registered schemas accept their canonical minimal arguments without coercion', () => {
  const dates = { startDate: '2025-01-01', endDate: '2025-01-31' };
  const productId = '507f1f77bcf86cd799439011';
  const examples = {
    search_products: { query: 'arroz', limit: 20 }, get_product_details: { productId },
    get_low_stock_products: { limit: 20 }, get_inventory_summary: {}, get_recent_transactions: {},
    get_sales_summary: dates, get_purchase_summary: dates, get_business_summary: { period: 'latest' },
    get_supplier_details: { supplierId: productId }, get_top_selling_products: { ...dates, limit: 10 },
    get_product_sales_summary: { ...dates, sku: 'SKU-1' }, get_demand_forecast: {}, get_replenishment_candidates: { limit: 20 }
  };
  for (const skill of SKILLS) {
    const args = examples[skill.id];
    const invocation = invoke(skill.id, args, skill.allowedAgents[0]);
    assert.deepEqual(invocation.args, args, skill.id);
    assert.ok(Object.isFrozen(invocation.args));
    assert.notEqual(invocation.args, args);
  }
});

test('every schema rejects tenant, identity, privilege, arbitrary query and URL fields', () => {
  for (const skill of SKILLS) {
    for (const field of ['businessId', 'userId', 'role', 'filter', '$where', 'url', 'unknown', 'maxRecords']) {
      assert.throws(() => invoke(skill.id, { [field]: 'untrusted' }, skill.allowedAgents[0]),
        expectCode('AGENT_INVALID_SKILL_ARGS'), `${skill.id}/${field}`);
    }
  }
});

test('schemas reject non-object inputs, coercible numbers and hidden extra fields', () => {
  for (const args of [null, [], [1], true, 'text', { limit: '5' }, { limit: NaN }, { limit: Infinity },
    { limit: 1.5 }, { limit: 0 }, { limit: -1 }, { [Symbol('hidden')]: 1 }]) {
    assert.throws(() => invoke('get_low_stock_products', args), expectCode('AGENT_INVALID_SKILL_ARGS'));
  }
  assert.throws(() => invoke('get_low_stock_products', Object.create({ limit: 5 })), expectCode('AGENT_INVALID_SKILL_ARGS'));
  assert.throws(() => invoke('get_low_stock_products', JSON.parse('{"__proto__":{}}')), expectCode('AGENT_INVALID_SKILL_ARGS'));
});

test('list limits accept their maximum and reject records above each cap', () => {
  for (const skill of SKILLS.filter(entry => entry.inputSchema.properties.limit)) {
    const args = skill.id === 'search_products' ? { query: 'SKU' }
      : skill.id === 'get_top_selling_products' ? { startDate: '2025-01-01', endDate: '2025-01-31' } : {};
    const agentId = skill.allowedAgents[0];
    assert.equal(invoke(skill.id, { ...args, limit: skill.maxRecords }, agentId).args.limit, skill.maxRecords);
    assert.throws(() => invoke(skill.id, { ...args, limit: skill.maxRecords + 1 }, agentId), expectCode('AGENT_INVALID_SKILL_ARGS'));
  }
});

test('date ranges validate calendar days, order and paired optional filters', () => {
  assert.equal(invoke('get_sales_summary', { startDate: '2024-02-29', endDate: '2024-02-29' }).args.startDate, '2024-02-29');
  for (const args of [{ startDate: '2025-02-29', endDate: '2025-03-01' },
    { startDate: '2025-04-31', endDate: '2025-05-01' },
    { startDate: '2025-01-31', endDate: '2025-01-01' },
    { startDate: '01/01/2025', endDate: '2025-01-31' }, { startDate: '2025-01-01' }]) {
    assert.throws(() => invoke('get_sales_summary', args), expectCode('AGENT_INVALID_SKILL_ARGS'));
  }
  assert.throws(() => invoke('get_recent_transactions', { endDate: '2025-01-31' }, 'operations'), expectCode('AGENT_INVALID_SKILL_ARGS'));
});

test('product selectors require exactly one valid ID or bounded SKU', () => {
  const productId = '507f1f77bcf86cd799439011';
  for (const args of [{}, { productId: 'invalid' }, { sku: '' }, { sku: ' ' }, { sku: 'x'.repeat(101) }, { productId, sku: 'SKU' }]) {
    assert.throws(() => invoke('get_product_details', args), expectCode('AGENT_INVALID_SKILL_ARGS'));
  }
  assert.equal(invoke('get_product_details', { sku: 'SKU-1' }).args.sku, 'SKU-1');
  assert.equal(invoke('get_demand_forecast', { productId }).args.productId, productId);
});

test('unknown skills and unauthorized agents fail before any executor lifecycle begins', async () => {
  const execution = createAgentExecution({ context: context() });
  await assert.rejects(execution.executeSkill({ agentId: 'analyst', skillId: 'executeMongoQuery' }), expectCode('AGENT_SKILL_NOT_FOUND'));
  await assert.rejects(execution.executeSkill({ agentId: 'operations', skillId: 'get_replenishment_candidates' }), expectCode('AGENT_SKILL_NOT_ALLOWED'));
  await assert.rejects(execution.executeSkill({ agentId: 'coordinator', skillId: 'get_demand_forecast' }), expectCode('AGENT_SKILL_NOT_ALLOWED'));
  await assert.rejects(execution.executeSkill({ agentId: 'missing', skillId: 'get_demand_forecast' }), expectCode('AGENT_INVALID_REQUEST'));
  assert.equal(execution.getUsage().totalSkillCalls, 0);
  assert.equal(execution.getEvents().some(event => event.type === 'skill_called'), false);
});

test('a pending executor returns a controlled error with trace correlation and zero LLM usage', async () => {
  const ctx = context();
  const execution = createAgentExecution({ context: ctx });
  await assert.rejects(execution.executeSkill({ agentId: 'analyst', skillId: 'get_inventory_summary' }), expectCode('AGENT_EXECUTOR_NOT_READY'));
  const usage = execution.finish();
  assert.equal(usage.totalSkillCalls, 0);
  assert.equal(usage.totalLlmCalls, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.metricsComplete, true);
  assert.equal(usage.agents[0].usageAvailable, true);
  const events = execution.getEvents();
  assert.deepEqual(events.map(event => event.type), ['request_started', 'agent_started', 'error', 'agent_finished', 'request_finished']);
  assert.ok(events.every(event => event.requestId === ctx.requestId));
  assert.equal(events[1].agentRunId, events[3].agentRunId);
  assert.equal(events.at(-1).status, 'FAILED');
  const count = events.length;
  execution.finish();
  assert.equal(execution.getEvents().length, count);
  await assert.rejects(execution.executeSkill({ agentId: 'analyst', skillId: 'get_demand_forecast' }), expectCode('AGENT_INVALID_REQUEST'));
});

test('skill dispatch budget admits four attempts and blocks the fifth without executing it', async () => {
  const execution = createAgentExecution({ context: context() });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(execution.executeSkill({ agentId: 'operations', skillId: 'get_inventory_summary' }), expectCode('AGENT_EXECUTOR_NOT_READY'));
  }
  await assert.rejects(execution.executeSkill({ agentId: 'operations', skillId: 'get_inventory_summary' }), expectCode('AGENT_BUDGET_EXCEEDED'));
  assert.equal(execution.finish().totalSkillCalls, 0);
  assert.equal(execution.getEvents().filter(event => event.type === 'skill_called').length, 0);
});

test('central budgets bound messages and future calls without reporting them as usage', () => {
  assert.equal(validateAgentMessage('x'.repeat(2000)).length, 2000);
  for (const message of ['', ' ', null, 'x'.repeat(2001)]) assert.throws(() => validateAgentMessage(message), expectCode('AGENT_INVALID_REQUEST'));
  const budget = createExecutionBudget();
  for (const [kind, max] of [['llmCalls', 3], ['skillCalls', 4], ['toolSelectionCycles', 2]]) {
    for (let i = 0; i < max; i++) budget.consume(kind);
    assert.throws(() => budget.consume(kind), expectCode('AGENT_BUDGET_EXCEEDED'));
    assert.equal(budget.snapshot()[kind], max);
  }
  assert.equal(EXECUTION_LIMITS.maxMessageChars, 2000);
  assert.deepEqual(TOKEN_BUDGETS.analyst, { maxInputTokens: 2200, maxOutputTokens: 450 });
  assert.equal(createRequestUsage().totalTokens, 0);
});

test('zero generations have known zero usage, including deterministic agent runs', () => {
  const usage = createRequestUsage({ agentIds: ['operations'], totalSkillCalls: 1 });
  assert.equal(usage.metricsComplete, true);
  assert.deepEqual(usage.agents[0], { agentId: 'operations', model: null, llmCalls: 0,
    inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedInputTokens: 0, toolUseTokens: 0, totalTokens: 0, latencyMs: 0, usageAvailable: true });
  assert.ok(Object.isFrozen(usage.agents[0]));
});

const measuredRecord = overrides => ({ agentId: 'analyst', model: 'future-model', usageAvailable: true,
  inputTokens: 100, outputTokens: 20, thoughtTokens: 10, cachedInputTokens: 40, toolUseTokens: 7, totalTokens: 130, latencyMs: 15, ...overrides });

test('usage aggregates provider totals without adding cached input twice', () => {
  const usage = createRequestUsage({ llmRecords: [measuredRecord(), measuredRecord({ agentId: 'operations' })], totalSkillCalls: 2 });
  assert.equal(usage.totalLlmCalls, 2);
  assert.equal(usage.totalInputTokens, 200);
  assert.equal(usage.totalOutputTokens, 40);
  assert.equal(usage.totalTokens, 260);
  assert.equal(usage.totalToolUseTokens, 14);
  assert.equal(usage.agents[0].thoughtTokens, 10);
  assert.equal(usage.agents[0].cachedInputTokens, 40);
});

test('missing provider metrics remain unknown and cannot masquerade as zero', () => {
  const unknown = { agentId: 'analyst', model: 'future-model', usageAvailable: false, latencyMs: 12 };
  const usage = createRequestUsage({ llmRecords: [measuredRecord({ agentId: 'operations' }), unknown] });
  assert.equal(usage.totalLlmCalls, 2);
  assert.equal(usage.metricsComplete, false);
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.totalInputTokens, null);
  assert.equal(usage.agents[0].totalTokens, 130);
  assert.equal(usage.agents[1].totalTokens, null);
  assert.equal(usage.agents[1].usageAvailable, false);
  assert.throws(() => createRequestUsage({ llmRecords: [{ ...unknown, totalTokens: 0 }] }), expectCode('AGENT_INVALID_REQUEST'));
});

test('partial usage fields stay unknown individually while retaining official totals', () => {
  const usage = createRequestUsage({ llmRecords: [{ agentId: 'analyst', model: 'gemini-3.8-flash', usageAvailable: true,
    inputTokens: 12, outputTokens: null, thoughtTokens: null, cachedInputTokens: 3, toolUseTokens: null,
    totalTokens: 25, latencyMs: 11 }] });
  assert.equal(usage.totalInputTokens, 12);
  assert.equal(usage.totalOutputTokens, null);
  assert.equal(usage.totalTokens, 25);
  assert.equal(usage.totalToolUseTokens, null);
  assert.equal(usage.metricsComplete, false);
  assert.equal(usage.agents[0].usageAvailable, true);
});

test('usage rejects malformed counts and overflow instead of coercing metrics', () => {
  for (const value of ['100', NaN, Infinity, -1, 1.5]) {
    assert.throws(() => createRequestUsage({ llmRecords: [measuredRecord({ inputTokens: value })] }), expectCode('AGENT_INVALID_REQUEST'));
  }
  assert.throws(() => createRequestUsage({ llmRecords: [measuredRecord({ cachedInputTokens: 101 })] }), expectCode('AGENT_INVALID_REQUEST'));
  assert.throws(() => createRequestUsage({ llmRecords: [measuredRecord({ totalTokens: Number.MAX_SAFE_INTEGER }), measuredRecord()] }), expectCode('AGENT_INVALID_REQUEST'));
});

test('trace IDs are UUIDs and unique, with optional conversation correlation', () => {
  const ids = new Set(Array.from({ length: 40 }, () => context().requestId));
  assert.equal(ids.size, 40);
  for (const id of ids) assert.match(id, /^[a-f\d-]{36}$/);
  const event = createTraceEvent('skill_called', { requestId: randomUUID(), conversationId: randomUUID(),
    agentRunId: randomUUID(), skillCallId: randomUUID(), agentId: 'analyst', skillId: 'get_demand_forecast' });
  assert.match(event.agentRunId, /^[a-f\d-]{36}$/);
  assert.notEqual(event.agentRunId, event.skillCallId);
});

test('trace allowlist omits secrets, raw arguments, tenant identities and reasoning', () => {
  const event = createTraceEvent('request_started', { requestId: randomUUID(), status: 'STARTED',
    JWT: 'secret-jwt', password: 'secret-password', apiKey: 'secret-key', mongoUri: 'secret-uri',
    chainOfThought: 'secret-thought', args: { query: 'secret-payload' }, userId: 'secret-user', businessId: 'secret-tenant' });
  assert.deepEqual(Object.keys(event).sort(), ['requestId', 'status', 'timestamp', 'type']);
  assert.equal(JSON.stringify(event).includes('secret'), false);
  assert.ok(Object.isFrozen(event));
  assert.equal(EVENT_TYPES.length, 9);
  assert.throws(() => createTraceEvent('arbitrary', { requestId: randomUUID() }), expectCode('AGENT_INVALID_REQUEST'));
  assert.throws(() => createTraceEvent('skill_called', { requestId: randomUUID() }), expectCode('AGENT_INVALID_REQUEST'));
});

test('failed telemetry sinks do not break the controlled domain result', async () => {
  const execution = createAgentExecution({ context: context(), onEvent: () => { throw new Error('sink unavailable'); } });
  await assert.rejects(execution.executeSkill({ agentId: 'analyst', skillId: 'get_inventory_summary' }), expectCode('AGENT_EXECUTOR_NOT_READY'));
  assert.equal(execution.finish().totalLlmCalls, 0);
});

test('evidence includes only a lightweight skill reference, time and period', () => {
  const evidence = createEvidence({ skillId: 'get_sales_summary', label: 'Ventas completadas de enero',
    asOf: '2025-01-31', period: { startDate: '2025-01-01', endDate: '2025-01-31' } });
  assert.equal(evidence.sourceType, 'skill');
  assert.equal(evidence.skillId, 'get_sales_summary');
  assert.match(evidence.evidenceId, /^[a-f\d-]{36}$/);
  assert.ok(Object.isFrozen(evidence.period));
  assert.throws(() => createEvidence({ skillId: 'get_sales_summary', label: 'Sales', payload: [] }), expectCode('AGENT_INVALID_REQUEST'));
  assert.throws(() => createEvidence({ skillId: 'get_sales_summary', label: 'Sales', asOf: '2025-02-29' }), expectCode('AGENT_INVALID_REQUEST'));
});

test('public error projection excludes stack and untrusted diagnostic details', () => {
  const error = new AgentError('AGENT_INVALID_SKILL_ARGS');
  assert.deepEqual(error.toJSON(), { code: 'AGENT_INVALID_SKILL_ARGS', message: 'Invalid skill arguments' });
  assert.equal(JSON.stringify(error).includes('stack'), false);
  assert.equal(new AgentError('secret-value').toJSON().message.includes('secret'), false);
});
