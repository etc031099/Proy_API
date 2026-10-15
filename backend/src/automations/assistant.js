const { createActionContext, randomUUID, zeroUsage } = require('./contracts');
const { performance } = require('node:perf_hooks');
const { actionIntent, parseAction, extractionSchema, validateExtraction, numericWords } = require('./actionInput');
const { createAgentExecution } = require('../agents/execution');
const { redact } = require('../services/agentHistoryProjection');
const { compactDraft, updateDraft, resolveDraft, applyResolution, TTL_MS } = require('./operationDraft');
const { resolveReference, configuredSuppliers } = require('./entityResolution');
const { Product } = require('../models');
const { ordinalSelection } = require('../agents/ordinalSelection');
const { actionDecision } = require('./actionDecision');
const { units, money, ruleNote } = require('../utils/assistantFormatting');
const resultAnswer = pending => pending.status !== 'EXECUTED' ? 'Acción cancelada. No se ejecutó ninguna operación.' : pending.result?.ruleConfigured
  ? `${pending.result.alreadyExists ? 'Ya existe una regla activa' : 'Regla configurada'} para ${pending.result.name || pending.result.sku}: stock ${pending.result.operator} ${units(pending.result.threshold)}. ${ruleNote}` : ['sale', 'purchase'].includes(pending.result?.type)
  ? `${pending.result.type === 'sale' ? 'Venta' : 'Compra'} registrada correctamente. ${pending.result.items.map(item => `${units(item.quantity)} de ${item.name || item.sku}; stock resultante: ${units(item.stock)}`).join('. ')}. Total: ${money(pending.result.total, pending.result.currency)}.`
  : `Producto registrado correctamente. SKU: ${pending.result?.sku || '—'}. Stock: ${Number.isFinite(pending.result?.stock) ? units(pending.result.stock) : '—'}.${pending.result?.needsSupplierSetup ? ' Todavía no tiene proveedor con precio de compra; configúralo desde Productos antes de registrar compras.' : ''}`;
