const format = value => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : 'no disponible';
const name = row => `${row.sku || row.name || 'Producto'}${row.sku && row.name ? ` (${row.name})` : ''}`;
const countLabel = (count, singular, plural) => `${format(count)} ${count === 1 ? singular : plural}`;
const dateLabel = value => {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'fecha no disponible';
};
const periodLabel = metadata => {
  if (!metadata.period) return 'el periodo consultado';
  const { startDate, endDate } = metadata.period;
  const start = new Date(`${startDate}T00:00:00Z`);
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  if (start.getUTCDate() === 1 && endDate === lastDay) {
    return new Intl.DateTimeFormat('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(start);
  }
  return `el periodo del ${dateLabel(startDate)} al ${dateLabel(endDate)}`;
};
const amounts = rows => (rows || []).map(row => `${format(row.amount)} ${row.currency}`).join('; ');
const listFooter = (metadata, displayedCount) => metadata.truncated || displayedCount < metadata.returnedCount
  ? `Te muestro ${displayedCount === 1 ? 'el primer resultado' : `los ${displayedCount} primeros`}; puedes pedirme ampliar la lista.` : '';
const historicalNote = (rows, metadata) => {
  const anchors = [...new Set(rows.map(row => row.anchor || metadata.anchor).filter(Boolean))];
  return anchors.length ? `Estas ${anchors.length === 1 ? 'estimaciones y recomendaciones corresponden al escenario histórico con fecha de referencia' : 'estimaciones y recomendaciones corresponden a escenarios históricos con fechas de referencia'} ${anchors.map(dateLabel).join(' y ')}.` : '';
};
const historicalPriceNote = metadata => metadata.anchor
  ? `Propuesta basada en el forecast histórico con fecha de corte ${dateLabel(metadata.anchor)} y en los precios configurados consultados actualmente; no es una predicción actual ni una cotización confirmada.`
  : 'Los precios corresponden a la configuración consultada actualmente y no constituyen una cotización confirmada.';
const replenishmentExplanation = result => {
  if (result.status === 'ML_NOT_READY') return buildSkillAnswer('get_demand_forecast', result);
  const row = result.data?.[0];
  if (!row) return buildSkillAnswer('get_demand_forecast', result);
  if (row.mlStatus !== 'READY') return `${name(row)} ${readinessLabel(row.mlStatus)}; no se puede justificar una cantidad numérica de reposición.`;
  return `${name(row)}: el modelo estima ${format(row.predictedDemand7d)} unidades para los próximos 7 días. En la fecha de referencia había ${format(row.stockAtAnchor)} unidades; el stock de seguridad es ${format(row.safetyStock)} y se recomienda reponer ${format(row.recommendedQty)} unidades. La recomendación combina demanda prevista, stock disponible y stock de seguridad. ${historicalNote([row], result.metadata)}`;
};
const readinessLabel = status => ({
  INSUFFICIENT_HISTORY: 'todavía no tiene suficiente historial para generar una predicción',
  MISSING_LINEAGE: 'todavía no tiene la configuración de origen necesaria',
  MISSING_PRICE_HISTORY: 'necesita historial de precios',
  MISSING_CALENDAR: 'necesita cobertura de calendario',
  INVALID_HISTORY: 'necesita un historial válido',
  INVALID_FEATURES: 'sus datos aún no cumplen el contrato de predicción',
  MODEL_UNAVAILABLE: 'el modelo no está disponible temporalmente'
}[status] || 'no tiene una predicción disponible');

const businessAnswer = (data, metadata) => {
  const period = periodLabel(metadata);
  if (metadata.periodMode === 'latest') {
    if (!data.completedTransactionsCount) return 'No encontré ventas ni compras completadas en el historial disponible.';
    const historical = metadata.period.endDate < String(metadata.asOf).slice(0, 10);
    return [`${historical ? 'Los datos de ventas y compras completadas disponibles son históricos. ' : ''}Como contexto adicional, el último periodo con actividad completada registrada es ${period}.`,
      `En ese periodo: ${countLabel(data.sales.completedTransactionsCount, 'venta completada', 'ventas completadas')}${data.sales.amountsByCurrency.length ? ` por ${amounts(data.sales.amountsByCurrency)}` : ''}; ${countLabel(data.purchases.completedTransactionsCount, 'compra completada', 'compras completadas')}${data.purchases.amountsByCurrency.length ? ` por ${amounts(data.purchases.amountsByCurrency)}` : ''}.`].join('\n');
  }
  const lines = [`Tienes ${countLabel(data.activeProducts, 'producto activo', 'productos activos')} en el catálogo. ${data.lowStockProducts
    ? `${data.lowStockProducts} ${data.lowStockProducts === 1 ? 'está' : 'están'} en el mínimo de stock o por debajo; conviene ${data.lowStockProducts === 1 ? 'revisarlo' : 'revisarlos'}.`
    : 'Ninguno está en el mínimo de stock o por debajo.'}`];
  if (!data.completedTransactionsCount) lines.push(`No se registran ventas o compras completadas durante ${period}.`);
  else {
    lines.push(data.sales.completedTransactionsCount
      ? `Durante ${period} registraste ${countLabel(data.sales.completedTransactionsCount, 'venta completada', 'ventas completadas')} por ${amounts(data.sales.amountsByCurrency)}.`
      : `No se registraron ventas completadas durante ${period}.`);
    lines.push(data.purchases.completedTransactionsCount
      ? `Registraste ${countLabel(data.purchases.completedTransactionsCount, 'compra completada', 'compras completadas')} por ${amounts(data.purchases.amountsByCurrency)} en ese periodo.`
      : `No se registraron compras completadas durante ${period}.`);
  }
  return lines.join('\n');
};

/** Every displayed number is taken from a verified skill DTO; no ML recalculation. */
const buildSkillAnswer = (skillId, result) => {
  if (skillId === 'analyze_demand_forecast') return require('./forecastResponses').buildForecastAnalysisAnswer(result);
  const { data, metadata, status } = result;
  if (status === 'ML_NOT_READY') return 'Este negocio aún no cuenta con historial o configuración suficiente para generar predicciones.';
  if (skillId === 'get_replenishment_cost') {
    if (Array.isArray(data)) return metadata.clarificationQuestion || 'Indica el SKU exacto del producto.';
    if (data.sku) {
      const rule = { PREFERRED_SUPPLIER: 'Se utilizó el proveedor preferido configurado. ',
        USER_SPECIFIED: 'Se utilizó el proveedor que indicaste. ', LOWEST_VALID_PRICE: 'Se seleccionó la oferta válida de menor costo. ',
        USER_SPECIFIED_UNAVAILABLE: 'El proveedor indicado no tiene una oferta válida para este producto. ' }[data.selectionRule] || '';
      const match = data.supplierMatch && data.supplierMatch.requested !== data.selectedSupplier
        ? `Tomé «${data.supplierMatch.requested}» como ${data.selectedSupplier}. ` : '';
      return `${match}${data.sku} (${data.productName}): ${format(data.recommendedQty)} unidades recomendadas × ${format(data.unitCost)} ${data.currency} = ${data.replenishmentCost === null ? 'costo no disponible' : `${format(data.replenishmentCost)} ${data.currency}`}.\n${rule}Proveedor: ${data.selectedSupplier || 'sin oferta utilizable'}. Stock al ancla: ${format(data.stockAtAnchor)}; demanda prevista: ${format(data.predictedDemand7d)}; estado: ${data.inventoryStatus || data.mlStatus}.\n${historicalPriceNote(metadata)}`;
    }
    const coverage = data.coverageProducts;
    return `Costo conocido para la reposición recomendada: ${format(data.knownCostSubtotal)} ${data.currency}. Productos considerados: ${data.consideredProducts}; con costo válido: ${data.costedProducts}; excluidos: ${data.excludedProducts}; unidades recomendadas: ${data.recommendedUnits}.${data.excludedProducts > 0 || coverage?.eligible > coverage?.costed ? ' El subtotal es incompleto porque hay productos sin costo utilizable o sin forecast READY.' : ''}\n${historicalPriceNote(metadata)}`;
  }
  if (skillId === 'compare_supplier_costs') {
    const offers = Array.isArray(data) ? data : [];
    if (!offers.length) return 'No encontré ofertas activas y válidas en PEN para ese producto.';
    const selected = offers.find(row => row.selected);
    const selectedNote = selected ? `Para una reposición normal, se utilizaría ${selected.supplier} porque ${selected.preferred
      ? 'es el proveedor preferido configurado' : 'es la oferta válida de menor costo'}.` : 'No hay un proveedor seleccionado.';
    return `Para ${offers[0].sku} (${offers[0].productName}) hay ${offers.length} proveedor${offers.length === 1 ? '' : 'es'} con ofertas válidas:\n${offers.map(row => `• ${row.supplier}: ${format(row.unitCost)} ${row.currency} por unidad${row.preferred ? '. Es el proveedor preferido configurado' : ''}${row.selected && !row.preferred ? '. Oferta seleccionada' : ''}.`).join('\n')}\n${selectedNote} Precios consultados: ${metadata.pricingAsOf || 'fecha no disponible'}.`;
  }
  if (skillId === 'get_supplier_products') {
    if (Object.hasOwn(data, 'product')) {
      if (!data.product) return `No encontré el producto ${data.productRef} en el catálogo de este negocio.`;
      if (!data.product.hasOffer) return `El proveedor ${data.supplierName} existe, pero no tiene una oferta configurada para ${data.product.sku} (${data.product.productName}).`;
      const currency = data.product.currency === 'PEN' ? 'S/ ' : '';
      return `Sí. ${data.supplierName} tiene una oferta configurada para ${data.product.sku} (${data.product.productName}) por ${currency}${format(data.product.purchasePrice)} ${data.product.currency}${data.product.preferredForProduct ? '. Es el proveedor preferido configurado para este producto' : ''}. Este precio está configurado en el sistema y no es una cotización confirmada.`;
    }
    const items = data.items || [];
    if (!items.length) return `${data.supplierName} no tiene productos con ofertas configuradas en el catálogo de este negocio.`;
    const first = metadata.offset + 1, last = metadata.offset + items.length;
    const price = row => `${row.currency === 'PEN' ? 'S/ ' : ''}${format(row.purchasePrice)} ${row.currency}`;
    const lines = items.map(row => `• ${row.sku || 'Sin SKU'} — ${row.productName} — ${price(row)}${row.preferredForProduct ? ' (proveedor preferido configurado)' : ''}${row.active ? '' : ' (producto inactivo)'}`);
    return [`${data.supplierName} tiene ${countLabel(data.totalProducts, 'producto con oferta configurada', 'productos con ofertas configuradas')} en el sistema:`,
      ...lines, `Mostrando ${first}–${last} de ${data.totalProducts}. Los precios configurados no son cotizaciones confirmadas.${data.pagination?.hasMore ? ' Puedes decir «ver más» para continuar.' : ''}`].join('\n');
  }
  if (skillId === 'plan_replenishment_budget') {
    const items = data.items || [];
    const lines = items.map(row => `• ${row.sku} (${row.productName}): ${format(row.plannedQty)}/${format(row.recommendedQty)} unidades con ${row.supplierName}, ${format(row.plannedCost)} PEN. ${row.reason}.`);
    const exclusionLabels = { NO_USABLE_OFFER: 'sin oferta utilizable', UNSUPPORTED_CURRENCY: 'moneda no admitida',
      PRODUCT_NOT_CONFIGURED: 'producto sin configuración de precio', INSUFFICIENT_HISTORY: 'historial insuficiente',
      ML_NOT_READY: 'forecast no listo' };
    const excluded = Object.entries(data.exclusionsByReason || {}).map(([reason, count]) =>
      `${count} ${exclusionLabels[reason.replace(/^FORECAST_/, '')] || (reason.startsWith('FORECAST_') ? 'forecast no listo' : 'sin oferta utilizable')}`);
    return [`Con S/ ${format(data.budget)}, la propuesta asigna S/ ${format(data.spent)} y deja S/ ${format(data.remaining)}.`,
      `${format(data.plannedUnits)} unidades planificadas; ${format(data.unplannedUnits)} quedan pendientes.`, ...lines,
      data.excludedProducts ? `No se pudieron costear ${data.excludedProducts} productos recomendados${excluded.length ? `: ${excluded.join('; ')}` : '.'}.` : '',
      historicalPriceNote(metadata)].filter(Boolean).join('\n');
  }
  if (skillId === 'get_sales_summary') return !data.completedSalesCount
    ? `No se registraron ventas completadas durante ${periodLabel(metadata)}.`
    : `Durante ${periodLabel(metadata)} registraste ${countLabel(data.completedSalesCount, 'venta completada', 'ventas completadas')}, con ${format(data.totalUnitsSold)} unidades vendidas. El importe de ventas es ${amounts(data.amountsByCurrency)}.`;
  if (skillId === 'get_product_sales_summary') return status === 'NO_DATA'
    ? `${name(data.product)} no registra ventas completadas durante ${periodLabel(metadata)}.`
    : `${name(data.product)} vendió ${format(data.totalUnitsSold)} unidades durante ${periodLabel(metadata)}. El importe correspondiente a ese producto es ${amounts(data.amountsByCurrency)}.`;
  if (skillId === 'get_product_details') return `${name(data)} tiene ${format(data.stock)} unidades disponibles y un mínimo configurado de ${format(data.minStockLevel)}. Su precio es ${format(data.price)} ${data.currency}. El producto está ${data.isActive ? 'activo' : 'inactivo'}.`;
  if (skillId === 'get_business_summary') return businessAnswer(data, metadata);
  const rankingPeriod = metadata.period ? periodLabel(metadata) : 'todo el historial disponible';
  if (!Array.isArray(data) || !data.length) return ({
    get_top_selling_products: `No encontré ventas completadas en ${rankingPeriod}.`,
    get_low_stock_products: 'No encontré productos en el mínimo de stock o por debajo.',
    get_recent_transactions: 'No encontré transacciones para los filtros consultados.',
    get_replenishment_candidates: 'No hay productos listos para ML con una cantidad de reposición sugerida mayor que cero en el escenario consultado.',
    get_demand_forecast: 'No encontré predicciones disponibles para los productos consultados.'
  }[skillId] || 'No encontré productos con ese nombre o SKU. Puedes probar con otro término.');
  const displayed = skillId === 'get_demand_forecast' ? data.slice(0, 5) : data;
  const headers = {
    get_low_stock_products: `Encontré ${countLabel(metadata.totalMatches ?? data.length, 'producto', 'productos')} en el mínimo de stock o por debajo.`,
    get_top_selling_products: `Estos son los productos con más unidades vendidas en ${rankingPeriod}:`,
    get_recent_transactions: 'Estas son las transacciones más recientes que coinciden con tu consulta:',
    get_demand_forecast: 'Esta es la demanda estimada para los próximos 7 días del escenario consultado:',
    get_replenishment_candidates: `Te recomiendo priorizar ${displayed.length} ${displayed.length === 1 ? 'producto' : 'productos'} para reposición.\nLa mayor cantidad sugerida corresponde a ${name(displayed[0])}: ${format(displayed[0].recommendedQty)} unidades.`,
    search_products: `Encontré ${countLabel(metadata.totalMatches ?? data.length, 'producto', 'productos')} que ${metadata.totalMatches === 1 ? 'coincide' : 'coinciden'} con tu búsqueda:`
  };
  const header = headers[skillId] || 'Estos son los productos consultados:';
  const lines = displayed.map(row => {
    if (skillId === 'get_low_stock_products') return `• ${name(row)} tiene ${format(row.stock)} unidades disponibles${row.shortage > 0
      ? ` y necesita ${format(row.shortage)} más para alcanzar su mínimo de ${format(row.minStockLevel)}`
      : ` y está justo en su mínimo de ${format(row.minStockLevel)}`}.`;
    if (skillId === 'get_top_selling_products') return `• ${name(row)} — ${format(row.unitsSold)} unidades vendidas.`;
    if (skillId === 'get_recent_transactions') return `• ${dateLabel(row.date)}: ${row.type === 'sale' ? 'venta' : 'compra'} ${{ completed: 'completada', pending: 'pendiente', cancelled: 'cancelada' }[row.status] || 'con estado no disponible'} por ${format(row.total)} ${row.currency}, con ${row.itemCount} líneas de productos.`;
    if (skillId === 'get_demand_forecast' || skillId === 'get_replenishment_candidates') {
      if (row.mlStatus !== 'READY') return `• ${name(row)} ${readinessLabel(row.mlStatus)}; no hay predicción disponible.`;
      if (skillId === 'get_replenishment_candidates') return `• ${name(row)} — reponer ${format(row.recommendedQty)} unidades; demanda estimada de ${format(row.predictedDemand7d)} unidades y stock disponible de ${format(row.stockAtAnchor)} en la fecha de referencia.`;
      return `• ${name(row)}: el modelo estima ${format(row.predictedDemand7d)} unidades para 7 días. En la fecha de referencia había ${format(row.stockAtAnchor)} unidades disponibles y se habían vendido ${format(row.salesLast7Days)} en los 7 días anteriores. Considerando ${format(row.safetyStock)} unidades de stock de seguridad, ${row.recommendedQty > 0 ? `se recomienda reponer ${format(row.recommendedQty)} unidades` : 'actualmente no se recomienda reposición para ese escenario'}.`;
    }
    return `• ${name(row)} tiene ${format(row.stock)} unidades disponibles y un mínimo configurado de ${format(row.minStockLevel)}.`;
  });
  const forecastSkill = ['get_demand_forecast', 'get_replenishment_candidates'].includes(skillId);
  return [header, ...lines, forecastSkill ? historicalNote(displayed, metadata) : '', listFooter(metadata, displayed.length)].filter(Boolean).join('\n');
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
  return { skillId, status: result.status, facts: project(result.data), period: result.metadata.period || null,
    ...(result.metadata.periodMode ? { periodMode: result.metadata.periodMode,
      inventoryBasis: result.metadata.inventoryBasis, asOf: result.metadata.asOf } : {}) };
};

module.exports = { buildSkillAnswer, llmObservation, safeText, replenishmentExplanation };
