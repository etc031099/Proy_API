const mongoose = require('mongoose');
const Conversation = require('../models/AgentConversation');
const Message = require('../models/AgentConversationMessage');
const error = code => Object.assign(new Error(code), { code });
const SUMMARY = 'conversationId title lastMessageAt messageCount status createdAt updatedAt';
const responseRoom = { $lt: [{ $add: [{ $ifNull: ['$messageCount', 0] }, { $ifNull: ['$queuedResponseCount', 0] }] }, 399] };

// Short atomic database units only: never hold a Mongo transaction during Gemini/skills.
const transaction = async operation => {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => operation(session)); }
  finally { await session.endSession(); }
};
const createAgentHistoryRepository = () => ({
  ensureConversation: (scope, conversationId, session) => Conversation.findOneAndUpdate({ ...scope, conversationId },
    { $setOnInsert: { ...scope, conversationId, title: 'Consulta por Telegram', lastMessageAt: new Date(), status: 'active' } },
    { upsert: true, new: true, session }).exec(),
  findConversation: (scope, conversationId) => Conversation.findOne({ ...scope, conversationId, status: 'active' }).lean().exec(),
  findRequest: (scope, requestKey, role) => Message.findOne({ ...scope, requestKey, role }).lean().exec(),
  async enqueue(scope, conversationId, message, requestKey, session) {
    const changed = await Conversation.updateOne({ ...scope, conversationId, status: 'active', messageCount: { $lt: 399 }, $expr: responseRoom },
      { $inc: { messageCount: 1, queuedResponseCount: 1 }, $set: { lastMessageAt: new Date() } }, { session });
    if (!changed.matchedCount) throw error('AGENT_HISTORY_LIMIT');
    await Message.create([{ ...scope, conversationId, requestKey, role: 'user', text: message, status: 'queued' }], { session });
  },
  startQueued: (scope, requestKey) => Message.updateOne({ ...scope, requestKey, role: 'user', status: 'queued' }, { $set: { status: 'pending' } }).exec(),
  async begin(scope, conversationId, message, requestKey, title, isNew) {
    return transaction(async session => {
      if (isNew) await Conversation.create([{ ...scope, conversationId, title, lastMessageAt: new Date() }], { session });
      const changed = await Conversation.updateOne({ ...scope, conversationId, status: 'active', messageCount: { $lt: 399 }, $expr: responseRoom },
        { $inc: { messageCount: 1 }, $set: { lastMessageAt: new Date() } }, { session });
      if (!changed.matchedCount) throw error('AGENT_HISTORY_LIMIT');
      const [user] = await Message.create([{ ...scope, conversationId, requestKey, role: 'user', text: message, status: 'pending' }], { session });
      return user.toObject();
    });
  },
  async complete(scope, conversationId, requestKey, response, contextSnapshot, reservedResponse = false) {
    return transaction(async session => {
      const changed = await Conversation.updateOne({ ...scope, conversationId, status: 'active' }, { $inc: { messageCount: 1, ...(reservedResponse ? { queuedResponseCount: -1 } : {}) },
        $set: { lastMessageAt: new Date(), lastIntent: response.intent, lastAgent: response.agent, contextSnapshot } }, { session });
      if (!changed.matchedCount) throw error('AGENT_CONVERSATION_NOT_FOUND');
      await Message.create([{ ...scope, conversationId, requestKey, role: 'assistant', text: response.answer, response, status: 'completed' }], { session });
      await Message.updateOne({ ...scope, conversationId, requestKey, role: 'user' }, { $set: { status: 'completed' } }, { session });
    });
  },
  fail: (scope, requestKey, reservedResponse = false) => !reservedResponse
    ? Message.updateOne({ ...scope, requestKey, role: 'user' }, { $set: { status: 'failed' } }).exec()
    : transaction(async session => {
      const row = await Message.findOne({ ...scope, requestKey, role: 'user', status: 'pending' }).session(session).lean();
      if (!row) return;
      await Message.updateOne({ ...scope, requestKey, role: 'user', status: 'pending' }, { $set: { status: 'failed' } }, { session });
      await Conversation.updateOne({ ...scope, conversationId: row.conversationId, queuedResponseCount: { $gt: 0 } }, { $inc: { queuedResponseCount: -1 } }, { session });
    }),
  retry: (scope, requestKey) => Message.updateOne({ ...scope, requestKey, role: 'user', status: 'failed' }, { $set: { status: 'pending' } }).exec(),
  async list(scope, page, limit) {
    const filter = { ...scope, status: 'active' };
    const total = await Conversation.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    page = Math.min(page, totalPages);
    const items = await Conversation.find(filter).select(SUMMARY).sort({ lastMessageAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean();
    return { items, pagination: { page, limit, total, totalPages } };
  },
  async messages(scope, conversationId, page, limit) {
    const filter = { ...scope, conversationId };
    const total = await Message.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    page = Math.min(page, totalPages);
    const messages = await Message.find(filter).select('role text status createdAt response').sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit).lean();
    return { messages: messages.reverse(), pagination: { page, limit, total, totalPages } };
  },
  async remove(scope, conversationId) {
    return transaction(async session => {
      const removed = await Conversation.deleteOne({ ...scope, conversationId, status: 'active' }, { session });
      if (!removed.deletedCount) throw error('AGENT_CONVERSATION_NOT_FOUND');
      await Message.deleteMany({ ...scope, conversationId }, { session });
    });
  }
});
module.exports = { createAgentHistoryRepository };
