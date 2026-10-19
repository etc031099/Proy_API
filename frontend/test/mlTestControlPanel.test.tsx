import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MlTestControlPanel } from '@/components/business-intelligence/MlTestControlPanel';
import { apiClient } from '@/lib/api';
import type { ForecastMlUpdateStatus, ForecastResponse, MlTestControlStatus, MlTestLifecycleStatus, MlTestScenarioAnalysisResult, ProductInventory } from '@/types/businessIntelligence';

const allowed: MlTestControlStatus = { state: 'NO_TEST', resetEpoch: '0', testCycleId: null, maintenance: false,
  cloudRestoreEnabled: false, capabilities: { destructiveMlTestControls: { allowed: true, target: 'LOCAL', reasonCode: null } } };
const denied: MlTestControlStatus = { ...allowed, capabilities: { destructiveMlTestControls: { allowed: false, target: null, reasonCode: 'ML_TEST_PRODUCTION_FORBIDDEN' } } };
const lifecycle = (overrides: Partial<MlTestLifecycleStatus> = {}): MlTestLifecycleStatus => ({ state: 'NO_TEST', resetEpoch: '0', testCycleId: null,
  maintenance: false, cloudRestoreEnabled: false, checkpointId: null, checkpoint: null, ...overrides });
const active = (overrides: Partial<MlTestLifecycleStatus> = {}) => lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '4', testCycleId: 'cycle-demo', checkpoint: { status: 'READY' }, ...overrides });
const inventory = (stock = 21): ProductInventory => ({ asOf: '2026-10-19', timezone: 'America/Lima', mode: 'LIVE', updatedAt: null, dataThrough: null,
  status: 'READY', availability: 'READY', freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null },
  product: { sku: 'BEB-AGU-001', name: 'Agua Cielo Sin Gas 625 ml' },
  stock: { onHand: stock, incoming: 0, inventoryPosition: stock },
  demand: { expectedDaily: null, expectedUnitsNext1d: null, expectedUnitsNext7d: null, expectedUnitsNext14d: null },
  coverage: { daysCover: null, status: null }, inventoryPolicy: { safetyStock: null, reorderPoint: null },
  recommendation: { reorderNow: null, preventiveRecommendation: null, recommendedQty: null }, risk: { level: null, reasonCodes: [] },
  classification: { abc: null, xyz: null } });
const mlStatus = (revision: number, signals7 = 0, signals14 = 0, eligibility = 'NO_PENDING_WORK'): ForecastMlUpdateStatus => ({
  dataVersion: revision, closedThrough: '2026-10-18', horizons: [7, 14].map((horizonDays, index) => {
    const signals = index === 0 ? signals7 : signals14;
    return { horizonDays, activeModelVersion: 1, trainedDataVersion: '83', pending: signals > 0, currentlyRunning: false,
      trigger: 'AUTO', lastRequestAt: null, lastAttemptAt: null, lastEvaluatedAt: null, lastResult: null,
      lastEvaluationReason: null, eligibility, nextEligibleAt: null, requestStatus: 'LAST_RESULT_NO_PENDING',
      dispatchStatus: null, availableOrigins: null, requiredOrigins: 107,
      readiness: { status: signals > 0 ? 'SIGNALS_PENDING' : 'NO_CHANGES', reasonCode: eligibility,
        hasPendingSignals: signals > 0, pendingSignalCount: signals,
        pendingSignalTypes: signals > 0 ? ['SALE_COMPLETED'] : [], firstPendingSignalAt: signals > 0 ? '2026-10-18T10:00:00.000Z' : null,
        lastPendingSignalAt: signals > 0 ? '2026-10-18T10:30:00.000Z' : null, pendingSince: null, lastDirtyAt: null,
        nextEligibleAt: null, eligibility, latestMatureOrigin: null, lastTrainedMatureOrigin: null,
        processedRevision: '83', latestPendingRevision: signals > 0 ? String(revision) : null,
        requiredOrigins: 107, availableOriginsActual: null } };
  }) as ForecastMlUpdateStatus['horizons'] });
