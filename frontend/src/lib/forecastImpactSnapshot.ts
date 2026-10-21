import { apiClient } from '@/lib/api';
import type { ForecastMlUpdateStatus, ForecastResponse } from '@/types/businessIntelligence';
import { readRidgeFeatureInputs, RIDGE_FEATURE_VERSION, type RidgeFeatureInputs } from './ridgeFeatures';

export type ForecastImpactInference = {
  horizonDays: 7 | 14;
  status: string;
  predictionUnits: number | null;
  modelVersion: number | null;
  artifactHash: string | null;
  dataVersion: string | null;
  revision: string | null;
  snapshotHash: string | null;
  observationsThrough: string | null;
  observationsClosedThrough: string | null;
  dataCutoff: string | null;
  featureVersion: string | null;
  featureHash: string | null;
  featureInputs: RidgeFeatureInputs | null;
  trainedDataVersion: string | null;
  trainedAt: string | null;
  forecastStartDate: string | null;
  forecastEndDate: string | null;
  updatedAt: string | null;
};

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
  forecasts: Record<string, { sku: string; name: string; seven: number | null; fourteen: number | null;
    // Optional for session payloads captured before feature evidence was exposed.
    inferences?: Record<7 | 14, ForecastImpactInference | null> }>;
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
  const [revisionValue, statusValue, ...forecastValues] = await Promise.all([
    read(() => apiClient.getIntelligenceRevision(), value => value.success ? value.data : null),
    read(() => apiClient.getForecastMlUpdateStatus(), value => value.httpStatus === 200 ? value.data : null),
    ...uniqueProducts.flatMap(product => ([7, 14] as const).map(days =>
      read(() => apiClient.getBusinessIntelligenceForecast(product.sku, days), value => value.success ? value.data : null))),
  ]);
  const status = statusValue as ForecastMlUpdateStatus | null;
  const horizon = (days: 7 | 14) => {
    const row = status?.horizons?.find(item => item.horizonDays === days);
    const versions = Object.values(forecasts).map(item => item.inferences?.[days]?.modelVersion);
    return { pending: row ? row.pending : null,
      signals: Number.isSafeInteger(row?.readiness?.pendingSignalCount) ? row!.readiness!.pendingSignalCount : null,
      activeVersion: versions.length && versions.every(value => value != null && value === versions[0]) ? versions[0]! : null,
      eligibility: row?.eligibility || row?.readiness?.status || null,
      reasonCode: row?.readiness?.reasonCode || row?.lastEvaluationReason || null,
      currentlyRunning: row ? row.currentlyRunning : null, lastEvaluatedAt: row?.lastEvaluatedAt || null,
      lastResult: row?.lastResult || null };
  };
  const forecasts: ForecastImpactSnapshot['forecasts'] = {};
  uniqueProducts.forEach((product, index) => {
    const seven = forecastValues[index * 2] as ForecastResponse | null;
    const fourteen = forecastValues[index * 2 + 1] as ForecastResponse | null;
    const liveRidgeUnits = (value: ForecastResponse | null) => value?.status === 'READY' && value.modelFamily === 'RIDGE_REGRESSION'
      && value.activeModelStatus === 'ACTIVE' && typeof value.predictionUnits === 'number' && Number.isFinite(value.predictionUnits)
      ? value.predictionUnits : null;
    const inference = (value: ForecastResponse | null, days: 7 | 14): ForecastImpactInference | null => {
      const features = value ? readRidgeFeatureInputs(value.featureInputs) : null;
      const envelopeComparable = Boolean(value && value.mode === 'LIVE' && value.modelFamily === 'RIDGE_REGRESSION'
        && value.product.sku === product.sku && value.horizonDays === days);
      const featuresComparable = Boolean(envelopeComparable && value?.status === 'READY' && value.activeModelStatus === 'ACTIVE'
        && value.featureVersion === RIDGE_FEATURE_VERSION && features?.sku === product.sku);
      if (!envelopeComparable || !value) return null;
      return { horizonDays: days, status: value.status, predictionUnits: liveRidgeUnits(value),
        modelVersion: value.modelVersion ?? null, artifactHash: value.artifactHash ?? null,
        dataVersion: value.dataVersion ?? null, revision: value.dataVersion ?? null,
        snapshotHash: value.snapshotHash ?? null, observationsThrough: value.observationsThrough ?? null,
        observationsClosedThrough: value.observationsThrough ?? null, dataCutoff: value.dataCutoff ?? null,
        featureVersion: value.featureVersion ?? null, featureHash: value.featureHash ?? null,
        // Keep the raw vector when its own contract is valid. Snapshot/revision/hash
        // bindings are recorded separately and may differ across two valid reads.
        featureInputs: featuresComparable ? features : null,
        trainedDataVersion: value.trainedDataVersion ?? null, trainedAt: value.trainedAt ?? null,
        forecastStartDate: value.forecastStartDate ?? null, forecastEndDate: value.forecastEndDate ?? null,
        updatedAt: value.updatedAt ?? null };
    };
    const inferences = { 7: inference(seven, 7), 14: inference(fourteen, 14) };
    if (!inferences[7] || !inferences[14]) failedReads += 1;
    forecasts[product.sku] = { sku: product.sku, name: seven?.product.name || fourteen?.product.name || product.name || product.sku,
      seven: inferences[7]?.predictionUnits ?? null, fourteen: inferences[14]?.predictionUnits ?? null, inferences };
  });
  const revision = revisionValue as { businessId?: string; scenarioId?: string; datasetVersion?: string; dataVersion?: string } | null;
  const coherentRevision = Boolean(revision?.dataVersion && status?.dataVersion === revision.dataVersion
    && Object.values(forecasts).every(product => ([7, 14] as const).every(days =>
      product.inferences?.[days]?.dataVersion === revision.dataVersion)));
  return { context: { businessId: revision?.businessId || null, scenarioId: revision?.scenarioId || null,
      datasetVersion: revision?.datasetVersion || null },
    complete: failedReads === 0 && coherentRevision,
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
