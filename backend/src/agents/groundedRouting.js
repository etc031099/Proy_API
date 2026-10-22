'use strict';
const { normalize, isOutOfDomain } = require('./domainGate');
const { V3_SKILLS } = require('./v3Skills');
const { resolveOperationalPeriod } = require('./intentRouting');
const { deepFreeze } = require('./contracts');

const B = 'get_business_analytics', I = 'get_inventory_intelligence', F = 'get_product_forecast';
const C = 'get_customer_intelligence', S = 'get_supplier_intelligence', M = 'get_cross_sell_recommendations', H = 'get_business_health';
const requestsInterpretation = message => /\b(?:que harias|que hago|que te preocupa|deberia preocuparme|explicame en palabras simples|como esta|hacerle caso|recomiendas? comprar|significa ese riesgo|orientame|aconsejame)\b/
  .test(normalize(message).replace(/\bq\b/g, 'que'));

// Only open analytical requests. Simple stock, period, forecast, concepts and
// WRITE/selection requests continue through their established deterministic path.
const classifyGrounded = message => {
  const text = normalize(message).replace(/\bq\b/g, 'que');
  if (isOutOfDomain(message)) return { route: 'OUT_OF_DOMAIN' };
  if (/^como van mis ventas$/.test(text)) return { route: 'DETERMINISTIC' };
  if (/^(?:saca|retira|mete|mueve|baja)\b/.test(text)) return { route: 'AMBIGUOUS_WRITE' };
  if (/^(?:vende|vender|compra|comprar|prepara|crea|crear|ajusta|confirma|confirmo|confirmar|cancela|cancelar|hazlo|procede)\b/.test(text)) return { route: 'DETERMINISTIC' };
  const result = (responseIntent, skills, extra = {}) => ({ route: 'GROUNDED_LLM', responseIntent,
    skills, domains: [...new Set(skills.map(id => V3_SKILLS[id].domain))], ...extra });
  // Open interpretation of one entity uses the same V3 resolver/continuation as
  // ordinary reads. It is not a global ranking or a second LLM router.
  if (/\bcliente\b/.test(text) && /conclusion|interpreta|explicame.*en general/.test(text))
    return result('customer_interpretation', [C], { entityScoped: true });
  if (requestsInterpretation(message)
    && /producto|\b(?:con|de)\b|recomendacion|riesgo|recomiendas? comprar/.test(text))
    return result('product_interpretation', [I, F], { entityScoped: true });
  if (/productos? nuevos?/.test(text) && /incorpor|compr|recomiend/.test(text))
    return result('new_products', [B, M, I], { noHistoricalSkuData: true });
  if (/promocion/.test(text) && /convendr|recom|lanzar/.test(text)) return result('promotion', [B, F, M, I]);
  if (/client/.test(text) && /reten|prioriz|recuper/.test(text)) return result('customer_retention', [C]);
  if (/repon|reposicion/.test(text) && /proveedor/.test(text) && /conviene|deberia|prioriz|recomiend/.test(text))
    return result('inventory_priorities', [I, S]);
  if (/stock|inventario/.test(text) && /demanda/.test(text) && /preocup|prioriz|recomiend/.test(text))
    return result('inventory_demand_priorities', [I, F]);
  if (/proveedor/.test(text) && /recom|elegir|conviene|prioriz/.test(text) && !/ventas|forecast|stock/.test(text))
    return result('supplier_advice', [S, I]);
  const salesQuestion = /\b(?:ventas?|vendid[oa]s?|ingresos?|tickets?)\b/.test(text);
  const asksSalesEvolution = /\b(?:evolucion|evolucionad[oa]s?|tendencia|tendencias|subiendo|bajando|subieron|bajaron|aumentaron|disminuyeron|creciendo|cayendo|como vienen|como van|variacion|variaciones)\b/.test(text);
  const asksSalesMonitoring = /\b(?:vigilar|vigile|vigiles|revisar|revise|revises|observar|observarse|atencion)\b/.test(text);
  if (salesQuestion && (asksSalesEvolution || asksSalesMonitoring) || /\bque tendencias observas?\b/.test(text))
    return result('sales_evolution', [B], { asksSalesEvolution, asksSalesMonitoring });
  if (/ventas/.test(text) && /stock/.test(text) && /forecast|pronostico/.test(text) && /compr|recom|prioriz|analiz/.test(text))
    return result('purchase_advice', /proveedor/.test(text) ? [B, I, F, S] : [B, I, F]);
  if (/ventas/.test(text) && /inventario/.test(text) && /forecast|pronostico/.test(text) && /analiz|prioriz/.test(text))
    return result('business_priorities', [B, I, F]);
  if (/vende bien/.test(text) && /poco stock/.test(text)) return result('sales_stock_opportunity', [B, I]);
  if (/potencial/.test(text) && /quiebre/.test(text)) return result('stockout_opportunity', [B, I, F]);
  if (((/prioriz|recomiend/.test(text) && /inventario|repon|reposicion/.test(text)) || /(?:debo|deberia).*repon.*por que/.test(text))
    && !/^que deberia reponer$/.test(text)) return result('inventory_priorities', [I, F]);
  if (/mejorar.*ventas|estrategia.*ventas|conclusiones.*ventas|(?:interpreta|analiza).*ventas/.test(text)) return result('sales_advice', [B]);
  if (/implica|interpreta|conclusiones/.test(text) && /wape|hgb|ma28|modelo|metrica/.test(text))
    return result('ml_interpretation', [F]);
  if (/resume.*negocio|conclusiones.*datos|que deberia mejorar primero|decisiones.*manana|algo preocupante.*negocio|interpreta.*salud|analiza.*negocio|que deberia (?:priorizar hoy|revisar primero).*negocio|senal preocupante.*negocio/.test(text))
    return result('business_health_interpretation', /manana/.test(text) ? [H, I, F] : [H]);
  return { route: 'DETERMINISTIC' };
};

