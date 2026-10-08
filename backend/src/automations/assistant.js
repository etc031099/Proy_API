const { createActionContext, randomUUID, zeroUsage } = require('./contracts');
const { getActionSkill } = require('./skills');
const { performance } = require('node:perf_hooks');
// Explicit structured commands only; free-form requests never authorize a write.
const withActionAssistant = (runtime, service) => ({
  ...runtime,
  async handle(req, input) {
    const normalized = input.message.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const match = /^(?:crea(?:r)?(?: un)? producto|registra(?:r)?(?: una)? (?:venta|compra))\b/.exec(normalized);
    const decision = /^(?:si|confirmar|confirmo|no|cancelar|cancelo)[.!?]*$/.test(normalized);
    if (!match && !decision) return runtime.handle(req, input);
    const started = performance.now();
    const conversationId = input.conversationId || randomUUID();
    const context = createActionContext(req, { conversationId });
    let pendingAction, answer, clarification = false;
    if (decision) {
      const pending = await service.resolvePending(context);
      if (!pending) { answer = 'No hay una única acción pendiente. Selecciona Confirmar o Cancelar en su tarjeta.'; clarification = true; }
      else {
        pendingAction = await (/^(si|confirm)/.test(normalized) ? service.confirmPendingAction : service.cancelPendingAction)(context, pending.pendingActionId);
        answer = pendingAction.status === 'EXECUTED' ? 'Acción ejecutada y auditada.' : 'Acción cancelada.';
      }
    } else {
      const skillId = /producto$/.test(match[0]) ? 'create_product' : /venta$/.test(match[0]) ? 'create_sale' : 'create_purchase';
      const skill = getActionSkill(skillId);
      if (skill.status !== 'READY') answer = 'Esta acción todavía no está habilitada. Utiliza el formulario habitual de ventas o compras; no se realizó ninguna escritura.';
      else {
        let args;
        try { args = JSON.parse(input.message.slice(match[0].length).trim()); } catch { /* Ask for structured fields, never infer prices or stock. */ }
        const missing = skill.inputSchema.required.filter(key => !args || !Object.hasOwn(args, key));
        if (missing.length) { answer = `Para preparar el producto faltan: ${missing.join(', ')}. Envía Crear producto seguido de un objeto JSON con esos campos.`; clarification = true; }
        else {
          pendingAction = await service.prepare({ agentId: 'operations', skillId, args, context, externalRequestId: req.agentActionRequestId || randomUUID() });
          answer = `${pendingAction.summary} Revisa la tarjeta antes de confirmar. La preparación no modifica el inventario.`;
        }
      }
    }
    const tokens = zeroUsage();
    const latencyMs = performance.now() - started;
    const participant = { agentId: 'operations', model: null, llmCalls: 0, skillCalls: 0, ...tokens,
      usageAvailable: true, latencyMs, providerLatencyMs: 0 };
    return { requestId: context.requestId, conversationId, answer, intent: 'action', agent: 'operations',
      participants: [participant], actions: [], evidence: [], usage: { totalLlmCalls: 0, totalSkillCalls: 0,
        totalInputTokens: 0, totalOutputTokens: 0, totalThoughtTokens: 0, totalCachedInputTokens: 0,
        totalToolUseTokens: 0, totalTokens: 0, metricsComplete: true, totalProviderLatencyMs: 0,
        totalLatencyMs: latencyMs, toolSelectionCycles: 0, agents: [participant] },
      requiresClarification: clarification, clarificationQuestion: clarification ? answer : null, latencyMs,
      ...(pendingAction ? { pendingAction } : {}) };
  }
});
module.exports = { withActionAssistant };
