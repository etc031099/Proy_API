'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const config = require('../config/v3Operational');
const { HistoricalScenario, Product, Contact, Transaction, InventoryMovement, V3OperationalRevision, V3OperationalChange } = require('../models');

const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const idOf = value => value == null ? null : String(value);
const cents = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : null;

function limaDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function limaDayStart(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 5));
}
function nextDay(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}
function previousDay(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day - 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}
function validIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}
const logicalHash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const stableKey = (type, doc) => {
  if (type === 'product') return doc.productKey || doc.sku || `OP-P-${idOf(doc._id)}`;
  if (type === 'customer') return doc.stableCode || doc.stableKey || `OP-C-${idOf(doc._id)}`;
  return doc.stableCode || doc.stableKey || `OP-S-${idOf(doc._id)}`;
};

async function resolveV3OperationalScenario(businessId, { session } = {}) {
  if (businessId !== config.businessId) throw fail('V3_TENANT_REQUIRED', 'Authenticated business is not the V3 tenant.', 403);
  let query = HistoricalScenario.findOne({ businessId: config.businessId, scenarioId: config.scenarioId, status: 'completed' });
  if (session) query = query.session(session);
  const scenario = await query.lean().maxTimeMS(5000);
  const metadata = scenario?.metadata || {};
  if (!scenario || scenario.sourceSha256 !== config.sourceSha256
      || metadata.datasetVersion !== config.datasetVersion
      || String(metadata.referenceDate || '') !== config.historicalCutoff
      || metadata.timezone !== config.timezone) {
    throw fail('V3_SCENARIO_INVALID', 'The authenticated V3 scenario is missing or does not match the approved historical lineage.', 409);
  }
  return scenario;
}

async function getDataVersion(businessId, { session, majority = false } = {}) {
  if (businessId !== config.businessId) return '0';
  let query = V3OperationalRevision.findById(businessId);
  if (session) query = query.session(session);
  if (majority && typeof query.readConcern === 'function') query = query.readConcern('majority');
  const row = await query.setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
  return row?.revision == null ? '0' : String(row.revision);
}

async function bumpV3OperationalRevision({ businessId, session, changes = [], effectiveAtUtc = new Date(),
  mlAffectedLocalDate = null }) {
  if (businessId !== config.businessId) return null;
  if (!session || !session.inTransaction()) throw new Error('V3 revision must be bumped inside the owning Mongo transaction.');
  await resolveV3OperationalScenario(businessId, { session });
  const bootstrap = await V3OperationalRevision.findById(businessId).session(session)
    .setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
  if (!bootstrap || bootstrap.bootstrapStatus !== 'VERIFIED'
      || bootstrap.historicalDatasetVersion !== config.datasetVersion
      || bootstrap.historicalDatasetSha256 !== config.sourceSha256) {
    throw fail('V3_OPERATIONAL_BOOTSTRAP_REQUIRED', 'V3 operational writes are blocked until the audited revision-zero bootstrap is complete.', 409);
  }
  if (bootstrap.revision >= 9223372036854775807n) throw fail('V3_REVISION_EXHAUSTED', 'V3 operational revision counter is exhausted.', 503);
  const row = await V3OperationalRevision.findOneAndUpdate(
    { _id: businessId, bootstrapStatus: 'VERIFIED' }, { $inc: { revision: 1n } },
    { upsert: false, new: true, session, projection: { revision: 1 } }
  ).setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
  const revision = row?.revision;
  if (typeof revision !== 'bigint' || revision < 1n) throw new Error('V3 revision storage did not return BSON int64 data.');
  if (changes.length) {
    const docs = changes.map((change, eventOrdinal) => ({
      businessId, scenarioId: config.scenarioId, revision, eventOrdinal,
      eventKey: `${revision}:${eventOrdinal}:${change.entityType}:${change.entityKey}:${change.operation}`,
      effectiveAtUtc, ...change
    }));
    await V3OperationalChange.insertMany(docs, { session, ordered: true });
    const { recordCommittedChange } = require('./forecastMlUpdateCoordinator');
    for (const [eventOrdinal, change] of changes.entries()) {
      await recordCommittedChange({ businessId, scenarioId: config.scenarioId, dataVersion: revision,
        change, eventOrdinal, session, affectedLocalDate: mlAffectedLocalDate });
    }
  }
  return revision.toString();
}

// This is an explicit pre-LIVE gate, never called by ordinary reads/writes.
// It establishes conceptual revision zero only when post-cutoff operational data is absent.
async function bootstrapV3OperationalRevision({ businessId, attestNoUnjournaledBaseCatalogChanges = false }) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary', writeConcern: { w: 'majority' } });
    const revision = await bootstrapV3OperationalRevisionInSession({ businessId, attestNoUnjournaledBaseCatalogChanges, session });
    await session.commitTransaction();
    return revision;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