// Only bounded questions about the displayed operation use its frozen preview.
const pendingQuestionType = message => {
  const text = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[¿?!.]/g, '').trim();
  if (/^(?:esta bien el precio|cual es el precio|y el precio|que precio tiene)$/.test(text)) return 'price';
  if (/^cuanto (?:quedar[ae]|quedar[ae] de stock|stock quedara)$/.test(text)) return 'stock';
  if (/^cuanto (?:pagare|es el total|cuesta en total)$/.test(text)) return 'total';
  if (/^que proveedor (?:elegi|seleccione)$/.test(text)) return 'supplier';
  if (/^cuantas unidades (?:son|hay)$/.test(text)) return 'quantity';
  return null;
};
const pendingQuestionAnswer = (pending, type) => {
  if (!pending || pending.status !== 'PENDING') return null;
  const items = pending.items || [], fields = pending.fields || {};
  let answer;
  if (type === 'price' && items.length && items.every(item => Number.isFinite(item.price)))
    answer = items.map(item => `${item.name || item.sku}: precio configurado de ${money(item.price, fields.currency)} por unidad; ${units(item.quantity)} por ${money(item.total, fields.currency)}.`).join('\n');
  if (type === 'stock' && items.length && items.every(item => Number.isFinite(item.resultingStock)))
    answer = items.map(item => `${item.name || item.sku}: el stock quedaría en ${units(item.resultingStock)}.`).join('\n');
  if (type === 'total' && Number.isFinite(fields.total)) answer = `El total de la operación sería ${money(fields.total, fields.currency)}.`;
  if (type === 'supplier' && pending.action === 'create_purchase' && fields.contact) answer = `El proveedor elegido es ${fields.contact}.`;
  if (type === 'quantity' && items.length && items.every(item => Number.isSafeInteger(item.quantity)))
    answer = items.map(item => `${item.name || item.sku}: ${units(item.quantity)}.`).join('\n');
  return answer ? `${answer}\nLa operación sigue pendiente y no se ha ejecutado.` : null;
};
// Bounded draft slots never authorize writes. Restored candidate IDs are looked up
// again before preparation. A separate per-conversation queue serialises updates.
const withActionAssistant = (runtime, service, options = {}) => {
  const drafts = new Map(), locks = new Map(), now = options.clock || Date.now;
  const keyFor = (req, id) => JSON.stringify([String(req.user?._id), req.businessId, id]);
  async function handle(req, input) {
    let v3State;
    if (req.businessId === require('../services/v3IntelligenceService').V3.businessId && input.conversationId) {
      const snapshot = await runtime.getContextSnapshot?.(req, input.conversationId);
      const candidate = require('../agents/v3Routing').compactV3State(snapshot?.v3Context, now());
      const binding = require('../agents/memory').contextBinding(require('../agents/contracts').createAgentRequestContext(req, { conversationId: input.conversationId }));
      if (candidate?.binding === binding) v3State = candidate;
      if (/^(?:haz|realiza) (?:el pedido|la compra)[.!]?$/i.test(input.message.trim())
        && v3State?.readRecommendation?.sku === v3State?.selectedProduct?.key) {
        const rec = v3State.readRecommendation;
        // Explicit action intent becomes only a normal, revalidated proposal.
        input = { ...input, message: `compra ${rec.quantity} del ${rec.sku}${rec.supplierCode ? ` con el proveedor ${rec.supplierCode}` : ''}` };
      }
    }
    const normalized = input.message.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^[¿¡]/, '').replace(/[?!.]$/, '');
    const decision = actionDecision(input.message);
    const expiredDraft = drafts.get(keyFor(req, input.conversationId));
    for (const [key, draft] of drafts) if (draft.expiresAt <= now()) drafts.delete(key);
    const draftKey = keyFor(req, input.conversationId);
    let previous = drafts.get(draftKey);
    const explicit = actionIntent(input.message);
    const actionOrdinal = ordinalSelection(input.message);
    let selectionActionProblem = null;
    if (explicit && ['create_sale', 'create_purchase'].includes(explicit) && actionOrdinal.matched && v3State?.pending
      && v3State.pending.type === 'product' && v3State.ranking?.type === 'product') {
      const index = actionOrdinal.index === -1 ? v3State.ranking.items.length - 1 : actionOrdinal.index;
      const candidate = actionOrdinal.index === null ? null : v3State.ranking.items[index];
      if (!candidate?.key) selectionActionProblem = 'Esa opción no está en la lista vigente. Elige una de las opciones mostradas; no se preparó ninguna operación.';
      let quantity;
      if (!selectionActionProblem) {
        try { quantity = parseAction(input.message, explicit).items?.[0]?.quantity; } catch { quantity = null; }
        if (!Number.isSafeInteger(quantity) || quantity < 1) selectionActionProblem = 'Indica una cantidad válida junto con la opción, por ejemplo «vende 2 de la segunda». No se preparó ninguna operación.';
        else input = { ...input, message: `${explicit === 'create_sale' ? 'vende' : 'compra'} ${quantity} del ${candidate.key}` };
      }
    }
    if (explicit && v3State && !selectionActionProblem) await runtime.clearV3Selection?.(req, input.conversationId);
    if (v3State?.pending && !explicit && decision !== 'cancel'
      && (/^(?:[1-5]|opcion [1-5]|si(?:,? ese)?|ok|vale|dale|ver mas|siguiente|anterior)$/.test(normalized)
        || ordinalSelection(input.message).matched
        || v3State.ranking?.items?.some(item => [item.key, item.label].some(value => value.toLowerCase() === input.message.trim().toLowerCase())))) return runtime.handle(req, input);
    const pendingQuestion = previous?.pendingActionId && !previous.readSuspended && !previous.selection && !previous.missingFields?.length && !explicit
      ? pendingQuestionType(input.message) : null;
    // A newer READ owns subsequent selections. Keep the frozen PendingAction
    // intact; only an explicit new action can re-enter the write flow.
    const newRead = !explicit && (/^(?:mejor\s+)?(?:dame|muestrame|busca|dime|cuanto|que|resume|explica|lista|cuales)\b/.test(normalized) || /[¿?]/.test(input.message))
      && !/que me falta|que datos|que proveedores/.test(normalized)
      && !(previous?.selection?.slot === 'product' && /^busca(?:r)?\b/.test(normalized))
      && !ordinalSelection(input.message).matched;
    if (previous && newRead && !decision && !pendingQuestion) {
      drafts.set(draftKey, { ...previous, readSuspended: true });
      return runtime.handle(req, input);
    }
    if (previous?.readSuspended && !explicit && !decision && !pendingQuestion) return runtime.handle(req, input);
    if (explicit === 'create_stock_alert_rule' && require('../agents/intentRouting').tenantScopeViolation(input.message))
      return runtime.handle(req, input); // Preserve the deterministic F9 denial before resolving any product.
    const contextual = (previous?.selection?.slot === 'product' && /^busca(?:r)?\b/.test(normalized)) || /que me falta|que datos|que proveedores|^(?:mejor|cambia|en vez|no es|opcion|el |la |si\b|no\b|cancel|confirm|hazlo|crear proveedor|elegir proveedor|continuar sin)/.test(normalized)
      || /^(?:\d+|sku\b|proveedor\b|precio de compra\b|categoria\b)/.test(normalized);
    if (previous && !explicit && !decision && !contextual && !pendingQuestion && /^(?:muestrame|busca|dime|cuanto|que|resume|explica|lista|cuales)\b|[¿?]/.test(normalized)) previous = undefined;
    const skillId = explicit || previous?.action;
    const candidateCommand = /^(?:ver mas|siguiente|anterior|anteriores|refinar busqueda|mas especifico)$/.test(normalized);
    // Read-only ML paging is not an operation-draft command. Active drafts keep
    // their existing selection flow; do not prepare/cancel a write for analytics.
    if (!previous && candidateCommand && input.conversationId) {
      const state = await runtime.getContextSnapshot?.(req, input.conversationId);
      if (state?.lastForecastAnalytics || state?.supplierResolution || state?.supplierProductListing || state?.v3Context?.pending) return runtime.handle(req, input);
    }
    if (!skillId && !decision && !candidateCommand) return runtime.handle(req, input);
    const started = performance.now(), conversationId = input.conversationId || randomUUID();
    const context = createActionContext(req, { conversationId }), key = keyFor(req, conversationId);
    let pendingAction, answer, clarification = false, previewShown = false, execution, suggestions = [], suggestionsExpiresAt, suggestionsPagination, suggestionsEntityType;
    if (selectionActionProblem) return response(selectionActionProblem, undefined, true);
    if (!previous && candidateCommand) return response('No hay una lista de opciones vigente. Inicia nuevamente la búsqueda.', undefined, true);
    if (pendingQuestion) {
      const pending = await service.get(context, previous.pendingActionId);
      const text = !pending?.expiresAt || Date.parse(pending.expiresAt) > now() ? pendingQuestionAnswer(pending, pendingQuestion) : null;
      if (text) return response(text, pending, false);
      if (pending?.status === 'PENDING' && Date.parse(pending.expiresAt) > now())
        return response('No tengo ese dato verificable en el preview. La operación sigue pendiente y no se ha ejecutado.', pending, true);
      return response('La operación ya terminó o expiró. No puedo responder desde un preview vigente.', undefined, true);
    }
    if (previous?.items && /que proveedores/.test(normalized)) {
      const products = [];
      for (const item of previous.items) {
        const result = await (options.resolver || resolveReference)(Product, context, item.ref);
        if (!result.value) return response('Primero elige el producto para consultar sus proveedores.', undefined, true);
        products.push(result.value);
      }
      const suppliers = await (options.supplierLookup || configuredSuppliers)(products, context);
      const labels = suppliers.map(row => `${row.name}${row.costs ? `: ${row.costs.map(cost => money(cost.purchasePrice, cost.currency)).join(', ')}` : ''}`);
      return response(labels.length ? `Proveedores configurados: ${labels.join('; ')}. Tu borrador sigue disponible.`
        : 'No hay proveedor común con precio de compra configurado. Tu borrador sigue disponible; configúralo desde Productos o cancela.', undefined, true);
    }
    if (decision) {
      if (expiredDraft && expiredDraft.expiresAt <= now())
        return response('La operación pendiente expiró. Indica nuevamente los datos para preparar un preview nuevo.', undefined, true);
      if (previous?.selection || previous?.missingFields?.length || previous && !previous.pendingActionId) {
        if (decision === 'cancel') { drafts.delete(key); return response('Borrador cancelado. No se guardó ninguna operación.', undefined, false); }
        return response('Todavía faltan datos o una selección. Elige la entidad solicitada antes de confirmar; no se ejecutó ninguna operación.', undefined, true);
      }
      const pending = previous?.pendingActionId ? await service.get(context, previous.pendingActionId) : await service.resolvePending(context);
      if (!pending) return response('No hay una operación pendiente identificable para confirmar o cancelar. Si hay varias, usa la tarjeta correspondiente.', undefined, true);
      if (pending.status === 'EXPIRED' || pending.expiresAt && Date.parse(pending.expiresAt) <= now()) {
        drafts.delete(key);
        return response('La operación pendiente expiró. Indica nuevamente los datos para preparar un preview nuevo.', undefined, true);
      }
      if (pending.status !== 'PENDING') {
        drafts.delete(key);
        return response('No hay una operación pendiente para confirmar o cancelar; esa acción ya terminó.', undefined, false);
      }
      if (decision === 'hold') {
        if (previous) previous.confirmationReady = false;
        return response('La operación sigue pendiente y no se ejecutó. Puedes revisar o corregir sus datos y después indicar «confirmar», o cancelarla.', pending, true);
      }
      if (decision === 'cancel') {
        pendingAction = await service.cancelPendingAction(context, pending.pendingActionId);
        answer = resultAnswer(pendingAction); drafts.delete(key);
      } else {
        const unique = await service.resolvePending(context);
        if (!unique || unique.pendingActionId !== pending.pendingActionId)
          return response('No puedo elegir una única operación pendiente. Usa Confirmar en la tarjeta de la acción que deseas ejecutar.', undefined, true);
        if (previous?.readSuspended) {
          const state = await runtime.getContextSnapshot?.(req, conversationId);
          if (state?.supplierResolution?.candidates?.length || state?.lastProductSelection?.sourceIntent === 'search_product' && state.lastProductSelection.continuationIntent)
            return response('Hay una selección de lectura activa. Elige una opción o usa la tarjeta de la operación pendiente para confirmarla explícitamente.', undefined, true);
          previous.readSuspended = false; previous.confirmationReady = true;
          previewShown = true;
          return response('Esta es la operación que sigue pendiente. Revisa nuevamente su tarjeta y confirma para ejecutarla.', pending, true);
        }
        if (!previous || decision === 'short' && previous.confirmationReady !== true)
          return response('Revisa la operación pendiente y escribe «confirmar» o usa Confirmar en su tarjeta.', pending, true);
        pendingAction = await service.confirmPendingAction(context, pending.pendingActionId);
        answer = resultAnswer(pendingAction); drafts.delete(key);
      }
    } else {
      if (previous?.pendingActionId && !explicit && !contextual) {
        previous.confirmationReady = false;
        return response('La operación sigue pendiente. Indica «confirmar», «cancelar» o la corrección que deseas hacer.', await service.get(context, previous.pendingActionId), true);
      }
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
          previous.confirmationReady = false;
        }
      }
      let extracted;
      try {
        const ordinalCorrection = !explicit && (previous?.selection || previous?.supplierChoices && /\bproveedor\b/.test(normalized)
          || previous?.productChoices && /\bproducto\b/.test(normalized)) && ordinalSelection(input.message).matched;
        const combinedSelectionQuantity = ordinalCorrection && previous?.selection?.slot === 'product'
          && ['create_sale', 'create_purchase'].includes(previous.action) && ordinalSelection(input.message).index !== null
          && /^\s*(?:\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+de\s+(?:el |la )?(?:primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa]|ultim[oa])\s*$/i.test(input.message);
        // A named selection alone selects a candidate. Quantity+ordinal is
        // accepted only for an existing product sale/purchase draft and still
        // flows through normal resolve + preview, never confirmation.
        if (ordinalCorrection && /\d|\b(?:cantidad|unidades?|stock|minimo|umbral)\b/.test(numericWords(normalized)) && !combinedSelectionQuantity)
          return response('Elige primero una opción de la lista. Después puedes corregir la cantidad o condición antes de confirmar.', undefined, true);
        extracted = ordinalCorrection && !combinedSelectionQuantity
          ? { action: skillId } : parseAction(input.message, skillId);
      }
      catch (error) {
        if (error.code !== 'ACTION_VALIDATION_FAILED') throw error;
        return response('Revisa los valores: la cantidad debe ser un entero mayor que cero; el stock, mínimo y umbral deben ser enteros desde cero.', undefined, true);
      }
      if (skillId === 'create_stock_alert_rule' && !previous && !extracted.items?.length && input.conversationId) {
        const state = await runtime.getContextSnapshot?.(req, input.conversationId);
        const selected = require('../agents/memory').compactSelectedProductReference(state?.selectedProductReference, now);
        const entity = selected || (state?.lastProductSelection?.items?.length > 1 || state?.recentEntities?.length > 1 ? null : state?.lastEntity);
        if (entity?.id && (!entity.type || entity.type === 'product')) extracted.items = [{ ref: entity.sku || entity.id }];
      }
      const unclear = skillId !== 'create_stock_alert_rule' && !previous && !extracted.direct && (skillId === 'create_product' ? !Object.keys(extracted.product || {}).length
        : !extracted.items?.length || /\b(?:tres|dos|cinco)\s+botellas/.test(normalized));
      if (unclear) {
        execution = createAgentExecution({ context: context.agentContext, ...(options.onEvent ? { onEvent: options.onEvent } : {}), ...(options.provider ? { provider: options.provider } : {}) });
        try {
          const result = await execution.generateStructured({ agentId: 'operations', schema: extractionSchema,
            systemInstruction: 'Extrae solamente campos explícitos. No inventes valores, precios, monedas, clientes ni proveedores. No ejecutes acciones. JSON breve.',
            messages: [{ role: 'user', text: redact(input.message) }] });
          const interpreted = validateExtraction(result.output);
          if (extracted.items?.some(item => item.quantity !== undefined)
            && (interpreted.items?.length !== extracted.items.length
              || extracted.items.some((item, index) => item.quantity !== undefined && item.quantity !== interpreted.items[index].quantity)))
            require('./contracts').fail('ACTION_VALIDATION_FAILED');
          extracted = interpreted;
          if (extracted.action !== skillId) require('./contracts').fail('ACTION_VALIDATION_FAILED');
        } finally { execution.finish(); }
      }
      let draft;
      if (extracted.supplierRef && require('../agents/supplierReference').contextualSupplier(extracted.supplierRef)) {
        const state = input.conversationId ? await runtime.getContextSnapshot?.(req, input.conversationId) : null;
        const supplier = previous?.selectedSupplier || state?.lastSupplier;
        if (!supplier) return response('Indica qué proveedor deseas usar; no tengo uno seleccionado en esta conversación.', undefined, true);
        extracted.supplierRef = supplier.id;
      }
      try { draft = updateDraft(explicit ? undefined : previous, extracted, input.message); }
      catch (error) {
        if (error.code !== 'ACTION_VALIDATION_FAILED') throw error;
        return response('Indica una cantidad entera válida: mayor que cero para ventas/compras, o desde cero para stock, mínimo y umbral.', undefined, true);
      }
      if (extracted.direct && (explicit || !previous)) draft.direct = extracted.direct;
      const resolved = applyResolution(draft, await resolveDraft(draft, context, options), now());
      if (draft.selectedSupplier) await runtime.rememberSupplier?.(req, conversationId, draft.selectedSupplier, draft.selectedProductReference);
      suggestions = resolved.suggestions || [];
      suggestionsPagination = resolved.suggestionsPagination;
      const candidateSlot = draft.selection?.slot;
      suggestionsEntityType = ['supplier', 'productSupplier'].includes(candidateSlot) ? 'supplier'
        : candidateSlot === 'customer' ? 'customer' : 'product';
      if (resolved.clarification) { answer = resolved.clarification; clarification = true; }
      else {
        pendingAction = await service.prepare({ agentId: 'operations', skillId, args: resolved.args, context, externalRequestId: req.agentActionRequestId || randomUUID() });
        draft.pendingActionId = pendingAction.pendingActionId;
        draft.confirmationReady = true;
        previewShown = true;
        answer = `${pendingAction.summary} ${skillId === 'create_stock_alert_rule' ? 'La regla todavía no se ha creado. ' : ''}Revisa la tarjeta antes de confirmar. La preparación no modifica el inventario.`;
      }
      draft.updatedAt = now(); draft.expiresAt = now() + TTL_MS;
      if (suggestions.length) suggestionsExpiresAt = draft.expiresAt;
      const safe = compactDraft(draft, now());
      if (safe && (drafts.size < 1000 || drafts.has(key))) drafts.set(key, safe);
    }
    return response(answer, pendingAction, clarification);
    function response(text, pending, needsClarification) {
      const activeDraft = drafts.get(key);
      if (activeDraft && !previewShown) activeDraft.confirmationReady = false;
      const realUsage = execution?.getUsage(), latencyMs = performance.now() - started;
      const participant = { agentId: 'operations', model: null, llmCalls: 0, skillCalls: 0, ...zeroUsage(), usageAvailable: true, latencyMs, providerLatencyMs: 0 };
      if (realUsage) Object.assign(participant, realUsage.agents.find(agent => agent.agentId === 'operations'));
      return { requestId: context.requestId, conversationId, answer: text, intent: 'action', agent: 'operations', participants: [participant], actions: [], evidence: [],
        usage: { totalLlmCalls: 0, totalSkillCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalThoughtTokens: 0,
          totalCachedInputTokens: 0, totalToolUseTokens: 0, totalTokens: 0, metricsComplete: true, totalProviderLatencyMs: 0,
          totalLatencyMs: latencyMs, toolSelectionCycles: 0, agents: [participant], ...(realUsage || {}) },
        requiresClarification: needsClarification, clarificationQuestion: needsClarification ? text : null, latencyMs,
        ...(pending ? { pendingAction: pending } : {}), ...(suggestions.length ? { suggestions, suggestionsExpiresAt } : {}),
        ...(suggestions.length ? { suggestionsEntityType } : {}),
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
module.exports = { withActionAssistant, resultAnswer, pendingQuestionAnswer };
