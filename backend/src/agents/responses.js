const format = value => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : 'no disponible';
const name = row => `${row.sku || row.name || 'Producto'}${row.sku && row.name ? ` (${row.name})` : ''}`;
const periodLabel = metadata => metadata.period ? `${metadata.period.startDate} a ${metadata.period.endDate}` : metadata.asOf || '';
const amounts = rows => (rows || []).map(row => `${format(row.amount)} ${row.currency}`).join('; ') || 'sin importes registrados';

/** Every displayed number is taken from a verified skill DTO; no ML recalculation. */
const buildSkillAnswer = (skillId, result) => {
  const { data, metadata, status } = result;
  if (status === 'ML_NOT_READY') return 'Este negocio aún no cuenta con historial o configuración suficiente para el replay de ML.';
  if (skillId === 'get_sales_summary') return `Ventas completadas (${periodLabel(metadata)}): ${data.completedSalesCount}; ${format(data.totalUnitsSold)} unidades. Importe: ${amounts(data.amountsByCurrency)}.`;
  if (skillId === 'get_product_sales_summary') return `${name(data.product)} vendió ${format(data.totalUnitsSold)} unidades (${periodLabel(metadata)}). Importe de líneas completadas: ${amounts(data.amountsByCurrency)}.`;
  if (skillId === 'get_product_details') return `${name(data)}: stock ${format(data.stock)}, mínimo ${format(data.minStockLevel)}, precio ${format(data.price)} ${data.currency}. ${data.isActive ? 'Activo' : 'Inactivo'}.`;
  if (skillId === 'get_business_summary') return `Estado del negocio (${periodLabel(metadata)}): ${data.activeProducts} productos activos, ${data.lowStockProducts} con stock bajo. Ventas completadas: ${amounts(data.sales.amountsByCurrency)}; compras completadas: ${amounts(data.purchases.amountsByCurrency)}. Transacciones completadas: ${data.completedTransactionsCount}.`;
  if (!Array.isArray(data) || !data.length) return skillId === 'get_top_selling_products'
    ? `No hay ventas completadas registradas en ${metadata.periodLabel || 'el periodo consultado'}.`
    : 'No hay registros que cumplan esta consulta.';
  const displayed = skillId === 'get_demand_forecast' ? data.slice(0, 5) : data;
  const header = `${skillId === 'get_top_selling_products' ? `Periodo: ${metadata.periodLabel || 'Todo el historial disponible'}. ` : ''}Mostrando ${displayed.length} de ${metadata.totalMatches ?? metadata.returnedCount}${metadata.truncated || displayed.length < data.length ? ' (lista limitada; consulta un SKU para ver su detalle)' : ''}.`;
  const lines = displayed.map(row => {
    if (skillId === 'get_low_stock_products') return `${name(row)}: stock ${format(row.stock)}, mínimo ${format(row.minStockLevel)}, déficit ${format(row.shortage)}.`;
    if (skillId === 'get_top_selling_products') return `${name(row)}: ${format(row.unitsSold)} unidades vendidas.`;
    if (skillId === 'get_recent_transactions') return `${row.date.slice(0, 10)}: ${row.type === 'sale' ? 'venta' : 'compra'}, ${row.status}, ${format(row.total)} ${row.currency}, ${row.itemCount} líneas.`;
    if (skillId === 'get_demand_forecast' || skillId === 'get_replenishment_candidates') {
      if (row.mlStatus !== 'READY') return `${name(row)}: ${row.mlStatus}; no hay predicción disponible.`;
      return `${name(row)}: el modelo estima ${format(row.predictedDemand7d)} unidades para 7 días. Stock al ancla: ${format(row.stockAtAnchor)}; ventas últimos 7 días: ${format(row.salesLast7Days)}; stock de seguridad: ${format(row.safetyStock)}. ${row.recommendedQty > 0 ? `El sistema recomienda reponer ${format(row.recommendedQty)} unidades` : 'El sistema no recomienda reposición'} (${row.inventoryStatus}). Replay histórico, ancla ${row.anchor}.`;
    }
    return `${name(row)}: stock ${format(row.stock)}, mínimo ${format(row.minStockLevel)}.`;
  });
  return [header, ...lines].join('\n');
};

// Bound and redact the facts sent for LLM selection. IDs and raw documents are omitted.
const safeText = value => String(value).replace(/@[a-z\d.-]+\.[a-z]{2,}|\b\d{9,15}\b|\b[a-f\d]{24,}\b|\bBearer\s+\S+|AIza[\w-]{20,}/gi, '[omitido]').slice(0, 120);
const llmObservation = (skillId, result) => {
  const allowed = new Set(['sku', 'name', 'stock', 'minStockLevel', 'shortage', 'unitsSold', 'totalUnitsSold',
    'completedSalesCount', 'activeProducts', 'lowStockProducts', 'completedTransactionsCount', 'mlStatus',
    'predictedDemand7d', 'stockAtAnchor', 'salesLast7Days', 'safetyStock', 'recommendedQty', 'inventoryStatus', 'anchor',
    'currency', 'amount', 'amountsByCurrency', 'sales', 'purchases', 'product', 'totalUnits']);
  const project = (value, depth = 0) => {
    if (depth > 3) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return safeText(value);
    if (Array.isArray(value)) return value.slice(0, 3).map(row => project(row, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, project(item, depth + 1)]));
    return null;
  };
  return { skillId, status: result.status, facts: project(result.data), period: result.metadata.period || null };
};

module.exports = { buildSkillAnswer, llmObservation, safeText };
