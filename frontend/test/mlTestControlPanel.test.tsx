import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MlTestControlPanel } from '@/components/business-intelligence/MlTestControlPanel';
import { apiClient } from '@/lib/api';
import type { ForecastMlUpdateStatus, MlTestControlStatus, MlTestLifecycleStatus, ProductInventory } from '@/types/businessIntelligence';

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

function mockLocal(status = lifecycle()) {
  vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: allowed });
  vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValue({ httpStatus: 200, data: status });
}
function mockScenario(status = active(), stock = 21) {
  mockLocal(status);
  vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValue({ success: true, data: inventory(stock) });
  vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: mlStatus(173) });
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
    expect(await screen.findByText('LOCAL AUTORIZADO')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Iniciar prueba' })).toBeTruthy();
    expect(screen.getByText('SIN PRUEBA ACTIVA')).toBeTruthy();
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
    expect(screen.getByRole('button', { name: 'Creando checkpoint…' }).hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(screen.getByText('TEST ACTIVE')).toBeTruthy());
    expect(create).toHaveBeenCalledTimes(1); expect(status).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Checkpoint creado. La prueba local está activa.')).toBeTruthy();
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
    expect(screen.getByText('21')).toBeTruthy();
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
    expect(screen.getByText(/Stock: 21 · Revisión operativa: 173/)).toBeTruthy();
    fireEvent.click(saleLink);
    expect(screen.getByText(/Stock: 21 · Revisión operativa: 173/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Comprobar cambios' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar cambios' }));
    expect(await screen.findByText('21 → 20')).toBeTruthy();
    expect(screen.getByText('173 → 174')).toBeTruthy();
    expect(screen.getAllByText('0 → 1')).toHaveLength(2);
    expect(screen.getByText('107 orígenes maduros no significan 107 ventas.')).toBeTruthy();
    expect(screen.getAllByText('El sistema está agrupando cambios recientes antes de evaluarlos.')).toHaveLength(2);
    expect(screen.getByText('Escenario listo para análisis')).toBeTruthy();
    expect(productRead).toHaveBeenCalledTimes(2); expect(mlRead).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(checkpoint).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(manualRequest).not.toHaveBeenCalled();
  });

  it('does not show scenario choices before checkpoint is READY', async () => {
    mockLocal(active({ checkpoint: { status: 'CREATING' } })); render(<MlTestControlPanel />);
    await screen.findByText('TEST ACTIVE');
    expect(screen.queryByRole('heading', { name: 'Escenario de prueba' })).toBeNull();
    expect(screen.queryByRole('button', { name: /NORMAL|OUTLIER|SHIFT/ })).toBeNull();
  });

  it('restore continue clears scenario and preserves the active cycle at the new epoch', async () => {
    mockScenario();
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockResolvedValue({ httpStatus: 200, data: active({ resetEpoch: '5' }) });
    vi.stubGlobal('confirm', vi.fn(() => true)); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /NORMAL/ }));
    await screen.findByText(/Estado inicial observado/);
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar checkpoint' }));
    expect(await screen.findByText('Checkpoint restaurado. El ciclo de prueba continúa activo.')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy(); expect(screen.queryByText(/Estado inicial observado/)).toBeNull();
    expect(restore).toHaveBeenCalledWith('continue'); expect(screen.getByRole('heading', { name: 'Escenario de prueba' })).toBeTruthy();
  });

  it('restore finish returns to NO_TEST and removes the scenario workflow', async () => {
    mockScenario();
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: active() })
      .mockResolvedValueOnce({ httpStatus: 200, data: lifecycle({ resetEpoch: '5' }) });
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockResolvedValue({ httpStatus: 200, data: lifecycle({ resetEpoch: '5' }) });
    vi.stubGlobal('confirm', vi.fn(() => true)); render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Finalizar prueba' }));
    expect(await screen.findByText('SIN PRUEBA ACTIVA')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Escenario de prueba' })).toBeNull(); expect(restore).toHaveBeenCalledWith('finish');
  });

  it('keeps maintenance protective and explains the state', async () => {
    mockLocal(lifecycle({ state: 'RESTORING', resetEpoch: '2', maintenance: true })); render(<MlTestControlPanel />);
    expect(await screen.findByText('Restauración en progreso. Las operaciones están temporalmente bloqueadas.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /iniciar prueba|restaurar checkpoint|finalizar prueba/i })).toBeNull();
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
});
