import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MlTestEpochBoundary } from '@/components/business-intelligence/MlTestEpochBoundary';
import { MlTestScenarioUiProvider, useMlTestScenarioUiState } from '@/components/business-intelligence/MlTestScenarioUiContext';
import { MlTestControlPanel } from '@/components/business-intelligence/MlTestControlPanel';
import { apiClient } from '@/lib/api';
import type { MlTestActivity, MlTestActivityProduct, MlTestLifecycleResult, MlTestProductBaseline, ForecastMlUpdateStatus, ForecastResponse, MlTestControlStatus, MlTestLifecycleStatus, MlTestScenarioAnalysisResult, ProductInventory, ProductOption } from '@/types/businessIntelligence';

const products: ProductOption[] = [
  { id: 'a', sku: 'SKU-A', name: 'Producto A', presentation: null },
  { id: 'b', sku: 'SKU-B', name: 'Producto B', presentation: null },
  { id: 'c', sku: 'SKU-C', name: 'Producto C', presentation: null },
  { id: 'd', sku: 'SKU-D', name: 'Producto D', presentation: null },
];
const allowed: MlTestControlStatus = { state: 'TEST_ACTIVE', resetEpoch: '0', testCycleId: null, maintenance: false,
  cloudRestoreEnabled: false, capabilities: { destructiveMlTestControls: { allowed: true, target: 'LOCAL', reasonCode: null } } };
const lifecycle = (overrides: Partial<MlTestLifecycleStatus> = {}): MlTestLifecycleStatus => ({ state: 'TEST_ACTIVE', resetEpoch: '4', testCycleId: 'cycle-demo',
  maintenance: false, cloudRestoreEnabled: false, checkpointId: 'checkpoint', checkpoint: { status: 'READY', dataVersion: '173' }, ...overrides });
const inventory = (sku: string, stock = 21, extra: Partial<ProductInventory> = {}): ProductInventory => ({ asOf: '2026-10-19', timezone: 'America/Lima', mode: 'LIVE', updatedAt: null, dataThrough: null,
  status: 'READY', availability: 'READY', freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null },
  product: { sku, name: products.find(item => item.sku === sku)?.name || sku },
  stock: { onHand: stock, incoming: 0, inventoryPosition: stock }, demand: { expectedDaily: null, expectedUnitsNext1d: null, expectedUnitsNext7d: null, expectedUnitsNext14d: null },
  coverage: { daysCover: 10, status: 'AVAILABLE' }, inventoryPolicy: { safetyStock: 2, reorderPoint: 4 },
  recommendation: { reorderNow: false, preventiveRecommendation: null, recommendedQty: 0 }, risk: { level: 'LOW', reasonCodes: [] }, classification: { abc: null, xyz: null }, ...extra });
const mlStatus = (revision: number, signals7 = 0, signals14 = 0, eligibility = 'NO_PENDING_WORK'): ForecastMlUpdateStatus => ({
  dataVersion: revision, closedThrough: '2026-10-18', horizons: [7, 14].map((horizonDays, index) => {
    const signals = index === 0 ? signals7 : signals14;
    return { horizonDays, activeModelVersion: 1, trainedDataVersion: '83', pending: signals > 0, currentlyRunning: false,
      trigger: 'AUTO', lastRequestAt: null, lastAttemptAt: null, lastEvaluatedAt: null, lastResult: null, lastEvaluationReason: null,
      eligibility, nextEligibleAt: null, requestStatus: 'LAST_RESULT_NO_PENDING', dispatchStatus: null, availableOrigins: null, requiredOrigins: 107,
      readiness: { status: signals > 0 ? 'SIGNALS_PENDING' : 'NO_CHANGES', reasonCode: eligibility, hasPendingSignals: signals > 0,
        pendingSignalCount: signals, pendingSignalTypes: signals > 0 ? ['SALE_COMPLETED'] : [], firstPendingSignalAt: null, lastPendingSignalAt: null,
        pendingSince: null, lastDirtyAt: null, nextEligibleAt: null, eligibility, latestMatureOrigin: null, lastTrainedMatureOrigin: null,
        processedRevision: '83', latestPendingRevision: signals > 0 ? String(revision) : null, requiredOrigins: 107, availableOriginsActual: null } };
  }) as ForecastMlUpdateStatus['horizons'] });
