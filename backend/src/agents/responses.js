const format = value => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : 'no disponible';
const money = value => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : 'no disponible';
const name = row => `${row.sku || row.name || 'Producto'}${row.sku && row.name ? ` (${row.name})` : ''}`;
const countLabel = (count, singular, plural) => `${format(count)} ${count === 1 ? singular : plural}`;
const dateLabel = value => {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'fecha no disponible';
};
const unsupportedClaimAnswer = intent => ({
  unsupported_supplier_causality: 'No tengo evidencia suficiente para afirmar que un proveedor se haya retrasado. El sistema no registra de forma verificable fechas prometidas y fechas reales de recepción para determinar incumplimientos o sus causas. Si me indicas el proveedor, puedo revisar sus productos y ofertas configuradas, pero eso no confirmaría un retraso.',
  forecast_confidence: 'El modelo entrega una predicción puntual, pero no expone una confianza exacta, probabilidad calibrada ni intervalo de predicción para este escenario. Sí puedo mostrar la demanda prevista, el stock de referencia y la recomendación de reposición; esos datos no equivalen a una medida de confianza.',
  unsupported_financial_impact: 'No puedo calcular una pérdida monetaria exacta por no comprar con los datos disponibles. El sistema muestra demanda prevista, stock y reposición recomendada, pero no cuenta con un modelo validado de ventas perdidas, margen ni probabilidad de demanda no atendida para convertir un faltante en dinero. Sí puedo mostrar esos indicadores operativos sin presentarlos como pérdida económica.'
}[intent] || 'No tengo evidencia suficiente para afirmar esa causa. Puedo mostrar los datos observados disponibles, pero no atribuir un motivo sin evidencia.');
const salesCausalityAnswer = (current, previous) => {
  if (!current?.data || !previous?.data) return 'No pude comparar ventas completadas para los periodos consultados. Aunque la comparación esté disponible, los datos de ventas por sí solos no permiten afirmar qué causó un cambio.';
  const periodText = result => `${dateLabel(result.metadata.period.startDate)}–${dateLabel(result.metadata.period.endDate)}`;
  const currencies = [...new Set([...(current.data.amountsByCurrency || []), ...(previous.data.amountsByCurrency || [])].map(row => row.currency))].sort();
  const byCurrency = result => new Map((result.data.amountsByCurrency || []).map(row => [row.currency, row.amount]));
  const currentAmounts = byCurrency(current), previousAmounts = byCurrency(previous);
  const compare = (left, right) => left < right ? 'disminuyeron' : left > right ? 'aumentaron' : 'se mantuvieron';
  const amountLines = currencies.length ? currencies.map(currency => {
    const before = previousAmounts.get(currency) || 0; const after = currentAmounts.get(currency) || 0;
    return `• Ventas en ${currency}: ${money(before)} → ${money(after)} (${compare(after, before)}).`;
  }) : ['• No se registraron importes de ventas en ninguno de los dos periodos.'];
  const priorUnits = Number.isFinite(previous.data.totalUnitsSold) ? previous.data.totalUnitsSold : 0;
  const currentUnits = Number.isFinite(current.data.totalUnitsSold) ? current.data.totalUnitsSold : 0;
  const units = `• Unidades vendidas: ${format(priorUnits)} → ${format(currentUnits)} (${compare(currentUnits, priorUnits)}).`;
  const priorCount = Number.isFinite(previous.data.completedSalesCount) ? previous.data.completedSalesCount : 0;
  const currentCount = Number.isFinite(current.data.completedSalesCount) ? current.data.completedSalesCount : 0;
  return [`Comparé ventas completadas del ${periodText(previous)} con el ${periodText(current)} (mismo tramo de días).`,
    ...amountLines, units, `• Ventas completadas: ${format(priorCount)} → ${format(currentCount)} (${compare(currentCount, priorCount)}).`,
    'Esta comparación muestra qué cambió, pero no permite determinar por qué. No hay evidencia registrada que atribuya la variación a una causa específica.'].join('\n');
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
const amounts = rows => (rows || []).map(row => `${money(row.amount)} ${row.currency}`).join('; ');
const dateTimeLabel = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${new Intl.DateTimeFormat('es-PE', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`
    : 'fecha no disponible';
};
const listFooter = (metadata, displayedCount) => metadata.truncated || displayedCount < metadata.returnedCount
  ? `Te muestro ${displayedCount === 1 ? 'el primer resultado' : `los ${displayedCount} primeros`}; puedes pedirme ampliar la lista.` : '';
const historicalNote = (rows, metadata) => {
  const anchors = [...new Set(rows.map(row => row.anchor || metadata.anchor).filter(Boolean))];
  return anchors.length ? `Estas ${anchors.length === 1 ? 'estimaciones y recomendaciones corresponden al escenario histórico con fecha de referencia' : 'estimaciones y recomendaciones corresponden a escenarios históricos con fechas de referencia'} ${anchors.map(dateLabel).join(' y ')}.` : '';
};
const historicalPriceNote = metadata => metadata.anchor
  ? `Propuesta basada en el forecast histórico con fecha de corte ${dateLabel(metadata.anchor)} y en los precios configurados consultados actualmente; no es una predicción actual ni una cotización confirmada.`
  : 'Los precios corresponden a la configuración consultada actualmente y no constituyen una cotización confirmada.';
const budgetPlanExplanation = result => {
  const data = result?.data;
  if (!data) return 'No tengo una propuesta de compra verificable para explicar.';
  const items = data.items || [];
  const statuses = [...new Set(items.map(item => item.inventoryStatus).filter(Boolean))];
  const statusText = statuses.length ? `Los productos seleccionados están en estado ${statuses.join(' y ')}.` : '';
  const partial = items.some(item => item.plannedQty < item.recommendedQty);
  const ordering = 'El orden prioriza primero REPONER sobre VIGILAR y OK; dentro de cada estado considera menor cobertura de stock frente a demanda, mayor déficit y cantidad recomendada, y usa el menor costo como desempate antes del orden estable por SKU.';
  const lines = items.slice(0, 5).map(item => `• ${item.sku} (${item.productName}): ${item.plannedQty === 1 ? '1 unidad planificada' : `${format(item.plannedQty)} unidades planificadas`} de ${format(item.recommendedQty)} recomendadas con ${item.supplierName}, a S/ ${money(item.unitCost)} por unidad (S/ ${money(item.plannedCost)} en total).`);
  const pricingDate = result.metadata?.pricingAsOf;
  const pricing = pricingDate ? `Los precios configurados se consultaron el ${dateTimeLabel(pricingDate)}; no son una cotización confirmada.`
    : 'La fecha de consulta de precios no está disponible; no es una cotización confirmada.';
  return [`La propuesta asigna S/ ${money(data.spent)} de S/ ${money(data.budget)} y deja S/ ${money(data.remaining)} sin asignar.`,
    statusText, ordering, partial ? 'El presupuesto cubrió algunos productos parcialmente; las cantidades recomendadas que no entraron en el presupuesto quedan pendientes.'
      : 'Las cantidades planificadas no superan las recomendaciones de reposición.', ...lines,
    result.metadata?.anchor ? `El forecast corresponde al escenario histórico con ancla ${dateLabel(result.metadata.anchor)}.` : '', pricing]
    .filter(Boolean).join('\n');
};
const budgetPlanFollowupAnswer = (plan, followupType, productRef) => {
  const amount = value => `S/ ${money(value)}`;
  switch (followupType) {
    case 'remaining': return `Quedan ${amount(plan.remaining)} sin asignar.`;
    case 'spent': return `El plan propuso asignar ${amount(plan.spent)} de ${amount(plan.budget)}; esta propuesta no registra una compra.`;
    case 'budget': return `El presupuesto de la propuesta fue ${amount(plan.budget)}.`;
    case 'planned_units': return `Se planificaron ${countLabel(plan.plannedUnits, 'unidad', 'unidades')} de compra.`;
    case 'pending_units': return plan.pendingUnits === null
      ? 'El snapshot de esta propuesta no conserva un total verificable de unidades pendientes.'
      : `Quedaron ${countLabel(plan.pendingUnits, 'unidad', 'unidades')} recomendadas pendientes de cubrir.`;
    case 'pending_items': {
      const pendingItems = plan.items.filter(item => item.pendingQty !== null && item.pendingQty > 0);
      const total = plan.pendingUnits === null ? ''
        : `Quedaron ${countLabel(plan.pendingUnits, 'unidad', 'unidades')} recomendadas pendientes de cubrir. `;
      const details = pendingItems.map(item => `${item.sku}: ${countLabel(item.pendingQty, 'unidad', 'unidades')} pendientes`).join('; ');
      if (!details) return `${total}El detalle guardado no permite enumerar productos que no entraron en la propuesta sin recalcularla.`.trim();
      return `${total}Entre los productos que la propuesta cubrió parcialmente: ${details}.`;
    }
    case 'supplier_for_product': {
      const key = String(productRef || '').trim().toLocaleLowerCase();
      const item = plan.items.find(row => row.sku.toLocaleLowerCase() === key || row.productName.toLocaleLowerCase() === key);
      return item ? `Para ${item.sku} (${item.productName}), la propuesta usaría ${item.supplierName}; costo configurado de ${amount(item.unitCost)} por unidad.`
        : `No encuentro «${String(productRef || 'ese producto').slice(0, 100)}» entre los productos seleccionados en esta propuesta. Indícame su SKU.`;
    }
    default: return 'No puedo resolver ese dato desde el plan guardado.';
  }
};
const replenishmentExplanation = result => {
  if (result.status === 'ML_NOT_READY') return buildSkillAnswer('get_demand_forecast', result);
  const row = result.data?.[0];
  if (!row) return buildSkillAnswer('get_demand_forecast', result);
  if (row.mlStatus !== 'READY') return `${name(row)} ${readinessLabel(row.mlStatus)}; no se puede justificar una cantidad numérica de reposición.`;
  return `${name(row)}: el modelo estimó ${format(row.predictedDemand7d)} unidades en el horizonte histórico agregado de 7 días. En la fecha de referencia había ${format(row.stockAtAnchor)} unidades; el stock de seguridad es ${format(row.safetyStock)} y se recomienda reponer ${format(row.recommendedQty)} unidades. La recomendación combina demanda prevista, stock disponible y stock de seguridad. ${historicalNote([row], result.metadata)}`;
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

const productCountAnswer = data => `Tienes ${countLabel(data.activeProducts, 'producto activo', 'productos activos')}.`;

/** Every displayed number is taken from a verified skill DTO; no ML recalculation. */
const buildSkillAnswer = (skillId, result) => {
  if (skillId === 'analyze_demand_forecast') return require('./forecastResponses').buildForecastAnalysisAnswer(result);
  const { data, metadata, status } = result;
  if (skillId === 'list_stock_alert_rules') {
    const note = 'Estas reglas se evalúan al cambiar el stock y registran alertas internas cuando se cruza la condición. Todavía no envían avisos automáticos.';
    if (!data.length) return `No tienes reglas de alerta de stock configuradas${metadata.sku ? ` para ${metadata.sku}` : ''}.\n${note}`;
    const count = metadata.totalMatches;
    return `Tienes ${count} ${count === 1 ? 'regla de alerta de stock configurada' : 'reglas de alerta de stock configuradas'}:\n`
      + data.map(row => `• ${row.sku} — stock ${row.operator} ${row.threshold} ${row.threshold === 1 ? 'unidad' : 'unidades'}.`).join('\n')
      + (metadata.truncated ? `\nMostrando ${metadata.returnedCount} de ${count} reglas.` : '') + `\n\n${note}`;
  }
  if (status === 'ML_NOT_READY') return 'Este negocio aún no cuenta con historial o configuración suficiente para generar predicciones.';
  if (skillId === 'get_replenishment_cost') {
    if (Array.isArray(data)) return metadata.clarificationQuestion || 'Indica el SKU exacto del producto.';
    if (data.sku) {
      const rule = { PREFERRED_SUPPLIER: 'Se utilizó el proveedor preferido configurado. ',
        USER_SPECIFIED: 'Se utilizó el proveedor que indicaste. ', LOWEST_VALID_PRICE: 'Se seleccionó la oferta válida de menor costo. ',
        USER_SPECIFIED_UNAVAILABLE: 'El proveedor indicado no tiene una oferta válida para este producto. ' }[data.selectionRule] || '';
      const match = data.supplierMatch && data.supplierMatch.requested !== data.selectedSupplier
        ? `Tomé «${data.supplierMatch.requested}» como ${data.selectedSupplier}. ` : '';
      return `${match}${data.sku} (${data.productName}): ${format(data.recommendedQty)} ${data.recommendedQty === 1 ? 'unidad' : 'unidades'} recomendadas × ${money(data.unitCost)} ${data.currency} = ${data.replenishmentCost === null ? 'costo no disponible' : `${money(data.replenishmentCost)} ${data.currency}`}.\n${rule}Proveedor: ${data.selectedSupplier || 'sin oferta utilizable'}. Stock al ancla: ${format(data.stockAtAnchor)}; demanda prevista: ${format(data.predictedDemand7d)}; estado: ${data.inventoryStatus || data.mlStatus}.\n${historicalPriceNote(metadata)}`;
    }
    const coverage = data.coverageProducts;
    return `Costo conocido para la reposición recomendada: ${money(data.knownCostSubtotal)} ${data.currency}. Productos considerados: ${data.consideredProducts}; con costo válido: ${data.costedProducts}; excluidos: ${data.excludedProducts}; unidades recomendadas: ${data.recommendedUnits}.${data.excludedProducts > 0 || coverage?.eligible > coverage?.costed ? ' El subtotal es incompleto porque hay productos sin costo utilizable o sin forecast READY.' : ''}\n${historicalPriceNote(metadata)}`;
  }
  if (skillId === 'compare_supplier_costs') {
    const offers = Array.isArray(data) ? data : [];
    if (!offers.length) return 'No encontré ofertas activas y válidas en PEN para ese producto.';
    const selected = offers.find(row => row.selected);
    const selectedNote = selected ? `Para una reposición normal, se utilizaría ${selected.supplier} porque ${selected.preferred
      ? 'es el proveedor preferido configurado' : 'es la oferta válida de menor costo'}.` : 'No hay un proveedor seleccionado.';
    return `Para ${offers[0].sku} (${offers[0].productName}) hay ${offers.length} proveedor${offers.length === 1 ? '' : 'es'} con ofertas válidas:\n${offers.map(row => `• ${row.supplier}: ${money(row.unitCost)} ${row.currency} por unidad${row.preferred ? '. Es el proveedor preferido configurado' : ''}${row.selected && !row.preferred ? '. Oferta seleccionada' : ''}.`).join('\n')}\n${selectedNote} Precios consultados: ${metadata.pricingAsOf ? dateTimeLabel(metadata.pricingAsOf) : 'fecha no disponible'}.`;
  }
  if (skillId === 'get_supplier_products') {
    if (Object.hasOwn(data, 'product')) {
      if (!data.product) return `No encontré el producto ${data.productRef} en el catálogo de este negocio.`;
      if (!data.product.hasOffer) return `El proveedor ${data.supplierName} existe, pero no tiene una oferta configurada para ${data.product.sku} (${data.product.productName}).`;
      const currency = data.product.currency === 'PEN' ? 'S/ ' : '';
      return `Sí. ${data.supplierName} tiene una oferta configurada para ${data.product.sku} (${data.product.productName}) por ${currency}${money(data.product.purchasePrice)} ${data.product.currency}${data.product.preferredForProduct ? '. Es el proveedor preferido configurado para este producto' : ''}. Este precio está configurado en el sistema y no es una cotización confirmada.`;
    }
    const items = data.items || [];
    if (!items.length) return `${data.supplierName} no tiene productos con ofertas configuradas en el catálogo de este negocio.`;
    const first = metadata.offset + 1, last = metadata.offset + items.length;
    const price = row => `${row.currency === 'PEN' ? 'S/ ' : ''}${money(row.purchasePrice)} ${row.currency}`;
    const lines = items.map(row => `• ${row.sku || 'Sin SKU'} — ${row.productName} — ${price(row)}${row.preferredForProduct ? ' (proveedor preferido configurado)' : ''}${row.active ? '' : ' (producto inactivo)'}`);
    return [`${data.supplierName} tiene ${countLabel(data.totalProducts, 'producto con oferta configurada', 'productos con ofertas configuradas')} en el sistema:`,
      ...lines, `Mostrando ${first}–${last} de ${data.totalProducts}. Los precios configurados no son cotizaciones confirmadas.${data.pagination?.hasMore ? ' Puedes decir «ver más» para continuar.' : ''}`].join('\n');
  }
  if (skillId === 'plan_replenishment_budget') {
    const items = data.items || [];
    const lines = items.map(row => `• ${row.sku} (${row.productName}): ${row.plannedQty === 1 ? '1 unidad' : `${format(row.plannedQty)} unidades`}/${format(row.recommendedQty)} con ${row.supplierName}, S/ ${money(row.plannedCost)}. ${row.reason}.`);
    const exclusionLabels = { NO_USABLE_OFFER: 'sin oferta utilizable', UNSUPPORTED_CURRENCY: 'moneda no admitida',
      PRODUCT_NOT_CONFIGURED: 'producto sin configuración de precio', INSUFFICIENT_HISTORY: 'historial insuficiente',
      ML_NOT_READY: 'forecast no listo' };
    const excluded = Object.entries(data.exclusionsByReason || {}).map(([reason, count]) =>
      `${count} ${exclusionLabels[reason.replace(/^FORECAST_/, '')] || (reason.startsWith('FORECAST_') ? 'forecast no listo' : 'sin oferta utilizable')}`);
    return [`Con S/ ${money(data.budget)}, la propuesta asigna S/ ${money(data.spent)} y deja S/ ${money(data.remaining)}.`,
      `${data.plannedUnits === 1 ? '1 unidad' : `${format(data.plannedUnits)} unidades`} planificadas; ${format(data.unplannedUnits)} quedan pendientes.`, ...lines,
      data.excludedProducts ? `No se pudieron costear ${data.excludedProducts} productos recomendados${excluded.length ? `: ${excluded.join('; ')}` : '.'}.` : '',
      historicalPriceNote(metadata)].filter(Boolean).join('\n');
  }
  if (skillId === 'get_sales_summary') return !data.completedSalesCount
    ? `No se registraron ventas completadas durante ${periodLabel(metadata)}.`
    : `Durante ${periodLabel(metadata)} registraste ${countLabel(data.completedSalesCount, 'venta completada', 'ventas completadas')}, con ${format(data.totalUnitsSold)} unidades vendidas. El importe de ventas es ${amounts(data.amountsByCurrency)}.`;
  if (skillId === 'get_product_sales_summary') return status === 'NO_DATA'
    ? `${name(data.product)} no registra ventas completadas durante ${periodLabel(metadata)}.`
    : `${name(data.product)} vendió ${format(data.totalUnitsSold)} unidades durante ${periodLabel(metadata)}. El importe correspondiente a ese producto es ${amounts(data.amountsByCurrency)}.`;
  if (skillId === 'get_product_details') return `${name(data)} tiene ${format(data.stock)} unidades disponibles y un mínimo configurado de ${format(data.minStockLevel)}. Su precio es ${money(data.price)} ${data.currency}. El producto está ${data.isActive ? 'activo' : 'inactivo'}.`;
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
    get_demand_forecast: 'Esta es la demanda estimada para el horizonte histórico agregado de 7 días del escenario consultado:',
    get_replenishment_candidates: `Te recomiendo priorizar ${displayed.length} ${displayed.length === 1 ? 'producto' : 'productos'} para reposición.\nLa mayor cantidad sugerida corresponde a ${name(displayed[0])}: ${format(displayed[0].recommendedQty)} unidades.`,
    search_products: `Encontré ${countLabel(metadata.totalMatches ?? data.length, 'producto', 'productos')} que ${metadata.totalMatches === 1 ? 'coincide' : 'coinciden'} con tu búsqueda:`
  };
  const header = headers[skillId] || 'Estos son los productos consultados:';
  const lines = displayed.map(row => {
    if (skillId === 'get_low_stock_products') return `• ${name(row)} tiene ${format(row.stock)} unidades disponibles${row.shortage > 0
      ? ` y necesita ${format(row.shortage)} más para alcanzar su mínimo de ${format(row.minStockLevel)}`
      : ` y está justo en su mínimo de ${format(row.minStockLevel)}`}.`;
    if (skillId === 'get_top_selling_products') return `• ${name(row)} — ${format(row.unitsSold)} unidades vendidas.`;
    if (skillId === 'get_recent_transactions') return `• ${dateLabel(row.date)}: ${row.type === 'sale' ? 'venta' : 'compra'} ${{ completed: 'completada', pending: 'pendiente', cancelled: 'cancelada' }[row.status] || 'con estado no disponible'} por ${money(row.total)} ${row.currency}, con ${row.itemCount} líneas de productos.`;
    if (skillId === 'get_demand_forecast' || skillId === 'get_replenishment_candidates') {
      if (row.mlStatus !== 'READY') return `• ${name(row)} ${readinessLabel(row.mlStatus)}; no hay predicción disponible.`;
      if (skillId === 'get_replenishment_candidates') return `• ${name(row)} — reponer ${format(row.recommendedQty)} unidades; demanda estimada de ${format(row.predictedDemand7d)} unidades y stock disponible de ${format(row.stockAtAnchor)} en la fecha de referencia.`;
      return `• ${name(row)}: el modelo estimó ${format(row.predictedDemand7d)} unidades en el horizonte histórico agregado de 7 días. En la fecha de referencia había ${format(row.stockAtAnchor)} unidades disponibles y se habían vendido ${format(row.salesLast7Days)} en los 7 días anteriores. Considerando ${format(row.safetyStock)} unidades de stock de seguridad, ${row.recommendedQty > 0 ? `se recomienda reponer ${format(row.recommendedQty)} unidades` : 'no se recomienda reposición para ese escenario'}.`;
    }
    return `• ${name(row)} tiene ${format(row.stock)} unidades disponibles y un mínimo configurado de ${format(row.minStockLevel)}.`;
  });
  const forecastSkill = ['get_demand_forecast', 'get_replenishment_candidates'].includes(skillId);
  return [header, ...lines, forecastSkill ? historicalNote(displayed, metadata) : '', listFooter(metadata, displayed.length)].filter(Boolean).join('\n');
};

const lowestUnitOffer = offers => [...offers].sort((a, b) => a.unitCost - b.unitCost
  || Number(b.preferred === true) - Number(a.preferred === true)
  || String(a.supplier).localeCompare(String(b.supplier)))[0];

const buildCheapestSupplierAnswer = result => {
  const offers = Array.isArray(result?.data) ? result.data.filter(row => Number.isFinite(row.unitCost) && row.unitCost >= 0) : [];
  if (!offers.length) return 'No encontré ofertas activas y válidas en PEN para ese producto.';
  const cheapest = lowestUnitOffer(offers);
  const row = offers[0];
  return `La oferta válida de menor costo para ${row.sku} (${row.productName}) es ${cheapest.supplier}: ${money(cheapest.unitCost)} ${cheapest.currency} por unidad.${cheapest.preferred ? ' También es el proveedor preferido configurado.' : ''} Precio configurado consultado: ${result.metadata.pricingAsOf ? dateTimeLabel(result.metadata.pricingAsOf) : 'fecha no disponible'}; no es una cotización confirmada.`;
};

const buildProductListSupplierComparisonAnswer = (result, comparisonType) => {
  if (result?.status === 'ML_NOT_READY') return 'No pude completar la comparación porque el forecast histórico del escenario no está listo. No inferí precios ni cantidades de reposición.';
  const rows = Array.isArray(result?.data) ? result.data : [];
  const canCompareTotal = comparisonType === 'replenishment_total_cost';
  const candidates = rows.flatMap(row => {
    const offers = Array.isArray(row.offers) ? row.offers.filter(offer => Number.isFinite(offer.unitCost)
      && offer.unitCost >= 0 && typeof offer.currency === 'string' && offer.currency) : [];
    if (canCompareTotal && (!Number.isSafeInteger(row.recommendedQty) || row.recommendedQty < 1)) return [];
    if (!offers.length) return [];
    const cheapest = lowestUnitOffer(offers);
    return [{ ...row, cheapest, comparisonCents: canCompareTotal
      ? Math.round(cheapest.unitCost * 100) * row.recommendedQty : Math.round(cheapest.unitCost * 100) }];
  });
  const noOffer = rows.filter(row => !Array.isArray(row.offers) || !row.offers.some(offer => Number.isFinite(offer.unitCost) && offer.unitCost >= 0));
  const lead = canCompareTotal ? 'costo total de reposición sugerida' : 'precio unitario de compra';
  if (!candidates.length) return canCompareTotal
    ? `No encontré productos de esa lista con una reposición sugerida y una oferta válida para comparar.`
    : `Ningún producto de esa lista tiene una oferta válida para comparar.`;
  const currencyGroups = new Map();
  for (const row of candidates) {
    if (!currencyGroups.has(row.cheapest.currency)) currencyGroups.set(row.cheapest.currency, []);
    currencyGroups.get(row.cheapest.currency).push(row);
  }
  const formatMoney = (cents, currency) => `${currency === 'PEN' ? 'S/ ' : ''}${money(cents / 100)} ${currency}`;
  const winnerText = (currency, group) => {
    const minimum = Math.min(...group.map(row => row.comparisonCents));
    const winners = group.filter(row => row.comparisonCents === minimum);
    return winners.map(row => canCompareTotal
      ? `• ${row.sku} (${row.productName}): ${formatMoney(row.comparisonCents, currency)} por ${row.recommendedQty} unidades con ${row.cheapest.supplier} (${formatMoney(Math.round(row.cheapest.unitCost * 100), currency)} por unidad).`
      : `• ${row.sku} (${row.productName}): ${row.cheapest.supplier}, ${formatMoney(row.comparisonCents, currency)} por unidad${row.cheapest.preferred ? ' (también es el proveedor preferido configurado)' : ''}.`);
  };
  const lines = [...currencyGroups].sort(([a], [b]) => a.localeCompare(b)).flatMap(([currency, group]) => winnerText(currency, group));
  const currencyNote = currencyGroups.size > 1
    ? 'Las monedas son distintas; no establezco un único ganador ni convierto importes entre ellas.' : '';
  const noOfferNote = noOffer.length
    ? `Sin oferta válida: ${noOffer.map(row => row.sku).join(', ')}.` : '';
  return [`De los productos de la lista, comparé el ${lead}:`, ...lines, currencyNote, noOfferNote,
    `Precios configurados consultados: ${result?.metadata?.pricingAsOf ? dateTimeLabel(result.metadata.pricingAsOf) : 'fecha no disponible'}; no son cotizaciones confirmadas.`]
    .filter(Boolean).join('\n');
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

module.exports = { buildSkillAnswer, buildCheapestSupplierAnswer, buildProductListSupplierComparisonAnswer, llmObservation, safeText, replenishmentExplanation,
  budgetPlanExplanation, budgetPlanFollowupAnswer, productCountAnswer, unsupportedClaimAnswer, salesCausalityAnswer };