async function bootstrapV3OperationalRevisionInSession({ businessId, attestNoUnjournaledBaseCatalogChanges, session }) {
  await resolveV3OperationalScenario(businessId, { session });
  const revision = await V3OperationalRevision.findById(businessId)
    .session(session)
    .setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
  if (revision?.bootstrapStatus === 'VERIFIED' && revision.historicalDatasetVersion === config.datasetVersion
      && revision.historicalDatasetSha256 === config.sourceSha256) return revision;
  if (revision && revision.revision !== 0n) throw fail('SNAPSHOT_BOOTSTRAP_AMBIGUOUS', 'Operational revision is already non-zero but is not verified; an audited capture is required.', 409);
  const start = limaDayStart(config.deltaStart);
  const checks = [
    Transaction.countDocuments({ businessId, date: { $gte: start }, scenarioId: { $ne: config.scenarioId } }),
    InventoryMovement.countDocuments({ businessId, occurredAt: { $gte: start }, source: { $ne: 'historical_import' } }),
    Product.countDocuments({ businessId, createdAt: { $gte: start }, scenarioId: { $ne: config.scenarioId } }),
    Contact.countDocuments({ businessId, createdAt: { $gte: start }, scenarioId: { $ne: config.scenarioId } }),
    V3OperationalChange.countDocuments({ businessId })
  ];
  const counts = [];
  // A transactional session must not execute parallel queries.
  for (const query of checks) counts.push(await query.session(session).maxTimeMS(5000));
  if (counts.some(Boolean)) throw fail('SNAPSHOT_BOOTSTRAP_AMBIGUOUS', 'Post-cutoff writes or catalog edits predate revision journaling; LIVE bootstrap is blocked pending an audited capture.', 409);
  const baseProducts = await Product.countDocuments({ businessId, scenarioId: config.scenarioId, sourceEventId: { $type: 'string' } })
    .session(session).maxTimeMS(5000);
  const baseContacts = await Contact.countDocuments({ businessId, scenarioId: config.scenarioId, sourceEventId: { $type: 'string' } })
    .session(session).maxTimeMS(5000);
  if ((baseProducts || baseContacts) && !attestNoUnjournaledBaseCatalogChanges) {
    throw fail('SNAPSHOT_BOOTSTRAP_ATTESTATION_REQUIRED', 'Historical import timestamps cannot prove whether base catalog rows changed after cutoff; an explicitly authorized no-un-journaled-change attestation is required.', 409);
  }
  try {
    return await V3OperationalRevision.findOneAndUpdate({ _id: businessId, revision: 0n }, {
      $set: { revision: 0n, bootstrapStatus: 'VERIFIED', historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256 }
    }, { upsert: true, new: true, runValidators: true, session })
      .setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
  } catch (error) {
    if (error.code === 11000) throw fail('SNAPSHOT_BOOTSTRAP_RACE', 'V3 operational bootstrap raced another initializer; retry the bootstrap check.', 409);
    throw error;
  }
}

function productProjection(doc, supplierKeys = new Map()) {
  return {
    productKey: stableKey('product', doc), sku: doc.sku || null, name: doc.name,
    active: doc.isActive !== false, priceCents: cents(doc.price), currency: doc.currency || null,
    costPriceCents: cents(doc.costPrice), category: doc.category || null,
    categoryCode: doc.categoryCode || null, subcategoryCode: doc.subcategoryCode || null,
    brand: doc.brand || null, presentation: doc.presentation || null,
    sizeValue: doc.sizeValue ?? null, sizeUnit: doc.sizeUnit || null, containedUnits: doc.containedUnits ?? null,
    unit: doc.unit || null, perishable: Boolean(doc.perishable), shelfLifeDays: doc.shelfLifeDays ?? null,
    minStock: doc.minStockLevel ?? 0, safetyStock: doc.safetyStock ?? null, reorderPoint: doc.reorderPoint ?? null,
    demandProfileKey: doc.demandProfileKey || null,
    supplierOffers: (doc.supplierPrices || []).map(row => ({ supplierKey: supplierKeys.get(idOf(row.supplierId)) || `OP-S-${idOf(row.supplierId)}`, costCents: cents(row.purchasePrice), currency: doc.currency || null,
      preferred: idOf(row.supplierId) === idOf(doc.preferredSupplierId), active: true }))
      .sort((a, b) => a.supplierKey.localeCompare(b.supplierKey))
  };
}
function contactProjection(doc) {
  return { entityKey: stableKey(doc.type, doc), name: doc.name, type: doc.type, active: doc.isActive !== false,
    createdAtUtc: doc.createdAt ? new Date(doc.createdAt).toISOString() : null };
}

