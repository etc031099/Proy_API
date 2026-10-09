const { createActionContext, randomUUID, zeroUsage } = require('./contracts');
const { performance } = require('node:perf_hooks');
const { actionIntent, parseAction, extractionSchema, validateExtraction } = require('./actionInput');
const { createAgentExecution } = require('../agents/execution');
const { redact } = require('../services/agentHistoryProjection');
const { compactDraft, updateDraft, resolveDraft, applyResolution, TTL_MS } = require('./operationDraft');
const { resolveReference, configuredSuppliers } = require('./entityResolution');
const { Product } = require('../models');
const resultAnswer = pending => pending.status !== 'EXECUTED' ? 'Acción cancelada.' : pending.result?.type
  ? `${pending.result.type === 'sale' ? 'Venta' : 'Compra'} registrada correctamente. ${pending.result.items.map(item => `${item.quantity} unidades de ${item.sku}; stock resultante: ${item.stock}`).join('. ')}. Total: ${pending.result.total} ${pending.result.currency}. Operación: ${pending.result.id}.`
  : `Producto registrado correctamente. SKU: ${pending.result?.sku || '—'}. Stock: ${pending.result?.stock ?? '—'}.${pending.result?.needsSupplierSetup ? ' Todavía no tiene proveedor con precio de compra; configúralo desde Productos antes de registrar compras.' : ''}`;
