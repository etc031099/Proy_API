'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config/v3Operational');
const { createForecastMlUpdateHistoryService, LIMIT_DEFAULT, LIMIT_MAX } = require('../src/services/forecastMlUpdateHistoryService');
const { createForecastMlUpdateRoutes } = require('../src/routes/forecastMlUpdate');
const { authenticate, checkBusinessAccess } = require('../src/middleware/auth');

const ids = Array.from({ length: 54 }, (_, i) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`);
const date = '2026-10-16T12:00:00.000Z';
const projection = {
  snapshot: { businessId: config.businessId, scenarioId: config.scenarioId, dataVersion: '83', asOf: '2026-10-16',
    capturedAtUtc: date, observationsClosedThrough: '2026-10-15', snapshotHash: 'secret-snapshot',
    products: [{ sku: 'SKU-1', productName: 'Producto 1' }, { sku: 'SKU-2', productName: 'Producto 2' }] },
  horizons: [{ horizonDays: 7, activeVersionBefore: 1, activeVersionAfter: 2, candidateVersion: 2,
    trainingJobReference: 'job-7', resultStatus: 'PROMOTED', promotionDecision: 'PROMOTED', activeChangeSource: 'EXECUTION',
    availableOrigins: 107, requiredOrigins: 107 }, { horizonDays: 14, resultStatus: 'EVALUATED_NO_PROMOTION',
    promotionDecision: 'NOT_PROMOTED', promotionReason: 'POLICY_FAILED', availableOrigins: 60, requiredOrigins: 107 }],
  prediction: { status: 'COMPLETE', finalizedAt: date, idempotencyKey: 'secret-idempotency', summary: {
    totalProductsEvaluated: 2, comparableProductsCount: 2, predictionChangedCount: 1,
    p7: { increasedCount: 1 }, p14: { decreasedCount: 1 } },
    detail: [{ sku: 'SKU-1', productName: 'Producto 1', p7: { old: 1, new: 2, delta: 1, deltaPct: 100, direction: 'INCREASED' },
      p14: { old: null, new: 4, delta: null, deltaPct: null, direction: 'NOT_COMPARABLE' } },
      { sku: 'SKU-2', productName: 'Producto 2', p7: { old: 4, new: 4, delta: 0, deltaPct: 0, direction: 'UNCHANGED' },
        p14: { old: 4, new: 5, delta: 1, deltaPct: 25, direction: 'INCREASED' } }] },
  inventory: { status: 'PARTIAL', reasonCode: 'INVENTORY_PARTIAL_COMPARISON', summary: {
    totalProductsEvaluated: 2, comparableProductsCount: 1, riskChangedCount: 1, reorderDecisionChangedCount: 1,
    recommendedQtyChangedCount: 1, reorderPointChangedCount: 1, coverageChangedCount: 1,
    rankingChangedCount: 0, unavailableCount: 1, notComparableCount: 1 }, details: [
      { sku: 'SKU-1', productName: 'Producto 1', risk: { before: null, after: 'LOW', changed: null },
        shouldReorder: { before: null, after: false, changed: null }, recommendedQty: { before: null, after: 2, delta: null },
        reorderPoint: { before: 3, after: 4, delta: 1 }, coverage: { daysCoverBefore: 4, daysCoverAfter: 5, delta: 1 },
        ranking: { positionBefore: null, positionAfter: null, delta: null, status: 'NOT_COMPARABLE' },
        availability: { before: 'PARTIAL', after: 'AVAILABLE', reasonCodesBefore: ['MISSING_LEAD_TIME'], reasonCodesAfter: [] } },
      { sku: 'SKU-2', productName: 'Producto 2', risk: { before: 'HIGH', after: 'LOW', changed: true },
        shouldReorder: { before: true, after: false, changed: true }, recommendedQty: { before: 3, after: 1, delta: -2 },
        reorderPoint: { before: 8, after: 7, delta: -1 }, coverage: { daysCoverBefore: 2, daysCoverAfter: 6, delta: 4 },
        ranking: { positionBefore: 1, positionAfter: 1, delta: 0, status: 'COMPARABLE' },
        availability: { before: 'AVAILABLE', after: 'AVAILABLE', reasonCodesBefore: [], reasonCodesAfter: [] } }] },
};
function row(i, status = 'PROMOTED', requestedAt = date) {
  const horizons = structuredClone(projection.horizons);
  if (status !== 'PROMOTED' && status !== 'PARTIAL') {
    horizons[0].resultStatus = status; horizons[0].promotionDecision = 'NOT_PROMOTED'; horizons[0].activeChangeSource = 'NONE';
  }
  return { executionId: ids[i], businessId: config.businessId, scenarioId: config.scenarioId,
    triggerSource: i % 2 ? 'SCHEDULED' : 'MANUAL', requestSource: i % 2 ? 'SCHEDULED' : 'MANUAL',
    manualRequestKey: 'must-not-leak', github: { token: 'secret-github-token' }, requestedAt: new Date(requestedAt),
    startedAt: new Date(date), finishedAt: new Date(date), status, stage: 'FINISHED', reasonCode: null,
    message: 'safe reason', eligibility: null, signalTypes: ['SALE_COMPLETED'], dataVersionBefore: '82',
    dataVersionEvaluated: '83', observationsClosedThrough: '2026-10-15', availableOrigins: 107,
    requiredOrigins: 107, pendingBefore: true, pendingAfter: false, perHorizon: horizons,
    impact: { status: 'PARTIAL', reasonCode: 'INVENTORY_PARTIAL_COMPARISON', predictionStatus: 'COMPLETE',
      prediction: { kind: 'MODEL_ATTRIBUTED_IMPACT', snapshot: structuredClone(projection.snapshot),
        status: 'COMPLETE', summary: structuredClone(projection.prediction.summary),
        versions: [{ horizonDays: 7, beforeVersion: 1, afterVersion: 2 }, { horizonDays: 14, beforeVersion: 1, afterVersion: 1 }],
        detail: structuredClone(projection.prediction.detail) }, inventory: structuredClone(projection.inventory) },
    attempts: [{ runAttempt: 1, status, reasonCode: null, startedAt: new Date(date), finishedAt: new Date(date),
      perHorizon: structuredClone(horizons), github: { token: 'private' } }],
    _id: 'internal-mongo-id', __v: 3, rawFeatures: 'private feature data' };
}
const nested = (value, key) => key.split('.').reduce((x, p) => x?.[p], value);
function matches(doc, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(branch => matches(doc, branch));
    const actual = nested(doc, key);
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
      if ('$elemMatch' in expected) return Array.isArray(actual) && actual.some(value => matches(value, expected.$elemMatch));
      return Object.entries(expected).every(([op, value]) => op === '$gte' ? actual >= value : op === '$lte' ? actual <= value : op === '$lt' ? actual < value : false);
    }
    return actual instanceof Date && expected instanceof Date ? actual.getTime() === expected.getTime() : actual === expected;
  });
}
function fakeModel(rows) {
  const reads = [];
  const query = (kind, filter) => {
    const state = { filter, projection: null, sort: null, limit: Infinity };
    const q = { select(v) { state.projection = v; return q; }, sort(v) { state.sort = v; return q; },
      limit(v) { state.limit = v; return q; }, lean() { return q; }, async exec() {
        reads.push({ kind, ...state }); const found = rows.filter(r => matches(r, filter));
        if (state.sort) found.sort((a, b) => b.requestedAt - a.requestedAt || b.executionId.localeCompare(a.executionId));
        return kind === 'findOne' ? structuredClone(found[0] || null) : structuredClone(found.slice(0, state.limit));
      } };
    return q;
  };
  return { reads, find: filter => query('find', filter), findOne: filter => query('findOne', filter) };
}
function setup(rows = Array.from({ length: 54 }, (_, i) => row(i))) {
  const model = fakeModel(rows), history = createForecastMlUpdateHistoryService({ model });
  const auth = (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
    return next();
  };
  const update = { request: async () => assert.fail('GET must not request'), status: async () => ({ current: true }) };
  const router = createForecastMlUpdateRoutes({ service: update, historyService: history,
    authenticateMiddleware: auth, businessAccessMiddleware: (req, res, next) => next() });
  return { router, history, model, rows, auth };
}
async function call(f, path, req = {}) {
  const layer = f.router.stack.find(value => value.route?.path === path);
  assert.ok(layer, `route ${path} exists`);
  const response = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; }, json(value) { this.body = value; return this; } };
  const request = { user: { businessId: config.businessId }, query: {}, params: {}, ...req };
  const noStore = f.router.stack.find(value => !value.route && value.handle.toString().includes("Cache-Control", "no-store"));
  noStore?.handle(request, response, () => {});
  await layer.route.stack.at(-1).handle(request, response);
  return response;
}

test('authenticated list is compact, newest first and uses default/max limits with stable cursor tie-breaker', async t => {
  const f = setup();
  assert.equal(f.router.stack[0].handle, f.auth);
  assert.equal(typeof f.router.stack[1].handle, 'function');
  const unauth = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  await f.router.stack[0].handle({ header: () => undefined }, unauth, () => assert.fail('auth required'));
  assert.equal(unauth.statusCode, 401);
  const first = await call(f, '/history'); assert.equal(first.statusCode, 200);
  assert.equal(first.headers['cache-control'], 'no-store');
  const payload = first.body.data;
  assert.equal(payload.page.limit, LIMIT_DEFAULT); assert.equal(payload.items.length, LIMIT_DEFAULT);
  assert.deepEqual(payload.items.slice(0, 3).map(x => x.executionId), ids.slice(51, 54).reverse());
  assert.ok(payload.page.nextCursor);
  assert.equal(JSON.stringify(payload).includes('SKU-1'), false);
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  assert.equal(JSON.stringify(payload).includes('_id'), false);
  const second = await call(f, '/history', { query: { limit: String(LIMIT_MAX), cursor: payload.page.nextCursor } });
  assert.equal(second.body.data.items.length, 54 - LIMIT_DEFAULT);
  assert.equal((await call(f, '/history', { query: { limit: String(LIMIT_MAX) } })).body.data.items.length, LIMIT_MAX);
  const tied = payload.items.filter(x => x.requestedAt === date).map(x => x.executionId);
  assert.deepEqual(tied, [...tied].sort().reverse());
  assert.equal(f.model.reads.every(r => !r.projection.includes('impact.prediction.detail') && !r.projection.includes('impact.inventory.details')), true);
});
test('filters accept only enumerated source/status/date/promotedOnly and reject tenant override', async t => {
  const rows = [row(0, 'NO_PENDING_WORK'), row(1, 'FAILED', '2026-10-15T10:00:00.000Z'), row(2, 'PROMOTED', '2026-10-15T10:00:00.000Z')];
  const f = setup(rows);
  let response = await call(f, '/history', { query: { triggerSource: 'SCHEDULED', status: 'FAILED', from: '2026-10-16', to: '2026-10-16' } });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.body.data.items, []);
  response = await call(f, '/history', { query: { status: 'NO_PENDING_WORK' } });
  assert.equal(response.body.data.items[0].status, 'NO_PENDING_WORK');
  response = await call(f, '/history', { query: { promotedOnly: 'true' } });
  assert.ok(response.body.data.items.every(x => x.status === 'PROMOTED'));
  for (const query of ['businessId=other', 'status=MADE_UP', 'triggerSource=MONGO', 'limit=51', 'limit=0',
    'from=2026-10-17&to=2026-10-16', 'promotedOnly=yes', 'unknown=x']) {
    const [key, value] = query.split('='); const q = Object.fromEntries(query.split('&').map(pair => pair.split('=')));
    assert.equal((await call(f, '/history', { query: q })).statusCode, 400, query);
  }
  const before = f.model.reads.length;
  assert.equal((await call(f, '/history', { user: { businessId: 'OTHER' } })).statusCode, 403);
  assert.equal(f.model.reads.length, before);
});
test('invalid, modified and cross-scope cursors return sanitized 400', async t => {
  const f = setup();
  const page = (await call(f, '/history', { query: { limit: '1' } })).body.data;
  const cursor = page.page.nextCursor;
  assert.equal((await call(f, '/history', { query: { cursor: 'not-a-cursor' } })).statusCode, 400);
  assert.equal((await call(f, '/history', { query: { cursor: `${cursor.slice(0, -1)}A` } })).statusCode, 400);
  const other = await call(f, '/history', { query: { cursor }, user: { businessId: 'OTHER' } });
  assert.equal(other.statusCode, 403);
  assert.deepEqual(other.body, { success: false, code: 'ML_SCOPE_UNAVAILABLE' });
});
test('legacy and malformed stored fields remain null or safe sentinels without inferred values', async () => {
  const legacy = row(0);
  delete legacy.requiredOrigins;
  delete legacy.perHorizon[0].requiredOrigins;
  legacy.reasonCode = 'raw database exception with secret';
  legacy.message = 'raw database exception with secret';
  legacy.stage = 'INTERNAL_TRACE_WITH_SECRET';
  legacy.impact.prediction.detail[0].p7.direction = 'RAW_PROVIDER_TEXT';
  const f = setup([legacy]);
  const item = (await call(f, '/history/:executionId', { params: { executionId: ids[0] } })).body.data;
  assert.equal(item.requiredOrigins, null);
  assert.equal(item.horizons[0].requiredOrigins, null);
  assert.equal(item.reasonCode, 'UNKNOWN_REASON');
  assert.equal(item.message, null);
  assert.equal(item.stage, 'UNKNOWN');
  const product = (await call(f, '/history/:executionId/products', { params: { executionId: ids[0] } })).body.data.items[0];
  assert.equal(product.prediction.p7.direction, 'NOT_COMPARABLE');
  assert.equal(JSON.stringify(item).includes('secret'), false);
  assert.equal(JSON.stringify(product).includes('RAW_PROVIDER_TEXT'), false);
});
test('detail returns allowlisted prediction/inventory summaries and safe technical history across statuses', async t => {
  const rows = ['PROMOTED', 'EVALUATED_NO_PROMOTION', 'NOT_ELIGIBLE', 'NO_PENDING_WORK', 'PARTIAL', 'FAILED', 'INTERRUPTED']
    .map((status, i) => row(i, status));
  rows[3].impact = undefined; rows[4].impact.prediction.detail[0].p7.new = null;
  const f = setup(rows);
  for (const source of rows) {
    const response = await call(f, '/history/:executionId', { params: { executionId: source.executionId } });
    assert.equal(response.statusCode, 200);
    const item = response.body.data;
    assert.equal(item.status, source.status); assert.equal(item.horizons.length, 2);
    assert.equal(Object.hasOwn(item, '_id'), false); assert.equal(JSON.stringify(item).includes('token'), false);
    assert.equal(JSON.stringify(item).includes('features'), false); assert.equal(JSON.stringify(item).includes('secret-snapshot'), false);
    assert.equal(item.impact.prediction.status, source.impact?.prediction.status || 'NOT_CAPTURED');
    assert.equal(item.impact.inventory.status, source.impact?.inventory.status || 'NOT_CAPTURED');
  }
  assert.equal((await call(f, '/history/:executionId', { params: { executionId: rows[0].executionId }, query: { businessId: 'other' } })).statusCode, 404);
  assert.equal((await call(f, '/history/:executionId', { params: { executionId: ids[53] }, user: { businessId: 'OTHER' } })).statusCode, 403);
});
test('execution and product reads return the same not-found response outside the authenticated tenant/scenario', async () => {
  for (const field of ['businessId', 'scenarioId']) {
    const foreign = row(52);
    foreign[field] = field === 'businessId' ? 'OTHER_BUSINESS' : 'OTHER_SCENARIO';
    const f = setup([foreign]);
    const detail = await call(f, '/history/:executionId', { params: { executionId: ids[52] } });
    const products = await call(f, '/history/:executionId/products', { params: { executionId: ids[52] } });
    assert.equal(detail.statusCode, 404);
    assert.deepEqual(detail.body, { success: false, code: 'ML_HISTORY_EXECUTION_NOT_FOUND' });
    assert.deepEqual(products.body, detail.body);
    assert.equal(f.model.reads.every(read => read.filter.businessId === config.businessId
      && read.filter.scenarioId === config.scenarioId), true);
  }
});
test('products endpoint paginates SKU details from persisted reports without recalculation', async t => {
  const f = setup([row(0)]), path = '/history/:executionId/products';
  const firstResponse = await call(f, path, { params: { executionId: ids[0] }, query: { limit: '1' } });
  assert.equal(firstResponse.statusCode, 200);
  const first = firstResponse.body.data; assert.equal(first.items.length, 1);
  assert.equal(first.items[0].sku, 'SKU-1'); assert.equal(first.items[0].prediction.p7.delta, 1);
  assert.equal(first.items[0].prediction.p14.old, null); assert.equal(first.items[0].inventory.risk.before, null);
  assert.equal(first.items[0].inventory.shouldReorder.after, false);
  assert.equal(first.items[0].inventory.ranking.status, 'NOT_COMPARABLE');
  assert.ok(first.page.nextCursor);
  const second = (await call(f, path, { params: { executionId: ids[0] }, query: { limit: '1', cursor: first.page.nextCursor } })).body.data;
  assert.equal(second.items[0].sku, 'SKU-2'); assert.equal(second.page.nextCursor, null);
  assert.equal((await call(f, path, { params: { executionId: ids[1] } })).statusCode, 404);
  assert.ok(f.model.reads.every(r => r.filter.businessId === config.businessId && r.filter.scenarioId === config.scenarioId));
});
test('history GETs do not call update/status/worker/ML and existing status endpoint remains available', async t => {
  const f = setup([row(0)]);
  assert.equal((await call(f, '/status')).statusCode, 200);
  await call(f, '/history'); await call(f, '/history/:executionId', { params: { executionId: ids[0] } });
  await call(f, '/history/:executionId/products', { params: { executionId: ids[0] } });
  assert.equal(f.model.reads.length, 3);
});

test('service cursor is scoped and generated tokens are canonical and opaque', async () => {
  const f = setup([row(0), row(1)]), service = createForecastMlUpdateHistoryService({ model: f.model });
  const req = { user: { businessId: config.businessId }, query: { limit: '1' } };
  const first = await service.list(req);
  assert.ok(first.page.nextCursor); assert.ok(!first.page.nextCursor.includes(config.businessId));
  const again = await service.list({ ...req, query: { limit: '1', cursor: first.page.nextCursor } });
  assert.notEqual(first.items[0].executionId, again.items[0].executionId);
});