async function recordV3ProductChange({ businessId, session, before = null, after, operation, effectiveAtUtc = new Date(), extraChanges = [] }) {
  if (businessId !== config.businessId) return null;
  const supplierIds = [...new Set([...(before?.supplierPrices || []), ...(after?.supplierPrices || [])].map(row => idOf(row.supplierId)).filter(Boolean))];
  const suppliers = supplierIds.length ? await Contact.find({ _id: { $in: supplierIds }, businessId, type: 'vendor' })
    .select('_id stableCode stableKey').session(session).lean().maxTimeMS(5000) : [];
  if (suppliers.length !== supplierIds.length) throw fail('SNAPSHOT_CROSS_TENANT_REFERENCE', 'Product supplier offer references a vendor outside the authenticated tenant.', 409);
  const supplierKeys = new Map(suppliers.map(row => [idOf(row._id), row.stableCode || row.stableKey || `OP-S-${idOf(row._id)}`]));
  const beforeProjection = before ? productProjection(before, supplierKeys) : null;
  const afterProjection = productProjection(after, supplierKeys);
  if (beforeProjection && JSON.stringify(canonical(beforeProjection)) === JSON.stringify(canonical(afterProjection))) return null;
  const change = { entityType: 'product', entityKey: afterProjection.productKey, operation,
    projection: { entityType: 'product', before: beforeProjection, after: afterProjection } };
  const changes = [change, ...extraChanges];
  return bumpV3OperationalRevision({ businessId, session, changes, effectiveAtUtc });
}

async function recordV3ContactChange({ businessId, session, before = null, after, operation, effectiveAtUtc = new Date() }) {
  if (businessId !== config.businessId) return null;
  const projection = contactProjection(after);
  const beforeProjection = before ? contactProjection(before) : null;
  if (beforeProjection && JSON.stringify(canonical(beforeProjection)) === JSON.stringify(canonical(projection))) return null;
  return bumpV3OperationalRevision({ businessId, session, effectiveAtUtc, changes: [{
    entityType: after.type === 'customer' ? 'customer' : 'supplier', entityKey: projection.entityKey, operation,
    projection: { entityType: 'contact', before: beforeProjection, after: projection }
  }] });
}

async function recordV3Transaction({ businessId, session, transaction, contact = null, productIdentities = [], operation = 'CREATE', effectiveAtUtc }) {
  if (businessId !== config.businessId) return null;
  const isSale = transaction.type === 'sale';
  const entityType = operation === 'CANCEL' || operation === 'RECEIVE'
    ? 'transaction' : (isSale ? 'sale' : 'purchase');
  let projection;
  if (operation === 'CANCEL') {
    const reference = verifiedTransactionReference(transaction);
    if (reference.origin === 'HISTORICAL' && transaction.type === 'sale'
        && reference.canonical.status !== 'completed') {
      throw fail('HISTORICAL_REFERENCE_NOT_FOUND', 'Only a completed frozen sale can be cancelled after the cutoff.', 409);
    }
    projection = { contractVersion: 2, transactionKey: reference.transactionKey,
      transactionOrigin: reference.origin, type: transaction.type, kind: 'CANCEL',
      affectedStableLineKeys: reference.lineKeys };
  } else projection = transactionProjection(transaction, contact, productIdentities);
  return bumpV3OperationalRevision({ businessId, session, effectiveAtUtc: effectiveAtUtc || transaction.date || new Date(),
    mlAffectedLocalDate: operation === 'CANCEL' && isSale ? limaDate(new Date(transaction.date)) : null,
    changes: [{
    entityType, entityKey: idOf(transaction._id), operation, projection
  }] });
}

function verifiedTransactionReference(transaction) {
  if (transaction.businessId && transaction.businessId !== config.businessId) {
    throw fail('HISTORICAL_REFERENCE_NOT_FOUND', 'Transaction does not belong to the V3 tenant.', 403);
  }
  if (transaction.scenarioId == null) {
    return { origin: 'LIVE', transactionKey: idOf(transaction._id),
      lineKeys: (transaction.products || []).map((line, index) => line.stableLineKey || `${idOf(transaction._id)}:${index}`), canonical: null };
  }
  const codeField = transaction.type === 'sale' ? 'saleCode' : 'purchaseCode';
  const lineKeyField = transaction.type === 'sale' ? 'saleLineKey' : 'purchaseLineKey';
  const canonical = transaction.scenarioData?.canonicalRecord;
  const canonicalLines = transaction.scenarioData?.canonicalLines;
  const localDate = transaction.type === 'sale' ? canonical?.localDate : canonical?.orderedLocalDate;
  if (transaction.scenarioId !== config.scenarioId || !transaction.stableCode
      || canonical?.scenarioId !== config.scenarioId || canonical?.[codeField] !== transaction.stableCode
      || !Array.isArray(canonicalLines) || canonicalLines.length !== transaction.products.length
      || !validIsoDay(localDate) || localDate > config.historicalCutoff
      || !Number.isFinite(new Date(transaction.date).getTime())
      || limaDate(new Date(transaction.date)) !== localDate
      || (canonical.sourceEventId && transaction.sourceEventId !== canonical.sourceEventId)) {
    throw fail('HISTORICAL_REFERENCE_NOT_FOUND', 'Historical transaction does not match the approved frozen stable reference.', 409);
  }
  const canonicalByKey = new Map(canonicalLines.map(line => [line[lineKeyField], line]));
  if (canonicalByKey.size !== canonicalLines.length) throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'Frozen transaction line keys are duplicated.', 409);
  const lineKeys = transaction.products.map(line => {
    const key = line.stableLineKey;
    const frozen = key && canonicalByKey.get(key);
    const frozenProductKey = frozen && (frozen.productKey || null);
    if (!key || !frozen || frozen[codeField] !== transaction.stableCode
        || (line.productKey || null) !== frozenProductKey || (line.sku || null) !== (frozen.sku || null)
        || Number(line.quantity) !== Number(transaction.type === 'sale'
          ? (frozen.unitsSold ?? frozen.quantity) : frozen.quantityOrdered)
        || (line.sourceEventId && frozen.sourceEventId && line.sourceEventId !== frozen.sourceEventId)) {
      throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'Transaction line does not match its frozen stableLineKey.', 409);
    }
    return key;
  });
  if (lineKeys.length !== canonicalByKey.size) throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'Frozen transaction contains an unmapped line.', 409);
  return { origin: 'HISTORICAL', transactionKey: transaction.stableCode, lineKeys, canonical };
}

