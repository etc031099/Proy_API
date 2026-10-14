import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessIntelligenceDashboard } from '@/components/business-intelligence/BusinessIntelligenceDashboard';
import { apiClient } from '@/lib/api';
import { getTranslation } from '@/i18n/dict';
import type { BusinessSummary, ForecastResponse, InventorySummary, ProductInventory } from '@/types/businessIntelligence';

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
  ...temporal, status: 'READY', product: { sku: 'PAN-FRE-001', name: 'Pan francés', presentation: 'Unidad' }, method: 'MOVING_AVERAGE_28',
  observationCutoff: '2026-10-13', horizons: { '1d': 2.32, '7d': 16.25, '14d': 32.5 },
  observedSeries: [
    { date: '2026-10-11', units: 4, status: 'CLOSED' },
    { date: '2026-10-12', units: 0, status: 'ZERO' },
    { date: '2026-10-13', units: null, status: 'MISSING' },
    { date: '2026-10-14', units: 2, status: 'PARTIAL' },
  ], forecastPeriod: { startDate: '2026-10-15', selectedHorizonDays: 7, units: 16.25 },
};
const productInventoryFixture: ProductInventory = {
  ...temporal, status: 'READY', availability: 'READY', freshness: { mode: 'LIVE', updatedAt: temporal.updatedAt, dataThrough: temporal.dataThrough },
  product: forecastFixture.product, stock: { onHand: 21, incoming: 0, inventoryPosition: 21 },
  demand: { expectedDaily: 2.32, expectedUnitsNext1d: 2.32, expectedUnitsNext7d: 16.25, expectedUnitsNext14d: 32.5 },
  coverage: { daysCover: 9, status: 'AVAILABLE' }, inventoryPolicy: { safetyStock: 8, reorderPoint: 12 },
  recommendation: { reorderNow: true, preventiveRecommendation: null, recommendedQty: 12 }, risk: { level: 'HIGH', reasonCodes: ['LOW_COVERAGE'] }, classification: { abc: 'A', xyz: 'X' },
};

function success<T>(data: T) { return { success: true, data }; }
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

describe('business intelligence dashboard', () => {
  beforeEach(() => { vi.restoreAllMocks(); mockOverview(); });

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

  it('searches products only on demand and offers 1, 7 and 14-day forecast without 28-day horizon', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    expect(apiClient.getBusinessIntelligenceForecast).not.toHaveBeenCalled();
    await openForecast();
    expect(await screen.findByText('Pronóstico 1 día')).toBeTruthy();
    expect(screen.getByText('Pronóstico 7 días')).toBeTruthy();
    expect(screen.getByText('Pronóstico 14 días')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pronóstico 28 días/ })).toBeNull();
    expect(screen.getByText('Media móvil de 28 días')).toBeTruthy();
    expect(screen.getByText('Día cerrado sin ventas')).toBeTruthy();
    expect(screen.getByText('Dato faltante')).toBeTruthy();
    expect(screen.getByText('Día parcial')).toBeTruthy();
  });

  it('renders cold start without forecast numbers or a fake forecast line', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success({ ...forecastFixture, status: 'COLD_START', horizons: { '1d': null, '7d': null, '14d': null }, observedSeries: [], forecastPeriod: null }));
    render(<BusinessIntelligenceDashboard />);
    await openForecast();
    expect(await screen.findByText('Historial insuficiente para generar un pronóstico.')).toBeTruthy();
    expect(screen.queryByText('Pronóstico 7 días')).toBeNull();
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

  it('renders ranking table and selecting a row opens its product forecast', async () => {
    vi.spyOn(apiClient, 'searchBusinessIntelligenceProducts').mockResolvedValue(success({ products: [productOption] }));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockResolvedValue(success(forecastFixture));
    render(<BusinessIntelligenceDashboard />);
    expect(await screen.findByRole('table', { name: 'Ranking de riesgo y reposición' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Pan francés.*PAN-FRE-001/ }));
    expect(await screen.findByText('Método:')).toBeTruthy();
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
});
