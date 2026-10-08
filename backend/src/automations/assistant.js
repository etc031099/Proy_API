const { createActionContext, randomUUID, zeroUsage } = require('./contracts');
const { getActionSkill } = require('./skills');
const { performance } = require('node:perf_hooks');
const { actionIntent, parseAction, resolveAction, extractionSchema, validateExtraction } = require('./actionInput');
const { createAgentExecution } = require('../agents/execution');
const { redact } = require('../services/agentHistoryProjection');
const resultAnswer = pending => pending.status !== 'EXECUTED' ? 'Acción cancelada.' : pending.result?.type
  ? `${pending.result.type === 'sale' ? 'Venta' : 'Compra'} registrada correctamente. ${pending.result.items.map(item => `${item.quantity} unidades de ${item.sku}; stock resultante: ${item.stock}`).join('. ')}. Total: ${pending.result.total} ${pending.result.currency}. Operación: ${pending.result.id}.`
  : `Producto registrado correctamente. SKU: ${pending.result?.sku || '—'}. Stock: ${pending.result?.stock ?? '—'}.`;
// Drafts contain only bounded extraction fields, isolated by authenticated user/business/conversation.
// They expire with the pending-action horizon; they never authorize a mutation.
const withActionAssistant = (runtime, service, options = {}) => {
  const drafts = new Map();
  return ({
  ...runtime,
  async handle(req, input) {
    const normalized = input.message.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (const [key, draft] of drafts) if (draft.expiresAt <= Date.now()) drafts.delete(key);
    const draftKey = JSON.stringify([String(req.user?._id), req.businessId, input.conversationId]);
    const previousDraft = /^(?:muestrame|busca|dime|cuanto|que|resume|explica|lista|cuales)\b|[¿?]/.test(normalized)
      && !actionIntent(input.message) ? undefined : drafts.get(draftKey);
    const skillId = actionIntent(input.message) || previousDraft?.action;
    const decision = /^(?:si|confirmar|confirmo|hazlo|no|cancelar|cancelo|no lo hagas)[.!?]*$/.test(normalized);
    if (!skillId && !decision) return runtime.handle(req, input);
    const started = performance.now();
    const conversationId = input.conversationId || randomUUID();
    const context = createActionContext(req, { conversationId });
    let pendingAction, answer, clarification = false, execution;
    if (decision) {
      const pending = await service.resolvePending(context);
      if (!pending) { answer = 'No hay una única acción pendiente. Selecciona Confirmar o Cancelar en su tarjeta.'; clarification = true; }
      else {
        pendingAction = await (/^(si|confirm|hazlo)/.test(normalized) ? service.confirmPendingAction : service.cancelPendingAction)(context, pending.pendingActionId);
        answer = resultAnswer(pendingAction);
      }
    } else {
      const skill = getActionSkill(skillId);
      if (skill.status !== 'READY') answer = 'Esta acción todavía no está habilitada. Utiliza el formulario habitual de ventas o compras; no se realizó ninguna escritura.';
      else {
        let extracted = parseAction(input.message, skillId);
        if (previousDraft && !actionIntent(input.message)) {
          if (skillId === 'create_product') {
            extracted.product = { ...(previousDraft.product || previousDraft.direct), ...extracted.product };
            const missing = skill.inputSchema.required.filter(key => extracted.product[key] === undefined);
            if (missing.length === 1 && !Object.keys(parseAction(input.message, skillId).product || {}).length) {
              const key = missing[0], value = input.message.trim();
              if (['name', 'sku', 'category', 'currency'].includes(key)) extracted.product[key] = key === 'currency' ? value.toUpperCase() : value;
              else if (/^\d+(?:[.,]\d+)?$/.test(value)) extracted.product[key] = Number(value.replace(',', '.'));
            }
          } else {
            const reference = /^(?:SKU|producto|productId)\s*[:=]?\s+(.+)$/i.exec(input.message.trim());
            extracted = { ...previousDraft, ...extracted, items: extracted.items.length ? extracted.items : previousDraft.items,
              paymentMethod: /cr[eé]dito|contado/i.test(input.message) ? extracted.paymentMethod : previousDraft.paymentMethod };
            if (reference && extracted.items?.length === 1) extracted.items = [{ ...extracted.items[0], ref: reference[1] }];
          }
        }
        const unclear = !extracted.direct && (skillId === 'create_product'
          ? !Object.keys(extracted.product || {}).length || ['price', 'stock', 'minStockLevel'].some(key =>
            extracted.product?.[key] === undefined && { price: /precio/, stock: /\bstock\b/, minStockLevel: /minimo/ }[key].test(normalized))
          : !extracted.items?.length);
        if (unclear && !previousDraft) {
          execution = createAgentExecution({ context: context.agentContext, ...(options.onEvent ? { onEvent: options.onEvent } : {}),
            ...(options.provider ? { provider: options.provider } : {}) });
          try {
            const result = await execution.generateStructured({ agentId: 'operations', schema: extractionSchema,
              systemInstruction: 'Extrae solamente campos explícitos de la solicitud. No inventes valores, precios, monedas, clientes ni proveedores. No ejecutes acciones. Respuesta JSON breve.',
              messages: [{ role: 'user', text: redact(input.message) }] });
            extracted = validateExtraction(result.output);
            if (extracted.action !== skillId) require('./contracts').fail('ACTION_VALIDATION_FAILED');
          } finally { execution.finish(); }
        }
        const missing = extracted.direct ? skill.inputSchema.required.filter(key => !Object.hasOwn(extracted.direct, key)) : [];
        const resolved = missing.length ? { clarification: `Para preparar la acción faltan: ${missing.join(', ')}.` }
          : await resolveAction(extracted, context, options.resolver);
        if (resolved.clarification) {
          answer = resolved.clarification; clarification = true;
          if (drafts.size < 1000 || drafts.has(draftKey)) drafts.set(JSON.stringify([context.userId, context.businessId, conversationId]),
            { ...extracted, expiresAt: Date.now() + 600000 });
        }
        else {
          drafts.delete(draftKey);
          pendingAction = await service.prepare({ agentId: 'operations', skillId, args: resolved.args, context, externalRequestId: req.agentActionRequestId || randomUUID() });
          answer = `${pendingAction.summary} Revisa la tarjeta antes de confirmar. La preparación no modifica el inventario.`;
        }
      }
    }
    const realUsage = execution?.getUsage();
    const tokens = zeroUsage();
    const latencyMs = performance.now() - started;
    const participant = { agentId: 'operations', model: null, llmCalls: 0, skillCalls: 0, ...tokens,
      usageAvailable: true, latencyMs, providerLatencyMs: 0 };
    if (realUsage) Object.assign(participant, realUsage.agents.find(agent => agent.agentId === 'operations'));
    return { requestId: context.requestId, conversationId, answer, intent: 'action', agent: 'operations',
      participants: [participant], actions: [], evidence: [], usage: { totalLlmCalls: 0, totalSkillCalls: 0,
        totalInputTokens: 0, totalOutputTokens: 0, totalThoughtTokens: 0, totalCachedInputTokens: 0,
        totalToolUseTokens: 0, totalTokens: 0, metricsComplete: true, totalProviderLatencyMs: 0,
        totalLatencyMs: latencyMs, toolSelectionCycles: 0, agents: [participant], ...(realUsage || {}) },
      requiresClarification: clarification, clarificationQuestion: clarification ? answer : null, latencyMs,
      ...(pendingAction ? { pendingAction } : {}) };
  }
});
};
module.exports = { withActionAssistant, resultAnswer };
