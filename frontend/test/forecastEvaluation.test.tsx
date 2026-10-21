import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastEvaluationPanel } from '@/components/business-intelligence/ForecastEvaluationPanel';
import { BusinessIntelligenceDashboard } from '@/components/business-intelligence/BusinessIntelligenceDashboard';
import { apiClient } from '@/lib/api';
import type { ForecastEvaluation, ModelEvaluation } from '@/types/forecastEvaluation';
import type { ForecastMlUpdateStatus } from '@/types/businessIntelligence';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null, BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null, Cell: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
  Line: () => null, LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Controlled contract fixture, deliberately different metrics from the real reports.
const metrics = { wape: .123456, mae: 2, rmse: null, rmsse: 3 };
const model: ModelEvaluation = {
  modelId: 'legacy', algorithm: 'HistGradientBoostingRegressor', modelType: 'MACHINE_LEARNING_REGRESSOR',
  learningType: 'SUPERVISED_REGRESSION', task: 'Predecir unidades vendidas', target: 'future_units', horizonDays: 7,
  features: ['lag_1', 'month'], featureGroups: ['Ventas históricas', 'Calendario'],
  dataset: { name: 'M5 / CA_3', version: 'demand-v1', synthetic: false, rows: 100, products: 10, logicalHash: 'a'.repeat(64) },
  trainPeriod: { startDate: '2011-03-26', endDate: '2015-11-15', rows: 60 },
  validationPeriod: { startDate: '2015-11-23', endDate: '2016-02-14', rows: 20 },
  testPeriod: { startDate: '2016-02-22', endDate: '2016-05-15', rows: 20 },
  metrics: { test: metrics }, baseline: { algorithm: 'four_week_average', modelStatus: 'BASELINE', testMetrics: { ...metrics, wape: .234567 } },
  relativeTestWapeImprovementPct: null, modelStatus: 'EVALUATED', version: '1.0.0', trainingCutoff: '2016-02-14',
  artifactHash: 'b'.repeat(64), evaluationEvidenceHash: 'c'.repeat(64), limitations: ['Evaluación histórica distinta del forecast LIVE.'],
};
const fixture: ForecastEvaluation = {
  contractVersion: 'forecast-model-evaluation-v1', analysisCutoff: '2026-10-12',
  selectedOperationalMethod: { algorithm: 'MOVING_AVERAGE_28', label: 'Media móvil de 28 días', modelType: 'STATISTICAL_BASELINE',
    learningType: 'NOT_APPLICABLE', modelStatus: 'OPERATIONAL', horizons: [1, 7, 14], version: 'ma28-v1', selectionReason: 'Selección según la validación V3.' },
  modelEvaluation: [model, { ...model, modelId: 'v3', horizonDays: 28, modelStatus: 'REJECTED_FOR_OPERATIONAL_USE', artifactHash: null,
    dataset: { ...model.dataset, name: 'V3 sintético', version: 'v3', synthetic: true },
    trainPeriod: { startDate: '2025-10-13', endDate: '2026-06-30', rows: null },
    validationPeriod: { startDate: '2026-07-01', endDate: '2026-08-15', rows: null },
    testPeriod: { startDate: '2026-08-16', endDate: '2026-10-12', rows: null } }],
  operationalEvaluation: [{ horizonDays: 7, modelStatus: 'BASELINE', testMetrics: { ...metrics, rmse: 4 } }],
  historicalSeries: { available: false, reasonCode: 'TEST_PREDICTIONS_NOT_PERSISTED', points: [] },
};

