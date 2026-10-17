import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastMlUpdatePanel, nextAutomaticReview } from '@/components/business-intelligence/ForecastMlUpdatePanel';
import { ForecastDiagnosticsPanel } from '@/components/business-intelligence/ForecastDiagnosticsPanel';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ForecastActiveModels, ForecastMlUpdateStatus, HealthDiagnostic } from '@/types/businessIntelligence';

const models: ForecastActiveModels = { models: [
  { horizonDays: 1, status: 'MODEL_NOT_APPROVED', activeModelStatus: 'NOT_APPROVED', modelFamily: 'RIDGE', recipeId: null },
  { horizonDays: 7, status: 'ACTIVE', activeModelStatus: 'ACTIVE', modelVersion: 1, trainedDataVersion: '83', modelFamily: 'RIDGE', recipeId: null },
  { horizonDays: 14, status: 'ACTIVE', activeModelStatus: 'ACTIVE', modelVersion: 1, trainedDataVersion: '83', modelFamily: 'RIDGE', recipeId: null },
] };
const health: HealthDiagnostic = { httpStatus: 200, dependencyStatus: { inventory: 'READY', forecast: 'READY', supplier: 'READY', healthAssembly: 'READY' }, reasonCode: null, elapsedMs: 2 };
const horizon = (horizonDays: 7 | 14, patch: Record<string, unknown> = {}) => ({
  horizonDays, activeModelVersion: 1, trainedDataVersion: '83', pending: false, currentlyRunning: false,
  trigger: 'AUTO' as const, lastRequestAt: null, lastAttemptAt: null, lastEvaluatedAt: null,
  lastResult: null, lastEvaluationReason: null, eligibility: 'NO_PENDING_WORK', nextEligibleAt: null,
  requestStatus: 'LAST_RESULT_NO_PENDING', dispatchStatus: null, availableOrigins: 0, requiredOrigins: 107 as const, ...patch,
});
const initialStatus: ForecastMlUpdateStatus = { dataVersion: '83', closedThrough: '2026-10-16', horizons: [horizon(7), horizon(14)] };
const ok = <T,>(data: T): AuthenticatedDiagnosticResult<T> => ({ httpStatus: 200, data });

