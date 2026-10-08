const ActionAudit = require('../models/ActionAudit');
const safeAudit = (row, context, status, now, errorCode) => ({
  actionId: row.pendingActionId, skillId: row.actionSkillId, actorType: context.actorType,
  userId: context.userId, businessId: context.businessId, sourceChannel: context.sourceChannel,
  createdAt: row.createdAt, confirmedAt: row.confirmedAt, executedAt: status === 'EXECUTED' ? now : undefined,
  status, ...(errorCode ? { errorCode } : {})
});
const writeAudit = (row, context, status, now, session, errorCode) => ActionAudit.create([safeAudit(row, context, status, now, errorCode)], { session });
module.exports = { safeAudit, writeAudit };