describe('forecast ML evidence and operative method', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'getForecastModelEvaluation').mockResolvedValue({ success: true, data: structuredClone(fixture) });
    vi.spyOn(apiClient, 'getForecastMlUpdateHistory').mockResolvedValue({ httpStatus: 200, data: { items: [], page: { limit: 20, nextCursor: null } } });
  });

  it('renders API metrics and keeps evaluated/rejected HGB separate from statistical operation', async () => {
    const { container } = render(<ForecastEvaluationPanel />);
    expect(await screen.findByText('Baseline estadístico de referencia')).toBeTruthy();
    expect(screen.getAllByText('HistGradientBoostingRegressor').length).toBeGreaterThan(0);
    expect(screen.getByText('Media móvil de 28 días · evidencia histórica V3')).toBeTruthy();
    expect(screen.getByText(/Evaluado — no aprobado para operación/)).toBeTruthy();
    expect(screen.getAllByText('Ver metodología y limitaciones').length).toBe(2);
    fireEvent.click(screen.getAllByText('Ver metodología y limitaciones')[0]);
    expect(screen.getAllByText(/WAPE TEST 0[.,]123456; baseline 0[.,]234567/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^0[.,]123456$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^0[.,]234567$/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/accuracy|precision|recall|No es un modelo ML|100 - WAPE/i);
    expect(container.textContent).not.toContain('Campeón');
    expect(screen.getByText(model.artifactHash!).closest('details')?.open).toBe(false);
    expect(screen.getByText(/no una serie TEST de predicciones/)).toBeTruthy();
  });

  it('exposes temporal splits and academic explanations with keyboard-accessible help', async () => {
    render(<ForecastEvaluationPanel />);
    await screen.findByText('Baseline estadístico de referencia');
    fireEvent.click(screen.getAllByRole('button', { name: 'Ayuda: WAPE TEST' })[0]);
    expect(screen.getByRole('tooltip').textContent).toContain('Un valor menor indica menor error');
    expect(screen.getAllByText(/Train:/).length).toBe(2);
    expect(screen.getAllByText(/Validation:/).length).toBe(2);
    expect(screen.getAllByText(/Test:/).length).toBe(2);
    expect(screen.getAllByText(/30.*jun.*2026/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/15.*ago.*2026/).length).toBeGreaterThan(0);
  });

  it('reports unavailable evidence and retries without substituted metrics', async () => {
    vi.mocked(apiClient.getForecastModelEvaluation).mockRejectedValueOnce(new Error('Unavailable'));
    render(<ForecastEvaluationPanel />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/^0[.,]123456$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar evaluación' }));
    expect(await screen.findByText('Baseline estadístico de referencia')).toBeTruthy();
  });

  it('loads evidence within the Forecast view without selecting a LIVE product', async () => {
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockRejectedValue(new Error('No LIVE'));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockRejectedValue(new Error('No LIVE'));
    vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: { state: 'NO_TEST', resetEpoch: '0', testCycleId: null,
      maintenance: false, cloudRestoreEnabled: false, capabilities: { destructiveMlTestControls: { allowed: false, target: null, reasonCode: 'ML_TEST_PRODUCTION_FORBIDDEN' } } } });
    const forecast = vi.spyOn(apiClient, 'getBusinessIntelligenceForecast');
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Predicción' }));
    expect(screen.getByRole('heading', { name: 'Pronóstico Ridge LIVE' })).toBeTruthy();
    expect(await screen.findByText('Baseline estadístico de referencia')).toBeTruthy();
    expect(forecast).not.toHaveBeenCalled();
    expect(screen.getAllByRole('tab')).toHaveLength(8);
  });

  it('keeps historical evidence collapsed and a history failure independent from ML status and Health', async () => {
    vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: { state: 'NO_TEST', resetEpoch: '0', testCycleId: null,
      maintenance: false, cloudRestoreEnabled: false, capabilities: { destructiveMlTestControls: { allowed: false, target: null, reasonCode: 'ML_TEST_PRODUCTION_FORBIDDEN' } } } });
    vi.spyOn(apiClient, 'getForecastMlUpdateHistory').mockRejectedValue(new Error('private history error'));
    vi.spyOn(apiClient, 'getForecastModelDiagnostics').mockResolvedValue({ httpStatus: 200, data: {
      models: [{ horizonDays: 7, status: 'ACTIVE', activeModelStatus: 'ACTIVE', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE' },
        { horizonDays: 14, status: 'ACTIVE', activeModelStatus: 'ACTIVE', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE' }],
    } });
    vi.spyOn(apiClient, 'getHealthDiagnostics').mockResolvedValue({ httpStatus: 200, data: {
      httpStatus: 200, dependencyStatus: { inventory: 'READY', forecast: 'READY', supplier: 'READY', healthAssembly: 'READY' },
      reasonCode: null, elapsedMs: 12,
    } });
    const horizonStatus = (horizonDays: 7 | 14) => ({ horizonDays, activeModelVersion: 1, trainedDataVersion: '83', pending: false,
      currentlyRunning: false, trigger: 'AUTO' as const, lastRequestAt: null, lastAttemptAt: null, lastEvaluatedAt: null,
      lastResult: null, lastEvaluationReason: null, eligibility: 'NO_PENDING_WORK', nextEligibleAt: null,
      requestStatus: 'LAST_RESULT_NO_PENDING', dispatchStatus: null, availableOrigins: null, requiredOrigins: 107 as const });
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: {
      dataVersion: '83', closedThrough: '2026-10-16', horizons: [horizonStatus(7), horizonStatus(14)],
    } satisfies ForecastMlUpdateStatus });
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Predicción' }));
    const historyError = await screen.findByRole('alert');
    expect(historyError.textContent).toMatch(/pronósticos siguen disponibles/);
    expect(await screen.findByText('Ensamblado Health')).toBeTruthy();
    expect(screen.getByText(/En LIVE, Ridge se utiliza para 7 y 14 días cuando el registry proporciona un artefacto ACTIVE aprobado\. MA28 se conserva como baseline estadístico; 1 día no tiene fallback\./)).toBeTruthy();
    const historical = screen.getByText('Evidencia histórica y comparación de modelos').closest('details');
    expect(historical?.open).toBe(false);
    expect(screen.getByText(/No corresponde al modelo LIVE utilizado actualmente/)).toBeTruthy();
  });

  it('uses the existing authenticated API client endpoint', async () => {
    vi.restoreAllMocks();
    const instance = (apiClient as unknown as { instance: { get: (url: string) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ data: { success: true, data: fixture } });
    expect((await apiClient.getForecastModelEvaluation()).data).toEqual(fixture);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/intelligence/forecast/evaluation', undefined));
  });

  it('explains the six-step ML workflow and category/product rejection without changing API values', async () => {
    render(<ForecastEvaluationPanel />);
    await screen.findByText('Baseline estadístico de referencia');
    const flow = screen.getByRole('region', { name: 'Cómo se aplicó Machine Learning' });
    expect(flow.querySelectorAll('li')).toHaveLength(6);
    expect(flow.textContent).toMatch(/Datos históricos.*Preparación de variables.*Entrenamiento HistGradientBoosting.*Validación temporal.*Comparación con baseline.*Decisión operativa/);
    expect(screen.getByText(/Para la evaluación histórica de demanda se entrenó HistGradientBoostingRegressor, un modelo de aprendizaje supervisado/)).toBeTruthy();
    expect(screen.getByText(/Ridge se utiliza para 7 y 14 días cuando el registry proporciona/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Evaluación histórica del modelo ML — Horizonte de 7 días' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Evaluación histórica V3 · Horizonte de 28 días' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda: ¿Por qué no fue seleccionado?' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/resultado agregado.*protección de categorías y productos prioritarios/);
    expect(screen.getByText(/Horizontes cubiertos por la evaluación histórica: 1 \/ 7 \/ 14 días/)).toBeTruthy();
    expect(screen.queryByText(/sintético|synthetic/i)).toBeNull();
    expect(screen.getByText('legacy').closest('details')?.open).toBe(false);
    expect(screen.getAllByText(/^0[.,]123456$/).length).toBeGreaterThan(0);
  });
});
