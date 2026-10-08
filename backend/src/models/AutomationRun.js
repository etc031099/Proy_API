const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  automationId: { type: String, required: true }, businessId: { type: String, required: true }, eventId: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true }, triggerType: { type: String, enum: ['EVENT', 'SCHEDULE', 'CONDITION', 'MANUAL'], required: true },
  triggerSource: { type: String, required: true }, status: { type: String, enum: ['RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'SKIPPED'], required: true },
  startedAt: { type: Date, required: true }, finishedAt: Date, agents: [String], skills: [String], actions: [String],
  llmCalls: { type: Number, default: 0 }, providerAttempts: { type: Number, default: 0 }, usage: mongoose.Schema.Types.Mixed,
  latencyMs: Number, resultSummary: { type: String, maxlength: 250 }, errorCode: String
}, { strict: 'throw' });
schema.index({ businessId: 1, automationId: 1, eventId: 1 }, { unique: true });
schema.index({ businessId: 1, startedAt: -1 });
module.exports = mongoose.model('AutomationRun', schema);
