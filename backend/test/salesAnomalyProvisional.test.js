'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createV3IntelligenceService, V3 } = require('../src/services/v3IntelligenceService');
const { createV3BusinessIntelligenceDashboard } = require('../src/services/v3BusinessIntelligenceDashboard');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');
const req = { user: { businessId: V3.businessId, _id: 'test' }, businessId: V3.businessId, query: {} };
function fixture({ corrupt = value => value, fail = false, operationalDate = '2026-10-20' } = {}) {
  let snapshots = 0, calls = 0;
  const sm = { businessId: V3.businessId, scenarioId: V3.scenarioId, asOfDate: operationalDate, operationalDate,
    historicalDatasetVersion: V3.datasetVersion, historicalDatasetSha256: V3.datasetSha256, dataVersion: '184',
    capturedAtUtc: `${operationalDate}T15:00:00.000Z`, snapshotHash: 'a'.repeat(64) };
  const models = { HistoricalScenario: { findOne: filter => ({ select() { return this; }, lean() { return this; },
    maxTimeMS: async () => ({ ...filter, status: 'completed', sourceSha256: V3.datasetSha256,
      metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.historicalCutoff, timezone: V3.timezone } }) }) } };
  const service = createV3IntelligenceService({ models, clock: () => new Date(sm.capturedAtUtc),
    snapshotBuilder: async options => { snapshots++; assert.equal(options.businessId, V3.businessId);
      return { mode: 'LIVE', dataVersion: '184', snapshot: { metadata: sm } }; },
    mlClient: { intelligence: async (domain, payload) => {
      calls++; assert.equal(domain, 'business'); assert.equal(payload.mode, 'anomalies_provisional');
      assert.equal(payload.dataMode, 'LIVE'); assert.equal(payload.context.businessId, V3.businessId);
      if (fail) throw new Error('mongodb://secret private raw error');
      return corrupt({ requestId: payload.requestId, status: 'OK', metadata: { ...payload.context,
        dataVersion: sm.dataVersion, snapshotHash: sm.snapshotHash, source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT',
        contractVersion: 'm6.9f4-live-intelligence-v1' }, data: {
        modelVersion: 'sales-isolation-forest-v3-v1', provisional: true, localDate: sm.asOfDate, revision: '184', observedAt: sm.capturedAtUtc,
        businessContext: { businessId: V3.businessId, scenarioId: V3.scenarioId, datasetVersion: V3.datasetVersion },
        status: 'EVALUATED', reason: null, aggregate: { revenuePEN: 10, tickets: 3, units: 5, averageTicketPEN: 10 / 3 },
        modelInput: { weekday: new Date(`${operationalDate}T00:00:00Z`).getUTCDay() || 7,
          weekdayLogTicketsDeviation: -1, weekdayLogAverageTicketDeviation: -.1 },
        inference: { anomalyScore: -.4, decisionFunction: .1, prediction: 1, label: 'WITHIN_PATTERN', regionSignature: 'b'.repeat(64) },
        modelIdentity: { threshold: -.5, artifact: 'model.joblib', artifactHash: 'a'.repeat(64), weeklyReferenceHash: 'b'.repeat(64), trainingCutoff: '2026-06-30', analysisCutoff: V3.historicalCutoff },
        commercial: { grossMargin: null, costCoverage: { knownSaleLines: 2, unknownSaleLines: 1, status: 'NOT_AVAILABLE' } },
      } });
    } } });
  return { service, dashboard: createV3BusinessIntelligenceDashboard({ intelligenceService: service }), counts: () => ({ calls, snapshots }) };
}
test('current-day provisional endpoint uses exactly one authorized snapshot and one ML call', async () => {
  const { dashboard, counts } = fixture();
  const response = await dashboard.salesAnomalyProvisional(req);
  assert.equal(response.data.provisional, true); assert.equal(response.data.aggregate.averageTicketPEN, 10 / 3);
  assert.equal(response.data.modelIdentity.threshold, -.5); assert.equal(response.data.revision, '184');
  assert.deepEqual(counts(), { calls: 1, snapshots: 1 });
});

