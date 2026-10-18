'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const { Contact, Product, Transaction, V3OperationalChange } = require('../models');
const { applyStockChange, normalizeDate } = require('./inventoryService');
const { bumpV3OperationalRevision, config, limaDate } = require('./v3OperationalSnapshotService');

const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const idOf = value => value == null ? null : String(value);
const integerCents = value => Number.isSafeInteger(value) && value >= 0;

function historicalPurchaseIdentity(transaction) {
  const canonical = transaction.scenarioData?.canonicalRecord;
  const lines = transaction.scenarioData?.canonicalLines;
  if (transaction.scenarioId !== config.scenarioId || transaction.type !== 'purchase'
      || !transaction.stableCode || canonical?.purchaseCode !== transaction.stableCode
      || canonical?.scenarioId !== config.scenarioId || !Array.isArray(lines)
      || lines.length !== transaction.products.length) {
    throw fail('HISTORICAL_REFERENCE_NOT_FOUND', 'The historical purchase has no verifiable frozen stable identity.');
  }
  const byKey = new Map(lines.map(line => [line.purchaseLineKey, line]));
  if (byKey.size !== lines.length) throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'Historical purchase line identities are duplicated.');
  const orderedLines = transaction.products.map((line, index) => {
    const canonicalLine = byKey.get(line.stableLineKey);
    if (!line.stableLineKey || !canonicalLine || canonicalLine.purchaseCode !== transaction.stableCode
        || canonicalLine.productKey !== line.productKey || (canonicalLine.sku || null) !== (line.sku || null)
        || Number(canonicalLine.quantityOrdered) !== Number(line.quantity)
        || Number(canonicalLine.quantityReceived || 0) !== 0) {
      throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'A historical purchase line does not match its frozen stable line key.');
    }
    return { line, canonicalLine, index };
  });
  if (orderedLines.length !== byKey.size) throw fail('HISTORICAL_LINE_REFERENCE_INVALID', 'Historical purchase contains an unmapped frozen line.');
  return { transactionKey: transaction.stableCode, canonical, orderedLines };
}

function livePurchaseIdentity(transaction) {
  const lifecycle = transaction.purchaseLifecycle;
  if (transaction.scenarioId || transaction.type !== 'purchase' || !lifecycle
      || lifecycle.fulfillmentMode !== 'DEFERRED') {
    throw fail('RECEIPT_REFERENCE_INVALID', 'Only a pending deferred V3 purchase can be received.');
  }
  return {
    transactionKey: transaction.stableCode || idOf(transaction._id),
    canonical: null,
    orderedLines: transaction.products.map((line, index) => ({
      line,
      canonicalLine: null,
      index,
      lineKey: line.stableLineKey || `${idOf(transaction._id)}:${index}`
    }))
  };
}

function orderCost(line, canonicalLine, isHistorical, transactionCurrency) {
  const cents = isHistorical
    ? canonicalLine?.purchasePriceCents
    : line.costCents != null ? line.costCents
      : Number.isFinite(Number(line.costPrice)) ? Math.round(Number(line.costPrice) * 100)
        : null;
  if (cents == null) return { cents: null, basis: 'UNAVAILABLE', currency: null };
  if (!integerCents(cents)) throw fail('RECEIPT_REFERENCE_INVALID', 'Stored purchase cost is invalid.');
  return { cents, basis: isHistorical ? 'HISTORICAL_COST' : 'ORDER_COST', currency: transactionCurrency };
}

/**
 * Apply one full receipt to a pending deferred purchase. This is an internal
 * contract primitive; it intentionally does not expose a public route or UI.
 * The purchase state, append-only stock movements, journal event, and revision
 * are committed in one Mongo transaction.
 */
