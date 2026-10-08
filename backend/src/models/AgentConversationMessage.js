const mongoose = require('mongoose');
const { isTraceId } = require('../agents/contracts');

const schema = new mongoose.Schema({
  conversationId: { type: String, required: true, validate: isTraceId },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  businessId: { type: String, required: true, maxlength: 50 },
  requestKey: { type: String, required: true, validate: isTraceId },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, required: true, maxlength: 20000 },
  status: { type: String, enum: ['pending', 'completed', 'failed'], required: true },
  // Allowlisted public response only. No provider request/response or raw DTOs.
  response: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, required: true }
}, { strict: 'throw' });
schema.index({ userId: 1, businessId: 1, requestKey: 1, role: 1 }, { unique: true });
schema.index({ userId: 1, businessId: 1, conversationId: 1, createdAt: -1, _id: -1 });
module.exports = mongoose.model('AgentConversationMessage', schema);
