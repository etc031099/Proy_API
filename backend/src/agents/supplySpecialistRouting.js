'use strict';
const { normalize } = require('./domainGate');
const { extractProductReference, isContextualProductReference } = require('../utils/productReference');

// Language adapters only: the existing V3 services own metrics, frozen rules,
// authenticated scope and entity resolution. No inference or mutation lives here.
const supplyWrite = message => /^(?:(?:quiero|quisiera)\s+)?(?:crea(?:r)?\s+(?:una\s+)?orden\s+de\s+compra|recib[ei](?:r)?\s+(?:esta\s+|esa\s+|la\s+)?compra)\b/
  .test(normalize(message).replace(/[¿?¡!]/g, '').trim());

const supplyPlan = (message, memory = {}, binding = {}) => {
  const text = normalize(message).replace(/\bq\b/g, 'que').replace(/[¿?¡!]/g, '').trim();
  if (require('../automations/actionInput').actionIntent(message) || supplyWrite(message) || /\s+y\s+/.test(text)) return null;
  const asOf = binding.operationalDate || binding.asOfDate;
  const period = asOf ? require('./intentRouting').resolveOperationalPeriod(message, asOf) : {};
  const make = (skillId, agent, args) => skillId === 'get_supplier_intelligence' && period.clarificationQuestion ? period
    : ({ tasks: [{ skillId, agent, args: { limit: 5, ...args,
      ...(skillId === 'get_supplier_intelligence' && period.explicit ? period.period : {}) } }] });
  if (/\bcompras?\b/.test(text) && /\bpendient/.test(text) && !/proveedor/.test(text)) {
    const plan = make('get_supplier_intelligence', 'procurement', { mode: 'rank', metric: 'orders', limit: 20 });
    if (!plan.tasks) return plan;
    plan.tasks[0].pendingOnly = true;
    return plan;
  }
  if (/proveedor/.test(text)) {
    if (/ofertas|alternativas/.test(text)) {
      const ref = message.match(/\bpara\s+(.+?)[?.!]*$/i)?.[1] || extractProductReference(message);
      if (!ref) return { clarificationQuestion: '¿De qué producto deseas consultar las ofertas configuradas?' };
      return make('get_supplier_intelligence', 'procurement', { mode: 'alternatives', productRef: ref });
    }
    if (/probabilidad|predictiv|fallara|futuro/.test(text)) return { clarificationQuestion:
      'No existe un modelo predictivo de proveedores. Puedo consultar puntualidad, lead time y desempeño histórico observado.' };
    if (/mejor desempeno|mejor proveedor/.test(text)) return { clarificationQuestion:
      '¿Quieres comparar puntualidad o lead time observado? No existe un score de mejor proveedor ni una predicción de desempeño futuro.' };
    if (/entrega(?:r)?\s+mas\s+rapido|entregar\s+mas\s+rapido/.test(text))
      return make('get_supplier_intelligence', 'procurement', { mode: 'rank', metric: 'fastestLeadTime', sortDirection: 'asc' });
    if (/como estan mis proveedores|resumen de proveedores/.test(text))
      return make('get_supplier_intelligence', 'procurement', { mode: 'summary' });
    if (/historial de (?:compras|recepciones)/.test(text)) {
      const contextual = /(?:este|ese) proveedor/.test(text);
      const ref = message.match(/\bSUP-\d+\b/i)?.[0]
        || (contextual ? memory.selectedSupplier?.key : message.match(/proveedor\s+(.+?)[?.!]*$/i)?.[1]);
      if (!ref) return { clarificationQuestion: '¿De qué proveedor deseas consultar el historial? Indica su nombre o código.' };
      return make('get_supplier_intelligence', 'procurement', { mode: 'detail', supplierRef: ref });
    }
  }
  if (!/clientes?/.test(text) && /productos?(?: estan)? relacionados|compran (?:junto )?con|compra(?:n)? (?:mas )?(?:la |el )|venta cruzada|cross.?sell|fp.?growth|asociacion|afinidad|\b(?:support|confidence|lift|soporte|confianza)\b/.test(text)) {
    let ref = /esta asociacion|esa asociacion/.test(text) ? memory.selectedProduct?.key
      : message.match(/(?:junto con|junto a|compran (?:junto )?con|asociaci[oó]n (?:hay )?para|compra(?:n)? m[aá]s)\s+(.+?)[?.!]*$/i)?.[1]
        || (/^con que producto|^que productos (?:estan )?relacionados$/.test(text) ? null : extractProductReference(message));
    if (isContextualProductReference(ref)) ref = memory.selectedProduct?.key || null;
    const concept = /\bsupport\b|soporte/.test(text) ? 'support' : /\bconfidence\b|confianza/.test(text) ? 'confidence'
      : /\blift\b/.test(text) ? 'lift' : /causal/.test(text) ? 'causality' : /fp.?growth/.test(text) ? 'fp_growth' : null;
    if (!ref && /este|ese|esta asociacion/.test(text)) ref = memory.selectedProduct?.key;
    return make('get_cross_sell_recommendations', 'associations', { mode: ref ? 'recommend' : 'rules',
      ...(ref ? { productRef: ref } : {}), ...(concept ? { concept } : {}) });
  }
  return null;
};
module.exports = { supplyPlan, supplyWrite };
