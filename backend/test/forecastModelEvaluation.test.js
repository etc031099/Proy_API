'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { V3, createV3IntelligenceService } = require('../src/services/v3IntelligenceService');
const { createV3BusinessIntelligenceDashboard } = require('../src/services/v3BusinessIntelligenceDashboard');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');

const evaluation = { contractVersion: 'forecast-model-evaluation-v1', analysisCutoff: V3.historicalCutoff,
  selectedOperationalMethod: { algorithm: 'MOVING_AVERAGE_28', modelType: 'STATISTICAL_BASELINE' },
  modelEvaluation: ['EVALUATED', 'REJECTED_FOR_OPERATIONAL_USE'].map(modelStatus => ({
    algorithm: 'HistGradientBoostingRegressor', modelStatus, metrics: { test: { wape: .3 } } })) };
const context = { businessId: V3.businessId, userId: 'test-user', requestId: 'evaluation-test' };
const request = { user: { _id: 'test-user', businessId: V3.businessId }, businessId: V3.businessId, query: {} };
const query = value => ({ select() { return this; }, lean() { return this; }, maxTimeMS: async () => value });
function fixture({ corrupt, fail = false } = {}) {
  const calls = [];
  const models = { HistoricalScenario: { findOne: filter => {
    assert.equal(filter.businessId, V3.businessId);
    return query({ ...filter, status: 'completed', sourceSha256: V3.datasetSha256,
      metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.historicalCutoff, timezone: V3.timezone } });
  } } };
  const mlClient = { intelligence: async (domain, payload) => {
    calls.push({ domain, payload });
    if (fail) { const error = new Error('private/path'); error.functionalCode = 'ARTIFACT_UNAVAILABLE'; throw error; }
    const result = { requestId: payload.requestId, status: 'OK', data: structuredClone(evaluation),
      metadata: { ...payload.context, source: 'CANONICAL_V3_BUNDLE', contractVersion: 'm6.9b-v3-intelligence-v1' } };
    return corrupt ? corrupt(result) : result;
  } };
  const intelligence = createV3IntelligenceService({ models, mlClient, clock: () => new Date('2026-10-14T18:00:00Z'),
    snapshotBuilder: () => { throw new Error('Evaluation must not read LIVE state'); } });
  return { calls, intelligence, dashboard: createV3BusinessIntelligenceDashboard({ intelligenceService: intelligence }) };
}

test('evaluation uses authenticated scenario and frozen internal forecast mode without LIVE snapshot', async () => {
  const { intelligence, calls } = fixture();
  assert.deepEqual(await intelligence.forecastEvaluation(context), evaluation);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, 'forecast');
  assert.equal(calls[0].payload.mode, 'evaluation');
  assert.equal(calls[0].payload.dataMode, 'HISTORICAL');
  assert.equal(calls[0].payload.context.asOfDate, V3.historicalCutoff);
  assert.equal(calls[0].payload.context.businessId, V3.businessId);
  assert.equal(calls[0].payload.operationalSnapshot, undefined);
});

test('foreign tenant cannot query evaluation through ML client', async () => {
  const { intelligence, calls } = fixture();
  await assert.rejects(intelligence.forecastEvaluation({ ...context, businessId: 'OTHER' }));
  assert.equal(calls.length, 0);
});

test('evaluation rejects mismatched lineage and an HGB operational champion', async () => {
  for (const corrupt of [body => ({ ...body, metadata: { ...body.metadata, datasetSha256: '0'.repeat(64) } }),
    body => { body.data.modelEvaluation[1].modelStatus = 'OPERATIONAL'; return body; }]) {
    await assert.rejects(fixture({ corrupt }).intelligence.forecastEvaluation(context));
  }
});

test('dashboard returns safe errors and ignores period/UI dates for fixed evaluation evidence', async () => {
  const { dashboard, calls } = fixture();
  assert.deepEqual((await dashboard.forecastEvaluation({ ...request, query: { asOf: 'bad', period: 'TODAY' } })).data, evaluation);
  assert.equal(calls[0].payload.context.asOfDate, V3.historicalCutoff);
  const error = (await fixture({ fail: true }).dashboard.forecastEvaluation(request)).error;
  assert.equal(error.code, 'ARTIFACT_UNAVAILABLE');
  assert.equal(error.httpStatus, 503);
  assert.ok(!JSON.stringify(error).includes('private/path'));
  assert.equal((await dashboard.forecastEvaluation({ ...request, businessId: 'OTHER' })).error.httpStatus, 403);
});

test('GET evaluation route is authenticated and exposes only the dashboard contract', async () => {
  const app = express();
  const { dashboard } = fixture();
  app.use('/api/intelligence', createBusinessIntelligenceDashboardRoutes({ service: dashboard,
    authenticateMiddleware: (req, res, next) => {
      if (req.headers.authorization !== 'test-only') return res.status(401).json({ success: false });
      req.user = request.user; req.businessId = request.businessId; next();
    }, businessAccessMiddleware: (_req, _res, next) => next() }));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/intelligence/forecast/evaluation`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: 'test-only' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: evaluation });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
