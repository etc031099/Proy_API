'use strict';

// Wire allowlist only. Feature formulas remain owned by build_live_features().
const FEATURE_VERSION = 'RIDGE_CAUSAL27_V1';
const FEATURE_HASH = '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5';
const CATEGORICAL = ['sku', 'categoryCode', 'subcategoryCode', 'brand', 'presentation', 'unit'];
const NUMERIC = ['sizeValue', 'containedUnits', 'weekdayNext', 'weekendNextDays', 'monthNext',
  'dayOfMonthNext', 'paydayDays', 'monthEndDays', 'currentUnits', 'lag_1', 'lag_7', 'lag_14',
  'lag_28', 'rollingMean_7', 'rollingMean_14', 'rollingMean_28', 'rollingStd_7', 'rollingStd_28',
  'zeroSalesStreak', 'daysSinceLastSale', 'neverSoldInObservedWindow'];

function projectRidgeFeatureInputs(row) {
  const inputs = row.featureInputs;
  if (row.status !== 'READY' || row.featureVersion !== FEATURE_VERSION || row.featureHash !== FEATURE_HASH
      || !inputs || typeof inputs !== 'object' || Array.isArray(inputs) || inputs.sku !== row.sku
      || CATEGORICAL.some(name => typeof inputs[name] !== 'string' || !inputs[name])
      || NUMERIC.some(name => typeof inputs[name] !== 'number' || !Number.isFinite(inputs[name]))) return null;
  return Object.fromEntries([...CATEGORICAL, ...NUMERIC].map(name => [name, inputs[name]]));
}

module.exports = { FEATURE_VERSION, FEATURE_HASH, CATEGORICAL, NUMERIC, projectRidgeFeatureInputs };
