import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  afterEach(() => cleanup());

  it('renders the 1-day policy status and reason', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    expect(await screen.findByText('No aprobado')).toBeTruthy();
    expect(screen.getByText('PROMOTION_POLICY_FAILED')).toBeTruthy();
  });

  it('renders the 7-day exact reason and safe registry summary', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    expect(await screen.findByText('ACTIVE_POINTER_MISSING')).toBeTruthy();
    expect(screen.getByText(/Sí \/ No \/ No/)).toBeTruthy();
  });

  it('renders the 14-day exact reason', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    expect(await screen.findByText('ACTIVE_ARTIFACT_NOT_FOUND')).toBeTruthy();
  });

  it('renders Health and dependency statuses from the diagnostic response', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    expect(await screen.findByText('Ensamblado Health')).toBeTruthy();
    expect(screen.getAllByText('Parcial').length).toBeGreaterThan(0);
    expect(screen.getByText('Proveedores')).toBeTruthy();
    expect(screen.getByText('Listo')).toBeTruthy();
  });

  it('shows a safe session message for 401', async () => {
    vi.mocked(apiClient.getForecastModelDiagnostics).mockResolvedValue({ httpStatus: 401, code: 'AUTH_REQUIRED' });
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    expect(await screen.findByText(/Sesión no autorizada/)).toBeTruthy();
    expect(screen.queryByText('ACTIVE_POINTER_MISSING')).toBeNull();
  });

  it('shows a temporary service message and reason for 503', async () => {
    vi.mocked(apiClient.getForecastModelDiagnostics).mockResolvedValue({ httpStatus: 503, code: 'ML_SERVICE_UNAVAILABLE' });
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    expect(await screen.findByText(/Servicio temporalmente no disponible/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('ML_SERVICE_UNAVAILABLE');
  });

  it('does not expose tenant IDs, hashes, artifact bytes or credentials', async () => {
    const { container } = render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByText('ACTIVE_POINTER_MISSING');
    expect(container.textContent).not.toMatch(/PRIVATE_BUSINESS_ID|PRIVATE_SCENARIO_ID|artifactHash|artifactData|Authorization|Bearer|JWT|cookie|Mongo|API_KEY/i);
    expect(container.textContent).toContain('Revisión de datos: 0');
    expect(container.textContent).toContain('Observaciones cerradas hasta:');
  });

  it('refresh invokes only the two explicit diagnostic GET helpers', async () => {
    const forecastGet = vi.mocked(apiClient.getForecastModelDiagnostics);
    const healthGet = vi.mocked(apiClient.getHealthDiagnostics);
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByText('ACTIVE_POINTER_MISSING');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    await waitFor(() => expect(forecastGet).toHaveBeenCalledTimes(2));
    expect(healthGet).toHaveBeenCalledTimes(2);
    expect(forecastGet.mock.calls).toHaveLength(2);
    expect(healthGet.mock.calls).toHaveLength(2);
  });

  it('uses only the read-only diagnostics and keeps active models for forecast detail', async () => {
    render(<ForecastDiagnosticsPanel onForecastModelsChange={onForecastModelsChange} />);
    await screen.findByText('ACTIVE_POINTER_MISSING');
    expect(screen.getByText(/no garantiza una nueva versión/)).toBeTruthy();
    expect(onForecastModelsChange).toHaveBeenCalledWith(forecast.models);
    expect(vi.mocked(apiClient.getForecastModelDiagnostics)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.getHealthDiagnostics)).toHaveBeenCalledTimes(1);
  });
});
