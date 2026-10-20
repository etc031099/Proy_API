import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastImpactDetailCard, ForecastImpactSummaryCard, useForecastImpact } from '@/components/business-intelligence/ForecastImpactPanel';
import { apiClient } from '@/lib/api';
import { clearLatestForecastImpactSale, FORECAST_IMPACT_SESSION_KEY, publishForecastImpactSale, readLatestForecastImpactSale, type ForecastImpactSaleMessage } from '@/lib/forecastImpactChannel';
import { readForecastImpactSnapshot, registerSaleWithImpact, type ForecastImpactProduct, type ForecastImpactSnapshot } from '@/lib/forecastImpactSnapshot';

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
function forecast(sku: string, value: number) {
  return { success: true, data: { mode: 'LIVE', status: 'READY', product: { sku, name: `Producto ${sku}` },
    modelFamily: 'RIDGE_REGRESSION', activeModelStatus: 'ACTIVE', predictionUnits: value, method: 'RIDGE_REGRESSION' } };
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
  vi.mocked(apiClient.getBusinessIntelligenceForecast).mockImplementation(async (sku, days) => forecast(sku, units + (sku === 'SKU-B' ? days : 0)) as never);
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
    'SKU-A': { sku: 'SKU-A', name: 'Producto A', seven, fourteen },
    'SKU-B': { sku: 'SKU-B', name: 'Producto B', seven: seven + 1, fourteen: fourteen + 1 },
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
    vi.spyOn(apiClient, 'analyzeMlTestScenario');
    vi.spyOn(apiClient, 'createMlTestCheckpoint');
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint');
    vi.spyOn(apiClient, 'requestForecastMlUpdate');
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
    expect(document.body.textContent).toContain('No disponible → 174');
  });

  it('retries a failed AFTER read without losing the BEFORE baseline', async () => {
    setSnapshotMocks('174', 91, 4.92);
    vi.mocked(apiClient.getForecastModelDiagnostics).mockRejectedValueOnce(new Error('temporary read failure'));
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
    expect(document.body.textContent?.match(/v1 → v1/g)).toHaveLength(2);
    expect(document.body.textContent).toContain('4.9 → 4.92');
    expect(document.body.textContent).toContain('5.9 → 11.92');
    expect(screen.getByText(/2 productos afectados · 3 unidades/)).toBeTruthy();
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
    expect(apiClient.createMlTestCheckpoint).not.toHaveBeenCalled();
    expect(apiClient.restoreMlTestCheckpoint).not.toHaveBeenCalled();
    expect(apiClient.requestForecastMlUpdate).not.toHaveBeenCalled();
  });
});
