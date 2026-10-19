'use strict';

const mongoose = require('mongoose');
const config = require('../config/v3Operational');
const target = require('./mlTestTargetAuthorization');
const access = require('./mlTestAccess');
const fence = require('./mlTestFence');
const { Long, ObjectId } = mongoose.mongo.BSON;

const MAX_EVENTS = 10000, MAX_LINES = 100000, OPERATIONS_PER_PRODUCT = 5, PAGE_SIZE = 20;
const fail = (code, httpStatus = 409) => { throw Object.assign(new Error(code), { code, httpStatus }); };
const revision = value => {
  const text = String(value ?? '');
  if (!/^(0|[1-9]\d*)$/.test(text) || BigInt(text) > 9223372036854775807n) fail('ML_TEST_ACTIVITY_REVISION_INVALID');
  return text;
};
const iso = value => {
  const date = new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const isSale = row => row.entityType === 'sale' && row.operation === 'CREATE' && row.projection?.initialStatus === 'completed';
const isCancellation = row => row.entityType === 'transaction' && row.operation === 'CANCEL' && row.projection?.type === 'sale';
const compare = (a, b) => BigInt(a.latestActivityRevision) === BigInt(b.latestActivityRevision)
  ? a.sku.localeCompare(b.sku, 'en') : BigInt(a.latestActivityRevision) > BigInt(b.latestActivityRevision) ? -1 : 1;

function groupActivity(rows, cancellations, catalog) {
  const products = new Map();
  let totalSales = 0, grossUnits = 0, cancellationCount = 0, linesRead = 0;
  for (const row of rows) {
    const sale = isSale(row);
    if (!sale && !isCancellation(row)) continue;
    const transaction = sale ? null : cancellations.get(row.entityKey);
    if (!sale && (!transaction || transaction.type !== 'sale' || transaction.status !== 'cancelled')) fail('ML_TEST_ACTIVITY_REFERENCE_INVALID');
    const lines = sale ? row.projection.lines : transaction.products;
    if (!Array.isArray(lines) || !lines.length) fail('ML_TEST_ACTIVITY_LINES_INVALID');
    const quantities = new Map();
    for (const line of lines) {
      if (++linesRead > MAX_LINES) fail('ML_TEST_ACTIVITY_READ_LIMIT_EXCEEDED', 413);
      const product = line.productId == null ? null : catalog.byId.get(String(line.productId));
      const sku = line.sku || product?.sku;
      if (typeof sku !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(sku)
          || !Number.isSafeInteger(line.quantity) || line.quantity < 1) fail('ML_TEST_ACTIVITY_LINES_INVALID');
      quantities.set(sku, (quantities.get(sku) || 0) + line.quantity);
      if (!Number.isSafeInteger(quantities.get(sku))) fail('ML_TEST_ACTIVITY_LINES_INVALID');
    }
    if (sale) totalSales++; else cancellationCount++;
    for (const [sku, quantity] of quantities) {
      const product = products.get(sku) || { sku, name: catalog.bySku.get(sku)?.name || sku,
        saleCount: 0, totalQuantity: 0, cancellationCount: 0, cancelledQuantity: 0,
        latestActivityAt: null, latestActivityRevision: '0', operationCount: 0, operations: [] };
      if (sale) { product.saleCount++; product.totalQuantity += quantity; grossUnits += quantity; }
      else { product.cancellationCount++; product.cancelledQuantity += quantity; }
      if (![product.totalQuantity, product.cancelledQuantity, grossUnits].every(Number.isSafeInteger)) fail('ML_TEST_ACTIVITY_LINES_INVALID');
      product.operationCount++;
      if (BigInt(row.revision) > BigInt(product.latestActivityRevision)) {
        product.latestActivityRevision = String(row.revision); product.latestActivityAt = iso(row.effectiveAtUtc);
      }
      // Source rows arrive newest revision first; keep only bounded detail.
      if (product.operations.length < OPERATIONS_PER_PRODUCT) product.operations.push({
        transactionId: row.entityKey, revision: String(row.revision), quantity, occurredAt: iso(row.effectiveAtUtc),
        kind: sale ? 'SALE_COMPLETED' : 'SALE_CANCELLED', status: sale ? 'completed' : 'cancelled',
      });
      products.set(sku, product);
    }
  }
  return { summary: { totalSales, grossUnits, affectedProducts: products.size, cancellationCount },
    products: [...products.values()].sort(compare) };
}

function parseQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)
      || Object.keys(query).some(key => !['limit', 'cursor'].includes(key))) fail('ML_TEST_REQUEST_INVALID', 400);
  const limit = query.limit === undefined ? PAGE_SIZE : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) fail('ML_TEST_REQUEST_INVALID', 400);
  let cursor = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!cursor || Object.keys(cursor).sort().join(',') !== 'checkpointId,resetEpoch,sku,testCycleId,upperRevision'
          || typeof cursor.sku !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(cursor.sku)) throw new Error();
      revision(cursor.upperRevision);
    } catch { fail('ML_TEST_ACTIVITY_CURSOR_INVALID', 400); }
  }
  return { limit, cursor };
}

