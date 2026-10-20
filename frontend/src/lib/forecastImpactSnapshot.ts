import { apiClient } from '@/lib/api';
import type { ForecastActiveModels, ForecastMlUpdateStatus, ForecastResponse } from '@/types/businessIntelligence';

export type ForecastImpactProduct = { sku: string; name: string; quantity: number };
export type ForecastImpactSnapshot = {
  context: { businessId: string | null; scenarioId: string | null; datasetVersion: string | null };
  complete: boolean;
  revision: string | null;
  capturedAt: string;
  horizons: Record<7 | 14, {
    pending: boolean | null;
    signals: number | null;
    activeVersion: number | null;
    eligibility: string | null;
    reasonCode: string | null;
    currentlyRunning: boolean | null;
    lastEvaluatedAt: string | null;
    lastResult: string | null;
  }>;
  forecasts: Record<string, { sku: string; name: string; seven: number | null; fourteen: number | null }>;
};

export function uniqueForecastImpactProducts(products: ForecastImpactProduct[]): ForecastImpactProduct[] {
  const bySku = new Map<string, ForecastImpactProduct>();
  for (const product of products) {
    const current = bySku.get(product.sku);
    if (current) current.quantity += product.quantity;
    else bySku.set(product.sku, { ...product });
  }
  return [...bySku.values()];
}

export async function readForecastImpactSnapshot(products: Array<Pick<ForecastImpactProduct, 'sku' | 'name'>>): Promise<ForecastImpactSnapshot> {
  const uniqueProducts = [...new Map(products.map(product => [product.sku, product])).values()];
  apiClient.invalidateIntelligenceReads();
  let failedReads = 0;
  const read = async <T,>(task: () => Promise<T>, extract: (value: T) => unknown): Promise<unknown | null> => {
    try {
      const value = extract(await task()) ?? null;
      if (value === null) failedReads += 1;
      return value;
    } catch { failedReads += 1; return null; }
  };
  const [revisionValue, statusValue, modelsValue, ...forecastValues] = await Promise.all([
    read(() => apiClient.getIntelligenceRevision(), value => value.success ? value.data : null),
    read(() => apiClient.getForecastMlUpdateStatus(), value => value.httpStatus === 200 ? value.data : null),
    read(() => apiClient.getForecastModelDiagnostics(), value => value.httpStatus === 200 ? value.data : null),
    ...uniqueProducts.flatMap(product => ([7, 14] as const).map(days =>
      read(() => apiClient.getBusinessIntelligenceForecast(product.sku, days), value => value.success ? value.data : null))),
  ]);
  const status = statusValue as ForecastMlUpdateStatus | null;
  const models = modelsValue as ForecastActiveModels | null;
  const horizon = (days: 7 | 14) => {
    const row = status?.horizons?.find(item => item.horizonDays === days);
    const active = models?.models?.find(item => item.horizonDays === days);
    return { pending: row ? row.pending : null,
      signals: Number.isSafeInteger(row?.readiness?.pendingSignalCount) ? row!.readiness!.pendingSignalCount : null,
      activeVersion: active?.modelVersion ?? row?.activeModelVersion ?? null,
      eligibility: row?.eligibility || row?.readiness?.status || null,
      reasonCode: row?.readiness?.reasonCode || row?.lastEvaluationReason || null,
      currentlyRunning: row ? row.currentlyRunning : null, lastEvaluatedAt: row?.lastEvaluatedAt || null,
      lastResult: row?.lastResult || null };
  };
  const forecasts: ForecastImpactSnapshot['forecasts'] = {};
  uniqueProducts.forEach((product, index) => {
    const seven = forecastValues[index * 2] as ForecastResponse | null;
    const fourteen = forecastValues[index * 2 + 1] as ForecastResponse | null;
    const liveRidgeUnits = (value: ForecastResponse | null) => value?.modelFamily === 'RIDGE_REGRESSION'
      && value.activeModelStatus === 'ACTIVE' && typeof value.predictionUnits === 'number' && Number.isFinite(value.predictionUnits)
      ? value.predictionUnits : null;
    forecasts[product.sku] = { sku: product.sku, name: seven?.product.name || fourteen?.product.name || product.name || product.sku,
      seven: liveRidgeUnits(seven), fourteen: liveRidgeUnits(fourteen) };
  });
  const revision = revisionValue as { businessId?: string; scenarioId?: string; datasetVersion?: string; dataVersion?: string } | null;
  return { context: { businessId: revision?.businessId || null, scenarioId: revision?.scenarioId || null,
      datasetVersion: revision?.datasetVersion || null },
    complete: failedReads === 0,
    revision: revision?.dataVersion || null,
    capturedAt: new Date().toISOString(), horizons: { 7: horizon(7), 14: horizon(14) }, forecasts };
}

export async function registerSaleWithImpact<T>(options: {
  products: ForecastImpactProduct[];
  captureBefore: (products: Array<Pick<ForecastImpactProduct, 'sku' | 'name'>>) => Promise<ForecastImpactSnapshot>;
  submit: () => Promise<T>;
  isSuccessful: (response: T) => boolean;
  onSuccess: (details: { response: T; products: ForecastImpactProduct[]; baseline: ForecastImpactSnapshot | null }) => void;
}): Promise<T> {
  const products = uniqueForecastImpactProducts(options.products);
  let baseline: ForecastImpactSnapshot | null = null;
  try { baseline = await options.captureBefore(products.map(({ sku, name }) => ({ sku, name }))); } catch { /* The sale remains available if diagnostics cannot be read. */ }
  const response = await options.submit();
  if (options.isSuccessful(response)) options.onSuccess({ response, products, baseline });
  return response;
}
