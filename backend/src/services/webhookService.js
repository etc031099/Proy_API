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
 * Deliver a notification without exposing payloads or secrets in logs.
 * @param {string} event - Event name, e.g. "transaction.created"
 * @param {object} payload - Event data
 * @returns {Promise<{delivered: boolean, status?: number, reason?: string}>}
 */
const notifyNodeRed = async (event, payload = {}) => {
  const url = getWebhookUrl();
  if (!url) return { delivered: false, reason: 'disabled' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
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

    if (!response.ok) {
      const status = Number(response.status);
      const category = status === 401 || status === 403
        ? 'authentication rejected'
        : status >= 500
          ? 'service unavailable'
          : 'request rejected';
      console.error(`[Node-RED] webhook delivery failed: ${category} (HTTP ${status})`);
      return { delivered: false, status, reason: category };
    }

    return { delivered: true, status: response.status };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'request timed out' : 'network request failed';
    console.error(`[Node-RED] webhook delivery failed: ${reason}`);
    return { delivered: false, reason };
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
    .catch(() => console.error('[Node-RED] webhook delivery failed unexpectedly'));
};

module.exports = {
  notifyNodeRed,
  emitEvent
};
