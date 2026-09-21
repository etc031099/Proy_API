const crypto = require('node:crypto');
const fs = require('node:fs');
const readline = require('node:readline');
const mongoose = require('mongoose');

const {
  Contact, Product, Transaction, CreditPayment,
  InventoryMovement, HistoricalScenario
} = require('../../src/models');
const { createProduct } = require('../../src/controllers/productController');
const {
  createTransaction,
  updateTransactionStatus
} = require('../../src/controllers/transactionController');
const { createCreditPayment } = require('../../src/controllers/creditPaymentController');
const { normalizeDate } = require('../../src/services/inventoryService');

const CONTACT_FIELDS = [
  '_id', 'name', 'phone', 'documentType', 'documentNumber', 'email', 'address',
  'latitude', 'longitude', 'type', 'isActive', 'notes', 'creditLimit',
  'currentBalance', 'balancesByCurrency'
];

const pick = (value, fields) => Object.fromEntries(
  fields.filter(field => Object.prototype.hasOwnProperty.call(value, field))
    .map(field => [field, value[field]])
);

const sha256File = filePath => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});

const invokeController = (controller, req) => new Promise((resolve, reject) => {
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) {
      if (statusCode >= 400) {
        reject(Object.assign(new Error(body.message || 'Historical import failed'), {
          statusCode,
          response: body
        }));
      } else {
        resolve({ statusCode, body });
      }
      return this;
    }
  };
  controller(req, res, reject);
});

const assertScenarioId = scenarioId => {
  if (typeof scenarioId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(scenarioId)) {
    throw new Error('scenarioId must be 1-100 letters, numbers, dots, underscores or hyphens');
  }
};

const assertObjectId = (value, field) => {
  if (!mongoose.isObjectIdOrHexString(value)) throw new Error(`${field} must be a valid ObjectId`);
  return new mongoose.Types.ObjectId(value);
};

const assertOwned = async (Model, id, businessId, scenarioId, label) => {
  const document = await Model.findOne({ _id: id, businessId, scenarioId }).select('_id createdAt');
  if (!document) throw new Error(`${label} is not owned by this business and scenario`);
  return document;
};

const createContactEvent = async ({ event, businessId, scenarioId }) => {
  const occurredAt = normalizeDate(event.occurredAt);
  const data = pick(event.payload || {}, CONTACT_FIELDS);
  data._id = assertObjectId(data._id, 'contact._id');
  data.businessId = businessId;
  data.scenarioId = scenarioId;
  data.sourceEventId = event.eventId;
  data.createdAt = occurredAt;
  data.updatedAt = occurredAt;
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const [contact] = await Contact.create([data], { session });
    await session.commitTransaction();
    return contact;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
};

const processHistoricalEvent = async ({ event, businessId, scenarioId }) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Each NDJSON line must be an object');
  }
  if (typeof event.eventId !== 'string' || !event.eventId.trim()) {
    throw new Error('Every historical event requires eventId');
  }
  const occurredAt = normalizeDate(event.occurredAt);
  const payload = event.payload || {};

  if (event.eventType === 'contact.created') {
    return createContactEvent({ event, businessId, scenarioId });
  }

  if (event.eventType === 'product.created') {
    const productId = assertObjectId(payload._id, 'product._id');
    for (const supplierPrice of payload.supplierPrices || []) {
      await assertOwned(Contact, supplierPrice.supplierId, businessId, scenarioId, 'supplier');
    }
    return invokeController(createProduct, {
      businessId,
      body: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== '_id')),
      historicalContext: {
        productId,
        scenarioId,
        sourceEventId: event.eventId,
        createdAt: occurredAt
      }
    });
  }

  if (event.eventType === 'transaction.completed') {
    const transactionId = assertObjectId(payload._id, 'transaction._id');
    if (!['sale', 'purchase'].includes(payload.type)) {
      throw new Error('transaction.type must be sale or purchase');
    }
    for (const item of payload.products || []) {
      await assertOwned(Product, item.productId, businessId, scenarioId, 'product');
    }
    if (payload.customerId) {
      await assertOwned(Contact, payload.customerId, businessId, scenarioId, 'customer');
    }
    if (payload.vendorId) {
      await assertOwned(Contact, payload.vendorId, businessId, scenarioId, 'vendor');
    }
    return invokeController(createTransaction, {
      businessId,
      body: { ...payload, status: undefined, date: undefined, cancelledAt: undefined },
      historicalContext: {
        transactionId,
        scenarioId,
        sourceEventId: event.eventId,
        date: occurredAt,
        createdAt: occurredAt,
        exchangeRates: payload.exchangeRates || {}
      }
    });
  }

  if (event.eventType === 'credit-payment.created') {
    const paymentId = assertObjectId(payload._id, 'credit payment._id');
    await assertOwned(Contact, payload.customerId, businessId, scenarioId, 'customer');
    return invokeController(createCreditPayment, {
      businessId,
      body: payload,
      historicalContext: {
        paymentId,
        scenarioId,
        sourceEventId: event.eventId,
        date: occurredAt,
        createdAt: occurredAt
      }
    });
  }

  if (event.eventType === 'transaction.cancelled') {
    const transactionId = assertObjectId(payload.transactionId, 'transactionId');
    await assertOwned(Transaction, transactionId, businessId, scenarioId, 'transaction');
    return invokeController(updateTransactionStatus, {
      businessId,
      params: { id: transactionId },
      body: { status: 'cancelled' },
      historicalContext: {
        scenarioId,
        sourceEventId: event.eventId,
        cancelledAt: occurredAt
      }
    });
  }

  throw new Error(`Unsupported eventType: ${event.eventType}`);
};

