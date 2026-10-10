const { createHash, randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const Transfer = require('../models/TelegramConnectionTransfer');
const Connection = require('../models/TelegramConnection');
const User = require('../models/User');
const TTL_MS = 10 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error('Telegram recovery unavailable'), { code });

// Only a validated private-chat update from server-side getUpdates calls confirm.
// Bounded process-local throttles complement a 64-bit challenge and durable generation limits.
const createAttemptLimiter = (clock = () => new Date()) => {
  const chats = new Map(); let minute = 0, total = 0;
  return chatId => {
    const now = clock().getTime(), key = hash(chatId);
    if (now - minute >= 60000) { minute = now; total = 0; }
    if (++total > 100) return false;
    for (const [id, row] of chats) if (row.expiresAt <= now) chats.delete(id);
    let row = chats.get(key);
    if (!row) {
      if (chats.size >= 2000) return false;
      row = { count: 0, expiresAt: now + TTL_MS }; chats.set(key, row);
    }
    return ++row.count <= 5;
  };
};

const repository = {
  async transaction(operation) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5000 });
      const result = await operation(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      throw error;
    } finally { await session.endSession(); }
  },
  owner: (businessId, userId, session) => User.exists({ _id: userId, businessId, isActive: true }).session(session),
  connection: (query, session) => Connection.findOne(query).session(session).lean().exec(),
  recent: (businessId, since, session) => Transfer.countDocuments({ destinationBusinessId: businessId, createdAt: { $gte: since } }).session(session),
  supersede: (businessId, session) => Transfer.updateMany({ destinationBusinessId: businessId, status: 'PENDING' }, { $set: { status: 'SUPERSEDED' } }, { session }),
  insert: (row, session) => Transfer.create([row], { session }),
  challenge: (challengeHash, session) => Transfer.findOne({ challengeHash }).session(session).lean().exec(),
  release: (row, session) => Connection.updateOne({ _id: row._id, businessId: row.businessId, chatId: row.chatId },
    { $unset: { chatId: 1, connectionCodeHash: 1, connectionCodeExpiresAt: 1 } }, { session }),
  assign: (businessId, chatId, session) => Connection.findOneAndUpdate({ businessId },
    { $set: { chatId, enabled: true }, $unset: { connectionCodeHash: 1, connectionCodeExpiresAt: 1 } },
    { session, upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }),
  consume: (row, source, now, session) => Transfer.updateOne({ _id: row._id, status: 'PENDING' }, { $set: {
    status: 'USED', confirmedAt: now, auditEvent: 'telegram.connection.transferred',
    ...(source ? { sourceConnectionId: source._id, sourceBusinessId: source.businessId } : {})
  } }, { session })
};
const createTelegramRecovery = ({ repo = repository, clock = () => new Date(), allowAttempt = createAttemptLimiter(clock),
  audit = event => console.info('[TelegramRecovery]', JSON.stringify(event)) } = {}) => ({
  async initiate({ businessId, userId }) {
    const now = clock(), code = `TRF-${randomBytes(8).toString('hex').toUpperCase()}`;
    const expiresAt = new Date(now.getTime() + TTL_MS);
    try {
      await repo.transaction(async session => {
        if (!await repo.owner(businessId, userId, session)) throw failure('TELEGRAM_RECOVERY_FORBIDDEN');
        if ((await repo.connection({ businessId }, session))?.chatId) throw failure('TELEGRAM_DESTINATION_CONNECTED');
        if (await repo.recent(businessId, new Date(now.getTime() - TTL_MS), session) >= 3) throw failure('TELEGRAM_RECOVERY_RATE_LIMITED');
        await repo.supersede(businessId, session);
        await repo.insert({ destinationBusinessId: businessId, destinationUserId: userId, challengeHash: hash(code),
          expiresAt, createdAt: now, status: 'PENDING' }, session);
      });
      return { code, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      if (error.code === 11000 || error.code === 112) throw failure('TELEGRAM_RECOVERY_CONFLICT');
      if (typeof error.code === 'string' && error.code.startsWith('TELEGRAM_')) throw error;
      throw failure('TELEGRAM_RECOVERY_UNAVAILABLE');
    }
  },
  async confirm(code, chatId) {
    if (typeof chatId !== 'string' || !/^[1-9]\d{0,15}$/.test(chatId)) return { status: 'INVALID' };
    if (!allowAttempt(chatId)) return { status: 'RATE_LIMITED' };
    if (typeof code !== 'string' || !/^TRF-[A-F0-9]{16}$/.test(code)) return { status: 'INVALID' };
    let auditEvent;
    try {
      const result = await repo.transaction(async session => {
        const row = await repo.challenge(hash(code), session);
        if (!row || row.status === 'SUPERSEDED') return { status: 'INVALID' };
        if (row.status === 'USED') return { status: 'USED' };
        const now = clock();
        if (row.expiresAt <= now) return { status: 'EXPIRED' };
        if (!await repo.owner(row.destinationBusinessId, row.destinationUserId, session)) return { status: 'INVALID' };
        const destination = await repo.connection({ businessId: row.destinationBusinessId }, session);
        if (destination?.chatId && destination.chatId !== chatId) return { status: 'DESTINATION_CONNECTED' };
        const source = await repo.connection({ chatId }, session);
        if (source && source.businessId !== row.destinationBusinessId) await repo.release(source, session);
        await repo.assign(row.destinationBusinessId, chatId, session);
        await repo.consume(row, source, now, session);
        auditEvent = { event: 'telegram.connection.transferred', sourceBusinessId: source?.businessId || null,
          destinationBusinessId: row.destinationBusinessId, actorUserId: String(row.destinationUserId), timestamp: now.toISOString() };
        return { status: source?.businessId === row.destinationBusinessId ? 'ALREADY_CONNECTED' : 'CONNECTED' };
      });
      if (auditEvent) { try { audit(auditEvent); } catch { /* Persisted audit is authoritative. */ } }
      return result;
    } catch (error) {
      return { status: error.code === 11000 || error.code === 112 ? 'CONFLICT' : 'UNAVAILABLE' };
    }
  }
});
const telegramRecovery = createTelegramRecovery();
module.exports = { createTelegramRecovery, telegramRecovery, createAttemptLimiter, repository, TTL_MS, hash };
