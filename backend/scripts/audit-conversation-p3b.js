/* Local audit only. No dotenv, database connection, HTTP client or real provider.
 * Usage: node backend/scripts/audit-conversation-p3b.js
 * Generated reports are separate from backend/test/run.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { families } = require('../test/audit/p3bCases');
const { readFixture, writeFixture, products, vendors, foreign, read, write, transactional, setObserver } = require('../test/audit/p3bFixtures');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { actionIntent, parseAction } = require('../src/automations/actionInput');
const { actionDecision } = require('../src/automations/actionDecision');
const { rankEntities } = require('../src/automations/entityResolution');
const { SKILLS } = require('../src/agents/skills');
const { ACTION_SKILLS } = require('../src/automations/skills');
const now = new Date('2026-10-09T12:00:00Z');
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const safe = value => JSON.parse(JSON.stringify(value, (_, item) => item instanceof RegExp ? { pattern: item.source, flags: item.flags } : item));
const canonicalIntents = expected => expected.map(intent => ({ forecast_analytics: 'ml_analytics', clarification: 'ambiguous_query',
  forecast_temporal_limitation: 'ml_historical_clarification' }[intent] || intent));
const skillsFor = { product_details: 'get_product_details', search_product: 'search_products', low_stock: 'get_low_stock_products',
  business_summary: 'get_business_summary', sales_summary: 'get_sales_summary', product_sales_summary: 'get_product_sales_summary',
  recent_transactions: 'get_recent_transactions', top_selling_products: 'get_top_selling_products', demand_forecast: 'get_demand_forecast',
  ml_analytics: 'analyze_demand_forecast', replenishment_candidates: 'get_replenishment_candidates', stock_alert_rules: 'list_stock_alert_rules',
  inventory_alert_events: 'list_inventory_alerts', inventory_alert_deliveries: 'list_inventory_alert_outbox_events',
  inventory_alert_channel_deliveries: 'list_inventory_alert_channel_deliveries' };
const summarize = response => ({ intent: response.intent, answer: response.answer, clarification: response.requiresClarification,
  code: response.code || null, skills: (response.actions || []).map(row => row.skillId),
  llmCalls: response.usage?.totalLlmCalls ?? null, tokens: response.usage?.totalTokens ?? null,
  participants: (response.participants || []).map(row => ({ agentId: row.agentId, llmCalls: row.llmCalls, skillCalls: row.skillCalls })),
  evidence: (response.evidence || []).map(row => ({ skillId: row.skillId, label: row.label, period: row.period, recordCount: row.recordCount })),
  suggestions: (response.suggestions || []).map(row => ({ label: row.label, message: row.message, detail: row.detail })),
  pagination: response.suggestionsPagination || null, pending: response.pendingAction ? { action: response.pendingAction.action,
    status: response.pendingAction.status, fields: response.pendingAction.fields, items: response.pendingAction.items } : null });
const check = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { auditAssertion: true }); };
const invariants = (f, responses) => {
  check(!f.confirmed || f.confirmed.length === 0, 'Unexpected mock action execution outside confirmation scenario');
  for (const response of responses) {
    check(response.usage?.totalLlmCalls === 0 && response.usage?.totalTokens === 0, 'Expected deterministic zero LLM/tokens');
    check(!['AGENT_INTERNAL_ERROR', 'AGENT_SKILL_FAILED'].includes(response.code), 'Unexpected internal/skill error');
    check(!response.answer?.includes(foreign.sku), 'Foreign tenant product appeared in response');
    check(!(response.suggestions || []).some(row => /0000000000000000000003e7/.test(row.label)), 'Foreign ID in candidates');
    if (f.events) {
      const events = f.events.filter(row => row.requestId === response.requestId);
      check(events[0]?.type === 'request_started' && events.at(-1)?.type === 'request_finished', 'Request observability lifecycle incomplete');
      check(events.every(row => row.conversationId === response.conversationId), 'Trace conversation correlation mismatch');
      check(events.filter(row => row.type.startsWith('skill_')).every(row => row.agentRunId && row.skillCallId), 'Skill correlation IDs missing');
      check((response.actions || []).every(action => events.some(event => event.type === 'skill_called' && event.skillId === action.skillId)), 'Action not backed by skill trace');
    }
  }
};
const periodFor = input => {
  const text = normalize(input);
  if (/desde ayer hasta hoy/.test(text)) return { startDate: '2026-10-08', endDate: '2026-10-09' };
  if (/ultimos 7 dias/.test(text)) return { startDate: '2026-10-03', endDate: '2026-10-09' };
  if (/ultimos 30 dias/.test(text)) return { startDate: '2026-09-10', endDate: '2026-10-09' };
  if (/\banteayer\b/.test(text)) return { startDate: '2026-10-07', endDate: '2026-10-07' };
  if (/\bayer\b/.test(text)) return { startDate: '2026-10-08', endDate: '2026-10-08' };
  if (/\bhoy\b/.test(text)) return { startDate: '2026-10-09', endDate: '2026-10-09' };
  if (/esta semana/.test(text)) return { startDate: '2026-10-05', endDate: '2026-10-09' };
  if (/9 de octubre de 2026|el 2026-10-09/.test(text)) return { startDate: '2026-10-09', endDate: '2026-10-09' };
  return null;
};
const failed = (row, reason, severity = 'P2') => Object.assign(row, { classification: 'FAIL', severity, notes: reason });
async function individual(family, input, index) {
  const expected = family.expected;
  const row = { id: `U-${String(index).padStart(4, '0')}`, family: family.family, area: family.area, input,
    expected: safe(expected), actual: {}, classification: 'PASS', severity: null, notes: '' };
  try {
    if (expected.level === 'decision') {
      const decision = actionDecision(input); row.actual = { level: 'decision_only', decision };
      check(expected.allowed ? expected.allowed.includes(decision) : !expected.forbidden.includes(decision), 'Approval/negation vocabulary mismatch');
      return row;
    }
    if (expected.level === 'resolver') {
      const rows = expected.kind === 'supplier' ? vendors : products;
      const result = rankEntities(rows, input, 0, expected.kind === 'supplier');
      const found = result.value ? [result.value] : result.candidates || [];
      row.actual = { level: 'resolver_only', confidence: result.confidence, candidates: found.map(row => ({ name: row.name, sku: row.sku })), total: result.pagination?.totalMatches ?? found.length };
      if (expected.absent) check(found.length === 0, 'Incompatible numeric/subgroup identity yielded a candidate');
      else {
        check(found.length > 0, 'No candidate for known structured identifier');
        if (expected.item) check(found.every(row => Number(row.sku.split('_').at(-1)) === Number(expected.item)), 'Numeric identity changed');
        if (expected.supplier) check(found.length === 1 && found[0].name === vendors[expected.supplier - 1].name, 'Supplier alias failed unique resolution');
      }
      return row;
    }
    if (expected.level === 'action') {
      const f = writeFixture();
      let parsed, parseError;
      try { parsed = parseAction(input, actionIntent(input)); } catch (error) { parseError = error.code || error.name; }
      const result = await f.send(input);
      row.actual = { level: 'guided_action_mock', ...summarize(result), parsed, parseError,
        prepared: safe(f.prepared), mockExecutions: f.confirmed.length, mockCancellations: f.cancelled.length };
      check(f.confirmed.length === 0, 'Action executed before human confirmation');
      if (expected.invalid) {
        check(f.prepared.length === 0 && !result.pendingAction, 'Unsafe quantity produced executable preview');
        check(result.usage?.totalLlmCalls === 0, 'Unsafe explicit quantity delegated to LLM');
      } else {
        check(actionIntent(input) === expected.action, 'Write phrase not recognized by action gateway');
        check(result.usage?.totalLlmCalls === 0 && result.usage?.totalTokens === 0, 'Deterministic write preparation lost zero-token behavior');
        if (expected.quantity && parsed?.items?.[0]?.quantity !== undefined)
          check(parsed.items[0].quantity === expected.quantity, 'Quantity parser changed explicit quantity');
        if (f.prepared.length && expected.quantity) check(f.prepared[0].products.every(item => item.quantity === expected.quantity), 'Prepared quantity differs from request');
        if (expected.action === 'create_sale' && /food (?:0*96|2 0*96)\b|M5-FOODS_2_096\b|item 0*96\b/.test(input) && !/fods/.test(input))
          check(f.prepared.length === 1, 'Known available sale product did not reach preview');
        if (expected.action === 'create_purchase' && /food(?:s)? (?:2 )?0*96\b|M5-FOODS_2_096\b/i.test(input)
          && /prove(?:edor|edro) (?:food 0*1\b|0*1 foods\b|sintetico 0*1 foods\b)/.test(normalize(input)))
          check(f.prepared.length === 1, 'Known purchase product/supplier did not reach preview');
        if (f.prepared.length && /food (?:196|960)/.test(input)) check(false, 'Nonexistent product produced a preview');
        if (!f.prepared.length && !result.requiresClarification) check(false, 'Neither preview nor useful clarification');
      }
      return row;
    }
    const plan = routeDeterministically(input, {}, now, undefined, undefined, 'A');
    row.actual = { level: 'routing', plan: plan && safe(plan) };
    if (expected.notSupported) { row.classification = 'NOT_SUPPORTED'; row.notes = `Intentionally unavailable: ${expected.capability}; routing shown separately, not counted as defect.`; return row; }
    if (expected.manual) { row.classification = 'NEEDS_MANUAL'; row.notes = 'Real-provider synthesis quality not evaluated; no paid calls made.'; return row; }
    const f = readFixture();
    const result = await f.run(input);
    row.actual = { level: 'orchestrator_mock_db', plan: plan && safe(plan), ...summarize(result),
      physicalMockProviderAttempts: f.calls.length, databaseFilters: safe(f.reads), trace: f.events.map(event => ({ type: event.type,
        agentId: event.agentId, skillId: event.skillId, hasRequestCorrelation: Boolean(event.requestId && event.conversationId),
        hasSkillCorrelation: event.type.startsWith('skill_') ? Boolean(event.agentRunId && event.skillCallId) : null })) };
    if (expected.level === 'multi') {
      row.classification = result.requiresClarification ? 'PARTIAL' : plan?.intent === 'compound_product_list' ? 'PASS' : 'PARTIAL';
      row.notes = 'General multi-intent planner intentionally absent; inspect response for omitted subrequests. Bounded compound-list forms can pass.';
      if (f.calls.length) { row.notes += ' Fallback provider attempt observed (fake only).'; }
      return row;
    }
    if (expected.temporal) {
      check(plan?.clarificationQuestion && !f.calls.length && result.usage.totalSkillCalls === 0, 'Temporal forecast must clarify without historical lookup');
      return row;
    }
    if (family.family === 'incomplete_temporals') {
      check(plan?.clarificationQuestion && !f.calls.length, 'Incomplete/invalid date was interpreted without clarification');
      return row;
    }
    const lookupOnly = family.family === 'product_details' && !/detalles|informaci[oó]n|todo|ficha|datos/.test(input);
    check(plan && (canonicalIntents(expected.intents).includes(plan.intent) || lookupOnly && plan.intent === 'search_product'
      || plan.clarificationQuestion && !f.calls.length), 'Wrong deterministic intent or unnecessary LLM fallback');
    check(!f.calls.length, 'Unexpected provider invocation on deterministic path');
    invariants(f, [result]);
    if (!result.requiresClarification && skillsFor[plan.intent]) check(row.actual.skills.includes(skillsFor[plan.intent]), 'Activity does not include expected skill');
    if (family.area === 'sales' || family.area === 'transactions') {
      const period = periodFor(input);
      if (period && !plan.clarificationQuestion) check(plan.period?.startDate === period.startDate && plan.period?.endDate === period.endDate, 'Period lost or narrowed');
      const transactionFilter = f.reads.find(row => row.model === 'Transaction' && row.pipeline)?.pipeline[0].$match;
      if (period && transactionFilter) {
        check(transactionFilter.date?.$gte.toISOString().slice(0, 10) === period.startDate, 'Executor did not apply requested period start');
        const inclusiveEnd = new Date(new Date(`${period.endDate}T00:00:00Z`).getTime() + 86400000).toISOString();
        check(transactionFilter.date?.$lt.toISOString() === inclusiveEnd, 'Executor did not apply inclusive period end');
      }
      if (/compras/.test(normalize(input)) && plan.intent === 'recent_transactions') check(plan.type === 'purchase', 'Purchase filter lost');
    }
    if (expected.attribute && !result.requiresClarification) {
      const text = normalize(result.answer);
      const pattern = { stock: /stock|unidad/, price: /s\/ 29\.45/, minimum: /minimo/, active: /activo|inactivo/ }[expected.attribute];
      check(pattern.test(text), 'Requested attribute missing');
      if (expected.attribute === 'price') check(!/stock|minimo|activo/.test(text), 'Price-only question returned unrelated attributes');
      if (expected.attribute === 'active') check(!/stock|precio/.test(text), 'State-only question returned unrelated attributes');
    }
    if (/food 0*96\b|item 0*96\b/.test(normalize(input)) && !result.requiresClarification && family.area === 'product')
      check(result.answer.includes(products[0].sku), 'Explicit product failed to resolve to 096');
    if (family.family === 'sales_ranking' && !/mes|ayer|ultimos/.test(normalize(input))) check(!plan.period, 'Generic ranking inherited current-month default');
    if (family.family === 'tenant_denial') check(result.usage.totalSkillCalls === 0, 'Cross-tenant request reached business skills');
    if (family.area === 'alerts') {
      const text = normalize(input), filter = f.reads.find(row => ['InventoryAlert', 'InventoryAlertOutboxEvent', 'InventoryAlertChannelDelivery'].includes(row.model))?.match;
      if (/\b(?:abiertas|open)\b/.test(text) && filter) check(filter.status === 'OPEN', 'Open alert status filter lost');
      if (/\b(?:omitidas|skipped)\b/.test(text) && filter) check(filter.status === 'SKIPPED', 'Telegram skipped status filter lost');
    }
    if (family.family === 'forecast_historical' && /food(?:s)? (?:2 )?0*96\b|item 0*96\b|M5-FOODS_2_096/i.test(input) && !result.requiresClarification)
      check(!products.slice(1).some(product => result.answer.includes(product.sku)), 'Explicit forecast product filter lost; batch returned instead');
    check(!/\b1 unidades\b|\b1 unidad disponibles\b|producto\(s\)|identificador:|operacion:|no envia avisos automaticos todavia/.test(normalize(result.answer)), 'Visible grammar/ID/obsolete-wording defect');
    check(!/\uFFFD|Ã|Â|â€/.test(result.answer), 'Mojibake in deterministic response');
    check((result.suggestions || []).length <= 5, 'Candidate page exceeds five visible choices');
  } catch (error) {
    const fixtureFault = !error.auditAssertion && !(error.code?.startsWith('ACTION_') || error.code?.startsWith('AGENT_'));
    if (fixtureFault) { row.classification = 'NEEDS_MANUAL'; row.notes = `Fixture/evaluator limitation: ${error.name}; ${error.message.slice(0, 140)}`; }
    else failed(row, error.message, /identity|quantity|attribute|Period|filter|product failed|known available/i.test(error.message) ? 'P1'
      : /grammar|wording/.test(error.message) ? 'P3' : 'P2');
    if (expected.temporal && row.actual.skills?.includes('get_demand_forecast')) row.severity = 'P1';
    if (row.actual.plan && !canonicalIntents(expected.intents || []).includes(row.actual.plan.intent)
      && row.actual.skills?.length && ['sales', 'transactions', 'alerts', 'forecast'].includes(family.area)) row.severity = 'P1';
    if (expected.attribute && row.actual.plan?.intent !== 'product_details' && row.actual.skills?.length) row.severity = 'P1';
    if (expected.temporal && !row.actual.skills?.includes('get_demand_forecast')) row.severity = 'P2';
    if (expected.invalid && row.actual.prepared?.length) row.severity = 'P0';
  }
  return row;
}

const sequences = [];
const seq = (family, turns, expected, run) => sequences.push({ family, turns, expected, run });
const readSeq = (family, turns, verify) => seq(family, turns, { deterministic: true, realSkillsWithFakeDb: true }, async () => {
  const f = readFixture(), conversation = randomUUID(), responses = [];
  for (const turn of turns) responses.push(await f.run(turn, conversation));
  invariants(f, responses); await verify(f, responses, conversation);
  return { turns: responses.map(summarize), mockProviderAttempts: f.calls.length, filters: safe(f.reads) };
});
for (let n = 0; n < 8; n++) {
  const firstRef = ['food 96', 'food 096', 'food 2 96', 'food 0096', products[0].sku, products[0].name, 'item 96', 'fods 96'][n];
  const first = `¿Cuánto stock tiene ${firstRef}?`;
  readSeq('attribute_context', [first, ['¿Y el precio?', '¿Y el stock mínimo?', '¿Está activo?', '¿Y su predicción?'][n % 4]], async (f, rows) => {
    check(!rows[1].requiresClarification && rows[1].answer.includes(products[0].sku), 'Selected product/attribute context lost');
  });
  const choice = ['1', 'el primero', products[1].sku, products[1].name, '2', 'el segundo', products[2].sku, products[2].name][n];
  const selectedSku = products[n < 4 ? 1 : 2].sku;
  readSeq('product_selection', ['¿Cuánto stock tiene food 210?', choice, '¿Y el precio?'], async (f, rows) => {
    check(rows[0].suggestions?.length === 2, 'Ambiguous product did not expose two clickable candidates');
    check(rows[1].answer.includes(selectedSku) && rows[2].answer.includes(selectedSku), 'Selection/followup product lost');
  });
  readSeq('sales_followup', ['¿Cuánto vendí ayer?', ['¿Y anteayer?', '¿Y hoy?', '¿Y en los últimos 7 días?', '¿Y el mes pasado?'][n % 4]], async (f, rows) => {
    check(rows[1].actions.some(action => action.skillId === 'get_sales_summary'), 'Sales period followup lost intent');
  });
  readSeq('list_followup', ['Muéstrame los 5 productos con mayor demanda', ['¿Cuál de esos tiene menos stock?', '¿Cuál de esos tiene mayor demanda?', '¿Cuál necesita más reposición?', '¿Cuál de esos tiene el proveedor más barato?'][n % 4]], async (f, rows) => {
    check(!rows[1].requiresClarification, 'Known product-list followup asked for unrelated context');
  });
  readSeq('supplier_pagination', ['proveedor food', 'Ver más', n % 2 ? 'Anterior' : 'Ver más', ['1', 'el primero', '2', 'el segundo'][n % 4]], async (f, rows) => {
    check(rows[0].suggestionsPagination?.totalMatches === 25 && rows[1].suggestionsPagination?.offset === 5, 'Supplier totals/page lost');
    const picked = rows[2].suggestions[n % 4 < 2 ? 0 : 1];
    check(rows[3].answer.includes(picked.label.replace(/^\d+\.\s*/, '')), 'Selection not bound to visible page');
  });
  readSeq('supplier_offer_continuation', ['cuanto cuesta food 212 con proveedor food', ...(n >= 4 ? ['Ver más'] : []), ['1', 'el primero', '2', 'el segundo'][n % 4]], async (f, rows) => {
    const last = rows.at(-1);
    check(last.answer.includes(products[3].sku) && last.answer.includes('15.67'), 'Product/supplier offer continuation lost original intent');
  });
  seq('write_product_selection', ['vende 3 del food 210', choice], { quantity: 3, previewOnly: true, product: selectedSku }, async () => {
    const f = writeFixture(), rows = [];
    for (const turn of ['vende 3 del food 210', choice]) rows.push(await f.send(turn));
    check(rows[0].suggestions?.length === 2, 'Write did not preserve clickable ambiguity');
    if (selectedSku === products[1].sku) {
      check(f.prepared.length === 0 && /Solicitaste 3 unidades.*solo hay 1 unidad disponible/.test(rows[1].answer), 'Stock shortage was not reported explicitly');
    } else {
      check(f.prepared.length === 1 && f.prepared[0].products[0].quantity === 3, 'Write continuation lost quantity');
      check(rows[1].pendingAction.items[0].sku === selectedSku, 'Wrong write candidate selected');
    }
    invariants(f, rows); return { turns: rows.map(summarize), prepared: safe(f.prepared), executions: f.confirmed.length };
  });
  seq('write_supplier_selection', [`compra 3 del food 96 con ${n % 2 ? '' : 'el '}proveedor food`, ...(n >= 4 ? ['Ver más'] : []), ['1', 'el primero', '2', 'el segundo'][n % 4]], { product: products[0].sku, quantity: 3, previewOnly: true }, null);
  // Capture the sequence, not a mutable outer loop reference.
  const purchase = sequences.at(-1);
  purchase.run = async () => {
    const f = writeFixture(), rows = [];
    for (const turn of purchase.turns) rows.push(await f.send(turn));
    check(f.prepared.length === 1 && f.prepared[0].products[0].quantity === 3, 'Purchase candidate continuation failed');
    check(rows.at(-1).pendingAction.items[0].sku === products[0].sku, 'Purchase product changed');
    invariants(f, rows); return { turns: rows.map(summarize), prepared: safe(f.prepared), executions: f.confirmed.length };
  };
  const question = ['¿cuál es el precio?', '¿cuánto pagaré?', '¿cuánto quedará de stock?', '¿cuántas unidades son?', '¿está bien el precio?', '¿cuánto quedaré de stock?', '¿qué proveedor elegí?', '¿cuánto quedará?'][n];
  seq('pending_question', [n === 6 ? 'compra 2 del food 96 con el proveedor food 1' : 'vende 2 del food 96', question], { factualFromPreview: true, remainsPending: true }, async () => {
    const f = writeFixture(), rows = [];
    rows.push(await f.send(n === 6 ? 'compra 2 del food 96 con el proveedor food 1' : 'vende 2 del food 96'));
    rows.push(await f.send(question)); invariants(f, rows);
    check(/pendiente/.test(rows[1].answer), 'Pending question lost pending status');
    check(/29\.45|58\.90|10 unidades|2 unidades|15\.67|Proveedor sintético/.test(rows[1].answer), 'Pending question did not answer verified preview data');
    return { turns: rows.map(summarize), executions: f.confirmed.length };
  });
  const control = ['¿está bien el precio?', 'no todavía', 'no confirmes', 'cancelar', 'mejor no', 'olvídalo', '¿qué pasa si confirmo?', '¿puedo cambiar el cliente?'][n];
  seq('decision_guard', ['vende 2 del food 96', control, 'sí'], { questionsNeverConfirm: true, cancellationNeverExecutes: true }, async () => {
    const f = writeFixture(), rows = [];
    for (const turn of ['vende 2 del food 96', control, 'sí']) rows.push(await f.send(turn));
    invariants(f, rows); return { turns: rows.map(summarize), executions: f.confirmed.length, cancellations: f.cancelled.length };
  });
  seq('conversation_isolation', [first, ['¿Y el precio?', '¿Y cuánto stock tiene?', '¿Cuál de esos tiene menos stock?', '¿Y cuánto cuesta reponerlo?'][n % 4]],
    { isolatedBinding: n < 4 ? 'conversation' : n < 6 ? 'user' : 'tenant+user', mustClarify: true }, async () => {
    const f = readFixture(), conversation = randomUUID(), firstResponse = await f.run(first, conversation);
    const second = await f.run(['¿Y el precio?', '¿Y cuánto stock tiene?', '¿Cuál de esos tiene menos stock?', '¿Y cuánto cuesta reponerlo?'][n % 4],
      n < 4 ? randomUUID() : conversation, n < 4 ? read.req() : read.req(n < 6 ? 'A' : 'B', 900 + n));
    invariants(f, [firstResponse, second]); check(second.requiresClarification && second.usage.totalSkillCalls === 0, 'Other conversation inherited product/list');
    return { turns: [firstResponse, second].map(summarize) };
  });
  readSeq('explicit_replaces_context', [first, ['precio food 511', '¿Está activo food 511?', '¿Cuál es la predicción de M5-FOODS_3_511?', '¿Cuánto vendí de M5-FOODS_3_511 ayer?'][n % 4]], async (f, rows) => {
    check(rows[1].answer.includes(products[4].sku) && !rows[1].answer.includes(products[0].sku), 'Explicit product did not replace old context');
  });
  const approval = ['confirma', 'confirmar', 'sí, hazlo', 'procede', 'de acuerdo', 'sí', 'ok', 'dale'][n];
  seq('confirmation_mock_only', ['vende 2 del food 96', approval, approval, 'cancelar'], { mockExecutions: 1, idempotent: true, cancelDoesNotUndo: true }, async () => {
    const f = writeFixture(), rows = [];
    for (const turn of ['vende 2 del food 96', approval, approval, 'cancelar']) rows.push(await f.send(turn));
    check(f.confirmed.length === 1, 'Repeated approval duplicated or failed mock execution');
    check(f.cancelled.length === 0, 'Cancel after success attempted reversal');
    check(rows.every(row => row.usage.totalLlmCalls === 0), 'Approval flow invoked LLM');
    return { turns: rows.map(summarize), executions: f.confirmed.length, cancellations: f.cancelled.length };
  });
  const guardTurns = n < 2 ? [approval] : n < 4 ? ['vende 3 del food 210', approval]
    : n < 6 ? ['vende 2 del food 96', 'cancelar', approval] : ['vende 2 del food 96', '[advance clock 11 minutes]', approval];
  seq('confirmation_scope_expiry', guardTurns, { noExecutionWithoutEligiblePreview: true }, async () => {
    let tick = Date.now(); const f = writeFixture({ clock: () => tick }), rows = [];
    for (const turn of guardTurns) {
      if (turn.startsWith('[advance')) { tick += 660000; continue; }
      rows.push(await f.send(turn));
    }
    invariants(f, rows); return { turns: rows.map(summarize), executions: f.confirmed.length, cancellations: f.cancelled.length };
  });
  const correction = ['mejor vende 2', 'mejor 2', 'cambiar cantidad del producto 1 a 2', 'cambia cantidad a 2',
    'mejor -2', 'mejor 2.5', 'no el segundo', 'no es el segundo, es el primero'][n];
  const correctionTurns = n >= 6 ? ['vende 3 del food 210', correction] : ['vende 3 del food 96', correction];
  if (n === 3) seq('customer_existing_credit', ['vende 2 food 96 al cliente Cliente Audit a crédito'], { existingCustomer: true, paymentMethod: 'credit', previewOnly: true }, async () => {
    const f = writeFixture(), original = f.options.resolver, customerId = read.id(3000);
    f.options.resolver = async (model, context, ref, type, offset) => type === 'customer'
      ? { value: { _id: customerId, name: 'Cliente Audit', isActive: true }, confidence: 'EXACT' }
      : original(model, context, ref, type, offset);
    const response = await f.send('vende 2 food 96 al cliente Cliente Audit a crédito');
    invariants(f, [response]); check(f.prepared[0]?.customerId === customerId && f.prepared[0].paymentMethod === 'credit', 'Existing credit-sale customer lost');
    return { turns: [summarize(response)], prepared: safe(f.prepared), executions: f.confirmed.length };
  });
  else seq('correction_safety', correctionTurns, { noExecution: true, preserveValidQuantityAndNegation: true }, async () => {
    const f = writeFixture(), rows = [];
    for (const turn of correctionTurns) rows.push(await f.send(turn));
    invariants(f, rows);
    if (n < 4) check(f.prepared.at(-1)?.products[0].quantity === 2, 'Quantity correction did not produce corrected preview');
    if (n >= 4) check(f.prepared.length <= 1 && !rows.at(-1).pendingAction, 'Invalid/negated choice yielded executable preview');
    return { turns: rows.map(summarize), prepared: safe(f.prepared), executions: f.confirmed.length };
  });
}
async function main() {
  const cases = []; let index = 0;
  for (const family of families) for (const input of family.inputs) cases.push(await individual(family, input, ++index));
  for (const [i, spec] of sequences.entries()) {
    const row = { id: `S-${String(i + 1).padStart(3, '0')}`, family: spec.family, area: 'sequence', turns: spec.turns,
      input: spec.turns[0], expected: spec.expected, actual: {}, classification: 'PASS', severity: null, notes: '' };
    setObserver(response => { (row.actual.observedTurns ||= []).push(summarize(response)); });
    try { row.actual = await spec.run(); }
    catch (error) { if (error.auditAssertion) failed(row, error.message, /product|quantity|period|conversation/i.test(error.message) ? 'P1' : 'P2');
      else { row.classification = 'NEEDS_MANUAL'; row.notes = `Fixture limitation: ${error.name}; ${error.message.slice(0, 140)}`; } }
    cases.push(row);
    setObserver();
  }
  // Additional structural security probes, not counted as natural utterances.
  for (const [name, context] of [
    ['wrong_tenant_pending', transactional.ctx('B')],
    ['wrong_user_pending', transactional.ctx('A', read.id(3001))],
    ['wrong_channel_pending', transactional.ctx('A', undefined, 'telegram')],
    ['wrong_conversation_pending', transactional.ctx('A', undefined, 'assistant', randomUUID())]
  ]) {
    const row = { id: `G-${cases.filter(row => row.id.startsWith('G-')).length + 1}`, family: 'structural_security', area: 'security',
      input: name, expected: { reject: true, mockBusinessWrites: 0 }, actual: {}, classification: 'PASS', severity: null, notes: '' };
    try {
      const f = transactional.fixture(), pending = await f.service.prepare({ agentId: 'operations', skillId: 'create_product',
        args: transactional.product, context: transactional.ctx(), externalRequestId: randomUUID() });
      let errorCode;
      try { await f.service.confirmPendingAction(context, pending.pendingActionId); } catch (error) { errorCode = error.code; }
      row.actual = { code: errorCode || null, mockBusinessWrites: f.writes() };
      check(errorCode && f.writes() === 0, 'Wrong pending actor/scope performed a mock write');
    } catch (error) { failed(row, error.message, 'P0'); }
    cases.push(row);
  }
  const injected = { id: 'G-5', family: 'structural_security', area: 'security', input: { message: 'stock food 96', businessId: 'B' },
    expected: { code: 'AGENT_INVALID_REQUEST', noDatabaseReads: true }, actual: {}, classification: 'PASS', severity: null, notes: '' };
  try {
    const f = readFixture(); let code;
    try { await f.orchestrator.handle(read.req(), injected.input); } catch (error) { code = error.code; }
    injected.actual = { code, reads: f.reads.length }; check(code === 'AGENT_INVALID_REQUEST' && f.reads.length === 0, 'Injected body scope accepted');
  } catch (error) { failed(injected, error.message, 'P0'); }
  cases.push(injected);
  for (const [i, input] of ['¿Cuánto stock tiene M5-FOODS_3_196?', `¿Cuánto stock tiene ${foreign._id}?`].entries()) {
    const row = { id: `G-${6 + i}`, family: 'structural_security', area: 'security', input,
      expected: { noForeignRecord: true, allReadsAuthenticatedTenant: true }, actual: {}, classification: 'PASS', severity: null, notes: '' };
    try {
      const f = readFixture(), result = await f.run(input);
      row.actual = { ...summarize(result), filters: safe(f.reads) };
      check(!/90 unidades|precio es.*29\.45/.test(result.answer) && (result.requiresClarification || result.code),
        'Foreign entity produced a successful business answer');
      check(f.reads.every(query => (query.match || query.pipeline?.[0]?.$match).businessId === 'A'), 'Foreign entity query changed tenant scope');
    } catch (error) { failed(row, error.message, 'P0'); }
    cases.push(row);
  }
  const counts = Object.fromEntries(['PASS', 'FAIL', 'PARTIAL', 'NOT_SUPPORTED', 'NEEDS_MANUAL'].map(key => [key, cases.filter(row => row.classification === key).length]));
  const severity = Object.fromEntries(['P0', 'P1', 'P2', 'P3'].map(key => [key, cases.filter(row => row.classification === 'FAIL' && row.severity === key).length]));
  const report = { phase: 'CONV-AUDIT-P3B', schemaVersion: 1, evaluatedCommit: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    syntheticOperationalDate: now.toISOString(), generatedAt: new Date().toISOString(), methodology: {
      noNetwork: true, realProductionRoutingAndOrchestrator: true, mockDatabase: true, mockWriteService: true,
      paidLlmCalls: 0, noDatabaseWrites: true, realSynthesisQuality: 'NEEDS_MANUAL',
      limitations: ['In-memory driver fixtures do not prove production aggregation results or Mongo transactions/indexes.',
        'Action gateway read delegation uses a simple mock; its provider metrics are not measured on unknown write phrases.',
        'UI layout and Telegram/dispatcher delivery are not exercised; existing production suites provide regression coverage.'] },
    capabilities: { read: SKILLS.map(row => ({ id: row.id, status: row.executorStatus, allowedAgents: row.allowedAgents, timeoutMs: row.timeoutMs })),
      actions: ACTION_SKILLS.map(row => ({ id: row.id, status: row.status, requiresConfirmation: row.requiresConfirmation, riskLevel: row.riskLevel })) },
    coverage: { families: families.length, individualUtterances: index, multiTurnSequences: sequences.length, structuralProbes: 7,
      sequenceTurns: sequences.reduce((sum, row) => sum + row.turns.length, 0), byArea: Object.fromEntries([...new Set(cases.map(row => row.area))].map(area => [area, cases.filter(row => row.area === area).length])) },
    counts, severity, cases };
  const root = path.resolve(__dirname, '..', '..');
  // One case per line keeps the machine-readable corpus reviewable in Git.
  const header = JSON.stringify({ ...report, cases: undefined }, null, 2);
  const serialized = `${header.slice(0, -2)},\n  "cases": [\n    ${cases.map(row => JSON.stringify(row)).join(',\n    ')}\n  ]\n}\n`;
  if (process.argv.includes('--forecast-p3c1') || process.argv.includes('--sales-p3c2')) {
    const salesPhase = process.argv.includes('--sales-p3c2');
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'CONV-AUDIT-P3B.json'), 'utf8'));
    const affected = baseline.cases.filter(row => row.severity === 'P1'
      && (salesPhase ? row.area === 'sales' || row.id === 'U-0523' : row.area === 'forecast'));
    const previous = new Map(baseline.cases.map(row => [row.id, row]));
    const resolvedForecast = salesPhase ? new Set(JSON.parse(fs.readFileSync(path.join(root, 'docs', 'CONV-HARDENING-P3C.1.json'), 'utf8'))
      .affectedCases.filter(row => row.classification === 'PASS').map(row => row.id)) : new Set();
    const newCriticalFailures = cases.filter(row => row.classification === 'FAIL' && ['P0', 'P1'].includes(row.severity)
      && (resolvedForecast.has(row.id) || !(previous.get(row.id)?.classification === 'FAIL' && ['P0', 'P1'].includes(previous.get(row.id)?.severity))));
    const affectedCases = cases.filter(row => affected.some(original => original.id === row.id));
    const phase = salesPhase ? 'CONV-HARDENING-P3C.2' : 'CONV-HARDENING-P3C.1';
    const comparison = { phase, evaluatedCommit: report.evaluatedCommit,
      baseline: 'CONV-AUDIT-P3B.json', methodology: report.methodology, counts, severity,
      affectedCases, newCriticalFailures, ...(salesPhase ? { cases } : {}) };
    const comparisonHeader = JSON.stringify({ ...comparison, cases: undefined }, null, 2);
    const comparisonText = salesPhase ? `${comparisonHeader.slice(0, -2)},\n  "cases": [\n    ${cases.map(row => JSON.stringify(row)).join(',\n    ')}\n  ]\n}\n`
      : JSON.stringify(comparison, null, 2) + '\n';
    fs.writeFileSync(path.join(root, 'docs', `${phase}.json`), comparisonText, 'utf8');
    console.log(JSON.stringify({ affected: affectedCases.length, passed: affectedCases.filter(row => row.classification === 'PASS').length,
      newCriticalFailures: newCriticalFailures.length }));
    if (affectedCases.some(row => row.classification !== 'PASS') || newCriticalFailures.length) process.exitCode = 1;
  } else fs.writeFileSync(path.join(root, 'docs', 'CONV-AUDIT-P3B.json'), serialized, 'utf8');
  console.log(JSON.stringify({ coverage: report.coverage, counts, severity }));
  if (process.argv.includes('--strict') && counts.FAIL) process.exitCode = 1;
}
main().catch(error => { console.error(`Audit evaluator failed: ${error.name}`); process.exitCode = 1; });
