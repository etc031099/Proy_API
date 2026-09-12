/**
 * Optional outbound webhook bridge to Node-RED (or any automation platform).
 *
 * It is a NO-OP unless the NODE_RED_WEBHOOK_URL environment variable is set,
 * so it never changes the behaviour of the existing system by default.
 *
 * When enabled, the backend POSTs an event to Node-RED, for example:
 *   { "event": "transaction.created", "timestamp": "...", "data": { ... } }
 */
const WEBHOOK_TIMEOUT_MS = 5000;

const getWebhookUrl = () => process.env.NODE_RED_WEBHOOK_URL;

/**
 * Fire-and-forget notification. Never throws so it cannot break a request.
 * @param {string} event - Event name, e.g. "transaction.created"
 * @param {object} payload - Event data
 * @returns {Promise<void>}
 */
const notifyNodeRed = async (event, payload = {}) => {
  const url = getWebhookUrl();
  if (!url) return; // integration disabled

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.NODE_RED_WEBHOOK_SECRET
          ? { 'X-Webhook-Secret': process.env.NODE_RED_WEBHOOK_SECRET }
          : {})
      },
      body: JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        data: payload
      }),
      signal: controller.signal
    });
  } catch (error) {
    console.error(`[Node-RED] webhook "${event}" failed:`, error.message);
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Convenience helper to run the webhook without awaiting it.
 */
const emitEvent = (event, payload) => {
  Promise.resolve()
    .then(() => notifyNodeRed(event, payload))
    .catch((error) => console.error('[Node-RED] webhook failed:', error.message));
};

module.exports = {
  notifyNodeRed,
  emitEvent
};
