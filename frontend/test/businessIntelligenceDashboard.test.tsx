import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessIntelligenceDashboard } from '@/components/business-intelligence/BusinessIntelligenceDashboard';
import { apiClient } from '@/lib/api';
import { getTranslation } from '@/i18n/dict';
import type { BusinessSummary, CertifiedForecastReplayEvidence, ForecastActiveModels, ForecastResponse, InventorySummary, ProductInventory } from '@/types/businessIntelligence';

// Epoch maintenance/remount behavior is tested independently with real API
// status responses in mlTestEpochBoundary.test.tsx.
vi.mock('@/components/business-intelligence/MlTestEpochBoundary', () => ({
  MlTestEpochBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null, BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null, Cell: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
  Line: () => null, LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const temporal = { asOf: '2026-10-14', timezone: 'America/Lima', mode: 'LIVE' as const, updatedAt: '2026-10-14T18:00:00Z', dataThrough: '2026-10-14T17:55:00Z' };
const summaryFixture: BusinessSummary = {
  ...temporal, salesToday: { value: 0, currency: 'PEN' }, unitsToday: 0, ticketsToday: 0,
  averageTicket: { value: 0, currency: 'PEN' }, grossMargin: { value: null, currency: null, percent: null, availability: 'UNAVAILABLE' },
  inventory: { totalProducts: 80, riskCounts: { critical: 5, high: 6, medium: 43, low: 26 }, reorderCount: 9, lowStockCount: 8, overstockCount: 6, pendingPurchasesCount: 29 },
};
const inventoryFixture: InventorySummary = {
  ...temporal, summary: { totalProducts: 80, riskCounts: { critical: 5, high: 6, medium: 43, low: 26 }, reorderCount: 9, lowStockCount: 8, overstockCount: 6, incomingUnits: 858, abcCounts: { A: 40, B: 24, C: 16 }, xyzCounts: { X: 55, Y: 22, Z: 3 }, abcXyzCounts: { AX: 20 } },
  items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés', presentation: 'Unidad', stock: 21, coverageDays: 3.5, risk: 'HIGH', riskReasonCodes: ['LOW_COVERAGE'], recommendedQty: 12, reorderNow: true }], total: 1,
};
const productOption = { id: 'product-1', sku: 'PAN-FRE-001', name: 'Pan francés', presentation: 'Unidad' };
const forecastFixture: ForecastResponse = {
  ...temporal, mode: 'HISTORICAL', status: 'READY', product: { sku: 'PAN-FRE-001', name: 'Pan francés', presentation: 'Unidad' }, method: 'MOVING_AVERAGE_28',
  observationCutoff: '2026-10-13', horizons: { '1d': 2.32, '7d': 16.25, '14d': 32.5 },
  observedSeries: [
    { date: '2026-10-11', units: 4, status: 'CLOSED' },
    { date: '2026-10-12', units: 0, status: 'ZERO' },
    { date: '2026-10-13', units: null, status: 'MISSING' },
    { date: '2026-10-14', units: 2, status: 'PARTIAL' },
  ], forecastPeriod: { startDate: '2026-10-15', selectedHorizonDays: 7, units: 16.25 },
};
const activeForecastFixture: ForecastActiveModels = { models: [
  { horizonDays: 1, status: 'MODEL_NOT_APPROVED', activeModelStatus: 'NOT_APPROVED', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27' },
  ...([7, 14] as const).map(horizonDays => ({ horizonDays, status: 'ACTIVE' as const, activeModelStatus: 'ACTIVE' as const,
    modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', modelVersion: 1, trainedAt: '2026-10-15T10:00:00.000Z',
    trainedDataVersion: '0', dataCutoff: '2026-10-13', featureVersion: 'RIDGE_CAUSAL27_V1', promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
    metrics: { wape: 0.2, mae: 1.4, bias: -0.03 } })),
] };
const replayEvidenceFixture: CertifiedForecastReplayEvidence = {
  demoRunId: 'cert-stable-2020', purpose: 'REPLAY_ONLY', profile: 'STABLE', seed: 2020, requiredOrigins: 107,
  policy: { numericPolicy: 'M6.10A22-PROMOTION-v1', replayPolicy: 'REPLAY-CAUSAL27-107-v1' }, level: 'LEVEL_7_FULL_EVALUATION',
  liveImpact: { modifiesLive: false, modifiesRegistry: false, modifiesActive: false, promotesActive: false },
  horizons: [
    { horizonDays: 7, status: 'PASS', metrics: { wape: 0.21821910661531238, mae: 2.7553986143126212, normalizedBias: 0.015203166728022906, relativeWapeImprovement: 0.07285079744035697 },
      globalChecks: { G1_POOLED_WAPE_5PCT: true, G2_POOLED_BIAS_10PCT: true, G3_POOLED_MACRO_MAE_110PCT: true }, reasons: [], selectedIdentity: 'replay:cert-stable-2020:7d:v2', selectedState: 'REPLAY_SELECTED' },
    { horizonDays: 14, status: 'REJECTED', metrics: { wape: 0.16015837551541576, mae: 4.056983784638979, normalizedBias: 0.010429423363195635, relativeWapeImprovement: 0.13230439506009892 },
      globalChecks: { G1_POOLED_WAPE_5PCT: true, G2_POOLED_BIAS_10PCT: true, G3_POOLED_MACRO_MAE_110PCT: true }, reasons: ['P_FOLD_CATA_MAE:F3:BEB-GAS-003'], candidateState: 'REPLAY_REJECTED' },
  ],
  interpretation: { execution: 'HISTORICAL_OFFLINE_REPLAY', isLiveState: false, requiredOriginsWasWeakened: false, explanations: [] },
};
const productInventoryFixture: ProductInventory = {
  ...temporal, status: 'READY', availability: 'READY', freshness: { mode: 'LIVE', updatedAt: temporal.updatedAt, dataThrough: temporal.dataThrough },
  product: forecastFixture.product, stock: { onHand: 21, incoming: 0, inventoryPosition: 21 },
  demand: { expectedDaily: 2.32, expectedUnitsNext1d: 2.32, expectedUnitsNext7d: 16.25, expectedUnitsNext14d: 32.5 },
  coverage: { daysCover: 9, status: 'AVAILABLE' }, inventoryPolicy: { safetyStock: 8, reorderPoint: 12 },
  recommendation: { reorderNow: true, preventiveRecommendation: null, recommendedQty: 12 }, risk: { level: 'HIGH', reasonCodes: ['LOW_COVERAGE'] }, classification: { abc: 'A', xyz: 'X' },
};

function success<T>(data: T) { return { success: true, data }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
function mockOverview() {
  vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockResolvedValue(success(summaryFixture));
  vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(inventoryFixture));
}
async function openForecast() {
  fireEvent.click(screen.getByRole('tab', { name: 'Predicción' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Producto' }), { target: { value: 'pan' } });
  await waitFor(() => expect(apiClient.searchBusinessIntelligenceProducts).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: /Pan francés.*SKU: PAN-FRE-001/ }));
}
function forecastCardText(days: 7 | 14) {
  const label = `Pronóstico ${days} días`;
  return screen.getByText(label, { exact: true }).closest('button')?.textContent || '';
}

describe('business intelligence dashboard', () => {
  beforeEach(() => { vi.restoreAllMocks(); mockOverview();
    vi.spyOn(apiClient, 'getForecastModelDiagnostics').mockResolvedValue({ httpStatus: 200, data: activeForecastFixture });
    vi.spyOn(apiClient, 'getHealthDiagnostics').mockResolvedValue({ httpStatus: 200, data: { httpStatus: 200,
      dependencyStatus: { inventory: 'READY', forecast: 'READY', supplier: 'READY', healthAssembly: 'READY' }, reasonCode: null, elapsedMs: 12 } });
    const mlHorizon = (horizonDays: 7 | 14) => ({
      horizonDays, activeModelVersion: 1, trainedDataVersion: '83', pending: false, currentlyRunning: false, trigger: 'AUTO' as const,
      lastRequestAt: null, lastAttemptAt: null, lastEvaluatedAt: null, lastResult: null, lastEvaluationReason: null, eligibility: 'NO_PENDING_WORK', nextEligibleAt: null,
      requestStatus: 'LAST_RESULT_NO_PENDING', dispatchStatus: null, availableOrigins: 0, requiredOrigins: 107 as const,
    });
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 200, data: { dataVersion: '83', closedThrough: '2026-10-16', horizons: [mlHorizon(7), mlHorizon(14)] } });
    vi.spyOn(apiClient, 'getForecastMlUpdateHistory').mockResolvedValue({ httpStatus: 200, data: { items: [], page: { limit: 20, nextCursor: null } } });
    vi.spyOn(apiClient, 'getCertifiedForecastReplayEvidence').mockResolvedValue({ httpStatus: 200, data: replayEvidenceFixture });
    vi.spyOn(apiClient, 'getForecastModelEvaluation').mockRejectedValue(new Error('Evaluation not part of these LIVE fixtures'));
  });

  it('renames the navigation label and presents the new page title', async () => {
    render(<BusinessIntelligenceDashboard />);
    expect(getTranslation('es', 'navigation.demandForecast')).toBe('Inteligencia del Negocio');
    expect(screen.getByRole('heading', { name: 'Analítica e Inteligencia del Negocio' })).toBeTruthy();
    expect(await screen.findByText('Ventas de hoy')).toBeTruthy();
  });

  it('shows summary KPIs and treats zero sales as a real zero state', async () => {
    render(<BusinessIntelligenceDashboard />);
    expect((await screen.findAllByText(/0\.00/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('0', { selector: 'h3' }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Hoy aún no hay ventas registradas/)).toBeTruthy();
    expect(screen.getByText('29')).toBeTruthy();
    expect(screen.getByText('No disponible')).toBeTruthy();
  });

  it('renders the summary while inventory is still loading, then removes only the inventory loading state', async () => {
    const summaryRead = deferred<Awaited<ReturnType<typeof apiClient.getBusinessIntelligenceSummary>>>();
    const inventoryRead = deferred<Awaited<ReturnType<typeof apiClient.getInventoryAnalytics>>>();
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockReturnValue(summaryRead.promise);
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockReturnValue(inventoryRead.promise);
    render(<BusinessIntelligenceDashboard />);

    await act(async () => { summaryRead.resolve(success(summaryFixture)); await summaryRead.promise; });
    expect(await screen.findByText('Ventas de hoy')).toBeTruthy();
    expect(screen.getByText('Cargando inventario y ranking…')).toBeTruthy();
    expect(apiClient.getBusinessIntelligenceSummary).toHaveBeenCalledTimes(1);
    expect(apiClient.getInventoryAnalytics).toHaveBeenCalledTimes(1);

    await act(async () => { inventoryRead.resolve(success(inventoryFixture)); await inventoryRead.promise; });
    expect(await screen.findByText('Distribución de riesgo de inventario')).toBeTruthy();
    expect(screen.queryByText('Cargando inventario y ranking…')).toBeNull();
  });

  it('renders inventory charts while the general summary is still loading', async () => {
    const summaryRead = deferred<Awaited<ReturnType<typeof apiClient.getBusinessIntelligenceSummary>>>();
    const inventoryRead = deferred<Awaited<ReturnType<typeof apiClient.getInventoryAnalytics>>>();
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockReturnValue(summaryRead.promise);
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockReturnValue(inventoryRead.promise);
    render(<BusinessIntelligenceDashboard />);

    await act(async () => { inventoryRead.resolve(success(inventoryFixture)); await inventoryRead.promise; });
    expect(await screen.findByText('Estabilidad de demanda (XYZ)')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Cargando resumen general' })).toBeTruthy();
    expect(screen.queryByText('Ventas de hoy')).toBeNull();

    await act(async () => { summaryRead.resolve(success(summaryFixture)); await summaryRead.promise; });
    expect(await screen.findByText('Ventas de hoy')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Cargando resumen general' })).toBeNull();
  });

  it('keeps summary visible when the independent inventory request fails', async () => {
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockResolvedValue(success(summaryFixture));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockRejectedValue(new Error('Inventory unavailable'));
    render(<BusinessIntelligenceDashboard />);

    expect(await screen.findByText('Ventas de hoy')).toBeTruthy();
    expect(await screen.findByText('No se pudo cargar el inventario.')).toBeTruthy();
    expect(apiClient.getBusinessIntelligenceSummary).toHaveBeenCalledTimes(1);
    expect(apiClient.getInventoryAnalytics).toHaveBeenCalledTimes(1);
  });

  it('summarizes four correctly classified techniques and navigates without adding a tab', async () => {
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByRole('heading', { name: 'Técnicas analíticas utilizadas' })).toBeTruthy();
    expect(screen.getByText('3 técnicas de Machine Learning y 1 técnica de minería de patrones, elegidas según el problema.')).toBeTruthy();
    expect(screen.getByText('Ridge Regression')).toBeTruthy();
    expect(screen.getByText('K-Means')).toBeTruthy();
    expect(screen.getByText('Isolation Forest')).toBeTruthy();
    expect(screen.getByText('FP-Growth')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(8);
    fireEvent.click(screen.getAllByRole('button', { name: 'Ver análisis' })[0]);
    expect(screen.getByRole('tab', { name: 'Predicción' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows unavailable and partial gross margin distinctly', async () => {
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByText('Margen bruto')).toBeTruthy();
    expect(screen.getByText('No disponible')).toBeTruthy();
    cleanup();
    vi.restoreAllMocks();
    const partial = { ...summaryFixture, grossMargin: { value: null, currency: null, percent: null, availability: 'PARTIAL' as const } };
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockResolvedValue(success(partial));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(inventoryFixture));
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByText('Parcial · No disponible')).toBeTruthy();
    expect(screen.getByText('Algunos costos no están disponibles.')).toBeTruthy();
  });

  it('searches products only on demand and offers operational 7 and 14-day forecasts without 1 or 28-day options', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    expect(apiClient.getBusinessIntelligenceForecast).not.toHaveBeenCalled();
    await openForecast();
    expect(screen.queryByRole('button', { name: /Pronóstico 1 día/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pronóstico 14 días/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pronóstico 28 días/ })).toBeNull();
    expect(await screen.findByText('Media móvil de 28 días (histórico)')).toBeTruthy();
    expect(screen.getByText('Día cerrado sin ventas')).toBeTruthy();
    expect(screen.getByText('Dato faltante')).toBeTruthy();
    expect(screen.getByText('Día parcial')).toBeTruthy();
  });

  it('shows LIVE Ridge metadata for 7/14, keeps 7d selected initially, and never requests a one-day forecast', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockImplementation(async (_sku, days) => success(
      { ...forecastFixture, mode: 'LIVE', status: 'READY', method: 'RIDGE_REGRESSION', modelFamily: 'RIDGE_REGRESSION',
        horizonDays: days, modelVersion: 1, featureVersion: 'RIDGE_CAUSAL27_V1', promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
        observationsThrough: '2026-10-15', observationCutoff: '2026-10-15', dataCutoff: '2026-10-14',
        observedSeries: [...forecastFixture.observedSeries, { date: '2026-10-15', units: 3, status: 'CLOSED' as const }],
        predictionUnits: days === 7 ? 16.25 : 32.5, baselineUnits: 14, forecastPeriod: { startDate: '2026-10-14', selectedHorizonDays: days, units: days === 7 ? 16.25 : 32.5 },
        horizons: { '1d': null, '7d': days === 7 ? 16.25 : null, '14d': days === 14 ? 32.5 : null } }));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    expect(await screen.findByText('Machine Learning Ridge')).toBeTruthy();
    expect(screen.getAllByText('Método seleccionado:')).toHaveLength(1);
    expect(screen.getByText(/Datos observados hasta: 15 oct/i)).toBeTruthy();
    expect(screen.getByText(/Corte de entrenamiento 14 oct/i)).toBeTruthy();
    expect(screen.getByText('Modelo v1')).toBeTruthy();
    expect(await screen.findByText(/Baseline estadístico MA28/)).toBeTruthy();
    expect(forecastCardText(7)).toContain('16.25');
    expect(forecastCardText(14)).toContain('32.50');
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Pronóstico 14 días/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('button', { name: /Pronóstico 1 día/ })).toBeNull();
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(1, 'PAN-FRE-001', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(2, 'PAN-FRE-001', 14);

    fireEvent.click(screen.getByRole('button', { name: /Pronóstico 14 días/ }));
    expect(await screen.findByText(/Pronóstico total para 14 días:/)).toBeTruthy();
    expect(forecastCardText(7)).toContain('16.25');
    expect(screen.getByRole('button', { name: /Pronóstico 14 días/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /Pronóstico 7 días/ }));
    expect(await screen.findByText(/Pronóstico total para 7 días:/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ }).getAttribute('aria-pressed')).toBe('true');
    expect(forecastCardText(7)).toContain('16.25');
    expect(forecastCardText(14)).toContain('32.50');
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
  });

  it('presents certified replay evidence separately without running replay or changing the LIVE horizon selector', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    const panel = await screen.findByRole('region', { name: 'Evidencia histórica de promoción' });
    expect(apiClient.getCertifiedForecastReplayEvidence).toHaveBeenCalledTimes(1);
    expect(within(panel).getByText('Replay histórico certificado · no modifica el modelo LIVE')).toBeTruthy();
    expect(within(panel).getByText('PASS')).toBeTruthy();
    expect(within(panel).getByText('REJECTED')).toBeTruthy();
    expect(within(panel).getByText(/\+7[,.]29\s*%/)).toBeTruthy();
    expect(within(panel).getByText(/\+13[,.]23\s*%/)).toBeTruthy();
    expect(within(panel).getByText('BEB-GAS-003')).toBeTruthy();
    expect(within(panel).getByText(/mejoró las métricas globales, pero fue bloqueado/)).toBeTruthy();
    expect(within(panel).getByText(/no modifica Registry, no modifica ACTIVE y no promociona modelos LIVE/)).toBeTruthy();
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Pronóstico 1 día/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pronóstico 14 días/ })).toBeTruthy();
  });

  it('keeps Prediction usable when certified replay evidence is temporarily unavailable', async () => {
    vi.mocked(apiClient.getCertifiedForecastReplayEvidence).mockRejectedValueOnce(new Error('temporary failure'));
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    expect(await screen.findByText('La evidencia histórica no está disponible temporalmente.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Pronóstico operativo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pronóstico 14 días/ })).toBeTruthy();
  });

  it('clears prior horizon values and loads both Ridge horizons when the selected product changes', async () => {
    const secondProduct = { id: 'product-2', sku: 'SNA-PAP-002', name: 'Papel higiénico', presentation: 'Paquete' };
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockImplementation(async query => success({ products: [query.includes('papel') ? secondProduct : productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockImplementation(async (sku, days) => success({
      ...forecastFixture, mode: 'LIVE', status: 'READY', method: 'RIDGE_REGRESSION', modelFamily: 'RIDGE_REGRESSION',
      product: sku === secondProduct.sku ? { sku, name: secondProduct.name, presentation: secondProduct.presentation } : forecastFixture.product,
      horizonDays: days, predictionUnits: sku === secondProduct.sku ? days === 7 ? 4.99 : 10.43 : days === 7 ? 16.25 : 32.5,
      horizons: { '1d': null, '7d': null, '14d': null },
      forecastPeriod: { startDate: '2026-10-14', selectedHorizonDays: days, units: sku === secondProduct.sku ? days === 7 ? 4.99 : 10.43 : days === 7 ? 16.25 : 32.5 },
    }));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    await waitFor(() => expect(forecastCardText(7)).toContain('16.25'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Producto' }), { target: { value: 'papel' } });
    fireEvent.click(await screen.findByRole('button', { name: /Papel higiénico.*SKU: SNA-PAP-002/ }));
    await waitFor(() => expect(forecastCardText(7)).toContain('4.99'));
    expect(forecastCardText(14)).toContain('10.43');
    expect(forecastCardText(7)).not.toContain('16.25');
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(4);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(3, 'SNA-PAP-002', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(4, 'SNA-PAP-002', 14);
  });

  it('renders cold start without forecast numbers or a fake forecast line', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success({ ...forecastFixture, status: 'COLD_START', horizons: { '1d': null, '7d': null, '14d': null }, observedSeries: [], forecastPeriod: null }));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    expect(await screen.findByText('Historial insuficiente para generar un pronóstico.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ })).toBeTruthy();
  });

  it('does not choose a product automatically', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts');
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast');
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Predicción' }));
    expect(await screen.findByText('No se seleccionó ningún producto automáticamente.')).toBeTruthy();
    expect(apiClient.searchBusinessIntelligenceProducts).not.toHaveBeenCalled();
    expect(apiClient.getBusinessIntelligenceForecast).not.toHaveBeenCalled();
  });

  it('does not load product inventory when an unrelated tab is opened after selecting a product', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    const inventoryRead = vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory');
    vi.spyOn(apiClient, 'getCustomersAnalytics').mockRejectedValue(new Error('test-only unavailable customer data'));
    vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValue(new Error('test-only unavailable model data'));
    render(<BusinessIntelligenceDashboard />);
    await openForecast(); await screen.findByText('Pronóstico 7 días');
    fireEvent.click(screen.getByRole('tab', { name: 'Clientes' }));
    await screen.findByText('No se pudo cargar la consulta.');
    expect(inventoryRead).not.toHaveBeenCalled();
  });

  it('hides the previous inventory while revalidating, and shows its own error on failure', async () => {
    render(<BusinessIntelligenceDashboard />);
    await screen.findByText('Productos en riesgo');
    vi.mocked(apiClient.getInventoryAnalytics).mockRejectedValueOnce(new Error('inventory unavailable'));
    apiClient.invalidateIntelligenceReads();
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    await screen.findByText('Cargando ranking de inventario…');
    expect(screen.queryByText('Riesgo de inventario')).toBeNull();
    await screen.findByText('No se pudo cargar el inventario.');
    expect(screen.queryByText('Riesgo de inventario')).toBeNull();
  });

  it('shows inventory detail values, risk labels, reorder action and ABC/XYZ', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValue(success(productInventoryFixture));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Producto' }), { target: { value: 'pan' } });
    await waitFor(() => expect(apiClient.searchBusinessIntelligenceProducts).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Pan francés.*SKU: PAN-FRE-001/ }));
    expect(await screen.findByText('Stock actual')).toBeTruthy();
    expect(screen.getByText('Alto')).toBeTruthy();
    expect(screen.getByText('Reposición inmediata:')).toBeTruthy();
    expect(screen.getByText('ABC: A')).toBeTruthy();
    expect(screen.getByText('XYZ: X')).toBeTruthy();
    expect(screen.getByText('12 unidades')).toBeTruthy();
  });

  it('hides unclassified ABC in product detail and clarifies preventive quantity when reorder is not immediate', async () => {
    const unclassifiedDetail: ProductInventory = { ...productInventoryFixture,
      recommendation: { ...productInventoryFixture.recommendation, reorderNow: false, recommendedQty: 12 },
      classification: { abc: 'UNCLASSIFIED', xyz: 'X' },
    };
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValue(success(unclassifiedDetail));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Producto' }), { target: { value: 'pan' } });
    await waitFor(() => expect(apiClient.searchBusinessIntelligenceProducts).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Pan francés.*SKU: PAN-FRE-001/ }));
    expect(await screen.findByText('XYZ: X')).toBeTruthy();
    expect(screen.queryByText(/ABC|UNCLASSIFIED/)).toBeNull();
    expect(screen.getByText('Cantidad para el nivel objetivo')).toBeTruthy();
    expect(screen.getByText(/No se recomienda reposición inmediata; la cantidad mostrada es una referencia/)).toBeTruthy();
    expect(screen.getByText('Reposición inmediata:')).toBeTruthy();
    expect(screen.getByText('Reposición inmediata:').parentElement?.textContent).toBe('Reposición inmediata: No');
    expect(screen.getByText(/Cantidad para el nivel objetivo: 12 unidades/)).toBeTruthy();
  });

  it('renders ranking table and selecting a row opens its product forecast', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByRole('table', { name: 'Ranking de riesgo y reposición' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Pan francés.*PAN-FRE-001/ }));
    expect((await screen.findAllByText('Método seleccionado:')).length).toBeGreaterThan(0);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledWith('PAN-FRE-001', 7);
  });

  it('shows a safe retry state on dashboard API failure', async () => {
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockRejectedValue(new Error('private backend detail'));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(inventoryFixture));
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('No se pudo cargar la inteligencia del negocio.')).toBeTruthy();
    expect(screen.queryByText('private backend detail')).toBeNull();
  });

  it('renders ABC and XYZ distributions returned by the inventory endpoint', async () => {
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText('Importancia económica (ABC)')).toBeTruthy();
    expect(screen.getByText('A: 40')).toBeTruthy();
    expect(screen.getByText('X: 55')).toBeTruthy();
  });

  it('hides ABC when every product is unclassified while keeping XYZ and other inventory visible', async () => {
    const unclassifiedInventory: InventorySummary = { ...inventoryFixture, summary: {
      ...inventoryFixture.summary, abcCounts: { A: 0, B: 0, C: 0, UNCLASSIFIED: 80 },
      xyzCounts: { X: 55, Y: 22, Z: 3, UNCLASSIFIED: 0 },
    } };
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(unclassifiedInventory));
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByText('Estabilidad de demanda (XYZ)')).toBeTruthy();
    expect(screen.queryByText('Importancia económica (ABC)')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText('Estabilidad de demanda (XYZ)')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Estabilidad de demanda \(XYZ\)/ }).textContent).toBe('Estabilidad de demanda (XYZ)');
    expect(screen.queryByText('Importancia económica (ABC)')).toBeNull();
    expect(screen.queryByText(/ABC/)).toBeNull();
    expect(screen.getByText('Riesgo de inventario')).toBeTruthy();
    expect(screen.getByText('Reposición recomendada')).toBeTruthy();
    expect(screen.getByText('X: 55')).toBeTruthy();
  });

  it('shows ABC when any classified group has products, even if A and C are empty', async () => {
    const bClassifiedInventory: InventorySummary = { ...inventoryFixture, summary: {
      ...inventoryFixture.summary, abcCounts: { A: 0, B: 4, C: 0, UNCLASSIFIED: 76 },
    } };
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(bClassifiedInventory));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText('Importancia económica (ABC)')).toBeTruthy();
    expect(screen.getByText('Estabilidad de demanda (XYZ)')).toBeTruthy();
  });

  it('shows Health as partial independently when its displayed Forecast, Inventory and Suppliers dependencies are ready', async () => {
    vi.spyOn(apiClient, 'getHealthDiagnostics').mockResolvedValue({ httpStatus: 200, data: { httpStatus: 200,
      dependencyStatus: { inventory: 'READY', forecast: 'READY', supplier: 'READY', healthAssembly: 'PARTIAL' }, reasonCode: null, elapsedMs: 12 } });
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Predicción' }));
    const diagnosticPanel = screen.getByLabelText('Estado del ML');
    await waitFor(() => expect(within(diagnosticPanel).getByText('Ensamblado Health').nextElementSibling?.textContent).toBe('Parcial'));
    expect(within(diagnosticPanel).getByText('Forecast').nextElementSibling?.textContent).toBe('Listo');
    expect(within(diagnosticPanel).getByText('Inventario').nextElementSibling?.textContent).toBe('Listo');
    expect(within(diagnosticPanel).getByText('Proveedores').nextElementSibling?.textContent).toBe('Listo');
  });

  it('does not render unavailable LIVE risk counts as zero or as LOW', async () => {
    const partialSummary: InventorySummary = { ...inventoryFixture, availabilityStatus: 'PARTIAL', summary: {
      ...inventoryFixture.summary, riskCounts: { critical: null, high: null, medium: null, low: null },
      riskCountsStatus: 'PARTIAL', riskUnavailableCount: 5, reorderCount: null,
    } };
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(partialSummary));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText(/Distribución parcial: 5 productos no tienen un nivel de riesgo calculable/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Distribución de riesgo:/ })).toBeNull();
    expect(screen.getByText('No disponible')).toBeTruthy();
    expect(screen.queryByText('Bajo 0')).toBeNull();
  });
});