for (const state of ['NO_TICKETS', 'WITHIN_PATTERN', 'ANOMALOUS_SIGNAL'])
  test(`A5.1.2 direct service and Sales adapter preserve 2026-10-21 ${state}`, async () => {
    // Contract fixtures only; these are not measurements of the cloud smoke.
    const { service, counts } = fixture({ operationalDate: '2026-10-21', corrupt: body => {
      if (state === 'NO_TICKETS') Object.assign(body.data, { status: 'NOT_EVALUABLE', reason: state,
        inference: null, modelInput: null, aggregate: { revenuePEN: 0, units: 0, tickets: 0, averageTicketPEN: null } });
      if (state === 'ANOMALOUS_SIGNAL') Object.assign(body.data.inference,
        { anomalyScore: -.6, decisionFunction: -.1, prediction: -1, label: state });
      return body;
    } });
    const context = { businessId: V3.businessId, userId: 'test', requestId: `a512-${state}` };
    const direct = await service.salesAnomalyProvisional(context);
    const adapted = await service.executeAssistant({ context, signal: new AbortController().signal,
      skill: { id: 'get_business_analytics', maxRecords: 5 }, args: { mode: 'provisional' } });
    assert.deepEqual(adapted.data, direct);
    assert.equal(adapted.data.localDate, '2026-10-21');
    assert.equal(adapted.metadata.asOf, '2026-10-21');
    assert.equal(adapted.status, state === 'NO_TICKETS' ? 'NO_DATA' : 'READY');
    assert.equal(direct.status, state === 'NO_TICKETS' ? 'NOT_EVALUABLE' : 'EVALUATED');
    assert.equal(direct.reason, state === 'NO_TICKETS' ? 'NO_TICKETS' : null);
    if (state === 'NO_TICKETS') assert.equal(direct.inference, null);
    else assert.equal(direct.inference.label, state);
    assert.deepEqual(counts(), { calls: 2, snapshots: 1 });
  });

test('A5.1 Sales reuses the provisional contract through its read skill, without another model call', async () => {
  const { service, counts } = fixture();
  const { createAgentOrchestrator } = require('../src/agents/orchestrator');
  const runtime = createAgentOrchestrator({ neutralProvider: null, dependencies: { v3Service: service } });
  const result = await runtime.handle({ user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId,
    role: 'user', isActive: true } }, { message: '¿Hubo transacciones anómalas?' });
  assert.equal(result.code, null, result.answer); assert.equal(result.agent, 'sales');
  assert.deepEqual(result.participants.map(row => row.agentId).sort(), ['coordinator', 'sales']);
  assert.match(result.answer, /agregado diario/); assert.match(result.answer, /histórico congelado/);
  assert.match(result.answer, /No es una confirmación ni una probabilidad de fraude/);
  assert.equal(result.usage.totalLlmCalls, 0); assert.deepEqual(counts(), { calls: 1, snapshots: 1 });
});

test('A5.1 provisional non-evaluable state is not replaced by a zero score', async () => {
  const context = { businessId: V3.businessId, userId: 'test', requestId: 'a51-provisional' };
  const { service } = fixture({ corrupt: body => { Object.assign(body.data, { status: 'NOT_EVALUABLE', reason: 'NO_TICKETS',
    inference: null, modelInput: null, aggregate: { revenuePEN: 0, units: 0, tickets: 0, averageTicketPEN: null } }); return body; } });
  const result = await service.executeAssistant({ context, signal: new AbortController().signal,
    skill: { id: 'get_business_analytics', maxRecords: 5 }, args: { mode: 'provisional' } });
  assert.equal(result.status, 'NO_DATA'); assert.equal(result.data.inference, null); assert.equal(result.data.reason, 'NO_TICKETS');
  await assert.rejects(service.executeAssistant({ context, signal: new AbortController().signal,
    skill: { id: 'get_business_analytics', maxRecords: 5 }, args: { mode: 'provisional', productRef: 'BEB-GAS-001' } }),
  { code: 'AGENT_INVALID_SKILL_ARGS' });
});