describe('Forecast manual ML update panel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue(ok(initialStatus));
    vi.spyOn(apiClient, 'requestForecastMlUpdate').mockResolvedValue(ok({ requestStatus: 'REQUEST_ACCEPTED',
      trigger: 'MANUAL', pending: true, horizons: [7, 14], dispatchStatus: 'DISPATCHED', messageCode: 'ML_UPDATE_REQUESTED' }));
    vi.spyOn(apiClient, 'getForecastModelDiagnostics').mockResolvedValue(ok(models));
    vi.spyOn(apiClient, 'getHealthDiagnostics').mockResolvedValue(ok(health));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('loads status, shows active 7d/14d models and automatic schedule', async () => {
    render(<ForecastMlUpdatePanel />);
    expect((await screen.findAllByText('v1')).length).toBe(2);
    expect(screen.getByText('Actualización automática:')).toBeTruthy();
    expect(screen.getByText('ACTIVO')).toBeTruthy();
    expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it('submits one empty-body request and shows accepted copy', async () => {
    render(<ForecastMlUpdatePanel />);
    await screen.findByText('ACTIVO');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    expect(await screen.findByText('Actualización solicitada.')).toBeTruthy();
    expect(apiClient.requestForecastMlUpdate).toHaveBeenCalledTimes(1);
    expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ALREADY_PENDING', 'Ya existe una actualización pendiente.'],
    ['RUNNING', 'La actualización está en curso.'],
  ] as const)('shows response copy for %s', async (requestStatus, copy) => {
    vi.mocked(apiClient.requestForecastMlUpdate).mockResolvedValueOnce(ok({ requestStatus,
      trigger: 'MANUAL', pending: true, horizons: [7, 14], dispatchStatus: 'DISPATCHED', messageCode: requestStatus }));
    render(<ForecastMlUpdatePanel />); await screen.findByText('ACTIVO');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    expect(await screen.findByText(copy)).toBeTruthy();
  });

  it('shows DEFERRED as saved for automatic processing', async () => {
    vi.mocked(apiClient.requestForecastMlUpdate).mockResolvedValueOnce(ok({ requestStatus: 'REQUEST_ACCEPTED',
      trigger: 'MANUAL', pending: true, horizons: [7, 14], dispatchStatus: 'DEFERRED', messageCode: 'ML_UPDATE_REQUESTED' }));
    render(<ForecastMlUpdatePanel />); await screen.findByText('ACTIVO');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    expect(await screen.findByText('Solicitud guardada; se procesará automáticamente.')).toBeTruthy();
  });

  it('presents insufficient mature evidence in plain language and keeps the code in technical details', async () => {
    const status = { ...initialStatus, horizons: [horizon(7, { lastResult: 'LAST_RESULT_INSUFFICIENT_HISTORY',
      lastEvaluationReason: 'NO_PROMOTION_INSUFFICIENT_HISTORY' }), horizon(14)] } as ForecastMlUpdateStatus;
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue(ok(status));
    render(<ForecastMlUpdatePanel />);
    expect(await screen.findByText('NO ELEGIBLE')).toBeTruthy();
    expect(screen.getByText('El sistema recibió la solicitud, pero aún no hay suficiente evidencia madura para generar un nuevo modelo.')).toBeTruthy();
    expect(screen.queryByText('NO_PROMOTION_INSUFFICIENT_HISTORY')).toBeNull();
    fireEvent.click(screen.getByText('Detalles técnicos'));
    expect(screen.getByText(/NO_PROMOTION_INSUFFICIENT_HISTORY/)).toBeTruthy();
  });

  it('polls each eight seconds, confirms completion with one final read and announces it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-17T06:00:00Z'));
    const pending = { ...initialStatus, horizons: [horizon(7, { pending: true, trigger: 'MANUAL' }), horizon(14, { pending: true, trigger: 'MANUAL' })] } as ForecastMlUpdateStatus;
    const settled = { ...initialStatus, horizons: [horizon(7, { lastResult: 'LAST_RESULT_NO_PENDING' }), horizon(14, { lastResult: 'LAST_RESULT_NO_PENDING' })] } as ForecastMlUpdateStatus;
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus))
      .mockResolvedValueOnce(ok(pending)).mockResolvedValueOnce(ok(settled)).mockResolvedValueOnce(ok(settled));
    render(<ForecastMlUpdatePanel />);
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(8_000);
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('Evaluación completada. No fue necesario cambiar el modelo.')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(4);
  });

  it('keeps polling while a horizon is running even when it is no longer pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = { ...initialStatus, horizons: [horizon(7, { pending: false, currentlyRunning: true }), horizon(14)] } as ForecastMlUpdateStatus;
    const settled = { ...initialStatus, horizons: [horizon(7, { lastResult: 'LAST_RESULT_PROMOTED' }), horizon(14)] } as ForecastMlUpdateStatus;
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus))
      .mockResolvedValueOnce(ok(running)).mockResolvedValueOnce(ok(settled)).mockResolvedValueOnce(ok(settled));
    render(<ForecastMlUpdatePanel />);
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(8_000);
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('Evaluación completada. Se activó una nueva versión.')).toBeTruthy();
  });

  it('switches to slower polling after two minutes and stops after an eight-minute window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = { ...initialStatus, horizons: [horizon(7, { pending: true }), horizon(14, { pending: true })] } as ForecastMlUpdateStatus;
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus)).mockResolvedValue(ok(pending));
    render(<ForecastMlUpdatePanel />); await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.mocked(apiClient.getForecastMlUpdateStatus).mock.calls.length).toBe(17);
    await vi.advanceTimersToNextTimerAsync();
    expect(vi.mocked(apiClient.getForecastMlUpdateStatus).mock.calls.length).toBe(18);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(vi.mocked(apiClient.getForecastMlUpdateStatus).mock.calls.length).toBe(18);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(apiClient.getForecastMlUpdateStatus).mock.calls.length).toBe(19);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(vi.mocked(apiClient.getForecastMlUpdateStatus).mock.calls.length).toBeLessThanOrEqual(44);
    expect(await screen.findByText('La evaluación continúa en segundo plano. Puedes actualizar el estado manualmente más tarde.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Actualizar ML ahora' }).hasAttribute('disabled')).toBe(true);
  });

  it('prevents double clicks and shows a recoverable API error', async () => {
    let resolveRequest: (value: AuthenticatedDiagnosticResult<import('@/types/businessIntelligence').ForecastMlUpdateRequestResult>) => void = () => {};
    vi.mocked(apiClient.requestForecastMlUpdate).mockReturnValueOnce(new Promise(resolve => { resolveRequest = resolve; }));
    render(<ForecastMlUpdatePanel />); await screen.findByText('ACTIVO');
    const button = screen.getByRole('button', { name: 'Actualizar ML ahora' });
    fireEvent.click(button); fireEvent.click(button);
    expect(apiClient.requestForecastMlUpdate).toHaveBeenCalledTimes(1);
    resolveRequest({ httpStatus: 429, code: 'ML_UPDATE_RATE_LIMITED' });
    expect(await screen.findByText(/Se alcanzó el límite de solicitudes/)).toBeTruthy();
  });

  it('keeps the 1d approval policy and both Ridge horizons visible', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={vi.fn()} />);
    expect(await screen.findByText('No aprobado')).toBeTruthy();
    expect(screen.getByText('7 días')).toBeTruthy();
    expect(screen.getByText('14 días')).toBeTruthy();
    expect(screen.getByText('1 día')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Actualizar ML ahora' })).toBeTruthy();
  });

  it('refreshes worker status when the existing diagnostics refresh button is used', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={vi.fn()} />);
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(2));
  });

  it('computes the next scheduled UTC cron minute as Peru local time', () => {
    expect(nextAutomaticReview(new Date('2026-10-17T06:00:00Z'))).toContain('01:17');
    expect(nextAutomaticReview(new Date('2026-10-17T06:20:00Z'))).toContain('07:17');
  });
});