// Bounded draft slots never authorize writes. Restored candidate IDs are looked up
// again before preparation. A separate per-conversation queue serialises updates.
const withActionAssistant = (runtime, service, options = {}) => {
  const drafts = new Map(), locks = new Map(), now = options.clock || Date.now;
  const keyFor = (req, id) => JSON.stringify([String(req.user?._id), req.businessId, id]);
  async function handle(req, input) {
    const normalized = input.message.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^[¿¡]/, '').replace(/[?!.]$/, '');
    for (const [key, draft] of drafts) if (draft.expiresAt <= now()) drafts.delete(key);
    const draftKey = keyFor(req, input.conversationId);
    let previous = drafts.get(draftKey);
    const explicit = actionIntent(input.message);
    const contextual = (previous?.selection?.slot === 'product' && /^busca(?:r)?\b/.test(normalized)) || /que me falta|que datos|que proveedores|^(?:mejor|cambia|en vez|no es|opcion|el |la |si\b|no\b|cancel|confirm|hazlo|crear proveedor|elegir proveedor|continuar sin)/.test(normalized)
      || /^(?:\d+|sku\b|proveedor\b|precio de compra\b|categoria\b)/.test(normalized);
    if (previous && !explicit && !contextual && /^(?:muestrame|busca|dime|cuanto|que|resume|explica|lista|cuales)\b|[¿?]/.test(normalized)) previous = undefined;
    const skillId = explicit || previous?.action;
    const decision = /^(?:si|confirmar|confirmo|hazlo|no|cancelar|cancelo|no lo hagas|mejor cancela eso)[.!?]*$/.test(normalized);
    const candidateCommand = /^(?:ver mas|siguiente|anterior|anteriores|refinar busqueda|mas especifico)$/.test(normalized);
    // Read-only ML paging is not an operation-draft command. Active drafts keep
    // their existing selection flow; do not prepare/cancel a write for analytics.
    if (!previous && candidateCommand && input.conversationId) {
      const state = await runtime.getContextSnapshot?.(req, input.conversationId);
      if (state?.lastForecastAnalytics) return runtime.handle(req, input);
    }
    if (!skillId && !decision && !candidateCommand) return runtime.handle(req, input);
    const started = performance.now(), conversationId = input.conversationId || randomUUID();
    const context = createActionContext(req, { conversationId }), key = keyFor(req, conversationId);
    let pendingAction, answer, clarification = false, execution, suggestions = [], suggestionsExpiresAt, suggestionsPagination;
    if (!previous && candidateCommand) return response('No hay una búsqueda de productos vigente. Inicia nuevamente la operación.', undefined, true);
    if (previous?.items && /que proveedores/.test(normalized)) {
      const products = [];
      for (const item of previous.items) {
        const result = await (options.resolver || resolveReference)(Product, context, item.ref);
        if (!result.value) return response('Primero elige el producto para consultar sus proveedores.', undefined, true);
        products.push(result.value);
      }
      const suppliers = await (options.supplierLookup || configuredSuppliers)(products, context);
      const labels = suppliers.map(row => `${row.name}${row.costs ? `: ${row.costs.map(cost => `${cost.purchasePrice} ${cost.currency}`).join(', ')}` : ''}`);
      return response(labels.length ? `Proveedores configurados: ${labels.join('; ')}. Tu borrador sigue disponible.`
        : 'No hay proveedor común con precio de compra configurado. Tu borrador sigue disponible; configúralo desde Productos o cancela.', undefined, true);
    }
    if (decision && (!previous || previous.pendingActionId || /^(no|cancel|mejor cancela)/.test(normalized))) {
      if (previous && !previous.pendingActionId) { drafts.delete(key); answer = 'Borrador cancelado. No se guardó ninguna operación.'; }
      else {
        const pending = await service.resolvePending(context);
        if (!pending) { answer = 'No hay una única acción pendiente. Selecciona Confirmar o Cancelar en su tarjeta.'; clarification = true; }
        else {
          pendingAction = await (/^(si|confirm|hazlo)/.test(normalized) ? service.confirmPendingAction : service.cancelPendingAction)(context, pending.pendingActionId);
          answer = resultAnswer(pendingAction); drafts.delete(key);
        }
      }
    } else {
      if (previous?.pendingActionId) {
        const stored = await service.get(context, previous.pendingActionId);
        if (stored.status !== 'PENDING') {
          drafts.delete(key);
          if (!explicit) return response('Esa acción ya terminó o venció. Inicia una nueva operación para modificarla.', stored, true);
          previous = undefined;
        } else {
          if (/que me falta|que datos/.test(normalized)) return response('La operación está completa. Revisa la tarjeta antes de confirmar.', stored, true);
          await service.cancelPendingAction(context, previous.pendingActionId);
          delete previous.pendingActionId;
        }
      }
      let extracted = parseAction(input.message, skillId);
      const unclear = !previous && !extracted.direct && (skillId === 'create_product' ? !Object.keys(extracted.product || {}).length
        : !extracted.items?.length || (!extracted.items[0].quantity && /\b(?:tres|dos|cinco)\s+botellas/.test(normalized)));
      if (unclear) {
        execution = createAgentExecution({ context: context.agentContext, ...(options.onEvent ? { onEvent: options.onEvent } : {}), ...(options.provider ? { provider: options.provider } : {}) });
        try {
          const result = await execution.generateStructured({ agentId: 'operations', schema: extractionSchema,
            systemInstruction: 'Extrae solamente campos explícitos. No inventes valores, precios, monedas, clientes ni proveedores. No ejecutes acciones. JSON breve.',
            messages: [{ role: 'user', text: redact(input.message) }] });
          extracted = validateExtraction(result.output);
          if (extracted.action !== skillId) require('./contracts').fail('ACTION_VALIDATION_FAILED');
        } finally { execution.finish(); }
      }
      const draft = updateDraft(explicit ? undefined : previous, extracted, input.message);
      if (extracted.direct && (explicit || !previous)) draft.direct = extracted.direct;
      const resolved = applyResolution(draft, await resolveDraft(draft, context, options), now());
      suggestions = resolved.suggestions || [];
      suggestionsPagination = resolved.suggestionsPagination;
      if (resolved.clarification) { answer = resolved.clarification; clarification = true; }
      else {
        pendingAction = await service.prepare({ agentId: 'operations', skillId, args: resolved.args, context, externalRequestId: req.agentActionRequestId || randomUUID() });
        draft.pendingActionId = pendingAction.pendingActionId;
        answer = `${pendingAction.summary} Revisa la tarjeta antes de confirmar. La preparación no modifica el inventario.`;
      }
      draft.updatedAt = now(); draft.expiresAt = now() + TTL_MS;
      if (suggestions.length) suggestionsExpiresAt = draft.expiresAt;
      const safe = compactDraft(draft, now());
      if (safe && (drafts.size < 1000 || drafts.has(key))) drafts.set(key, safe);
    }
    return response(answer, pendingAction, clarification);
    function response(text, pending, needsClarification) {
      const realUsage = execution?.getUsage(), latencyMs = performance.now() - started;
      const participant = { agentId: 'operations', model: null, llmCalls: 0, skillCalls: 0, ...zeroUsage(), usageAvailable: true, latencyMs, providerLatencyMs: 0 };
      if (realUsage) Object.assign(participant, realUsage.agents.find(agent => agent.agentId === 'operations'));
      return { requestId: context.requestId, conversationId, answer: text, intent: 'action', agent: 'operations', participants: [participant], actions: [], evidence: [],
        usage: { totalLlmCalls: 0, totalSkillCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalThoughtTokens: 0,
          totalCachedInputTokens: 0, totalToolUseTokens: 0, totalTokens: 0, metricsComplete: true, totalProviderLatencyMs: 0,
          totalLatencyMs: latencyMs, toolSelectionCycles: 0, agents: [participant], ...(realUsage || {}) },
        requiresClarification: needsClarification, clarificationQuestion: needsClarification ? text : null, latencyMs,
        ...(pending ? { pendingAction: pending } : {}), ...(suggestions.length ? { suggestions, suggestionsExpiresAt } : {}),
        ...(suggestionsPagination ? { suggestionsPagination } : {}) };
    }
  }
  return { ...runtime,
    async restoreContext(req, id, snapshot) {
      await runtime.restoreContext?.(req, id, snapshot);
      const key = keyFor(req, id), restored = compactDraft(snapshot.operationDraft, now());
      if (!drafts.has(key) && restored && drafts.size < 1000) drafts.set(key, restored);
    },
    async getContextSnapshot(req, id) { return { ...await runtime.getContextSnapshot?.(req, id), operationDraft: compactDraft(drafts.get(keyFor(req, id)), now()) }; },
    forgetConversation(req, id) { drafts.delete(keyFor(req, id)); return runtime.forgetConversation?.(req, id); },
    async handle(req, input) {
      const key = keyFor(req, input.conversationId), preceding = locks.get(key) || Promise.resolve();
      const work = preceding.catch(() => {}).then(() => handle(req, input)); locks.set(key, work);
      try { return await work; } finally { if (locks.get(key) === work) locks.delete(key); }
    }
  };
};
module.exports = { withActionAssistant, resultAnswer };
