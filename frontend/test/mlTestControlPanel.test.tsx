import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MlTestControlPanel } from '@/components/business-intelligence/MlTestControlPanel';
import { apiClient } from '@/lib/api';
import type { MlTestControlStatus, MlTestLifecycleStatus } from '@/types/businessIntelligence';

const allowed: MlTestControlStatus = { state: 'NO_TEST', resetEpoch: '0', testCycleId: null, maintenance: false,
  cloudRestoreEnabled: false, capabilities: { destructiveMlTestControls: { allowed: true, target: 'LOCAL', reasonCode: null } } };
const denied: MlTestControlStatus = { ...allowed, capabilities: { destructiveMlTestControls: { allowed: false, target: null, reasonCode: 'ML_TEST_PRODUCTION_FORBIDDEN' } } };
const lifecycle = (overrides: Partial<MlTestLifecycleStatus> = {}): MlTestLifecycleStatus => ({ state: 'NO_TEST', resetEpoch: '0', testCycleId: null,
  maintenance: false, cloudRestoreEnabled: false, checkpointId: null, checkpoint: null, ...overrides });

function mockLocal(status = lifecycle()) {
  vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: allowed });
  vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValue({ httpStatus: 200, data: status });
}

describe('ML test control panel', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('fails closed without local capability and does not call administrative endpoints', async () => {
    vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: denied });
    const lifecycleRead = vi.spyOn(apiClient, 'getMlTestLifecycleStatus');
    const checkpoint = vi.spyOn(apiClient, 'createMlTestCheckpoint');
    render(<MlTestControlPanel />);
    expect(await screen.findByText('Las pruebas destructivas del ML solo están disponibles en el entorno local autorizado.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /iniciar prueba|restaurar checkpoint|finalizar prueba/i })).toBeNull();
    expect(lifecycleRead).not.toHaveBeenCalled(); expect(checkpoint).not.toHaveBeenCalled();
  });

  it('requires target LOCAL even if the capability is otherwise allowed', async () => {
    vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: { ...allowed,
      capabilities: { destructiveMlTestControls: { allowed: true, target: null, reasonCode: null } } } });
    const lifecycleRead = vi.spyOn(apiClient, 'getMlTestLifecycleStatus');
    render(<MlTestControlPanel />);
    expect(await screen.findByText('Las pruebas destructivas del ML solo están disponibles en el entorno local autorizado.')).toBeTruthy();
    expect(lifecycleRead).not.toHaveBeenCalled();
  });

  it('shows local lifecycle controls only after explicit LOCAL capability', async () => {
    mockLocal();
    render(<MlTestControlPanel />);
    expect(await screen.findByText('LOCAL AUTORIZADO')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Iniciar prueba' })).toBeTruthy();
    expect(screen.getByText('SIN PRUEBA ACTIVA')).toBeTruthy();
  });

  it('starts a test with one checkpoint request, locks while processing, and refreshes status', async () => {
    mockLocal();
    const create = vi.spyOn(apiClient, 'createMlTestCheckpoint').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { httpStatus: 201, data: { ...lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '1', testCycleId: 'cycle-1' }), status: 'READY' } };
    });
    const status = vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: lifecycle() })
      .mockResolvedValueOnce({ httpStatus: 200, data: lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '1', testCycleId: 'cycle-1', checkpoint: { status: 'READY' } }) });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar prueba' }));
    expect(screen.getByRole('button', { name: 'Creando checkpoint…' }).hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(screen.getByText('TEST ACTIVE')).toBeTruthy());
    expect(create).toHaveBeenCalledTimes(1); expect(status).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Checkpoint creado. La prueba local está activa.')).toBeTruthy();
  });

  it('restore continue uses the real mode, refreshes epoch and keeps the cycle active', async () => {
    mockLocal(lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '1', testCycleId: 'cycle-1', checkpoint: { status: 'READY' } }));
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockResolvedValue({ httpStatus: 200, data: lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '2', testCycleId: 'cycle-1' }) });
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '1', testCycleId: 'cycle-1', checkpoint: { status: 'READY' } }) })
      .mockResolvedValueOnce({ httpStatus: 200, data: lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '2', testCycleId: 'cycle-1', checkpoint: { status: 'READY' } }) });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restaurar checkpoint' }));
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());
    expect(restore).toHaveBeenCalledWith('continue'); expect(screen.getByText('TEST ACTIVE')).toBeTruthy();
  });

  it('restore finish uses finish mode and returns to NO_TEST', async () => {
    mockLocal(lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '1', testCycleId: 'cycle-1', checkpoint: { status: 'READY' } }));
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint').mockResolvedValue({ httpStatus: 200, data: lifecycle({ state: 'NO_TEST', resetEpoch: '2' }) });
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValueOnce({ httpStatus: 200, data: lifecycle({ state: 'TEST_ACTIVE', resetEpoch: '1', testCycleId: 'cycle-1', checkpoint: { status: 'READY' } }) })
      .mockResolvedValueOnce({ httpStatus: 200, data: lifecycle({ state: 'NO_TEST', resetEpoch: '2' }) });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Finalizar prueba' }));
    await waitFor(() => expect(screen.getByText('SIN PRUEBA ACTIVA')).toBeTruthy());
    expect(restore).toHaveBeenCalledWith('finish');
  });

  it('maintenance blocks controls and explains the maintenance state', async () => {
    mockLocal(lifecycle({ state: 'RESTORING', resetEpoch: '2', maintenance: true }));
    render(<MlTestControlPanel />);
    expect(await screen.findByText('Restauración en progreso. Las operaciones están temporalmente bloqueadas.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /iniciar prueba|restaurar checkpoint|finalizar prueba/i })).toBeNull();
  });

  it.each([409, 503])('shows a recoverable message for HTTP %i without breaking the panel', async httpStatus => {
    mockLocal();
    vi.spyOn(apiClient, 'createMlTestCheckpoint').mockResolvedValue({ httpStatus, code: 'ML_TEST_OPERATION_FAILED' });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar prueba' }));
    const expected = httpStatus === 409
      ? 'La operación no puede ejecutarse en el estado actual. Actualiza el estado e inténtalo de nuevo si corresponde.'
      : 'El entorno de pruebas está temporalmente no disponible. Los datos de la prueba se mantienen protegidos.';
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Pruebas del Machine Learning' })).toBeTruthy();
  });

  it('shows a recoverable message after a network failure', async () => {
    mockLocal();
    vi.spyOn(apiClient, 'createMlTestCheckpoint').mockResolvedValue({ httpStatus: 0, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<MlTestControlPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar prueba' }));
    expect(await screen.findByText('No se pudo conectar con el entorno de pruebas. Puedes volver a consultar el estado.')).toBeTruthy();
  });

  it('keeps replay read-only and does not add horizon or training controls', async () => {
    mockLocal();
    const replay = vi.spyOn(apiClient, 'getCertifiedForecastReplayEvidence');
    const train = vi.spyOn(apiClient, 'requestForecastMlUpdate');
    render(<MlTestControlPanel />);
    await screen.findByRole('button', { name: 'Iniciar prueba' });
    expect(replay).not.toHaveBeenCalled(); expect(train).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /1 día|7 días|14 días|normal|outlier|shift/i })).toBeNull();
  });
});
