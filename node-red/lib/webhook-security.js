const crypto = require('node:crypto');

const ALLOWED_EVENTS = new Set([
  'transaction.created',
  'product.low_stock',
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

  if (typeof payload.event !== 'string' || !ALLOWED_EVENTS.has(payload.event)) {
    return rejection(400, 'UNSUPPORTED_WEBHOOK_EVENT', 'Webhook event is not supported');
  }

  const data = { ...payload.data };
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
    event: payload.event,
    data
  };
};

const createWebhookSecurity = (expectedSecret) => ({
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
