const mongoose = require('mongoose');
const PendingAction = require('../models/PendingAction');
const Conversation = require('../models/AgentConversation');
const { scopeOf, bindingOf, fail, ActionError } = require('./contracts');
const { writeAudit } = require('./audit');
const filterFor = context => ({ ...scopeOf(context), ...bindingOf(context) });
const atomic = async (operation, startSession = () => mongoose.startSession()) => {
  const session = await startSession();
  try { session.startTransaction({ maxCommitTimeMS: 10000 }); const result = await operation(session); await session.commitTransaction(); return result; }
  catch (error) { if (session.inTransaction()) { try { await session.abortTransaction(); } catch { /* Preserve uncertain-commit classification. */ } } throw error; }
  finally { try { await session.endSession(); } catch { /* Cleanup must not overwrite a committed result. */ } }
};
const createActionRepository = ({ pendingModel = PendingAction, conversationModel = Conversation,
  startSession = () => mongoose.startSession(), audit = writeAudit } = {}) => {
  const PendingAction = pendingModel, Conversation = conversationModel;
  const transaction = operation => atomic(operation, startSession);
  return ({
  async checkConversation(context) {
    if (context.conversationId && !await Conversation.exists({ ...scopeOf(context), conversationId: context.conversationId, status: 'active' }).maxTimeMS(5000)) fail('ACTION_NOT_ALLOWED');
  },
  get: (context, id) => PendingAction.findOne({ ...filterFor(context), pendingActionId: id }).lean().maxTimeMS(5000).exec(),
  findExternal: (context, externalRequestId) => PendingAction.findOne({ ...filterFor(context), externalRequestId }).lean().maxTimeMS(5000).exec(),
  recent: context => PendingAction.find({ ...filterFor(context), status: 'PENDING', expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 }).limit(2).lean().maxTimeMS(5000).exec(),
  async insert(context, row) {
    try { return (await PendingAction.create(row)).toObject(); }
    catch (error) {
      if (error.code !== 11000) throw error;
      return PendingAction.findOne({ ...filterFor(context), externalRequestId: row.externalRequestId }).lean().maxTimeMS(5000).exec();
    }
  },
  async transition(context, id, decision, clock, execute) {
    try {
      return await transaction(async session => {
        const row = await PendingAction.findOne({ ...filterFor(context), pendingActionId: id }).session(session).maxTimeMS(5000);
        if (!row) fail('ACTION_NOT_ALLOWED');
        if (row.status === 'EXECUTED') { if (decision !== 'confirm') fail('ACTION_ALREADY_EXECUTED'); return row.toObject(); }
        if (row.status === 'CANCELLED') fail('ACTION_CANCELLED');
        if (row.status === 'EXPIRED') fail('ACTION_EXPIRED');
        if (row.status !== 'PENDING') fail('ACTION_CONFLICT');
        const now = clock();
        if (row.expiresAt <= now) row.status = 'EXPIRED';
        else if (decision === 'cancel') row.status = 'CANCELLED';
        else {
          row.status = 'CONFIRMED'; row.confirmedAt = row.requiresConfirmation ? now : undefined;
          await row.save({ session });
          row.result = await execute(row.toObject(), session);
          row.executedAt = clock(); row.status = 'EXECUTED';
        }
        await row.save({ session });
        await audit(row, context, row.status, clock(), session);
        return row.toObject();
      });
    } catch (error) {
      // Never retry a write automatically; uncertain commits require a status lookup/repeated confirm.
      if ([112, 251].includes(error.code) || error.hasErrorLabel?.('UnknownTransactionCommitResult')
        || error.hasErrorLabel?.('TransientTransactionError')) fail('ACTION_CONFLICT');
      if (error instanceof ActionError && ['ACTION_NOT_ALLOWED', 'ACTION_CANCELLED', 'ACTION_EXPIRED', 'ACTION_CONFLICT', 'ACTION_ALREADY_EXECUTED'].includes(error.code)) throw error;
      const code = error instanceof ActionError ? error.code : error.code === 11000 ? 'ACTION_CONFLICT' : 'ACTION_EXECUTION_FAILED';
      // Business writes were rolled back. A separate short unit records a safe failure, fail-closed if audit is unavailable.
      try { await transaction(async session => {
        const row = await PendingAction.findOne({ ...filterFor(context), pendingActionId: id, status: 'PENDING' }).session(session);
        if (!row) return; row.status = 'FAILED'; row.errorCode = code; await row.save({ session });
        await audit(row, context, 'FAILED', clock(), session, code);
      }); } catch { /* No raw database error is logged or exposed. */ }
      fail(code);
    }
  }
});
};
module.exports = { createActionRepository, atomic };
