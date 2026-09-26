const getForecastSummary = (products = []) => ({
  total: products.length,
  ready: products.filter(product => product.mlStatus === 'READY').length,
  restock: products.filter(product => product.inventoryStatus === 'REPONER').length,
  watch: products.filter(product => product.inventoryStatus === 'VIGILAR').length,
  ok: products.filter(product => product.inventoryStatus === 'OK').length,
});

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

module.exports = { getForecastSummary, formatForecastNumber, getStatusLabel, getStatusClass };
