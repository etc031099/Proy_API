import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessIntelligenceDashboard } from '@/components/business-intelligence/BusinessIntelligenceDashboard';
import { apiClient } from '@/lib/api';
import { getTranslation } from '@/i18n/dict';
import { clearLatestForecastImpactSale, publishForecastImpactSale } from '@/lib/forecastImpactChannel';
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
  beforeEach(() => { vi.restoreAllMocks(); clearLatestForecastImpactSale(); mockOverview();
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
    vi.spyOn(apiClient, 'getProductOperations').mockResolvedValue({ httpStatus: 200, data: {
      product: { sku: 'PAN-FRE-001', name: 'Pan francés' }, items: [], limit: 20, hasMore: false, nextCursor: null,
      filters: { type: 'ALL', from: null, to: null },
    } });
    vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: { state: 'NO_TEST', resetEpoch: '0', testCycleId: null,
      maintenance: false, cloudRestoreEnabled: false, capabilities: { destructiveMlTestControls: { allowed: false, target: null, reasonCode: 'ML_TEST_PRODUCTION_FORBIDDEN' } } } });
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus');
    vi.spyOn(apiClient, 'getCertifiedForecastReplayEvidence').mockResolvedValue({ httpStatus: 200, data: replayEvidenceFixture });
    vi.spyOn(apiClient, 'getForecastModelEvaluation').mockRejectedValue(new Error('Evaluation not part of these LIVE fixtures'));
  });

  it('renames the navigation label and presents the new page title', async () => {
    render(<BusinessIntelligenceDashboard />);
    expect(getTranslation('es', 'navigation.demandForecast')).toBe('Inteligencia del Negocio');
    expect(screen.getByRole('heading', { name: 'Analítica e Inteligencia del Negocio' })).toBeTruthy();
    expect(await screen.findByText('Ventas')).toBeTruthy();
  });

  it('keeps the eight navigation tabs in one non-wrapping row and preserves selection', async () => {
    render(<BusinessIntelligenceDashboard />);
    const tablist = screen.getByRole('tablist', { name: 'Secciones de inteligencia del negocio' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual([
      'Resumen', 'Predicción', 'Inventario', 'Ventas', 'Clientes', 'Proveedores', 'Productos relacionados', 'Salud',
    ]);
    expect(tablist.className).toContain('w-max');
    expect(tablist.className).toContain('min-w-full');
    expect(tablist.className).toContain('gap-2');
    expect(tablist.className).toContain('xl:justify-center');
    expect(tablist.className).not.toContain('justify-between');
    expect(tablist.parentElement?.className).toContain('overflow-x-auto');
    expect(tabs.every(tab => tab.className.includes('flex-none') && tab.className.includes('whitespace-nowrap'))).toBe(true);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]?.className).toContain('border-primary');
    expect(tabs[1]?.className).toContain('border-transparent');

    fireEvent.click(screen.getByRole('tab', { name: 'Productos relacionados' }));
    const relatedTab = screen.getByRole('tab', { name: 'Productos relacionados' });
    expect(relatedTab.getAttribute('aria-selected')).toBe('true');
    expect(relatedTab.className).toContain('border-primary');
    expect(screen.getByRole('tab', { name: 'Salud' })).toBeTruthy();
  });

  it('shows summary KPIs and treats zero sales as a real zero state', async () => {
    render(<BusinessIntelligenceDashboard />);
    expect((await screen.findAllByText(/0\.00/)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Actividad de hoy')).toBeTruthy();
    expect(screen.getByText('Unidades vendidas')).toBeTruthy();
    expect(screen.getByText('Tickets')).toBeTruthy();
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
    expect(await screen.findByLabelText('Actividad de hoy')).toBeTruthy();
    expect(screen.getByText('Cargando inventario y ranking…')).toBeTruthy();
    expect(apiClient.getBusinessIntelligenceSummary).toHaveBeenCalledTimes(1);
    expect(apiClient.getInventoryAnalytics).toHaveBeenCalledTimes(1);

    await act(async () => { inventoryRead.resolve(success(inventoryFixture)); await inventoryRead.promise; });
    expect(await screen.findByText('Panorama de inventario')).toBeTruthy();
    expect(screen.queryByText('Cargando inventario y ranking…')).toBeNull();
  });

  it('loads the summary before starting the heavier inventory ranking request', async () => {
    const summaryRead = deferred<Awaited<ReturnType<typeof apiClient.getBusinessIntelligenceSummary>>>();
    const inventoryRead = deferred<Awaited<ReturnType<typeof apiClient.getInventoryAnalytics>>>();
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockReturnValue(summaryRead.promise);
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockReturnValue(inventoryRead.promise);
    render(<BusinessIntelligenceDashboard />);

    expect(apiClient.getInventoryAnalytics).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Cargando resumen general' })).toBeTruthy();
    expect(screen.queryByText('Ventas')).toBeTruthy();

    await act(async () => { summaryRead.resolve(success(summaryFixture)); await summaryRead.promise; });
    expect(await screen.findByLabelText('Actividad de hoy')).toBeTruthy();
    expect(apiClient.getInventoryAnalytics).toHaveBeenCalledTimes(1);
    await act(async () => { inventoryRead.resolve(success(inventoryFixture)); await inventoryRead.promise; });
    expect(await screen.findByText('Panorama de inventario')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Cargando resumen general' })).toBeNull();
  });

  it('restores the latest sale metadata on Summary without reading Ridge forecasts until Prediction opens', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(success({ businessId: 'business-1', scenarioId: 'scenario-1', datasetVersion: 'v1', dataVersion: '83', asOf: temporal.asOf }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: 'sale-12345678',
      occurredAt: '2026-10-20T18:00:00Z', hasCustomer: false, customerRef: null,
      products: [{ sku: 'PAN-FRE-001', name: 'Pan francés', quantity: 2 }], baseline: null,
      baselineUnavailable: true, context: { businessId: 'business-1', scenarioId: 'scenario-1', datasetVersion: 'v1' } });
    render(<BusinessIntelligenceDashboard />);

    expect(await screen.findByText(/12345678/)).toBeTruthy();
    expect(apiClient.getBusinessIntelligenceForecast).not.toHaveBeenCalled();
    expect(apiClient.getIntelligenceRevision).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Predicción' }));
    await waitFor(() => expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2));
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(1, 'PAN-FRE-001', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(2, 'PAN-FRE-001', 14);

    fireEvent.click(screen.getByRole('tab', { name: 'Resumen' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Predicción' }));
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
  });

  it('keeps summary visible when the independent inventory request fails', async () => {
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockResolvedValue(success(summaryFixture));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockRejectedValue(new Error('Inventory unavailable'));
    render(<BusinessIntelligenceDashboard />);

    expect(await screen.findByLabelText('Actividad de hoy')).toBeTruthy();
    expect(await screen.findByText('No se pudo cargar el inventario.')).toBeTruthy();
    expect(apiClient.getBusinessIntelligenceSummary).toHaveBeenCalledTimes(1);
    expect(apiClient.getInventoryAnalytics).toHaveBeenCalledTimes(1);
  });

  it('shows a compact map of analytical methods and navigates without adding a tab', async () => {
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByRole('heading', { name: 'Técnicas de análisis' })).toBeTruthy();
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    expect(screen.getByText(/Ridge Regression/)).toBeTruthy();
    expect(screen.getByText(/RFM \+ K-Means/)).toBeTruthy();
    expect(screen.getByText(/Isolation Forest/)).toBeTruthy();
    expect(screen.getByText(/FP-Growth/)).toBeTruthy();
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
    const partial = { ...summaryFixture, grossMargin: { value: null, currency: null, percent: null, availability: 'PARTIAL' as const,
      costCoverage: { knownSaleLines: 3, unknownSaleLines: 2, status: 'PARTIAL' } } };
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockResolvedValue(success(partial));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(inventoryFixture));
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByText('No disponible')).toBeTruthy();
    expect(screen.getByText('Costos registrados para 3 de 5 líneas de venta.')).toBeTruthy();
    expect(screen.queryByText(/Parcial ·/)).toBeNull();
  });

  it('shows the returned risk and reorder aggregates and explains when global counts are partial', async () => {
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByText('5 críticos · 6 altos')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
    cleanup();
    vi.restoreAllMocks();
    const partialSummary: BusinessSummary = { ...summaryFixture,
      inventory: { ...summaryFixture.inventory, riskCounts: { critical: null, high: null, medium: null, low: null }, reorderCount: null } };
    const partialInventory: InventorySummary = { ...inventoryFixture,
      summary: { ...inventoryFixture.summary, riskCounts: { critical: null, high: null, medium: null, low: null },
        riskUnavailableCount: 4, recommendationUnavailableCount: 3, reorderCount: null } };
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockResolvedValue(success(partialSummary));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(partialInventory));
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByText('Conteo global no disponible; análisis parcial disponible abajo (4 sin riesgo calculable).')).toBeTruthy();
    expect(screen.getByText('Conteo global no disponible; revisa las acciones por producto abajo (3 sin recomendación calculable).')).toBeTruthy();
    expect(screen.getAllByText('Alto').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reponer ahora').length).toBeGreaterThan(0);
  });

  it('shows a complete margin amount and percentage from the dashboard summary contract', async () => {
    const completeMargin: BusinessSummary = { ...summaryFixture,
      grossMargin: { value: 123.45, currency: 'PEN', percent: 25, availability: 'AVAILABLE',
        costCoverage: { knownSaleLines: 5, unknownSaleLines: 0, status: 'AVAILABLE' } } };
    vi.spyOn(apiClient, 'getBusinessIntelligenceSummary').mockResolvedValue(success(completeMargin));
    render(<BusinessIntelligenceDashboard />);
    const marginCard = (await screen.findByText('Margen bruto')).closest('.rounded-xl');
    expect(marginCard?.textContent).toMatch(/123[,.]45/);
    expect(marginCard?.textContent).toMatch(/25[,.]0/);
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
    expect(await screen.findByText('Ver detalles del modelo')).toBeTruthy();
    fireEvent.click(screen.getByText('Ver detalles del modelo'));
    expect((await screen.findAllByText('Media móvil de 28 días (histórico)')).length).toBeGreaterThan(0);
    expect(screen.getByText('Día cerrado sin ventas')).toBeTruthy();
    expect(screen.getByText('Dato faltante')).toBeTruthy();
    expect(screen.getByText('Día parcial')).toBeTruthy();
  });

  it('loads product operations only after opening the internal history tab', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    expect(apiClient.getProductOperations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Historial de operaciones' }));
    expect(await screen.findByText('No hay operaciones para los filtros seleccionados.')).toBeTruthy();
    expect(apiClient.getProductOperations).toHaveBeenCalledWith('PAN-FRE-001', { type: 'ALL', limit: 20 }, expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: 'Pronóstico' }).getAttribute('aria-pressed')).toBe('false');
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
    expect(await screen.findByText('Modelo LIVE · Ridge v1')).toBeTruthy();
    const modelDetails = screen.getByText('Ver detalles del modelo').closest('details')!;
    expect(modelDetails.open).toBe(false);
    fireEvent.click(screen.getByText('Ver detalles del modelo'));
    expect(within(modelDetails).getByText('Machine Learning Ridge')).toBeTruthy();
    expect(within(modelDetails).getByText(/15 oct/i)).toBeTruthy();
    expect(within(modelDetails).getByText(/14 oct/i)).toBeTruthy();
    expect(within(modelDetails).getByText(/Baseline estadístico MA28/)).toBeTruthy();
    expect(forecastCardText(7)).toContain('16.25');
    expect(forecastCardText(14)).toContain('32.50');
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Pronóstico 14 días/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('button', { name: /Pronóstico 1 día/ })).toBeNull();
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(1, 'PAN-FRE-001', 7);
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenNthCalledWith(2, 'PAN-FRE-001', 14);

    fireEvent.click(screen.getByRole('button', { name: /Pronóstico 14 días/ }));
    expect(await screen.findByText(/Total para 14 días:/)).toBeTruthy();
    expect(forecastCardText(7)).toContain('16.25');
    expect(screen.getByRole('button', { name: /Pronóstico 14 días/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /Pronóstico 7 días/ }));
    expect(await screen.findByText(/Total para 7 días:/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ }).getAttribute('aria-pressed')).toBe('true');
    expect(forecastCardText(7)).toContain('16.25');
    expect(forecastCardText(14)).toContain('32.50');
    expect(apiClient.getBusinessIntelligenceForecast).toHaveBeenCalledTimes(2);
  });

  it('explains certified historical candidate evaluation separately from LIVE without running replay', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    const panel = await screen.findByRole('region', { name: 'Evaluación histórica certificada' });
    fireEvent.click(within(panel).getByText('Ver evaluación completa'));
    expect(apiClient.getCertifiedForecastReplayEvidence).toHaveBeenCalledTimes(1);
    expect(within(panel).getByText(/Esta evaluación reproduce evidencia histórica cerrada/)).toBeTruthy();
    expect(within(panel).getByText('107 orígenes maduros evaluados')).toBeTruthy();
    expect(within(panel).getByText(/No significa 107 ventas/)).toBeTruthy();
    expect(within(panel).getAllByText('APROBADO').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('RECHAZADO').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/\+7[,.]29\s*%/)).toHaveLength(2);
    expect(within(panel).getAllByText(/\+13[,.]23\s*%/)).toHaveLength(2);
    expect(within(panel).getByText(/21[,.]82\s*%/)).toBeTruthy();
    expect(within(panel).getByText(/16[,.]02\s*%/)).toBeTruthy();
    expect(within(panel).getByText(/2[,.]76 unidades/)).toBeTruthy();
    expect(within(panel).getByText(/4[,.]06 unidades/)).toBeTruthy();
    expect(within(panel).getByText(/\+1[,.]52\s*%/)).toBeTruthy();
    expect(within(panel).getByText(/\+1[,.]04\s*%/)).toBeTruthy();
    expect(within(panel).getByText(/El candidato histórico superó las reglas exigidas/)).toBeTruthy();
    expect(within(panel).getByText(/Aunque mejoró globalmente, fue rechazado porque falló una regla de seguridad/)).toBeTruthy();
    expect(within(panel).getByText(/En el fold con clave F3, el SKU/).textContent).toContain('BEB-GAS-003');
    expect(within(panel).getByText(/Una mejora promedio no basta/)).toBeTruthy();
    expect(within(panel).getByText(/Esta evaluación es histórica y aislada/)).toBeTruthy();
    expect(within(panel).getByText(/No cambia ACTIVE ni Registry, no modifica ventas, stock o señales LIVE/)).toBeTruthy();
    const technicalDetails = within(panel).getAllByText('Ver detalles técnicos').map((label) => label.closest('details')!);
    expect(technicalDetails).toHaveLength(2);
    const replayDetails = technicalDetails[1];
    expect(replayDetails.open).toBe(false);
    const reason = within(replayDetails).getByText('P_FOLD_CATA_MAE:F3:BEB-GAS-003');
    expect(reason.closest('details')?.open).toBe(false);
    fireEvent.click(within(replayDetails).getByText('Ver detalles técnicos'));
    expect(within(panel).getByText(/Semilla determinista/)).toBeTruthy();
    expect(within(replayDetails).getByText(/BEB-GAS-003/)).toBeTruthy();
    expect(within(replayDetails).getByText(/P_FOLD_CATA_MAE:F3:BEB-GAS-003/)).toBeTruthy();
    expect(within(technicalDetails[0]).getByText('Candidato seleccionado en replay').parentElement?.textContent).toContain('replay:cert-stable-2020:7d:v2');
    expect(within(panel).getByRole('button', { name: 'Explorar evidencia' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /Pronóstico 1 día/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pronóstico 14 días/ })).toBeTruthy();
  });

  it('keeps a loading state, rejects a non-certificate response, and never invokes training or restore actions', async () => {
    const pending = deferred<{ httpStatus: number; data?: CertifiedForecastReplayEvidence }>();
    vi.spyOn(apiClient, 'getCertifiedForecastReplayEvidence').mockReturnValue(pending.promise);
    const train = vi.spyOn(apiClient, 'analyzeMlTestScenario');
    const manual = vi.spyOn(apiClient, 'requestForecastMlUpdate');
    const checkpoint = vi.spyOn(apiClient, 'createMlTestCheckpoint');
    const restore = vi.spyOn(apiClient, 'restoreMlTestCheckpoint');
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    expect(await screen.findByText('Cargando evaluación histórica certificada…')).toBeTruthy();
    pending.resolve({ httpStatus: 200, data: { ...replayEvidenceFixture, requiredOrigins: 106 } as unknown as CertifiedForecastReplayEvidence });
    expect(await screen.findByText('La evaluación histórica certificada no está disponible.')).toBeTruthy();
    expect(train).not.toHaveBeenCalled(); expect(manual).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Pronóstico 7 días/ })).toBeTruthy();
  });

  it('orders Prediction from current ML state to product forecast, history, replay, and local tests', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: { state: 'NO_TEST', resetEpoch: '0', testCycleId: null,
      maintenance: false, cloudRestoreEnabled: false, capabilities: { destructiveMlTestControls: { allowed: true, target: 'LOCAL', reasonCode: null } } } });
    vi.spyOn(apiClient, 'getMlTestLifecycleStatus').mockResolvedValue({ httpStatus: 200, data: { state: 'NO_TEST', resetEpoch: '0', testCycleId: null,
      maintenance: false, checkpoint: null, cloudRestoreEnabled: false } });
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    expect(apiClient.getMlTestControlStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Herramientas avanzadas de demostración local'));
    await waitFor(() => expect(apiClient.getMlTestControlStatus).toHaveBeenCalledTimes(1));
    const orderedLabels = [
      'Pronóstico Ridge LIVE', 'Detalles técnicos',
      'Pronóstico por producto', 'Pronóstico 7 días', 'Impacto de nuevos datos',
      'Preparación para próxima evaluación', 'Historial de actualizaciones ML',
      'Evaluación histórica certificada', 'Evidencia histórica y comparación de modelos',
      'Herramientas avanzadas de demostración local',
    ];
    const orderedNodes = orderedLabels.map(title => screen.getByText(title));
    for (let index = 0; index < orderedNodes.length - 1; index += 1) {
      expect(orderedNodes[index]!.compareDocumentPosition(orderedNodes[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('keeps Prediction usable when certified replay evidence is temporarily unavailable', async () => {
    vi.mocked(apiClient.getCertifiedForecastReplayEvidence).mockRejectedValueOnce(new Error('temporary failure'));
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    expect(await screen.findByText('No se pudo cargar la evaluación histórica certificada.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Pronóstico Ridge LIVE' })).toBeTruthy();
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
    expect(await screen.findByText('Elige un producto para ver sus pronósticos Ridge de 7 y 14 días.')).toBeTruthy();
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
    await screen.findByText('Cargando inventario…');
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
    expect(screen.getAllByText('Alto').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reponer ahora').length).toBeGreaterThan(0);
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
    expect(screen.queryByText('ABC: UNCLASSIFIED')).toBeNull();
    expect(screen.getByText('Cantidad para el nivel objetivo')).toBeTruthy();
    expect(screen.getByText(/No se recomienda reposición inmediata; la cantidad mostrada es una referencia/)).toBeTruthy();
    const reorderMetric = within(screen.getByRole('region', { name: 'Reglas' })).getByText('Reponer ahora');
    expect(reorderMetric.closest('div')?.parentElement?.textContent).toContain('No');
    expect(screen.getByText(/Cantidad para el nivel objetivo: 12 unidades/)).toBeTruthy();
  });

  it('renders the compact summary ranking and opens the selected product in inventory', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockResolvedValue(success(productInventoryFixture));
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByRole('table', { name: 'Hasta ocho productos priorizados por el ranking de inventario' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Pan francés.*PAN-FRE-001/ })[0]!);
    expect(await screen.findByText('Stock actual')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Inventario' }).getAttribute('aria-selected')).toBe('true');
    expect(apiClient.getBusinessIntelligenceProductInventory).toHaveBeenCalledWith('PAN-FRE-001');
  });

  it('limits the summary ranking to the first eight backend-ranked products without extra reads', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...inventoryFixture.items[0]!,
      sku: `SKU-${String(index + 1).padStart(3, '0')}`,
      productName: `Producto ${index + 1}`,
    }));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success({ ...inventoryFixture, items, total: items.length }));
    render(<BusinessIntelligenceDashboard />);

    const table = await screen.findByRole('table', { name: 'Hasta ocho productos priorizados por el ranking de inventario' });
    expect(within(table).getAllByRole('row')).toHaveLength(9);
    expect(within(table).getByText('Producto 1')).toBeTruthy();
    expect(within(table).getByText('Producto 8')).toBeTruthy();
    expect(within(table).queryByText('Producto 9')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ver todos los productos en Inventario →' })).toBeTruthy();
    expect(apiClient.getBusinessIntelligenceSummary).toHaveBeenCalledTimes(1);
    expect(apiClient.getInventoryAnalytics).toHaveBeenCalledTimes(1);
    expect(screen.getByText('UNCLASSIFIED: No disponible')).toBeTruthy();
  });

  it('orders inventory sections and expands the top-eight ranking from already loaded rows only', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...inventoryFixture.items[0]!, sku: `INV-${index + 1}`, productName: `Inventario ${index + 1}`,
    }));
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success({ ...inventoryFixture, items, total: 80 }));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    const summarySection = await screen.findByRole('region', { name: 'Resumen operativo de inventario' });
    const impactSection = screen.getByRole('region', { name: 'Impacto de última operación' });
    const searchHint = screen.getByText('Selecciona un producto del buscador o del ranking para ver su detalle.');
    const searchCard = screen.getByRole('textbox', { name: 'Producto' }).closest('[class*="p-3"]');
    expect(searchCard).toBeTruthy();
    expect(searchHint.closest('[class*="p-3"]')).toBe(searchCard);
    const panoramaHeading = screen.getByRole('heading', { name: 'Panorama de inventario' });
    const rankingHeading = screen.getByRole('heading', { name: 'Productos que requieren atención' });
    expect(summarySection.compareDocumentPosition(impactSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(impactSection.compareDocumentPosition(panoramaHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panoramaHeading.compareDocumentPosition(rankingHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Productos priorizados por el ranking de inventario' });
    expect(within(table).getAllByRole('row')).toHaveLength(9);
    expect(within(table).getByText('Inventario 8')).toBeTruthy();
    expect(within(table).queryByText('Inventario 9')).toBeNull();
    const inventoryReadsBeforeExpand = vi.mocked(apiClient.getInventoryAnalytics).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Ver ranking completo →' }));
    expect(within(table).getAllByRole('row')).toHaveLength(13);
    expect(within(table).getByText('Inventario 12')).toBeTruthy();
    expect(apiClient.getInventoryAnalytics).toHaveBeenCalledTimes(inventoryReadsBeforeExpand);
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

  it('renders the requested risk and XYZ panorama without adding ABC to this overview', async () => {
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText('Distribución de riesgo')).toBeTruthy();
    expect(screen.getByText('X: 55')).toBeTruthy();
    expect(screen.queryByText(/Importancia económica \(ABC\)/)).toBeNull();
  });

  it('shows honest global partial risk and reorder aggregates from the full inventory projection', async () => {
    const partialInventory: InventorySummary = { ...inventoryFixture, summary: {
      ...inventoryFixture.summary,
      riskCounts: { critical: null, high: null, medium: null, low: null },
      riskUnavailableCount: 1,
      riskEvaluableCounts: { critical: 23, high: 19, medium: 30, low: 7 },
      riskEvaluableCount: 79,
      reorderCount: null,
      reorderCountEvaluable: 18,
      reorderEvaluableCount: 79,
      reorderDecisionUnavailableCount: 1,
    } };
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(partialInventory));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText('18')).toBeTruthy();
    expect(screen.getByText('18 de 79 productos evaluables · 1 sin decisión de reposición.')).toBeTruthy();
    expect(screen.getByText('42 productos')).toBeTruthy();
    expect(screen.getByText('23 críticos · 19 altos')).toBeTruthy();
    expect(screen.getByText('79 de 80 productos evaluables · 1 sin riesgo calculable.')).toBeTruthy();
    expect(screen.getByText('Distribución parcial sobre 79 de 80 productos evaluables.')).toBeTruthy();
    expect(screen.getByText('1 producto sin riesgo calculable')).toBeTruthy();
    const panorama = screen.getByRole('region', { name: 'Panorama de inventario' });
    for (const level of ['Crítico', 'Alto', 'Medio', 'Bajo']) expect(within(panorama).getByText(level)).toBeTruthy();
    expect(screen.getAllByText('Reponer ahora').length).toBeGreaterThan(0);
  });

  it('shows only known risk levels when partial category counts are incomplete', async () => {
    const partialInventory: InventorySummary = { ...inventoryFixture, summary: {
      ...inventoryFixture.summary,
      riskCounts: { critical: null, high: null, medium: null, low: null },
      riskUnavailableCount: 2,
      riskEvaluableCounts: { critical: 4, high: null, medium: 8, low: 20 },
      riskEvaluableCount: 78,
    } };
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(partialInventory));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    const panorama = await screen.findByRole('region', { name: 'Panorama de inventario' });
    expect(within(panorama).getByText('Crítico')).toBeTruthy();
    expect(within(panorama).getByText('Medio')).toBeTruthy();
    expect(within(panorama).getByText('Bajo')).toBeTruthy();
    expect(within(panorama).queryByText('Alto')).toBeNull();
    expect(screen.getByText('No disponible')).toBeTruthy();
    expect(screen.queryByText(/\d+ productos$/)).toBeNull();
    expect(screen.getByText('Distribución parcial sobre 78 de 80 productos evaluables.')).toBeTruthy();
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
    expect(screen.queryByText('Importancia económica (ABC)')).toBeNull();
    expect(screen.getByText('Distribución de riesgo')).toBeTruthy();
    expect(screen.getByText('Productos a reponer')).toBeTruthy();
    expect(screen.getByText('X: 55')).toBeTruthy();
  });

  it('keeps ABC out of the panorama while retaining the XYZ classification view', async () => {
    const bClassifiedInventory: InventorySummary = { ...inventoryFixture, summary: {
      ...inventoryFixture.summary, abcCounts: { A: 0, B: 4, C: 0, UNCLASSIFIED: 76 },
    } };
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(bClassifiedInventory));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText('Estabilidad de demanda (XYZ)')).toBeTruthy();
    expect(screen.queryByText('Importancia económica (ABC)')).toBeNull();
    expect(screen.getByText('Estabilidad de demanda (XYZ)')).toBeTruthy();
  });

  it('shows Health as partial independently when its displayed Forecast, Inventory and Suppliers dependencies are ready', async () => {
    vi.spyOn(apiClient, 'getHealthDiagnostics').mockResolvedValue({ httpStatus: 200, data: { httpStatus: 200,
      dependencyStatus: { inventory: 'READY', forecast: 'READY', supplier: 'READY', healthAssembly: 'PARTIAL' }, reasonCode: null, elapsedMs: 12 } });
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Predicción' }));
    fireEvent.click(screen.getByText('Detalles técnicos'));
    const diagnosticPanel = await screen.findByLabelText('Estado del ML');
    fireEvent.click(await within(diagnosticPanel).findByText('Ver estado de Health'));
    await waitFor(() => expect(within(diagnosticPanel).getByText('Ensamblado Health').nextElementSibling?.textContent).toBe('Parcial'));
    expect(within(diagnosticPanel).getByText('Forecast').nextElementSibling?.textContent).toBe('Listo');
    expect(within(diagnosticPanel).getByText('Inventario').nextElementSibling?.textContent).toBe('Listo');
    expect(within(diagnosticPanel).getByText('Proveedores').nextElementSibling?.textContent).toBe('Listo');
  });

  it('loads expensive Forecast and Health diagnostics only when technical details are opened', async () => {
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Predicción' }));
    expect(apiClient.getForecastModelDiagnostics).not.toHaveBeenCalled();
    expect(apiClient.getHealthDiagnostics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Detalles técnicos'));
    await waitFor(() => {
      expect(apiClient.getForecastModelDiagnostics).toHaveBeenCalledTimes(1);
      expect(apiClient.getHealthDiagnostics).toHaveBeenCalledTimes(1);
    });
  });

  it('does not render unavailable LIVE risk counts as zero or as LOW', async () => {
    const partialSummary: InventorySummary = { ...inventoryFixture, availabilityStatus: 'PARTIAL', summary: {
      ...inventoryFixture.summary, riskCounts: { critical: null, high: null, medium: null, low: null },
      riskCountsStatus: 'PARTIAL', riskUnavailableCount: 5, reorderCount: null,
    } };
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(partialSummary));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText('5 productos sin riesgo calculable')).toBeTruthy();
    expect(screen.queryByText('La distribución global no está disponible porque el análisis es parcial.')).toBeNull();
    expect(screen.queryByRole('img', { name: /Distribución de riesgo:/ })).toBeNull();
    expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0);
    expect(screen.queryByText('Bajo 0')).toBeNull();
  });

  it('does not invent a count when the number of products without computable risk is absent', async () => {
    const partialSummary: InventorySummary = { ...inventoryFixture, availabilityStatus: 'PARTIAL', summary: {
      ...inventoryFixture.summary, riskCounts: { critical: null, high: null, medium: null, low: null },
      riskCountsStatus: 'PARTIAL', riskUnavailableCount: undefined,
    } };
    vi.spyOn(apiClient, 'getInventoryAnalytics').mockResolvedValue(success(partialSummary));
    render(<BusinessIntelligenceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: 'Inventario' }));
    expect(await screen.findByText('No hay conteos evaluables disponibles.')).toBeTruthy();
    expect(screen.queryByText(/\d+ productos? sin riesgo calculable/)).toBeNull();
  });
});
