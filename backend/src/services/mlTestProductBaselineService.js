'use strict';
const mongoose = require('mongoose');
const config = require('../config/v3Operational');
const target = require('./mlTestTargetAuthorization');
const fence = require('./mlTestFence');
const Baseline = require('../models/MlTestProductBaseline');
const COLLECTION = 'mltestproductbaselines';
const scope = Object.freeze({ businessId: config.businessId, scenarioId: config.scenarioId });
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const keyFor = (control, checkpoint, sku) => ({ ...scope, checkpointId: checkpoint.checkpointId,
  testCycleId: control.testCycleId, resetEpoch: String(control.resetEpoch), sku });

function forecastValue(response, days, sku, capturedRevision) {
  const row = response?.data;
  const ridge = row?.modelFamily === 'RIDGE_REGRESSION' && row?.method === 'RIDGE_REGRESSION';
  const units = row?.forecastPeriod?.units ?? row?.horizons?.[`${days}d`];
  if (response?.error || !row || row.product?.sku !== sku || row.mode !== 'LIVE'
      || (row.modelFamily != null && row.modelFamily !== 'RIDGE_REGRESSION')
      || (row.method != null && row.method !== 'RIDGE_REGRESSION')
      || typeof row.status !== 'string' || row.horizonDays !== days || String(row.dataVersion ?? '') !== capturedRevision
      || (row.status === 'READY' && (!ridge || row.activeModelStatus !== 'ACTIVE' || numberOrNull(units) === null))) {
    fail('ML_TEST_BASELINE_FORECAST_UNVERIFIED');
  }
  // Preserve actual serving statuses/reasons, including genuine nulls. No
  // synthetic fallback or invented availability status is introduced here.
  return { status: row.status, reasonCode: row.reasonCode ?? null, modelFamily: row.modelFamily,
    activeModelStatus: row.activeModelStatus ?? null, modelVersion: row.modelVersion ?? null,
    trainedDataVersion: row.trainedDataVersion == null ? null : String(row.trainedDataVersion),
    units: numberOrNull(units), horizonDays: days, dataVersion: String(row.dataVersion) };
}