async function receiveV3Purchase({ businessId, purchaseId, receiptKey, receivedAtUtc = new Date(), observedReceiptCosts = [] }) {
  if (businessId !== config.businessId) throw fail('RECEIPT_REFERENCE_INVALID', 'Authenticated business is not the V3 tenant.', 403);
  if (typeof receiptKey !== 'string' || receiptKey.trim().length < 8 || receiptKey.trim().length > 160) {
    throw fail('RECEIPT_REFERENCE_INVALID', 'receiptKey must be a stable idempotency key between 8 and 160 characters.', 400);
  }
  if (!mongoose.isValidObjectId(purchaseId)) {
    throw fail('RECEIPT_REFERENCE_INVALID', 'Purchase reference is invalid.', 400);
  }
  const normalizedReceiptKey = receiptKey.trim();
  if (!Array.isArray(observedReceiptCosts)) throw fail('RECEIPT_REFERENCE_INVALID', 'observedReceiptCosts must be an array.', 400);
  const normalizedObservedCosts = observedReceiptCosts.map(evidence => {
    if (!evidence || typeof evidence.lineKey !== 'string'
        || !integerCents(evidence.purchaseUnitCostCents)
        || typeof evidence.currency !== 'string' || evidence.currency.length !== 3) {
      throw fail('RECEIPT_REFERENCE_INVALID', 'Observed receipt cost must include a line, non-negative integer cents, and currency.', 400);
    }
    return { lineKey: evidence.lineKey, purchaseUnitCostCents: evidence.purchaseUnitCostCents, currency: evidence.currency };
  }).sort((a, b) => a.lineKey.localeCompare(b.lineKey));
  if (new Set(normalizedObservedCosts.map(row => row.lineKey)).size !== normalizedObservedCosts.length) {
    throw fail('RECEIPT_REFERENCE_INVALID', 'Observed receipt cost must be unique per line.', 400);
  }
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(normalizedObservedCosts)).digest('hex');

  const session = await mongoose.startSession();
  try {
    session.startTransaction({ writeConcern: { w: 'majority' } });
    const existingEvent = await V3OperationalChange.findOne({ businessId, operation: 'RECEIVE', 'projection.receiptKey': normalizedReceiptKey })
      .session(session).setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
    const transaction = await Transaction.findOne({ _id: purchaseId, businessId, type: 'purchase' }).session(session).maxTimeMS(5000);
    if (!transaction) throw fail('RECEIPT_REFERENCE_INVALID', 'Purchase does not belong to the authenticated business.', 404);

    const historical = transaction.scenarioId === config.scenarioId;
    if (historical) await require('./v3OperationalSnapshotService').resolveV3OperationalScenario(businessId, { session });
    const identity = historical ? historicalPurchaseIdentity(transaction) : livePurchaseIdentity(transaction);
    if (existingEvent) {
      if (existingEvent.entityKey !== idOf(transaction._id)
          || existingEvent.projection?.transactionKey !== identity.transactionKey
          || existingEvent.projection?.requestHash !== requestHash) {
        throw fail('RECEIPT_ALREADY_APPLIED', 'receiptKey was already used for a different purchase.', 409);
      }
      await session.abortTransaction();
      return { alreadyApplied: true, receiptKey: normalizedReceiptKey, transactionKey: identity.transactionKey,
        revision: String(existingEvent.revision), receivedAtUtc: existingEvent.effectiveAtUtc };
    }

    const receivedAt = normalizeDate(receivedAtUtc, 'receivedAtUtc');
    if (receivedAt.getTime() > Date.now()) throw fail('RECEIPT_REFERENCE_INVALID', 'A receipt timestamp cannot be in the future.', 400);

    const orderStatus = historical ? identity.canonical.status : transaction.status;
    const isDeferred = historical
      ? orderStatus === 'pending' || Boolean(identity.canonical.promisedAt && !identity.canonical.receivedAt)
      : transaction.purchaseLifecycle.fulfillmentMode === 'DEFERRED';
    if (!isDeferred || orderStatus !== 'pending' || transaction.status !== 'pending') {
      if (transaction.purchaseLifecycle?.receiptState === 'COMPLETE'
          || transaction.purchaseLifecycle?.receipts?.length) {
        throw fail('RECEIPT_ALREADY_APPLIED', 'Purchase already has a receipt recorded.', 409);
      }
      throw fail('RECEIPT_REFERENCE_INVALID', 'Only a purchase still pending its first full receipt is supported.', 409);
    }
    if (receivedAt < transaction.date) throw fail('RECEIPT_REFERENCE_INVALID', 'Receipt timestamp cannot precede the purchase order.', 400);
    if (historical && (!identity.canonical.promisedAt || identity.canonical.receivedAt)) {
      throw fail('RECEIPT_REFERENCE_INVALID', 'Frozen purchase does not represent a pending dated receipt.');
    }

    const vendorId = idOf(transaction.vendorId || transaction.supplierId);
    const supplier = vendorId ? await Contact.findOne({ _id: vendorId, businessId, type: 'vendor' })
      .select('_id stableCode stableKey').session(session).lean().maxTimeMS(5000) : null;
    if (!supplier) throw fail('RECEIPT_REFERENCE_INVALID', 'Purchase supplier does not belong to the authenticated business.', 403);
    const supplierKey = supplier.stableCode || supplier.stableKey || `OP-S-${vendorId}`;
    if (historical && identity.canonical.supplierCode !== supplierKey) {
      throw fail('RECEIPT_REFERENCE_INVALID', 'Historical supplier does not match the frozen purchase reference.');
    }
    const productIds = identity.orderedLines.map(row => idOf(row.line.productId));
    const products = await Product.find({ _id: { $in: productIds }, businessId }).session(session).maxTimeMS(5000);
    const productById = new Map(products.map(product => [idOf(product._id), product]));
    if (productById.size !== new Set(productIds).size) throw fail('RECEIPT_REFERENCE_INVALID', 'A purchase product is outside the authenticated business.', 403);

    const observedByLine = new Map();
    for (const evidence of normalizedObservedCosts) {
      if (observedByLine.has(evidence.lineKey)
          || evidence.currency !== (transaction.currency || 'PEN')) {
        throw fail('RECEIPT_REFERENCE_INVALID', 'Observed receipt cost must be unique per line and match the purchase currency.', 400);
      }
      observedByLine.set(evidence.lineKey, evidence);
    }

    const previousReceipts = transaction.purchaseLifecycle?.receipts || [];
    if (previousReceipts.length || transaction.purchaseLifecycle?.receiptState === 'COMPLETE') {
      throw fail('RECEIPT_ALREADY_APPLIED', 'Purchase already has a receipt recorded.', 409);
    }
    const currency = transaction.currency || 'PEN';
    const eventLines = [];
    const lifecycleLines = [];
    for (const { line, canonicalLine, index, lineKey: explicitLineKey } of identity.orderedLines) {
      const lineKey = explicitLineKey || line.stableLineKey || `${idOf(transaction._id)}:${index}`;
      const product = productById.get(idOf(line.productId));
      const productKey = product.productKey || product.sku || `OP-P-${idOf(product._id)}`;
      if ((line.productKey && line.productKey !== productKey)
          || (line.sku && line.sku !== (product.sku || null))
          || (canonicalLine && (canonicalLine.productKey !== (product.productKey || null)
            || (canonicalLine.sku || null) !== (product.sku || null)))) {
        throw fail('RECEIPT_REFERENCE_INVALID', 'Purchase line product identity does not match its tenant product.');
      }
      const orderedQty = Number(canonicalLine?.quantityOrdered ?? line.quantity);
      if (!Number.isSafeInteger(orderedQty) || orderedQty < 1) throw fail('RECEIPT_REFERENCE_INVALID', 'Ordered quantity is invalid.');
      const requested = observedByLine.get(lineKey);
      const orderEvidence = orderCost(line, canonicalLine, historical, currency);
      const evidence = requested
        ? { cents: requested.purchaseUnitCostCents, basis: 'OBSERVED_RECEIPT_COST', currency }
        : orderEvidence;
      const valueDeltaCents = evidence.cents == null ? null : evidence.cents * orderedQty;
      if (valueDeltaCents != null && !Number.isSafeInteger(valueDeltaCents)) {
        throw fail('RECEIPT_REFERENCE_INVALID', 'Received purchase value exceeds the supported safe integer range.');
      }
      eventLines.push({ lineKey, productKey,
        sku: product.sku || null, orderedQty, receivedQty: orderedQty,
        purchaseUnitCostCents: evidence.cents, costBasis: evidence.basis, currency: evidence.currency });
      lifecycleLines.push({ stableLineKey: lineKey, receivedQty: orderedQty,
        purchaseUnitCostCents: evidence.cents, costBasis: evidence.basis, currency: evidence.currency });
      await applyStockChange({ product, quantityDelta: orderedQty, type: 'purchase', transactionId: transaction._id,
        occurredAt: receivedAt, source: 'api', scenarioId: transaction.scenarioId || null,
        sourceEventId: `v3-receipt:${normalizedReceiptKey}:${lineKey}`, stableCode: transaction.stableCode || null,
        localDate: limaDate(receivedAt), reason: 'v3_purchase_receipt', currency: evidence.currency,
        unitCostCents: evidence.cents, valueDeltaCents, costBasis: evidence.basis, session });
    }
    for (const lineKey of observedByLine.keys()) {
      if (!eventLines.some(line => line.lineKey === lineKey)) throw fail('RECEIPT_REFERENCE_INVALID', 'Observed receipt cost references an unknown purchase line.', 400);
    }

    transaction.status = 'completed';
    transaction.purchaseLifecycle = {
      fulfillmentMode: 'DEFERRED', orderedAtUtc: transaction.date,
      promisedAtUtc: historical ? identity.canonical.promisedAt : transaction.purchaseLifecycle?.promisedAtUtc || null,
      receiptState: 'COMPLETE',
      receipts: [{ receiptKey: normalizedReceiptKey, receivedAtUtc: receivedAt, lines: lifecycleLines }]
    };
    await transaction.save({ session });
    const revision = await bumpV3OperationalRevision({ businessId, session, effectiveAtUtc: receivedAt, changes: [{
      entityType: 'transaction', entityKey: idOf(transaction._id), operation: 'RECEIVE',
      projection: { contractVersion: 2, transactionKey: identity.transactionKey,
        transactionOrigin: historical ? 'HISTORICAL' : 'LIVE', type: 'purchase', kind: 'RECEIVE',
        receiptKey: normalizedReceiptKey, requestHash, supplierKey, lines: eventLines }
    }] });
    await session.commitTransaction();
    return { alreadyApplied: false, receiptKey: normalizedReceiptKey, transactionKey: identity.transactionKey,
      revision, receivedAtUtc: receivedAt, receiptState: 'COMPLETE' };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    if (error?.code === 11000 && error?.keyPattern?.['projection.receiptKey']) {
      const duplicate = await V3OperationalChange.findOne({ businessId, operation: 'RECEIVE', 'projection.receiptKey': normalizedReceiptKey })
        .setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
      if (duplicate && duplicate.entityKey === idOf(purchaseId)) {
        if (duplicate.projection?.requestHash !== requestHash) {
          throw fail('RECEIPT_ALREADY_APPLIED', 'receiptKey was already used with different receipt cost evidence.', 409);
        }
        return { alreadyApplied: true, receiptKey: normalizedReceiptKey,
          transactionKey: duplicate.projection.transactionKey, revision: String(duplicate.revision),
          receivedAtUtc: duplicate.effectiveAtUtc };
      }
      throw fail('RECEIPT_ALREADY_APPLIED', 'receiptKey was already applied.', 409);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = { receiveV3Purchase: input => require('./mlTestFence').runCycle(() => receiveV3Purchase(input)), historicalPurchaseIdentity };
