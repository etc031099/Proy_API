const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const AutomationRun = require('../models/AutomationRun');
const { createAgentExecution } = require('../agents/execution');
const { AUTOMATION_DEFINITIONS } = require('./definitions');
const { validateTrigger } = require('./triggers');
const { evaluateCondition } = require('./rules');
const { getActionSkill } = require('./skills');
const { createActionService } = require('./execution');
const { assertContext, fail, zeroUsage } = require('./contracts');
const runRepository = {
  async claim(row) { try { return { row: (await AutomationRun.create(row)).toObject(), claimed: true }; }
    catch (error) { if (error.code !== 11000) throw error;
      return { row: await AutomationRun.findOne({ businessId: row.businessId, automationId: row.automationId, eventId: row.eventId }).lean(), claimed: false }; } },
  finish: (row, update) => AutomationRun.updateOne({ _id: row._id, businessId: row.businessId, status: 'RUNNING' }, { $set: update }).exec()
};
const createAutomationEngine = ({ definitions = AUTOMATION_DEFINITIONS, actionService = createActionService(), runs = runRepository,
  readFactory = context => createAgentExecution({ context: context.agentContext }) } = {}) => ({
  async executeAutomation({ definition, trigger, context }) {
    assertContext(context); validateTrigger(trigger, context);
    // Definitions are resolved from a trusted server registry, not supplied by any channel/LLM.
    const selected = definitions.find(row => row.id === definition);
    if (!selected || selected.trigger.type !== trigger.type || selected.trigger.config.name !== trigger.name) fail('ACTION_NOT_ALLOWED');
    const started = performance.now();
    let claim;
    try { claim = await runs.claim({ automationId: selected.id, businessId: context.businessId, userId: context.userId,
      eventId: trigger.eventId, triggerType: trigger.type, triggerSource: trigger.sourceChannel,
      status: 'RUNNING', startedAt: new Date(), agents: [], skills: [], actions: [], llmCalls: 0, providerAttempts: 0, usage: zeroUsage() }); }
    catch { fail('ACTION_EXECUTION_FAILED'); }
    const { row, claimed } = claim;
    if (!claimed) return { status: row.status, alreadyProcessed: true, usage: zeroUsage() };
    const skills = [], actions = []; let status = 'SKIPPED', errorCode;
    try {
      if (selected.enabled) {
        if (selected.reads.length !== 1 || selected.reads.length > selected.riskPolicy.maxReadCalls || selected.actions.length !== 1
          || !Number.isSafeInteger(selected.riskPolicy.maxActionCalls) || selected.riskPolicy.maxActionCalls < 0
          || selected.riskPolicy.maxActionCalls > 3) fail('ACTION_NOT_ALLOWED');
        const read = readFactory(context);
        let result;
        try { for (const invocation of selected.reads) { const output = await read.runAgent(invocation.agentId,
          () => read.executeSkill(invocation)); result = output; skills.push(invocation.skillId); } }
        finally { read.finish(); }
        if (selected.conditions.every(condition => evaluateCondition(condition, result))) {
          const action = selected.actions[0], skill = getActionSkill(action.skillId);
          if (action.agentId !== 'operations' || skill.id !== 'create_inventory_alert' || skill.requiresConfirmation || skill.status !== 'READY'
            || !selected.riskPolicy.allowedRiskLevels.includes(skill.riskLevel)) fail('ACTION_NOT_ALLOWED');
          for (const product of result.data.slice(0, Math.min(3, selected.riskPolicy.maxActionCalls))) {
            const output = await actionService.prepare({ agentId: action.agentId, skillId: skill.id, context, externalRequestId: randomUUID(),
              args: { type: 'LOW_STOCK', productId: product.id, label: 'Stock bajo detectado mediante skill verificada.' } });
            actions.push(output.pendingActionId);
          }
          status = 'SUCCEEDED';
        }
      }
    } catch { status = actions.length ? 'PARTIAL' : 'FAILED'; errorCode = 'ACTION_EXECUTION_FAILED'; }
    const safe = { status, finishedAt: new Date(), agents: skills.length ? ['operations'] : [], skills, actions, llmCalls: 0,
      providerAttempts: 0, usage: zeroUsage(), latencyMs: performance.now() - started,
      resultSummary: `${actions.length} alertas internas registradas.`, ...(errorCode ? { errorCode } : {}) };
    try { await runs.finish(row, safe); } catch { fail('ACTION_EXECUTION_FAILED'); } return safe;
  }
});
module.exports = { createAutomationEngine };
