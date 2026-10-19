'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');
const { getCertifiedStable2020Replay } = require('../src/services/forecastReplayCertificateService');

const certificate = getCertifiedStable2020Replay();

function createRouter() {
  const dashboard = new Proxy({}, { get() { throw new Error('Dashboard/ML service must not run'); } });
  return createBusinessIntelligenceDashboardRoutes({
    service: dashboard,
    authenticateMiddleware: (_req, _res, next) => next(),
    businessAccessMiddleware: (_req, _res, next) => next(),
  });
}

function certificateRoute(router) {
  return router.stack.find(layer => layer.route?.path === '/forecast/replay/certified-stable-2020').route.stack[0].handle;
}

async function invoke(handler, query = {}) {
  const response = {
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ query }, response);
  return response;
}

test('certified replay reader returns the fixed sanitized historical evidence', () => {
  assert.equal(certificate.demoRunId, 'cert-stable-2020');
  assert.equal(certificate.purpose, 'REPLAY_ONLY');
  assert.equal(certificate.profile, 'STABLE');
  assert.equal(certificate.seed, 2020);
  assert.equal(certificate.requiredOrigins, 107);
  assert.equal(certificate.horizons[0].status, 'PASS');
  assert.equal(certificate.horizons[1].status, 'REJECTED');
  assert.deepEqual(certificate.horizons[1].reasons, ['P_FOLD_CATA_MAE:F3:BEB-GAS-003']);
  assert.deepEqual(certificate.liveImpact, {
    modifiesLive: false,
    modifiesRegistry: false,
    modifiesActive: false,
    promotesActive: false,
  });
  assert.match(certificate.interpretation.explanations.join(' '), /107 origins/);
});

test('certificate route is behind shared authentication/access middleware and returns fixed read-only evidence', async () => {
  const router = createRouter();
  assert.deepEqual(router.stack.slice(0, 2).map(layer => layer.name), ['authenticateMiddleware', 'businessAccessMiddleware']);
  const response = await invoke(certificateRoute(router));
  assert.equal(response.statusCode, undefined);
  assert.match(response.headers['Cache-Control'], /no-store/);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.purpose, 'REPLAY_ONLY');
  assert.equal(response.body.data.requiredOrigins, 107);
  assert.equal(response.body.data.horizons.find(item => item.horizonDays === 7).status, 'PASS');
  assert.equal(response.body.data.horizons.find(item => item.horizonDays === 14).status, 'REJECTED');
});

test('certificate endpoint rejects client-selected run or file parameters', async () => {
  const response = await invoke(certificateRoute(createRouter()), { runId: 'other', file: '../../tmp.json' });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    success: false,
    code: 'FORECAST_REPLAY_SELECTION_NOT_ALLOWED',
  });
});
