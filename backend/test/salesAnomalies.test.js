'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { V3, createV3IntelligenceService } = require('../src/services/v3IntelligenceService');
const { createV3BusinessIntelligenceDashboard } = require('../src/services/v3BusinessIntelligenceDashboard');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');
const directory = path.join(__dirname, '../../ml/artifacts/sales-isolation-forest-v3');
const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8'));
const daily = JSON.parse(fs.readFileSync(path.join(directory, 'daily-results.json'), 'utf8'));
const keys = ['contractVersion', 'modelId', 'version', 'algorithm', 'learningType', 'task', 'trainingCutoff', 'analysisCutoff',
  'sampleCount', 'analysisDays', 'trainingTimestamp', 'features', 'transformations', 'contamination', 'threshold', 'anomalyCount',
  'anomalyRate', 'stability', 'scoreSemantics', 'selectionReason', 'status', 'artifactHash', 'limitations', 'reference'];
const evidence = { ...Object.fromEntries(keys.map(key => [key, metadata[key]])), mode: 'FROZEN',
  candidates: metadata.candidates.map(row => Object.fromEntries(['contamination', 'threshold', 'anomalyCount', 'anomalyRate', 'dates', 'jaccardMean', 'jaccardMin'].map(key => [key, row[key]]))) };
const context = { businessId: V3.businessId, userId: 'test', requestId: 'g4' };
const req = { user: { businessId: V3.businessId, _id: 'test' }, businessId: V3.businessId, query: {} };
const query = value => ({ select() { return this; }, lean() { return this; }, maxTimeMS: async () => value });
function fixture({ corrupt, fail = false } = {}) {
  const calls = [];
  const models = { HistoricalScenario: { findOne: filter => query({ ...filter, status: 'completed', sourceSha256: V3.datasetSha256,
    metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.historicalCutoff, timezone: V3.timezone } }) } };
  const mlClient = { intelligence: async (domain, payload) => {
    calls.push({ domain, payload });
    if (fail) { const error = new Error('private path'); error.functionalCode = 'ARTIFACT_UNAVAILABLE'; throw error; }
    const series = daily.filter(row => payload.period.startDate <= row.date && row.date <= payload.period.endDate);
    const anomalies = series.filter(row => row.isAnomaly);
    const data = { ...structuredClone(evidence), period: payload.period, filteredDays: series.length,
      filteredAnomalyCount: anomalies.length, series, topAnomalies: anomalies.toSorted((a, b) => a.anomalyScore-b.anomalyScore).slice(0, payload.limit) };
    const result = { requestId: payload.requestId, status: 'OK', data,
      metadata: { ...payload.context, source: 'CANONICAL_V3_BUNDLE', contractVersion: 'm6.9b-v3-intelligence-v1' } };
    return corrupt ? corrupt(result) : result;
  } };
  const service = createV3IntelligenceService({ models, mlClient, clock: () => new Date('2026-10-14T18:00:00Z'),
    snapshotBuilder: () => { throw new Error('Anomalies must not request LIVE snapshot'); } });
  return { calls, service, dashboard: createV3BusinessIntelligenceDashboard({ intelligenceService: service }) };
}
test('frozen anomalies use authenticated business domain and bounded 365-day series', async () => {
  const { dashboard, calls } = fixture();
  const result = await dashboard.salesAnomalies({ ...req, query: { businessId: 'OTHER', period: 'TODAY' } });
  assert.equal(result.data.anomalyCount, 71);
  assert.equal(result.data.series.length, 365);
  assert.equal(calls[0].domain, 'business');
  assert.equal(calls[0].payload.context.businessId, V3.businessId);
  assert.equal(calls[0].payload.context.asOfDate, V3.historicalCutoff);
  assert.equal(calls[0].payload.dataMode, 'HISTORICAL');
  assert.equal(calls[0].payload.operationalSnapshot, undefined);
});
test('date filter only narrows frozen output and limit only narrows ranking', async () => {
  const { dashboard } = fixture();
  const result = await dashboard.salesAnomalies({ ...req, query: { startDate: '2026-10-01', endDate: '2026-10-12', limit: '3' } });
  assert.equal(result.data.filteredDays, 12);
  assert.equal(result.data.anomalyCount, 71);
  assert.ok(result.data.topAnomalies.length <= 3);
});
test('cross-tenant and LIVE dates denied before ML', async () => {
  const { dashboard, service, calls } = fixture();
  await assert.rejects(service.salesAnomalies({ ...context, businessId: 'OTHER' }));
  assert.equal((await dashboard.salesAnomalies({ ...req, businessId: 'OTHER' })).error.httpStatus, 403);
  assert.equal((await dashboard.salesAnomalies({ ...req, query: { endDate: '2026-10-13' } })).error.httpStatus, 400);
  assert.equal((await dashboard.salesAnomalies({ ...req, query: { limit: '21' } })).error.httpStatus, 400);
  assert.equal(calls.length, 0);
});
test('wrong source/counts or invented probability rejected', async () => {
  for (const corrupt of [body => ({ ...body, metadata: { ...body.metadata, source: 'LIVE' } }),
    body => { body.data.filteredAnomalyCount = 0; return body; },
    body => { body.data.series[0] = { ...body.data.series[0], probability: .99 }; return body; }]) {
    const { service } = fixture({ corrupt });
    await assert.rejects(service.salesAnomalies(context));
  }
});
test('HTTP route requires authentication and serves frozen metadata', async () => {
  const { dashboard } = fixture();
  const app = express();
  app.use('/api/intelligence', createBusinessIntelligenceDashboardRoutes({ service: dashboard,
    authenticateMiddleware: (request, response, next) => {
      if (!request.headers.authorization) return response.status(401).json({ success: false });
      request.user = req.user; request.businessId = req.businessId; next();
    }, businessAccessMiddleware: (_req, _res, next) => next() }));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/intelligence/sales/anomalies`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: 'test-only' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.mode, 'FROZEN');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('missing artifact gives safe error', async () => {
  const { dashboard } = fixture({ fail: true });
  const result = await dashboard.salesAnomalies(req);
  assert.equal(result.error.code, 'ARTIFACT_UNAVAILABLE');
  assert.equal(result.error.httpStatus, 503);
  assert.ok(!JSON.stringify(result).includes('private path'));
});
