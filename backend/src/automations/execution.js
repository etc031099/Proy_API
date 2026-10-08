const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { randomUUID, isTraceId, PENDING_TTL_MS, scopeOf, bindingOf, fail, zeroUsage, deepFreeze, ActionError } = require('./contracts');
const { validateActionInvocation } = require('./skills');
const { createActionExecutors } = require('./executors');
const { createActionRepository } = require('./repository');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hashArgs = args => createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex');
const view = row => ({ pendingActionId: row.pendingActionId, action: row.actionSkillId, summary: row.summary,
  fields: row.preview.fields, expiresAt: new Date(row.expiresAt).toISOString(), requiresConfirmation: row.requiresConfirmation, status: row.status,
  ...(row.status === 'EXECUTED' ? { result: row.result } : {}), usage: zeroUsage() });
const createActionService = ({ repository = createActionRepository(), executors = createActionExecutors(), clock = () => new Date() } = {}) => {
  const transition = async (context, id, decision, confirmedByHuman = false) => {
    scopeOf(context); if (!isTraceId(id)) fail('ACTION_VALIDATION_FAILED');
    await repository.checkConversation(context);
    const started = performance.now();
    const row = await repository.transition(context, id, decision, clock, async (stored, session) => {
      const { skill, args } = validateActionInvocation({ agentId: 'operations', skillId: stored.actionSkillId, args: stored.validatedArgs, context });
      if (hashArgs(args) !== stored.argsHash) fail('ACTION_CONFLICT');
      if (skill.requiresConfirmation && (!confirmedByHuman || context.actorType !== 'USER')) fail('ACTION_CONFIRMATION_REQUIRED');
      if (!executors[skill.id]) fail('ACTION_NOT_ALLOWED');
      const result = await executors[skill.id].execute(deepFreeze(structuredClone(args)), context, session, stored.pendingActionId);
      // Do not use Promise.race for writes: a timed-out promise could still commit a mutation.
      // This deadline is checked before the atomic commit and rolls back late work.
      if (performance.now() - started > skill.timeoutMs) fail('ACTION_EXECUTION_FAILED');
      return result;
    });
    if (row.status === 'EXPIRED') fail('ACTION_EXPIRED');
    return { ...view(row), latencyMs: performance.now() - started };
  };
  const service = {
    async prepare({ agentId = 'operations', skillId, args, context, externalRequestId }) {
      if (!isTraceId(externalRequestId)) fail('ACTION_VALIDATION_FAILED');
      const validated = validateActionInvocation({ agentId, skillId, args, context });
      const executor = executors[skillId]; if (!executor) fail('ACTION_NOT_ALLOWED');
      await repository.checkConversation(context);
      const safeArgs = deepFreeze(structuredClone(validated.args));
      const existing = await repository.findExternal(context, externalRequestId);
      if (existing) {
        if (existing.actionSkillId !== skillId || existing.argsHash !== hashArgs(safeArgs)) fail('ACTION_CONFLICT');
        return validated.skill.requiresConfirmation ? view(existing) : transition(context, existing.pendingActionId, 'confirm');
      }
      const preview = await executor.preview(safeArgs, context);
      const row = await repository.insert(context, { ...scopeOf(context), ...bindingOf(context), pendingActionId: randomUUID(), externalRequestId,
        actionSkillId: skillId, validatedArgs: safeArgs, argsHash: hashArgs(safeArgs), summary: preview.summary, preview,
        riskLevel: validated.skill.riskLevel, requiresConfirmation: validated.skill.requiresConfirmation,
        status: 'PENDING', createdAt: clock(), expiresAt: new Date(clock().getTime() + PENDING_TTL_MS) });
      if (!row || row.actionSkillId !== skillId || row.argsHash !== hashArgs(safeArgs)) fail('ACTION_CONFLICT');
      return validated.skill.requiresConfirmation ? view(row) : transition(context, row.pendingActionId, 'confirm');
    },
    confirmPendingAction: (context, id) => transition(context, id, 'confirm', true),
    cancelPendingAction: (context, id) => transition(context, id, 'cancel'),
    async get(context, id) { scopeOf(context); if (!isTraceId(id)) fail('ACTION_VALIDATION_FAILED'); const row = await repository.get(context, id); if (!row) fail('ACTION_NOT_ALLOWED'); return view(row); },
    async resolvePending(context) { scopeOf(context); const rows = await repository.recent(context); return rows.length === 1 ? view(rows[0]) : null; }
  };
  // Channel adapters receive only domain errors, never raw database/provider failures.
  return Object.freeze(Object.fromEntries(Object.entries(service).map(([name, operation]) => [name, async (...args) => {
    try { return await operation(...args); } catch (error) { if (error instanceof ActionError) throw error; fail('ACTION_EXECUTION_FAILED'); }
  }])));
};
module.exports = { createActionService, hashArgs, view };
