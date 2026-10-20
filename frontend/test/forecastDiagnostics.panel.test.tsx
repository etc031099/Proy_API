import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastDiagnosticsPanel } from '@/components/business-intelligence/ForecastDiagnosticsPanel';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ForecastActiveModels, HealthDiagnostic } from '@/types/businessIntelligence';

const forecast: ForecastActiveModels = {
  models: [
    { horizonDays: 1, status: 'MODEL_NOT_APPROVED', activeModelStatus: 'NOT_APPROVED', reasonCode: 'PROMOTION_POLICY_FAILED', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27' },
    { horizonDays: 7, status: 'MODEL_UNAVAILABLE', activeModelStatus: 'NONE', reasonCode: 'ACTIVE_POINTER_MISSING', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', registryFound: true, activePointerFound: false, artifactFound: false, mlLoadStatus: 'NOT_CHECKED' },
    { horizonDays: 14, status: 'MODEL_UNAVAILABLE', activeModelStatus: 'NONE', reasonCode: 'ACTIVE_ARTIFACT_NOT_FOUND', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', registryFound: true, activePointerFound: true, artifactFound: false, mlLoadStatus: 'NOT_CHECKED' },
  ],
  forecastServing: { businessId: 'PRIVATE_BUSINESS_ID', scenarioId: 'PRIVATE_SCENARIO_ID', asOf: '2026-10-16', dataVersion: '0', observationsClosedThrough: '2026-10-15', snapshotStatus: 'AVAILABLE', snapshotReasonCode: null, horizons: {} },
};
const health: HealthDiagnostic = { httpStatus: 200, dependencyStatus: { inventory: 'PARTIAL', forecast: 'PARTIAL', supplier: 'READY', healthAssembly: 'PARTIAL' }, reasonCode: null, elapsedMs: 42 };
const ok = <T,>(data: T): AuthenticatedDiagnosticResult<T> => ({ httpStatus: 200, data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function revealHealthDetails() {
  fireEvent.click(await screen.findByText('Ver estado de Health'));
}

function revealModelDetails(index = 0) {
  const toggles = screen.getAllByText('Ver detalles técnicos');
  fireEvent.click(toggles[index]);
}

describe('forecast serving diagnostics panel', () => {
  const onForecastModelsChange = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    onForecastModelsChange.mockReset();
    vi.spyOn(apiClient, 'getForecastModelDiagnostics').mockResolvedValue(ok(forecast));
    vi.spyOn(apiClient, 'getHealthDiagnostics').mockResolvedValue(ok(health));
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue(ok({ dataVersion: '83', closedThrough: '2026-10-16', horizons: [
      { horizonDays: 7, activeModelVersion: 1, trainedDataVersion: '83', pending: false, currentlyRunning: false, trigger: 'AUTO', lastRequestAt: null, lastAttemptAt: null, lastEvaluatedAt: null, lastResult: null, lastEvaluationReason: null, eligibility: 'NO_PENDING_WORK', nextEligibleAt: null, requestStatus: 'LAST_RESULT_NO_PENDING', dispatchStatus: null, availableOrigins: 0, requiredOrigins: 107 },
      { horizonDays: 14, activeModelVersion: 1, trainedDataVersion: '83', pending: false, currentlyRunning: false, trigger: 'AUTO', lastRequestAt: null, lastAttemptAt: null, lastEvaluatedAt: null, lastResult: null, lastEvaluationReason: null, eligibility: 'NO_PENDING_WORK', nextEligibleAt: null, requestStatus: 'LAST_RESULT_NO_PENDING', dispatchStatus: null, availableOrigins: 0, requiredOrigins: 107 },
    ] }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows only the approved LIVE 7-day and 14-day horizons', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    expect(await screen.findByText('Salud de los modelos LIVE')).toBeTruthy();
    expect(screen.getByText('Ridge · 7 días')).toBeTruthy();
    expect(screen.getByText('Ridge · 14 días')).toBeTruthy();
    expect(screen.queryByText('Ridge · 1 día')).toBeNull();
    expect(screen.queryByText('PROMOTION_POLICY_FAILED')).toBeNull();
  });

  it('renders the 7-day exact reason and safe registry summary', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByText('Ridge · 7 días');
    await revealModelDetails(0);
    expect(await screen.findByText(/ACTIVE_POINTER_MISSING/)).toBeTruthy();
    expect(screen.getByText(/Sí \/ No \/ No/)).toBeTruthy();
  });

  it('renders the 14-day exact reason', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByText('Ridge · 14 días');
    await revealModelDetails(1);
    expect(await screen.findByText(/ACTIVE_ARTIFACT_NOT_FOUND/)).toBeTruthy();
  });

  it('renders Health and dependency statuses from the diagnostic response', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await revealHealthDetails();
    expect(await screen.findByText('Servicios analíticos')).toBeTruthy();
    expect(screen.getAllByText('Parcial').length).toBeGreaterThan(0);
    expect(screen.getByText('Proveedores')).toBeTruthy();
    expect(screen.getByText('Listo')).toBeTruthy();
  });

  it('renders Forecast as soon as it resolves while Health keeps its own loading state', async () => {
    const forecastRead = deferred<AuthenticatedDiagnosticResult<ForecastActiveModels>>();
    const healthRead = deferred<AuthenticatedDiagnosticResult<HealthDiagnostic>>();
    const forecastGet = vi.spyOn(apiClient, 'getForecastModelDiagnostics').mockReturnValue(forecastRead.promise);
    const healthGet = vi.spyOn(apiClient, 'getHealthDiagnostics').mockReturnValue(healthRead.promise);
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { forecastRead.resolve(ok(forecast)); await forecastRead.promise; });
    expect(screen.getByRole('region', { name: 'Diagnóstico de pronósticos' })).toBeTruthy();
    expect(screen.getByText('Cargando Health…')).toBeTruthy();
    expect(forecastGet).toHaveBeenCalledTimes(1);
    expect(healthGet).toHaveBeenCalledTimes(1);

    await act(async () => { healthRead.resolve(ok(health)); await healthRead.promise; });
    expect(await screen.findByText('Servicios analíticos')).toBeTruthy();
    expect(screen.queryByText('Cargando Health…')).toBeNull();
  });

  it('renders Health as soon as it resolves while Forecast keeps its own loading state', async () => {
    const forecastRead = deferred<AuthenticatedDiagnosticResult<ForecastActiveModels>>();
    const healthRead = deferred<AuthenticatedDiagnosticResult<HealthDiagnostic>>();
    vi.spyOn(apiClient, 'getForecastModelDiagnostics').mockReturnValue(forecastRead.promise);
    vi.spyOn(apiClient, 'getHealthDiagnostics').mockReturnValue(healthRead.promise);
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { healthRead.resolve(ok(health)); await healthRead.promise; });
    expect(await screen.findByText('Servicios analíticos')).toBeTruthy();
    expect(screen.getByText('Cargando pronósticos…')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Diagnóstico de pronósticos' })).toBeNull();

    await act(async () => { forecastRead.resolve(ok(forecast)); await forecastRead.promise; });
    expect(await screen.findByRole('region', { name: 'Diagnóstico de pronósticos' })).toBeTruthy();
    expect(screen.queryByText('Cargando pronósticos…')).toBeNull();
  });

  it('keeps Forecast visible when Health fails independently', async () => {
    vi.spyOn(apiClient, 'getForecastModelDiagnostics').mockResolvedValue(ok(forecast));
    vi.useFakeTimers();
    const healthGet = vi.spyOn(apiClient, 'getHealthDiagnostics')
      .mockRejectedValueOnce(new Error('Health unavailable'))
      .mockRejectedValueOnce(new Error('Health unavailable'));
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando diagnóstico Health…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByRole('region', { name: 'Diagnóstico de pronósticos' })).toBeTruthy();
    expect(screen.getByText(/No se pudo consultar Health/)).toBeTruthy();
    expect(healthGet).toHaveBeenCalledTimes(2);
  });

  it('keeps Health visible when Forecast fails independently', async () => {
    vi.useFakeTimers();
    const forecastGet = vi.spyOn(apiClient, 'getForecastModelDiagnostics').mockRejectedValue(new Error('Forecast unavailable'));
    vi.spyOn(apiClient, 'getHealthDiagnostics').mockResolvedValue(ok(health));
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando servicio de pronósticos…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText('Servicios analíticos')).toBeTruthy();
    expect(screen.getByText(/No se pudo consultar el diagnóstico de pronósticos/)).toBeTruthy();
    expect(forecastGet).toHaveBeenCalledTimes(2);
  });

  it('shows a safe session message for 401', async () => {
    vi.mocked(apiClient.getForecastModelDiagnostics).mockResolvedValue({ httpStatus: 401, code: 'AUTH_REQUIRED' });
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    expect(await screen.findByText(/Sesión no autorizada/)).toBeTruthy();
    expect(screen.queryByText('ACTIVE_POINTER_MISSING')).toBeNull();
  });

  it('shows a temporary service message and reason for 503', async () => {
    vi.useFakeTimers();
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics)
      .mockResolvedValueOnce({ httpStatus: 503, code: 'ML_SERVICE_UNAVAILABLE' })
      .mockResolvedValueOnce({ httpStatus: 503, code: 'ML_SERVICE_UNAVAILABLE' });
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando servicio de pronósticos…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    const message = screen.getByText(/Servicio temporalmente no disponible/);
    expect(message.textContent).toContain('ML_SERVICE_UNAVAILABLE');
    expect(forecastGet).toHaveBeenCalledTimes(2);
  });

  it('does not expose tenant IDs, hashes, artifact bytes or credentials', async () => {
    const { container } = render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByText('Ridge · 7 días');
    await revealModelDetails();
    await screen.findByText(/ACTIVE_POINTER_MISSING/);
    expect(container.textContent).not.toMatch(/PRIVATE_BUSINESS_ID|PRIVATE_SCENARIO_ID|artifactHash|artifactData|Authorization|Bearer|JWT|cookie|Mongo|API_KEY/i);
    expect(container.textContent).not.toContain('PRIVATE_BUSINESS_ID');
    expect(container.textContent).not.toContain('Observaciones cerradas hasta:');
    fireEvent.click(screen.getByText('Ver metadatos de servicio'));
    expect(container.textContent).toContain('Revisión del servicio');
    expect(container.textContent).toContain('Observaciones cerradas hasta');
  });

  it('refresh invokes only the two explicit diagnostic GET helpers', async () => {
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics);
    const healthGet = vi.mocked(apiClient.getHealthDiagnostics);
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByText('Ridge · 7 días');
    await revealModelDetails();
    await screen.findByText(/ACTIVE_POINTER_MISSING/);
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    await waitFor(() => expect(forecastGet).toHaveBeenCalledTimes(2));
    expect(healthGet).toHaveBeenCalledTimes(2);
    expect(forecastGet.mock.calls).toHaveLength(2);
    expect(healthGet.mock.calls).toHaveLength(2);
  });

  it('uses only the read-only diagnostics and keeps active models for forecast detail', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByText('Ridge · 7 días');
    await revealModelDetails();
    await screen.findByText(/ACTIVE_POINTER_MISSING/);
    expect(screen.getByText('Resumen del ML')).toBeTruthy();
    expect(onForecastModelsChange).toHaveBeenCalledWith(forecast.models);
    expect(vi.mocked(apiClient.getForecastModelDiagnostics)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.getHealthDiagnostics)).toHaveBeenCalledTimes(1);
  });

  it('retries transient Forecast failure once without reloading successful Health', async () => {
    vi.useFakeTimers();
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics)
      .mockResolvedValueOnce({ httpStatus: 503, code: 'ML_SERVICE_UNAVAILABLE' })
      .mockResolvedValueOnce(ok(forecast));
    const healthGet = vi.mocked(apiClient.getHealthDiagnostics).mockResolvedValue(ok(health));
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando servicio de pronósticos…')).toBeTruthy();
    expect(screen.getByText('Servicios analíticos')).toBeTruthy();
    expect(forecastGet).toHaveBeenCalledTimes(1);
    expect(healthGet).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    await revealModelDetails();
    expect(screen.getByText(/ACTIVE_POINTER_MISSING/)).toBeTruthy();
    expect(forecastGet).toHaveBeenCalledTimes(2);
    expect(healthGet).toHaveBeenCalledTimes(1);
  });

  it('recovers automatically from a temporary network/fetch rejection', async () => {
    vi.useFakeTimers();
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics)
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(ok(forecast));
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando servicio de pronósticos…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    await revealModelDetails();
    expect(screen.getByText(/ACTIVE_POINTER_MISSING/)).toBeTruthy();
    expect(forecastGet).toHaveBeenCalledTimes(2);
  });

  it('retries a Health diagnostic timeout without reloading successful Forecast', async () => {
    vi.useFakeTimers();
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics).mockResolvedValue(ok(forecast));
    const healthGet = vi.mocked(apiClient.getHealthDiagnostics)
      .mockResolvedValueOnce({ httpStatus: 200, data: { ...health, httpStatus: 504, reasonCode: 'HEALTH_DIAGNOSTIC_TIMEOUT' } })
      .mockResolvedValueOnce(ok(health));
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando diagnóstico Health…')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Diagnóstico de pronósticos' })).toBeTruthy();
    expect(forecastGet).toHaveBeenCalledTimes(1);
    expect(healthGet).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText('Servicios analíticos')).toBeTruthy();
    expect(healthGet).toHaveBeenCalledTimes(2);
    expect(forecastGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HTTP 504', { httpStatus: 504, code: 'HEALTH_DIAGNOSTIC_TIMEOUT' }],
    ['HEALTH_DIAGNOSTIC_TIMEOUT code', { httpStatus: 200, data: { ...health, httpStatus: 504, reasonCode: 'HEALTH_DIAGNOSTIC_TIMEOUT' } }],
    ['SERVICE_TEMPORARILY_UNAVAILABLE code', { httpStatus: 0, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' }],
  ])('automatically retries %s once', async (_label, firstFailure) => {
    vi.useFakeTimers();
    const healthGet = vi.mocked(apiClient.getHealthDiagnostics)
      .mockResolvedValueOnce(firstFailure as AuthenticatedDiagnosticResult<HealthDiagnostic>)
      .mockResolvedValueOnce(ok(health));
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando diagnóstico Health…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText('Servicios analíticos')).toBeTruthy();
    expect(healthGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['1d no aprobado', ok(forecast)],
    ['política de promoción fallida', { httpStatus: 400, code: 'PROMOTION_POLICY_FAILED' }],
    ['respuesta 4xx', { httpStatus: 401, code: 'AUTH_REQUIRED' }],
    ['rate limit', { httpStatus: 429, code: 'ANALYTICS_RATE_LIMITED' }],
    ['modelo funcionalmente no disponible', { httpStatus: 503, code: 'MODEL_UNAVAILABLE' }],
    ['contrato de features incompatible', { httpStatus: 503, code: 'FEATURE_CONTRACT_MISMATCH' }],
    ['integridad del artefacto inválida', { httpStatus: 503, code: 'ARTIFACT_HASH_MISMATCH' }],
  ])('does not retry non-transient Forecast result: %s', async (_label, firstResult) => {
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics)
      .mockResolvedValue(firstResult as AuthenticatedDiagnosticResult<ForecastActiveModels>);
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByRole('region', { name: 'Diagnóstico de pronósticos' });
    expect(forecastGet).toHaveBeenCalledTimes(1);
  });

  it('shows the ordinary service error after the one automatic retry also fails', async () => {
    vi.useFakeTimers();
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics)
      .mockResolvedValueOnce({ httpStatus: 503, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' })
      .mockResolvedValueOnce({ httpStatus: 503, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' });
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando servicio de pronósticos…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText(/Servicio temporalmente no disponible/)).toBeTruthy();
    expect(forecastGet).toHaveBeenCalledTimes(2);
  });

  it('cleans a pending retry timer when the panel unmounts', async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.getHealthDiagnostics).mockResolvedValueOnce({ httpStatus: 504, code: 'HEALTH_DIAGNOSTIC_TIMEOUT' });
    const { unmount } = render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Preparando diagnóstico Health…')).toBeTruthy();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(vi.mocked(apiClient.getHealthDiagnostics)).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh diagnostic cycle when manually refreshed after automatic recovery', async () => {
    vi.useFakeTimers();
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics)
      .mockResolvedValueOnce({ httpStatus: 503, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' })
      .mockResolvedValueOnce(ok(forecast))
      .mockResolvedValue(ok(forecast));
    const healthGet = vi.mocked(apiClient.getHealthDiagnostics).mockResolvedValue(ok(health));
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    await revealModelDetails();
    expect(screen.getByText(/ACTIVE_POINTER_MISSING/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(forecastGet).toHaveBeenCalledTimes(3);
    expect(healthGet).toHaveBeenCalledTimes(2);
  });
});
