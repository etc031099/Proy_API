'use strict';

const renderForecastConclusion = (result, intent, args) => {
  if (result.data?.method !== 'RIDGE_REGRESSION' || args.mode === 'method') return null;
  const rows = result.data.items || [];
  if (rows.length !== 1) return null;
  const row = rows[0], name = result.metadata?.selected?.product?.label || row.productName || row.name || row.sku;
  const lineage = `Modelo ${row.modelVersion == null ? 'no disponible' : `v${row.modelVersion}`} · ${row.activeModelStatus || 'no disponible'} · featureVersion ${row.featureVersion || 'no disponible'}.`;
  if (intent === 'model_status') return `Para ${name}, la autoridad del pronóstico es Ridge LIVE. ${lineage}`;
  return row.status === 'READY' && row.activeModelStatus === 'ACTIVE' && Number.isFinite(row.predictionUnits)
    ? `Se esperan ${Number(row.predictionUnits.toFixed(2))} unidades de ${name} en los próximos ${args.horizonDays || 7} días según Ridge LIVE ACTIVE. ${lineage}`
    : `El pronóstico Ridge LIVE de ${name} para ${args.horizonDays || 7} días no está disponible. ${lineage}`;
};
module.exports = { renderForecastConclusion };