async function resolveTransactionChangeReferences(changes, businessId, session) {
  const rows = changes.filter(row => row.entityType === 'transaction' && ['CANCEL', 'RECEIVE'].includes(row.operation));
  if (!rows.length) return changes;
  const ids = [...new Set(rows.map(row => row.entityKey))];
  if (ids.some(id => !mongoose.isValidObjectId(id))) {
    throw fail('HISTORICAL_REFERENCE_NOT_FOUND', 'Operational transaction event has an invalid internal reference.', 409);
  }
  const transactions = await Transaction.find({ businessId, _id: { $in: ids } })
    .select('_id businessId type date status cancelledAt scenarioId sourceEventId stableCode products.productId products.quantity products.productName products.sku products.productKey products.stableLineKey products.sourceEventId purchaseLifecycle scenarioData.canonicalRecord scenarioData.canonicalLines')
    .session(session).lean().maxTimeMS(10000);
  const byId = new Map(transactions.map(transaction => [idOf(transaction._id), transaction]));
  if (transactions.some(transaction => transaction.scenarioId === config.scenarioId)) {
    await resolveV3OperationalScenario(businessId, { session });
  }
  return changes.map(row => {
    if (row.entityType !== 'transaction' || !['CANCEL', 'RECEIVE'].includes(row.operation)) return row;
    const transaction = byId.get(row.entityKey);
    if (!transaction) throw fail('HISTORICAL_REFERENCE_NOT_FOUND', 'Operational transaction event references no tenant-owned transaction.', 409);
    const identity = verifiedTransactionReference(transaction);
    const projection = row.projection || {};
    if ((projection.transactionKey && projection.transactionKey !== identity.transactionKey)
        || (projection.transactionOrigin && projection.transactionOrigin !== identity.origin)
        || (projection.type && projection.type !== transaction.type)) {
      throw fail('HISTORICAL_REFERENCE_NOT_FOUND', 'Operational transaction event disagrees with its stable tenant reference.', 409);
    }
    if (row.operation === 'CANCEL' && transaction.type === 'sale'
        && identity.origin === 'HISTORICAL' && identity.canonical.status !== 'completed') {
      throw fail('HISTORICAL_REFERENCE_NOT_FOUND', 'Cancellation references a frozen sale that was not completed.', 409);
    }
    if (row.operation === 'RECEIVE' && transaction.type !== 'purchase') {
      throw fail('RECEIPT_REFERENCE_INVALID', 'RECEIVE event does not reference a purchase.', 409);
    }
    const expectedLineKeys = new Set(identity.lineKeys);
    if (row.operation === 'CANCEL' && projection.affectedStableLineKeys
        && (projection.affectedStableLineKeys.length !== expectedLineKeys.size
          || projection.affectedStableLineKeys.some(key => !expectedLineKeys.has(key)))) {
      throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'Cancellation line references do not match the transaction.');
    }
    if (row.operation === 'RECEIVE' && (projection.lines || []).some(line => !expectedLineKeys.has(line.lineKey))) {
      throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'Receipt line reference does not match the purchase.');
    }
    if (row.operation === 'RECEIVE' && identity.origin === 'HISTORICAL') {
      const receipt = transaction.purchaseLifecycle?.receipts?.find(item => item.receiptKey === projection.receiptKey);
      const receiptLines = new Map((receipt?.lines || []).map(line => [line.stableLineKey, line]));
      if (identity.canonical.status !== 'pending' || !identity.canonical.promisedAt || identity.canonical.receivedAt
          || transaction.status !== 'completed' || transaction.purchaseLifecycle?.receiptState !== 'COMPLETE'
          || !receipt || receiptLines.size !== expectedLineKeys.size
          || (projection.lines || []).length !== expectedLineKeys.size
          || (projection.lines || []).some(line => {
            const frozen = transaction.scenarioData.canonicalLines.find(item => item.purchaseLineKey === line.lineKey);
            const saved = receiptLines.get(line.lineKey);
            return !frozen || !saved || Number(line.orderedQty) !== Number(frozen.quantityOrdered)
              || Number(line.receivedQty) !== Number(frozen.quantityOrdered)
              || Number(saved.receivedQty) !== Number(line.receivedQty)
              || (saved.purchaseUnitCostCents ?? null) !== (line.purchaseUnitCostCents ?? null)
              || saved.costBasis !== line.costBasis || (saved.currency ?? null) !== (line.currency ?? null);
          })) {
        throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'Receipt does not match a full first receipt of the frozen pending purchase.', 409);
      }
    }
    return { ...row, projection: { ...projection, contractVersion: projection.contractVersion || 2,
      transactionKey: identity.transactionKey, transactionOrigin: identity.origin,
      type: transaction.type,
      ...(row.operation === 'CANCEL' ? { kind: 'CANCEL', affectedStableLineKeys: identity.lineKeys } : { kind: 'RECEIVE' }) } };
  });
}

