'use strict';
const { normalize } = require('./domainGate');
const { resolveOperationalPeriod } = require('./intentRouting');

// Intent adaptation only. Metrics, segmentation and inference remain in the
// existing authenticated services. Explicit writes stay with Operations.
const commercialPlan = (message, memory, binding) => {
  const text = normalize(message).replace(/\bq\b/g, 'que');
  if (/^(?:registra|registrar|vende|vender|crea|crear|compra|comprar|actualiza|elimina|borra)\b/.test(text)
    || /\s+y\s+/.test(text)) return null;
  const make = (skillId, args) => ({ tasks: [{ skillId,
    agent: skillId === 'get_business_analytics' ? 'sales' : 'customers', args: { limit: 5, ...args } }] });
  if (/churn|abandonara|riesgo de fuga|probabilidad de abandono/.test(text))
    return { clarificationQuestion: 'No existe un modelo de churn. Puedo consultar RFM, actividad observada o el cluster K-Means, sin predecir abandono.' };
  if (/consumidor final|consumer final/.test(text) && /cliente|rfm|cluster|segment|grupo/.test(text))
    return { clarificationQuestion: 'Consumidor Final es un agregado anónimo excluido del perfil individual RFM y de K-Means.' };
  if (/rfm|segment|cluster|grupo/.test(text) && /cliente|CLI-|pertenece|rfm|k.?means/i.test(message)) {
    const contextual = /(?:este|ese|su) cliente/.test(text);
    const ref = message.match(/\bCLI-\d+\b/i)?.[0]
      || (!contextual && message.match(/\b(?:pertenece|segmentado|segmentada)\s+(.+?)[?.!]*$/i)?.[1])
      || (!contextual && message.match(/\b(?:rfm|segmento|cluster)\s+de\s+(.+?)[?.!]*$/i)?.[1])
      || (contextual ? memory.selectedCustomer?.key : null);
    if (contextual && !ref) return { clarificationQuestion: '¿A qué cliente te refieres? Indica su nombre o código.' };
    if (/rfm/.test(text) && !/cluster|k.?means/.test(text))
      return ref ? make('get_customer_intelligence', { mode: 'detail', customerRef: ref })
        : make('get_customer_intelligence', { mode: 'summary' });
    return make('get_customer_intelligence', { mode: 'clustering', ...(ref ? { customerRef: ref } : {}) });
  }
  if (/clientes/.test(text) && /mejores|mas compran|frecuencia|tiempo sin comprar|distribuid|actividad/.test(text))
    return make('get_customer_intelligence', { mode: /actividad/.test(text) ? 'summary' : 'rank',
      metric: /frecuencia/.test(text) ? 'tickets' : /sin comprar/.test(text) ? 'recency' : 'spend' });
  if (/anomali|anomal[ao]s?|atipic|isolation/.test(text) && !/histor|congelad|cutoff|score|algoritmo|metodo|accuracy|estabilidad|contaminacion|entren/.test(text)) {
    if (/manana|proxima|futur/.test(text)) return { clarificationQuestion: 'Isolation Forest no predice anomalías futuras.' };
    if (/ayer|semana|mes|\d{4}-\d{2}-\d{2}/.test(text)) return null; // existing bounded historical-period path
    return make('get_business_analytics', { mode: 'provisional' });
  }
  if (!/ventas|vendimos|ingresos|producto se vendio mas|vendido mas/.test(text)
    || /pronostic|forecast|se vender|venderemos|causa|por que|recomienda|analiza|interpreta|mejorar|recientes|ventas de |vendi de |ventas tuvo/.test(text)) return null;
  // The coordinator also probes routing before resolving the operational clock.
  // Only the bound execution path attaches a period; never use wall-clock dates.
  const asOf = binding.operationalDate || binding.asOfDate;
  const parsed = asOf ? resolveOperationalPeriod(message, asOf) : { period: {} };
  if (parsed.clarificationQuestion) return parsed;
  if (asOf && (!parsed.period || parsed.period.endDate > asOf
    || parsed.period.startDate < (binding.earliestDate || '2025-10-13'))) return null;
  return make('get_business_analytics', { mode: /producto se vendio mas|vendido mas/.test(text) ? 'rank'
    : /evoluci|variacion|tendencia|estuvieron/.test(text) ? 'compare' : 'summary',
    metric: /unidades|producto se vendio mas|vendido mas/.test(text) ? 'units' : /cuantas|tickets|transacciones/.test(text) ? 'tickets' : 'revenue',
    ...(/producto se vendio mas|vendido mas/.test(text) ? { entityType: 'product' } : {}), ...parsed.period });
};
module.exports = { commercialPlan };
