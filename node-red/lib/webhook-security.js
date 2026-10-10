const crypto = require('node:crypto');

const ALLOWED_EVENTS = new Set([
  'transaction.created',
  'product.low_stock',
  'inventory.alert.opened',
  'inventory.alert.resolved',
  'telegram.command'
]);

const CHAT_ID_PATTERN = /^-?[1-9]\d{0,19}$/;
const ALLOWED_TELEGRAM_COMMANDS = new Set(['stock', 'ventas', 'deudas', 'ayuda']);
const ALLOWED_TELEGRAM_BUTTONS = new Set([
  'stock bajo',
  'ventas de hoy',
  'deudas',
  'ayuda'
]);

const isPlainObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const constantTimeEqual = (received, expected) => {
  const receivedValue = typeof received === 'string' ? received : '';
  const expectedValue = typeof expected === 'string' ? expected : '';
  const receivedDigest = crypto.createHash('sha256').update(receivedValue, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedValue, 'utf8').digest();

  return crypto.timingSafeEqual(receivedDigest, expectedDigest)
    && receivedValue.length > 0
    && expectedValue.length > 0;
};

const getHeader = (headers, name) => {
  if (!isPlainObject(headers)) return undefined;
  const expectedName = name.toLowerCase();
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === expectedName);
  return matchingKey ? headers[matchingKey] : undefined;
};

const normalizeChatId = (value) => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    value = String(value);
  }

  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return CHAT_ID_PATTERN.test(normalized) ? normalized : null;
};

const isAllowedTelegramCommand = (text) => {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith('/')) {
    const command = normalized.split(/\s+/, 1)[0].slice(1).split('@', 1)[0];
    return ALLOWED_TELEGRAM_COMMANDS.has(command);
  }

  const withoutButtonIcon = normalized.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return ALLOWED_TELEGRAM_BUTTONS.has(withoutButtonIcon);
};

const rejection = (statusCode, code, message) => ({
  ok: false,
  statusCode,
  code,
  message
});

const validateWebhookRequest = ({ headers, payload }, expectedSecret) => {
  const receivedSecret = getHeader(headers, 'x-webhook-secret');
  if (!constantTimeEqual(receivedSecret, expectedSecret)) {
    return rejection(401, 'WEBHOOK_UNAUTHORIZED', 'Webhook authentication failed');
  }

  if (!isPlainObject(payload) || !isPlainObject(payload.data)) {
    return rejection(400, 'INVALID_WEBHOOK_PAYLOAD', 'Webhook payload must contain an object data field');
  }

  const event = payload.eventType || payload.event;
  if (typeof event !== 'string' || !ALLOWED_EVENTS.has(event)) {
    return rejection(400, 'UNSUPPORTED_WEBHOOK_EVENT', 'Webhook event is not supported');
  }

  const data = { ...payload.data };
  if (event.startsWith('inventory.alert.')) {
    const status = event === 'inventory.alert.opened' ? 'OPEN' : 'RESOLVED';
    const keys = (object, allowed) => isPlainObject(object) && Object.keys(object).every(key => allowed.includes(key));
    if (!keys(payload, ['eventId', 'eventType', 'occurredAt', 'data'])
      || payload.eventType !== event || typeof payload.eventId !== 'string'
      || !/^[a-f0-9]{24}:inventory\.alert\.(opened|resolved)$/.test(payload.eventId)
      || typeof payload.occurredAt !== 'string' || !Number.isFinite(Date.parse(payload.occurredAt))
      || !keys(data, ['alertId', 'source', 'product', 'condition', 'previousStock', 'newStock', 'status'])
      || !/^[a-f0-9]{24}$/.test(data.alertId) || payload.eventId !== `${data.alertId}:${event}`
      || data.source !== 'stock_alert_rule' || data.status !== status
      || !keys(data.product, ['sku', 'name']) || !['sku', 'name'].every(key => typeof data.product[key] === 'string'
        && data.product[key].length > 0 && data.product[key].length <= 200)
      || !keys(data.condition, ['operator', 'threshold']) || !['<', '<='].includes(data.condition.operator)
      || !Number.isSafeInteger(data.condition.threshold) || data.condition.threshold < 0 || data.condition.threshold > 1000000
      || ![data.previousStock, data.newStock].every(value => Number.isSafeInteger(value) && value >= 0)) {
      return rejection(400, 'INVALID_ALERT_EVENT', 'Invalid inventory alert event');
    }
  }
  if (payload.event === 'telegram.command') {
    const chatId = normalizeChatId(data.chatId);
    if (!chatId) {
      return rejection(400, 'INVALID_CHAT_ID', 'Telegram chatId is invalid');
    }
    if (
      typeof data.text !== 'string'
      || data.text.trim().length === 0
      || data.text.length > 4096
      || !isAllowedTelegramCommand(data.text)
    ) {
      return rejection(400, 'INVALID_TELEGRAM_COMMAND', 'Telegram command text is invalid');
    }
    data.chatId = chatId;
    data.text = data.text.trim();
  }

  return {
    ok: true,
    event,
    data
  };
};