const buildGroundedPlan = (message, binding, memory = {}) => {
  const classification = classifyGrounded(message);
  if (classification.route !== 'GROUNDED_LLM') return null;
  if (classification.entityScoped) {
    const domains = [/stock|inventario|reposicion/, /forecast|pronostico|demanda/, /ventas|vendimos|ingresos/,
      /clientes?/, /proveedores?/, /asociaci|fp.?growth/].filter(pattern => pattern.test(normalize(message)));
    if (domains.length > 2) return { ...classification, tasks: [],
      clarificationQuestion: 'Indica como máximo dos dominios relacionados para este análisis.' };
    const customer = classification.responseIntent === 'customer_interpretation';
    let ref = customer ? message.match(/\bCLI-\d+\b/i)?.[0] || (/\b(?:este|ese) cliente\b/.test(normalize(message)) ? memory.selectedCustomer?.key : null)
      : message.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+){1,5}\b/)?.[0]
        || normalize(message).match(/\bsegun (?:los )?datos que tienes de\s+(.+?)(?:,|\s+explicame\b|$)/)?.[1]
        || normalize(message).replace(/\bq\b/g, 'que').match(/\b(?:sabes de|hago con|harias con)\s+(.+?)(?:,|$)/)?.[1]
        || require('../utils/productReference').extractProductReference(message);
    if (!customer && ref) ref = require('./specialistRouting').resolveSpecialistReference(ref, memory);
    if (!customer && (!ref || require('../utils/productReference').isContextualProductReference(ref)))
      ref = memory.selectedProduct?.key;
    if (!ref) return { ...classification, tasks: [], clarificationQuestion:
      `Indica o selecciona el ${customer ? 'cliente' : 'producto'} que deseas analizar; no asumiré una entidad.` };
    const horizonDays = require('./languageNlu').requestedHorizon(message) ?? 7;
    if (!customer && ![7, 14].includes(horizonDays)) return { ...classification, tasks: [],
      clarificationQuestion: 'Ridge LIVE está aprobado únicamente para 7 y 14 días; 1 día no está aprobado.' };
    return { ...classification, responseMode: customer ? 'grounded-customer' : 'grounded-product',
      tasks: classification.skills.map(skillId => ({ skillId, agent: require('./specialistRouting').agentForTask(skillId),
        args: { limit: 3, mode: 'detail', ...(customer ? { customerRef: ref } : { productRef: ref }),
          ...(skillId === F ? { horizonDays } : {}) } })) };
  }
  const parsed = resolveOperationalPeriod(message, binding.operationalDate || binding.asOfDate || binding.referenceDate);
  if (parsed.clarificationQuestion) return { ...classification, clarificationQuestion: parsed.clarificationQuestion, tasks: [] };
  const sku = message.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+){1,5}\b/)?.[0];
  if (classification.responseIntent === 'ml_interpretation' && sku) return { ...classification, tasks: [],
    clarificationQuestion: 'La evaluación del modelo es global, no por SKU. ¿Quieres revisar esa evaluación o el pronóstico operativo del producto?' };
  const horizon = Number(normalize(message).match(/\b(?:para|proximos?|horizonte(?: de)?)\s+(\d+)\s+dias?\b/)?.[1]
    || (/manana/.test(normalize(message)) ? 1 : 7));
  if (classification.skills.includes(F) && classification.responseIntent !== 'ml_interpretation' && ![7, 14].includes(horizon))
    return { ...classification, tasks: [], clarificationQuestion: 'Ridge LIVE está aprobado únicamente para 7 y 14 días; 1 día no está aprobado. ¿Cuál deseas consultar?' };
  const tasks = classification.skills.map(skillId => {
    let args = { limit: 3 };
    if (skillId === B) args = { ...args, mode: classification.responseIntent === 'sales_evolution' ? 'compare' : 'summary', ...parsed.period,
      ...(['stockout_opportunity', 'sales_stock_opportunity'].includes(classification.responseIntent) ? { mode: 'rank', entityType: 'product', metric: 'units' } : {}),
      ...(classification.noHistoricalSkuData ? { mode: 'rank', entityType: 'category', metric: 'units' } : {}),
      ...(sku ? { productRef: sku } : {}) };
    if (skillId === I) args = { ...args, mode: 'recommendations',
      ...(classification.responseIntent === 'sales_stock_opportunity' ? { flag: 'low_stock' } : {}), ...(sku ? { productRef: sku } : {}) };
    if (skillId === F) args = { ...args, mode: classification.responseIntent === 'ml_interpretation' ? 'evaluation' : 'rank',
      horizonDays: horizon, ...(sku ? { productRef: sku, mode: 'detail' } : {}) };
    if (skillId === C) args = { ...args, mode: 'rank', segment: 'AT_RISK', metric: 'recency', ...parsed.period };
    if (skillId === S) args = { ...args, mode: 'summary', ...parsed.period, ...(sku ? { productRef: sku } : {}) };
    if (skillId === M) args = { ...args, mode: 'rules' }; // serving enforces the approved frozen artifact
    if (skillId === H) args = { ...args, ...parsed.period };
    return { skillId, agent: require('./specialistRouting').agentForTask(skillId, args), args };
  });
  if (new Set(tasks.map(task => task.agent)).size > 2) return { ...classification, tasks: [],
    clarificationQuestion: 'Indica como máximo dos dominios relacionados para este análisis; no consultaré todos los módulos sin priorización.' };
  return deepFreeze({ ...classification, tasks });
};
module.exports = { classifyGrounded, buildGroundedPlan, requestsInterpretation };