const analysisResult = (horizonDays: 7 | 14, overrides: Partial<MlTestScenarioAnalysisResult> = {}): MlTestScenarioAnalysisResult => ({
  horizonDays, testCycleId: 'cycle-demo', resetEpoch: '4', outcome: 'NOT_MATURE', trained: false, candidateCreated: false, promoted: false,
  reasonCode: 'NOT_MATURE', requiredOrigins: 107, availableOrigins: null,
  activeModelBefore: { modelVersion: 1, trainedDataVersion: '83', dataCutoff: '2026-10-15' },
  activeModelAfter: { modelVersion: 1, trainedDataVersion: '83', dataCutoff: '2026-10-15' }, message: 'safe', ...overrides,
});
const forecast = (sku: string, horizon: 7 | 14, units: number): ForecastResponse => ({ asOf: '2026-10-19', timezone: 'America/Lima', mode: 'LIVE', updatedAt: null, dataThrough: null,
  status: 'READY', product: { sku, name: products.find(item => item.sku === sku)?.name }, method: 'RIDGE_REGRESSION', horizonDays: horizon,
  modelFamily: 'RIDGE_REGRESSION', activeModelStatus: 'ACTIVE', modelVersion: 1, observationCutoff: '2026-10-18',
  horizons: { '1d': null, '7d': horizon === 7 ? units : null, '14d': horizon === 14 ? units : null }, observedSeries: [],
  forecastPeriod: { startDate: '2026-10-20', selectedHorizonDays: horizon, units } });


function activityProduct(sku: string, quantity = 2): MlTestActivityProduct {
  return { sku, name: products.find(row => row.sku === sku)?.name || 'Producto ' + sku,
    saleCount: 2, totalQuantity: quantity, cancellationCount: 0, cancelledQuantity: 0, latestActivityAt: '2026-10-19T15:00:00Z',
    latestActivityRevision: '174', operationCount: 2,
    operations: [{ transactionId: 'sale-1', revision: '174', quantity, occurredAt: '2026-10-19T15:00:00Z', kind: 'SALE_COMPLETED', status: 'completed' }],
    baseline: { available: false } };
}
function productBaseline(capturedRevision = '174'): Extract<MlTestProductBaseline, { available: true }> {
  return { available: true as const, baselineRevision: '173', capturedRevision, capturedAt: '2026-10-19T15:00:00Z',
    stock: { onHand: 10, incoming: 0, inventoryPosition: 10 },
    forecast7: { status: 'READY', reasonCode: null, modelFamily: 'RIDGE_REGRESSION', activeModelStatus: 'ACTIVE', modelVersion: 1,
      trainedDataVersion: '83', units: 4.99, horizonDays: 7 as const, dataVersion: capturedRevision },
    forecast14: { status: 'READY', reasonCode: null, modelFamily: 'RIDGE_REGRESSION', activeModelStatus: 'ACTIVE', modelVersion: 1,
      trainedDataVersion: '83', units: 10.43, horizonDays: 14 as const, dataVersion: capturedRevision },
    coverage: { daysCover: 8.25, status: 'AVAILABLE', availabilityStatus: 'AVAILABLE', reasonCode: null },
    risk: { level: 'MEDIUM', status: 'AVAILABLE', reasonCodes: [] },
    recommendation: { reorderNow: false, recommendedQty: 12, status: 'AVAILABLE', availabilityStatus: 'AVAILABLE', reasonCode: null } };
}
function activityData(skus: string[] = [], currentRevision = skus.length ? '174' : '173', epoch = '4'): MlTestActivity {
  return { checkpointId: 'checkpoint', testCycleId: 'cycle-demo', resetEpoch: epoch,
    summary: { baselineRevision: '173', currentRevision, totalSales: skus.length ? 2 : 0, grossUnits: skus.length * 2,
      affectedProducts: skus.length, cancellationCount: 0 },
    products: skus.map(sku => activityProduct(sku)), page: { limit: 20, nextCursor: null, operationsPerProduct: 5 } };
}
function mockLocal(data = activityData(), status = lifecycle()) {
  vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: { ...allowed, ...status } });
  vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValue({ httpStatus: 200, data: status });
  vi.spyOn(apiClient, 'getMlTestActivity').mockResolvedValue({ httpStatus: 200, data });
  vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue({ success: true, data: { products } });
  vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockImplementation(async sku => ({ success: true, data: inventory(sku) }));
  vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: mlStatus(Number(data.summary.currentRevision)) });
  vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockImplementation(async (sku, horizon) => ({ success: true, data: forecast(sku, horizon as 7 | 14, horizon === 14 ? 30 : 15) }));
}
async function loaded() {
  await waitFor(() => expect((screen.getByRole('button', { name: 'Analizar ML' }) as HTMLButtonElement).disabled).toBe(false));
}
function confirm() { vi.stubGlobal('confirm', vi.fn(() => true)); }
function TabProbe() {
  const { tab, setTab } = useMlTestScenarioUiState();
  return <><button onClick={() => setTab('forecast')}>Seleccionar Predicción</button><p>Pestaña actual: {tab}</p></>;
}
function BaselineProbe() {
  const { baseline } = useMlTestScenarioUiState();
  return <p>Baseline compartido: {baseline ? 'presente' : 'vacío'}</p>;
}
async function openProduct(sku: string) {
  const label = screen.getByText(new RegExp(' · ' + sku + '$'));
  fireEvent.click(label.closest('summary')!);
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'Impacto observado ' + sku })).queryByText('Consultando métricas actuales…')).toBeNull());
}
function restored(mode: 'continue' | 'finish', signals7 = 0, signals14 = 0) {
  const next = lifecycle({ state: mode === 'continue' ? 'TEST_ACTIVE' : 'NO_TEST', resetEpoch: '5',
    testCycleId: mode === 'continue' ? 'cycle-demo' : null });
  vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValue({ httpStatus: 200, data: next });
  vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: { ...allowed, ...next } });
  vi.spyOn(apiClient, 'getMlTestActivity').mockResolvedValue({ httpStatus: 200, data: activityData([], '173', '5') });
  vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: mlStatus(173, signals7, signals14) });
  return { ...next, activityAfterRestore: { status: 'EMPTY' as const, checkpointId: 'checkpoint', resetEpoch: '5',
    baselineRevision: '173', currentRevision: '173', totalSales: 0, grossUnits: 0, affectedProducts: 0, cancellationCount: 0 } };
}

