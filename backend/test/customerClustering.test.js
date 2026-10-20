'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { V3, createV3IntelligenceService } = require('../src/services/v3IntelligenceService');
const { createV3BusinessIntelligenceDashboard } = require('../src/services/v3BusinessIntelligenceDashboard');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, '../../ml/artifacts/customer-kmeans-v3/metadata.json'), 'utf8'));
const context = { businessId: V3.businessId, userId: 'test', requestId: 'g3' };
const req = { user: { businessId: V3.businessId, _id: 'test' }, businessId: V3.businessId, query: {} };
const query = value => ({ select() { return this; }, lean() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS: async () => value });
function fixture({ corrupt, fail = false } = {}) {
  const calls = [];
  const customer = { _id: '507f1f77bcf86cd799439011', name: 'Cliente Uno', stableCode: 'CUS-01' };
  const models = { HistoricalScenario: { findOne: filter => query({ ...filter, status: 'completed', sourceSha256: V3.datasetSha256,
    metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.historicalCutoff, timezone: V3.timezone } }) },
  Contact: {
    find: filter => { assert.equal(filter.businessId, V3.businessId); return query([customer]); },
    findOne: filter => {
      assert.equal(filter.businessId, V3.businessId);
      const matches = filter._id ? String(filter._id) === customer._id
        : (filter.$or || []).some(condition => condition.stableCode === customer.stableCode);
      return query(matches ? customer : null);
    }
  } };
  const snapshot = { metadata: { businessId: V3.businessId, scenarioId: V3.scenarioId, asOfDate: '2026-10-14', dataVersion: '3', snapshotVersion: 'v3-operational-snapshot-v2', snapshotHash: 'verified-hash' } };
  const mlClient = { intelligence: async (domain, payload) => {
    calls.push({ domain, payload });
    if (fail) { const error = new Error('private path'); error.functionalCode = 'ARTIFACT_UNAVAILABLE'; throw error; }
    const live = payload.dataMode === 'LIVE';
    const data = live ? { total: 1, items: [{ customerCode: 'CUS-01', rfm90d: { raw: { recencyDays: 2, frequency90d: 4, monetary90dCents: 12345 } } }] }
      : { ...structuredClone(evidence), ...(payload.customerCode ? { assignmentAsOfDate: payload.assignmentAsOfDate,
        assignments: [{ customerRef: payload.customerCode, status: 'ASSIGNED', cluster: 2 }] } : {}) };
    const result = { requestId: payload.requestId, status: 'OK', data, metadata: { ...payload.context,
      source: live ? 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT' : 'CANONICAL_V3_BUNDLE',
      contractVersion: live ? 'm6.9f4-live-intelligence-v1' : 'm6.9b-v3-intelligence-v1',
      ...(live ? { dataVersion: '3', snapshotHash: 'verified-hash' } : {}) } };
    return corrupt ? corrupt(result) : result;
  } };
  const service = createV3IntelligenceService({ models, mlClient, clock: () => new Date('2026-10-14T18:00:00Z'),
    snapshotBuilder: async () => ({ mode: 'LIVE', dataVersion: '3', snapshot }) });
  return { calls, service, dashboard: createV3BusinessIntelligenceDashboard({ intelligenceService: service }) };
}
test('frozen clustering travels through authenticated customer domain with no user RFM', async () => {
  const { dashboard, calls } = fixture();
  const result = await dashboard.customerClustering({ ...req, query: { businessId: 'OTHER', monetary: 999, period: 'TODAY' } });
  assert.equal(result.data.algorithm, 'KMeans');
  assert.equal(calls[0].domain, 'customers');
  assert.equal(calls[0].payload.context.businessId, V3.businessId);
  assert.equal(calls[0].payload.context.asOfDate, V3.historicalCutoff);
  assert.equal(calls[0].payload.assignmentRfm, undefined);
});
test('current assignment uses tenant-resolved customer and verified skill RFM', async () => {
  const { dashboard, calls } = fixture();
  const result = await dashboard.customerClustering({ ...req, query: { customerRef: 'CUS-01', monetary: 999 } });
  assert.equal(result.data.assignments[0].customerRef, 'CUS-01');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].payload.assignmentRfm, { recency: 2, frequency: 4, monetary: 123.45 });
  assert.equal(calls[1].payload.assignmentAsOfDate, '2026-10-14');
});
test('current assignment resolves a Contact Mongo ObjectId to its canonical customerCode', async () => {
  const { dashboard, calls } = fixture();
  const result = await dashboard.customerClustering({ ...req, query: { customerRef: '507f1f77bcf86cd799439011' } });
  assert.equal(result.data.assignments[0].customerRef, 'CUS-01');
  assert.deepEqual(calls[1].payload.assignmentRfm, { recency: 2, frequency: 4, monetary: 123.45 });
});
test('clustering rejects a contact outside the authenticated tenant and does not call ML', async () => {
  const { dashboard, calls } = fixture();
  const result = await dashboard.customerClustering({ ...req, query: { customerRef: '507f191e810c19729de860ea' } });
  assert.equal(result.error.code, 'CUSTOMER_NOT_FOUND');
  assert.equal(result.error.httpStatus, 404);
  assert.equal(calls.length, 0);
});
test('clustering rejects missing or non-identity references without name/email fallback', async () => {
  const { dashboard, calls } = fixture();
  const result = await dashboard.customerClustering({ ...req, query: { customerRef: 'Cliente Uno' } });
  assert.equal(result.error.code, 'CUSTOMER_NOT_FOUND');
  assert.equal(calls.length, 0);
});
test('tenant mismatch and invalid customer query fail safely', async () => {
  const { dashboard, service, calls } = fixture();
  await assert.rejects(service.customerClustering({ ...context, businessId: 'OTHER' }));
  assert.equal((await dashboard.customerClustering({ ...req, businessId: 'OTHER' })).error.httpStatus, 403);
  assert.equal((await dashboard.customerClustering({ ...req, query: { customerRef: ['CUS-01'] } })).error.httpStatus, 400);
  assert.equal(calls.length, 0);
});
test('wrong model lineage and invented probabilities are denied', async () => {
  for (const corrupt of [body => ({ ...body, metadata: { ...body.metadata, datasetSha256: 'wrong' } }),
    body => { body.data.assignments[0].probability = .99; return body; }]) {
    const { service } = fixture({ corrupt });
    await assert.rejects(service.customerClustering(context));
  }
});
test('authenticated HTTP clustering route precedes customer parameter route', async () => {
  const { dashboard } = fixture();
  const app = express();
  app.use('/api/intelligence', createBusinessIntelligenceDashboardRoutes({ service: dashboard,
    authenticateMiddleware: (request, response, next) => {
      if (!request.headers.authorization) return response.status(401).json({ success: false });
      request.user = req.user; request.businessId = req.businessId; next();
    }, businessAccessMiddleware: (_req, _res, next) => next() }));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/intelligence/customers/clustering`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: 'test-only' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.sampleCount, 38);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('missing artifact reports safe error without implementation path', async () => {
  const { dashboard } = fixture({ fail: true });
  const result = await dashboard.customerClustering(req);
  assert.equal(result.error.httpStatus, 503);
  assert.equal(result.error.code, 'ARTIFACT_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('private path'));
});