const importHistoricalScenario = async ({ filePath, businessId, scenarioId, batchSize = 500 }) => {
  assertScenarioId(scenarioId);
  if (!businessId || typeof businessId !== 'string') throw new Error('businessId is required');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error('batchSize must be an integer from 1 to 5000');
  }
  const sourceSha256 = await sha256File(filePath);
  const existing = await HistoricalScenario.findOne({ businessId, scenarioId });
  if (existing) {
    if (existing.status === 'completed' && existing.sourceSha256 === sourceSha256) {
      return { alreadyImported: true, importedRecords: existing.importedRecords, sourceSha256 };
    }
    throw new Error(
      `Scenario ${scenarioId} already exists with status ${existing.status}; reset it explicitly before retrying`
    );
  }

  const marker = await HistoricalScenario.create({
    businessId, scenarioId, sourceSha256, status: 'importing'
  });
  let importedRecords = 0;
  let previousOccurredAt = null;
  try {
    const lines = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON at line ${lineNumber}: ${error.message}`);
      }
      const occurredAt = normalizeDate(event.occurredAt);
      if (previousOccurredAt && occurredAt < previousOccurredAt) {
        throw new Error(`Events are not in causal time order at line ${lineNumber}`);
      }
      previousOccurredAt = occurredAt;
      try {
        await processHistoricalEvent({ event, businessId, scenarioId });
      } catch (error) {
        throw new Error(`Historical event failed at line ${lineNumber}: ${error.message}`);
      }
      importedRecords += 1;
      if (importedRecords % batchSize === 0) {
        await HistoricalScenario.updateOne(
          { _id: marker._id },
          { $set: { importedRecords } }
        );
      }
    }
    marker.status = 'completed';
    marker.importedRecords = importedRecords;
    await marker.save();
    return { alreadyImported: false, importedRecords, sourceSha256 };
  } catch (error) {
    await HistoricalScenario.updateOne(
      { _id: marker._id },
      { $set: { status: 'failed', importedRecords, failureMessage: error.message } }
    );
    throw error;
  }
};

const deleteInBatches = async (Model, filter, batchSize) => {
  let deleted = 0;
  while (true) {
    const ids = await Model.find(filter).select('_id').limit(batchSize).lean();
    if (!ids.length) return deleted;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const result = await Model.collection.deleteMany(
        { ...filter, _id: { $in: ids.map(item => item._id) } },
        { session }
      );
      await session.commitTransaction();
      deleted += result.deletedCount;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }
};

const resetHistoricalScenario = async ({ businessId, scenarioId, batchSize = 1000 }) => {
  assertScenarioId(scenarioId);
  const marker = await HistoricalScenario.findOne({ businessId, scenarioId });
  if (!marker) return { found: false, deleted: {} };
  const filter = { businessId, scenarioId };
  const deleted = {};
  for (const [name, Model] of [
    ['inventoryMovements', InventoryMovement],
    ['creditPayments', CreditPayment],
    ['transactions', Transaction],
    ['products', Product],
    ['contacts', Contact]
  ]) {
    deleted[name] = await deleteInBatches(Model, filter, batchSize);
  }
  deleted.scenarios = await deleteInBatches(HistoricalScenario, filter, 1);
  return { found: true, deleted };
};

module.exports = {
  importHistoricalScenario,
  resetHistoricalScenario,
  processHistoricalEvent,
  sha256File
};
