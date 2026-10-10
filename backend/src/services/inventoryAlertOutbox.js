const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const Event = require('../models/InventoryAlertOutboxEvent');
const eventIdentity = (alertId, eventType) => `${alertId}:${eventType}`;
const recordAlertEvent = async ({ alert, eventType, previousStock, newStock, product, occurredAt, session }) => {
  if (!session?.inTransaction()) throw new Error('Alert outbox requires a transaction');
  if (!product) product = await require('../models/Product').findOne({ _id: alert.productId, businessId: alert.businessId })
    .select('sku name').session(session).lean().exec();
  if (!product) throw new Error('Alert product unavailable');
  const eventId = eventIdentity(alert._id, eventType);
  const payload = { eventId, eventType, occurredAt: occurredAt.toISOString(), data: {
    alertId: String(alert._id), source: 'stock_alert_rule',
    product: { sku: product.sku, name: product.name },
    condition: { operator: alert.condition.operator, threshold: alert.condition.threshold },
    previousStock, newStock, status: eventType === 'inventory.alert.opened' ? 'OPEN' : 'RESOLVED'
  } };
  await Event.updateOne({ eventId }, { $setOnInsert: { eventId, eventType, businessId: alert.businessId,
    alertId: alert._id, productId: alert.productId, payload } }, { upsert: true, session, runValidators: true }).exec();
};
const backoffMs = attempts => [30000, 120000, 300000, 900000][Math.min(Math.max(attempts - 1, 0), 3)];
const repository = {
  claim: (now, token) => Event.findOneAndUpdate({ $or: [
    { status: { $in: ['PENDING', 'FAILED'] }, nextAttemptAt: { $ne: null, $lte: now } },
    { status: 'IN_FLIGHT', leaseUntil: { $lte: now } }
  ] }, { $set: { status: 'IN_FLIGHT', leaseToken: token, leaseUntil: new Date(now.getTime() + 15000), lastAttemptAt: now },
    $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } }).lean().exec(),
  finish: (row, token, update) => Event.updateOne({ eventId: row.eventId, status: 'IN_FLIGHT', leaseToken: token },
    { $set: update, $unset: { leaseToken: 1, leaseUntil: 1 } }).exec()
};
const send = async payload => {
  const url = process.env.NODE_RED_WEBHOOK_URL, secret = process.env.NODE_RED_WEBHOOK_SECRET;
  if (!url || !secret) return { category: 'DISABLED', retryable: true };
  // HTTPS for deployed traffic; loopback HTTP is allowed only for local development.
  let target;
  try { target = new URL(url); } catch { return { category: 'PAYLOAD', retryable: false }; }
  if (target.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production'
    && target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) return { category: 'PAYLOAD', retryable: false };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret }, body: JSON.stringify(payload) });
    if (response.ok) {
      const ack = await response.json();
      return ack.success === true && ack.eventId === payload.eventId ? { delivered: true } : { category: 'INVALID_ACK', retryable: true };
    }
    const status = response.status;
    return { category: status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'UNAVAILABLE' : [401, 403].includes(status) ? 'AUTH' : 'PAYLOAD',
      retryable: status === 429 || status >= 500 };
  } catch (error) { return { category: error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', retryable: true }; }
  finally { clearTimeout(timer); }
};
const createInventoryAlertDispatcher = ({ repo = repository, deliver = send, clock = () => new Date() } = {}) => ({
  async run() {
    const summary = { claimed: 0, delivered: 0, retrying: 0, failed: 0 };
    for (let i = 0; i < 10; i++) {
      const token = randomUUID(), row = await repo.claim(clock(), token);
      if (!row) break;
      summary.claimed++;
      let result;
      try { result = await deliver(row.payload); } catch { result = { category: 'NETWORK', retryable: true }; }
      if (result.delivered) {
        await repo.finish(row, token, { status: 'DELIVERED', deliveredAt: clock(), nextAttemptAt: null, lastErrorCategory: null });
        summary.delivered++;
      } else {
        await repo.finish(row, token, { status: 'FAILED', lastErrorCategory: result.category,
          nextAttemptAt: result.retryable ? new Date(clock().getTime() + backoffMs(row.attempts)) : null });
        summary[result.retryable ? 'retrying' : 'failed']++;
      }
    }
    return summary;
  }
});
// Stored receipt is the consumer inbox for ACT-04A; channel delivery is a separate later phase.
const receiveAlertEvent = async payload => {
  if (!payload || typeof payload.eventId !== 'string' || payload.eventId.length > 100) return null;
  const row = await Event.findOne({ eventId: payload.eventId }).lean().exec();
  if (!row || !isDeepStrictEqual(row.payload, payload)) return null;
  const result = await Event.updateOne({ eventId: row.eventId, receivedAt: { $exists: false } }, { $set: { receivedAt: new Date() } }).exec();
  return { success: true, eventId: row.eventId, duplicate: result.modifiedCount === 0 };
};
module.exports = { recordAlertEvent, eventIdentity, backoffMs, createInventoryAlertDispatcher, receiveAlertEvent, repository, send };
