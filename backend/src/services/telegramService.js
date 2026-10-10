const crypto = require('crypto');
const { TelegramConnection } = require('../models');
const { emitEvent } = require('./webhookService');

const TELEGRAM_API = 'https://api.telegram.org';
const CODE_TTL_MS = 10 * 60 * 1000;

const getToken = () => process.env.TELEGRAM_BOT_TOKEN;
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const requestError = (category, retryable) => Object.assign(new Error('Telegram request failed'), { category, retryable });

const telegramRequest = async (method, payload, timeoutMs = 8000) => {
  const token = getToken();
  if (!token) {
    throw requestError('CONFIGURATION', false);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error'
    });
    let data;
    try { data = await response.json(); } catch (error) {
      if (controller.signal.aborted) throw requestError('TIMEOUT', true);
      throw requestError(response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'UNAVAILABLE'
        : response.status === 401 ? 'AUTH' : response.status === 403 ? 'FORBIDDEN' : response.status === 400 ? 'INVALID_CHAT' : 'INVALID_RESPONSE',
      ![400, 401, 403].includes(response.status));
    }
    if (!response.ok || !data?.ok) {
      const status = data?.error_code || response.status;
      throw requestError(status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'UNAVAILABLE'
        : status === 401 ? 'AUTH' : status === 403 ? 'FORBIDDEN' : status === 400 ? 'INVALID_CHAT' : 'CONFIGURATION',
      status === 429 || status >= 500);
    }
    return data.result;
  } catch (error) {
    if (error.category) throw error;
    throw requestError(error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', true);
  } finally { clearTimeout(timeoutId); }
};

