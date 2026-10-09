const format = value => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : 'no disponible';
const label = row => `${row.sku} (${row.name})`;
const buildForecastAnalysisAnswer = ({ data, metadata, status }) => {
  if (status === 'ML_NOT_READY') return 'El negocio no tiene un escenario ML listo para consultar.';
  const date = new Date(`${metadata.anchor}T00:00:00Z`);
  const anchor = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('es-PE', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date) : 'fecha no disponible';
  const heading = `Para el escenario histórico con fecha de corte ${anchor}, horizonte ${metadata.model?.horizonDays || 7} días${metadata.department ? ` · departamento ${metadata.department}` : ''}${metadata.category ? ` · categoría ${metadata.category}` : ''}:`;
  if (metadata.mode === 'summary') return `${heading}\n${data.products} productos; ${data.ready} READY; ${data.notReady} sin predicción.\nOK: ${data.states.OK}; VIGILAR: ${data.states.VIGILAR}; REPONER: ${data.states.REPONER}.\nStock al corte: ${format(data.stockTotal)}. Demanda prevista: ${format(data.predictedDemandTotal)}. Reposición recomendada: ${format(data.recommendedTotal)}. Los totales de predicción y reposición incluyen solo productos READY.`;
  if (!data.length) return `${heading}\n${metadata.mode === 'not_ready'
    ? `${metadata.totalProducts} productos analizados, ${metadata.readyProducts} READY; no encontré productos sin predicción${metadata.department || metadata.category ? ' en el filtro consultado' : ''}.`
    : 'No encontré productos que cumplan el filtro consultado.'}`;
  const lines = data.map(row => row.mlStatus !== 'READY'
    ? `• ${label(row)}: sin predicción (${row.mlStatus}). Stock: ${format(row.stockAtAnchor)}.`
    : `• ${label(row)}: demanda prevista ${format(row.predictedDemand7d)}, stock ${format(row.stockAtAnchor)}${metadata.mode === 'exceeding_stock' ? `, diferencia demanda−stock ${format(row.demandStockGap)}` : ''}; reposición sugerida ${format(row.recommendedQty)}, estado ${row.inventoryStatus}.`);
  if (metadata.mode === 'compare') {
    if (data.every(row => row.mlStatus === 'READY')) {
      for (const [field, title] of [['predictedDemand7d', 'Mayor demanda prevista'], ['recommendedQty', 'Mayor necesidad de reposición']]) {
        lines.push(data[0][field] === data[1][field] ? `${title}: empate.`
          : `${title}: ${label(data[0][field] > data[1][field] ? data[0] : data[1])}.`);
      }
      lines.push('La prioridad indicada usa demanda, stock y reposición del escenario; no evalúa costos ni presupuesto.');
    } else lines.push('No puedo comparar demanda ni prioridad de reposición: uno o ambos productos no están READY.');
  } else lines.push(`Mostrando ${metadata.offset + 1}–${metadata.offset + data.length} de ${metadata.totalMatches}.${metadata.truncated ? ' Puedes pedir «ver más».' : ''}`);
  return [heading, ...lines].join('\n');
};
module.exports = { buildForecastAnalysisAnswer };