async function recordV3Movement({ businessId, session, movement, operation = 'ADJUST' }) {
  if (businessId !== config.businessId || !movement) return null;
  return bumpV3OperationalRevision({ businessId, session, effectiveAtUtc: movement.occurredAt, changes: [{
    entityType: 'movement', entityKey: idOf(movement._id), operation,
    projection: { productKey: movement.productId ? `OP-P-${idOf(movement.productId)}` : null,
      type: movement.type, quantityDelta: movement.quantityDelta, stockBefore: movement.stockBefore, stockAfter: movement.stockAfter }
  }] });
}

function transactionProjection(tx, contact = null, productIdentities = []) {
  const isSale = tx.type === 'sale';
  const identities = new Map(productIdentities.map(row => [idOf(row.productId), row]));
  const products = (tx.products || []).map((line, index) => ({
    lineKey: line.stableLineKey || `${idOf(tx._id)}:${index}`,
    productKey: line.productKey || line.sku || identities.get(idOf(line.productId))?.productKey
      || identities.get(idOf(line.productId))?.sku || `OP-P-${idOf(line.productId)}`,
    sku: line.sku || identities.get(idOf(line.productId))?.sku || null, quantity: line.quantity,
    unitPriceCents: cents(line.price), lineTotalCents: cents(line.total ?? Number(line.price) * Number(line.quantity)),
    unitCostAtSaleCents: line.costCents != null ? Number(line.costCents) : cents(line.costPrice),
    costBasis: line.costCents != null || line.costPrice != null ? 'CAPTURED' : 'UNKNOWN',
    costKnown: line.costCents != null || line.costPrice != null,
    promo: Boolean(line.promo || line.discountCents)
  }));
  const projection = isSale ? {
    saleKey: idOf(tx._id), occurredAtUtc: new Date(tx.date).toISOString(), localDate: limaDate(new Date(tx.date)),
    customerKey: tx.customerId ? (contact?.stableCode || contact?.stableKey || `OP-C-${idOf(tx.customerId)}`) : null,
    currency: tx.currency || 'PEN', totalCents: cents(tx.totalAmount), initialStatus: tx.status || 'completed', lines: products
  } : {
    purchaseKey: idOf(tx._id), supplierKey: contact?.stableCode || contact?.stableKey || `OP-S-${idOf(tx.vendorId || tx.supplierId)}`,
    orderedAtUtc: new Date(tx.date).toISOString(), currency: tx.currency || 'PEN', status: tx.status || 'completed',
    receiptEvidence: tx.status === 'pending' ? 'NONE' : 'IMMEDIATE_PURCHASE', promisedAtUtc: null,
    lines: products.map(line => ({ lineKey: line.lineKey, productKey: line.productKey, sku: line.sku,
      quantityOrdered: line.quantity, purchaseUnitCostCents: line.unitPriceCents, lineTotalCents: line.lineTotalCents }))
  };
  if (!isSale && (tx.status === 'pending' || tx.purchaseLifecycle?.fulfillmentMode === 'DEFERRED')) {
    return { ...projection, contractVersion: 2, fulfillmentMode: 'DEFERRED',
      initialStatus: tx.status || 'pending', receiptEvidence: 'NONE',
      promisedAtUtc: tx.purchaseLifecycle?.promisedAtUtc ? new Date(tx.purchaseLifecycle.promisedAtUtc).toISOString() : null };
  }
  return projection;
}

