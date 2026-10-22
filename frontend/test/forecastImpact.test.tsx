import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastImpactDetailCard, ForecastImpactSummaryCard, useForecastImpact } from '@/components/business-intelligence/ForecastImpactPanel';
import { apiClient } from '@/lib/api';
import { clearLatestForecastImpactSale, FORECAST_IMPACT_SESSION_KEY, publishForecastImpactSale, readLatestForecastImpactSale, type ForecastImpactSaleMessage } from '@/lib/forecastImpactChannel';
import { readForecastImpactSnapshot, registerSaleWithImpact, type ForecastImpactProduct, type ForecastImpactSnapshot, type ForecastImpactInference } from '@/lib/forecastImpactSnapshot';
import { RIDGE_FEATURE_ORDER, compareRidgeFeatures, compareRidgeInferenceFeatures, readRidgeFeatureInputs } from '@/lib/ridgeFeatures';

class TestBroadcastChannel {
  static channels: TestBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(name: string) { void name; TestBroadcastChannel.channels.push(this); }
  postMessage(data: unknown) { for (const channel of TestBroadcastChannel.channels) if (channel !== this) channel.onmessage?.({ data } as MessageEvent); }
  close() { TestBroadcastChannel.channels = TestBroadcastChannel.channels.filter(channel => channel !== this); }
}

function horizon(horizonDays: 7 | 14, pendingSignalCount: number, eligibility = 'NOT_MATURE') {
  return { horizonDays, activeModelVersion: 1, trainedDataVersion: '83', pending: true, currentlyRunning: false,
    trigger: 'AUTO' as const, lastRequestAt: null, lastAttemptAt: null, lastEvaluatedAt: null, lastResult: null,
    lastEvaluationReason: null, eligibility, nextEligibleAt: null, requestStatus: 'PENDING', dispatchStatus: null,
    availableOrigins: null, requiredOrigins: 107 as const,
    readiness: { status: 'WAITING_MATURITY', reasonCode: 'NOT_MATURE', hasPendingSignals: true, pendingSignalCount,
      pendingSignalTypes: ['SALE_COMPLETED'], firstPendingSignalAt: '2026-10-18T10:00:00Z', lastPendingSignalAt: '2026-10-18T10:00:00Z',
      pendingSince: '2026-10-18T10:00:00Z', lastDirtyAt: '2026-10-18T10:00:00Z', nextEligibleAt: null,
      latestMatureOrigin: '2026-10-11', lastTrainedMatureOrigin: '2026-10-10', processedRevision: '83', latestPendingRevision: '174',
      requiredOrigins: 107 as const, availableOriginsActual: null },
  };
}
function forecast(sku: string, value: number, days: 7 | 14 = 7, revision = '174') {
  return { success: true, data: { mode: 'LIVE', status: 'READY', product: { sku, name: `Producto ${sku}` },
    modelFamily: 'RIDGE_REGRESSION', activeModelStatus: 'ACTIVE', predictionUnits: value, method: 'RIDGE_REGRESSION',
    horizonDays: days, modelVersion: 1, dataVersion: revision, snapshotHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64),
    observationsThrough: '2026-10-18', dataCutoff: '2026-10-15', trainedDataVersion: '83', trainedAt: '2026-10-15T10:00:00Z',
    featureVersion: 'RIDGE_CAUSAL27_V1', featureHash: '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5',
    featureInputs: Object.fromEntries(RIDGE_FEATURE_ORDER.map((key, index) => [key, index < 6 ? key === 'sku' ? sku : 'descriptor' : index])) } };
}
function inference(sku: string, days: 7 | 14, revision: string, value: number): ForecastImpactInference {
  const row = forecast(sku, value, days, revision).data;
  return { ...row, horizonDays: days, revision, observationsClosedThrough: row.observationsThrough,
    featureInputs: readRidgeFeatureInputs(row.featureInputs), forecastStartDate: null, forecastEndDate: null, updatedAt: null };
}
function setSnapshotMocks(revision: string, signals: number, units: number) {
  vi.mocked(apiClient.getIntelligenceRevision).mockResolvedValue({ success: true, data: {
    businessId: 'demo', scenarioId: 'v3', datasetVersion: 'v1', asOf: '2026-10-19', dataVersion: revision,
  } });
  vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue({ httpStatus: 200, data: {
    dataVersion: revision, closedThrough: '2026-10-18', horizons: [horizon(7, signals), horizon(14, signals)],
  } as never });
  vi.mocked(apiClient.getForecastModelDiagnostics).mockResolvedValue({ httpStatus: 200, data: { models: [7, 14].map(horizonDays => ({
    horizonDays: horizonDays as 7 | 14, status: 'ACTIVE' as const, activeModelStatus: 'ACTIVE' as const,
    modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', modelVersion: 1,
  })) } });
  vi.mocked(apiClient.getBusinessIntelligenceForecast).mockImplementation(async (sku, days) => forecast(sku, units + (sku === 'SKU-B' ? days : 0), days as 7 | 14, revision) as never);
}
function Harness({ navigate = vi.fn() }: { navigate?: (tab: 'forecast' | 'inventory' | 'sales' | 'customers' | 'related') => void }) {
  const impact = useForecastImpact();
  return <><ForecastImpactSummaryCard impact={impact} onNavigate={navigate} /><ForecastImpactDetailCard impact={impact} /></>;
}
const products: ForecastImpactProduct[] = [
  { sku: 'SKU-A', name: 'Producto A', quantity: 1 },
  { sku: 'SKU-B', name: 'Producto B', quantity: 2 },
  { sku: 'SKU-A', name: 'Producto A', quantity: 2 },
];
function baseline(revision = '173', signals = 90, seven = 4.9, fourteen = 10.4): ForecastImpactSnapshot {
  const h = () => ({ pending: true, signals, activeVersion: 1, eligibility: 'NOT_MATURE', reasonCode: 'NOT_MATURE',
    currentlyRunning: false, lastEvaluatedAt: null, lastResult: null });
  return { context: { businessId: 'demo', scenarioId: 'v3', datasetVersion: 'v1' }, complete: true, revision, capturedAt: '2026-10-19T16:00:00Z', horizons: { 7: h(), 14: h() }, forecasts: {
    'SKU-A': { sku: 'SKU-A', name: 'Producto A', seven, fourteen,
      inferences: { 7: inference('SKU-A', 7, revision, seven), 14: inference('SKU-A', 14, revision, fourteen) } },
    'SKU-B': { sku: 'SKU-B', name: 'Producto B', seven: seven + 1, fourteen: fourteen + 1,
      inferences: { 7: inference('SKU-B', 7, revision, seven + 1), 14: inference('SKU-B', 14, revision, fourteen + 1) } },
  } };
}