function createMlTestActivity({ client = mongoose.connection.getClient(), db = mongoose.connection.db,
  env = process.env } = {}) {
  async function read(user, query, restored = false) {
    const scope = access.authorizeAdminAction(user, {}, query);
    const options = parseQuery(query);
    const authorization = await target.authorizeLocalTarget({ client, db, user, env });
    if (!target.authorized(client, db, authorization)) fail('ML_TEST_LOCAL_TARGET_INVALID', 503);
    const session = client.startSession({ snapshot: true, causalConsistency: false });
    const readOptions = { session, readConcern: { level: 'snapshot' }, readPreference: 'primary', promoteLongs: false, maxTimeMS: 5000 };
    try {
      const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId }, readOptions);
      const token = fence.tokenOf(control);
      fence.parseToken(fence.durableToken(token));
      const finished = restored && control?.state === 'NO_TEST' && control.restoreFinish === true
        && control.finalizedAt && control.restoreId && control.lastCheckpointId && control.activeCheckpointId == null;
      if ((!finished && token.state !== 'TEST_ACTIVE') || (!finished && (!token.testCycleId || token.resetEpoch === '0')))
        fail('ML_TEST_CYCLE_NOT_ACTIVE');
      const checkpointId = finished ? control.lastCheckpointId : control.activeCheckpointId;
      if (!/^[a-f0-9-]{36}$/i.test(checkpointId || '')) fail('ML_TEST_CYCLE_NOT_ACTIVE');
      const checkpoint = await db.collection('mltestcheckpoints').findOne({ checkpointId, ...scope }, readOptions);
      if (checkpoint?.status !== 'READY') fail('ML_TEST_CHECKPOINT_NOT_READY');
      const baselineRevision = revision(checkpoint.dataVersion);
      const current = await db.collection('v3operationalrevisions').findOne({ _id: scope.businessId }, readOptions);
      const currentRevision = revision(current?.revision);
      if (BigInt(currentRevision) < BigInt(baselineRevision)) fail('ML_TEST_ACTIVITY_REVISION_INVALID');
      const cursor = options.cursor;
      if (cursor && (cursor.checkpointId !== checkpointId || cursor.testCycleId !== token.testCycleId || cursor.resetEpoch !== token.resetEpoch
          || BigInt(cursor.upperRevision) > BigInt(currentRevision) || BigInt(cursor.upperRevision) < BigInt(baselineRevision)))
        fail('ML_TEST_ACTIVITY_CURSOR_INVALID', 400);
      const upperRevision = cursor?.upperRevision || currentRevision;
      const filter = { ...scope, revision: { $gt: Long.fromString(baselineRevision), $lte: Long.fromString(upperRevision) },
        $or: [{ entityType: 'sale', operation: 'CREATE', 'projection.initialStatus': 'completed' },
          { entityType: 'transaction', operation: 'CANCEL', 'projection.type': 'sale' }] };
      const rows = await db.collection('v3operationalchanges').find(filter, { ...readOptions,
        projection: { entityType: 1, operation: 1, entityKey: 1, revision: 1, effectiveAtUtc: 1,
          'projection.initialStatus': 1, 'projection.type': 1, 'projection.lines.sku': 1, 'projection.lines.quantity': 1 } })
        .sort({ revision: -1, eventOrdinal: -1 }).limit(MAX_EVENTS + 1).toArray();
      if (rows.length > MAX_EVENTS) fail('ML_TEST_ACTIVITY_READ_LIMIT_EXCEEDED', 413);
      const cancelIds = [...new Set(rows.filter(isCancellation).map(row => row.entityKey))];
      if (cancelIds.some(id => !/^[a-f0-9]{24}$/i.test(id))) fail('ML_TEST_ACTIVITY_REFERENCE_INVALID');
      const transactions = cancelIds.length ? await db.collection('transactions').find({ businessId: scope.businessId,
        _id: { $in: cancelIds.map(id => new ObjectId(id)) } }, { ...readOptions,
        projection: { type: 1, status: 1, 'products.productId': 1, 'products.sku': 1, 'products.quantity': 1 } }).limit(MAX_EVENTS).toArray() : [];
      // A live transaction line does not persist SKU today. Prefer its original
      // committed sale projection over a potentially renamed current product.
      const originalSales = cancelIds.length ? await db.collection('v3operationalchanges').find({ ...scope,
        entityType: 'sale', operation: 'CREATE', entityKey: { $in: cancelIds }, revision: { $lte: Long.fromString(upperRevision) } },
      { ...readOptions, projection: { entityKey: 1, 'projection.lines.sku': 1, 'projection.lines.quantity': 1 } }).limit(MAX_EVENTS + 1).toArray() : [];
      if (originalSales.length > MAX_EVENTS || new Set(originalSales.map(row => row.entityKey)).size !== originalSales.length)
        fail('ML_TEST_ACTIVITY_REFERENCE_INVALID');
      const originalById = new Map(originalSales.map(row => [row.entityKey, row.projection?.lines]));
      for (const transaction of transactions) {
        const original = originalById.get(String(transaction._id));
        if (!original) continue;
        if (!Array.isArray(original) || original.length !== transaction.products?.length) fail('ML_TEST_ACTIVITY_REFERENCE_INVALID');
        transaction.products = transaction.products.map((line, index) => {
          if (original[index].quantity !== line.quantity || !original[index].sku) fail('ML_TEST_ACTIVITY_REFERENCE_INVALID');
          return { ...line, sku: original[index].sku };
        });
      }
      const skuSet = new Set(rows.filter(isSale).flatMap(row => (row.projection.lines || []).map(line => line.sku)).filter(Boolean));
      for (const transaction of transactions) for (const line of transaction.products || []) if (line.sku) skuSet.add(line.sku);
      const productIds = transactions.flatMap(tx => (tx.products || []).map(line => line.productId)).filter(Boolean);
      const catalogRows = skuSet.size || productIds.length ? await db.collection('products').find({ businessId: scope.businessId,
        $or: [{ sku: { $in: [...skuSet] } }, { _id: { $in: productIds } }] }, { ...readOptions,
        projection: { sku: 1, name: 1 } }).limit(MAX_LINES + 1).toArray() : [];
      if (catalogRows.length > MAX_LINES) fail('ML_TEST_ACTIVITY_READ_LIMIT_EXCEEDED', 413);
      const grouped = groupActivity(rows, new Map(transactions.map(tx => [String(tx._id), tx])), {
        byId: new Map(catalogRows.map(row => [String(row._id), row])), bySku: new Map(catalogRows.map(row => [row.sku, row])) });
      const offset = cursor ? grouped.products.findIndex(product => product.sku === cursor.sku) + 1 : 0;
      if (cursor && offset === 0) fail('ML_TEST_ACTIVITY_CURSOR_INVALID', 400);
      const products = grouped.products.slice(offset, offset + options.limit);
      const nextCursor = offset + products.length < grouped.products.length ? Buffer.from(JSON.stringify({
        checkpointId, testCycleId: token.testCycleId, resetEpoch: token.resetEpoch, upperRevision,
        sku: products[products.length - 1].sku })).toString('base64url') : null;
      // A restore beginning during this read invalidates the whole response.
      await fence.assertCurrent(db, token);
      const finalControl = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId },
        { promoteLongs: false, readPreference: 'primary', readConcern: { level: 'majority' }, maxTimeMS: 5000 });
      if (String(finalControl?.resetEpoch) !== token.resetEpoch || finalControl?.testCycleId !== token.testCycleId) fail('STALE_TEST_EPOCH');
      if (finalControl?.state !== control.state || finalControl.activeCheckpointId !== control.activeCheckpointId
          || finalControl.lastCheckpointId !== control.lastCheckpointId) fail('ML_TEST_CYCLE_NOT_ACTIVE');
      return { checkpointId, testCycleId: token.testCycleId, resetEpoch: token.resetEpoch,
        summary: { baselineRevision, currentRevision: upperRevision, ...grouped.summary }, products,
        page: { limit: options.limit, nextCursor, operationsPerProduct: OPERATIONS_PER_PRODUCT } };
    } finally { await session.endSession(); }
  }
  return { execute: ({ user, query = {} }) => read(user, query),
    // Used only by the authenticated restore route after its server-owned
    // lifecycle receipt. GET /activity still requires TEST_ACTIVE.
    verifyRestored: async ({ user }) => {
      const result = await read(user, {}, true);
      return { status: result.summary.totalSales === 0 && result.summary.cancellationCount === 0
        && result.summary.currentRevision === result.summary.baselineRevision ? 'EMPTY' : 'NOT_EMPTY',
      checkpointId: result.checkpointId, resetEpoch: result.resetEpoch, ...result.summary };
    } };
}

module.exports = { createMlTestActivity, groupActivity, parseQuery, MAX_EVENTS, OPERATIONS_PER_PRODUCT };