function buildSnapshotSections(changes, asOfDate, closedThrough, visibleProducts = [], throughUtc = null) {
  const catalogChanges = [], sales = [], purchases = [], transactionChanges = [];
  const canceled = new Set();
  const lowerBound = limaDayStart(config.deltaStart).getTime();
  const upperBound = throughUtc ? new Date(throughUtc).getTime() : Number.POSITIVE_INFINITY;
  for (const row of changes) {
    const eventTime = new Date(row.effectiveAtUtc).getTime();
    if (!Number.isFinite(eventTime) || eventTime < lowerBound || eventTime > upperBound) continue;
    const effectiveAtUtc = new Date(row.effectiveAtUtc).toISOString();
    const common = { eventKey: row.eventKey, effectiveAtUtc, revision: String(row.revision), entityType: row.entityType, entityKey: row.entityKey };
    if (['product', 'customer', 'supplier'].includes(row.entityType)) {
      catalogChanges.push({ ...common, operation: row.operation, projection: row.projection });
    } else if (row.entityType === 'sale' && row.operation === 'CREATE') sales.push(row.projection);
    else if (row.entityType === 'purchase' && row.operation === 'CREATE') purchases.push(row.projection);
    else if (row.entityType === 'transaction' && ['CANCEL', 'RECEIVE'].includes(row.operation)) {
      const projection = row.projection || {};
      const transactionKey = projection.transactionKey || row.entityKey;
      const kind = row.operation;
      const lineChanges = kind === 'RECEIVE'
        ? (projection.lines || []).map(line => ({ lineKey: line.lineKey, receivedQty: line.receivedQty,
          productKey: line.productKey, sku: line.sku ?? null, orderedQty: line.orderedQty,
          purchaseUnitCostCents: line.purchaseUnitCostCents ?? null, costBasis: line.costBasis || 'UNAVAILABLE',
          currency: line.currency ?? null }))
        // Match the strict Python wire schema before hashing. Its parser includes
        // nullable fields in model_dump(), so omitted defaults would change the hash.
        : (projection.affectedStableLineKeys || []).map(lineKey => ({ lineKey, receivedQty: null,
          productKey: null, sku: null, orderedQty: null, purchaseUnitCostCents: null,
          costBasis: null, currency: null }));
      transactionChanges.push({ ...common, entityKey: transactionKey, transactionKey,
        transactionOrigin: projection.transactionOrigin || 'LIVE', kind,
        receiptKey: kind === 'RECEIVE' ? projection.receiptKey : null,
        supplierKey: kind === 'RECEIVE' ? projection.supplierKey : null,
        lineChanges });
      if (kind === 'CANCEL') canceled.add(transactionKey);
    }
  }
  const unitsByDayProduct = new Map();
  for (const sale of sales) {
    if (sale.initialStatus !== 'completed' || canceled.has(sale.saleKey) || sale.localDate > closedThrough || sale.localDate <= config.historicalCutoff) continue;
    for (const line of sale.lines) {
      const key = `${line.productKey}\u0000${sale.localDate}`;
      unitsByDayProduct.set(key, (unitsByDayProduct.get(key) || 0) + Number(line.quantity));
    }
  }
  const closedSalesDays = [];
  for (let date = config.deltaStart; date <= closedThrough; date = nextDay(date)) {
    for (const productKey of visibleProducts) {
      const unitsSold = unitsByDayProduct.get(`${productKey}\u0000${date}`) || 0;
      closedSalesDays.push({ productKey, localDate: date, unitsSold, completeness: 'COMPLETE', availability: 'UNKNOWN', availableHours: null, onHandUsableAtOrigin: null });
      if (closedSalesDays.length > 30000) throw fail('SNAPSHOT_SOURCE_LIMIT_EXCEEDED', 'Closed-day coverage exceeds the configured row limit.', 413);
    }
  }
  const sortBy = (array, keys) => array.sort((a, b) => keys.map(key => String(a[key] ?? '').localeCompare(String(b[key] ?? ''))).find(result => result !== 0) || 0);
  sortBy(catalogChanges, ['effectiveAtUtc', 'eventKey']); sortBy(sales, ['occurredAtUtc', 'saleKey']);
  sortBy(purchases, ['orderedAtUtc', 'purchaseKey']); sortBy(transactionChanges, ['effectiveAtUtc', 'eventKey']); sortBy(closedSalesDays, ['localDate', 'productKey']);
  const contractVersion = changes.some(row => row.projection?.contractVersion === 2
    || row.operation === 'RECEIVE') ? '2' : '1';
  return { catalogChanges, sales, purchases, transactionChanges, closedSalesDays, contractVersion };
}

function enforcePayloadLimit(snapshot) {
  if (!snapshot.metadata) snapshot.metadata = {};
  let payloadBytes = Buffer.byteLength(JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, payloadBytes: 0 } }), 'utf8');
  for (let index = 0; index < 5; index += 1) {
    snapshot.metadata.payloadBytes = payloadBytes;
    const measured = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (measured === payloadBytes) break;
    payloadBytes = measured;
  }
  if (payloadBytes > config.maxPayloadBytes) throw fail('SNAPSHOT_PAYLOAD_TOO_LARGE',
    `V3 operational snapshot is ${payloadBytes} bytes; maximum is ${config.maxPayloadBytes}.`, 413);
  return payloadBytes;
}

