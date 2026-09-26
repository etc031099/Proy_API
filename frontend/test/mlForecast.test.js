const assert = require('node:assert/strict');
const test = require('node:test');
const { formatForecastNumber, getForecastSummary, getStatusLabel } = require('../src/lib/demandForecast.js');

test('summarizes READY and inventory states without changing predictions', () => {
  const products = [
    { mlStatus: 'READY', inventoryStatus: 'REPONER' },
    { mlStatus: 'READY', inventoryStatus: 'OK' },
    { mlStatus: 'ML_NO_DISPONIBLE', inventoryStatus: 'ML_NO_DISPONIBLE' },
  ];
  assert.deepEqual(getForecastSummary(products), { total: 3, ready: 2, restock: 1, watch: 0, ok: 1 });
});

test('formats finite predictions for display and preserves unavailable values', () => {
  assert.equal(formatForecastNumber(0.8020370664, 2), new Intl.NumberFormat('es-PE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(0.8020370664));
  assert.equal(formatForecastNumber(null, 2), '—');
  assert.equal(formatForecastNumber(Infinity, 2), '—');
});

test('exposes human-readable ML status labels', () => {
  assert.equal(getStatusLabel('ML_NO_DISPONIBLE'), 'ML NO DISPONIBLE');
  assert.equal(getStatusLabel('REPONER'), 'REPONER');
});