for (const state of ['NOT_EVALUABLE', 'WITHIN_PATTERN', 'ANOMALOUS_SIGNAL'])
  test(`A5.1.1 human provisional presentation preserves ${state}`, async () => {
    const { service, counts } = fixture({ corrupt: body => {
      if (state === 'NOT_EVALUABLE') Object.assign(body.data, { status: 'NOT_EVALUABLE', reason: 'NO_TICKETS', inference: null,
        modelInput: null, aggregate: { revenuePEN: 0, units: 0, tickets: 0, averageTicketPEN: null } });
      if (state === 'ANOMALOUS_SIGNAL') Object.assign(body.data.inference,
        { anomalyScore: -.6, decisionFunction: -.1, prediction: -1, label: state });
      return body;
    } });
    const { createAgentOrchestrator } = require('../src/agents/orchestrator');
    const runtime = createAgentOrchestrator({ neutralProvider: null, dependencies: { v3Service: service } });
    const result = await runtime.handle({ user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId,
      role: 'user', isActive: true } }, { message: 'se detectaron transacciones anomalas?' });
    assert.equal(result.code, null, result.answer); assert.equal(result.agent, 'sales');
    if (state === 'NOT_EVALUABLE') {
      assert.match(result.answer, /^Hoy no hay ventas registradas para evaluar anomalías/);
      assert.match(result.answer, /Isolation Forest necesita actividad de ventas en el agregado diario/);
      assert.doesNotMatch(result.answer, /no hubo anomalías|sin anomalías|No se observó/);
      assert.equal(result.v3Views[0].metrics[0].value, 'No evaluable');
      assert.equal(result.v3Views[0].metrics[1].value, 'No disponible');
      assert.deepEqual(result.v3Views[0].metrics.find(metric => metric.label === 'Motivo'),
        { label: 'Motivo', value: 'No hay tickets registrados hoy' });
    } else assert.match(result.answer, state === 'ANOMALOUS_SIGNAL' ? /^Se observó una señal/ : /^No se observó una señal/);
    assert.match(result.answer, /no clasifica transacciones individuales/); assert.match(result.answer, /No es una confirmación ni una probabilidad de fraude/);
    assert.equal(result.usage.totalLlmCalls, 0); assert.deepEqual(counts(), { calls: 1, snapshots: 1 });
  });