async function readSnapshotData({ businessId, session, asOfDate, capturedAtUtc }) {
  const from = limaDayStart(config.deltaStart);
  const through = asOfDate === limaDate(capturedAtUtc)
    ? capturedAtUtc
    : new Date(limaDayStart(nextDay(asOfDate)).getTime() - 1);
  // Mongo sessions in a transaction must be used serially (not Promise.all).
  const journalRows = await V3OperationalChange.find({ businessId, effectiveAtUtc: { $gte: from, $lte: through } })
    .sort({ revision: 1, eventOrdinal: 1 }).limit(config.maxChanges + 1).session(session)
    .setOptions({ useBigInt64: true }).lean().maxTimeMS(15000);
  const changes = await resolveTransactionChangeReferences(journalRows, businessId, session);
  const futureCatalogChanges = await V3OperationalChange.find({ businessId, entityType: 'product', effectiveAtUtc: { $gt: through }, operation: { $in: ['UPDATE', 'DEACTIVATE'] } })
    .sort({ effectiveAtUtc: 1, revision: 1, eventOrdinal: 1 }).limit(config.maxChanges + 1).session(session)
    .setOptions({ useBigInt64: true }).lean().maxTimeMS(15000);
  const products = await Product.find({ businessId }).select('_id productKey sku name isActive price currency costPrice category categoryCode subcategoryCode brand presentation sizeValue sizeUnit containedUnits unit perishable shelfLifeDays minStockLevel safetyStock reorderPoint demandProfileKey supplierPrices preferredSupplierId createdAt scenarioId stock')
    .limit(config.maxProducts + 1).session(session).lean().maxTimeMS(15000);
  const movements = await InventoryMovement.aggregate([
    { $match: { businessId, occurredAt: { $lte: through } } },
    { $group: { _id: '$productId', onHand: { $sum: '$quantityDelta' }, movementCount: { $sum: 1 },
      operationalMovementCount: { $sum: { $cond: [{ $gte: ['$occurredAt', from] }, 1, 0] } },
      lastOperationalOccurredAt: { $max: { $cond: [{ $gte: ['$occurredAt', from] }, '$occurredAt', null] } } } },
    { $limit: config.maxProducts + 1 }
  ]).session(session).option({ maxTimeMS: 15000 });
  if (changes.length > config.maxChanges || futureCatalogChanges.length > config.maxChanges
      || products.length > config.maxProducts || movements.length > config.maxProducts) throw fail('SNAPSHOT_SOURCE_LIMIT_EXCEEDED', 'V3 snapshot source count exceeds a safe, explicit limit.', 413);
  const productById = new Map(products.map(product => [idOf(product._id), product]));
  for (const movement of movements) if (!productById.has(idOf(movement._id))) throw fail('SNAPSHOT_CROSS_TENANT_REFERENCE', 'An inventory movement references a product outside the authenticated tenant.', 409);
  const movementByProduct = new Map(movements.map(row => [idOf(row._id), row]));
  if (movements.reduce((count, row) => count + row.movementCount, 0) > config.maxMovements) throw fail('SNAPSHOT_SOURCE_LIMIT_EXCEEDED', 'V3 snapshot movement count exceeds a safe, explicit limit.', 413);
  const visibleProducts = products.filter(product =>
    (product.scenarioId === config.scenarioId && product.sourceEventId)
      || !product.createdAt || new Date(product.createdAt) <= through);
  const asOfProductState = new Map();
  for (const event of futureCatalogChanges) if (!asOfProductState.has(event.entityKey) && event.projection?.before) {
    asOfProductState.set(event.entityKey, event.projection.before);
  }
  const stockStates = visibleProducts.map(product => {
    const onHand = movementByProduct.get(idOf(product._id))?.onHand || 0;
    if (!Number.isSafeInteger(onHand) || onHand < 0) throw fail('SNAPSHOT_INVALID_LEDGER', 'Inventory ledger produced an invalid stock balance.', 409);
    if (asOfDate === limaDate(capturedAtUtc) && onHand !== product.stock) throw fail('SNAPSHOT_LEDGER_MISMATCH', 'Product stock does not reconcile with its inventory ledger.', 409);
    const currentKey = stableKey('product', product);
    const past = asOfProductState.get(currentKey);
    return { productKey: past?.productKey || currentKey, sku: past?.sku ?? (product.sku || null), onHand, stockBasis: 'MONGO_LEDGER' };
  });
  const liveCatalogRows = visibleProducts;
  return { changes, stockStates, products, through,
    visibleProductKeys: liveCatalogRows.map(product => stableKey('product', product)).sort(),
    dataThroughUtc: [...changes.map(row => new Date(row.effectiveAtUtc)), ...movements.map(row => row.lastOperationalOccurredAt).filter(Boolean)]
      .sort((a, b) => b - a)[0]?.toISOString() || null,
  };
}

