import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastMlUpdatePanel, nextAutomaticReview } from '@/components/business-intelligence/ForecastMlUpdatePanel';
import { ForecastMlUpdateHistoryPanel } from '@/components/business-intelligence/ForecastMlUpdateHistoryPanel';
import { ForecastDiagnosticsPanel } from '@/components/business-intelligence/ForecastDiagnosticsPanel';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ForecastActiveModels, ForecastMlUpdateExecution, ForecastMlUpdateExecutionDetail, ForecastMlUpdateStatus, HealthDiagnostic } from '@/types/businessIntelligence';

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
  requestStatus: 'LAST_RESULT_NO_PENDING', dispatchStatus: null, availableOrigins: null, requiredOrigins: 107 as const,
  readiness: { status: 'NO_CHANGES' as const, reasonCode: 'NO_PENDING_WORK', hasPendingSignals: false,
    pendingSignalCount: 0, pendingSignalTypes: [], firstPendingSignalAt: null, lastPendingSignalAt: null,
    pendingSince: null, lastDirtyAt: null, nextEligibleAt: null, eligibility: 'NO_PENDING_WORK',
    latestMatureOrigin: null, lastTrainedMatureOrigin: null, processedRevision: '83', latestPendingRevision: null,
    requiredOrigins: 107 as const, availableOriginsActual: null }, ...patch,
});
const initialStatus: ForecastMlUpdateStatus = { dataVersion: '83', closedThrough: '2026-10-16', horizons: [horizon(7), horizon(14)] };
const manualPendingStatus = (status: ForecastMlUpdateStatus) => {
  const activate = (row: ForecastMlUpdateStatus['horizons'][number]) => ({ ...row, pending: true,
    trigger: 'MANUAL' as const, requestStatus: 'ALREADY_PENDING' });
  const horizons: ForecastMlUpdateStatus['horizons'] = [activate(status.horizons[0]), activate(status.horizons[1])];
  return { ...status, horizons };
};
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
    expect(await screen.findByText('Modelos activos')).toBeTruthy();
    expect(screen.getByText('Estado de evidencia')).toBeTruthy();
    expect(screen.getByText('Elegibilidad actual')).toBeTruthy();
    expect(screen.getByText(/Ridge LIVE · 7 días/).parentElement?.textContent).toContain('v1');
    expect(screen.getByText(/Ridge LIVE · 14 días/).parentElement?.textContent).toContain('v1');
    expect(screen.getByText('Actualización automática').parentElement?.textContent).toContain('Activa');
    expect(screen.getByText('Preparación para próxima evaluación')).toBeTruthy();
    expect(screen.getByText('No hay señales pendientes; los modelos LIVE siguen disponibles.')).toBeTruthy();
    expect(screen.getAllByText('Ver detalles técnicos')).toHaveLength(1);
    fireEvent.click(screen.getByText('Ver detalles técnicos'));
    expect(screen.getAllByText('107 orígenes maduros no significan 107 ventas.')).toHaveLength(1);
    expect(screen.queryByText('Sin cambios nuevos para revisar.')).toBeNull();
    expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['WAITING_MATURITY', 'Hay evidencia pendiente, pero todavía no es madura.'],
    ['WAITING_DEBOUNCE', 'Hay evidencia pendiente; el sistema agrupa los cambios antes de revisar.'],
    ['WAITING_COOLDOWN', 'Hay evidencia pendiente; se espera el intervalo de seguridad para revisarla.'],
    ['READY_FOR_WORKER_REVIEW', 'Hay evidencia lista para revisión; esto no implica que un modelo vaya a promoverse.'],
  ] as const)('explains %s without claiming current origins', async (readinessStatus, copy) => {
    const status = { ...initialStatus, horizons: [horizon(7, { readiness: {
      ...horizon(7).readiness, status: readinessStatus, hasPendingSignals: true,
      pendingSignalCount: 2, pendingSignalTypes: ['SALE_COMPLETED'], firstPendingSignalAt: '2026-10-17T15:00:00.000Z',
      lastPendingSignalAt: '2026-10-17T16:00:00.000Z', availableOriginsActual: null,
    } }), horizon(14)] as [ReturnType<typeof horizon>, ReturnType<typeof horizon>] } satisfies ForecastMlUpdateStatus;
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue(ok(status));
    render(<ForecastMlUpdatePanel />);
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.getByText('Señales pendientes: 7d 2 · 14d 0')).toBeTruthy();
    expect(screen.getByText('Ver detalles técnicos').closest('details')?.hasAttribute('open')).toBe(false);
    fireEvent.click(screen.getByText('Ver detalles técnicos'));
    expect(screen.getByText('Venta completada')).toBeTruthy();
    expect(screen.getByText(/Señales pendientes: 7d 2/)).toBeTruthy();
  });

  it('shows an active worker review as distinct from pending signals or promotion', async () => {
    const status = { ...initialStatus, horizons: [horizon(7, { currentlyRunning: true, readiness: {
      ...horizon(7).readiness, status: 'WORKER_ACTIVE', reasonCode: 'LEASE_ACTIVE', eligibility: 'LEASE_ACTIVE',
    } }), horizon(14)] as [ReturnType<typeof horizon>, ReturnType<typeof horizon>] } satisfies ForecastMlUpdateStatus;
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue(ok(status));
    render(<ForecastMlUpdatePanel />);
    expect(await screen.findByText('Revisión en curso')).toBeTruthy();
    expect(screen.getByText('Hay una revisión en curso para uno de los horizontes.')).toBeTruthy();
    expect(screen.queryByText(/orígenes disponibles: \d+\/107/)).toBeNull();
  });

  it('distinguishes operational status timestamps from a later scheduled durable execution', async () => {
    const manualState = { ...initialStatus, horizons: [horizon(7, {
      lastRequestAt: '2026-10-17T19:07:00.000Z', lastAttemptAt: '2026-10-17T07:05:00.000Z',
      lastEvaluatedAt: '2026-10-17T19:07:00.000Z', lastResult: 'LAST_RESULT_NO_PENDING',
    }), horizon(14, {
      lastRequestAt: '2026-10-17T19:07:00.000Z', lastAttemptAt: '2026-10-17T07:05:00.000Z',
      lastEvaluatedAt: '2026-10-17T19:07:00.000Z', lastResult: 'LAST_RESULT_NO_PENDING',
    })] } satisfies ForecastMlUpdateStatus;
    const scheduled: ForecastMlUpdateExecution = {
      executionId: '11111111-1111-4111-8111-111111111111', triggerSource: 'SCHEDULED', requestSource: 'SCHEDULED',
      requestedAt: '2026-10-17T20:35:00.000Z', startedAt: '2026-10-17T20:35:00.000Z', finishedAt: '2026-10-17T20:35:15.000Z',
      status: 'NO_PENDING_WORK', reasonCode: 'NO_PENDING_WORK', dataVersionEvaluated: '83', observationsClosedThrough: '2026-10-15',
      availableOrigins: null, requiredOrigins: 107, pendingBefore: false, pendingAfter: false,
      horizons: [7, 14].map(horizonDays => ({ horizonDays: horizonDays as 7 | 14, activeVersionBefore: 1,
        activeVersionAfter: 1, candidateVersion: null, resultStatus: 'NO_PENDING_WORK' as const,
        promotionDecision: 'NOT_EVALUATED' as const, promotionReason: 'NO_PENDING_WORK', availableOrigins: null,
        requiredOrigins: 107 as const, trainingJobReference: null })),
      impact: { status: 'NOT_APPLICABLE', reasonCode: 'NO_MODEL_PROMOTION',
        prediction: { status: 'NOT_CAPTURED', reasonCode: 'NO_MODEL_PROMOTION', summary: null },
        inventory: { status: 'NOT_CAPTURED', reasonCode: 'NO_MODEL_PROMOTION', summary: null } },
    };
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue(ok(manualState));
    vi.spyOn(apiClient, 'getForecastMlUpdateHistory').mockResolvedValue(ok({
      items: [scheduled], page: { limit: 20, nextCursor: null },
    }));
    const scheduledDetail: ForecastMlUpdateExecutionDetail = {
      ...scheduled, stage: 'FINISHED', eligibility: 'NO_PENDING_WORK', signalTypes: [], attempts: [],
      dataVersionBefore: '83', message: 'NO_PENDING_WORK',
      impact: { ...scheduled.impact, prediction: { ...scheduled.impact.prediction, versions: [] } },
    };
    vi.spyOn(apiClient, 'getForecastMlUpdateExecution').mockResolvedValue(ok(scheduledDetail));

    render(<><ForecastMlUpdatePanel /><ForecastMlUpdateHistoryPanel /></>);

    fireEvent.click(await screen.findByText('Ver detalles técnicos'));
    const requestLabel = await screen.findByText('Última solicitud manual');
    const workerLabel = screen.getByText('Último intento elegible del worker');
    expect(requestLabel.parentElement?.textContent).toContain('2:07');
    expect(workerLabel.parentElement?.textContent).toContain('2:05');
    expect(screen.queryByText('Última ejecución')).toBeNull();
    expect(screen.getByRole('region', { name: 'Historial de actualizaciones ML' })).toBeTruthy();
    fireEvent.click(screen.getByText('Ver detalles técnicos'));
    expect(screen.getByText('Cierre operativo vigente').parentElement?.textContent).toMatch(/16 oct/);
    const automaticLabel = await screen.findByText(/Automático/);
    expect(automaticLabel.closest('article')?.textContent).toContain('3:35');
    expect(automaticLabel.closest('article')?.textContent).toContain('Sin trabajo pendiente');
    fireEvent.click(within(automaticLabel.closest('article')!).getByRole('button', { name: 'Ver detalle' }));
    const capturedClosedThrough = await within(automaticLabel.closest('article')!).findByText(/Observaciones cerradas para esta ejecución:/);
    expect(capturedClosedThrough.parentElement?.textContent).toMatch(/15 oct/);
    fireEvent.click(within(automaticLabel.closest('article')!).getByText('Detalles técnicos'));
    expect(within(automaticLabel.closest('article')!).getAllByText(/NO_PENDING_WORK/).length).toBeGreaterThan(0);
  });

  it('submits one empty-body request and shows accepted copy', async () => {
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus))
      .mockResolvedValueOnce(ok(manualPendingStatus(initialStatus)));
    render(<ForecastMlUpdatePanel />);
    await screen.findByText('Modelos activos');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    expect(await screen.findByText('Actualización solicitada.')).toBeTruthy();
    expect(apiClient.requestForecastMlUpdate).toHaveBeenCalledTimes(1);
    expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Actualizar ML ahora' }).hasAttribute('disabled')).toBe(true);
  });

  it.each(['NOT_MATURE', 'COOLDOWN_ACTIVE', 'DEBOUNCE_NOT_ELAPSED'])(
    'allows a manual request with 90 pending signals and %s', async eligibility => {
      const pendingHorizon = (h: 7 | 14) => horizon(h, { pending: true, eligibility, requestStatus: 'NOT_ELIGIBLE_YET', readiness: {
          ...horizon(h).readiness, status: eligibility === 'NOT_MATURE' ? 'WAITING_MATURITY'
            : eligibility === 'COOLDOWN_ACTIVE' ? 'WAITING_COOLDOWN' : 'WAITING_DEBOUNCE', hasPendingSignals: true,
          pendingSignalCount: 90, pendingSignalTypes: ['SALE_COMPLETED'], processedRevision: '83',
          latestPendingRevision: '173', eligibility, reasonCode: eligibility,
        } });
      const pendingStatus: ForecastMlUpdateStatus = { ...initialStatus, dataVersion: '173',
        horizons: [pendingHorizon(7), pendingHorizon(14)] };
      vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(pendingStatus))
        .mockResolvedValueOnce(ok(manualPendingStatus(pendingStatus)));
      render(<ForecastMlUpdatePanel />);
      expect((await screen.findAllByText(eligibility === 'DEBOUNCE_NOT_ELAPSED' ? 'Agrupando cambios recientes' : 'Evidencia pendiente')).length).toBeGreaterThan(0);
      const button = screen.getByRole('button', { name: 'Actualizar ML ahora' });
      expect(button.hasAttribute('disabled')).toBe(false);
      fireEvent.click(button);
      expect(await screen.findByText('Actualización solicitada.')).toBeTruthy();
      expect(apiClient.requestForecastMlUpdate).toHaveBeenCalledExactlyOnceWith();
      expect(button.hasAttribute('disabled')).toBe(true);
    },
  );

  it.each([
    { currentlyRunning: true, requestStatus: 'NOT_ELIGIBLE_YET' },
    { currentlyRunning: false, requestStatus: 'ALREADY_PENDING' },
    { currentlyRunning: false, requestStatus: 'RUNNING' },
  ])('blocks an existing worker or durable request: %j', async patch => {
    const blockedStatus: ForecastMlUpdateStatus = { ...initialStatus,
      horizons: [horizon(7, { pending: true, ...patch }), horizon(14)] };
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue(ok(blockedStatus));
    render(<ForecastMlUpdatePanel />);
    expect((await screen.findAllByText(patch.currentlyRunning ? 'Evaluación en curso' : 'Evidencia pendiente')).length).toBeGreaterThan(0);
    const button = screen.getByRole('button', { name: 'Actualizar ML ahora' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(apiClient.requestForecastMlUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['ALREADY_PENDING', 'Ya existe una actualización pendiente.'],
    ['RUNNING', 'La actualización está en curso.'],
  ] as const)('shows response copy for %s', async (requestStatus, copy) => {
    vi.mocked(apiClient.requestForecastMlUpdate).mockResolvedValueOnce(ok({ requestStatus,
      trigger: 'MANUAL', pending: true, horizons: [7, 14], dispatchStatus: 'DISPATCHED', messageCode: requestStatus }));
    const active: ForecastMlUpdateStatus = requestStatus === 'RUNNING'
      ? { ...initialStatus, horizons: [horizon(7, { currentlyRunning: true, requestStatus: 'RUNNING' }), horizon(14)] }
      : manualPendingStatus(initialStatus);
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus)).mockResolvedValueOnce(ok(active));
    render(<ForecastMlUpdatePanel />); await screen.findByText('Modelos activos');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    expect(await screen.findByText(copy)).toBeTruthy();
  });

  it('shows DEFERRED as saved for automatic processing', async () => {
    vi.mocked(apiClient.requestForecastMlUpdate).mockResolvedValueOnce(ok({ requestStatus: 'REQUEST_ACCEPTED',
      trigger: 'MANUAL', pending: true, horizons: [7, 14], dispatchStatus: 'DEFERRED', messageCode: 'ML_UPDATE_REQUESTED' }));
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus))
      .mockResolvedValueOnce(ok(manualPendingStatus(initialStatus)));
    render(<ForecastMlUpdatePanel />); await screen.findByText('Modelos activos');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    expect(await screen.findByText('Solicitud guardada; se procesará automáticamente.')).toBeTruthy();
  });

  it('presents insufficient mature evidence in plain language and keeps the code in technical details', async () => {
    const status = { ...initialStatus, horizons: [horizon(7, { lastResult: 'LAST_RESULT_INSUFFICIENT_HISTORY',
      lastEvaluationReason: 'NO_PROMOTION_INSUFFICIENT_HISTORY' }), horizon(14)] } as ForecastMlUpdateStatus;
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue(ok(status));
    render(<ForecastMlUpdatePanel />);
    expect(await screen.findByText('Aún no elegible')).toBeTruthy();
    expect(screen.getByText('El sistema recibió la solicitud, pero aún no hay suficiente evidencia madura para generar un nuevo modelo.')).toBeTruthy();
    expect(screen.getByText('Ver detalles técnicos').closest('details')?.hasAttribute('open')).toBe(false);
    fireEvent.click(screen.getByText('Ver detalles técnicos'));
    expect(screen.getAllByText(/NO_PROMOTION_INSUFFICIENT_HISTORY/).length).toBeGreaterThan(0);
  });

  it('polls each eight seconds, confirms completion with one final read and announces it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-17T06:00:00Z'));
    const pending = manualPendingStatus(initialStatus);
    const settled = { ...initialStatus, horizons: [horizon(7, { lastResult: 'LAST_RESULT_NO_PENDING' }), horizon(14, { lastResult: 'LAST_RESULT_NO_PENDING' })] } as ForecastMlUpdateStatus;
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus))
      .mockResolvedValueOnce(ok(pending)).mockResolvedValueOnce(ok(settled)).mockResolvedValueOnce(ok(settled));
    render(<ForecastMlUpdatePanel />);
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar ML ahora' }));
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(8_000);
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('Revisión completada: no había trabajo pendiente. El modelo activo no cambió.')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(4);
  });

  it('ends a manual NOT_MATURE request while keeping immature signals visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const requestedAt = '2026-10-18T18:07:00.000Z';
    const active = manualPendingStatus({ ...initialStatus, dataVersion: '173', horizons: [
      horizon(7, { lastRequestAt: requestedAt, pending: true, requestStatus: 'ALREADY_PENDING' }),
      horizon(14, { lastRequestAt: requestedAt, pending: true, requestStatus: 'ALREADY_PENDING' }),
    ] });
    const terminal = { ...active, horizons: active.horizons.map(row => ({ ...row,
      currentlyRunning: false, requestStatus: 'NOT_ELIGIBLE_YET', lastEvaluatedAt: '2026-10-18T18:08:00.000Z',
      lastResult: 'NOT_ELIGIBLE_YET', lastEvaluationReason: 'NOT_MATURE', readiness: {
        ...row.readiness, status: 'WAITING_MATURITY', reasonCode: 'NOT_MATURE', eligibility: 'NOT_MATURE',
        hasPendingSignals: true, pendingSignalCount: 90, pendingSignalTypes: ['SALE_COMPLETED'],
        processedRevision: '83', latestPendingRevision: '173',
      },
    })) as ForecastMlUpdateStatus['horizons'] } satisfies ForecastMlUpdateStatus;
    const onManualRequestFinished = vi.fn();
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus))
      .mockResolvedValueOnce(ok(active)).mockResolvedValueOnce(ok(terminal)).mockResolvedValueOnce(ok(terminal));
    render(<ForecastMlUpdatePanel onManualRequestFinished={onManualRequestFinished} />);
    await screen.findByText('Modelos activos');
    const button = screen.getByRole('button', { name: 'Actualizar ML ahora' });
    fireEvent.click(button);
    expect(await screen.findByText('Actualización solicitada.')).toBeTruthy();
    expect(button.hasAttribute('disabled')).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await screen.findByText('Revisión completada. La evidencia todavía debe completar su período de madurez antes de evaluar un nuevo modelo.')).toBeTruthy();
    expect(screen.getAllByText('Evidencia pendiente').length).toBeGreaterThan(0);
    expect(screen.getByText('Señales pendientes: 7d 90 · 14d 90')).toBeTruthy();
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(onManualRequestFinished).toHaveBeenCalledTimes(1);
    expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(4);
  });

  it('keeps pending evidence independent from an active manual request on initial load', async () => {
    const terminalPending: ForecastMlUpdateStatus = { ...initialStatus, dataVersion: '173', horizons: [
      horizon(7, { pending: true, requestStatus: 'NOT_ELIGIBLE_YET', lastRequestAt: '2026-10-18T18:07:00.000Z',
        lastEvaluatedAt: '2026-10-18T18:08:00.000Z', lastEvaluationReason: 'NOT_MATURE', readiness: {
          ...horizon(7).readiness, status: 'WAITING_MATURITY', hasPendingSignals: true, pendingSignalCount: 90,
        } }),
      horizon(14, { pending: true, requestStatus: 'NOT_ELIGIBLE_YET', lastRequestAt: '2026-10-18T18:07:00.000Z',
        lastEvaluatedAt: '2026-10-18T18:08:00.000Z', lastEvaluationReason: 'NOT_MATURE', readiness: {
          ...horizon(14).readiness, status: 'WAITING_MATURITY', hasPendingSignals: true, pendingSignalCount: 90,
        } }),
    ] };
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValue(ok(terminalPending));
    render(<ForecastMlUpdatePanel />);
    expect((await screen.findAllByText('Evidencia pendiente')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Actualizar ML ahora' }).hasAttribute('disabled')).toBe(false);
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
    const pending = manualPendingStatus(initialStatus);
    vi.mocked(apiClient.getForecastMlUpdateStatus).mockResolvedValueOnce(ok(initialStatus))
      .mockResolvedValueOnce(ok(pending)).mockResolvedValue(ok(pending));
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
    render(<ForecastMlUpdatePanel />); await screen.findByText('Modelos activos');
    const button = screen.getByRole('button', { name: 'Actualizar ML ahora' });
    fireEvent.click(button); fireEvent.click(button);
    expect(apiClient.requestForecastMlUpdate).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute('disabled')).toBe(true);
    resolveRequest({ httpStatus: 429, code: 'ML_UPDATE_RATE_LIMITED' });
    expect(await screen.findByText(/Se alcanzó el límite de solicitudes/)).toBeTruthy();
  });

  it('shows 7d and 14d LIVE without exposing the unapproved 1d horizon in normal UI', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={vi.fn()} />);
    expect(await screen.findByText('Salud de los modelos LIVE')).toBeTruthy();
    expect(screen.getByText('Ridge · 7 días')).toBeTruthy();
    expect(screen.getByText('Ridge · 14 días')).toBeTruthy();
    expect(screen.queryByText('No aprobado')).toBeNull();
    expect(screen.queryByText('1 día')).toBeNull();
    expect(screen.getByRole('button', { name: 'Actualizar ML ahora' })).toBeTruthy();
  });

  it('refreshes worker status when the existing diagnostics refresh button is used', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={vi.fn()} />);
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    await waitFor(() => expect(apiClient.getForecastMlUpdateStatus).toHaveBeenCalledTimes(2));
  });

  it('reloads durable history when the manual request completion token changes', async () => {
    vi.spyOn(apiClient, 'getForecastMlUpdateHistory').mockResolvedValue(ok({
      items: [], page: { limit: 20, nextCursor: null },
    }));
    const { rerender } = render(<ForecastMlUpdateHistoryPanel refreshToken={0} />);
    expect(await screen.findByText('Aún no hay ejecuciones históricas capturadas.')).toBeTruthy();
    expect(apiClient.getForecastMlUpdateHistory).toHaveBeenCalledTimes(1);
    rerender(<ForecastMlUpdateHistoryPanel refreshToken={1} />);
    await waitFor(() => expect(apiClient.getForecastMlUpdateHistory).toHaveBeenCalledTimes(2));
  });

  it('computes the next scheduled UTC cron minute as Peru local time', () => {
    expect(nextAutomaticReview(new Date('2026-10-17T06:00:00Z'))).toContain('01:17');
    expect(nextAutomaticReview(new Date('2026-10-17T06:20:00Z'))).toContain('07:17');
  });
});
