'use strict';
const { normalize, isOutOfDomain } = require('./domainGate');
const { V3_SKILLS } = require('./v3Skills');
const { resolveOperationalPeriod } = require('./intentRouting');
const { deepFreeze } = require('./contracts');

const B = 'get_business_analytics', I = 'get_inventory_intelligence', F = 'get_product_forecast';
const C = 'get_customer_intelligence', S = 'get_supplier_intelligence', M = 'get_cross_sell_recommendations', H = 'get_business_health';

// Only open analytical requests. Simple stock, period, forecast, concepts and
// WRITE/selection requests continue through their established deterministic path.
const classifyGrounded = message => {
  const text = normalize(message);
  if (isOutOfDomain(message)) return { route: 'OUT_OF_DOMAIN' };
  if (/^(?:saca|retira|mete|mueve|baja)\b/.test(text)) return { route: 'AMBIGUOUS_WRITE' };
  if (/^(?:vende|vender|compra|comprar|prepara|crea|crear|ajusta|confirma|confirmo|confirmar|cancela|cancelar|hazlo|procede)\b/.test(text)) return { route: 'DETERMINISTIC' };
  const result = (responseIntent, skills, extra = {}) => ({ route: 'GROUNDED_LLM', responseIntent,
    skills, domains: [...new Set(skills.map(id => V3_SKILLS[id].domain))], ...extra });
  if (/productos? nuevos?/.test(text) && /incorpor|compr|recomiend/.test(text))
    return result('new_products', [B, M, I], { noHistoricalSkuData: true });
  if (/promocion/.test(text) && /convendr|recom|lanzar/.test(text)) return result('promotion', [B, F, M, I]);
  if (/client/.test(text) && /reten|prioriz/.test(text)) return result('customer_retention', [C]);
  if (/proveedor/.test(text) && /recom|elegir|conviene|prioriz/.test(text) && !/ventas|forecast|stock/.test(text))
    return result('supplier_advice', [S, I]);
  if (/ventas/.test(text) && /stock/.test(text) && /forecast|pronostico/.test(text) && /compr|recom|prioriz|analiz/.test(text))
    return result('purchase_advice', /proveedor/.test(text) ? [B, I, F, S] : [B, I, F]);
  if (/ventas/.test(text) && /inventario/.test(text) && /forecast|pronostico/.test(text) && /analiz|prioriz/.test(text))
    return result('business_priorities', [B, I, F]);
  if (/vende bien/.test(text) && /poco stock/.test(text)) return result('sales_stock_opportunity', [B, I]);
  if (/potencial/.test(text) && /quiebre/.test(text)) return result('stockout_opportunity', [B, I, F]);
  if ((/prioriz|recomiend/.test(text) && /inventario|repon|reposicion/.test(text))
    && !/^que deberia reponer$/.test(text)) return result('inventory_priorities', [I, F, S]);
  if (/mejorar.*ventas|estrategia.*ventas|conclusiones.*ventas/.test(text)) return result('sales_advice', [B]);
  if (/implica|interpreta|conclusiones/.test(text) && /wape|hgb|ma28|modelo|metrica/.test(text))
    return result('ml_interpretation', [F]);
  if (/resume.*negocio.*dueno|conclusiones.*datos|que deberia mejorar primero|decisiones.*manana|algo preocupante.*negocio|interpreta.*salud|analiza.*negocio/.test(text))
    return result('business_health_interpretation', /manana/.test(text) ? [H, I, F] : [H]);
  return { route: 'DETERMINISTIC' };
};

const buildGroundedPlan = (message, binding) => {
  const classification = classifyGrounded(message);
  if (classification.route !== 'GROUNDED_LLM') return null;
  const parsed = resolveOperationalPeriod(message, binding.operationalDate || binding.asOfDate || binding.referenceDate);
  if (parsed.clarificationQuestion) return { ...classification, clarificationQuestion: parsed.clarificationQuestion, tasks: [] };
  const sku = message.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+){1,5}\b/)?.[0];
  const tasks = classification.skills.map(skillId => {
    let args = { limit: 3 };
    if (skillId === B) args = { ...args, mode: 'summary', ...parsed.period,
      ...(['stockout_opportunity', 'sales_stock_opportunity'].includes(classification.responseIntent) ? { mode: 'rank', entityType: 'product', metric: 'units' } : {}),
      ...(classification.noHistoricalSkuData ? { mode: 'rank', entityType: 'category', metric: 'units' } : {}),
      ...(sku ? { productRef: sku } : {}) };
    if (skillId === I) args = { ...args, mode: 'recommendations',
      ...(classification.responseIntent === 'sales_stock_opportunity' ? { flag: 'low_stock' } : {}), ...(sku ? { productRef: sku } : {}) };
    if (skillId === F) args = { ...args, mode: classification.responseIntent === 'ml_interpretation' ? 'evaluation' : 'rank',
      horizonDays: /manana/.test(normalize(message)) ? 1 : 7, ...(sku ? { productRef: sku, mode: 'detail' } : {}) };
    if (skillId === C) args = { ...args, mode: 'rank', segment: 'AT_RISK', metric: 'recency', ...parsed.period };
    if (skillId === S) args = { ...args, mode: 'summary', ...parsed.period, ...(sku ? { productRef: sku } : {}) };
    if (skillId === M) args = { ...args, mode: 'rules' }; // serving enforces the approved frozen artifact
    if (skillId === H) args = { ...args, ...parsed.period };
    return { skillId, agent: V3_SKILLS[skillId].agents[0], args };
  });
  return deepFreeze({ ...classification, tasks });
};
module.exports = { classifyGrounded, buildGroundedPlan };
