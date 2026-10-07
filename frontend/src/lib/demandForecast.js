const validMetric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** @param {import('../types').DemandForecastProduct[]} products */
const getForecastSummary = (products = []) => {
  const ready = products.filter(product => product.mlStatus === 'READY');
  return {
    total: products.length,
    ready: ready.length,
    restock: ready.filter(product => product.inventoryStatus === 'REPONER').length,
    watch: ready.filter(product => product.inventoryStatus === 'VIGILAR').length,
    ok: ready.filter(product => product.inventoryStatus === 'OK').length,
    totalDemand: ready.reduce((total, product) => total + (validMetric(product.predictedDemand7d) ? product.predictedDemand7d : 0), 0),
    totalRecommended: ready.reduce((total, product) => total + (validMetric(product.recommendedQty) ? product.recommendedQty : 0), 0),
  };
};

/**
 * @param {import('../types').DemandForecastProduct[]} products
 * @param {'predictedDemand7d' | 'recommendedQty'} metric
 */
const getTopForecastProducts = (products = [], metric = 'predictedDemand7d') => products
  .filter(product => product.mlStatus === 'READY' && validMetric(product[metric])
    && (metric !== 'recommendedQty' || product[metric] > 0))
  .slice()
  .sort((a, b) => b[metric] - a[metric] || a.sku.localeCompare(b.sku))
  .slice(0, 10);

/**
 * @param {import('../types').DemandForecastProduct[]} products
 * @param {string} search
 * @param {string} status
 * @param {string} sort
 */
const getVisibleForecastProducts = (products = [], search = '', status = 'all', sort = 'recommendedQty') => {
  const query = search.trim().toLocaleLowerCase('es');
  const order = { REPONER: 0, VIGILAR: 1, OK: 2, ML_NO_DISPONIBLE: 3 };
  return products.filter(product => (status === 'all' || product.inventoryStatus === status)
    && `${product.name} ${product.sku}`.toLocaleLowerCase('es').includes(query))
    .sort((a, b) => {
      if (sort === 'status') return (order[a.inventoryStatus] ?? 3) - (order[b.inventoryStatus] ?? 3)
        || a.sku.localeCompare(b.sku);
      const field = ['predictedDemand7d', 'recommendedQty', 'stockAtAnchor'].includes(sort) ? sort : 'recommendedQty';
      const aValue = validMetric(a[field]) ? a[field] : -1;
      const bValue = validMetric(b[field]) ? b[field] : -1;
      return bValue - aValue || a.sku.localeCompare(b.sku);
    });
};

/** @param {import('../types').DemandForecastProduct} product */
const getForecastExplanation = product => {
  if (product.mlStatus !== 'READY' || !validMetric(product.predictedDemand7d)
    || !validMetric(product.recommendedQty) || !validMetric(product.safetyStock)) {
    return 'Este producto aún no dispone de una predicción válida. Su historial o configuración deben estar preparados antes de interpretar una recomendación.';
  }
  const demand = formatForecastNumber(product.predictedDemand7d, 2);
  const stock = formatForecastNumber(product.stockAtAnchor, 0);
  const safety = formatForecastNumber(product.safetyStock, 2);
  const introduction = `El modelo estima una demanda de ${demand} unidades para los próximos 7 días. El stock disponible al ancla es ${stock} y el stock de seguridad es ${safety}.`;
  return product.recommendedQty === 0
    ? `${introduction} Actualmente el sistema no recomienda reposición.`
    : `${introduction} Considerando estos valores, el sistema recomienda reponer ${formatForecastNumber(product.recommendedQty, 0)} unidades.`;
};

const formatForecastNumber = (value, digits = 1) => (
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('es-PE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }) : '—'
);

const getStatusLabel = status => ({
  REPONER: 'REPONER',
  VIGILAR: 'VIGILAR',
  OK: 'OK',
  ML_NO_DISPONIBLE: 'ML NO DISPONIBLE',
}[status] || 'ML NO DISPONIBLE');

const getStatusClass = status => ({
  REPONER: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  VIGILAR: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  OK: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  ML_NO_DISPONIBLE: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
}[status] || 'border-slate-200 bg-slate-50 text-slate-700');

const getForecastErrorCopy = type => {
  if (type === 'not-ready') {
    return {
      title: 'Este negocio aún no cuenta con historial o configuración suficiente para generar predicciones.',
      description: 'La generación de predicciones estará disponible cuando los datos y la configuración estén preparados.',
      retry: false,
    };
  }
  if (type === 'unknown') {
    return {
      title: 'No se pudo cargar la predicción.',
      description: 'Inténtalo más tarde. Si el problema continúa, contacta con soporte.',
      retry: false,
    };
  }
  if (type === 'empty') {
    return {
      title: 'No hay productos disponibles para analizar.',
      description: 'No se encontraron productos elegibles para esta consulta.',
      retry: true,
    };
  }
  return {
    title: 'El servicio de predicción está iniciándose o no está disponible temporalmente.',
    description: 'El servicio de Machine Learning puede tardar unos segundos en iniciar. Vuelve a intentarlo.',
    retry: true,
  };
};

module.exports = { getForecastSummary, getTopForecastProducts, getVisibleForecastProducts, getForecastExplanation, formatForecastNumber, getStatusLabel, getStatusClass, getForecastErrorCopy };
