import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
import { ExtendedAnalyticsPanel } from '@/components/business-intelligence/ExtendedAnalyticsPanel';
import type { InventorySummary } from '@/types/businessIntelligence';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null, BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null, Cell: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
  Line: () => null, LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValue(new Error('ML metadata outside this fixture')); });
const envelope = <T,>(data: T) => ({ success: true, data });
const meta = { asOf: '2026-10-14', timezone: 'America/Lima', mode: 'LIVE' as const, updatedAt: null, dataThrough: '2026-10-14' };
const inventory = { ...meta, summary: { totalProducts: 1, riskCounts: { critical: 0, high: 0, medium: 1, low: 0 }, reorderCount: 0, lowStockCount: 0, overstockCount: 0, incomingUnits: 0 }, items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés', presentation: null, stock: 21, coverageDays: 4, risk: 'MEDIUM', riskReasonCodes: [], recommendedQty: null, reorderNow: false }], total: 1 } as InventorySummary;

describe('extended business intelligence smoke panels', () => {
  it('renders null sales margin as unavailable and uses the requested period query', async () => {
    const get = vi.spyOn(apiClient, 'getSalesAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: '2026-10-14' }, dataVersion: 0, snapshotHash: 'hash', source: 'LIVE', engineVersion: 'v3', period: { startDate: '2026-10-08', endDate: '2026-10-14' }, comparisonPeriod: null, summary: { revenue: { value: 0, currency: 'PEN' }, units: 0, tickets: 0, averageTicket: { value: null, currency: null }, grossMargin: { value: null, currency: null, percent: null, availability: 'UNAVAILABLE' } }, grossMarginAvailability: 'UNAVAILABLE', variation: null, comparisonAvailability: null, series: null, seriesStatus: 'NOT_REQUESTED', rankings: { topProducts: [], topCategories: [] } } as never));
    render(<ExtendedAnalyticsPanel tab="sales" inventory={inventory} />);
    expect((await screen.findAllByText('No disponible')).length).toBeGreaterThan(0);
    expect(get).toHaveBeenCalledWith({ period: 'TODAY', includeSeries: true, compare: true, limit: 10 });
  });

  it('shows frozen associations and a valid empty related-product state', async () => {
    vi.spyOn(apiClient, 'getAssociations').mockResolvedValue(envelope({ ...meta, mode: 'FROZEN', freshness: { mode: 'FROZEN', cutoff: '2026-10-12' }, dataVersion: null, snapshotHash: null, source: 'M6.7', engineVersion: null, cutoff: '2026-10-12', summary: null, available: false, items: [], total: 0, limit: 10, offset: 0 } as never));
    vi.spyOn(apiClient, 'getRelatedProducts').mockResolvedValue(envelope({ ...meta, mode: 'FROZEN', freshness: { mode: 'FROZEN', cutoff: '2026-10-12' }, dataVersion: null, snapshotHash: null, source: 'M6.7', engineVersion: null, cutoff: '2026-10-12', sourceProduct: { sku: 'PAN-FRE-001', name: 'Pan francés', presentation: null }, available: false, items: [], total: 0 } as never));
    render(<ExtendedAnalyticsPanel tab="related" inventory={inventory} />);
    expect((await screen.findAllByText(/FROZEN · cutoff 2026-10-12/)).length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText('El análisis histórico no tiene reglas disponibles.')).toBeTruthy();
    expect(await screen.findByText('El análisis histórico no tiene recomendaciones disponibles.')).toBeTruthy();
    expect(apiClient.getRelatedProducts).toHaveBeenCalledWith('PAN-FRE-001');
  });

  it('loads customer detail only after selecting a real result reference', async () => {
    const row = { customerId: 'CUS-01', displayName: 'Cliente Uno', segment: 'LOYAL', recency: 1, frequency: 4, monetary: null, spend: null, lifetimeTicketCount: 4, rfm90d: null, averageTicket: null, lastPurchaseDate: null, firstPurchaseDate: null, reasonCodes: [], preferences: null, trends: null, windows: null, freshness: null };
    const list = vi.spyOn(apiClient, 'getCustomersAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 1, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', summary: { totalRegistered: 1, active: 1, new: 0, inactive: 0, atRisk: 0, highValue: 0, potential: 0, segments: {}, consumerFinalIncludedInIndividualRfm: false }, items: [row], total: 1, limit: 20, offset: 0 } as never));
    const detail = vi.spyOn(apiClient, 'getCustomerAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 1, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', status: 'READY', item: row, historyAvailability: 'AVAILABLE' } as never));
    render(<ExtendedAnalyticsPanel tab="customers" inventory={inventory} />);
    await screen.findByText(/Consumer Final se excluye de la segmentación individual/);
    fireEvent.click(screen.getByRole('button', { name: /Cliente Uno/ }));
    expect(await screen.findByText('Gasto registrado')).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    expect(detail).toHaveBeenCalledWith('CUS-01');
  });

  it('loads supplier detail by the selected stable reference and preserves null availability', async () => {
    const row = { supplierId: 'SUP-05', name: 'Proveedor cinco', orders: 3, spend: null, pending: 1, received: 2, leadTime: null, punctuality: null, leadTimeAvailability: 'INSUFFICIENT_HISTORY', dependency: {}, products: [], status: 'PARTIAL' };
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 1, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, summary: { totalSuppliers: 1, totalSpend: null, pendingOrders: 1, receivedOrders: 2, dependency: null, averageLeadTime: { days: null, sampleSize: null, status: 'NOT_EXPOSED_BY_ENGINE' } }, items: [row], total: 1, limit: 20, offset: 0 } as never));
    const detail = vi.spyOn(apiClient, 'getSupplierAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 1, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', status: 'PARTIAL', item: { ...row, costTrends: null, historyAvailability: 'INSUFFICIENT_HISTORY' }, historyAvailability: 'INSUFFICIENT_HISTORY' } as never));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    fireEvent.click(await screen.findByRole('button', { name: /Proveedor cinco/ }));
    expect(await screen.findByText('Productos suministrados')).toBeTruthy();
    expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0);
    expect(detail).toHaveBeenCalledWith('SUP-05');
  });

  it('renders health freshness by domain without creating a composite score', async () => {
    const domains = Object.fromEntries(['sales', 'margin', 'customers', 'inventory', 'suppliers', 'forecast', 'marketBasket'].map(name => [name, { status: name === 'marketBasket' ? 'FROZEN' : 'READY', freshness: { mode: name === 'marketBasket' ? 'FROZEN' : 'LIVE', cutoff: name === 'marketBasket' ? '2026-10-12' : undefined }, metrics: {}, insights: [] }]));
    vi.spyOn(apiClient, 'getBusinessHealth').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 0, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', status: 'PARTIAL', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, domains, insights: [] } as never));
    render(<ExtendedAnalyticsPanel tab="health" inventory={inventory} />);
    expect(await screen.findByText(/No se calcula una puntuación global/)).toBeTruthy();
    expect(screen.getByText('Productos relacionados')).toBeTruthy();
    expect(screen.getByText(/FROZEN/)).toBeTruthy();
    expect(screen.queryByText(/score: \d/i)).toBeNull();
  });

  it('shows a distinct unavailable state for service errors', async () => {
    vi.spyOn(apiClient, 'getBusinessHealth').mockRejectedValue({ response: { status: 503, data: { code: 'ANALYTICS_UNAVAILABLE' } } });
    render(<ExtendedAnalyticsPanel tab="health" inventory={inventory} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/no se sustituyeron los datos por valores históricos/i));
  });

  it('distinguishes observed zero sales from unavailable margin and renders accessible metric help', async () => {
    vi.spyOn(apiClient, 'getSalesAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 0, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, comparisonPeriod: null, summary: { revenue: { value: 0, currency: 'PEN' }, units: 0, tickets: 0, averageTicket: { value: 0, currency: 'PEN' }, grossMargin: { value: null, currency: null, percent: null, availability: 'UNAVAILABLE' } }, grossMarginAvailability: 'UNAVAILABLE', variation: null, comparisonAvailability: null, series: [], seriesStatus: 'READY', rankings: { topProducts: [], topCategories: [] } } as never));
    render(<ExtendedAnalyticsPanel tab="sales" inventory={inventory} />);
    expect(await screen.findByText(/No se registraron ventas en este período/)).toBeTruthy();
    expect(screen.getByText('No disponible')).toBeTruthy();
    const help = screen.getByLabelText('Ayuda: Margen bruto');
    expect(help).toBeTruthy();
    fireEvent.mouseEnter(help.parentElement!);
    expect(await screen.findByText(/No hay costos suficientes para calcular el margen/)).toBeTruthy();
    fireEvent.mouseLeave(help.parentElement!);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    fireEvent.click(help);
    expect(await screen.findByText(/No hay costos suficientes para calcular el margen/)).toBeTruthy();
  });

  it('renders RFM columns and uses human names with secondary SKU for frozen basket rules', async () => {
    const customer = { customerId: 'CUS-1', displayName: 'María Pérez', segment: 'HIGH_VALUE', recency: 2, frequency: 5, monetary: { value: 120, currency: 'PEN' }, spend: { value: 150, currency: 'PEN' }, lifetimeTicketCount: 8, rfm90d: {}, averageTicket: { value: 24, currency: 'PEN' }, lastPurchaseDate: '2026-10-13', firstPurchaseDate: null, reasonCodes: [], preferences: null, trends: null, windows: null, freshness: null };
    vi.spyOn(apiClient, 'getCustomersAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 0, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', summary: { totalRegistered: 1, active: 1, new: 0, inactive: 0, atRisk: 0, highValue: 1, potential: 0, segments: { HIGH_VALUE: 1 }, consumerFinalIncludedInIndividualRfm: false }, items: [customer], total: 1, limit: 20, offset: 0 } as never));
    vi.spyOn(apiClient, 'getAssociations').mockResolvedValue(envelope({ ...meta, mode: 'FROZEN', freshness: { mode: 'FROZEN', cutoff: '2026-10-12' }, dataVersion: null, snapshotHash: null, source: 'M6.7', engineVersion: null, cutoff: '2026-10-12', summary: {}, available: true, items: [{ antecedent: ['A'], antecedentProducts: [{ name: 'Pan Francés', sku: 'PAN-FRE-001' }], consequent: ['B'], consequentProducts: [{ name: 'Leche Gloria', sku: 'LEC-GLO-001' }], support: 0.02, confidence: 0.2, lift: 1.59, ticketCount: 207, stability: 'STABLE', status: 'READY' }], total: 1, limit: 10, offset: 0 } as never));
    vi.spyOn(apiClient, 'getRelatedProducts').mockResolvedValue(envelope({ ...meta, mode: 'FROZEN', freshness: { mode: 'FROZEN', cutoff: '2026-10-12' }, dataVersion: null, snapshotHash: null, source: 'M6.7', engineVersion: null, cutoff: '2026-10-12', sourceProduct: { sku: 'PAN-FRE-001', name: 'Pan Francés', presentation: null }, available: true, items: [{ relatedProduct: { sku: 'LEC-GLO-001', name: 'Leche Gloria' }, support: 0.02, confidence: 0.2, lift: 1.59, ticketCount: 207, stability: 'STABLE', classification: 'CROSS_SELL' }], total: 1 } as never));
    const { rerender } = render(<ExtendedAnalyticsPanel tab="customers" inventory={inventory} />);
    expect((await screen.findAllByText('Alto valor')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Valor monetario').length).toBeGreaterThan(0);
    rerender(<ExtendedAnalyticsPanel tab="related" inventory={inventory} />);
    await waitFor(() => expect(screen.getByText('Pan Francés')).toBeTruthy());
    expect(screen.getAllByText('Leche Gloria').length).toBeGreaterThan(0);
    expect(screen.getByText('SKU: PAN-FRE-001')).toBeTruthy();
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FROZEN · cutoff 2026-10-12').length).toBeGreaterThan(0);
  });
});
