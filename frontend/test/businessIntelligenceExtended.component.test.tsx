import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
import { ExtendedAnalyticsPanel } from '@/components/business-intelligence/ExtendedAnalyticsPanel';
import type { InventorySummary } from '@/types/businessIntelligence';
import { AnalyticsErrorBoundary } from '@/components/business-intelligence/AnalyticsErrorBoundary';

const chartProbe = vi.hoisted(() => ({ fail: false, formatters: [] as Array<(value: unknown, name: string) => unknown> }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null, BarChart: ({ children }: { children: React.ReactNode }) => { if (chartProbe.fail) throw new Error('test chart failure'); return <div>{children}</div>; },
  CartesianGrid: () => null, Cell: () => null, Tooltip: ({ formatter }: { formatter: (value: unknown, name: string) => unknown }) => { chartProbe.formatters.push(formatter); return null; }, XAxis: () => null, YAxis: () => null,
  Line: () => null, LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  chartProbe.fail = false; chartProbe.formatters = [];
  vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValue(new Error('ML metadata outside this fixture'));
  vi.spyOn(apiClient, 'getSalesAnomalies').mockRejectedValue(new Error('Frozen anomalies outside this fixture'));
});
const envelope = <T,>(data: T) => ({ success: true, data });
const meta = { asOf: '2026-10-14', timezone: 'America/Lima', mode: 'LIVE' as const, updatedAt: null, dataThrough: '2026-10-14' };
const inventory = { ...meta, summary: { totalProducts: 1, riskCounts: { critical: 0, high: 0, medium: 1, low: 0 }, reorderCount: 0, lowStockCount: 0, overstockCount: 0, incomingUnits: 0 }, items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés', presentation: null, stock: 21, coverageDays: 4, risk: 'MEDIUM', riskReasonCodes: [], recommendedQty: null, reorderNow: false }], total: 1 } as InventorySummary;
const supplierRow = { supplierId: 'SUP-05', name: 'Proveedor cinco', orders: 3, spend: { value: 45, currency: 'PEN' }, pending: 1, received: 2, leadTime: null, punctuality: null, leadTimeAvailability: 'INSUFFICIENT_HISTORY', dependency: {}, products: [], status: 'PARTIAL' };
const supplierFixture = () => ({ ...meta, freshness: { mode: 'LIVE', dataThrough: null }, dataVersion: 0, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, summary: { totalSuppliers: 1, totalSpend: null, pendingOrders: 1, receivedOrders: 2, dependency: null, averageLeadTime: { days: null, sampleSize: null, status: 'INSUFFICIENT_HISTORY' } }, items: [supplierRow], total: 1, limit: 20, offset: 0 });
const customerFixture = () => ({ ...meta, freshness: { mode: 'LIVE' }, summary: { totalRegistered: 0, active: 0, new: 0, inactive: 0, atRisk: 0, highValue: 0, segments: {}, consumerFinalIncludedInIndividualRfm: false }, items: [], total: 0 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('G.5 FIX1 supplier isolation and partial contracts', () => {
  it('never renders prior customer data as suppliers while the new request is pending', async () => {
    vi.spyOn(apiClient, 'getCustomersAnalytics').mockResolvedValue(envelope(customerFixture() as never));
    const pending = deferred<Awaited<ReturnType<typeof apiClient.getSuppliersAnalytics>>>();
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockReturnValue(pending.promise);
    const { rerender } = render(<ExtendedAnalyticsPanel tab="customers" inventory={inventory} />);
    await screen.findByText(/Consumer Final se excluye/);
    expect(() => rerender(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />)).not.toThrow();
    expect(screen.getByRole('status').textContent).toContain('Cargando');
    await act(async () => { pending.resolve(envelope(supplierFixture() as never)); });
    expect(await screen.findByRole('button', { name: /Proveedor cinco/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves unavailable optional metrics and tolerates absent product collections in detail', async () => {
    const partial = supplierFixture();
    delete (partial.summary as Partial<typeof partial.summary>).averageLeadTime;
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope(partial as never));
    vi.spyOn(apiClient, 'getSupplierAnalytics').mockResolvedValue(envelope({ ...meta, item: { ...supplierRow, products: {} }, historyAvailability: 'INSUFFICIENT_HISTORY' } as never));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    fireEvent.click(await screen.findByRole('button', { name: /Proveedor cinco/ }));
    await screen.findByText('Productos suministrados');
    expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0);
    expect(screen.getByText('No disponible en el detalle.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a valid empty collection and rejects a malformed required supplier contract safely', async () => {
    const get = vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValueOnce(envelope({ ...supplierFixture(), items: [], total: 0 } as never)).mockResolvedValueOnce(envelope({ items: {} } as never));
    const { unmount } = render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByText('No hay proveedores para mostrar.'); unmount();
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504, 401, 403, 404, 422])('keeps HTTP %i controlled with manual retry only', async status => {
    const get = vi.spyOn(apiClient, 'getSuppliersAnalytics').mockRejectedValueOnce({ response: { status } }).mockResolvedValue(envelope(supplierFixture() as never));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByRole('alert'); expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('button', { name: /Proveedor cinco/ }); expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not retry a network timeout automatically', async () => {
    const get = vi.spyOn(apiClient, 'getSuppliersAnalytics').mockRejectedValue(new Error('network timeout'));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByRole('alert'); expect(get).toHaveBeenCalledTimes(1);
  });

  it('ignores an old period response and shows loading until the current period is ready', async () => {
    const old = deferred<Awaited<ReturnType<typeof apiClient.getSuppliersAnalytics>>>();
    const latest = deferred<Awaited<ReturnType<typeof apiClient.getSuppliersAnalytics>>>();
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValueOnce(envelope(supplierFixture() as never)).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByRole('button', { name: /Proveedor cinco/ });
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'LAST_7_DAYS' } });
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'LAST_30_DAYS' } });
    await act(async () => { latest.resolve(envelope({ ...supplierFixture(), items: [{ ...supplierRow, name: 'Resultado reciente' }] } as never)); });
    await screen.findByRole('button', { name: /Resultado reciente/ });
    await act(async () => { old.resolve(envelope({ ...supplierFixture(), items: [{ ...supplierRow, name: 'Resultado obsoleto' }] } as never)); });
    expect(screen.queryByRole('button', { name: /Resultado obsoleto/ })).toBeNull();
  });

  it('ignores a supplier list that resolves after leaving its tab', async () => {
    const pending = deferred<Awaited<ReturnType<typeof apiClient.getSuppliersAnalytics>>>();
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockReturnValue(pending.promise);
    vi.spyOn(apiClient, 'getCustomersAnalytics').mockResolvedValue(envelope(customerFixture() as never));
    const { rerender } = render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    rerender(<ExtendedAnalyticsPanel tab="customers" inventory={inventory} />);
    await screen.findByText(/Consumer Final se excluye/);
    await act(async () => { pending.resolve(envelope(supplierFixture() as never)); });
    expect(screen.queryByRole('button', { name: /Proveedor cinco/ })).toBeNull();
    expect(screen.queryByText('No se pudo mostrar la analítica de proveedores.')).toBeNull();
    expect(screen.getByText(/Consumer Final se excluye/)).toBeTruthy();
  });

  it('ignores out-of-order supplier details and pending details after a tab change', async () => {
    const first = deferred<Awaited<ReturnType<typeof apiClient.getSupplierAnalytics>>>();
    const second = deferred<Awaited<ReturnType<typeof apiClient.getSupplierAnalytics>>>();
    const third = deferred<Awaited<ReturnType<typeof apiClient.getSupplierAnalytics>>>();
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope({ ...supplierFixture(), items: [supplierRow, { ...supplierRow, supplierId: 'SUP-01', name: 'Proveedor uno' }] } as never));
    vi.spyOn(apiClient, 'getSupplierAnalytics').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    vi.spyOn(apiClient, 'getCustomersAnalytics').mockResolvedValue(envelope(customerFixture() as never));
    const { rerender } = render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    fireEvent.click(await screen.findByRole('button', { name: /Proveedor cinco/ }));
    fireEvent.click(screen.getByRole('button', { name: /Proveedor uno/ }));
    await act(async () => { second.resolve(envelope({ ...meta, item: { ...supplierRow, supplierId: 'SUP-01', name: 'Detalle vigente' } } as never)); });
    await screen.findByText('Detalle vigente');
    await act(async () => { first.resolve(envelope({ ...meta, item: { ...supplierRow, name: 'Detalle obsoleto' } } as never)); });
    expect(screen.queryByText('Detalle obsoleto')).toBeNull();
    expect(screen.getByText('Detalle vigente')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Proveedor cinco/ }));
    rerender(<ExtendedAnalyticsPanel tab="customers" inventory={inventory} />);
    await act(async () => { third.resolve(envelope({ ...meta, item: { ...supplierRow, name: 'Detalle obsoleto' } } as never)); });
    await screen.findByText(/Consumer Final se excluye/);
    expect(screen.queryByText('Detalle obsoleto')).toBeNull();
  });

  it('formats missing chart tooltip values as unavailable, never as invented zero', async () => {
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope(supplierFixture() as never));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByRole('button', { name: /Proveedor cinco/ });
    expect(chartProbe.formatters.length).toBeGreaterThan(0);
    for (const formatter of chartProbe.formatters) {
      expect(() => formatter(undefined, 'pending')).not.toThrow();
      expect(JSON.stringify(formatter(null, 'pending'))).toContain('No disponible');
    }
  });

  it('isolates a chart render failure and remounts the supplier loader on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    chartProbe.fail = true;
    const get = vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope(supplierFixture() as never));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    expect(await screen.findByText('No se pudo mostrar la analítica de proveedores.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).not.toContain('test chart failure');
    chartProbe.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('button', { name: /Proveedor cinco/ });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a module boundary leaves sibling content available', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken() { throw new Error('private error'); return null; }
    render(<><p>Resumen disponible</p><AnalyticsErrorBoundary label="proveedores"><Broken /></AnalyticsErrorBoundary></>);
    expect(screen.getByText('Resumen disponible')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).not.toContain('private error');
  });

  it('humanizes nested health metrics, real horizons and observations without placeholders', async () => {
    const metrics = { kpis: { cogsCents: 1200 }, segmentDistribution: { AT_RISK: 3 }, atRiskCount: 3, inactiveCount: 2, products: { analyzedCount: 80, unavailableCount: 0 }, summary: { available: true }, topSpendShares: null, analysisVersion: 'v1', stableCrossSellRuleCount: 33, horizons: [1, 7, 14], source: 'MOVING_AVERAGE_28' };
    const domains = Object.fromEntries(['sales', 'margin', 'customers', 'inventory', 'suppliers', 'forecast', 'marketBasket'].map(name => [name, { status: 'READY', freshness: null, metrics: name === 'forecast' ? metrics : {}, insights: [{ code: 'PRIVATE_KEY' }, { summary: 'Revisar productos con poco stock.' }] }]));
    vi.spyOn(apiClient, 'getBusinessHealth').mockResolvedValue(envelope({ ...meta, status: 'READY', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, domains, insights: [{ code: 'HIDDEN' }, { message: 'El margen requiere costos completos.' }] } as never));
    const { container } = render(<ExtendedAnalyticsPanel tab="health" inventory={inventory} />);
    await screen.findByText('Horizontes disponibles');
    expect(screen.getByText('1 día · 7 días · 14 días')).toBeTruthy();
    expect(screen.getByText('Media móvil de 28 días')).toBeTruthy();
    expect(screen.getByText('Indicadores principales · Costo de ventas')).toBeTruthy();
    expect(screen.getByText('Productos · Productos analizados')).toBeTruthy();
    expect(screen.getByText('Clientes inactivos')).toBeTruthy();
    expect(screen.getByText('Reglas estables de venta cruzada')).toBeTruthy();
    expect(screen.getByText('El margen requiere costos completos.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Kpis|Segment Distribution|Cogs Cents|At Risk Count|Hay una observación disponible|PRIVATE_KEY|0: 1|MOVING_AVERAGE_28/);
  });

  it.each([true, false])('uses contract basket names (available=%s) and keeps SKU fallback', async namesAvailable => {
    vi.spyOn(apiClient, 'getAssociations').mockResolvedValue(envelope({ ...meta, cutoff: '2026-10-12', mode: 'FROZEN', available: true, total: 1, items: [{ antecedent: ['PAN-FRE-001'], consequent: ['DES-LEC-001'], antecedentProducts: namesAvailable ? ['Pan francés fresco'] : [], consequentProducts: namesAvailable ? ['Leche evaporada'] : [], support: .02, confidence: .2, lift: 1.5, ticketCount: 20, stability: 'STABLE' }] } as never));
    vi.spyOn(apiClient, 'getRelatedProducts').mockResolvedValue(envelope({ ...meta, mode: 'FROZEN', cutoff: '2026-10-12', sourceProduct: { sku: 'PAN-FRE-001', name: 'Pan' }, available: false, items: [] } as never));
    render(<ExtendedAnalyticsPanel tab="related" inventory={inventory} />);
    await screen.findByText('SKU: PAN-FRE-001 → DES-LEC-001');
    if (namesAvailable) expect(screen.getByText(/Pan francés fresco/)).toBeTruthy();
    else expect(screen.getAllByText(/PAN-FRE-001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Confianza').length).toBeGreaterThan(0);
  });
});

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
    await waitFor(() => expect(screen.getAllByText(/FROZEN · cutoff 2026-10-12/).length).toBeGreaterThanOrEqual(2));
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
    const domains = Object.fromEntries(['sales', 'margin', 'customers', 'inventory', 'suppliers', 'forecast', 'marketBasket'].map(name => [name, { status: name === 'marketBasket' ? 'FROZEN' : 'READY', freshness: { mode: name === 'marketBasket' ? 'FROZEN' : 'LIVE', cutoff: name === 'marketBasket' ? '2026-10-12' : undefined }, metrics: name === 'sales' ? { grossMarginCents: 12345, CUSTOMER_AT_RISK_COUNT: 3, forecastSource: 'MOVING_AVERAGE_28' } : {}, insights: [] }]));
    vi.spyOn(apiClient, 'getBusinessHealth').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 0, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', status: 'PARTIAL', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, domains, insights: [] } as never));
    render(<ExtendedAnalyticsPanel tab="health" inventory={inventory} />);
    expect(await screen.findByText(/No se calcula una puntuación global/)).toBeTruthy();
    expect(screen.getByText('Productos relacionados')).toBeTruthy();
    expect(screen.getByText(/FROZEN/)).toBeTruthy();
    expect(screen.getByText('Margen bruto')).toBeTruthy();
    expect(screen.getByText('Clientes en riesgo')).toBeTruthy();
    expect(screen.getByText('Media móvil de 28 días')).toBeTruthy();
    expect(screen.queryByText('grossMarginCents')).toBeNull();
    expect(screen.queryByText('CUSTOMER_AT_RISK_COUNT')).toBeNull();
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
    expect(screen.getAllByText('Soporte').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Lift').length).toBeGreaterThan(0);
    expect(screen.getAllByText('207').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FROZEN · cutoff 2026-10-12').length).toBeGreaterThan(0);
  });
});
