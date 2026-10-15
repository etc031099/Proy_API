'use strict';
const LIMITATION_MESSAGES = Object.freeze({
  RECOMMENDED_QUANTITY_UNAVAILABLE: 'La cantidad sugerida no está disponible para parte del inventario consultado.',
  FORECAST_UNAVAILABLE: 'No hay pronóstico disponible para parte de los productos consultados.',
  SUPPLIER_RELATION_UNAVAILABLE: 'La evidencia consultada no permite vincular proveedores con los productos candidatos.',
  ANALYTICS_PARTIAL: 'Parte de la información analítica consultada está marcada como parcial.',
  ANALYTICS_UNAVAILABLE: 'Un resultado analítico consultado está marcado como no disponible.',
  CONTEXT_EVIDENCE_OMITTED: 'Parte de la evidencia fue omitida para respetar el límite del contexto.'
});
const LIMITATION_REASONS = Object.freeze(['NO_ALLOWED_LIMITATION_CONTEXT', 'UNKNOWN_LIMITATION_CODE', 'LIMITATION_NOT_AUTHORIZED']);
const isLimitationCode = code => typeof code === 'string' && Object.hasOwn(LIMITATION_MESSAGES, code);

// Only explicit states in the evidence sent to synthesis authorize limitations.
// A rank limit, supplier-wide metric or ordinary forecast uncertainty is not one.
const buildAllowedLimitations = (evidence = []) => {
  const authorized = new Map();
  const add = (code, ref) => {
    if (!authorized.has(code)) authorized.set(code, { code, message: LIMITATION_MESSAGES[code], evidenceRefs: [] });
    authorized.get(code).evidenceRefs.push(ref);
  };
  for (const row of evidence) {
    if (row.omission === 'CONTEXT_BUDGET') { add('CONTEXT_EVIDENCE_OMITTED', row.ref); continue; }
    if (row.omission === 'NO_CANDIDATE_SUPPLIER_EVIDENCE') { add('SUPPLIER_RELATION_UNAVAILABLE', row.ref); continue; }
    const partial = row.status === 'PARTIAL' || row.facts?.availabilityStatus === 'PARTIAL';
    const unavailable = ['NO_DATA', 'UNAVAILABLE'].includes(row.status);
    const items = Array.isArray(row.facts?.items) ? row.facts.items : [];
    if (row.skillId === 'get_inventory_intelligence' && partial && items.some(item =>
      item.recommendation?.recommendedQty === null && item.recommendation?.status === 'LIVE_FORECAST_REQUIRED'))
      add('RECOMMENDED_QUANTITY_UNAVAILABLE', row.ref);
    else if (row.skillId === 'get_product_forecast' && (unavailable || items.some(item =>
      ['COLD_START', 'INSUFFICIENT_HISTORY', 'UNAVAILABLE'].includes(item.status))))
      add('FORECAST_UNAVAILABLE', row.ref);
    else if (partial) add('ANALYTICS_PARTIAL', row.ref);
    else if (unavailable) add('ANALYTICS_UNAVAILABLE', row.ref);
  }
  return [...authorized.values()];
};
const validateLimitations = (codes, context) => {
  // Intersect the sent allowlist with current factual states, not free-form prose.
  const factual = new Set(buildAllowedLimitations(context.evidence).map(row => row.code));
  const allowed = new Set((context.allowedLimitations || []).filter(row => isLimitationCode(row.code)
    && factual.has(row.code)).map(row => row.code));
  for (const [index, code] of codes.entries()) {
    if (!isLimitationCode(code) || !allowed.has(code)) throw Object.assign(new Error('GROUNDED_INVALID_RESPONSE'), {
      validationReason: 'LIMITATION_NOT_ALLOWED', validationLayer: 'GROUNDING', validationField: `limitations[${index}]`,
      limitationReason: !allowed.size ? 'NO_ALLOWED_LIMITATION_CONTEXT' : !isLimitationCode(code)
        ? 'UNKNOWN_LIMITATION_CODE' : 'LIMITATION_NOT_AUTHORIZED',
      ...(isLimitationCode(code) ? { limitationCode: code } : {})
    });
  }
};
const renderLimitations = codes => codes.map(code => LIMITATION_MESSAGES[code]);
module.exports = { LIMITATION_MESSAGES, LIMITATION_REASONS, isLimitationCode,
  buildAllowedLimitations, validateLimitations, renderLimitations };
