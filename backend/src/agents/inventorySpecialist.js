'use strict';

const number = value => Number.isFinite(value) ? String(Number(value.toFixed(2))) : 'no disponible';
const renderInventoryConclusion = (result, intent) => {
  const rows = result.data?.items || [];
  if (intent === 'replenishment' && !rows.length) return 'La recomendación de reposición no está disponible para el producto consultado.';
  if (!['replenishment', 'coverage', 'stock'].includes(intent) || rows.length !== 1) return null;
  const row = rows[0], name = row.productName || row.name || row.sku;
  if (intent === 'stock') return `El stock de ${name} es ${number(row.stock?.onHand)} unidades; stock mínimo: ${number(row.inventoryPolicy?.configuredMinimumStock)}; entradas pendientes: ${number(row.stock?.incoming)}; posición de inventario: ${number(row.stock?.inventoryPosition)}.`;
  if (intent === 'coverage') return `La cobertura de ${name} es ${number(row.coverage?.daysCover)} días según la evidencia disponible.`;
  const reorder = row.recommendation?.shouldReorder;
  const conclusion = reorder === true ? `Sí, debes reponer ${name}.` : reorder === false
    ? `No necesitas reponer ${name} según la recomendación actual.` : `La recomendación de reposición de ${name} no está disponible.`;
  const position = row.stock?.inventoryPosition, point = row.inventoryPolicy?.reorderPoint;
  const comparison = Number.isFinite(position) && Number.isFinite(point)
    ? `La posición de inventario es ${number(position)} y está ${position < point ? 'por debajo del' : position === point ? 'en el' : 'por encima del'} punto de reorden de ${number(point)}.` : '';
  const risk = { CRITICAL: 'crítico', HIGH: 'alto', MEDIUM: 'medio', LOW: 'bajo' }[row.risk?.level] || 'no disponible';
  return [conclusion, `Stock actual: ${number(row.stock?.onHand)} unidades.`, comparison, `Cobertura: ${number(row.coverage?.daysCover)} días; riesgo: ${risk}.`,
    `Cantidad sugerida por el servicio: ${number(row.recommendation?.recommendedQty)} unidades.`].filter(Boolean).join(' ');
};
module.exports = { renderInventoryConclusion };