const createConnectionCode = async (businessId) => {
  const code = `BILLING-${crypto.randomInt(100000, 1000000)}`;
  await TelegramConnection.findOneAndUpdate(
    { businessId },
    {
      connectionCodeHash: hashCode(code),
      connectionCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      enabled: true
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { code, expiresAt: new Date(Date.now() + CODE_TTL_MS) };
};

const getConnection = (businessId) => TelegramConnection.findOne({ businessId }).lean();

const disconnect = async (businessId) => {
  await TelegramConnection.findOneAndUpdate(
    { businessId },
    { $unset: { chatId: 1, connectionCodeHash: 1, connectionCodeExpiresAt: 1 } }
  );
};

// Menú de botones que aparece en el chat (el usuario solo toca, no escribe).
const MENU_KEYBOARD = {
  keyboard: [
    [{ text: '📦 Stock bajo' }, { text: '💰 Ventas de hoy' }],
    [{ text: '🧾 Deudas' }, { text: '❓ Ayuda' }]
  ],
  resize_keyboard: true
};

const sendMessage = async (chatId, text, extra = {}) => telegramRequest('sendMessage', {
  chat_id: chatId,
  text,
  disable_web_page_preview: true,
  ...extra
});

const notifyLowStock = async (businessId, product, previousStock) => {
  if (product.stock > product.minStockLevel || previousStock <= product.minStockLevel) return;
  const connection = await TelegramConnection.findOne({
    businessId,
    enabled: true,
    lowStockAlertsEnabled: true,
    chatId: { $exists: true, $ne: null }
  });
  if (!connection) return;

  await sendMessage(connection.chatId, [
    '⚠️ LOW STOCK ALERT / ALERTA DE STOCK BAJO',
    '',
    '🇬🇧 English',
    `Product: ${product.name}`,
    `Current stock: ${product.stock}`,
    `Minimum stock: ${product.minStockLevel}`,
    'Action: Please restock this product.',
    '',
    '🇪🇸 Español',
    `Producto: ${product.name}`,
    `Stock actual: ${product.stock}`,
    `Stock mínimo: ${product.minStockLevel}`,
    'Acción: Reponer este producto.',
  ].join('\n'));
  connection.lastAlertAt = new Date();
  await connection.save();
};

const createTelegramUpdateProcessor = ({ send = sendMessage, emit = emitEvent, connections = TelegramConnection,
  recovery = require('./telegramRecovery').telegramRecovery } = {}) => async (update) => {
  const message = update.message;
  const text = message?.text?.trim();
  const chatId = message?.chat?.id;
  if (!text || !chatId) return;

  if (/^\/transfer(?:\s|$|@)/i.test(text)) {
    // No public update endpoint: this processor is called only by authenticated getUpdates.
    // Private chat identity must be the sending human, never a forwarded/group destination.
    if (message.chat.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0
      || message.from?.id !== chatId || message.from?.is_bot !== false) return;
    const match = /^\/transfer\s+(TRF-[A-F0-9]{16})$/i.exec(text);
    const result = await recovery.confirm(match ? match[1].toUpperCase() : '', String(chatId));
    const replies = {
      CONNECTED: 'Telegram conectado correctamente. Las preferencias corresponden al negocio de destino.',
      ALREADY_CONNECTED: 'Telegram ya está conectado a este negocio.',
      USED: 'Esta transferencia ya fue utilizada.',
      EXPIRED: 'El código venció. Solicita uno nuevo desde Integraciones.',
      INVALID: 'Código de transferencia inválido o vencido.',
      DESTINATION_CONNECTED: 'Desconecta primero el Telegram actual del negocio de destino.',
      RATE_LIMITED: 'Demasiados intentos. Espera 10 minutos antes de volver a intentarlo.',
      CONFLICT: 'Otra transferencia está en curso. Vuelve a intentarlo.',
      UNAVAILABLE: 'No se pudo completar la transferencia. Vuelve a intentarlo.'
    };
    await send(chatId, replies[result.status] || replies.UNAVAILABLE);
    return;
  }

  const code = text.replace(/^\/start\s*/i, '').trim().toUpperCase();
  if (!/^BILLING-\d{6}$/.test(code)) {
    if (/^\/start$/i.test(text)) {
      await send(
        chatId,
        [
          '👋 Bienvenido al bot de tu sistema de Inventario y Facturación.',
          '',
          'Usa los botones de abajo para consultar tu sistema.',
          '',
          'Para recibir alertas de stock, envía el código de conexión que genera tu sistema.'
        ].join('\n'),
        { reply_markup: MENU_KEYBOARD }
      );
      return;
    }

    // Forward any other message (comandos escritos o textos de los botones) to Node-RED.
    // Node-RED only REPLIES (sendMessage), so it never conflicts with this poller.
    emit('telegram.command', {
      chatId: String(chatId),
      text,
      username: message?.from?.username || null,
      name: [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(' ') || null
    });
    return;
  }

  const connection = await connections.findOne({
    connectionCodeHash: hashCode(code),
    connectionCodeExpiresAt: { $gt: new Date() }
  });
  if (!connection) {
    await send(chatId, 'This connection code is invalid or expired.');
    return;
  }

  connection.chatId = String(chatId);
  connection.connectionCodeHash = undefined;
  connection.connectionCodeExpiresAt = undefined;
  try { await connection.save(); }
  catch (error) {
    if (error.code !== 11000) throw error;
    await send(chatId, 'Este Telegram ya está vinculado. Usa Recuperar conexión desde Integraciones.');
    return;
  }
  await send(chatId, 'Telegram notifications connected successfully.');
};
const processUpdate = createTelegramUpdateProcessor();

let polling = false;
let offset = 0;
const pollUpdates = async () => {
  if (polling || !getToken()) return;
  polling = true;
  try {
    const updates = await telegramRequest(
      'getUpdates',
      { offset, timeout: 25, allowed_updates: ['message'] },
      35000
    );
    for (const update of updates) {
      offset = update.update_id + 1;
      await processUpdate(update);
    }
  } catch (error) {
    console.error('[Telegram] polling error:', error.category || 'UNAVAILABLE');
  } finally {
    polling = false;
    if (getToken()) setTimeout(pollUpdates, 1000);
  }
};

const startPolling = () => {
  if (getToken()) pollUpdates();
};

module.exports = {
  sendMessage,
  createConnectionCode,
  getConnection,
  disconnect,
  notifyLowStock,
  createTelegramUpdateProcessor,
  startPolling
};