async function buildV3OperationalSnapshot({ businessId, asOfDate, now = new Date(), minimumDataVersion = null }) {
  await resolveV3OperationalScenario(businessId);
  if (!validIsoDay(asOfDate)) throw fail('INVALID_AS_OF_DATE', 'asOfDate must be a valid ISO calendar day.', 400);
  const operationalDate = limaDate(now);
  if (asOfDate <= config.historicalCutoff) return { mode: 'HISTORICAL', scenarioId: config.scenarioId, asOfDate, dataVersion: null, snapshot: null };
  if (asOfDate > operationalDate) throw fail('FUTURE_AS_OF_DATE', 'asOfDate cannot be later than the V3 operational date.', 400);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await mongoose.startSession({ causalConsistency: true });
    try {
      const floor = await getDataVersion(businessId, { session, majority: true });
      const required = minimumDataVersion != null && BigInt(minimumDataVersion) > BigInt(floor) ? String(minimumDataVersion) : floor;
      session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
      const scenario = await resolveV3OperationalScenario(businessId, { session });
      const revisionRow = await V3OperationalRevision.findById(businessId).session(session)
        .setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
      if (!revisionRow || revisionRow.bootstrapStatus !== 'VERIFIED'
          || revisionRow.historicalDatasetVersion !== config.datasetVersion
          || revisionRow.historicalDatasetSha256 !== config.sourceSha256) {
        throw fail('SNAPSHOT_BOOTSTRAP_REQUIRED', 'V3 live snapshot is unavailable until the audited revision-zero bootstrap is complete.', 409);
      }
      const version = await getDataVersion(businessId, { session });
      if (BigInt(version) < BigInt(required)) throw fail('SNAPSHOT_BELOW_REVISION_FLOOR', 'Consistent snapshot did not observe the required operational revision.', 409);
      const capturedAtUtc = new Date(now);
      const data = await readSnapshotData({ businessId, session, asOfDate, capturedAtUtc });
      const closedThrough = [previousDay(asOfDate), previousDay(operationalDate)].sort()[0];
      const sections = buildSnapshotSections(data.changes, asOfDate, closedThrough, data.visibleProductKeys, data.through);
      const projectedChanges = sections.catalogChanges.map(change => ({ ...change, projection: change.projection || { before: null, after: null } }));
      sections.catalogChanges = projectedChanges;
      const contractV2 = sections.contractVersion === '2';
      const payload = {
        metadata: {
          snapshotVersion: contractV2 ? 'v3-operational-snapshot-v2' : config.snapshotVersion,
          contractVersion: contractV2 ? '2' : config.contractVersion,
          businessId: config.businessId, scenarioId: config.scenarioId,
          historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256,
          historicalCutoff: config.historicalCutoff, deltaStart: config.deltaStart, timezone: config.timezone,
          operationalDate, asOfDate, capturedAtUtc: capturedAtUtc.toISOString(), dataThroughUtc: data.dataThroughUtc,
          observationsClosedThrough: closedThrough,
          dataVersion: version, completeness: 'COMPLETE',
          counts: { catalogChanges: sections.catalogChanges.length, sales: sections.sales.length, purchases: sections.purchases.length,
            transactionChanges: sections.transactionChanges.length, stockStates: data.stockStates.length, closedSalesDays: sections.closedSalesDays.length },
          costCoverage: { knownSaleLines: sections.sales.flatMap(sale => sale.lines).filter(line => line.costKnown).length,
            unknownSaleLines: sections.sales.flatMap(sale => sale.lines).filter(line => !line.costKnown).length },
          availabilityCoverage: 'UNKNOWN'
        },
        catalogChanges: sections.catalogChanges, sales: sections.sales, purchases: sections.purchases,
        transactionChanges: sections.transactionChanges, stockStates: data.stockStates, closedSalesDays: sections.closedSalesDays
      };
      const hashInput = { ...payload, metadata: { ...payload.metadata, capturedAtUtc: undefined } };
      payload.metadata.snapshotHash = logicalHash(hashInput);
      enforcePayloadLimit(payload);
      await session.commitTransaction();
      return { mode: 'LIVE', dataVersion: version, snapshot: payload };
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      const retryableSnapshotError = error.code === 'SNAPSHOT_BELOW_REVISION_FLOOR'
        || error.codeName === 'SnapshotUnavailable'
        || error.hasErrorLabel?.('TransientTransactionError')
        || error.errorLabels?.includes('TransientTransactionError');
      if (attempt === 0 && retryableSnapshotError) continue;
      if (error.code === 'SNAPSHOT_BELOW_REVISION_FLOOR') throw fail('SNAPSHOT_CONSISTENCY_UNAVAILABLE', 'Could not obtain a consistent V3 operational snapshot after one retry.', 503);
      throw error;
    } finally { await session.endSession(); }
  }
  throw fail('SNAPSHOT_CONSISTENCY_UNAVAILABLE', 'Could not obtain a consistent V3 operational snapshot.', 503);
}

module.exports = {
  config, resolveV3OperationalScenario, getDataVersion, bumpV3OperationalRevision, bootstrapV3OperationalRevision,
  buildV3OperationalSnapshot, productProjection, contactProjection, transactionProjection,
  recordV3ProductChange, recordV3ContactChange, recordV3Transaction, recordV3Movement,
  buildSnapshotSections, enforcePayloadLimit, limaDate, limaDayStart, logicalHash,
  verifiedTransactionReference, resolveTransactionChangeReferences
};
