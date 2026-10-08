const mongoose = require('mongoose');
const { isTraceId, CHANNELS, RISK_LEVELS } = require('../automations/contracts');
const schema = new mongoose.Schema({
  pendingActionId: { type: String, required: true, validate: isTraceId }, userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  businessId: { type: String, required: true }, conversationId: { type: String, default: null, validate: value => value === null || isTraceId(value) },
  sourceChannel: { type: String, enum: CHANNELS, required: true }, externalRequestId: { type: String, required: true, validate: isTraceId },
  actionSkillId: { type: String, required: true }, validatedArgs: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  argsHash: { type: String, required: true, immutable: true }, snapshotHash: { type: String, immutable: true },
  summary: { type: String, required: true, maxlength: 250 },
  riskLevel: { type: String, enum: RISK_LEVELS, required: true }, requiresConfirmation: { type: Boolean, required: true },
  expiresAt: { type: Date, required: true }, status: { type: String, enum: ['PENDING', 'CONFIRMED', 'EXECUTED', 'CANCELLED', 'EXPIRED', 'FAILED'], default: 'PENDING' },
  preview: { type: mongoose.Schema.Types.Mixed, required: true }, result: mongoose.Schema.Types.Mixed,
  confirmedAt: Date, executedAt: Date, errorCode: String
}, { timestamps: true, strict: 'throw' });
schema.index({ userId: 1, businessId: 1, pendingActionId: 1 }, { unique: true });
schema.index({ userId: 1, businessId: 1, sourceChannel: 1, externalRequestId: 1 }, { unique: true });
schema.index({ userId: 1, businessId: 1, conversationId: 1, status: 1, createdAt: -1 });
// No TTL deletion: expiration is enforced on confirmation; retain terminal records for audit/idempotency.
module.exports = mongoose.model('PendingAction', schema);
