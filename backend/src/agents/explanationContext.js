'use strict';
const { V3_IDS } = require('./v3Skills');
const { TTL_MS, contextBinding } = require('./memory');
const { renderV3 } = require('./v3Routing');
const MAX_BYTES = 6400;
const clean = (value, max) => typeof value === 'string'
  ? require('../services/agentHistoryProjection').redact(value).slice(0, max) : '';
const normalize = message => message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[¿?!.]/g, '').trim();
const isExplanation = message => /^(?:por (?:q|que)(?: (?:ese|esa|el|ella|dices eso|el primero|la primera|el segundo|la segunda|el tercero|la tercera))?|como sabes|de donde sale eso|explicame eso|estas seguro|que significa eso|esa prediccion la inventaste)$/.test(normalize(message));
// Only public projections of successful skill results. No provider text, prompt,
// private reasoning, raw result documents or arbitrary metadata enter this cache.
function compactExplanation(value, now = Date.now()) {
  if (!value || !/^[a-f\d]{64}$/.test(value.binding || '') || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= now || value.expiresAt > now + TTL_MS || !Array.isArray(value.entries)) return null;
  const entries = value.entries.slice(0, 4).filter(row => V3_IDS.includes(row?.skillId) && typeof row.facts === 'string')
    .map(row => ({ skillId: row.skillId, facts: clean(row.facts, 1300), entities: (Array.isArray(row.entities) ? row.entities : []).slice(0, 5)
      .filter(item => typeof item?.key === 'string' && typeof item?.facts === 'string')
      .map(item => ({ key: clean(item.key, 100), facts: clean(item.facts, 700) })) }));
  const result = { binding: value.binding, expiresAt: value.expiresAt, entries,
    responseType: ['VERIFIED_SYNTHESIS', 'FALLBACK_FACTS'].includes(value.responseType) ? value.responseType : 'FACTS' };
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES && entries.length) {
    const largest = entries.filter(row => row.entities.length).sort((a, b) => b.entities.length - a.entities.length)[0];
    if (largest) largest.entities.pop(); else entries.pop();
  }
  return entries.length ? result : null;
}
function rememberExplanation(results, context, responseType) {
  const entries = results.filter(({ skillId, result, responseMode }) => V3_IDS.includes(skillId)
    && ['READY', 'PARTIAL'].includes(result.status) && responseMode !== 'inventory-nearest-minimum').slice(0, 4)
    .map(({ skillId, result, args = {}, responseMode }) => {
      const facts = renderV3(skillId, result, args, responseMode);
      const entities = (result.data?.items || []).slice(0, 5).map(row => ({
        key: row.customerCode || row.supplierCode || row.sku || row.recommendedSku,
        facts: renderV3(skillId, { ...result, data: { ...result.data, items: [row] } }, args)
          + (Number.isFinite(row.rfm90d?.raw?.recencyDays) ? ` Recencia observada: ${row.rfm90d.raw.recencyDays} días.` : '')
      })).filter(row => row.key);
      return { skillId, facts, entities };
    });
  return compactExplanation({ binding: contextBinding(context), expiresAt: Date.now() + TTL_MS, responseType, entries });
}
const notes = {
  get_inventory_intelligence: 'La reposición se apoya en stock, entradas, cobertura y motivos disponibles del motor. Los motivos no disponibles no pueden inferirse; no se ejecutó una compra.',
  get_product_forecast: 'Ridge LIVE usa modelos ACTIVE CAUSAL27 en 7 y 14 días. La evidencia histórica conserva su corte y método; 1 día no está aprobado para Ridge LIVE.',
  get_customer_intelligence: 'El segmento y la recencia son señales observadas; no existe una probabilidad individual de abandono calculada.',
  get_supplier_intelligence: 'La puntualidad y el plazo son métricas observadas; no garantizan entregas futuras ni constituyen un score global.',
  get_cross_sell_recommendations: 'FP-Growth observó asociaciones en el artefacto congelado al 2026-10-12. Asociación no implica causalidad ni garantiza ventas futuras.',
  get_business_analytics: 'Estos indicadores describen el período consultado; una variación no demuestra su causa.',
  get_business_health: 'Son señales descriptivas consultadas de ventas, inventario, clientes y proveedores cuando están disponibles; no existe un score global.'
};
function explainPrevious(message, value, context) {
  if (/^por que (?:usan|usamos|usa) ridge$/.test(normalize(message)))
    return { intent: 'explain_contract', agent: 'forecast', answer: `${notes.get_product_forecast} El contrato aprobado no permite inferir una comparación nueva con otros modelos; para eso se necesita su evidencia de evaluación.` };
  if (!isExplanation(message)) return null;
  const saved = compactExplanation(value);
  const clarify = answer => ({ intent: 'explain_previous', agent: 'coordinator', clarification: true, answer });
  if (!saved || saved.binding !== contextBinding(context)) return clarify('No tengo evidencia vigente de una respuesta anterior para explicar. Indica qué consulta del negocio deseas revisar.');
  let entries = saved.entries;
  const ordinal = require('./ordinalSelection').ordinalSelection(message);
  const singular = /\b(?:ese|esa|el|ella)$/.test(normalize(message));
  if (ordinal.matched || singular) {
    const lists = entries.filter(row => row.entities.length);
    if (lists.length !== 1) return clarify('¿Cuál de las entidades de la respuesta deseas que explique? Indica su nombre o una opción inequívoca.');
    const index = ordinal.matched ? ordinal.index === -1 ? lists[0].entities.length - 1 : ordinal.index : lists[0].entities.length === 1 ? 0 : null;
    const selected = index !== null ? lists[0].entities[index] : null;
    if (!selected) return clarify('¿A cuál te refieres? Elige una entidad de la respuesta anterior por nombre u ordinal.');
    entries = [{ ...lists[0], facts: selected.facts }];
  }
  return { intent: 'explain_previous', agent: 'coordinator', answer: [
    'La respuesta se basa en estos hechos de la consulta anterior (no son una lectura nueva):',
    ...entries.map(row => `${row.facts}\n${notes[row.skillId]}`),
    ...(saved.responseType === 'FALLBACK_FACTS' ? ['La interpretación anterior no estuvo disponible o completa; solo puedo explicar los hechos que sí se obtuvieron.'] : [])
  ].join('\n\n') };
}
module.exports = { compactExplanation, rememberExplanation, explainPrevious, isExplanation, MAX_BYTES };