const analysisResult = (horizonDays: 7 | 14, overrides: Partial<MlTestScenarioAnalysisResult> = {}): MlTestScenarioAnalysisResult => ({
  horizonDays, testCycleId: 'cycle-demo', resetEpoch: '4', outcome: 'NOT_MATURE', trained: false,
  candidateCreated: false, promoted: false, reasonCode: 'NOT_MATURE', requiredOrigins: 107,
  availableOrigins: null, activeModelBefore: { modelVersion: 1, trainedDataVersion: '83', dataCutoff: '2026-10-15' },
  activeModelAfter: { modelVersion: 1, trainedDataVersion: '83', dataCutoff: '2026-10-15' },
  message: 'safe backend message', ...overrides,
});
const ridgeForecast = (horizonDays: 7 | 14, units: number): ForecastResponse => ({
  asOf: '2026-10-19', timezone: 'America/Lima', mode: 'LIVE', updatedAt: null, dataThrough: null,
  status: 'READY', product: { sku: 'BEB-AGU-001', name: 'Agua Cielo Sin Gas 625 ml' }, method: 'RIDGE_REGRESSION',
  horizonDays, modelFamily: 'RIDGE_REGRESSION', activeModelStatus: 'ACTIVE', modelVersion: 1, observationCutoff: '2026-10-18',
  horizons: { '1d': null, '7d': horizonDays === 7 ? units : null, '14d': horizonDays === 14 ? units : null }, observedSeries: [],
  forecastPeriod: { startDate: '2026-10-20', selectedHorizonDays: horizonDays, units },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function mockLocal(status = lifecycle()) {
  vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: allowed });
  vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValue({ httpStatus: 200, data: status });
}
function mockScenario(status = active(), stock = 21) {
  mockLocal(status);
  vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValue({ success: true, data: inventory(stock) });
  vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: mlStatus(173) });
  vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockImplementation(async (_sku, horizon) => ({ success: true, data: ridgeForecast(horizon === 14 ? 14 : 7, horizon === 14 ? 30 : 15) }));
}
async function prepareChangedScenario() {
  mockScenario();
  vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValueOnce({ success: true, data: inventory(21) })
    .mockResolvedValueOnce({ success: true, data: inventory(20) });
  vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValueOnce({ httpStatus: 200, data: mlStatus(173) })
    .mockResolvedValueOnce({ httpStatus: 200, data: mlStatus(174, 1, 1, 'NOT_MATURE') });
  vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValue({ httpStatus: 200, data: active() });
  render(<MlTestControlPanel />);
  fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
  await screen.findByText(/Estado inicial observado/);
  fireEvent.click(screen.getByRole('button', { name: 'Comprobar cambios' }));
  await screen.findByText('Escenario listo para análisis');
  vi.stubGlobal('confirm', vi.fn(() => true));
}