const createWebhookSecurity = (expectedSecret) => ({
  async processInventoryAlertChannels(eventId, baseUrl, fetchImpl = fetch) {
    if (typeof eventId !== 'string' || !/^[a-f0-9]{24}:inventory\.alert\.(opened|resolved)$/.test(eventId)) return { success: false };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const target = new URL(`${String(baseUrl).replace(/\/$/, '')}/internal/inventory-alert-dispatch/channels/process`);
      if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', 'backend'].includes(target.hostname))) return { success: false };
      const response = await fetchImpl(target.href, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': expectedSecret }, body: JSON.stringify({ eventId }) });
      const result = await response.json();
      return { success: response.ok && result.success === true };
    } catch { return { success: false }; }
    finally { clearTimeout(timer); }
  },
  async receiveInventoryAlert(message, baseUrl, fetchImpl = fetch) {
    const validated = validateWebhookRequest({ headers: message?.req?.headers || {}, payload: message.payload }, expectedSecret);
    const reply = (statusCode, payload) => ({ ...message, statusCode, headers: { 'Content-Type': 'application/json' }, payload });
    if (!validated.ok) return reply(validated.statusCode, { success: false, code: validated.code });
    if (!validated.event.startsWith('inventory.alert.')) return reply(400, { success: false, code: 'INVALID_ALERT_EVENT' });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try {
      const target = new URL(`${String(baseUrl).replace(/\/$/, '')}/internal/inventory-alert-dispatch/receipt`);
      if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', 'backend'].includes(target.hostname))) {
        return reply(503, { success: false, code: 'RECEIPT_UNAVAILABLE' });
      }
      const response = await fetchImpl(target.href, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': expectedSecret }, body: JSON.stringify(message.payload) });
      const result = await response.json();
      if (!response.ok || result.success !== true || result.eventId !== message.payload.eventId) {
        const status = response.status >= 500 ? 503 : [401, 403, 429].includes(response.status) ? response.status : 400;
        return reply(status, { success: false, code: 'INVALID_ALERT_RECEIPT' });
      }
      return reply(200, { success: true, eventId: result.eventId, duplicate: result.duplicate === true });
    } catch { return reply(503, { success: false, code: 'RECEIPT_UNAVAILABLE' }); }
    finally { clearTimeout(timer); }
  },
  routeMessage(message) {
    const headers = message?.req?.headers || message?.headers || {};
    const result = validateWebhookRequest({ headers, payload: message?.payload }, expectedSecret);

    if (!result.ok) {
      message.statusCode = result.statusCode;
      message.headers = { 'Content-Type': 'application/json' };
      message.payload = {
        success: false,
        code: result.code,
        message: result.message
      };
      return [null, message];
    }

    message.event = result.event;
    message.data = result.data;
    message.payload = `Evento: ${result.event}`;
    return [message, null];
  }
});

const parseBasicAuthorization = (header) => {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
};

const hasBasicAuthorization = (headers, username, password) => {
  const credentials = parseBasicAuthorization(headers?.authorization);
  return Boolean(
    credentials
    && constantTimeEqual(credentials.username, username)
    && constantTimeEqual(credentials.password, password)
  );
};

const createHttpNodeMiddleware = ({ username, password, protectPrivateEndpoints }) => (
  request,
  response,
  next
) => {
  const requestPath = String(request.path || request.url || '').split('?')[0];

  // The webhook authenticates itself inside the first flow node.
  if (requestPath === '/webhook') return next();
  if (!protectPrivateEndpoints) return next();

  if (hasBasicAuthorization(request.headers, username, password)) return next();

  response.statusCode = 401;
  response.setHeader('WWW-Authenticate', 'Basic realm="Node-RED"');
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ success: false, code: 'HTTP_NODE_UNAUTHORIZED' }));
  return undefined;
};

const createDashboardIoMiddleware = ({ username, password, protectPrivateEndpoints }) => (
  socket,
  next
) => {
  if (!protectPrivateEndpoints || hasBasicAuthorization(socket?.request?.headers, username, password)) {
    return next();
  }

  const error = new Error('Dashboard authentication failed');
  error.data = { code: 'DASHBOARD_UNAUTHORIZED' };
  return next(error);
};

module.exports = {
  ALLOWED_EVENTS,
  constantTimeEqual,
  createDashboardIoMiddleware,
  createHttpNodeMiddleware,
  createWebhookSecurity,
  isAllowedTelegramCommand,
  normalizeChatId,
  validateWebhookRequest
};
