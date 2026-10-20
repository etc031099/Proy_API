'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const V3 = require('../config/v3Operational');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const TYPE_FILTERS = new Set(['ALL', 'SALE', 'SALE_CANCELLED', 'PURCHASE_CREATED', 'PURCHASE_RECEIVED', 'INVENTORY_ADJUSTMENT']);
const RANK = Object.freeze({ SALE: 10, PURCHASE_CREATED: 20, SALE_CANCELLED: 30, PURCHASE_RECEIVED: 40, INVENTORY_ADJUSTMENT: 50 });
const SAFE_MESSAGES = Object.freeze({ INVALID_REQUEST: 'La consulta del historial no es válida.', PRODUCT_NOT_FOUND: 'No se encontró el producto solicitado.', CURSOR_INVALID: 'El cursor del historial no es válido.', HISTORY_UNAVAILABLE: 'No se pudo cargar el historial del producto.' });

function fail(code, status = 400) { throw Object.assign(new Error(code), { code, httpStatus: status }); }
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function dayStartLima(day) { return new Date(`${day}T05:00:00.000Z`); }
function nextDay(day) { const date = new Date(`${day}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); }
function parseFilters(query = {}) {
  const allowed = new Set(['type', 'from', 'to', 'limit', 'cursor']);
  if (!query || Object.keys(query).some(key => !allowed.has(key))) fail('INVALID_REQUEST');
  const type = query.type === undefined ? 'ALL' : query.type;
  if (!TYPE_FILTERS.has(type)) fail('INVALID_REQUEST');
  const from = query.from;
  const to = query.to;
  if ((from !== undefined && !validDay(from)) || (to !== undefined && !validDay(to)) || (from && to && from > to)) fail('INVALID_REQUEST');
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9]\d?$/.test(query.limit)) fail('INVALID_REQUEST');
    limit = Number(query.limit);
    if (limit > MAX_LIMIT) fail('INVALID_REQUEST');
  }
  return { type, from: from || null, to: to || null, limit, cursor: query.cursor || null };
}
function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) fail('HISTORY_UNAVAILABLE', 503);
  return secret;
}
function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function encodeCursor(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}
function decodeCursor(raw, expected, secret) {
  if (typeof raw !== 'string' || raw.length > 2048) fail('CURSOR_INVALID');
  const parts = raw.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) fail('CURSOR_INVALID');
  const expectedSig = Buffer.from(sign(parts[0], secret));
  const actualSig = Buffer.from(parts[1]);
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) fail('CURSOR_INVALID');
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (Buffer.from(JSON.stringify(payload)).toString('base64url') !== parts[0]
        || Object.entries(expected).some(([key, value]) => payload[key] !== value)
        || payload.v !== 1 || !validDay(payload.key?.timestamp?.slice(0, 10))
        || !Number.isFinite(Date.parse(payload.key.timestamp)) || new Date(payload.key.timestamp).toISOString() !== payload.key.timestamp
        || !Object.values(RANK).includes(payload.key.sourceRank) || typeof payload.key.sourceId !== 'string'
        || !/^[a-f\d]{24}$/i.test(payload.key.sourceId)) fail('CURSOR_INVALID');
    return payload;
  } catch (error) { if (error.code === 'CURSOR_INVALID') throw error; fail('CURSOR_INVALID'); }
}
const idString = value => value == null ? '' : String(value);
const safeString = value => typeof value === 'string' && value.length <= 160 ? value : null;
const validQuantity = value => Number.isFinite(value) ? value : null;
const idFilter = productId => ({ 'products.productId': productId });
function scenarioScope(scenarioId) {
  return { $or: [{ scenarioId }, { scenarioId: null }, { scenarioId: { $exists: false } }] };
}
function cursorCondition(stream, key) {
  if (!key) return null;
  const rank = RANK[stream.type];
  if (rank > key.sourceRank) return { [stream.timeField]: { $lt: new Date(key.timestamp) } };
  if (rank < key.sourceRank) return { [stream.timeField]: { $lte: new Date(key.timestamp) } };
  return { $or: [{ [stream.timeField]: { $lt: new Date(key.timestamp) } },
    { [stream.timeField]: new Date(key.timestamp), _id: { $lt: key.sourceId } }] };
}
function composeQuery(base, timeField, filters, stream, key) {
  const clauses = [base];
  const range = {};
  if (filters.from) range.$gte = dayStartLima(filters.from);
  if (filters.to) range.$lt = dayStartLima(nextDay(filters.to));
  if (Object.keys(range).length) clauses.push({ [timeField]: range });
  const after = cursorCondition(stream, key);
  if (after) clauses.push(after);
  return clauses.length === 1 ? base : { $and: clauses };
}
function productLines(transaction, productId) {
  return (transaction.products || []).filter(line => idString(line.productId) === idString(productId));
}
function classifyRelation(change, productId, productSku, operation, lineKeys = []) {
  if (!change) return 'LIMITED_LEGACY';
  if (change.entityType === 'transaction' && change.operation === operation) {
    const projection = change.projection || {};
    const productKey = `OP-P-${idString(productId)}`;
    const lines = operation === 'CANCEL' ? projection.affectedStableLineKeys : projection.lines;
    if (operation === 'CANCEL' && Array.isArray(lines) && lineKeys.some(key => lines.includes(key))) return 'DIRECT_REVISION';
    if (operation === 'RECEIVE' && Array.isArray(lines) && lines.some(line => line.productKey === productKey
      || line.sku === productSku || idString(line.productId) === idString(productId))) return 'DIRECT_REVISION';
  }
  if (change.entityType === 'sale' && change.operation === 'CREATE'
      && (change.projection?.lines || []).some(line => line.productKey === `OP-P-${idString(productId)}`
        || line.sku === productSku || idString(line.productId) === idString(productId))) return 'DIRECT_REVISION';
  return 'LIMITED_LEGACY';
}

function createProductOperationHistoryService({ models, secret = () => process.env.JWT_SECRET } = {}) {
  const getModels = () => models || require('../models');
  const keyFor = () => signingKey(typeof secret === 'function' ? secret() : secret);
  const resolveProduct = async (businessId, sku) => {
    const product = await getModels().Product.findOne({ businessId, sku, scenarioId: V3.scenarioId })
      .select('_id sku name').lean().maxTimeMS(3000);
    if (!product) fail('PRODUCT_NOT_FOUND', 404);
    return product;
  };
  const streamDefinitions = (businessId, product, filters, cursorKey) => {
    const scope = scenarioScope(V3.scenarioId);
    const txBase = { businessId, ...idFilter(product._id), ...scope };
    const movementScope = { $or: [{ scenarioId: V3.scenarioId }, { scenarioId: null }, { scenarioId: { $exists: false } }] };
    const movementBase = { businessId, productId: product._id };
    const tx = (type, query, timeField) => ({ type, timeField, model: getModels().Transaction,
      query: composeQuery({ ...txBase, ...query }, timeField, filters, { type }, cursorKey) });
    const mov = (type, query) => ({ type, timeField: 'occurredAt', model: getModels().InventoryMovement,
      query: composeQuery({ $and: [movementBase, movementScope, query] }, 'occurredAt', filters, { type }, cursorKey) });
    const types = filters.type === 'ALL' ? Object.keys(RANK) : [filters.type];
    return [
      types.includes('SALE') && tx('SALE', { type: 'sale', status: 'completed' }, 'date'),
      types.includes('PURCHASE_CREATED') && tx('PURCHASE_CREATED', { type: 'purchase' }, 'date'),
      types.includes('SALE_CANCELLED') && tx('SALE_CANCELLED', { type: 'sale', status: 'cancelled', cancelledAt: { $type: 'date' } }, 'cancelledAt'),
      types.includes('PURCHASE_RECEIVED') && mov('PURCHASE_RECEIVED', { type: 'purchase', $or: [{ reason: 'v3_purchase_receipt' }, { 'scenarioData.type': 'purchase_receipt' }] }),
      types.includes('INVENTORY_ADJUSTMENT') && mov('INVENTORY_ADJUSTMENT', { type: 'manual_adjustment' }),
    ].filter(Boolean);
  };
  const toItem = (stream, row, product) => {
    const tx = ['SALE', 'PURCHASE_CREATED', 'SALE_CANCELLED'].includes(stream.type);
    const quantity = tx ? productLines(row, product._id).reduce((sum, line) => sum + (Number.isFinite(line.quantity) ? line.quantity : 0), 0)
      : validQuantity(row.quantityDelta);
    const occurredAt = stream.type === 'SALE_CANCELLED' ? row.cancelledAt : tx ? row.date : row.occurredAt;
    const sourceId = idString(row._id);
    const relationQuality = 'DIRECT_ID';
    const item = { operationId: `${stream.type}:${sourceId}`, sourceId, productId: idString(product._id), type: stream.type, occurredAt: occurredAt.toISOString(),
      quantity, reference: safeString(row.invoiceNumber || row.stableCode || row.scenarioData?.canonicalRecord?.[stream.type === 'PURCHASE_CREATED' ? 'purchaseCode' : 'saleCode']) || sourceId.slice(-8),
      customer: stream.type === 'SALE' || stream.type === 'SALE_CANCELLED' ? safeString(row.customerName) : null,
      supplier: stream.type === 'PURCHASE_CREATED' || stream.type === 'PURCHASE_RECEIVED' ? safeString(row.vendorName || row.supplierName) : null,
      relationQuality, ridgeImpact: { status: stream.type === 'SALE' || stream.type === 'SALE_CANCELLED' ? 'not_found' : 'not_applicable', horizons: [] },
      inventoryImpact: { status: tx ? 'not_found' : 'persisted', movementType: tx ? null : row.type,
        quantityDelta: tx ? null : validQuantity(row.quantityDelta), stockBefore: tx ? null : validQuantity(row.stockBefore),
        stockAfter: tx ? null : validQuantity(row.stockAfter) },
      _sort: { timestamp: occurredAt.toISOString(), sourceRank: RANK[stream.type], sourceId },
      _lineKeys: productLines(row, product._id).map((line, index) => line.stableLineKey || `${sourceId}:${index}`),
      _transactionId: row.transactionId ? idString(row.transactionId) : null,
      _sku: product.sku,
      _sourceEventId: row.sourceEventId || null };
    return item;
  };
  const enrich = async (items, businessId) => {
    const models = getModels();
    const transactionItems = items.filter(item => ['SALE', 'SALE_CANCELLED', 'PURCHASE_CREATED'].includes(item.type));
    if (transactionItems.length) {
      const movements = await models.InventoryMovement.find({ businessId, productId: transactionItems[0].productId,
        transactionId: { $in: [...new Set(transactionItems.map(item => item.sourceId))] },
        type: { $in: ['sale', 'cancellation', 'purchase'] }, ...scenarioScope(V3.scenarioId) })
        .select('_id transactionId productId type quantityDelta stockBefore stockAfter occurredAt reason scenarioId scenarioData')
        .lean().maxTimeMS(5000);
      for (const item of transactionItems) {
        const expectedType = item.type === 'SALE' ? 'sale' : item.type === 'SALE_CANCELLED' ? 'cancellation' : 'purchase';
        const rows = movements.filter(movement => idString(movement.transactionId) === item.sourceId && movement.type === expectedType
          && !(item.type === 'PURCHASE_CREATED' && (movement.reason === 'v3_purchase_receipt' || movement.scenarioData?.type === 'purchase_receipt')))
          .sort((left, right) => left.occurredAt - right.occurredAt || left._id.localeCompare(right._id));
        if (rows.length) {
          const first = rows[0], last = rows[rows.length - 1];
          item._linkedMovements = rows;
          item.inventoryImpact = { status: 'persisted', movementType: expectedType,
            quantityDelta: rows.reduce((sum, movement) => sum + validQuantity(movement.quantityDelta), 0),
            stockBefore: validQuantity(first.stockBefore), stockAfter: validQuantity(last.stockAfter) };
        }
      }
    }
    const receipts = items.filter(item => item.type === 'PURCHASE_RECEIVED' && item._transactionId);
    if (receipts.length) {
      const purchaseRows = await models.Transaction.find({ businessId, type: 'purchase',
        _id: { $in: [...new Set(receipts.map(item => item._transactionId))] },
        'products.productId': receipts[0].productId, ...scenarioScope(V3.scenarioId) })
        .select('_id vendorName supplierName invoiceNumber stableCode purchaseLifecycle.receipts').lean().maxTimeMS(3000);
      const byPurchase = new Map(purchaseRows.map(row => [idString(row._id), row]));
      for (const item of receipts) {
        const purchase = byPurchase.get(item._transactionId);
        const receipt = purchase?.purchaseLifecycle?.receipts?.find(candidate =>
          typeof candidate.receiptKey === 'string'
          && item._sourceEventId?.startsWith(`v3-receipt:${candidate.receiptKey}:`));
        if (purchase && receipt) {
          item.supplier = safeString(purchase.vendorName || purchase.supplierName);
          item.reference = safeString(purchase.invoiceNumber || purchase.stableCode) || item.reference;
          item._receiptKey = receipt.receiptKey;
        } else item.relationQuality = 'LIMITED_LEGACY';
      }
    }
    const linked = items.filter(item => ['SALE', 'SALE_CANCELLED', 'PURCHASE_RECEIVED', 'INVENTORY_ADJUSTMENT'].includes(item.type));
    const entityKeys = [...new Set(linked.flatMap(item => item.type === 'PURCHASE_RECEIVED' ? [item._transactionId] : [item.sourceId]).filter(Boolean))];
    const changes = entityKeys.length ? await models.V3OperationalChange.find({ businessId, scenarioId: V3.scenarioId,
      entityKey: { $in: entityKeys }, entityType: { $in: ['sale', 'transaction', 'movement'] },
      operation: { $in: ['CREATE', 'CANCEL', 'RECEIVE', 'ADJUST'] } })
      .select('revision eventOrdinal eventKey effectiveAtUtc entityType entityKey operation projection').lean().maxTimeMS(5000) : [];
    const changeByIdentity = new Map(changes.map(change => [`${change.entityType}:${change.entityKey}:${change.operation}`, change]));
    const signalChanges = [];
    for (const item of items) {
      if (item.type === 'PURCHASE_RECEIVED') {
        const receiptMatch = /^v3-receipt:(.+):[^:]+$/.exec(item._sourceEventId || '');
        const receiptKey = item._receiptKey || receiptMatch?.[1];
        const change = receiptKey && item._transactionId ? changeByIdentity.get(`transaction:${item._transactionId}:RECEIVE`) : null;
        if (change && change.projection?.receiptKey === receiptKey
            && (change.projection?.lines || []).some(line => line.productKey === `OP-P-${item.productId}` || line.sku === item._sku)) {
            item._change = change; item.relationQuality = 'DIRECT_REVISION';
        }
        continue;
      }
      if (item.type === 'INVENTORY_ADJUSTMENT') {
        const change = changeByIdentity.get(`movement:${item.sourceId}:ADJUST`);
        if (change && change.projection?.productKey === `OP-P-${item.productId}`) {
          item._change = change; item.relationQuality = 'DIRECT_REVISION';
        }
        continue;
      }
      if (!['SALE', 'SALE_CANCELLED'].includes(item.type)) continue;
      const change = changeByIdentity.get(item.type === 'SALE'
        ? `sale:${item.sourceId}:CREATE` : `transaction:${item.sourceId}:CANCEL`);
      if (!change) { if (item.type === 'SALE_CANCELLED') item.relationQuality = 'LIMITED_LEGACY'; continue; }
      item.relationQuality = classifyRelation(change, item.productId, item._sku, item.type === 'SALE' ? 'CREATE' : 'CANCEL', item._lineKeys);
      item._change = change;
      if (change.eventKey) signalChanges.push({ item, change, eventType: item.type === 'SALE' ? 'SALE_COMPLETED' : 'SALE_CANCELLED' });
    }
    const eventKeys = [...new Set(signalChanges.map(entry => entry.change.eventKey))];
    if (eventKeys.length) {
      const eventTypes = [...new Set(signalChanges.map(entry => entry.eventType))];
      const events = await models.ForecastMlUpdateEvent.find({ businessId, scenarioId: V3.scenarioId,
        eventKey: { $in: eventKeys }, horizonDays: { $in: [7, 14] }, eventType: { $in: eventTypes } })
        .select('eventKey horizonDays eventType dataVersion occurredAt historicalCorrection').lean().maxTimeMS(5000);
      const eventsByKey = new Map(events.map(event => [`${event.eventKey}:${event.eventType}`, []]));
      for (const event of events) eventsByKey.get(`${event.eventKey}:${event.eventType}`).push(event);
      for (const { item, change, eventType } of signalChanges) {
        const rows = eventsByKey.get(`${change.eventKey}:${eventType}`) || [];
        item.ridgeImpact = { status: rows.length ? 'persisted' : 'not_found', horizons: rows.map(event => ({
          horizonDays: event.horizonDays, eventType: event.eventType, dataVersion: String(event.dataVersion),
          occurredAt: event.occurredAt?.toISOString?.() || null, historicalCorrection: Boolean(event.historicalCorrection) })) };
      }
    }
    return items;
  };
  const list = async (req) => {
    const businessId = req.user?.businessId;
    const sku = String(req.params?.sku || '').trim();
    if (!businessId || !/^[A-Za-z0-9._-]{1,100}$/.test(sku)) fail('INVALID_REQUEST', businessId ? 400 : 401);
    const filters = parseFilters(req.query);
    const product = await resolveProduct(businessId, sku);
    const scope = { businessId, scenarioId: V3.scenarioId, productId: idString(product._id), sku,
      type: filters.type, from: filters.from, to: filters.to };
    const key = keyFor();
    const payload = filters.cursor ? decodeCursor(filters.cursor, { v: 1, ...scope }, key) : null;
    const streams = streamDefinitions(businessId, product, filters, payload?.key || null);
    const batches = await Promise.all(streams.map(async stream => {
      const rows = await stream.model.find(stream.query).sort({ [stream.timeField]: -1, _id: -1 }).limit(filters.limit + 1)
        .select(stream.model.modelName === 'Transaction'
          ? '_id businessId type date status cancelledAt scenarioId products.productId products.quantity invoiceNumber stableCode customerName vendorName supplierName scenarioData.canonicalRecord'
          : '_id businessId productId transactionId type quantityDelta stockBefore stockAfter occurredAt reason scenarioId scenarioData sourceEventId')
        .lean().maxTimeMS(5000);
      return { stream, rows };
    }));
    const items = batches.flatMap(({ stream, rows }) => rows.map(row => toItem(stream, row, product)))
      .sort(compareItems);
    const page = items.slice(0, filters.limit + 1);
    const hasMore = page.length > filters.limit;
    const visible = page.slice(0, filters.limit);
    const enriched = await enrich(visible, businessId);
    const last = enriched.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ v: 1, ...scope, key: last._sort }, key) : null;
    return { product: { sku: product.sku, name: product.name || product.sku }, items: enriched.map(publicItem), limit: filters.limit, hasMore, nextCursor,
      filters: { type: filters.type, from: filters.from, to: filters.to } };
  };
  const detail = async (req) => {
    const businessId = req.user?.businessId;
    const sku = String(req.params?.sku || '').trim();
    const operationId = String(req.params?.operationId || '');
    if (!businessId || !/^[A-Za-z0-9._-]{1,100}$/.test(sku)) fail('INVALID_REQUEST', businessId ? 400 : 401);
    const match = /^(SALE|PURCHASE_CREATED|SALE_CANCELLED|PURCHASE_RECEIVED|INVENTORY_ADJUSTMENT):([a-f\d]{24})$/i.exec(operationId);
    if (!match) fail('INVALID_REQUEST');
    const type = match[1].toUpperCase(), sourceId = match[2];
    const product = await resolveProduct(businessId, sku);
    const stream = streamDefinitions(businessId, product, { type, from: null, to: null }, null).find(row => row.type === type);
    const row = await stream.model.findOne({ ...stream.query, _id: sourceId }).select(stream.model.modelName === 'Transaction'
      ? '_id businessId type date status cancelledAt scenarioId products.productId products.quantity invoiceNumber stableCode customerName vendorName supplierName scenarioData.canonicalRecord purchaseLifecycle'
      : '_id businessId productId transactionId type quantityDelta stockBefore stockAfter occurredAt reason scenarioId scenarioData sourceEventId')
      .lean().maxTimeMS(3000);
    if (!row) fail('PRODUCT_NOT_FOUND', 404);
    const item = toItem(stream, row, product);
    item.productId = idString(product._id);
    await enrich([item], businessId);
    const change = item._change;
    const movement = stream.type === 'PURCHASE_RECEIVED' || stream.type === 'INVENTORY_ADJUSTMENT' ? row : null;
    const movementRows = movement ? [movement] : item._linkedMovements || [];
    return { operation: publicItem(item), facts: { product: { sku: product.sku, name: product.name || product.sku },
      quantity: item.quantity, reference: item.reference, customer: item.customer, supplier: item.supplier,
      status: row.status || null, receiptKey: stream.type === 'PURCHASE_RECEIVED' ? item._receiptKey || null : null },
      inventoryMovements: movementRows.map(entry => ({ movementType: entry.type, quantityDelta: entry.quantityDelta,
        stockBefore: entry.stockBefore, stockAfter: entry.stockAfter, occurredAt: entry.occurredAt.toISOString() })),
      ridgeEvidence: item.ridgeImpact, traceability: change ? { revision: String(change.revision), eventOrdinal: change.eventOrdinal,
        eventKey: change.eventKey, effectiveAtUtc: change.effectiveAtUtc?.toISOString?.() || null, entityType: change.entityType,
        entityKey: change.entityKey, operation: change.operation, relationQuality: item.relationQuality } : {
        revision: null, eventOrdinal: null, eventKey: null, effectiveAtUtc: null, entityType: null, entityKey: null,
        operation: null, relationQuality: item.relationQuality } };
  };
  return Object.freeze({ list, detail });
}
function compareItems(left, right) {
  return right._sort.timestamp.localeCompare(left._sort.timestamp)
    || right._sort.sourceRank - left._sort.sourceRank || right._sort.sourceId.localeCompare(left._sort.sourceId);
}
function publicItem(item) { const { _sort, _change, productId, ...safe } = item; return safe; }

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, TYPE_FILTERS, RANK, validDay, dayStartLima,
  parseFilters, encodeCursor, decodeCursor, cursorCondition, compareItems, createProductOperationHistoryService,
  publicItem, SAFE_MESSAGES };