describe('forecast impact observation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearLatestForecastImpactSale();
    TestBroadcastChannel.channels = [];
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
    vi.spyOn(apiClient, 'getIntelligenceRevision');
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus');
    vi.spyOn(apiClient, 'getForecastModelDiagnostics');
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast');
    vi.spyOn(apiClient, 'getProductOperationDetail');
    vi.spyOn(apiClient, 'analyzeMlTestScenario');
    vi.spyOn(apiClient, 'createMlTestCheckpoint');
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint');
    vi.spyOn(apiClient, 'requestForecastMlUpdate');
  });

  it('keeps the no-operation state compact instead of rendering unavailable comparison rows', () => {
    render(<Harness />);
    expect(screen.getByText(/Sin venta reciente disponible/)).toBeTruthy();
    expect(screen.queryByText('Revisión')).toBeNull();
    expect(screen.queryByText('Señales pendientes 7d')).toBeNull();
  });

  it('captures automatically before one-SKU sale POST and publishes only after success', async () => {
    const sequence: string[] = [];
    const captured = baseline();
    const result = await registerSaleWithImpact({ products: [products[0]],
      captureBefore: async skuProducts => { sequence.push(`before:${skuProducts.map(item => item.sku).join(',')}`); return captured; },
      submit: async () => { sequence.push('post'); return { success: true }; }, isSuccessful: response => response.success,
      onSuccess: ({ response, baseline: value, products: affected }) => {
        publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: 'tx-1', occurredAt: '2026-10-19T17:00:00Z',
          hasCustomer: false, customerRef: null, products: affected, baseline: value, baselineUnavailable: value === null || !value.complete,
          context: value?.context || { businessId: null, scenarioId: null, datasetVersion: null } });
        sequence.push(`publish:${response.success}:${value?.revision}:${affected.length}`);
      } });
    expect(result.success).toBe(true);
    expect(sequence).toEqual(['before:SKU-A', 'post', 'publish:true:173:1']);
    expect(readLatestForecastImpactSale()?.baseline?.revision).toBe('173');
  });

  it('captures both unique SKUs, aggregates duplicate lines and quantities greater than one', async () => {
    const captureBefore = vi.fn(async () => baseline());
    const onSuccess = vi.fn();
    await registerSaleWithImpact({ products, captureBefore, submit: async () => ({ success: true }),
      isSuccessful: response => response.success, onSuccess });
    expect(captureBefore).toHaveBeenCalledWith([{ sku: 'SKU-A', name: 'Producto A' }, { sku: 'SKU-B', name: 'Producto B' }]);
    expect(onSuccess.mock.calls[0][0].products).toEqual([
      { sku: 'SKU-A', name: 'Producto A', quantity: 3 }, { sku: 'SKU-B', name: 'Producto B', quantity: 2 },
    ]);
  });

  it('does not publish impact after a failed sale POST', async () => {
    const onSuccess = vi.fn();
    await registerSaleWithImpact({ products: [products[0]], captureBefore: async () => baseline(),
      submit: async () => ({ success: false }), isSuccessful: response => response.success, onSuccess });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(FORECAST_IMPACT_SESSION_KEY)).toBeNull();
  });

  it('continues the sale with no baseline if read-only capture fails', async () => {
    const onSuccess = vi.fn();
    await registerSaleWithImpact({ products: [products[0]], captureBefore: async () => { throw new Error('diagnostic unavailable'); },
      submit: async () => ({ success: true }), isSuccessful: response => response.success, onSuccess });
    expect(onSuccess.mock.calls[0][0].baseline).toBeNull();
  });

  it('recovers the last successful impact from session storage after dashboard unmount and remount', async () => {
    setSnapshotMocks('174', 91, 4.92);
    const savedBaseline = baseline();
    publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: 'saved-sale', occurredAt: '2026-10-19T17:00:00Z',
      hasCustomer: true, customerRef: 'customer-ref', baseline: savedBaseline, baselineUnavailable: false, context: savedBaseline.context,
      products: [{ sku: 'SKU-A', name: 'Producto A', quantity: 2 }, { sku: 'SKU-B', name: 'Producto B', quantity: 1 }] });
    const firstMount = render(<Harness />);
    await waitFor(() => expect(document.body.textContent).toContain('173 → 174'));
    firstMount.unmount();
    render(<Harness />);
    await waitFor(() => expect(document.body.textContent).toContain('90 → 91'));
    expect(document.body.textContent).toContain('Producto A · SKU-A');
    expect(document.body.textContent).toContain('Producto B · SKU-B');
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledWith('SKU-A', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledWith('SKU-B', 14);
    expect(document.body.textContent).toContain('2 producto(s) · 3 unidad(es)');
  });

  it('ignores and removes corrupt or incompatible session payloads', () => {
    window.sessionStorage.setItem(FORECAST_IMPACT_SESSION_KEY, '{bad json');
    render(<Harness />);
    expect(readLatestForecastImpactSale()).toBeNull();
    expect(window.sessionStorage.getItem(FORECAST_IMPACT_SESSION_KEY)).toBeNull();
    expect(apiClient.getIntelligenceRevision).not.toHaveBeenCalled();
    window.sessionStorage.setItem(FORECAST_IMPACT_SESSION_KEY, JSON.stringify({ version: 1, type: 'SALE_COMPLETED' }));
    expect(readLatestForecastImpactSale()).toBeNull();
    expect(window.sessionStorage.getItem(FORECAST_IMPACT_SESSION_KEY)).toBeNull();
  });

  it('does not render a saved sale from another business/scenario/dataset context', async () => {
    setSnapshotMocks('174', 91, 4.92);
    const otherBaseline = { ...baseline(), context: { businessId: 'other-business', scenarioId: 'other-scenario', datasetVersion: 'other-v' } };
    publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: 'foreign-sale', occurredAt: '2026-10-19T17:00:00Z',
      hasCustomer: true, customerRef: 'private-ref', baseline: otherBaseline, baselineUnavailable: false, context: otherBaseline.context,
      products: [{ sku: 'FOREIGN-SKU', name: 'Producto de otro contexto', quantity: 1 }] });
    render(<Harness />);
    await waitFor(() => expect(window.sessionStorage.getItem(FORECAST_IMPACT_SESSION_KEY)).toBeNull());
    expect(document.body.textContent).not.toContain('Producto de otro contexto');
  });

  it('keeps the successful sale and an explicit baseline-unavailable state in the session payload', async () => {
    setSnapshotMocks('174', 91, 4.92);
    const onSuccess = vi.fn(({ baseline: value, products: affected }) => publishForecastImpactSale({ version: 2,
      type: 'SALE_COMPLETED', transactionId: 'sale-without-before', occurredAt: '2026-10-19T17:00:00Z',
      hasCustomer: false, customerRef: null, products: affected, baseline: value, baselineUnavailable: value === null || !value.complete,
      context: { businessId: 'demo', scenarioId: 'v3', datasetVersion: 'v1' } }));
    await registerSaleWithImpact({ products: [products[0]], captureBefore: async () => { throw new Error('before unavailable'); },
      submit: async () => ({ success: true }), isSuccessful: result => result.success, onSuccess });
    expect(readLatestForecastImpactSale()?.baselineUnavailable).toBe(true);
    render(<Harness />);
    expect(await screen.findByText('Estado previo no disponible; la venta sí se registró.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('No disponible → 174');
    expect(document.body.textContent).toContain('Captura BEFORE histórica');
    expect(document.body.textContent).toContain('No disponible; no se presenta como cambio');
  });

  it('loads durable movement and Ridge evidence only when expanded and binds it to the exact transaction and SKU', async () => {
    const transactionId = '507f1f77bcf86cd799439011';
    const before = baseline();
    const sale: ForecastImpactSaleMessage = { version: 2, type: 'SALE_COMPLETED', transactionId,
      occurredAt: '2026-10-19T17:00:00Z', hasCustomer: false, customerRef: null, baseline: before,
      baselineUnavailable: false, context: before.context, products: [products[0]] };
    vi.mocked(apiClient.getProductOperationDetail).mockResolvedValue({ httpStatus: 200, data: {
      operation: { operationId: `SALE:${transactionId}`, sourceId: transactionId, type: 'SALE' },
      facts: { product: { sku: 'SKU-A', name: 'Producto A' } },
      inventoryMovements: [{ quantityDelta: -1, stockBefore: 12, stockAfter: 11, occurredAt: sale.occurredAt }],
      ridgeEvidence: { status: 'persisted', horizons: [{ eventType: 'SALE_COMPLETED', horizonDays: 7, dataVersion: '174', historicalCorrection: false }] },
      traceability: { revision: '174', relationQuality: 'EXACT' },
    } } as never);
    render(<ForecastImpactDetailCard impact={{ baseline: before, after: baseline('174'), sale, pendingSale: null,
      allowUnknownScope: false, loadingAfter: false, error: null, retryAfterSale: vi.fn() }} />);
    expect(apiClient.getProductOperationDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(`Evidencia de la transacción · SKU-A`));
    await waitFor(() => expect(apiClient.getProductOperationDetail).toHaveBeenCalledWith('SKU-A', `SALE:${transactionId}`, expect.any(AbortSignal)));
    expect(await screen.findByText(/stock 12 → 11/)).toBeTruthy();
    expect(screen.getByText(/Ridge 7d · dataVersion 174/)).toBeTruthy();
  });

  it('retries a failed AFTER read without losing the BEFORE baseline', async () => {
    setSnapshotMocks('174', 91, 4.92);
    vi.mocked(apiClient.getBusinessIntelligenceForecast).mockRejectedValueOnce(new Error('temporary read failure'));
    const savedBaseline = baseline();
    publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: 'retry-sale', occurredAt: '2026-10-19T17:00:00Z',
      hasCustomer: false, customerRef: null, baseline: savedBaseline, baselineUnavailable: false, context: savedBaseline.context,
      products: [{ sku: 'SKU-A', name: 'Producto A', quantity: 1 }] });
    render(<Harness />);
    expect(await screen.findByText('La lectura posterior quedó incompleta.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar lectura' }));
    await waitFor(() => expect(document.body.textContent).toContain('173 → 174'));
    expect(document.body.textContent).toContain('4.9 → 4.92');
    expect(document.body.textContent).not.toContain('Estado previo no disponible');
  });

  it('reads AFTER for every SKU in the event without requiring a Predicción selection', async () => {
    setSnapshotMocks('174', 91, 4.92);
    render(<Harness />);
    const before = baseline();
    const sale: ForecastImpactSaleMessage = { version: 2, type: 'SALE_COMPLETED', transactionId: 'transaction-12345678',
      occurredAt: '2026-10-19T17:00:00.000Z', hasCustomer: true, customerRef: 'customer-ref', baseline: before,
      baselineUnavailable: false, context: before.context,
      products: [{ sku: 'SKU-A', name: 'Producto A', quantity: 1 }, { sku: 'SKU-B', name: 'Producto B', quantity: 2 }] };
    act(() => publishForecastImpactSale(sale));
    await waitFor(() => expect(document.body.textContent).toContain('173 → 174'));
    expect(document.body.textContent).toContain('90 → 91');
    expect(document.body.textContent?.match(/ACTIVE · RIDGE_REGRESSION · v1 → ACTIVE · RIDGE_REGRESSION · v1/g)).toHaveLength(4);
    expect(document.body.textContent).toContain('4.9 → 4.92');
    expect(document.body.textContent).toContain('5.9 → 11.92');
    expect(document.body.textContent).toContain('2 producto(s) · 3 unidad(es)');
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledWith('SKU-A', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledWith('SKU-A', 14);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledWith('SKU-B', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledWith('SKU-B', 14);
    expect(apiClient.analyzeMlTestScenario).not.toHaveBeenCalled();
    expect(apiClient.createMlTestCheckpoint).not.toHaveBeenCalled();
  });

  it('a newer successful sale replaces the previous comparison instead of mixing baselines', async () => {
    setSnapshotMocks('180', 93, 5.1);
    render(<Harness />);
    act(() => publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: 'first-sale', occurredAt: '2026-10-19T17:00:00Z',
      hasCustomer: false, customerRef: null, baseline: baseline('173'), baselineUnavailable: false, context: baseline().context,
      products: [{ sku: 'SKU-A', name: 'Producto A', quantity: 1 }] }));
    await waitFor(() => expect(document.body.textContent).toContain('173 → 180'));
    act(() => publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: 'second-sale', occurredAt: '2026-10-19T18:00:00Z',
      hasCustomer: false, customerRef: null, baseline: baseline('179'), baselineUnavailable: false, context: baseline().context,
      products: [{ sku: 'SKU-B', name: 'Producto B', quantity: 2 }] }));
    await waitFor(() => expect(document.body.textContent).toContain('179 → 180'));
    expect(document.body.textContent).not.toContain('173 → 180');
    expect(document.body.textContent).toContain('Producto B · SKU-B');
    expect(readLatestForecastImpactSale()?.transactionId).toBe('second-sale');
  });

  it('keeps Ridge sources limited to LIVE 7d/14d without MA28 or local-test calls', async () => {
    setSnapshotMocks('173', 90, 4.92);
    await readForecastImpactSnapshot([{ sku: 'SKU-A', name: 'Producto A' }]);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(1, 'SKU-A', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(2, 'SKU-A', 14);
    expect(apiClient.getForecastModelDiagnostics).not.toHaveBeenCalled();
    expect(apiClient.createMlTestCheckpoint).not.toHaveBeenCalled();
    expect(apiClient.restoreMlTestCheckpoint).not.toHaveBeenCalled();
    expect(apiClient.requestForecastMlUpdate).not.toHaveBeenCalled();
  });

  function renderComparison(before: ForecastImpactSnapshot | null, after: ForecastImpactSnapshot | null, saleProducts = [products[0]]) {
    const sale: ForecastImpactSaleMessage = { version: 2, type: 'SALE_COMPLETED', transactionId: 'feature-sale',
      occurredAt: '2026-10-19T17:00:00Z', hasCustomer: false, customerRef: null, products: saleProducts,
      baseline: before, baselineUnavailable: !before?.complete, context: before?.context || baseline().context };
    render(<ForecastImpactDetailCard impact={{ baseline: before, after, sale, pendingSale: null, allowUnknownScope: false,
      loadingAfter: false, error: null, retryAfterSale: vi.fn() }} />);
  }

  it('preserves each inference binding, raw vector and distinct horizon without another request', async () => {
    setSnapshotMocks('193', 104, 7.65);
    const snapshot = await readForecastImpactSnapshot([products[0]]);
    const seven = snapshot.forecasts['SKU-A'].inferences![7]!;
    const fourteen = snapshot.forecasts['SKU-A'].inferences![14]!;
    expect(seven.dataVersion).toBe('193'); expect(seven.revision).toBe('193');
    expect(seven.observationsClosedThrough).toBe('2026-10-18');
    expect(seven.snapshotHash).toBe('a'.repeat(64)); expect(seven.featureVersion).toBe('RIDGE_CAUSAL27_V1');
    expect(Object.keys(seven.featureInputs!)).toEqual(RIDGE_FEATURE_ORDER);
    expect(seven.horizonDays).toBe(7); expect(fourteen.horizonDays).toBe(14);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
    expect(apiClient.getIntelligenceRevision).toHaveBeenCalledTimes(1);
    expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1);
    expect(apiClient.getForecastModelDiagnostics).not.toHaveBeenCalled();
  });

  it('retains a valid feature vector when optional identity hashes are absent', async () => {
    setSnapshotMocks('193', 104, 7.65);
    vi.mocked(apiClient.getBusinessIntelligenceForecast).mockImplementation(async (sku, days) => {
      const response = forecast(sku, 7.65, days as 7 | 14, '193');
      Object.assign(response.data, { snapshotHash: null, artifactHash: null, featureHash: null, dataVersion: null });
      return response as never;
    });
    const snapshot = await readForecastImpactSnapshot([products[0]]);
    expect(snapshot.forecasts['SKU-A'].inferences![7]!.featureInputs).not.toBeNull();
    expect(snapshot.forecasts['SKU-A'].inferences![14]!.featureInputs).not.toBeNull();
    expect(snapshot.complete).toBe(false);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
  });

  it('never substitutes status or another horizon metadata for the inference binding', async () => {
    setSnapshotMocks('193', 104, 7.65);
    vi.mocked(apiClient.getBusinessIntelligenceForecast).mockImplementation(async (sku, days) => {
      const response = forecast(sku, days === 7 ? 7.65 : 15.89, days as 7 | 14, days === 7 ? '192' : '194');
      response.data.modelVersion = days === 7 ? 1 : 2;
      response.data.featureInputs.weekendNextDays = days === 7 ? 2 : 4;
      return response as never;
    });
    const snapshot = await readForecastImpactSnapshot([products[0]]);
    expect(snapshot.revision).toBe('193');
    expect(snapshot.forecasts['SKU-A'].inferences![7]!.dataVersion).toBe('192');
    expect(snapshot.forecasts['SKU-A'].inferences![14]!.dataVersion).toBe('194');
    expect(snapshot.forecasts['SKU-A'].inferences![7]!.featureInputs!.weekendNextDays).toBe(2);
    expect(snapshot.forecasts['SKU-A'].inferences![14]!.featureInputs!.weekendNextDays).toBe(4);
    expect(snapshot.forecasts['SKU-A'].inferences![14]!.modelVersion).toBe(2);
    expect(snapshot.complete).toBe(false);
  });

  it('explains an open-day sale only with equal bound inputs, cutoffs, artifacts and raw predictions', () => {
    const before = baseline('192', 103), after = baseline('193', 104);
    renderComparison(before, after);
    expect(screen.getAllByText('0 de 8 modificadas')).toHaveLength(2);
    expect(screen.getAllByText('0 de 6 modificadas')).toHaveLength(2);
    expect(screen.getAllByText('0 de 13 modificadas')).toHaveLength(2);
    const table = screen.getByRole('table', { name: 'Entradas vigentes Ridge 7d', hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(28);
    expect(screen.getByText(/La venta añadió evidencia pendiente, pero el día actual todavía está abierto/)).toBeTruthy();
    expect(document.body.textContent).toContain('4.9 → 4.9');
    expect(document.body.textContent).toContain('10.4 → 10.4');
  });

  it('compares valid vectors when revision, dataVersion and snapshotHash differ between reads', () => {
    const before = baseline('193', 104), after = baseline('194', 105);
    after.forecasts['SKU-A'].inferences![7]!.snapshotHash = 'c'.repeat(64);
    after.forecasts['SKU-A'].inferences![14]!.snapshotHash = 'd'.repeat(64);
    renderComparison(before, after);
    expect(screen.getAllByText('0 de 8 modificadas')).toHaveLength(2);
    expect(screen.getAllByText('0 de 6 modificadas')).toHaveLength(2);
    expect(screen.getAllByText('0 de 13 modificadas')).toHaveLength(2);
    expect(document.body.textContent).toContain('193 → 194');
  });

  it('keeps feature comparisons visible when a global snapshot is partial, without claiming full causality', () => {
    const before = baseline('193', 104), after = baseline('194', 105);
    after.complete = false;
    renderComparison(before, after);
    expect(screen.getAllByText('0 de 8 modificadas')).toHaveLength(2);
    expect(screen.getAllByText('0 de 6 modificadas')).toHaveLength(2);
    expect(screen.getAllByText('0 de 13 modificadas')).toHaveLength(2);
    expect(screen.queryByText(/por eso P7 y P14 permanecieron iguales/)).toBeNull();
  });

  it.each([
    ['different feature version', { featureVersion: 'OTHER' }, {}],
    ['different SKU', {}, { featureInputs: readRidgeFeatureInputs(forecast('SKU-B', 1).data.featureInputs) }],
    ['different horizon', { horizonDays: 14 }, {}],
    ['incomplete vector', { featureInputs: null }, {}],
  ])('marks %s as incomparable', (_label, beforeChanges, afterChanges) => {
    const before = inference('SKU-A', 7, '193', 4.9);
    const after = inference('SKU-A', 7, '194', 4.9);
    Object.assign(before, beforeChanges);
    Object.assign(after, afterChanges);
    expect(compareRidgeInferenceFeatures(before, after, 'SKU-A', 7).complete).toBe(false);
  });

  it('compares received calendar, closed-sales and admissible catalog changes without formulas', () => {
    const before = baseline(), after = baseline('174', 91);
    after.forecasts['SKU-A'].inferences![7]!.featureInputs!.currentUnits = 50;
    after.forecasts['SKU-A'].inferences![7]!.featureInputs!.weekdayNext = 4;
    after.forecasts['SKU-A'].inferences![7]!.featureInputs!.brand = 'Nueva marca';
    after.forecasts['SKU-A'].inferences![7]!.observationsClosedThrough = '2026-10-19';
    renderComparison(before, after);
    expect(screen.getByText('1 de 8 modificadas')).toBeTruthy();
    expect(screen.getByText('1 de 6 modificadas')).toBeTruthy();
    expect(screen.getByText('1 de 13 modificadas')).toBeTruthy();
    expect(screen.getByText(/Ridge 7d: 1 entrada modificada en producto/)).toBeTruthy();
    expect(screen.queryByText(/por eso P7 y P14 permanecieron iguales/)).toBeNull();
  });

  it.each(['BEFORE', 'AFTER'] as const)('missing %s inputs never asserts full equality or discards the other side', side => {
    const before = baseline(), after = baseline('174', 91);
    (side === 'BEFORE' ? before : after).forecasts['SKU-A'].inferences![7]!.featureInputs = null;
    renderComparison(before, after);
    if (side === 'BEFORE') {
      expect(screen.getAllByText('13 entradas actuales')).toHaveLength(1);
      expect(screen.getByText(/BEFORE histórico no disponible; no se calcula diferencia/)).toBeTruthy();
    } else {
      expect(screen.getAllByText('Lectura actual no disponible')).toHaveLength(3);
    }
    expect(document.body.textContent).toContain('173 → 174');
    expect(screen.queryByText(/por eso P7 y P14 permanecieron iguales/)).toBeNull();
  });

  it.each(['BEFORE', 'AFTER'] as const)('a partial %s snapshot still compares its valid vectors but avoids the open-day conclusion', side => {
    const before = baseline('192', 103), after = baseline('193', 104);
    (side === 'BEFORE' ? before : after).complete = false;
    renderComparison(before, after);
    expect(screen.getAllByText('0 de 8 modificadas')).toHaveLength(2);
    expect(screen.getAllByText('0 de 6 modificadas')).toHaveLength(2);
    expect(screen.getAllByText('0 de 13 modificadas')).toHaveLength(2);
    expect(document.body.textContent).toContain('192 → 193');
    expect(screen.queryByText(/por eso P7 y P14 permanecieron iguales/)).toBeNull();
  });

  it('stores the complete BEFORE inference evidence and recovers it without a separate model read', () => {
    const before = baseline();
    publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: 'evidence',
      occurredAt: '2026-10-19T17:00:00Z', hasCustomer: false, customerRef: null, products: [products[0]],
      baseline: before, baselineUnavailable: false, context: before.context });
    expect(readLatestForecastImpactSale()?.baseline?.forecasts['SKU-A'].inferences).toEqual(before.forecasts['SKU-A'].inferences);
    expect(apiClient.getForecastModelDiagnostics).not.toHaveBeenCalled();
  });

  it('identifies an AFTER model change without attributing a promotion to the sale', () => {
    const before = baseline(), after = baseline('174', 91);
    after.forecasts['SKU-A'].inferences![14]!.modelVersion = 2;
    after.forecasts['SKU-A'].inferences![14]!.artifactHash = 'c'.repeat(64);
    renderComparison(before, after);
    expect(screen.getByText(/La inferencia AFTER de Ridge 14d usó otra versión ACTIVE o artifact \(v1 → v2\)/)).toBeTruthy();
  });

  it('uses exact received numbers rather than rounded output to claim equality', () => {
    const before = baseline(), after = baseline('174', 91);
    after.forecasts['SKU-A'].inferences![7]!.predictionUnits = 4.900001;
    renderComparison(before, after);
    expect(screen.queryByText(/por eso P7 y P14 permanecieron iguales/)).toBeNull();
  });

  it('keeps a feature change isolated to its SKU and horizon in a multi-product sale', () => {
    const before = baseline(), after = baseline('174', 91);
    after.forecasts['SKU-B'].inferences![14]!.featureInputs!.currentUnits = 50;
    renderComparison(before, after, [products[0], products[1]]);
    const a = screen.getByText('Producto A · SKU-A').closest('article')!;
    const b = screen.getByText('Producto B · SKU-B').closest('article')!;
    expect(within(a).getAllByText('0 de 13 modificadas')).toHaveLength(2);
    expect(within(a).queryByText('1 de 13 modificadas')).toBeNull();
    expect(within(b).getByText('1 de 13 modificadas')).toBeTruthy();
  });

  it('legacy or incomplete vectors are unavailable and never interpreted as zeros', () => {
    expect(compareRidgeFeatures(null, null).groups.every(group => group.changed === null)).toBe(true);
    expect(compareRidgeFeatures({}, forecast('SKU-A', 1).data.featureInputs).complete).toBe(false);
  });
});
