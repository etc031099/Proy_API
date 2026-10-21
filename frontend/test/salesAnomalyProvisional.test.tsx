import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SalesIsolationForestImpact, provisionalComparison } from '@/components/business-intelligence/SalesIsolationForestImpact';
import { provisionalFixture } from './fixtures/salesProvisional';
import { apiClient } from '@/lib/api';
import { captureSalesImpactSnapshot, makeSalesImpactEvent, waitForSalesImpactBefore, type SalesImpactSnapshot } from '@/lib/salesImpactSnapshot';
import { registerSaleWithImpact } from '@/lib/forecastImpactSnapshot';
import { publishCompletedSaleImpact, readLatestSalesImpact, SALES_IMPACT_SESSION_KEY } from '@/lib/salesImpactChannel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.removeItem(SALES_IMPACT_SESSION_KEY); });
const before = () => provisionalFixture();
const after = () => provisionalFixture({ revision: '185', observedAt: '2026-10-20T15:01:00Z' });

describe('provisional Isolation Forest sales comparison', () => {
  it('shows real features, changed score/decision and provisional methodology', () => {
    const next = after(); next.modelInput!.weekdayLogTicketsDeviation = -.9;
    next.inference = { anomalyScore: -.6, decisionFunction: -.1, prediction: -1, label: 'ANOMALOUS_SIGNAL', regionSignature: 'c'.repeat(64) };
    render(<SalesIsolationForestImpact before={before()} after={next} />);
    expect(screen.getByText('Dentro del patrón → Señal atípica')).toBeTruthy();
    expect(screen.getByText(/-0[,.]4 → -0[,.]6/)).toBeTruthy();
    expect(screen.getByText(/Desviación de tickets vs patrón/)).toBeTruthy();
    expect(screen.getByText('EVALUACIÓN PROVISIONAL')).toBeTruthy();
    expect(screen.getByText(/no implica fraude ni confirma una causa/)).toBeTruthy();
    expect(screen.getByText(/El día actual todavía está abierto/)).toBeTruthy();
    expect(screen.getByText('Modelo sin cambios')).toBeTruthy();
    expect(screen.getByText(/model.joblib/)).toBeTruthy();
  });

  it('first sale has no invented BEFORE score and uses real AFTER inference', () => {
    const initial = provisionalFixture({ status: 'NOT_EVALUABLE', reason: 'NO_TICKETS', modelInput: null, inference: null,
      aggregate: { revenuePEN: 0, units: 0, tickets: 0, averageTicketPEN: null } });
    render(<SalesIsolationForestImpact before={initial} after={after()} />);
    expect(screen.getByText(/No existía actividad suficiente antes/)).toBeTruthy();
    expect(screen.getByText('No evaluable → Dentro del patrón')).toBeTruthy();
    expect(screen.getByText(/No evaluable → -0[,.]4/)).toBeTruthy();
  });

  it('keeps AFTER not evaluable explicit', () => {
    render(<SalesIsolationForestImpact before={before()} after={provisionalFixture({ revision: '185', status: 'NOT_EVALUABLE',
      reason: 'INVALID_AVERAGE_TICKET', modelInput: null, inference: null })} />);
    expect(screen.getByText('Dentro del patrón → No evaluable')).toBeTruthy();
    expect(screen.getByText(/estado posterior no es evaluable/)).toBeTruthy();
  });

  it('explains unchanged score and region only when feature and leaf signatures support it', () => {
    const next = after(); next.modelInput!.weekdayLogTicketsDeviation = -.8;
    render(<SalesIsolationForestImpact before={before()} after={next} />);
    expect(screen.getByText(/inferencia permaneció en la misma región del bosque/)).toBeTruthy();
    expect(screen.getByText('Dentro del patrón → Dentro del patrón')).toBeTruthy();
    cleanup();
    next.inference!.regionSignature = 'd'.repeat(64);
    render(<SalesIsolationForestImpact before={before()} after={next} />);
    expect(screen.queryByText(/inferencia permaneció en la misma región/)).toBeNull();
    expect(screen.getByText(/pero el score permaneció igual/)).toBeTruthy();
  });

  it.each(['date', 'tenant', 'model', 'revision'] as const)('does not compare mismatched %s', issue => {
    const next = after();
    if (issue === 'date') next.localDate = '2026-10-21';
    if (issue === 'tenant') next.businessContext = { ...next.businessContext, businessId: 'OTHER' };
    if (issue === 'model') next.modelIdentity = { ...next.modelIdentity, artifactHash: 'f'.repeat(64) };
    if (issue === 'revision') next.revision = '184';
    expect(provisionalComparison(before(), next).comparable).toBe(false);
    render(<SalesIsolationForestImpact before={before()} after={next} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Score Isolation Forest')).toBeNull();
  });

  it('warns about additional operational revisions', () => {
    render(<SalesIsolationForestImpact before={before()} after={provisionalFixture({ revision: '187' })} />);
    expect(screen.getByText(/pudieron registrarse otros cambios operativos/)).toBeTruthy();
  });

  it('uses one HTTP capture for commercial metrics and inference, without revision probes', async () => {
    const instance = (apiClient as unknown as { instance: { get: (url: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ data: { success: true, data: before() } });
    const value = await captureSalesImpactSnapshot();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/intelligence/sales/anomalies/provisional', { timeout: 15_000 });
    expect(value?.isolationForest?.modelInput).toEqual(before().modelInput);
    expect(value?.averageTicket?.value).toBe(22.5);
    const event = makeSalesImpactEvent({ businessContext: before().businessContext, transactionId: 'one-multi-sku-sale',
      occurredAt: before().observedAt, saleTotal: { value: 10, currency: 'PEN' }, before: value,
      after: value ? { ...value, isolationForest: after() } : null });
    expect(event.isolationForestImpact?.captureStatus).toBe('COMPLETE');
    expect(event.transactionId).toBe('one-multi-sku-sale');
  });

  it.each(['BEFORE', 'AFTER'] as const)('%s failure never prevents the real shared sale wrapper from completing', async failedSide => {
    const capture = vi.spyOn(apiClient, 'getSalesImpactAnalytics');
    if (failedSide === 'BEFORE') capture.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce({ success: true, data: after() });
    else capture.mockResolvedValueOnce({ success: true, data: before() }).mockRejectedValueOnce(new Error('temporary failure'));
    let initial: SalesImpactSnapshot | null = null;
    const submit = vi.fn(async () => ({ success: true }));
    const result = await registerSaleWithImpact({ products: [{ sku: 'A', name: 'Producto A', quantity: 3 }, { sku: 'B', name: 'Producto B', quantity: 2 }],
      captureBefore: async () => { initial = await waitForSalesImpactBefore(captureSalesImpactSnapshot()); return { context: before().businessContext } as never; },
      submit, isSuccessful: row => row.success,
      onSuccess: () => publishCompletedSaleImpact({ businessContext: before().businessContext,
        transactionId: 'multi-1', occurredAt: before().observedAt, saleTotal: { value: 10, currency: 'PEN' }, before: initial }) });
    expect(result.success).toBe(true); expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(readLatestSalesImpact()?.transactionId).toBe('multi-1');
    expect(readLatestSalesImpact()?.isolationForestImpact?.captureStatus).toBe(`${failedSide}_UNAVAILABLE`);
  });
});