test('date/tenant parameters and mismatched authenticated business are rejected before ML', async () => {
  const { dashboard, service, counts } = fixture();
  for (const query of [{ asOf: '2026-10-19' }, { businessId: 'OTHER' }, { scenarioId: 'OTHER' }])
    assert.equal((await dashboard.salesAnomalyProvisional({ ...req, query })).error.httpStatus, 400);
  assert.equal((await dashboard.salesAnomalyProvisional({ ...req, businessId: 'OTHER' })).error.httpStatus, 403);
  await assert.rejects(service.salesAnomalyProvisional({ businessId: 'OTHER' }));
  assert.deepEqual(counts(), { calls: 0, snapshots: 0 });
});
test('wrong lineage, revision, date, threshold and decision fail closed', async () => {
  for (const change of [d => { d.revision = '999'; }, d => { d.businessContext.businessId = 'OTHER'; },
    d => { d.modelIdentity.threshold = -.4; }, d => { d.localDate = '2026-10-19'; },
    d => { d.observedAt = '2026-10-20T15:00:00.001Z'; },
    d => { d.inference.prediction = -1; }, d => { d.modelInput.weekday = 3; }]) {
    const { dashboard } = fixture({ corrupt: body => { change(body.data); return body; } });
    assert.equal((await dashboard.salesAnomalyProvisional(req)).error.httpStatus, 503);
  }
});
test('snapshot timestamp is matched by instant across UTC serializations', async () => {
  const { dashboard } = fixture({ corrupt: body => {
    body.data.observedAt = '2026-10-20T15:00:00+00:00';
    return body;
  } });
  const response = await dashboard.salesAnomalyProvisional(req);
  assert.equal(response.data.status, 'EVALUATED');
  assert.equal(response.data.observedAt, '2026-10-20T15:00:00+00:00');
});
test('no-score response is explicit and unexpected fields are never projected', async () => {
  const { dashboard } = fixture({ corrupt: body => { Object.assign(body.data, {
    status: 'NOT_EVALUABLE', reason: 'NO_TICKETS', inference: null, modelInput: null, rawSecret: 'private',
    aggregate: { revenuePEN: 0, units: 0, tickets: 0, averageTicketPEN: null } }); return body; } });
  const response = await dashboard.salesAnomalyProvisional(req);
  assert.equal(response.data.status, 'NOT_EVALUABLE'); assert.equal(response.data.inference, null);
  assert.ok(!JSON.stringify(response).includes('private'));
});
test('ML failure is sanitized', async () => {
  const { dashboard } = fixture({ fail: true }); const response = await dashboard.salesAnomalyProvisional(req);
  assert.equal(response.error.httpStatus, 503); assert.equal(response.error.code, 'ANALYTICS_UNAVAILABLE');
  assert.ok(!JSON.stringify(response).includes('secret'));
});

test('Sales distinguishes ML unavailability from a valid NO_TICKETS result', async () => {
  const { service } = fixture({ fail: true });
  const { createAgentOrchestrator } = require('../src/agents/orchestrator');
  const runtime = createAgentOrchestrator({ neutralProvider: null, dependencies: { v3Service: service } });
  const result = await runtime.handle({ user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId,
    role: 'user', isActive: true } }, { message: 'se detectaron transacciones anomalas?' });
  assert.match(result.answer, /El módulo analítico no está disponible en este momento/);
  assert.doesNotMatch(result.answer, /Hoy no hay ventas|No se observó|secret/);
  assert.ok(!(result.v3Views || []).some(view => view.title === 'Señal provisional de ventas'));
});

test('other non-evaluable reasons are not presented as a day without tickets', async () => {
  const { service } = fixture({ corrupt: body => {
    Object.assign(body.data, { status: 'NOT_EVALUABLE', reason: 'INVALID_AVERAGE_TICKET',
      modelInput: null, inference: null,
      aggregate: { revenuePEN: 0, units: 5, tickets: 3, averageTicketPEN: 0 } });
    return body;
  } });
  const { createAgentOrchestrator } = require('../src/agents/orchestrator');
  const runtime = createAgentOrchestrator({ neutralProvider: null, dependencies: { v3Service: service } });
  const result = await runtime.handle({ user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId,
    role: 'user', isActive: true } }, { message: 'se detectaron transacciones anomalas?' });
  assert.equal(result.code, null, result.answer);
  assert.match(result.answer, /^No hay una señal de anomalía evaluable/);
  assert.doesNotMatch(result.answer, /Hoy no hay ventas|No se observó/);
  assert.ok(!result.v3Views[0].metrics.some(metric => metric.label === 'Motivo'));
});
test('HTTP provisional route remains authenticated and no-store', async () => {
  const { dashboard } = fixture(); const app = express();
  app.use('/api/intelligence', createBusinessIntelligenceDashboardRoutes({ service: dashboard,
    authenticateMiddleware: (request, response, next) => { if (!request.headers.authorization) return response.sendStatus(401);
      request.user = req.user; request.businessId = req.businessId; next(); }, businessAccessMiddleware: (_q, _s, next) => next() }));
  const server = app.listen(0);
  try { const url = `http://127.0.0.1:${server.address().port}/api/intelligence/sales/anomalies/provisional`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: 'test' } }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).data.status, 'EVALUATED');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
