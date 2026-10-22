import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
import { SalesImpactPanel } from '@/components/business-intelligence/SalesImpactPanel';
import { publishCompletedSaleImpact, readLatestSalesImpact, SALES_IMPACT_SESSION_KEY } from '@/lib/salesImpactChannel';
import { captureSalesImpactSnapshot, isSalesImpactEvent, makeSalesImpactEvent, waitForSalesImpactBefore, type SalesImpactSnapshot } from '@/lib/salesImpactSnapshot';
import { provisionalFixture } from './fixtures/salesProvisional';
import type { SalesProvisionalEvaluation } from '@/types/salesAnomalies';

const context = { businessId: 'MINIMARKET-PASCO-V3', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'dataset-v3' };
const revision = { success: true, data: { ...context, asOf: '2026-10-20', dataVersion: '184' } };
const analytics = (overrides: Partial<SalesProvisionalEvaluation> = {}) => ({ success: true, data: provisionalFixture(overrides) });
const snapshot = (values: Partial<SalesImpactSnapshot> = {}): SalesImpactSnapshot => ({
  period: { startDate: '2026-10-20', endDate: '2026-10-20' }, dataVersion: 184,
  revenue: { value: 45, currency: 'PEN' }, units: 4, tickets: 2, averageTicket: { value: 22.5, currency: 'PEN' },
  grossMarginAmount: null, grossMarginPercent: null,
  costCoverage: { knownSaleLines: 3, unknownSaleLines: 1, status: 'PARTIAL' }, ...values,
});
const event = (before: SalesImpactSnapshot | null, after: SalesImpactSnapshot | null) => makeSalesImpactEvent({
  businessContext: context, transactionId: 'sale-1', occurredAt: '2026-10-20T10:00:00Z',
  saleTotal: { value: 12, currency: 'PEN' }, before, after,
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.removeItem(SALES_IMPACT_SESSION_KEY); vi.useRealTimers(); });

