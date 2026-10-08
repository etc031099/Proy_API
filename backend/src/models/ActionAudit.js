const mongoose = require('mongoose');
const { CHANNELS } = require('../automations/contracts');
const schema = new mongoose.Schema({
  actionId: { type: String, required: true }, skillId: { type: String, required: true }, actorType: { type: String, enum: ['USER', 'AUTOMATION', 'SYSTEM'], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true }, businessId: { type: String, required: true },
  sourceChannel: { type: String, enum: CHANNELS, required: true }, createdAt: { type: Date, required: true },
  confirmedAt: Date, executedAt: Date, status: { type: String, enum: ['EXECUTED', 'CANCELLED', 'EXPIRED', 'FAILED'], required: true }, errorCode: String
}, { strict: 'throw' });
schema.index({ businessId: 1, actionId: 1 }, { unique: true });
module.exports = mongoose.model('ActionAudit', schema);
