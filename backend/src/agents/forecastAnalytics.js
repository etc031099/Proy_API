const { AgentError } = require('./contracts');
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const MODES = ['top', 'exceeding_stock', 'not_ready', 'compare', 'summary'];
const compactAnalyticsContext = value => value && MODES.includes(value.mode) ? {
  mode: value.mode, limit: Number.isSafeInteger(value.limit) ? Math.max(1, Math.min(20, value.limit)) : 5,
  offset: Number.isSafeInteger(value.offset) ? Math.max(0, Math.min(60, value.offset)) : 0,
  ...Object.fromEntries(['department', 'category', 'first', 'second'].filter(key => typeof value[key] === 'string')
    .map(key => [key, value[key].slice(0, 100)]))
} : null;

/** Pure post-processing of verified forecast DTOs. No recomputed recommendations,
 * no prices, writes or model calls. Missing predictions are never coerced to zero. */
const analyzeForecast = (batch, args, scenarioId) => {
  let rows = batch.data;
  const metadata = { ...batch.metadata, scenarioId, mode: args.mode,
    evidenceLabel: `Forecast histórico · ${scenarioId || 'escenario del tenant'} · ${batch.metadata.anchor} · ${args.mode}` };
  const evidenceFor = selected => `${metadata.evidenceLabel} · ${selected.map(row => row.sku).join(', ')} · demanda/stock/reposición`.slice(0, 160);
  for (const field of ['department', 'category']) if (args[field]) {
    if (rows.length && rows.every(row => row[field] == null)) {
      return { status: 'CLARIFICATION', data: [], metadata: { ...metadata, returnedCount: 0,
        clarificationQuestion: `El forecast aún no expone metadata de ${field === 'department' ? 'departamento' : 'categoría'} del lineage. No la deduciré del SKU.` } };
    }
    rows = rows.filter(row => normalize(row[field]) === normalize(args[field]));
    metadata[field] = args[field];
  }
  const ready = rows.filter(row => row.mlStatus === 'READY');
  if (ready.some(row => !Number.isFinite(row.predictedDemand7d) || !Number.isFinite(row.stockAtAnchor)
    || !Number.isFinite(row.recommendedQty))) throw new AgentError('AGENT_SKILL_EXECUTION_FAILED');
  if (args.mode === 'summary') {
    const sum = field => ready.reduce((total, row) => total + row[field], 0);
    return { status: 'READY', data: { products: rows.length, ready: ready.length, notReady: rows.length - ready.length,
      states: Object.fromEntries(['OK', 'VIGILAR', 'REPONER'].map(state => [state, ready.filter(row => row.inventoryStatus === state).length])),
      stockTotal: rows.every(row => Number.isFinite(row.stockAtAnchor)) ? rows.reduce((n, row) => n + row.stockAtAnchor, 0) : null,
      predictedDemandTotal: sum('predictedDemand7d'), recommendedTotal: sum('recommendedQty'), totalsBasis: 'READY_ONLY' },
    metadata: { ...metadata, returnedCount: 1 } };
  }
  if (args.mode === 'compare') {
    const selected = [];
    for (const reference of [args.first, args.second]) {
      if (!reference) return { status: 'CLARIFICATION', data: [], metadata: { ...metadata, returnedCount: 0,
        clarificationQuestion: 'Indica los dos nombres o SKU que deseas comparar.' } };
      const ranked = require('../automations/entityResolution').rankEntities(rows.map(row => ({ ...row, _id: row.productId })), reference);
      const matches = ranked.value ? [ranked.value] : ranked.candidates || [];
      if (!ranked.value) return { status: 'CLARIFICATION', data: matches.slice(0, 5), metadata: { ...metadata,
        returnedCount: Math.min(5, matches.length),
        suggestions: matches.slice(0, 5).map(row => ({ label: row.name, detail: row.sku,
          message: selected.length ? `Compara ${selected[0].sku} con ${row.sku}` : `Compara ${row.sku} con ${args.second}` })),
        clarificationQuestion: matches.length
          ? `Hay varias coincidencias para «${reference}». Indica un SKU: ${matches.slice(0, 5).map(row => row.sku).join(', ')}.`
          : `No encontré «${reference}» en el forecast de este negocio. Indica otro nombre o SKU.` } };
      const { _id: ignoredId, ...resolved } = matches[0];
      selected.push(resolved);
    }
    if (selected[0].productId === selected[1].productId) return { status: 'CLARIFICATION', data: [], metadata: {
      ...metadata, returnedCount: 0, clarificationQuestion: 'Elige dos productos distintos para comparar.' } };
    return { status: 'READY', data: selected, metadata: { ...metadata, evidenceLabel: evidenceFor(selected), returnedCount: 2, totalMatches: 2 } };
  }
  rows = args.mode === 'not_ready' ? rows.filter(row => row.mlStatus !== 'READY')
    : args.mode === 'exceeding_stock' ? ready.filter(row => row.predictedDemand7d > row.stockAtAnchor)
      .map(row => ({ ...row, demandStockGap: row.predictedDemand7d - row.stockAtAnchor })) : ready;
  rows = [...rows].sort((a, b) => (args.mode === 'not_ready' ? 0
    : args.mode === 'exceeding_stock' ? b.demandStockGap - a.demandStockGap : b.predictedDemand7d - a.predictedDemand7d)
    || String(a.sku).localeCompare(String(b.sku)));
  const offset = args.offset || 0, limit = args.limit || 5;
  return { status: rows.length ? 'READY' : 'NO_DATA', data: rows.slice(offset, offset + limit), metadata: {
    ...metadata, evidenceLabel: evidenceFor(rows.slice(offset, offset + limit)),
    totalProducts: batch.data.length, readyProducts: batch.data.filter(row => row.mlStatus === 'READY').length,
    totalMatches: rows.length, returnedCount: rows.slice(offset, offset + limit).length,
    offset, limit, truncated: offset + limit < rows.length } };
};
module.exports = { analyzeForecast, compactAnalyticsContext };