describe('free local ML test activity', () => {
  afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('removes all scenario configuration, quantities and product selection; never writes sales or launches replay', async () => {
    mockLocal(); const sale = vi.spyOn(apiClient, 'createTransaction');
    render(<MlTestControlPanel />); await loaded();
    expect(screen.getByText('Prueba libre del Machine Learning')).toBeTruthy();
    for (const term of [/NORMAL/, /OUTLIER/, /SHIFT/, /Capturar estado inicial/, /Cantidad planificada/])
      expect(screen.queryByText(term)).toBeNull();
    expect(screen.queryByLabelText('Producto')).toBeNull(); expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(apiClient.searchBusinessIntelligenceProducts).not.toHaveBeenCalled();
    expect(apiClient.getBusinessIntelligenceForecast).not.toHaveBeenCalled(); expect(sale).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: 'Abrir pantalla de ventas' });
    expect(link.getAttribute('href')).toBe('/transactions/sale'); expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows compact activity aggregated by SKU, and loads only current metrics on expansion', async () => {
    mockLocal(activityData(['SKU-A', 'SKU-B'])); render(<MlTestControlPanel />); await loaded();
    expect(screen.getByText('Ventas registradas')).toBeTruthy(); expect(screen.getByText('Unidades vendidas')).toBeTruthy();
    const list = screen.getByRole('region', { name: 'Productos afectados' });
    expect(within(list).getAllByText(/Producto A · SKU-A/)).toHaveLength(1);
    expect(within(list).getAllByText(/2 ventas · 2 unidades/)).toHaveLength(2);
    expect(apiClient.getBusinessIntelligenceProductInventory).not.toHaveBeenCalled();
    await openProduct('SKU-A');
    const current = screen.getByRole('region', { name: 'Impacto observado SKU-A' });
    expect(current.textContent).toContain('No disponible → 21 unidades');
    expect(current.textContent).toContain('No disponible → 15 unidades'); expect(current.textContent).toContain('No disponible → 30 unidades');
    expect(current.textContent).toContain('Otros cambios del negocio ocurridos durante la prueba también pueden influir');
    expect(current.textContent).not.toContain('174');
    const productCard = screen.getByText(/ · SKU-A$/).closest('details')!;
    expect(within(productCard).getByText('Detalles técnicos').closest('details')?.open).toBe(false);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
    expect(apiClient.getBusinessIntelligenceForecast).not.toHaveBeenCalledWith('SKU-A', 1);
    expect(screen.getByText('Impacto global del ML')).toBeTruthy();
  });

  it('shows first-contact baseline before current LIVE metrics and keeps capture revision in technical details', async () => {
    const data = activityData(['SKU-A']); data.products[0].baseline = productBaseline('175');
    mockLocal(data); render(<MlTestControlPanel />); await loaded();
    const initiallyCollapsed = screen.getByText(/ · SKU-A$/).closest('details')!;
    expect(within(initiallyCollapsed).getByText('Detalles técnicos').closest('details')?.open).toBe(false);
    await openProduct('SKU-A');
    const impact = screen.getByRole('region', { name: 'Impacto observado SKU-A' });
    expect(impact.textContent).toContain('Stock10 unidades → 21 unidades');
    expect(impact.textContent).toContain('Pronóstico Ridge 7d4.99 unidades → 15 unidades');
    expect(impact.textContent).toContain('Pronóstico Ridge 14d10.43 unidades → 30 unidades');
    expect(impact.textContent).toContain('Cobertura8.25 días → 10 días');
    expect(impact.textContent).toContain('RiesgoMEDIUM → LOW');
    expect(impact.textContent).toContain('Cantidad para nivel objetivo / reposición12 unidades → 0 unidades');
    expect(impact.textContent).toContain('Comparación entre el estado capturado justo antes del primer contacto');
    const card = screen.getByText(/ · SKU-A$/).closest('details')!;
    const technical = within(card).getByText('Detalles técnicos').closest('details')!;
    fireEvent.click(within(technical).getByText('Detalles técnicos'));
    expect(technical.textContent).toContain('Punto de restauración: rev 173');
    expect(technical.textContent).toContain('Baseline del producto capturado en rev 175');
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
  });

  it('keeps independent baselines per SKU and one original baseline across repeated same-SKU sales', async () => {
    const data = activityData(['SKU-A', 'SKU-B']);
    data.products[0].baseline = productBaseline('174'); data.products[1].baseline = productBaseline('176');
    data.products[0].saleCount = 3; data.products[0].operationCount = 3;
    mockLocal(data); render(<MlTestControlPanel />); await loaded();
    expect(screen.getByText(/3 ventas · 2 unidades/)).toBeTruthy();
    await openProduct('SKU-A');
    const cardA = screen.getByText(/ · SKU-A$/).closest('details')!;
    const technicalA = within(cardA).getByText('Detalles técnicos').closest('details')!;
    fireEvent.click(within(technicalA).getByText('Detalles técnicos'));
    expect(technicalA.textContent).toContain('Baseline del producto capturado en rev 174');
    await openProduct('SKU-B');
    const cardB = screen.getByText(/ · SKU-B$/).closest('details')!;
    const technicalB = within(cardB).getByText('Detalles técnicos').closest('details')!;
    fireEvent.click(within(technicalB).getByText('Detalles técnicos'));
    expect(technicalB.textContent).toContain('Baseline del producto capturado en rev 176');
  });

  it('does not invent unavailable baseline forecast values or display non-Ridge as LIVE', async () => {
    const data = activityData(['SKU-A']); const base = productBaseline();
    base.forecast7 = { ...base.forecast7, status: 'UNAVAILABLE', modelFamily: null, activeModelStatus: null, units: null };
    data.products[0].baseline = base;
    mockLocal(data);
    vi.mocked(apiClient.getBusinessIntelligenceForecast).mockImplementation(async (_sku, horizon) => horizon === 7
      ? ({ success: true, data: { ...forecast('SKU-A', 7, 22), modelFamily: 'HGB', method: 'HGB', activeModelStatus: 'ACTIVE' } })
      : ({ success: true, data: forecast('SKU-A', 14, 30) }));
    render(<MlTestControlPanel />); await loaded(); await openProduct('SKU-A');
    const impact = screen.getByRole('region', { name: 'Impacto observado SKU-A' });
    expect(impact.textContent).toContain('Pronóstico Ridge 7dNo disponible → No disponible');
    expect(impact.textContent).toContain('Pronóstico Ridge 14d10.43 unidades → 30 unidades');
  });

  it('drops old product comparisons after restore and uses only the baseline returned for the new epoch', async () => {
    const old = activityData(['SKU-A']); old.products[0].baseline = productBaseline('174');
    mockLocal(old); render(<MlTestControlPanel />); await loaded(); await openProduct('SKU-A');
    expect(screen.getByRole('region', { name: 'Impacto observado SKU-A' }).textContent).toContain('10 unidades → 21 unidades');

    const nextCycle = lifecycle({ resetEpoch: '5', checkpoint: { status: 'READY', dataVersion: '190' } });
    const fresh = activityData(['SKU-A'], '191', '5'); fresh.summary.baselineRevision = '190';
    fresh.products[0].baseline = { ...productBaseline('191'), baselineRevision: '190', stock: { onHand: 8 } };
    vi.mocked(apiClient.getMlTestControlStatus).mockResolvedValue({ httpStatus: 200, data: { ...allowed, ...nextCycle } });
    vi.mocked(apiClient.getMlTestLifecycleStatus).mockResolvedValue({ httpStatus: 200, data: nextCycle });
    vi.mocked(apiClient.getMlTestActivity).mockResolvedValue({ httpStatus: 200, data: fresh });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar actividad' }));
    await waitFor(() => expect(screen.getByText(/190 → 191/)).toBeTruthy());
    await openProduct('SKU-A');
    const impact = screen.getByRole('region', { name: 'Impacto observado SKU-A' });
    expect(impact.textContent).toContain('8 unidades → 21 unidades');
    const card = screen.getByText(/ · SKU-A$/).closest('details')!;
    const technical = within(card).getByText('Detalles técnicos').closest('details')!;
    fireEvent.click(within(technical).getByText('Detalles técnicos'));
    expect(technical.textContent).toContain('Punto de restauración: rev 190');
    expect(technical.textContent).toContain('Baseline del producto capturado en rev 191');
  });

  it('shows five collapsed products first, supports more/less and name/SKU filtering', async () => {
    mockLocal(activityData(['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D', 'SKU-E', 'SKU-F']));
    render(<MlTestControlPanel />); await loaded();
    expect(screen.queryByText(/ · SKU-F$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver más productos' })); expect(screen.getByText(/ · SKU-F$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar menos' })); expect(screen.queryByText(/ · SKU-F$/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Filtrar productos cargados por nombre o SKU'), { target: { value: 'SKU-F' } });
    expect(screen.getByText(/ · SKU-F$/)).toBeTruthy(); expect(screen.queryByText(/ · SKU-A$/)).toBeNull();
    expect(apiClient.getBusinessIntelligenceProductInventory).not.toHaveBeenCalled();
  });

  it('appends cursor pages without duplicate products and preserves the pinned revision', async () => {
    const first = activityData(['SKU-A']); first.page.nextCursor = 'opaque';
    mockLocal(first); render(<MlTestControlPanel />); await loaded();
    vi.mocked(apiClient.getMlTestActivity).mockResolvedValue({ httpStatus: 200, data: activityData(['SKU-A', 'SKU-B']) });
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más productos' }));
    await screen.findByText(/Producto B · SKU-B$/);
    expect(screen.getAllByText(/Producto A · SKU-A$/)).toHaveLength(1);
    expect(apiClient.getMlTestActivity).toHaveBeenLastCalledWith({ cursor: 'opaque', limit: 20 });
  });

  it('refreshes manually and when the document becomes visible, without polling', async () => {
    mockLocal(); render(<MlTestControlPanel />); await loaded();
    vi.mocked(apiClient.getMlTestActivity).mockResolvedValue({ httpStatus: 200, data: activityData(['SKU-A']) });
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue({ httpStatus: 200, data: mlStatus(174, 1, 1, 'NOT_MATURE') });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar actividad' }));
    await screen.findByText(/Producto A · SKU-A$/); await loaded();
    expect(apiClient.getMlTestActivity).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange')); expect(apiClient.getMlTestActivity).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(apiClient.getMlTestActivity).toHaveBeenCalledTimes(3));
    await loaded(); vi.useFakeTimers();
    await act(async () => { vi.advanceTimersByTime(120000); });
    vi.useRealTimers(); expect(apiClient.getMlTestActivity).toHaveBeenCalledTimes(3);
  });

  it('preserves global baseline separately and never invents one when opening an already modified test', async () => {
    mockLocal(activityData(['SKU-A'])); render(<MlTestControlPanel />); await loaded();
    expect(screen.getByText(/No se capturó una referencia global/)).toBeTruthy();
    expect(screen.getAllByText(/Inicial no capturado/)).toHaveLength(4);
    expect(screen.getByText(/107 orígenes maduros no significan 107 ventas/)).toBeTruthy();
  });

  it('analysis remains global and sequential 7 then 14, with a same-cycle read between', async () => {
    mockLocal(activityData(['SKU-A'])); confirm();
    const analysis = vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(7) })
      .mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(14) });
    render(<MlTestControlPanel />); await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Analizar ML' }));
    await waitFor(() => expect(analysis).toHaveBeenCalledTimes(2));
    expect(analysis).toHaveBeenNthCalledWith(1, 7); expect(analysis).toHaveBeenNthCalledWith(2, 14);
    expect(screen.getAllByText('107 / No disponible')).toHaveLength(2);
    const lifecycleOrders = vi.mocked(apiClient.getMlTestLifecycleStatus).mock.invocationCallOrder;
    expect(lifecycleOrders.some(order => order > analysis.mock.invocationCallOrder[0] && order < analysis.mock.invocationCallOrder[1])).toBe(true);
  });

  it('stops analysis before 14 when the test epoch changes', async () => {
    mockLocal(); confirm(); render(<MlTestControlPanel />); await loaded();
    vi.spyOn(apiClient, 'analyzeMlTestScenario').mockImplementation(async () => {
      vi.mocked(apiClient.getMlTestLifecycleStatus).mockResolvedValue({ httpStatus: 200, data: lifecycle({ resetEpoch: '5' }) });
      return { httpStatus: 200, data: analysisResult(7) };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Analizar ML' }));
    await screen.findByText('El ciclo cambió; el análisis se detuvo.');
    expect(apiClient.analyzeMlTestScenario).toHaveBeenCalledTimes(1);
  });

  it.each(['continue', 'finish'] as const)('restore %s verifies globals and empty activity, scrolls to the mounted result and preserves Prediction across remount', async mode => {
    mockLocal(); confirm();
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    render(<MlTestScenarioUiProvider><MlTestEpochBoundary><TabProbe /><MlTestControlPanel /></MlTestEpochBoundary></MlTestScenarioUiProvider>);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Seleccionar Predicción' }));
    vi.mocked(apiClient.getMlTestActivity).mockResolvedValue({ httpStatus: 200, data: activityData(['SKU-A']) });
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue({ httpStatus: 200, data: mlStatus(174, 1, 1) });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar actividad' })); await screen.findByText(/Producto A · SKU-A$/); await loaded();
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockImplementation(async () => ({ httpStatus: 200, data: restored(mode) }));
    fireEvent.click(screen.getByRole('button', { name: mode === 'continue' ? 'Restaurar punto de restauración' : 'Finalizar prueba' }));
    await screen.findByRole('heading', { name: 'Restauración completada' });
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' }));
    const result = screen.getByRole('region', { name: 'Verificación de restauración' });
    expect(result.className).toContain('scroll-mt-24');
    expect(result.textContent).toContain('La verificación global contiene diferencias o valores iniciales no capturados');
    expect(result.textContent).toContain('Actividad posterior al punto de restauración: vacía y verificada.');
    expect(result.textContent).not.toContain('Pronóstico Ridge');
    expect(screen.queryByText(/Producto A · SKU-A$/)).toBeNull();
    expect(screen.getByText('Pestaña actual: forecast')).toBeTruthy();
    if (mode === 'continue') expect(await screen.findByText('Aún no se detectaron ventas ni cancelaciones en esta prueba.')).toBeTruthy();
    else expect(screen.getByRole('button', { name: 'Iniciar prueba' })).toBeTruthy();
  });

  it('does not scroll during normal load or VERIFYING; failure scrolls without claiming restore success', async () => {
    mockLocal(); confirm(); const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    render(<MlTestControlPanel />); await loaded(); expect(scroll).not.toHaveBeenCalled();
    let resolve!: (response: { httpStatus: number; data?: MlTestLifecycleResult }) => void;
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockImplementation(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    expect(screen.getByRole('heading', { name: 'Restaurando punto de restauración…' })).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
    resolve({ httpStatus: 503 });
    await screen.findByRole('heading', { name: 'No se pudo verificar la restauración' });
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Coincide con el punto/)).toBeNull();
  });

  it('fails verification when activity remains or finish receipt is unavailable', async () => {
    mockLocal(); confirm(); render(<MlTestControlPanel />); await loaded();
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockImplementation(async () => {
      const data = restored('finish'); return { httpStatus: 200, data: { ...data, activityAfterRestore: { status: 'UNAVAILABLE' } } };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar prueba' }));
    await screen.findByRole('heading', { name: 'No se pudo verificar la restauración' });
    expect(screen.queryByText(/vacía y verificada/)).toBeNull();
  });

  it('does not claim an empty restored activity when post-restore sales remain', async () => {
    mockLocal(); confirm(); render(<MlTestControlPanel />); await loaded();
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockImplementation(async () => {
      const data = restored('continue');
      vi.mocked(apiClient.getMlTestActivity).mockResolvedValue({ httpStatus: 200, data: activityData(['SKU-A'], '174', '5') });
      return { httpStatus: 200, data };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    await screen.findByRole('heading', { name: 'No se pudo verificar la restauración' });
    expect(screen.queryByText(/vacía y verificada/)).toBeNull();
  });

  it.each(['continue', 'finish'] as const)('captures signals and ACTIVE versions before checkpoint and preserves that global baseline through %s restore', async mode => {
    mockLocal(activityData(), lifecycle({ state: 'NO_TEST', testCycleId: null, checkpoint: null }));
    const getStatus = vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: mlStatus(173, 90, 90) });
    confirm(); const create = vi.spyOn(apiClient, 'createMlTestCheckpoint').mockImplementation(async () => {
      const next = lifecycle();
      vi.mocked(apiClient.getMlTestLifecycleStatus).mockResolvedValue({ httpStatus: 200, data: next });
      return { httpStatus: 201, data: next };
    });
    render(<MlTestScenarioUiProvider><BaselineProbe /><MlTestControlPanel /></MlTestScenarioUiProvider>);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Iniciar prueba' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar prueba' })); await loaded();
    expect(getStatus.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    expect(screen.queryByText(/No se capturó una referencia global/)).toBeNull();
    expect(screen.getAllByText('90 → 90')).toHaveLength(2);
    expect(screen.getAllByText('v1 → v1')).toHaveLength(2);
    expect(screen.getByText('Baseline compartido: presente')).toBeTruthy();
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockImplementation(async () => ({ httpStatus: 200, data: restored(mode, 90, 90) }));
    fireEvent.click(screen.getByRole('button', { name: mode === 'continue' ? 'Restaurar punto de restauración' : 'Finalizar prueba' }));
    const result = await screen.findByRole('region', { name: 'Verificación de restauración' });
    await waitFor(() => expect(within(result).getAllByText('90 → 90')).toHaveLength(2));
    expect(within(result).getAllByText('v1 → v1')).toHaveLength(2);
    expect(result.textContent).toContain('Coincide con el punto de restauración en las métricas globales verificadas');
    expect(screen.getByText('Baseline compartido: ' + (mode === 'continue' ? 'presente' : 'vacío'))).toBeTruthy();
    expect(Boolean(window.sessionStorage.getItem('ml-test-global-baseline:v1'))).toBe(mode === 'continue');
    expect(apiClient.getBusinessIntelligenceForecast).not.toHaveBeenCalled();
    expect(apiClient.getBusinessIntelligenceProductInventory).not.toHaveBeenCalled();
  });

  it('shows a mismatch when restored global ML values differ from the captured baseline', async () => {
    mockLocal(activityData(), lifecycle({ state: 'NO_TEST', testCycleId: null, checkpoint: null }));
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue({ httpStatus: 200, data: mlStatus(173, 90, 90) });
    confirm(); vi.spyOn(apiClient, 'createMlTestCheckpoint').mockImplementation(async () => {
      const next = lifecycle(); vi.mocked(apiClient.getMlTestLifecycleStatus).mockResolvedValue({ httpStatus: 200, data: next });
      return { httpStatus: 201, data: next };
    });
    render(<MlTestControlPanel />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Iniciar prueba' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar prueba' })); await loaded();
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockImplementation(async () => ({ httpStatus: 200, data: restored('continue', 89, 90) }));
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    const result = await screen.findByRole('region', { name: 'Verificación de restauración' });
    expect(result.textContent).toContain('90 → 89');
    expect(result.textContent).toContain('Difiere');
    expect(result.textContent).not.toContain('Coincide con el punto de restauración en las métricas globales verificadas');
  });

  it('does not claim a full match when the pre-checkpoint status revision differs from the snapshot', async () => {
    mockLocal(activityData(), lifecycle({ state: 'NO_TEST', testCycleId: null, checkpoint: null }));
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue({ httpStatus: 200, data: mlStatus(172, 90, 90) });
    confirm(); vi.spyOn(apiClient, 'createMlTestCheckpoint').mockImplementation(async () => {
      const next = lifecycle(); vi.mocked(apiClient.getMlTestLifecycleStatus).mockResolvedValue({ httpStatus: 200, data: next });
      return { httpStatus: 201, data: next };
    });
    render(<MlTestControlPanel />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Iniciar prueba' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar prueba' })); await loaded();
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockImplementation(async () => ({ httpStatus: 200, data: restored('continue', 90, 90) }));
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    const result = await screen.findByRole('region', { name: 'Verificación de restauración' });
    expect(result.textContent).toContain('valores iniciales no capturados');
    expect(result.textContent).toContain('No se pudo verificar');
    expect(result.textContent).not.toContain('Coincide con el punto de restauración en las métricas globales verificadas');
  });

  it('does not claim a full match when a restored global signal value is unavailable', async () => {
    mockLocal(activityData(), lifecycle({ state: 'NO_TEST', testCycleId: null, checkpoint: null }));
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue({ httpStatus: 200, data: mlStatus(173, 90, 90) });
    confirm(); vi.spyOn(apiClient, 'createMlTestCheckpoint').mockImplementation(async () => {
      const next = lifecycle(); vi.mocked(apiClient.getMlTestLifecycleStatus).mockResolvedValue({ httpStatus: 200, data: next });
      return { httpStatus: 201, data: next };
    });
    render(<MlTestControlPanel />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Iniciar prueba' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar prueba' })); await loaded();
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockImplementation(async () => {
      const result = restored('continue', 90, 90);
      const incomplete = mlStatus(173, 90, 90); delete incomplete.horizons[0].readiness;
      vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue({ httpStatus: 200, data: incomplete });
      return { httpStatus: 200, data: result };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    const result = await screen.findByRole('region', { name: 'Verificación de restauración' });
    expect(result.textContent).toContain('No disponible');
    expect(result.textContent).toContain('No se pudo verificar');
    expect(result.textContent).not.toContain('Coincide con el punto de restauración en las métricas globales verificadas');
  });

  it('restores the same-cycle baseline after a fresh provider mount and keeps it through activity and analysis', async () => {
    mockLocal(activityData(), lifecycle({ state: 'NO_TEST', testCycleId: null, checkpoint: null }));
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: mlStatus(173, 90, 90) });
    confirm(); vi.spyOn(apiClient, 'createMlTestCheckpoint').mockImplementation(async () => {
      const next = lifecycle(); vi.mocked(apiClient.getMlTestLifecycleStatus).mockResolvedValue({ httpStatus: 200, data: next });
      return { httpStatus: 201, data: next };
    });
    const first = render(<MlTestScenarioUiProvider><MlTestControlPanel /></MlTestScenarioUiProvider>);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Iniciar prueba' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar prueba' })); await loaded();
    first.unmount();

    mockLocal(activityData([], '174'), lifecycle());
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: mlStatus(174, 91, 91) });
    render(<MlTestScenarioUiProvider><MlTestControlPanel /></MlTestScenarioUiProvider>);
    await loaded();
    expect(screen.getAllByText('173 → 174')).toHaveLength(2);
    expect(screen.getAllByText('90 → 91')).toHaveLength(2);
    expect(screen.getAllByText('v1 → v1')).toHaveLength(2);
    expect(screen.queryByText(/Inicial no capturado/)).toBeNull();

    confirm();
    vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(7) })
      .mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(14) });
    fireEvent.click(screen.getByRole('button', { name: 'Analizar ML' }));
    await waitFor(() => expect(apiClient.analyzeMlTestScenario).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('90 → 91')).toHaveLength(2);
    expect(screen.getAllByText('v1 → v1')).toHaveLength(2);
  });

  it('does not reuse a stored baseline after the checkpoint or test cycle changes', async () => {
    window.sessionStorage.setItem('ml-test-global-baseline:v1', JSON.stringify({ checkpointId: 'old-checkpoint',
      testCycleId: 'old-cycle', baselineRevision: '173', resetEpoch: '4', globalMl: { dataVersion: '173', horizons: [
        { horizonDays: 7, activeModelVersion: 1, pendingSignalCount: 90 },
        { horizonDays: 14, activeModelVersion: 1, pendingSignalCount: 90 },
      ] } }));
    const newCycle = lifecycle({ checkpointId: 'new-checkpoint', testCycleId: 'new-cycle', checkpoint: { status: 'READY', dataVersion: '200' } });
    const newActivity = { ...activityData([], '200'), checkpointId: 'new-checkpoint', testCycleId: 'new-cycle' };
    mockLocal(newActivity, newCycle);
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: mlStatus(200, 3, 4) });
    render(<MlTestScenarioUiProvider><MlTestControlPanel /></MlTestScenarioUiProvider>);
    await loaded();
    expect(screen.getByText('Inicial no capturado → 3')).toBeTruthy();
    expect(screen.getByText('Inicial no capturado → 4')).toBeTruthy();
    expect(screen.getAllByText('Inicial no capturado → v1')).toHaveLength(2);
    expect(screen.queryByText('90 → 3')).toBeNull();
    expect(window.sessionStorage.getItem('ml-test-global-baseline:v1')).toBeNull();
  });

  it('keeps the matching persisted baseline while restore is in progress', async () => {
    window.sessionStorage.setItem('ml-test-global-baseline:v1', JSON.stringify({ checkpointId: 'checkpoint', testCycleId: 'cycle-demo',
      baselineRevision: '173', resetEpoch: '4', globalMl: { dataVersion: '173', horizons: [
        { horizonDays: 7, activeModelVersion: 1, pendingSignalCount: 90 },
        { horizonDays: 14, activeModelVersion: 1, pendingSignalCount: 90 },
      ] } }));
    mockLocal(activityData(), lifecycle({ state: 'RESTORING', maintenance: true }));
    render(<MlTestScenarioUiProvider><MlTestControlPanel /></MlTestScenarioUiProvider>);
    expect(await screen.findByText('Restauración en curso')).toBeTruthy();
    expect(window.sessionStorage.getItem('ml-test-global-baseline:v1')).not.toBeNull();
  });

  it('keeps cloud/disabled controls hidden and shows recoverable activity errors', async () => {
    mockLocal(); vi.mocked(apiClient.getMlTestControlStatus).mockResolvedValue({ httpStatus: 200, data: { ...allowed,
      capabilities: { destructiveMlTestControls: { allowed: false, target: null, reasonCode: 'ML_TEST_PRODUCTION_FORBIDDEN' } } } });
    const view = render(<MlTestControlPanel />);
    await waitFor(() => expect(apiClient.getMlTestControlStatus).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Pruebas del Machine Learning' })).toBeNull();
    expect(apiClient.getMlTestActivity).not.toHaveBeenCalled(); view.unmount();
    vi.mocked(apiClient.getMlTestControlStatus).mockResolvedValue({ httpStatus: 200, data: allowed });
    vi.mocked(apiClient.getMlTestActivity).mockResolvedValue({ httpStatus: 503 });
    render(<MlTestControlPanel />); expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/Producto A/)).toBeNull();
  });
});
