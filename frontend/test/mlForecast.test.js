/* eslint-disable @typescript-eslint/no-require-imports -- Node.js helper tests use CommonJS. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { formatForecastNumber, getForecastErrorCopy, getForecastSummary, getStatusLabel, getTopForecastProducts, getVisibleForecastProducts, getForecastExplanation } = require('../src/lib/demandForecast.js');

test('summarizes READY and inventory states without changing predictions', () => {
  const products = [
    { mlStatus: 'READY', inventoryStatus: 'REPONER' },
    { mlStatus: 'READY', inventoryStatus: 'OK' },
    { mlStatus: 'ML_NO_DISPONIBLE', inventoryStatus: 'ML_NO_DISPONIBLE' },
  ];
  assert.deepEqual(getForecastSummary(products), { total: 3, ready: 2, restock: 1, watch: 0, ok: 1, totalDemand: 0, totalRecommended: 0 });
});

const fixture = () => [
  { productId: '1', sku: 'ZERO', name: 'Sin demanda', mlStatus: 'READY', inventoryStatus: 'OK', predictedDemand7d: 0, recommendedQty: 0, safetyStock: 2, stockAtAnchor: 10 },
  { productId: '2', sku: 'MILK', name: 'Leche entera', mlStatus: 'READY', inventoryStatus: 'REPONER', predictedDemand7d: 48.75, recommendedQty: 41, safetyStock: 9.75, stockAtAnchor: 26 },
  { productId: '3', sku: 'RICE', name: 'Arroz', mlStatus: 'READY', inventoryStatus: 'VIGILAR', predictedDemand7d: 4.25, recommendedQty: 0, safetyStock: 1, stockAtAnchor: 6 },
  { productId: '4', sku: 'NEW', name: 'Producto nuevo', mlStatus: 'INSUFFICIENT_HISTORY', inventoryStatus: 'ML_NO_DISPONIBLE', predictedDemand7d: null, recommendedQty: null, safetyStock: null, stockAtAnchor: 0 },
];

test('dashboard totals and all three states use the full batch and preserve zero/missing semantics', () => {
  assert.deepEqual(getForecastSummary(fixture()), { total: 4, ready: 3, restock: 1, watch: 1, ok: 1, totalDemand: 53, totalRecommended: 41 });
  assert.deepEqual(getForecastSummary([]), { total: 0, ready: 0, restock: 0, watch: 0, ok: 0, totalDemand: 0, totalRecommended: 0 });
});

test('rankings use descending valid READY predictions and exclude zero restocking without mutating the batch', () => {
  const products = Object.freeze(fixture().map(Object.freeze));
  assert.deepEqual(getTopForecastProducts(products).map(item => item.sku), ['MILK', 'RICE', 'ZERO']);
  assert.deepEqual(getTopForecastProducts(products, 'recommendedQty').map(item => item.sku), ['MILK']);
  assert.deepEqual(products.map(item => item.sku), ['ZERO', 'MILK', 'RICE', 'NEW']);
  const many = Array.from({ length: 12 }, (_, index) => ({ ...products[0], sku: `SKU-${index}`, predictedDemand7d: index }));
  assert.equal(getTopForecastProducts(many).length, 10);
  assert.equal(getTopForecastProducts(many)[0].predictedDemand7d, 11);
});

test('explorer searches name or SKU and table filters/sorts do not affect global totals', () => {
  const products = fixture();
  assert.deepEqual(getVisibleForecastProducts(products, ' milk ').map(item => item.sku), ['MILK']);
  assert.deepEqual(getVisibleForecastProducts(products, 'entera').map(item => item.sku), ['MILK']);
  assert.deepEqual(getVisibleForecastProducts(products, '', 'VIGILAR').map(item => item.sku), ['RICE']);
  assert.equal(getVisibleForecastProducts(products, '', 'all', 'stockAtAnchor')[0].sku, 'MILK');
  assert.deepEqual(getVisibleForecastProducts(products, '', 'all', 'status').map(item => item.sku), ['MILK', 'RICE', 'ZERO', 'NEW']);
  assert.equal(getVisibleForecastProducts(products, 'missing').length, 0);
  assert.equal(getForecastSummary(products).total, 4);
});

test('explanation reports aggregate demand and the supplied recommendation without inventing causality', () => {
  const products = fixture();
  assert.equal(getForecastExplanation(products[1]), 'El modelo estima una demanda de 48.75 unidades para los próximos 7 días. El stock disponible al ancla es 26 y el stock de seguridad es 9.75. Considerando estos valores, el sistema recomienda reponer 41 unidades.');
  assert.match(getForecastExplanation(products[0]), /demanda de 0 unidades.*no recomienda reposición/);
  assert.match(getForecastExplanation(products[3]), /aún no dispone de una predicción válida/);
  assert.equal(getForecastExplanation(products[1]), getForecastExplanation(products[1]));
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

test('keeps ML_NOT_READY separate from temporary unavailability', () => {
  assert.equal(getForecastErrorCopy('not-ready').retry, false);
  assert.match(getForecastErrorCopy('not-ready').title, /historial/);
  assert.equal(getForecastErrorCopy('unavailable').retry, true);
  assert.match(getForecastErrorCopy('unavailable').title, /iniciándose|disponible/);
});
