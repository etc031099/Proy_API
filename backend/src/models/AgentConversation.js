const mongoose = require('mongoose');
const { isTraceId } = require('../agents/contracts');

const schema = new mongoose.Schema({
  conversationId: { type: String, required: true, validate: isTraceId },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  businessId: { type: String, required: true, maxlength: 50 },
  title: { type: String, required: true, maxlength: 60 },
  lastMessageAt: { type: Date, required: true },
  messageCount: { type: Number, default: 0, min: 0, max: 400 },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  lastIntent: { type: String, maxlength: 40 },
  lastAgent: { type: String, enum: ['coordinator', 'operations', 'analyst'] },
  // Written only through the compact memory projection, never chat text or skill DTOs.
  contextSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, strict: 'throw' });
schema.index({ userId: 1, businessId: 1, conversationId: 1 }, { unique: true });
schema.index({ userId: 1, businessId: 1, lastMessageAt: -1, _id: -1 });
module.exports = mongoose.model('AgentConversation', schema);
