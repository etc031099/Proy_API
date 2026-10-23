const { createHash } = require('node:crypto');
const { readTelegramConfig } = require('../config/telegramAssistant');
const { createAgentRequestContext } = require('../agents/contracts');
const { sameBinding, createTelegramTransportRepository } = require('./telegramTransportRepository');
const { formatTelegramResponse, telegramFrames } = require('./telegramFormatter');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const CHANNEL_MESSAGE = 'Las operaciones desde Telegram todavía no están habilitadas.';
const parseUpdate = update => {
  const callback = update?.callback_query;
  const message = callback?.message || update?.message;
  const actor = callback?.from || message?.from;
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0
    || Object.keys(update).some(key => !['update_id', callback ? 'callback_query' : 'message'].includes(key))
    || !message
    || !Number.isSafeInteger(message.message_id) || message.message_id < 1
    || message.chat?.type !== 'private' || !Number.isSafeInteger(message.chat.id) || message.chat.id <= 0
    || actor?.id !== message.chat.id || actor?.is_bot !== false
    || message.sender_chat || message.via_bot || message.forward_origin
    || callback && (message.date === 0 || typeof callback.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callback.id)
      || typeof callback.data !== 'string' || !/^t1:[A-Za-z0-9_-]{22}$/.test(callback.data))) fail('TELEGRAM_UPDATE_UNSUPPORTED');
  let text, control;
  if (!callback) {
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000) fail('TELEGRAM_UPDATE_UNSUPPORTED');
    text = message.text.trim();
    if (text.startsWith('/')) {
      if (/^\/start(?:@[A-Za-z0-9_]+)?$/.test(text)) { control = 'start'; text = '/start'; }
      else if (/^\/transfer(?:\s|$)/.test(text)) { control = 'transfer'; text = '/transfer'; }
      else fail('TELEGRAM_UPDATE_UNSUPPORTED');
    }
  }
  return { updateId: update.update_id, chatId: String(message.chat.id), telegramUserId: String(actor.id), text, control,
    ...(callback ? { callbackToken: callback.data, callbackQueryId: callback.id, callbackMessageId: message.message_id } : {}),
    fingerprint: createHash('sha256').update(JSON.stringify([message.chat.id, actor.id, message.message_id, callback?.data || message.text])).digest('hex') };
};
const createTelegramConversations = (config = readTelegramConfig) => {
  const { logAgentEvent } = require('../controllers/agentMessagesController');
  const actionService = require('../automations/execution').createActionService();
  const runtime = require('../automations/assistant').withActionAssistant(
    require('../agents/orchestrator').createAgentOrchestrator({ onEvent: logAgentEvent }), actionService,
    { sourceChannel: 'telegram', readOnly: true, requireCustomerDecision: true,
      telegramOperationsEnabled: () => config().operationsEnabled });
  return require('./agentConversationService').createAgentConversationService({ runtime, actionService, sourceChannel: 'telegram', durableTransport: true });
};
const createTelegramAssistantTransport = ({ config = readTelegramConfig, repository = createTelegramTransportRepository(),
  loadUser = async (id, session) => require('../models/User').findById(id).select('_id businessId role isActive').session(session || null).lean(),
  conversations = createTelegramConversations(config), telegram = require('./telegramService') } = {}) => {
  const authorize = async (settings, identity, session) => {
    const binding = settings.bindings.find(row => row.chatId === identity.chatId && row.telegramUserId === identity.telegramUserId);
    if (!binding) fail('TELEGRAM_UNAUTHORIZED');
    const user = await loadUser(binding.systemUserId, session);
    const req = { user, businessId: binding.businessId };
    try { createAgentRequestContext(req); if (String(user._id) !== binding.systemUserId) fail('TELEGRAM_UNAUTHORIZED'); }
    catch { fail('TELEGRAM_UNAUTHORIZED'); }
    return { binding, req };
  };
  return Object.freeze({
    async admit(update) {
      const settings = config();
      if (!settings.enabled || settings.mode !== 'webhook') fail('TELEGRAM_CHANNEL_DISABLED');
      const parsed = parseUpdate(update);
      const { binding, req } = await authorize(settings, parsed);
      await repository.assertReady();
      const result = await repository.admit(binding, parsed,
        (durable, text, key, session) => conversations.enqueueTransportMessage(req, durable.conversationId, text, key, session), settings);
      if (parsed.callbackQueryId) {
        // Answer only after full binding/token validation and durable consumption. No LLM involved.
        await telegram.answerCallbackQuery(parsed.callbackQueryId);
      }
      return { ...result, channel: 'telegram' };
    },
    async recover() {
      const settings = config();
      if (!settings.enabled || settings.mode !== 'webhook') return;
      await repository.assertReady();
      await Promise.all((await repository.pending()).map(async receipt => {
        const claim = await repository.claim(receipt._id);
        if (!claim) return;
        try {
          const { binding, req } = await authorize(settings, claim.binding);
          if (!sameBinding(claim.binding, binding) || claim.receipt.bindingGeneration !== binding.bindingGeneration) fail('TELEGRAM_BINDING_REVOKED');
          const isAction = ['CONFIRM_ACTION', 'CANCEL_ACTION'].includes(claim.receipt.control);
          if (isAction && req.user.role !== 'admin') fail('TELEGRAM_UNAUTHORIZED');
          if (isAction && !config().operationsEnabled) fail('TELEGRAM_CALLBACK_INVALID');
          const actionInput = { conversationId: claim.binding.conversationId, transportControl: claim.receipt.control, pendingActionId: claim.receipt.pendingActionId };
          let saved = await conversations.transportRequest(req, claim.binding.conversationId, claim.receipt.requestKey);
          if (saved.status === 'failed') { await repository.reject(claim, 'TELEGRAM_READ_FAILED'); return; }
          if (claim.reconcile && saved.status !== 'completed') {
            if (isAction && await conversations.reconcileTransportAction(req, actionInput, claim.receipt.requestKey))
              saved = await conversations.transportRequest(req, claim.binding.conversationId, claim.receipt.requestKey);
            else { await repository.uncertain(claim); return; } // Never repeat an uncertain skill/write.
          }
          if (saved.status !== 'completed') {
            if (isAction) {
              const freshSettings = config();
              if (!freshSettings.enabled || freshSettings.mode !== 'webhook' || !freshSettings.operationsEnabled) fail('TELEGRAM_CALLBACK_INVALID');
              const fresh = await authorize(freshSettings, claim.binding);
              if (!sameBinding(claim.binding, fresh.binding) || fresh.binding.bindingGeneration !== claim.receipt.bindingGeneration) fail('TELEGRAM_BINDING_REVOKED');
              if (fresh.req.user.role !== 'admin') fail('TELEGRAM_UNAUTHORIZED');
            }
            await repository.invoke(claim); // Durable INVOKING before any skill/provider, outside the transaction.
            await conversations.send(req, { message: saved.text, conversationId: claim.binding.conversationId,
              transportControl: claim.receipt.control, pendingActionId: claim.receipt.pendingActionId }, claim.receipt.requestKey);
            saved = await conversations.transportRequest(req, claim.binding.conversationId, claim.receipt.requestKey);
          }
          if (!saved.response) fail('TELEGRAM_HISTORY_UNCERTAIN');
          if (claim.receipt.status !== 'OUTPUT_READY') await repository.output(claim, formatTelegramResponse(saved.response).choices);
          const frames = telegramFrames(saved.response, await repository.tokens(claim.receipt.requestKey));
          for (let index = claim.receipt.deliveryIndex || 0; index < frames.length; index++) {
            await authorize(config(), claim.binding);
            await repository.beginSend(claim, index);
            const { text, ...extra } = frames[index];
            const sent = await telegram.sendMessage(claim.binding.chatId, text, extra);
            if (!Number.isSafeInteger(sent?.message_id)) fail('TELEGRAM_DELIVERY_UNCERTAIN');
            await repository.sent(claim, index, sent.message_id, index === frames.length - 1);
          }
        } catch (error) {
          if (error.code === 'TELEGRAM_CLAIM_STALE') return;
          if (['TELEGRAM_UNAUTHORIZED', 'TELEGRAM_BINDING_REVOKED', 'TELEGRAM_CALLBACK_INVALID'].includes(error.code)) await repository.reject(claim, error.code);
          else await repository.uncertain(claim);
        }
      }));
    },
    operationsMessage: CHANNEL_MESSAGE
  });
};
let timer;
const startTelegramTransportRecovery = () => {
  if (timer) return;
  try { if (!readTelegramConfig().enabled) return; } catch { return; }
  const transport = createTelegramAssistantTransport();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await transport.recover(); }
    catch { console.warn(JSON.stringify({ event: 'TELEGRAM_TRANSPORT_RETRYABLE', channel: 'telegram' })); }
    finally { busy = false; }
  };
  timer = setInterval(tick, 5000); timer.unref();
  void tick();
};
module.exports = { parseUpdate, createTelegramAssistantTransport, startTelegramTransportRecovery, createTelegramConversations, CHANNEL_MESSAGE };
