const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  destinationBusinessId: { type: String, required: true },
  destinationUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
  challengeHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['PENDING', 'USED', 'SUPERSEDED'], default: 'PENDING', required: true },
  confirmedAt: Date,
  sourceConnectionId: mongoose.Schema.Types.ObjectId,
  sourceBusinessId: String,
  auditEvent: { type: String, enum: ['telegram.connection.transferred'] }
}, { timestamps: true, strict: 'throw' });
schema.index({ destinationBusinessId: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' } });
schema.index({ destinationBusinessId: 1, createdAt: 1 });
// Expiry is checked at confirmation; used records remain as sanitized audit/replay history.
module.exports = mongoose.model('TelegramConnectionTransfer', schema);