describe('SalesImpact temporal commercial comparison', () => {
  it('captures the existing TODAY sales summary without inventing missing margin', async () => {
    const get = vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockResolvedValue(analytics() as never);
    const result = await captureSalesImpactSnapshot();
    expect(get).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ revenue: { value: 45, currency: 'PEN' }, units: 4, tickets: 2,
      averageTicket: { value: 22.5, currency: 'PEN' }, grossMarginAmount: null, grossMarginPercent: null,
      costCoverage: { knownSaleLines: 3, unknownSaleLines: 1 } });
  });

  it('preserves valid margin and amount from the contract when cost coverage is available', async () => {
    vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockResolvedValue(analytics({ commercial: {
      grossMargin: { value: 18, currency: 'PEN', percent: 40, availability: 'AVAILABLE' },
      costCoverage: { knownSaleLines: 4, unknownSaleLines: 0, status: 'AVAILABLE' },
    } }) as never);
    expect(await captureSalesImpactSnapshot()).toMatchObject({ grossMarginAmount: { value: 18, currency: 'PEN' }, grossMarginPercent: 40 });
  });

  it('bounds a slow BEFORE capture so analytic latency cannot hold the sale flow indefinitely', async () => {
    vi.useFakeTimers();
    let resolve!: (value: SalesImpactSnapshot | null) => void;
    const capture = new Promise<SalesImpactSnapshot | null>(done => { resolve = done; });
    const waiting = waitForSalesImpactBefore(capture);
    let saleCanContinue = false;
    void waiting.then(() => { saleCanContinue = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(saleCanContinue).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBeNull();
    expect(saleCanContinue).toBe(true);
    resolve(snapshot());
  });

  it('keeps the completed sale successful when AFTER analytics fails', async () => {
    vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockRejectedValue(new Error('temporary analytics failure'));
    publishCompletedSaleImpact({ businessContext: context, transactionId: 'sale-1', occurredAt: '2026-10-20T10:00:00Z',
      saleTotal: { value: 12, currency: 'PEN' }, before: snapshot() });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(readLatestSalesImpact()?.captureStatus).toBe('AFTER_UNAVAILABLE');
    expect(readLatestSalesImpact()?.before?.revenue?.value).toBe(45);
  });

  it('continues after a failed BEFORE analytics capture', async () => {
    vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockRejectedValue(new Error('temporary analytics failure'));
    const before = await waitForSalesImpactBefore(captureSalesImpactSnapshot());
    const saleSubmitted = true;
    expect(before).toBeNull();
    expect(saleSubmitted).toBe(true);
  });

  it('records one multi-SKU ticket and uses aggregate units from before/after snapshots', async () => {
    const before = snapshot({ revenue: { value: 100, currency: 'PEN' }, units: 10, tickets: 4 });
    const after = snapshot({ revenue: { value: 133, currency: 'PEN' }, units: 13, tickets: 5 });
    const saved = event(before, after);
    expect(isSalesImpactEvent(saved)).toBe(true);
    expect(saved.transactionId).toBe('sale-1');
    if (!saved.before || !saved.after) throw new Error('Expected both sales snapshots');
    expect(saved.before.units).toBe(10); expect(saved.after.units).toBe(13);
    expect(saved.after.tickets! - saved.before.tickets!).toBe(1);
    expect(saved.after.units! - saved.before.units!).toBe(3);
  });

  it('captures quantity N as units while retaining a single ticket increase', () => {
    const saved = event(snapshot({ units: 2, tickets: 8 }), snapshot({ units: 5, tickets: 9 }));
    if (!saved.before || !saved.after) throw new Error('Expected both sales snapshots');
    expect(saved.after.units! - saved.before.units!).toBe(3);
    expect(saved.after.tickets! - saved.before.tickets!).toBe(1);
  });

  it('publishes the pending sale event immediately and then updates it with AFTER without polling', async () => {
    vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockResolvedValueOnce(analytics() as never);
    publishCompletedSaleImpact({ businessContext: context, transactionId: 'sale-1', occurredAt: '2026-10-20T10:00:00Z',
      saleTotal: { value: 12, currency: 'PEN' }, before: snapshot() });
    expect(readLatestSalesImpact()?.captureStatus).toBe('AFTER_PENDING');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(readLatestSalesImpact()?.captureStatus).toBe('COMPLETE');
    expect(apiClient.getSalesImpactAnalytics).toHaveBeenCalledTimes(1);
  });

  it('keeps sale B when overlapping AFTER captures resolve in reverse order', async () => {
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    vi.spyOn(apiClient, 'getSalesImpactAnalytics')
      .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }) as never)
      .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }) as never);
    publishCompletedSaleImpact({ businessContext: context, transactionId: 'sale-A', occurredAt: '2026-10-22T10:00:00Z',
      saleTotal: { value: 10, currency: 'PEN' }, before: null });
    publishCompletedSaleImpact({ businessContext: context, transactionId: 'sale-B', occurredAt: '2026-10-22T10:01:00Z',
      saleTotal: { value: 20, currency: 'PEN' }, before: null });
    resolveB(analytics());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(readLatestSalesImpact()?.transactionId).toBe('sale-B');
    expect(readLatestSalesImpact()?.after).not.toBeNull();
    resolveA(analytics());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(readLatestSalesImpact()?.transactionId).toBe('sale-B');
    expect(readLatestSalesImpact()?.saleTotal?.value).toBe(20);
  });

  it('uses at most two sales analytics captures for a completed sale and none to create an event on panel mount', async () => {
    const get = vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockResolvedValueOnce(analytics() as never).mockResolvedValueOnce(analytics() as never);
    const before = await captureSalesImpactSnapshot();
    publishCompletedSaleImpact({ businessContext: context, transactionId: 'sale-2', occurredAt: '2026-10-20T11:00:00Z',
      saleTotal: { value: 12, currency: 'PEN' }, before });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(2);
    get.mockClear();
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision as never);
    render(<SalesImpactPanel />);
    expect(get).not.toHaveBeenCalled();
  });

  it('shows a compact empty state and makes no analytics/revision calls or polling', () => {
    vi.useFakeTimers();
    const sales = vi.spyOn(apiClient, 'getSalesImpactAnalytics');
    const revisionRead = vi.spyOn(apiClient, 'getIntelligenceRevision');
    render(<SalesImpactPanel />);
    expect(screen.getByText(/Sin una venta reciente para comparar/)).toBeTruthy();
    expect(sales).not.toHaveBeenCalled(); expect(revisionRead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders verified commercial deltas and explicitly separates frozen Isolation Forest', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision as never);
    vi.spyOn(apiClient, 'getSalesImpactAnalytics');
    const before = snapshot({ revenue: { value: 33, currency: 'PEN' }, units: 3, tickets: 1, averageTicket: { value: 33, currency: 'PEN' }, grossMarginAmount: { value: 10, currency: 'PEN' }, grossMarginPercent: 30 });
    const after = snapshot({ revenue: { value: 45, currency: 'PEN' }, units: 4, tickets: 2, averageTicket: { value: 22.5, currency: 'PEN' }, grossMarginAmount: { value: 18, currency: 'PEN' }, grossMarginPercent: 40 });
    sessionStorage.setItem(SALES_IMPACT_SESSION_KEY, JSON.stringify(event(before, after)));
    render(<SalesImpactPanel />);
    expect(await screen.findByText(/33.*45/)).toBeTruthy();
    expect(screen.getByText('3 → 4')).toBeTruthy();
    expect(screen.getByText('1 → 2')).toBeTruthy();
    expect(screen.getByText(/10.*30%.*18.*40%/)).toBeTruthy();
    expect(screen.getByText(/El modelo permanece congelado/)).toBeTruthy();
    expect(apiClient.getSalesImpactAnalytics).not.toHaveBeenCalled();
  });

  it('does not show incomplete margin as a total and keeps its cost coverage visible', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision as never);
    sessionStorage.setItem(SALES_IMPACT_SESSION_KEY, JSON.stringify(event(snapshot(), snapshot())));
    render(<SalesImpactPanel />);
    expect(await screen.findByText('Antes: Costos registrados para 3 de 4 líneas. Después: Costos registrados para 3 de 4 líneas.')).toBeTruthy();
    expect(screen.getByText('No disponible')).toBeTruthy();
    expect(screen.queryByText(/18,00/)).toBeNull();
  });

  it('preserves the event after temporary context verification failure and has no automatic polling', async () => {
    vi.useFakeTimers();
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockRejectedValue(new Error('temporary 429'));
    const saved = event(snapshot(), snapshot());
    sessionStorage.setItem(SALES_IMPACT_SESSION_KEY, JSON.stringify(saved));
    render(<SalesImpactPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(readLatestSalesImpact()?.transactionId).toBe('sale-1');
    expect(apiClient.getIntelligenceRevision).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(apiClient.getIntelligenceRevision).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar verificación' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiClient.getIntelligenceRevision).toHaveBeenCalledTimes(2);
  });
});