function createMlTestProductBaselineService({ env = process.env, db = mongoose.connection.db,
  client = db?.client, targets = target, epochFence = fence,
  dashboardFactory = () => require('./v3BusinessIntelligenceDashboard').createV3BusinessIntelligenceDashboard(),
  now = () => new Date() } = {}) {
  async function local() {
    if (!targets.localFlagEnabled(env) || !db || !client) return false;
    try { await targets.assertLocalStatusTarget({ client, db, env }); return true; }
    catch { return false; } // A cloud/mismatched target is strictly inert.
  }
  async function revision(session) {
    const row = await db.collection('v3operationalrevisions').findOne({ _id: scope.businessId },
      { ...(session ? { session } : { readConcern: { level: 'majority' } }), promoteLongs: false });
    const value = String(row?.revision ?? '');
    if (row?.bootstrapStatus !== 'VERIFIED' || !/^(0|[1-9]\d*)$/.test(value)) fail('ML_TEST_BASELINE_REVISION_INVALID');
    return value;
  }
  async function modelIdentity(session) {
    const rows = await db.collection('forecastmodelregistries').find({ ...scope, horizonDays: { $in: [7, 14] } },
      session ? { session } : { readPreference: 'primary', readConcern: { level: 'majority' } }).toArray();
    return JSON.stringify(rows.map(row => ({ horizonDays: row.horizonDays,
      activeModelVersion: String(row.activeModelVersion ?? ''), activeArtifactId: String(row.activeArtifactId ?? ''),
      generation: String(row.generation ?? '') })).sort((a, b) => a.horizonDays - b.horizonDays));
  }
  async function activeCycle() {
    const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { promoteLongs: false });
    if (control?.state !== 'TEST_ACTIVE' || !control.testCycleId || !/^[1-9]\d*$/.test(String(control.resetEpoch ?? ''))
        || !/^[a-f0-9-]{36}$/.test(control.activeCheckpointId || '')) return null;
    const checkpoint = await db.collection('mltestcheckpoints').findOne({ ...scope, checkpointId: control.activeCheckpointId });
    if (checkpoint?.status !== 'READY') return null;
    if (!/^(0|[1-9]\d*)$/.test(String(checkpoint.dataVersion ?? ''))) fail('ML_TEST_BASELINE_CHECKPOINT_INVALID');
    const token = epochFence.tokenOf(control);
    epochFence.parseToken(epochFence.durableToken(token));
    return { control, checkpoint, token };
  }
  async function provisionIndexes() {
    try { await db.createCollection(COLLECTION); } catch (error) { if (error.code !== 48) throw error; }
    const [[keys, options]] = Baseline.schema.indexes();
    await db.collection(COLLECTION).createIndex(keys, { unique: options.unique, name: options.name });
  }
  async function provision() {
    if (!await local()) return false;
    await provisionIndexes(); return true;
  }
  async function prepare({ businessId, productIds, trigger }) {
    if (businessId !== scope.businessId || !await local()) return null;
    const cycle = await activeCycle();
    if (!cycle) return null;
    const ids = [...new Set(productIds.map(String))];
    if (!ids.length || ids.some(id => !mongoose.isObjectIdOrHexString(id))) fail('ML_TEST_BASELINE_PRODUCT_INVALID');
    const products = await db.collection('products').find({ ...scope,
      _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } }).toArray();
    if (products.length !== ids.length || new Set(products.map(p => p.sku)).size !== products.length
        || products.some(p => !/^[A-Za-z0-9._-]{1,100}$/.test(p.sku || '')))
      fail('ML_TEST_BASELINE_PRODUCT_INVALID');
    const missing = [];
    for (const product of products) {
      if (!await db.collection(COLLECTION).findOne(keyFor(cycle.control, cycle.checkpoint, product.sku))) missing.push(product);
    }
    if (!missing.length) return null;
    // New LOCAL checkpoints pre-provision this namespace before future caller
    // sessions. Own-session sales also support legacy cycles here. Index
    // creation is additive/idempotent; incompatible indexes fail.
    await provisionIndexes();
    const capturedRevision = await revision();
    if (BigInt(capturedRevision) < BigInt(cycle.checkpoint.dataVersion)) fail('ML_TEST_BASELINE_SOURCE_CHANGED');
    const registryIdentity = await modelIdentity();
    const dashboard = dashboardFactory();
    const captured = [];
    for (const product of missing) {
      const req = { businessId, user: { businessId }, params: { sku: product.sku }, query: {} };
      const inventory = await dashboard.productInventory(req);
      const data = inventory?.data;
      if (inventory?.error || !data || data.mode !== 'LIVE' || data.product?.sku !== product.sku
          || String(data.freshness?.dataVersion ?? '') !== capturedRevision
          || !Number.isSafeInteger(data.stock?.onHand) || data.stock.onHand !== product.stock
          || !data.coverage || !data.risk || !data.recommendation) fail('ML_TEST_BASELINE_INVENTORY_UNVERIFIED');
      const forecast7 = forecastValue(await dashboard.forecast({ ...req, query: { horizonDays: 7 } }), 7, product.sku, capturedRevision);
      const forecast14 = forecastValue(await dashboard.forecast({ ...req, query: { horizonDays: 14 } }), 14, product.sku, capturedRevision);
      const capturedAt = now();
      captured.push({ ...keyFor(cycle.control, cycle.checkpoint, product.sku), productId: product._id,
        productName: String(data.product.name || product.name), presentation: typeof data.product.presentation === 'string' ? data.product.presentation : null,
        baselineRevision: String(cycle.checkpoint.dataVersion), capturedRevision, capturedAt, createdAt: capturedAt, trigger,
        stock: { onHand: data.stock.onHand, incoming: numberOrNull(data.stock.incoming), inventoryPosition: numberOrNull(data.stock.inventoryPosition) },
        forecast7, forecast14,
        coverage: { daysCover: numberOrNull(data.coverage.daysCover), status: data.coverage.status ?? null,
          availabilityStatus: data.coverage.availabilityStatus ?? null, reasonCode: data.coverage.reasonCode ?? null },
        risk: { level: data.risk.level ?? null, status: data.risk.status ?? null,
          reasonCodes: Array.isArray(data.risk.reasonCodes) ? [...data.risk.reasonCodes] : [] },
        recommendation: { reorderNow: data.recommendation.reorderNow ?? null,
          recommendedQty: numberOrNull(data.recommendation.recommendedQty), status: data.recommendation.status ?? null,
          availabilityStatus: data.recommendation.availabilityStatus ?? null, reasonCode: data.recommendation.reasonCode ?? null } });
    }
    if (await revision() !== capturedRevision || await modelIdentity() !== registryIdentity) fail('ML_TEST_BASELINE_SOURCE_CHANGED');
    await epochFence.assertCurrent(db, cycle.token);
    return { token: cycle.token, checkpointId: cycle.checkpoint.checkpointId, capturedRevision, registryIdentity, captured };
  }
  async function prepareSale({ input, businessId, historical, preview }) {
    if (historical || preview || input?.type !== 'sale' || !targets.localFlagEnabled(env)) return null;
    return prepare({ businessId, productIds: (input.products || []).map(item => item.productId), trigger: 'SALE_COMPLETED' });
  }
  async function prepareCancellation({ businessId, transactionId, historical }) {
    if (historical || businessId !== scope.businessId || !await local()) return null;
    if (!mongoose.isObjectIdOrHexString(transactionId)) return null;
    const sale = await db.collection('transactions').findOne({ _id: new mongoose.Types.ObjectId(String(transactionId)), businessId });
    if (sale?.type !== 'sale' || sale.status !== 'completed') return null;
    return prepare({ businessId, productIds: sale.products.map(item => item.productId), trigger: 'SALE_CANCELLED' });
  }
  async function persist({ plan, session }) {
    if (!plan) return;
    if (!targets.localFlagEnabled(env)) fail('ML_TEST_BASELINE_LOCAL_TARGET_REQUIRED');
    try { targets.assertLocalConnectionTarget({ client, db, env }); }
    catch { fail('ML_TEST_BASELINE_LOCAL_TARGET_REQUIRED'); }
    if (!session?.inTransaction?.()) fail('ML_TEST_BASELINE_TRANSACTION_REQUIRED');
    await epochFence.withEpoch(db, async () => {
      // All protected writers contend on this durable control write. Lock it
      // before business mutation, then validate the prepared committed revision.
      await epochFence.guard({ db, session });
      const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { session, promoteLongs: false });
      if (control?.state !== 'TEST_ACTIVE' || control.activeCheckpointId !== plan.checkpointId
          || control.testCycleId !== plan.token.testCycleId || String(control.resetEpoch) !== plan.token.resetEpoch)
        fail('STALE_TEST_EPOCH');
      const checkpoint = await db.collection('mltestcheckpoints').findOne({ ...scope, checkpointId: plan.checkpointId }, { session });
      if (checkpoint?.status !== 'READY' || plan.captured.some(row => row.baselineRevision !== String(checkpoint.dataVersion)))
        fail('ML_TEST_BASELINE_CHECKPOINT_INVALID');
      for (const row of plan.captured) {
        const key = keyFor(control, { checkpointId: plan.checkpointId }, row.sku);
        if (await db.collection(COLLECTION).findOne(key, { session })) continue;
        if (await revision(session) !== plan.capturedRevision || await modelIdentity(session) !== plan.registryIdentity)
          fail('ML_TEST_BASELINE_SOURCE_CHANGED');
        const product = await db.collection('products').findOne({ _id: row.productId, ...scope }, { session });
        if (!product || product.sku !== row.sku || product.stock !== row.stock.onHand) fail('ML_TEST_BASELINE_SOURCE_CHANGED');
        await db.collection(COLLECTION).updateOne(key, { $setOnInsert: row }, { session, upsert: true });
      }
    }, plan.token);
  }
  async function clearCycle({ checkpointId, testCycleId, session }) {
    if (!targets.localFlagEnabled(env) || !db || !client) return;
    try { targets.assertLocalConnectionTarget({ client, db, env }); } catch { return; }
    if (!session?.inTransaction?.() || !checkpointId || !testCycleId) fail('ML_TEST_BASELINE_TRANSACTION_REQUIRED');
    const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, { session });
    if (control?.state !== 'RESTORING' || control.activeCheckpointId !== checkpointId || control.testCycleId !== testCycleId)
      fail('ML_TEST_BASELINE_CLEANUP_STATE_INVALID');
    await db.collection(COLLECTION).deleteMany({ ...scope, checkpointId, testCycleId }, { session });
  }
  return { prepareSale, prepareCancellation, persist, clearCycle, provision };
}
module.exports = { createMlTestProductBaselineService, COLLECTION,
  prepareSale: input => createMlTestProductBaselineService().prepareSale(input),
  prepareCancellation: input => createMlTestProductBaselineService().prepareCancellation(input),
  persist: input => createMlTestProductBaselineService().persist(input),
  provision: input => createMlTestProductBaselineService({ db: input.db, client: input.client, env: input.env }).provision(),
  clearCycle: input => createMlTestProductBaselineService({ db: input.db, client: input.client, env: input.env }).clearCycle(input) };
