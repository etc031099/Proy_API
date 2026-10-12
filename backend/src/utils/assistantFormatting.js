const countLabel = (value, singular, plural = `${singular}s`) => `${value} ${value === 1 ? singular : plural}`;
const units = value => countLabel(value, 'unidad', 'unidades');
const money = (value, currency = 'PEN') => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'no disponible';
  const amount = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return currency === 'PEN' ? `S/ ${amount}` : `${amount} ${currency}`;
};
const ruleNote = 'Se evaluará automáticamente en futuros cambios de stock. Al cruzar la condición, genera una alerta para distribución automática. Telegram requiere integración conectada y la preferencia habilitada.';
module.exports = { countLabel, units, money, ruleNote };
