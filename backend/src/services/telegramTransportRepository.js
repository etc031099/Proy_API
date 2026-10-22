const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const Binding = require('../models/TelegramAssistantBinding');
const Receipt = require('../models/TelegramUpdateReceipt');
const Conversation = require('../models/AgentConversation');
const Message = require('../models/AgentConversationMessage');
const Callback = require('../models/TelegramCallbackToken');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sameBinding = (row, expected) => row?.active === true && ['chatId', 'telegramUserId', 'systemUserId', 'businessId', 'bindingGeneration']
  .every(key => String(row[key]) === String(expected[key]));
const transaction = async work => {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5000 }); }
  finally { await session.endSession(); }
};
const createTelegramTransportRepository = ({ BindingModel = Binding, ReceiptModel = Receipt, ConversationModel = Conversation,
  MessageModel = Message, CallbackModel = Callback, transact = transaction, clock = Date.now } = {}) => {
  const Binding = BindingModel, Receipt = ReceiptModel;
  const Tokens = CallbackModel;
  const owned = async (claim, session, allowRevoked = false) => {
    const binding = await Binding.findOneAndUpdate({ _id: claim.binding._id, ...(!allowRevoked ? { active: true } : {}), activeReceiptId: claim.receipt._id,
      bindingGeneration: claim.binding.bindingGeneration }, { $inc: { processingVersion: 1 } }, { session, new: true }).lean();
    const receipt = binding && await Receipt.findOne({ _id: claim.receipt._id, ownerToken: claim.receipt.ownerToken }).session(session).lean();
    if (!receipt) fail('TELEGRAM_CLAIM_STALE');
    return { binding, receipt };
  };
  return ({
  async assertReady() {
    // No automatic index/collection writes on startup or HTTP requests.
    for (const Model of [Binding, Receipt, ConversationModel, MessageModel, CallbackModel]) {
      const actual = await Model.collection.listIndexes().toArray();
      for (const [key, options] of Model.schema.indexes()) {
        if (!actual.some(index => JSON.stringify(index.key) === JSON.stringify(key)
          && Boolean(index.unique) === Boolean(options.unique) && !index.partialFilterExpression && !index.sparse
          && index.expireAfterSeconds === options.expireAfterSeconds)) fail('TELEGRAM_INDEXES_REQUIRED');
      }
    }
  },
  async admit(expected, update, enqueue, { operationsEnabled = false } = {}) {
    // Initial concurrent upserts can race on a unique key. Retry the whole short transaction once.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await transact(async session => {
          let binding = await Binding.findOne({ businessId: expected.businessId }).session(session).lean();
          if (!binding) {
            [binding] = await Binding.create([{ ...expected, conversationId: randomUUID(), active: true }], { session });
          }
          if (!sameBinding(binding, expected)) fail('TELEGRAM_BINDING_REVOKED');
          const prior = await Receipt.findOne({ updateId: update.updateId }).session(session).lean();
          if (prior) {
            if (String(prior.bindingId) !== String(binding._id) || prior.fingerprint !== update.fingerprint
              || prior.bindingGeneration !== binding.bindingGeneration) fail('TELEGRAM_UPDATE_CONFLICT');
            return { duplicate: true, requestKey: prior.requestKey, status: prior.status };
          }
          let token;
          if (update.callbackToken) {
            token = await Tokens.findOne({ token: update.callbackToken, bindingId: binding._id }).session(session).lean();
            if (!token || !sameBinding({ ...token, active: true }, expected) || token.sourceChannel !== 'telegram'
              || !['candidate', 'page', 'refine', 'cancel', 'CONFIRM_ACTION', 'CANCEL_ACTION'].includes(token.purpose)
              || (['CONFIRM_ACTION', 'CANCEL_ACTION'].includes(token.purpose)
                ? !operationsEnabled || !require('../agents/contracts').isTraceId(token.pendingActionId)
                : typeof token.selectionMessage !== 'string' || !token.selectionMessage.trim() || token.selectionMessage.length > 2000)
              || token.conversationId !== binding.conversationId || !Number.isFinite(new Date(token.expiresAt).getTime())
              || new Date(token.expiresAt) <= new Date(clock())
              || token.messageId !== update.callbackMessageId) fail('TELEGRAM_CALLBACK_INVALID');
            if (token.consumedRequestKey) {
              const original = await Receipt.findOne({ requestKey: token.consumedRequestKey }).session(session).lean();
              if (!original) fail('TELEGRAM_CALLBACK_INVALID');
              return { duplicate: true, requestKey: original.requestKey, status: original.status };
            }
            if (token.keyboardRequestKey !== binding.keyboardRequestKey || binding.keyboardClaimKey) fail('TELEGRAM_CALLBACK_INVALID');
          }
          const changed = await Binding.findOneAndUpdate({ _id: binding._id, active: true, bindingGeneration: expected.bindingGeneration },
            { $inc: { nextSequence: 1 } }, { new: true, session }).lean();
          if (!changed) fail('TELEGRAM_BINDING_REVOKED');
          const requestKey = randomUUID();
          if (token) {
            await Tokens.updateOne({ _id: token._id }, { $set: { consumedRequestKey: requestKey } }, { session });
            await Binding.updateOne({ _id: binding._id }, { $set: { keyboardClaimKey: requestKey } }, { session });
          }
          if (enqueue) await enqueue(binding, token?.selectionMessage || (token?.purpose === 'CONFIRM_ACTION' ? 'Confirmar operación'
            : token?.purpose === 'CANCEL_ACTION' ? 'Cancelar operación' : update.text), requestKey, session);
          await Receipt.create([{ updateId: update.updateId, fingerprint: update.fingerprint,
            control: token?.purpose || update.control, pendingActionId: token?.pendingActionId, callbackQueryId: update.callbackQueryId,
            callbackMessageId: update.callbackMessageId, callbackExpiresAt: token?.expiresAt, keyboardRequestKey: token?.keyboardRequestKey,
            requestKey, bindingId: binding._id, bindingGeneration: binding.bindingGeneration,
            sequence: changed.nextSequence, status: 'RECEIVED' }], { session });
          return { duplicate: false, requestKey, status: 'RECEIVED' };
        });
      } catch (error) { if (error.code !== 11000 || attempt) throw error; }
    }
  },
  // One queue head per binding: a blocked chat cannot starve other authorized businesses.
  pending: () => Receipt.aggregate([
    { $match: { status: { $in: ['RECEIVED', 'PROCESSING', 'UNCERTAIN', 'OUTPUT_READY'] } } },
    { $sort: { sequence: 1, _id: 1 } }, { $group: { _id: '$bindingId', receipt: { $first: '$$ROOT' } } },
    { $limit: 20 }, { $replaceRoot: { newRoot: '$receipt' } }
  ]),
  async claim(receiptId) {
    return transact(async session => {
      const candidate = await Receipt.findOne({ _id: receiptId, status: { $in: ['RECEIVED', 'PROCESSING', 'UNCERTAIN', 'OUTPUT_READY'] } }).session(session).lean();
      if (!candidate) return null;
      const binding = await Binding.findOneAndUpdate({ _id: candidate.bindingId }, { $inc: { processingVersion: 1 } }, { session, new: true }).lean();
      if (!binding) return null;
      if (binding.activeReceiptId && String(binding.activeReceiptId) !== String(candidate._id)) return null;
      const first = await Receipt.findOne({ bindingId: binding._id, status: { $in: ['RECEIVED', 'PROCESSING', 'UNCERTAIN', 'OUTPUT_READY'] } })
        .sort({ sequence: 1 }).session(session).lean();
      if (String(first?._id) !== String(candidate._id)) return null;
      if (candidate.leaseUntil > new Date(clock())) return null;
      if (candidate.invocationStarted && ['PROCESSING', 'UNCERTAIN'].includes(candidate.status)) return { binding, receipt: candidate, reconcile: true };
      if (candidate.sending) {
        await Receipt.updateOne({ _id: candidate._id }, { $set: { status: 'DELIVERY_UNKNOWN', resultCode: 'TELEGRAM_DELIVERY_UNCERTAIN' } }, { session });
        await Binding.updateOne({ _id: binding._id }, { $set: { activeReceiptId: null } }, { session });
        return null;
      }
      if (candidate.keyboardRequestKey && (candidate.keyboardRequestKey !== binding.keyboardRequestKey || candidate.callbackExpiresAt <= new Date(clock()))) {
        await Receipt.updateOne({ _id: candidate._id }, { $set: { status: 'FAILED', resultCode: 'TELEGRAM_CALLBACK_INVALID' } }, { session });
        await Binding.updateOne({ _id: binding._id }, { $set: { activeReceiptId: null } }, { session });
        return null;
      }
      const ownerToken = randomUUID(), leaseUntil = new Date(clock() + 120000);
      await Binding.updateOne({ _id: binding._id }, { $set: { activeReceiptId: candidate._id } }, { session });
      const receipt = await Receipt.findOneAndUpdate({ _id: candidate._id }, { $set: { ownerToken, leaseUntil,
        status: candidate.status === 'OUTPUT_READY' ? 'OUTPUT_READY' : 'PROCESSING' } }, { session, new: true }).lean();
      return { binding: { ...binding, activeReceiptId: candidate._id }, receipt };
    });
  },
  async invoke(claim) {
    return transact(async session => {
      const { receipt } = await owned(claim, session);
      if (receipt.status !== 'PROCESSING' || receipt.invocationStarted || receipt.leaseUntil <= new Date(clock())) fail('TELEGRAM_CLAIM_STALE');
      if (receipt.callbackExpiresAt <= new Date(clock())) fail('TELEGRAM_CALLBACK_INVALID');
      await Receipt.updateOne({ _id: receipt._id }, { $set: { invocationStarted: true } }, { session });
    });
  },
  async uncertain(claim) {
    return transact(async session => {
      const { receipt } = await owned(claim, session);
      if (receipt.status === 'PROCESSING') await Receipt.updateOne({ _id: receipt._id },
        { $set: { status: 'UNCERTAIN', resultCode: 'TELEGRAM_EXECUTION_UNCERTAIN' } }, { session });
    });
  },
  async output(claim, choices) {
    return transact(async session => {
      const { binding, receipt } = await owned(claim, session);
      if (!['PROCESSING', 'UNCERTAIN'].includes(receipt.status)) return;
      if (choices.length) await Tokens.create(choices.map(choice => ({ ...choice, bindingId: binding._id, chatId: binding.chatId,
        sourceChannel: 'telegram',
        telegramUserId: binding.telegramUserId, systemUserId: binding.systemUserId, businessId: binding.businessId,
        conversationId: binding.conversationId, bindingGeneration: binding.bindingGeneration, keyboardRequestKey: receipt.requestKey })), { session, ordered: true });
      await Binding.updateOne({ _id: binding._id }, { $set: { keyboardRequestKey: receipt.requestKey, keyboardClaimKey: null } }, { session });
      await Receipt.updateOne({ _id: receipt._id }, { $set: { status: 'OUTPUT_READY', leaseUntil: new Date(clock() + 120000) } }, { session });
    });
  },
  tokens: requestKey => Tokens.find({ keyboardRequestKey: requestKey }).sort({ position: 1 }).lean(),
  async beginSend(claim, index) {
    return transact(async session => {
      const { receipt } = await owned(claim, session);
      if (receipt.status !== 'OUTPUT_READY' || receipt.sending || receipt.deliveryIndex !== index) fail('TELEGRAM_CLAIM_STALE');
      await Receipt.updateOne({ _id: receipt._id }, { $set: { sending: true, leaseUntil: new Date(clock() + 120000) } }, { session });
    });
  },
  async sent(claim, index, messageId, last) {
    return transact(async session => {
      const { binding, receipt } = await owned(claim, session);
      if (receipt.status !== 'OUTPUT_READY' || !receipt.sending || receipt.deliveryIndex !== index) fail('TELEGRAM_CLAIM_STALE');
      await Receipt.updateOne({ _id: receipt._id }, { $set: { sending: false, deliveryIndex: index + 1,
        deliveredMessageIds: [...receipt.deliveredMessageIds, messageId], ...(last ? { status: 'COMPLETED', resultCode: 'READ_COMPLETED', completedAt: new Date(clock()) } : {}) } }, { session });
      if (last) {
        await Tokens.updateMany({ keyboardRequestKey: receipt.requestKey }, { $set: { messageId } }, { session });
        await Binding.updateOne({ _id: binding._id }, { $set: { activeReceiptId: null } }, { session });
      }
    });
  },
  async reject(claim, code) {
    return transact(async session => {
      const { binding, receipt } = await owned(claim, session, true);
      await Receipt.updateOne({ _id: receipt._id }, { $set: { status: 'FAILED', resultCode: code } }, { session });
      await Binding.updateOne({ _id: binding._id }, { $set: { activeReceiptId: null } }, { session });
    });
  }
  });
};
module.exports = { createTelegramTransportRepository, sameBinding };