describe('ML test control panel', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('renders nothing without authorized LOCAL capability and does not query lifecycle', async () => {
    vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: denied });
    const lifecycleRead = vi.spyOn(apiClient, 'getMlTestLifecycleStatus');
    render(<MlTestControlPanel />);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pruebas del Machine Learning' })).toBeNull());
    expect(screen.queryByText(/solo están disponibles en el entorno local/i)).toBeNull();
    expect(lifecycleRead).not.toHaveBeenCalled();
  });

  it('fails closed when target is not LOCAL or capability lookup fails', async () => {
    vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValueOnce({ httpStatus: 200, data: { ...allowed,
      capabilities: { destructiveMlTestControls: { allowed: true, target: null, reasonCode: null } } } })
      .mockResolvedValueOnce({ httpStatus: 503 });
    const { unmount } = render(<MlTestControlPanel />);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pruebas del Machine Learning' })).toBeNull());
    unmount(); render(<MlTestControlPanel />);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pruebas del Machine Learning' })).toBeNull());
  });

  it('shows lifecycle controls only after explicit LOCAL capability', async () => {
    mockLocal(); render(<MlTestControlPanel />);
    expect(await screen.findByText('Sin prueba activa')).toBeTruthy();
    expect(screen.getByText('Punto de restauración')).toBeTruthy();
    expect(screen.queryByText('LOCAL AUTORIZADO')).toBeNull();
    expect(screen.getByRole('button', { name: 'Iniciar prueba' })).toBeTruthy();
    expect(screen.queryByText('SIN PRUEBA ACTIVA')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Escenario de prueba' })).toBeNull();
  });

  it('starts a checkpoint, locks controls, then refreshes status', async () => {
    mockLocal();
    const create = vi.spyOn(apiClient, 'createMlTestCheckpoint').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { httpStatus: 201, data: { ...active({ resetEpoch: '5' }), status: 'READY' } };
    });
    const status = vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: lifecycle() })
      .mockResolvedValueOnce({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    vi.stubGlobal('confirm', vi.fn(() => true)); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar prueba' }));
    expect(screen.getByRole('button', { name: 'Creando punto de restauración…' }).hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(screen.getByText('Prueba activa')).toBeTruthy());
    expect(create).toHaveBeenCalledTimes(1); expect(status).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Punto de restauración creado. La prueba local está activa.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Escenario de prueba' })).toBeTruthy();
  });

  it('renders three scenarios only with TEST_ACTIVE and READY checkpoint; shows exact NORMAL and OUTLIER quantities', async () => {
    mockScenario(); render(<MlTestControlPanel />);
    expect(await screen.findByRole('button', { name: /NORMAL/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /OUTLIER/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /SHIFT/ })).toBeTruthy();
    expect(apiClient.getBusinessIntelligenceProductInventory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /NORMAL/ }));
    expect(await screen.findByText(/SKU BEB-AGU-001, cantidad 1 unidad/)).toBeTruthy();
    expect(screen.getAllByText('21').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /OUTLIER/ }));
    expect(await screen.findByText(/SKU BEB-AGU-001, cantidad 15 unidades/)).toBeTruthy();
  });

  it('shows SHIFT as five separate sales and never collapses it into one quantity 17', async () => {
    mockScenario(); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /SHIFT/ }));
    for (const [index, quantity] of [3, 4, 3, 4, 3].entries()) {
      expect(await screen.findByText(new RegExp(`Venta ${index + 1} → SKU BEB-AGU-001, cantidad ${quantity} unidades?`))).toBeTruthy();
    }
    expect(screen.queryByText(/cantidad 17/)).toBeNull();
    expect(screen.getAllByText(/una transacción separada/)).toHaveLength(5);
    expect(screen.getByText(/Estado inicial observado/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Analizar escenario' })).toBeNull();
    const saleLink = screen.getByRole('link', { name: 'Abrir pantalla de ventas' });
    expect(saleLink.getAttribute('href')).toBe('/transactions/sale');
    expect(saleLink.getAttribute('target')).toBe('_blank');
    expect(saleLink.getAttribute('rel')).toContain('noopener');
    expect(saleLink.getAttribute('rel')).toContain('noreferrer');
  });

  it('blocks the instructions when current stock does not satisfy the scenario', async () => {
    mockScenario(active(), 14); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /OUTLIER/ }));
    expect(await screen.findAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain('El producto no tiene stock suficiente');
    expect(screen.queryByRole('link', { name: 'Abrir pantalla de ventas' })).toBeNull();
  });

  it('checks changes using read-only calls and displays actual stock, revision, signals, and 107 origins', async () => {
    mockScenario();
    const productRead = vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValueOnce({ success: true, data: inventory(21) })
      .mockResolvedValueOnce({ success: true, data: inventory(20) });
    const mlRead = vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValueOnce({ httpStatus: 200, data: mlStatus(173) })
      .mockResolvedValueOnce({ httpStatus: 200, data: mlStatus(174, 1, 1, 'DEBOUNCE_NOT_ELAPSED') });
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValue({ httpStatus: 200, data: active() });
    const checkpoint = vi.spyOn(apiClient, 'createMlTestCheckpoint');
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint');
    const manualRequest = vi.spyOn(apiClient, 'requestForecastMlUpdate');
    const invalidate = vi.spyOn(apiClient, 'invalidateIntelligenceReads');
    render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
    expect(await screen.findByText(/Estado inicial observado/)).toBeTruthy();
    const saleLink = screen.getByRole('link', { name: 'Abrir pantalla de ventas' });
    expect(saleLink.getAttribute('href')).toBe('/transactions/sale');
    expect(saleLink.getAttribute('target')).toBe('_blank');
    expect(within(screen.getByLabelText('Estado inicial observado')).getByText('Stock').parentElement?.textContent).toContain('21');
    fireEvent.click(saleLink);
    expect(within(screen.getByLabelText('Estado inicial observado')).getByText('Stock').parentElement?.textContent).toContain('21');
    expect(screen.getByRole('button', { name: 'Comprobar cambios' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar cambios' }));
    expect(await screen.findByText('21 → 20')).toBeTruthy();
    expect(screen.getByText('173 → 174')).toBeTruthy();
    expect(screen.getAllByText('0 → 1')).toHaveLength(2);
    expect(screen.getByText('107 orígenes maduros no significan 107 ventas.')).toBeTruthy();
    expect(screen.getAllByText('El sistema recibió nueva evidencia, pero todavía está agrupando los cambios recientes antes de evaluar un candidato.')).toHaveLength(2);
    expect(screen.getByText('Escenario listo para análisis')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analizar escenario' })).toBeTruthy();
    expect(productRead).toHaveBeenCalledTimes(2); expect(mlRead).toHaveBeenCalledTimes(2);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(1, 'BEB-AGU-001', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(2, 'BEB-AGU-001', 14);
    const comparison = screen.getByRole('region', { name: 'Comparación del escenario' });
    expect(within(comparison).getByText('Pronóstico Ridge 7d').parentElement?.textContent).toContain('15 unidades → 15 unidades');
    expect(within(comparison).getByText('Pronóstico Ridge 14d').parentElement?.textContent).toContain('30 unidades → 30 unidades');
    expect(within(comparison).getByText('Modelo activo 7d').parentElement?.textContent).toContain('v1 → v1');
    expect(within(comparison).getByText('Modelo activo 14d').parentElement?.textContent).toContain('v1 → v1');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(checkpoint).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(manualRequest).not.toHaveBeenCalled();
  });

  it('shows Ridge before and after, active versions and optional inventory fields without treating equal forecasts as failure', async () => {
    mockScenario();
    const coverageInventory = (stock: number, daysCover: number, riskLevel: 'LOW' | 'HIGH') => ({ ...inventory(stock),
      coverage: { daysCover, status: 'AVAILABLE' }, risk: { level: riskLevel, reasonCodes: [] }, recommendation: { reorderNow: false, preventiveRecommendation: null, recommendedQty: 4 } });
    vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValueOnce({ success: true, data: coverageInventory(21, 10, 'LOW') })
      .mockResolvedValueOnce({ success: true, data: coverageInventory(20, 8, 'HIGH') });
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValueOnce({ httpStatus: 200, data: mlStatus(173) })
      .mockResolvedValueOnce({ httpStatus: 200, data: mlStatus(174, 1, 1, 'NOT_MATURE') });
    const forecastRead = vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockImplementation(async (_sku, horizon) => ({
      success: true, data: ridgeForecast(horizon === 14 ? 14 : 7, horizon === 14 ? 30 : 15) }));
    render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
    await screen.findByText(/Estado inicial observado/);
    expect(screen.queryByRole('region', { name: 'Comparación del escenario' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar cambios' }));
    const comparison = await screen.findByRole('region', { name: 'Comparación del escenario' });
    expect(within(comparison).getByText('Impacto observado del escenario')).toBeTruthy();
    expect(within(comparison).getByText('Pronóstico Ridge 7d').parentElement?.textContent).toContain('15 unidades → 15 unidades');
    expect(within(comparison).getByText('Pronóstico Ridge 14d').parentElement?.textContent).toContain('30 unidades → 30 unidades');
    expect(within(comparison).getAllByText('Sin cambio observable en esta consulta.')).toHaveLength(2);
    expect(within(comparison).getByText('Modelo activo 7d').parentElement?.textContent).toContain('v1 → v1');
    expect(within(comparison).getByText('Cobertura').parentElement?.textContent).toContain('10 días → 8 días');
    expect(within(comparison).getByText('Riesgo').parentElement?.textContent).toContain('LOW → HIGH');
    expect(forecastRead).toHaveBeenCalledTimes(4);
    expect(within(comparison).getByText(/no atribuye causalidad exclusiva/)).toBeTruthy();
  });

  it('represents unavailable Ridge reads honestly and does not create a forecast fallback', async () => {
    mockScenario();
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue({ success: true, data: {
      ...ridgeForecast(7, 12), status: 'MODEL_NOT_APPROVED', modelFamily: null, activeModelStatus: 'NOT_APPROVED', forecastPeriod: null,
    } });
    render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
    await screen.findByText(/Estado inicial observado/);
    expect(screen.getAllByText('Pronóstico Ridge 7d').every(label => label.parentElement?.textContent?.includes('No disponible'))).toBe(true);
    expect(screen.getAllByText('Pronóstico Ridge 14d').every(label => label.parentElement?.textContent?.includes('No disponible'))).toBe(true);
  });

  it('keeps the raw reason code collapsed under technical details', async () => {
    await prepareChangedScenario();
    vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 200,
      data: analysisResult(7, { outcome: 'DEBOUNCE_NOT_ELAPSED', reasonCode: 'DEBOUNCE_NOT_ELAPSED' }) })
      .mockResolvedValueOnce({ httpStatus: 200,
        data: analysisResult(14, { outcome: 'DEBOUNCE_NOT_ELAPSED', reasonCode: 'DEBOUNCE_NOT_ELAPSED' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    const result = await screen.findByRole('region', { name: 'Resultado de la revisión ML' });
    expect(within(result).getAllByText('El sistema recibió nueva evidencia, pero todavía está agrupando los cambios recientes antes de evaluar un candidato.')).toHaveLength(2);
    const technicalDetails = within(result).getAllByText('Ver detalles técnicos')[0].closest('details');
    expect(technicalDetails?.hasAttribute('open')).toBe(false);
    fireEvent.click(within(result).getAllByText('Ver detalles técnicos')[0]);
    expect(within(result).getAllByText('DEBOUNCE_NOT_ELAPSED').every(code => code.closest('details') !== null)).toBe(true);
    expect(within(result).getAllByText('Entrenamiento')).toHaveLength(2);
    expect(within(result).getAllByText('No')).toHaveLength(6);
  });

  it('does not show scenario choices before checkpoint is READY', async () => {
    mockLocal(active({ checkpoint: { status: 'CREATING' } })); render(<MlTestControlPanel />);
    await screen.findByText('Prueba activa');
    expect(screen.queryByRole('heading', { name: 'Escenario de prueba' })).toBeNull();
    expect(screen.queryByRole('button', { name: /NORMAL|OUTLIER|SHIFT/ })).toBeNull();
  });

  it('restore continue clears scenario and preserves the active cycle at the new epoch', async () => {
    mockScenario();
    const productRead = vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory');
    const mlRead = vi.spyOn(apiClient, 'getForecastMlUpdateStatus');
    const forecastRead = vi.spyOn(apiClient, 'getBusinessIntelligenceForecast');
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: active({ resetEpoch: '5' }) })
      .mockResolvedValue({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockResolvedValue({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    vi.stubGlobal('confirm', vi.fn(() => true)); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
    await screen.findByText(/Estado inicial observado/);
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    expect(await screen.findByText('Punto de restauración aplicado. La prueba continúa activa.')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy(); expect(screen.queryByText(/Estado inicial observado/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Restauración completada' })).toBeTruthy();
    expect(screen.getByText('Coincide con el punto de restauración')).toBeTruthy();
    expect(screen.getByText('Stock').parentElement?.textContent).toContain('Post-restore: 21');
    expect(screen.getByRole('button', { name: 'Repetir escenario' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Elegir otro escenario' })).toBeTruthy();
    expect(productRead).toHaveBeenCalledTimes(2);
    expect(mlRead).toHaveBeenCalledTimes(2);
    expect(forecastRead).toHaveBeenCalledTimes(4);
    expect(restore).toHaveBeenCalledWith('continue'); expect(screen.getByRole('heading', { name: 'Escenario de prueba' })).toBeTruthy();
  });

  it('shows restore progress and keeps destructive actions locked while the restore request is pending', async () => {
    mockScenario();
    const pendingRestore = deferred<Awaited<ReturnType<typeof apiClient.restoreMlTestCheckpoint>>>();
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockReturnValue(pendingRestore.promise);
    vi.stubGlobal('confirm', vi.fn(() => true)); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
    await screen.findByText(/Estado inicial observado/);
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    expect(screen.getByRole('status').textContent).toContain('Restaurando punto de restauración…');
    expect(screen.getByRole('button', { name: 'Restaurando…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Finalizar prueba' }).hasAttribute('disabled')).toBe(true);
    pendingRestore.resolve({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    expect(await screen.findByText(/La restauración terminó, pero no se pudo confirmar/)).toBeTruthy();
  });

  it('reports restore mismatches instead of presenting them as a successful match', async () => {
    mockScenario();
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: active({ resetEpoch: '5' }) })
      .mockResolvedValue({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValueOnce({ success: true, data: inventory(21) })
      .mockResolvedValueOnce({ success: true, data: inventory(20) });
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockResolvedValue({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    vi.stubGlobal('confirm', vi.fn(() => true)); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
    await screen.findByText(/Estado inicial observado/);
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    expect(await screen.findByText(/La restauración terminó; revisa las diferencias de verificación/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('diferencias o lecturas no disponibles');
    expect(screen.queryByText('Coincide con el punto de restauración')).toBeNull();
    expect(screen.getByText(/Post-restore: 20 · Baseline esperado: 21 · Difiere/)).toBeTruthy();
  });

  it('restore finish returns to NO_TEST and removes the scenario workflow', async () => {
    mockScenario();
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: lifecycle({ resetEpoch: '6' }) })
      .mockResolvedValueOnce({ httpStatus: 200, data: lifecycle({ resetEpoch: '6' }) });
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockResolvedValue({ httpStatus: 200, data: lifecycle({ resetEpoch: '5' }) });
    vi.stubGlobal('confirm', vi.fn(() => true)); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
    await screen.findByText(/Estado inicial observado/);
    fireEvent.click(await screen.findByRole('button', { name: 'Finalizar prueba' }));
    expect(await screen.findByText('Sin prueba activa')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Escenario de prueba' })).toBeNull(); expect(restore).toHaveBeenCalledWith('finish');
    expect(screen.getByRole('heading', { name: 'Restauración completada' })).toBeTruthy();
    expect(screen.getAllByText(/Prueba finalizada\. El sistema volvió al punto inicial\./)).toHaveLength(2);
  });

  it('keeps maintenance protective and explains the state', async () => {
    mockLocal(lifecycle({ state: 'RESTORING', resetEpoch: '2', maintenance: true })); render(<MlTestControlPanel />);
    expect(await screen.findByText('Restauración en progreso. Las operaciones están temporalmente bloqueadas.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /iniciar prueba|restaurar punto|finalizar prueba/i })).toBeNull();
  });

  it.each([409, 503])('shows a recoverable message for HTTP %i', async httpStatus => {
    mockLocal(); vi.spyOn(apiClient, 'createMlTestCheckpoint').mockResolvedValue({ httpStatus, code: 'ML_TEST_OPERATION_FAILED' });
    vi.stubGlobal('confirm', vi.fn(() => true)); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar prueba' }));
    const expected = httpStatus === 409 ? 'La operación no puede ejecutarse en el estado actual. Actualiza el estado e inténtalo de nuevo si corresponde.'
      : 'El entorno de pruebas está temporalmente no disponible. Los datos de la prueba se mantienen protegidos.';
    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it('does not invoke sales, worker, manual update, or replay from the scenario panel', async () => {
    mockScenario();
    const replay = vi.spyOn(apiClient, 'getCertifiedForecastReplayEvidence');
    const train = vi.spyOn(apiClient, 'requestForecastMlUpdate');
    const checkpoint = vi.spyOn(apiClient, 'createMlTestCheckpoint');
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint');
    const sale = vi.spyOn(apiClient, 'createTransaction');
    const productRead = vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory');
    render(<MlTestControlPanel />); fireEvent.click(await screen.findByRole('button', { name: /SHIFT/ }));
    await screen.findByText(/Estado inicial observado/);
    expect(replay).not.toHaveBeenCalled(); expect(train).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
    expect(sale).not.toHaveBeenCalled();
    expect(productRead).toHaveBeenCalledWith('BEB-AGU-001');
  });

  it('shows analysis control only after observed changes, then calls 7d before 14d sequentially', async () => {
    await prepareChangedScenario();
    const analyze = vi.spyOn(apiClient, 'analyzeMlTestScenario');
    let resolve7!: (value: Awaited<ReturnType<typeof apiClient.analyzeMlTestScenario>>) => void;
    analyze.mockImplementationOnce(() => new Promise(resolve => { resolve7 = resolve; }))
      .mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(14) });
    expect(screen.getByRole('button', { name: 'Analizar escenario' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('madurez, debounce, cooldown y 107 orígenes'));
    await waitFor(() => expect(analyze).toHaveBeenNthCalledWith(1, 7));
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Analizando 7 días…' }).hasAttribute('disabled')).toBe(true);
    resolve7({ httpStatus: 200, data: analysisResult(7) });
    await waitFor(() => expect(analyze).toHaveBeenNthCalledWith(2, 14));
    expect(analyze.mock.invocationCallOrder[0]).toBeLessThan(analyze.mock.invocationCallOrder[1]);
    expect(await screen.findAllByText('Todavía no existe suficiente evidencia temporal madura para evaluar un nuevo modelo.')).toHaveLength(4);
    expect(screen.getAllByText('107 / No disponible')).toHaveLength(2);
    expect(screen.getAllByText('Entrenamiento').length).toBe(2);
    const resultRegion = screen.getByRole('region', { name: 'Resultado de la revisión ML' });
    expect(resultRegion.textContent).toContain('Entrenar un candidato tampoco significa promoverlo');
    expect(resultRegion.textContent).toContain('la política de promoción sigue siendo la autoridad final');
  });

  it.each([
    ['DEBOUNCE_NOT_ELAPSED', 'El sistema recibió nueva evidencia, pero todavía está agrupando los cambios recientes antes de evaluar un candidato.'],
    ['COOLDOWN_ACTIVE', 'El sistema mantiene un intervalo de seguridad antes de otra evaluación.'],
    ['NO_PENDING_WORK', 'No hay cambios pendientes por evaluar.'],
  ])('presents %s in teacher-friendly language', async (outcome, copy) => {
    await prepareChangedScenario();
    vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 200,
      data: analysisResult(7, { outcome, reasonCode: outcome }) })
      .mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(14, { outcome, reasonCode: outcome }) });
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    expect(await screen.findAllByText(copy)).toHaveLength(2);
  });

  it('keeps training, candidate and promotion separate and never claims promotion from outcome alone', async () => {
    await prepareChangedScenario();
    vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 200,
      data: analysisResult(7, { outcome: 'PROMOTED', trained: true, candidateCreated: true, promoted: false }) })
      .mockResolvedValueOnce({ httpStatus: 200,
        data: analysisResult(14, { outcome: 'PROMOTED', trained: true, candidateCreated: true, promoted: true,
          activeModelAfter: { modelVersion: 2, trainedDataVersion: '174', dataCutoff: '2026-10-18' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    expect(await screen.findByText('El worker reportó PROMOTED, pero no se confirmó un cambio de modelo ACTIVE.')).toBeTruthy();
    expect(await screen.findByText('Modelo promovido.')).toBeTruthy();
    expect(screen.getByText('ACTIVE: v1 → v1')).toBeTruthy();
    expect(screen.getByText('ACTIVE: v1 → v2')).toBeTruthy();
    expect(screen.getAllByText('Sí')).toHaveLength(5);
  });

  it('stops after a 7d error and preserves 7d when 14d fails', async () => {
    await prepareChangedScenario();
    const analyze = vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 503 })
      .mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(7) })
      .mockResolvedValueOnce({ httpStatus: 409 });
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    expect(await screen.findByText('El análisis local está temporalmente no disponible.')).toBeTruthy();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/no se ejecutó el horizonte de 14 días/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    await waitFor(() => expect(screen.getAllByText('Todavía no existe suficiente evidencia temporal madura para evaluar un nuevo modelo.')).toHaveLength(2));
    expect(await screen.findByText('El ciclo de prueba cambió o existe otra operación incompatible.')).toBeTruthy();
    expect(analyze).toHaveBeenCalledTimes(3);
  });

  it('clears analysis results and stops before 14d when cycle or epoch becomes stale', async () => {
    await prepareChangedScenario();
    const lifecycleRead = vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    const analyze = vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(7) });
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    expect(await screen.findByText('El ciclo de prueba cambió durante el análisis. Actualiza el estado antes de continuar.')).toBeTruthy();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Resultado de la revisión ML' })).toBeNull();
    expect(lifecycleRead).toHaveBeenCalled();
  });

  it('blocks a second analysis click while the request is running', async () => {
    await prepareChangedScenario();
    let resolve!: (value: Awaited<ReturnType<typeof apiClient.analyzeMlTestScenario>>) => void;
    const analyze = vi.spyOn(apiClient, 'analyzeMlTestScenario').mockImplementation(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    const running = await screen.findByRole('button', { name: 'Analizando 7 días…' });
    fireEvent.click(running);
    expect(analyze).toHaveBeenCalledTimes(1);
    resolve({ httpStatus: 200, data: analysisResult(7) });
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    resolve({ httpStatus: 200, data: analysisResult(14) });
  });

  it('clears analysis results after restoring the active checkpoint', async () => {
    await prepareChangedScenario();
    vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(7) })
      .mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(14) });
    vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockResolvedValue({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    await screen.findByRole('region', { name: 'Resultado de la revisión ML' });
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar punto de restauración' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Resultado de la revisión ML' })).toBeNull());
    expect(screen.queryByText(/Estado inicial observado/)).toBeNull();
  });

  it('does not call live update, sales or replay when analyzing a local scenario', async () => {
    await prepareChangedScenario();
    const analyze = vi.spyOn(apiClient, 'analyzeMlTestScenario').mockResolvedValueOnce({ httpStatus: 200,
      data: analysisResult(7, { outcome: 'NO_PENDING_WORK', reasonCode: 'NO_PENDING_WORK' }) })
      .mockResolvedValueOnce({ httpStatus: 200, data: analysisResult(14, { outcome: 'NO_PENDING_WORK', reasonCode: 'NO_PENDING_WORK' }) });
    const live = vi.spyOn(apiClient, 'requestForecastMlUpdate');
    const sale = vi.spyOn(apiClient, 'createTransaction');
    const replay = vi.spyOn(apiClient, 'getCertifiedForecastReplayEvidence');
    fireEvent.click(screen.getByRole('button', { name: 'Analizar escenario' }));
    const results = await screen.findByRole('region', { name: 'Resultado de la revisión ML' });
    await waitFor(() => expect(within(results).getAllByText('No hay cambios pendientes por evaluar.')).toHaveLength(2));
    expect(analyze.mock.calls.map(call => call[0])).toEqual([7, 14]);
    expect(live).not.toHaveBeenCalled(); expect(sale).not.toHaveBeenCalled(); expect(replay).not.toHaveBeenCalled();
  });
});
