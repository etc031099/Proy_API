// Response contract only: no feature formulas or preprocessing in the browser.
export const RIDGE_FEATURE_VERSION = 'RIDGE_CAUSAL27_V1';
export const RIDGE_FEATURE_GROUPS = [
  { name: 'Producto / catálogo', keys: ['sku', 'categoryCode', 'subcategoryCode', 'brand', 'presentation', 'unit', 'sizeValue', 'containedUnits'] },
  { name: 'Calendario', keys: ['weekdayNext', 'weekendNextDays', 'monthNext', 'dayOfMonthNext', 'paydayDays', 'monthEndDays'] },
  { name: 'Ventas cerradas', keys: ['currentUnits', 'lag_1', 'lag_7', 'lag_14', 'lag_28', 'rollingMean_7', 'rollingMean_14', 'rollingMean_28', 'rollingStd_7', 'rollingStd_28', 'zeroSalesStreak', 'daysSinceLastSale', 'neverSoldInObservedWindow'] },
] as const;
export const RIDGE_FEATURE_ORDER = RIDGE_FEATURE_GROUPS.flatMap(group => [...group.keys]);
export type RidgeFeatureName = typeof RIDGE_FEATURE_ORDER[number];
export type RidgeFeatureInputs = Record<RidgeFeatureName, string | number>;

export function readRidgeFeatureInputs(value: unknown): RidgeFeatureInputs | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (RIDGE_FEATURE_ORDER.some((key, index) => index < 6
    ? typeof row[key] !== 'string' || !row[key]
    : typeof row[key] !== 'number' || !Number.isFinite(row[key]))) return null;
  return Object.fromEntries(RIDGE_FEATURE_ORDER.map(key => [key, row[key]])) as RidgeFeatureInputs;
}

export function compareRidgeFeatures(before: unknown, after: unknown) {
  const a = readRidgeFeatureInputs(before), b = readRidgeFeatureInputs(after);
  const rows = RIDGE_FEATURE_ORDER.map(key => ({ key, before: a?.[key] ?? null, after: b?.[key] ?? null,
    state: !a || !b ? 'No disponible' as const : a[key] === b[key] ? 'Sin cambio' as const : 'Cambió' as const }));
  return { rows, complete: Boolean(a && b),
    groups: RIDGE_FEATURE_GROUPS.map(group => ({ name: group.name, total: group.keys.length,
      changed: a && b ? group.keys.filter(key => a[key] !== b[key]).length : null })) };
}

type RidgeInferenceLike = {
  horizonDays?: unknown;
  featureVersion?: unknown;
  featureInputs?: unknown;
};

// Snapshot identity metadata may legitimately differ between BEFORE and AFTER.
// Comparability is about the exact feature contract and the same SKU/horizon.
export function compareRidgeInferenceFeatures(
  before: RidgeInferenceLike | null | undefined,
  after: RidgeInferenceLike | null | undefined,
  sku: string,
  horizonDays: 7 | 14,
) {
  const compatible = Boolean(before && after
    && before.horizonDays === horizonDays && after.horizonDays === horizonDays
    && before.featureVersion === RIDGE_FEATURE_VERSION && after.featureVersion === RIDGE_FEATURE_VERSION
    && readRidgeFeatureInputs(before.featureInputs)?.sku === sku
    && readRidgeFeatureInputs(after.featureInputs)?.sku === sku);
  return compatible
    ? compareRidgeFeatures(before!.featureInputs, after!.featureInputs)
    : compareRidgeFeatures(null, null);
}
