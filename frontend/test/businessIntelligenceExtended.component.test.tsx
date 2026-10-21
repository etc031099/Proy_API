import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Profiler } from 'react';
import { apiClient } from '@/lib/api';
import { ExtendedAnalyticsPanel, healthEntries } from '@/components/business-intelligence/ExtendedAnalyticsPanel';
import type { InventorySummary } from '@/types/businessIntelligence';
import { AnalyticsErrorBoundary } from '@/components/business-intelligence/AnalyticsErrorBoundary';

const chartProbe = vi.hoisted(() => ({ fail: false, formatters: [] as Array<(value: unknown, name: string) => unknown>, barData: [] as unknown[][] }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null, BarChart: ({ children, data }: { children: React.ReactNode; data?: unknown[] }) => { if (chartProbe.fail) throw new Error('test chart failure'); if (data) chartProbe.barData.push(data); return <div>{children}</div>; },
  CartesianGrid: () => null, Cell: () => null, Tooltip: ({ formatter }: { formatter: (value: unknown, name: string) => unknown }) => { chartProbe.formatters.push(formatter); return null; }, XAxis: () => null, YAxis: () => null,
  Line: () => null, LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.removeItem('token'); apiClient.invalidateIntelligenceReads(); });
beforeEach(() => {
  chartProbe.fail = false; chartProbe.formatters = []; chartProbe.barData = [];
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
  it('shows Top 10 customers then expands only the already loaded rows', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ customerId: `CUS-${index}`, displayName: `Cliente cargado ${index + 1}`,
      segment: 'POTENTIAL', recency: 1, frequency: 2, monetary: { value: 20, currency: 'PEN' } }));
    const get = vi.spyOn(apiClient, 'getCustomersAnalytics').mockResolvedValue(envelope({ ...customerFixture(), items, total: 40 } as never));
    render(<ExtendedAnalyticsPanel tab="customers" inventory={inventory} />);
    await screen.findByRole('heading', { name: 'Segmentación RFM actual' });
    expect(screen.getAllByRole('button', { name: /Cliente cargado/ })).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos los clientes cargados' }));
    expect(screen.getAllByRole('button', { name: /Cliente cargado/ })).toHaveLength(12);
    expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar Top 10' }));
    expect(screen.getAllByRole('button', { name: /Cliente cargado/ })).toHaveLength(10);
  });
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

  it('explains that global lead time is not exposed while retaining per-supplier observations', async () => {
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope({
      ...supplierFixture(), summary: { ...supplierFixture().summary, averageLeadTime: { days: null, sampleSize: null, status: 'NOT_EXPOSED_BY_ENGINE' } },
      items: [{ ...supplierRow, name: 'Horizonte Abastos', leadTime: { averageDays: 6.54, sampleSize: 7 }, punctuality: { onTimeRatePct: 77.94 } }],
    } as never));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByRole('button', { name: /Horizonte Abastos/ });
    expect(screen.getByText('El motor no expone un promedio global; los tiempos observados disponibles se muestran por proveedor.')).toBeTruthy();
    expect(screen.getByText('Proveedores')).toBeTruthy();
    expect(screen.getByText('Pedidos pendientes')).toBeTruthy();
    expect(screen.getByText('Pedidos recibidos')).toBeTruthy();
    expect(screen.getByText('Gasto recibido')).toBeTruthy();
    expect(screen.getByText('Lead time promedio')).toBeTruthy();
    expect(screen.getAllByText(/6[,.]54 días/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/77[,.]94%/).length).toBeGreaterThan(0);
    expect(screen.getByText('OPERACIONAL')).toBeTruthy();
    expect(screen.getByText(/no utiliza un modelo ML propio/i)).toBeTruthy();
  });

  it('shows up to five deterministic operational attention entries using only observed signals', async () => {
    const items = [
      { ...supplierRow, supplierId: 'SUP-01', name: 'Proveedor 1', pending: 7, received: 20, leadTime: { averageDays: 6.54 }, punctuality: { onTimeRatePct: 77.94 } },
      { ...supplierRow, supplierId: 'SUP-02', name: 'Proveedor 2', pending: 5, received: 20, leadTime: { averageDays: 8 }, punctuality: { onTimeRatePct: 80 } },
      { ...supplierRow, supplierId: 'SUP-03', name: 'Proveedor 3', pending: 4, received: 20, leadTime: null, punctuality: { onTimeRatePct: 90 } },
      { ...supplierRow, supplierId: 'SUP-04', name: 'Proveedor 4', pending: 3, received: 20, leadTime: null, punctuality: null },
      { ...supplierRow, supplierId: 'SUP-05', name: 'Proveedor 5', pending: 2, received: 20, leadTime: null, punctuality: null },
      { ...supplierRow, supplierId: 'SUP-06', name: 'Proveedor 6', pending: 0, received: 20, leadTime: { averageDays: 0 }, punctuality: { onTimeRatePct: 100 } },
      { ...supplierRow, supplierId: 'SUP-07', name: 'Proveedor 7', pending: null, received: 20, leadTime: null, punctuality: null },
    ];
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope({ ...supplierFixture(), items, total: items.length } as never));
    const { container } = render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByText('Proveedores que requieren atención');
    const attention = container.querySelector('#supplier-attention-title')?.closest('section')?.textContent || '';
    expect(attention).toContain('Proveedor 1');
    expect(attention).toMatch(/7 pendientes · 6[,.]54 días de entrega · 77[,.]94% puntualidad/);
    expect(attention).not.toContain('Proveedor 6');
    expect(attention).not.toContain('Proveedor 7');
    expect(container.querySelector('#supplier-attention-title')?.closest('section')?.querySelectorAll('ul li')).toHaveLength(5);
    expect(container.textContent).not.toMatch(/riesgo ML|predicción de proveedores|score de proveedores|proveedor crítico/i);
  });

  it('uses an honest pending/received proportion and omits rows with unknown counts', async () => {
    const items = [
      { ...supplierRow, supplierId: 'SUP-01', name: 'Proporción conocida', pending: 7, received: 93, leadTime: { averageDays: 3 }, punctuality: { onTimeRatePct: 90 } },
      { ...supplierRow, supplierId: 'SUP-02', name: 'Conteo incompleto', pending: 3, received: null },
      { ...supplierRow, supplierId: 'SUP-03', name: 'Sin pedidos', pending: 0, received: 0 },
    ];
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope({ ...supplierFixture(), items, total: items.length } as never));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByText('Proporción de pedidos por proveedor');
    const complianceGrid = screen.getByRole('heading', { name: 'Cumplimiento operativo' }).parentElement?.children[1] as HTMLElement;
    expect(complianceGrid.children[2]?.className).toContain('xl:col-span-2');
    const proportion = chartProbe.barData.find(rows => rows.some(row => !!row && typeof row === 'object' && 'pendingCount' in row));
    expect(proportion).toEqual([expect.objectContaining({ name: 'Proporción conocida', pending: 7, received: 93, pendingCount: 7, receivedCount: 93 })]);
    expect(screen.getByText(/solo proveedores con ambos conteos conocidos/i)).toBeTruthy();
    expect(screen.getByText('Menor tiempo de entrega implica mayor rapidez operativa.')).toBeTruthy();
    expect(screen.getByText('Mayor porcentaje implica mayor cumplimiento de entrega.')).toBeTruthy();
  });

  it('shows six suppliers first and expands only loaded rows without another request', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...supplierRow, supplierId: `SUP-${index + 1}`, name: `Proveedor cargado ${index + 1}`,
      pending: 0, received: 0, leadTime: { averageDays: 0 }, punctuality: { onTimeRatePct: 100 },
    }));
    const get = vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope({ ...supplierFixture(), items, total: 40 } as never));
    const { container } = render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    await screen.findByText('Listado de proveedores');
    const table = container.querySelector('table');
    expect(table?.className).toContain('xl:table');
    expect(table?.querySelector('tbody')?.className).toContain('block');
    expect(Array.from(table?.querySelectorAll('th') || []).map(header => header.textContent)).toEqual([
      'Proveedor', 'Gasto', 'Pedidos', 'Pendientes', 'Recibidos', 'Lead time', 'Puntualidad',
    ]);
    expect(container.textContent).toContain('Proveedor cargado 6');
    expect(container.textContent).not.toContain('Proveedor cargado 7');
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos los proveedores' }));
    expect(container.textContent).toContain('Proveedor cargado 12');
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('columnheader', { name: 'Historial' })).toBeNull();
    expect(container.textContent).toContain('Ver detalle');
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
    const healthMetrics: Record<string, Record<string, unknown>> = {
      sales: { kpis: { revenueCents: 120000, tickets: 8 } },
      margin: { classificationMethod: 'relative product percentiles: revenue p75/p25 and gross-margin-rate p25/p75; no net-profit claim' },
      customers: { segmentDistribution: { AT_RISK: 3 }, atRiskCount: 3 },
      inventory: { riskUnavailableCount: 0, products: { analyzedCount: 80, unavailableCount: 0 } },
      suppliers: { criticalInventoryExposure: { singleSourceCriticalOrHighSkuCount: 7, meaning: 'business exposure due to inventory risk plus a single configured supplier; not a supplier-failure prediction' } },
      forecast: metrics,
      marketBasket: { usefulRuleCount: 33, analysisVersion: 'm6.7-v1' },
    };
    const domains = Object.fromEntries(Object.entries(healthMetrics).map(([name, domainMetrics]) => [name, { status: 'READY', freshness: null, metrics: domainMetrics, insights: [{ code: 'PRIVATE_KEY' }, { summary: 'Revisar productos con poco stock.' }] }]));
    vi.spyOn(apiClient, 'getBusinessHealth').mockResolvedValue(envelope({ ...meta, status: 'READY', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, domains, insights: [{ code: 'HIDDEN' }, { message: 'El margen requiere costos completos.' }] } as never));
    const { container } = render(<ExtendedAnalyticsPanel tab="health" inventory={inventory} />);
    expect((await screen.findAllByText('Horizontes disponibles')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('7 y 14 días').length).toBeGreaterThan(0);
    expect(screen.queryByText('1 día · 7 días · 14 días')).toBeNull();
    expect(screen.getAllByText('Media móvil de 28 días').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Indicadores principales · Costo de ventas').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Productos · Productos analizados').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Clientes inactivos').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reglas estables de venta cruzada').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Percentiles relativos de ingresos (p75/p25) y margen bruto (p25/p75); no representa utilidad neta.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Productos con riesgo crítico · Productos de riesgo alto/crítico con proveedor único').length).toBeGreaterThan(0);
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    expect(screen.getByText('El margen requiere costos completos.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Kpis|Segment Distribution|Cogs Cents|At Risk Count|Indicador adicional|Hay una observación disponible|PRIVATE_KEY|relative product percentiles|business exposure due|0: 1|MOVING_AVERAGE_28/);
  });

  it.each([true, false])('uses contract basket names (available=%s) and keeps SKU fallback', async namesAvailable => {
    vi.spyOn(apiClient, 'getAssociations').mockResolvedValue(envelope({ ...meta, cutoff: '2026-10-12', mode: 'FROZEN', summary: { analysisVersion: 'MINIMARKET-PASCO-V3-MBA-v1' }, available: true, total: 1, items: [{ antecedent: ['PAN-FRE-001'], consequent: ['DES-LEC-001'], antecedentProducts: namesAvailable ? ['Pan francés fresco'] : [], consequentProducts: namesAvailable ? ['Leche evaporada'] : [], support: .02, confidence: .2, lift: 1.5, ticketCount: 20, stability: 'STABLE' }] } as never));
    vi.spyOn(apiClient, 'getRelatedProducts').mockResolvedValue(envelope({ ...meta, mode: 'FROZEN', cutoff: '2026-10-12', sourceProduct: { sku: 'PAN-FRE-001', name: 'Pan' }, available: false, items: [] } as never));
    render(<ExtendedAnalyticsPanel tab="related" inventory={inventory} />);
    await screen.findByText('SKU: PAN-FRE-001 → DES-LEC-001');
    expect(screen.getByText('Versión: MINIMARKET-PASCO-V3-MBA-v1')).toBeTruthy();
    expect(screen.getByText('Reglas de asociación históricas')).toBeTruthy();
    expect(apiClient.getRelatedProducts).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Producto relacionado' }), { target: { value: 'PAN-FRE-001' } });
    await waitFor(() => expect(apiClient.getRelatedProducts).toHaveBeenCalledTimes(1));
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
    expect(apiClient.getRelatedProducts).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Producto relacionado' }), { target: { value: 'PAN-FRE-001' } });
    await waitFor(() => expect(screen.getAllByText(/FROZEN · cutoff 2026-10-12/).length).toBeGreaterThan(0));
    expect(await screen.findByText('El análisis histórico no tiene reglas disponibles.')).toBeTruthy();
    expect(await screen.findByText('El análisis histórico no tiene recomendaciones disponibles.')).toBeTruthy();
    expect(apiClient.getRelatedProducts).toHaveBeenCalledWith('PAN-FRE-001');
  });

  it('shows compact sales performance, only active categories, and at most eight ranked products', async () => {
    const topProducts = Array.from({ length: 10 }, (_, index) => ({ name: `Producto ${index + 1}`, sku: `SKU-${index + 1}`, revenue: { value: 100 - index, currency: 'PEN' }, units: 1 }));
    const get = vi.spyOn(apiClient, 'getSalesAnalytics').mockResolvedValue(envelope({ ...meta, period: { startDate: '2026-10-14', endDate: '2026-10-14' }, comparisonPeriod: null,
      summary: { revenue: { value: 250, currency: 'PEN' }, units: 8, tickets: 4, averageTicket: { value: 62.5, currency: 'PEN' }, grossMargin: { value: null, currency: null, percent: null, availability: 'PARTIAL', costCoverage: { knownSaleLines: 3, unknownSaleLines: 2, status: 'PARTIAL' } } },
      grossMarginAvailability: 'PARTIAL', variation: null, comparisonAvailability: null, series: [], seriesStatus: 'READY',
      rankings: { topProducts, topCategories: [{ category: 'Con actividad', revenue: { value: 40, currency: 'PEN' } }, { category: 'Sin ventas', revenue: { value: 0, currency: 'PEN' } }, { category: 'Sin dato', revenue: null }] } } as never));
    render(<ExtendedAnalyticsPanel tab="sales" inventory={inventory} />);
    expect(await screen.findByText('Rendimiento del periodo')).toBeTruthy();
    expect(screen.getByLabelText('Impacto comercial de la última venta')).toBeTruthy();
    expect(screen.getByText('Distribución comercial')).toBeTruthy();
    expect(screen.getByLabelText('Impacto comercial de la última venta').compareDocumentPosition(screen.getByText('Distribución comercial')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('No disponible')).toBeTruthy();
    expect(screen.getByText('Costos disponibles para 3 de 5 líneas de venta.')).toBeTruthy();
    await waitFor(() => expect(chartProbe.barData.length).toBe(2));
    expect(chartProbe.barData[0]).toHaveLength(8);
    expect(chartProbe.barData[1]).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(apiClient.getSalesAnomalies).toHaveBeenCalledTimes(1);
  });

  it('shows a complete gross margin amount and percentage only when coverage is available', async () => {
    vi.spyOn(apiClient, 'getSalesAnalytics').mockResolvedValue(envelope({ ...meta, period: { startDate: '2026-10-14', endDate: '2026-10-14' }, comparisonPeriod: null,
      summary: { revenue: { value: 100, currency: 'PEN' }, units: 2, tickets: 1, averageTicket: { value: 100, currency: 'PEN' }, grossMargin: { value: 35, currency: 'PEN', percent: 35, availability: 'AVAILABLE', costCoverage: { knownSaleLines: 2, unknownSaleLines: 0, status: 'AVAILABLE' } } },
      grossMarginAvailability: 'AVAILABLE', variation: null, comparisonAvailability: null, series: [], seriesStatus: 'READY', rankings: { topProducts: [], topCategories: [] } } as never));
    render(<ExtendedAnalyticsPanel tab="sales" inventory={inventory} />);
    expect(await screen.findByText(/35[.,]00/)).toBeTruthy();
    expect(screen.getByText(/35%/)).toBeTruthy();
    expect(screen.queryByText('No disponible')).toBeNull();
  });

  it('loads customer detail only after selecting a real result reference', async () => {
    const row = { customerId: 'CUS-01', displayName: 'Cliente Uno', segment: 'LOYAL', recency: 1, frequency: 4, monetary: null, spend: null, lifetimeTicketCount: 4, rfm90d: null, averageTicket: null, lastPurchaseDate: null, firstPurchaseDate: null, reasonCodes: [], preferences: null, trends: null, windows: null, freshness: null };
    const list = vi.spyOn(apiClient, 'getCustomersAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 1, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', summary: { totalRegistered: 1, active: 1, new: 0, inactive: 0, atRisk: 0, highValue: 0, potential: 0, segments: { LOYAL: 1 }, consumerFinalIncludedInIndividualRfm: false }, items: [row], total: 1, limit: 20, offset: 0 } as never));
    const detail = vi.spyOn(apiClient, 'getCustomerAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 1, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', status: 'READY', item: row, historyAvailability: 'AVAILABLE' } as never));
    render(<ExtendedAnalyticsPanel tab="customers" inventory={inventory} />);
    await screen.findByText(/Consumer Final se excluye de la segmentación individual/);
    const customerImpact = screen.getByText('Impacto de la última venta en el cliente');
    const rfmSegments = screen.getByText('Segmentos de clientes');
    expect(customerImpact.compareDocumentPosition(rfmSegments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cliente Uno/ }));
    expect(await screen.findByText('Gasto registrado')).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    expect(detail).toHaveBeenCalledWith('CUS-01');
  });

  it('loads supplier detail by the selected stable reference and preserves null availability', async () => {
    const row = { supplierId: 'SUP-05', name: 'Proveedor cinco', orders: 3, spend: null, pending: 1, received: 2, leadTime: null, punctuality: null, leadTimeAvailability: 'INSUFFICIENT_HISTORY', dependency: {}, products: [], status: 'PARTIAL' };
    vi.spyOn(apiClient, 'getSuppliersAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 1, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, summary: { totalSuppliers: 1, totalSpend: null, pendingOrders: 1, receivedOrders: 2, dependency: null, averageLeadTime: { days: null, sampleSize: null, status: 'NOT_EXPOSED_BY_ENGINE' } }, items: [row], total: 1, limit: 20, offset: 0 } as never));
    const detail = vi.spyOn(apiClient, 'getSupplierAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 1, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', status: 'PARTIAL', item: { ...row, costTrends: null, historyAvailability: 'NOT_EXPOSED_BY_ENGINE' }, historyAvailability: 'NOT_EXPOSED_BY_ENGINE' } as never));
    render(<ExtendedAnalyticsPanel tab="suppliers" inventory={inventory} />);
    fireEvent.click(await screen.findByRole('button', { name: /Proveedor cinco/ }));
    expect(await screen.findByText('Productos suministrados')).toBeTruthy();
    expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0);
    expect(screen.getByText('Historial: No disponible')).toBeTruthy();
    expect(screen.queryByText(/not exposed by engine/i)).toBeNull();
    expect(detail).toHaveBeenCalledWith('SUP-05');
  });

  it('organizes Health into an executive status, attention, advanced analytics and operational domains', async () => {
    const names = ['sales', 'margin', 'customers', 'inventory', 'suppliers', 'forecast', 'marketBasket'] as const;
    const status: Record<string, string> = { sales: 'READY', margin: 'UNAVAILABLE', customers: 'PARTIAL', inventory: 'PARTIAL', suppliers: 'READY', forecast: 'AVAILABLE', marketBasket: 'AVAILABLE' };
    const metrics: Record<string, Record<string, unknown>> = {
      sales: { kpis: { revenueCents: 12345, unitsSold: 8, ticketCount: 4, averageTicketCents: 3086 }, trends: { revenue: { percentChange: 12 } }, forecastSource: 'MOVING_AVERAGE_28' },
      margin: { grossMarginCents: null, grossMarginPct: null, cogsCents: null, reasonCode: 'COST_COVERAGE_INCOMPLETE' },
      customers: { registeredCustomerCount: 12, atRiskCount: 3, inactiveCount: 2, newCount: 1 },
      inventory: { totalProducts: 80, analyzedCount: 79, lowStock: 8, forecastAvailability: 'PARTIAL', forecastExpectedUnitsNext1d: 15, forecastHorizons: [1, 7, 14] },
      suppliers: { summary: { totalSuppliers: 5, pendingOrders: 2, receivedOrders: 8, receivedSpendCents: 45000 } },
      forecast: { source: 'RIDGE_CAUSAL27', horizons: [7, 14], knownCount: 78, missingCount: 2 },
      marketBasket: { available: true, analysisVersion: 'FP-GROWTH-v1', sourceArtifactCutoff: '2026-10-12', stableCrossSellRuleCount: 6, usefulRuleCount: 9 },
    };
    const domains = Object.fromEntries(names.map(name => [name, { status: status[name], freshness: { mode: name === 'marketBasket' ? 'FROZEN' : 'LIVE', cutoff: name === 'marketBasket' ? '2026-10-12' : undefined }, metrics: metrics[name], insights: [] }]));
    const get = vi.spyOn(apiClient, 'getBusinessHealth').mockResolvedValue(envelope({ ...meta, updatedAt: '2026-10-14T18:30:00Z', dataVersion: 83, engineVersion: 'health-v3', source: 'LIVE', status: 'PARTIAL', period: { startDate: '2026-10-14', endDate: '2026-10-14' }, domains, insights: [{ code: 'CROSS_SELL_OPPORTUNITIES', summary: 'Historical stable associations.' }] } as never));
    render(<ExtendedAnalyticsPanel tab="health" inventory={inventory} />);
    expect(await screen.findByText('Estado general del sistema analítico')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Estado general' })).getByText('Parcial')).toBeTruthy();
    expect(screen.getByText(/Componentes disponibles: 4 · parciales: 2 · no disponibles: 1/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Requiere atención' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Modelos y analítica avanzada' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Capas operacionales' })).toBeTruthy();
    expect(screen.getByText('Pronóstico Ridge')).toBeTruthy();
    expect(screen.getByText('FP-Growth · reglas de asociación')).toBeTruthy();
    expect(screen.getAllByText('RIDGE_CAUSAL27').length).toBeGreaterThan(0);
    expect(screen.getAllByText('7 y 14 días').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Histórico/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Las reglas describen asociaciones históricas; no implican causalidad/)).toBeTruthy();
    expect(screen.getByText(/no incluye estados independientes de K-Means o Isolation Forest/)).toBeTruthy();
    expect(screen.getAllByText(/Costos disponibles|cobertura de costos/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Modelos y analítica avanzada' }).querySelector('div.grid')?.className).toContain('grid-cols-1');
    expect(get).toHaveBeenCalledTimes(1);
    expect(apiClient.getCustomerClustering).not.toHaveBeenCalled();
    expect(apiClient.getSalesAnomalies).not.toHaveBeenCalled();
    const inventoryCard = screen.getByRole('heading', { name: 'Inventario' }).closest('article');
    expect(inventoryCard).toBeTruthy();
    fireEvent.click(within(inventoryCard!).getByText('Ver detalles'));
    expect(screen.getByText(/El dato de 1 día se conserva como referencia contractual histórica/)).toBeTruthy();
    fireEvent.click(screen.getByText('Ver diagnóstico completo'));
    expect(screen.queryByText('Códigos técnicos de bloqueo')).toBeNull();
  });

  it.each([
    ['READY', 'Disponible'], ['PARTIAL', 'Parcial'], ['UNAVAILABLE', 'No disponible'],
  ])('uses the contractual overall state %s without a score', async (overall, label) => {
    const domains = Object.fromEntries(['sales', 'margin', 'customers', 'inventory', 'suppliers', 'forecast', 'marketBasket'].map(name => [name, { status: overall, freshness: null, metrics: {}, insights: [] }]));
    vi.spyOn(apiClient, 'getBusinessHealth').mockResolvedValue(envelope({ ...meta, dataVersion: null, source: 'LIVE', engineVersion: null, status: overall, period: { startDate: '2026-10-14', endDate: '2026-10-14' }, domains, insights: [] } as never));
    render(<ExtendedAnalyticsPanel tab="health" inventory={inventory} />);
    expect(await screen.findByText('Estado general del sistema analítico')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Estado general' })).getByText(label)).toBeTruthy();
    expect(screen.queryByText(/score de salud|puntuación global/i)).toBeNull();
    if (overall === 'PARTIAL') expect(screen.getByRole('heading', { name: 'Requiere atención' })).toBeTruthy();
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
    expect(await screen.findByText(/Si falta cobertura, no se presenta un total/)).toBeTruthy();
    fireEvent.mouseLeave(help.parentElement!);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    fireEvent.click(help);
    expect(await screen.findByText(/Si falta cobertura, no se presenta un total/)).toBeTruthy();
  });

  it('renders RFM columns and uses human names with secondary SKU for frozen basket rules', async () => {
    const customer = { customerId: 'CUS-1', displayName: 'María Pérez', segment: 'TOP_HIGH_VALUE', recency: 2, frequency: 5, monetary: { value: 120, currency: 'PEN' }, spend: { value: 150, currency: 'PEN' }, lifetimeTicketCount: 8, rfm90d: {}, averageTicket: { value: 24, currency: 'PEN' }, lastPurchaseDate: '2026-10-13', firstPurchaseDate: null, reasonCodes: [], preferences: null, trends: null, windows: null, freshness: null };
    vi.spyOn(apiClient, 'getCustomersAnalytics').mockResolvedValue(envelope({ ...meta, freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null }, dataVersion: 0, snapshotHash: 'h', source: 'LIVE', engineVersion: 'v3', summary: { totalRegistered: 1, active: 1, new: 0, inactive: 0, atRisk: 0, highValue: 1, potential: 0, segments: { TOP_HIGH_VALUE: 1 }, consumerFinalIncludedInIndividualRfm: false }, items: [customer], total: 1, limit: 20, offset: 0 } as never));
    vi.spyOn(apiClient, 'getAssociations').mockResolvedValue(envelope({ ...meta, mode: 'FROZEN', freshness: { mode: 'FROZEN', cutoff: '2026-10-12' }, dataVersion: null, snapshotHash: null, source: 'M6.7', engineVersion: null, cutoff: '2026-10-12', summary: {}, available: true, items: [{ antecedent: ['A'], antecedentProducts: [{ name: 'Pan Francés', sku: 'PAN-FRE-001' }], consequent: ['B'], consequentProducts: [{ name: 'Leche Gloria', sku: 'LEC-GLO-001' }], support: 0.02, confidence: 0.2, lift: 1.59, ticketCount: 207, stability: 'STABLE', status: 'READY' }], total: 1, limit: 10, offset: 0 } as never));
    vi.spyOn(apiClient, 'getRelatedProducts').mockResolvedValue(envelope({ ...meta, mode: 'FROZEN', freshness: { mode: 'FROZEN', cutoff: '2026-10-12' }, dataVersion: null, snapshotHash: null, source: 'M6.7', engineVersion: null, cutoff: '2026-10-12', sourceProduct: { sku: 'PAN-FRE-001', name: 'Pan Francés', presentation: null }, available: true, items: [{ relatedProduct: { sku: 'LEC-GLO-001', name: 'Leche Gloria' }, support: 0.02, confidence: 0.2, lift: 1.59, ticketCount: 207, stability: 'STABLE', classification: 'CROSS_SELL' }], total: 1 } as never));
    const { rerender } = render(<ExtendedAnalyticsPanel tab="customers" inventory={inventory} />);
    expect((await screen.findAllByText('Alto valor')).length).toBeGreaterThan(0);
    expect(screen.queryByText('TOP_HIGH_VALUE')).toBeNull();
    expect(screen.getAllByText('Valor monetario').length).toBeGreaterThan(0);
    rerender(<ExtendedAnalyticsPanel tab="related" inventory={inventory} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Producto relacionado' }), { target: { value: 'PAN-FRE-001' } });
    await waitFor(() => expect(screen.getByText('Pan Francés')).toBeTruthy());
    expect(screen.getAllByText('Leche Gloria').length).toBeGreaterThan(0);
    expect(screen.getByText('SKU: PAN-FRE-001')).toBeTruthy();
    expect(screen.getAllByText('Soporte').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Lift').length).toBeGreaterThan(0);
    expect(screen.getAllByText('207').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/corte histórico 12 oct\. 2026|cutoff 2026-10-12/i).length).toBeGreaterThan(0);
  });
});

describe('FIX3 Health presentation contracts', () => {
  it('revisits real panels with revision checks and no repeated operational payloads', async () => {
    const instance = (apiClient as unknown as { instance: { get: (url: string) => Promise<unknown> } }).instance;
    localStorage.setItem('token', 'test-only-panel-session');
    const revision = { businessId: 'test-business', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'v1', dataVersion: '0', asOf: '2026-10-14' };
    const domains = { sales: { status: 'READY', metrics: { kpis: { revenueCents: 0 } }, freshness: null, insights: [] } };
    const get = vi.spyOn(instance, 'get').mockImplementation(async url => ({ data: envelope(url.endsWith('/revision') ? revision
      : url.endsWith('/customers') ? customerFixture() : url.endsWith('/suppliers') ? supplierFixture()
      : { ...meta, status: 'READY', period: { startDate: meta.asOf, endDate: meta.asOf }, domains, insights: [] }) }));
    const renders: number[] = [];
    const panel = (tab: 'customers' | 'suppliers' | 'health') => <Profiler id="navigation" onRender={(_id, _phase, duration) => renders.push(duration)}><ExtendedAnalyticsPanel tab={tab} inventory={inventory} /></Profiler>;
    const { rerender } = render(panel('customers'));
    await screen.findByText(/Consumer Final se excluye/);
    for (const tab of ['suppliers', 'health', 'customers', 'suppliers'] as const) {
      rerender(panel(tab));
      await waitFor(() => expect(screen.queryByText('Cargando analítica…')).toBeNull());
    }
    expect(get.mock.calls.filter(([url]) => !url.endsWith('/revision'))).toHaveLength(3);
    expect(get.mock.calls.filter(([url]) => url.endsWith('/revision'))).toHaveLength(8);
    const ordered = [...renders].sort((a, b) => a - b);
    console.info('FIX3 fixture render (not cloud)', JSON.stringify({ commits: renders.length, medianMs: ordered[Math.floor(ordered.length / 2)], maxMs: ordered.at(-1) }));
  });
  it('labels the remaining engine fields in natural Spanish', () => {
    const fields = { averageTicket: 12, averageDistinctSkusPerTicket: 2.5, averageUnitsPerTicket: 3,
      highRevenueLowMargin: [], lowRevenueHighMargin: [], highMarginProducts: [], incomingUnits: 858,
      lowStock: 8, shouldReorder: 26, forecastAvailability: 'AVAILABLE', abcAvailable: true, purchaseOrders: 2155 };
    expect(healthEntries(fields).map(row => row.label)).toEqual(['Ticket promedio', 'Productos distintos por ticket', 'Unidades promedio por ticket',
      'Alto ingreso y bajo margen', 'Bajo ingreso y alto margen', 'Productos con margen alto', 'Unidades por recibir', 'Productos con stock bajo',
      'Productos que requieren reposición', 'Disponibilidad del pronóstico', 'Clasificación ABC disponible', 'Órdenes de compra']);
    const supplier = healthEntries({ receivedSpendCents: 1200, committedSpendCents: 2500, pendingCommitmentCents: 1300, exposures: [1, 2] });
    expect(supplier.map(row => row.label)).toEqual(['Gasto recibido', 'Gasto comprometido', 'Compromiso pendiente', 'Productos expuestos al riesgo']);
    expect(supplier[0].value).toContain('12.00');
    expect(healthEntries({ internalUnexpectedField: 'internal text', meaning: 'metadata' })).toEqual([]);
  });
  it('removes only equal monetary aliases; preserves distinct values, zero, null and percentage units', () => {
    const rows = healthEntries({ revenue: 12.34, revenueCents: 1234, grossMargin: 0, grossMarginCents: 0, cogs: null, cogsCents: null,
      grossMarginPct: .5, averageTicket: 6.17 });
    expect(rows.filter(row => row.label === 'Ingresos')).toHaveLength(1);
    expect(rows.filter(row => row.label === 'Margen bruto')).toHaveLength(1);
    expect(rows.filter(row => row.label === 'Costo de ventas')).toHaveLength(1);
    expect(rows.find(row => row.label === 'Costo de ventas')?.value).toBe('No disponible');
    expect(rows.find(row => row.label === 'Margen bruto (%)')?.value).toBe('0.5%');
    expect(healthEntries({ revenue: 12, revenueCents: 1300 })).toHaveLength(2);
    expect(healthEntries({ trends: { revenue: { value: 1234, previousValue: 1000, absoluteChange: 234, percentChange: 23.4 } } })[0].value).toContain('12.34');
  });
});
