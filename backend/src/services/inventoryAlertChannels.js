const { createHash, randomUUID } = require('node:crypto');
const Delivery = require('../models/InventoryAlertChannelDelivery');
const Event = require('../models/InventoryAlertOutboxEvent');
const Connection = require('../models/TelegramConnection');
const EVENT_PATTERN = /^[a-f0-9]{24}:inventory\.alert\.(opened|resolved)$/;
const LEASE_MS = 30000;
const MAX_ATTEMPTS = 5;
const destinationKey = connection => connection?.chatId
  ? createHash('sha256').update(String(connection.chatId)).digest('hex') : 'not-connected';
const categorySet = new Set(['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'UNAVAILABLE', 'AUTH', 'FORBIDDEN', 'INVALID_CHAT', 'CONFIGURATION', 'INVALID_RESPONSE']);
const retryableSet = new Set(['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'UNAVAILABLE', 'INVALID_RESPONSE']);
const due = now => ({ $or: [
  { status: { $in: ['PENDING', 'FAILED'] }, nextAttemptAt: { $ne: null, $lte: now } },
  { status: 'IN_FLIGHT', leaseUntil: { $lte: now } }
] });
const repository = {
  event: eventId => Event.findOne({ eventId }).lean().exec(),
  connection: businessId => Connection.findOne({ businessId }).select('businessId chatId enabled stockRuleAlertsEnabled stockRuleResolvedAlertsEnabled').lean().exec(),
  async ensure(event, connection, now = new Date()) {
    const key = { eventId: event.eventId, channel: 'telegram', destinationKey: destinationKey(connection) };
    try {
      await Delivery.updateOne(key, { $setOnInsert: { ...key, businessId: event.businessId,
        productId: event.productId, sku: event.payload.data.product.sku, eventType: event.eventType, nextAttemptAt: now } },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true }).exec();
    } catch (error) { if (error.code !== 11000) throw error; }
  },
  claim: (event, now, token) => Delivery.findOneAndUpdate({ eventId: event.eventId, businessId: event.businessId, ...due(now) },
    { $set: { status: 'IN_FLIGHT', leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now },
      $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } }).lean().exec(),
  finish: (row, token, update) => Delivery.updateOne({ _id: row._id, businessId: row.businessId, status: 'IN_FLIGHT', leaseToken: token },
    { $set: update, $unset: { leaseToken: 1, leaseUntil: 1 } }).exec(),
  // Filter eligibility before limiting, so an undelivered outbox backlog cannot
  // starve channel retries that are ready to send.
  pending: now => Delivery.aggregate([
    { $match: due(now) }, { $lookup: { from: Event.collection.name,
      let: { eventId: '$eventId', businessId: '$businessId' }, pipeline: [
        { $match: { status: 'DELIVERED', receivedAt: { $exists: true, $ne: null }, $expr: { $and: [
          { $eq: ['$eventId', '$$eventId'] }, { $eq: ['$businessId', '$$businessId'] }
        ] } } }, { $project: { _id: 1 } }
      ], as: 'outbox' } }, { $match: { 'outbox.0': { $exists: true } } },
    { $sort: { createdAt: 1, _id: 1 } }, { $limit: 10 }, { $project: { _id: 0, eventId: 1 } }
  ]).option({ maxTimeMS: 5000 }).exec()
};
const messageFor = event => {
  const data = event.payload.data;
  const compact = value => String(value).replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 200);
  return [event.eventType === 'inventory.alert.opened' ? '⚠️ Regla de stock personalizada activada' : '✅ Regla de stock personalizada recuperada',
    `${compact(data.product.sku)} · ${compact(data.product.name)}`,
    `Stock: ${data.previousStock} → ${data.newStock}`,
    `Condición: stock ${data.condition.operator} ${data.condition.threshold}`].join('\n');
};
const createInventoryAlertChannels = ({ repo = repository, send = require('./telegramService').sendMessage, clock = () => new Date() } = {}) => {
  const prepare = async eventId => {
    if (typeof eventId !== 'string' || !EVENT_PATTERN.test(eventId)) return null;
    const event = await repo.event(eventId);
    if (!event?.receivedAt) return null;
    await repo.ensure(event, await repo.connection(event.businessId), clock());
    return { status: 'PENDING' };
  };
  const processPendingEvent = async eventId => {
    const event = await repo.event(eventId);
    // Receipt and Node-RED ACK alone never authorize a send before ACT-04A delivery.
    if (!event || event.status !== 'DELIVERED' || !event.receivedAt) return { status: 'PENDING' };
    const token = randomUUID(), row = await repo.claim(event, clock(), token);
    if (!row) return { status: 'UNCHANGED' };
    const connection = await repo.connection(event.businessId);
    const skipReason = !['inventory.alert.opened', 'inventory.alert.resolved'].includes(event.eventType) ? 'unsupported_event'
      : !connection?.chatId ? 'telegram_not_configured' : !connection.enabled ? 'telegram_disabled'
        : !(event.eventType === 'inventory.alert.opened' ? connection.stockRuleAlertsEnabled : connection.stockRuleResolvedAlertsEnabled)
          ? 'preference_disabled' : destinationKey(connection) !== row.destinationKey ? 'destination_changed' : null;
    if (skipReason) {
      await repo.finish(row, token, { status: 'SKIPPED', skipReason, nextAttemptAt: null });
      return { status: 'SKIPPED' };
    }
    try {
      await send(connection.chatId, messageFor(event));
      await repo.finish(row, token, { status: 'DELIVERED', deliveredAt: clock(), nextAttemptAt: null, lastErrorCategory: null });
      return { status: 'DELIVERED' };
    } catch (error) {
      const category = categorySet.has(error.category) ? error.category : 'NETWORK';
      const retryable = retryableSet.has(category) && row.attempts < MAX_ATTEMPTS;
      const nextAttemptAt = retryable ? new Date(clock().getTime() + require('./inventoryAlertOutbox').backoffMs(row.attempts)) : null;
      await repo.finish(row, token, { status: 'FAILED', lastErrorCategory: category, nextAttemptAt });
      return { status: retryable ? 'PENDING' : 'FAILED' };
    }
  };
  return {
    prepare,
    processPendingEvent,
    async process(eventId) {
      if (!await prepare(eventId)) return null;
      // Insert-before-read plus dispatcher's afterDelivered drain closes the ACK race.
      return processPendingEvent(eventId);
    },
    async run() {
      const rows = await repo.pending(clock()), summary = { processed: 0 };
      for (const row of rows) { await processPendingEvent(row.eventId); summary.processed++; }
      return summary;
    }
  };
};
module.exports = { createInventoryAlertChannels, repository, destinationKey, messageFor, LEASE_MS, MAX_ATTEMPTS };
