import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryImpactDetailCard, InventoryImpactSummaryCard, useInventoryImpact } from '@/components/business-intelligence/InventoryImpactPanel';
import { apiClient } from '@/lib/api';
import type { ProductInventory } from '@/types/businessIntelligence';
import { clearLatestForecastImpactSale, publishForecastImpactSale, readLatestForecastImpactSale } from '@/lib/forecastImpactChannel';
import { registerSaleWithImpact, type ForecastImpactSnapshot } from '@/lib/forecastImpactSnapshot';
import { clearLatestInventoryImpact, INVENTORY_IMPACT_SESSION_KEY, publishInventoryImpact, readLatestInventoryImpact } from '@/lib/inventoryImpactChannel';
import { readInventoryImpactSnapshot, recordInventoryOperation, type InventoryImpactEvent, type InventoryImpactProduct, type InventoryImpactSnapshot, type InventoryImpactType } from '@/lib/inventoryImpactSnapshot';

class TestBroadcastChannel {
  static channels: TestBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(name: string) { void name; TestBroadcastChannel.channels.push(this); }
  postMessage(data: unknown) { for (const channel of TestBroadcastChannel.channels) if (channel !== this) channel.onmessage?.({ data } as MessageEvent); }
  close() { TestBroadcastChannel.channels = TestBroadcastChannel.channels.filter(channel => channel !== this); }
}

const products: InventoryImpactProduct[] = [
  { sku: 'SKU-A', name: 'Producto A', quantity: 2 }, { sku: 'SKU-A', name: 'Producto A', quantity: 3 },
  { sku: 'SKU-B', name: 'Producto B', quantity: 1 },
];
function inventory(sku: string, onHand = 18): ProductInventory {
  return { asOf: '2026-10-20', timezone: 'America/Lima', mode: 'LIVE', updatedAt: null, dataThrough: null,
    status: 'READY', availability: 'READY', freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null },
    product: { sku, name: `Producto ${sku}` }, stock: { onHand, incoming: 0, inventoryPosition: onHand },
    demand: { expectedDaily: 1.2, expectedUnitsNext1d: null, expectedUnitsNext7d: 8.4, expectedUnitsNext14d: 16.8 },
    coverage: { daysCover: 15, status: 'AVAILABLE', availabilityStatus: 'AVAILABLE', reasonCode: null },
    inventoryPolicy: { safetyStock: 2, reorderPoint: 5 },
    recommendation: { reorderNow: false, preventiveRecommendation: false, recommendedQty: 0 },
    risk: { level: 'LOW', lowStock: false, reasonCodes: [] }, classification: { abc: null, xyz: 'X' } };
}
function setReadMocks(afterStock = 16) {
  vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
  vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue({ success: true, data: {
    businessId: 'demo', scenarioId: 'v3', datasetVersion: 'v1', asOf: '2026-10-20', dataVersion: '174',
  } } as never);
  vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockImplementation(async sku => ({ success: true, data: inventory(sku, afterStock) } as never));
}
function baseline(): InventoryImpactSnapshot {
  return { context: { businessId: 'demo', scenarioId: 'v3', datasetVersion: 'v1' }, complete: true,
    capturedAt: '2026-10-20T17:00:00.000Z', products: Object.fromEntries(['SKU-A', 'SKU-B'].map(sku => {
      const row = inventory(sku);
      return [sku, { sku, name: row.product.name || sku, captureStatus: 'AVAILABLE' as const, stock: row.stock,
        demand: { expectedDaily: row.demand.expectedDaily, expectedUnitsNext7d: row.demand.expectedUnitsNext7d,
          expectedUnitsNext14d: row.demand.expectedUnitsNext14d }, coverage: row.coverage,
        inventoryPolicy: { safetyStock: 2, reorderPoint: 5 }, recommendation: { reorderNow: false, recommendedQty: 0 },
        risk: { level: row.risk.level, lowStock: row.risk.lowStock }, classification: row.classification }];
    })) };
}
function event(type: InventoryImpactType = 'SALE'): InventoryImpactEvent {
  const saved = baseline();
  const after = baseline();
  for (const row of Object.values(after.products)) row.stock = { ...row.stock!, onHand: 16, inventoryPosition: 16 };
  return { version: 1, type, operationId: 'operation-12345678', occurredAt: saved.capturedAt,
    reference: 'REF-1', operationSucceeded: true, products: [{ sku: 'SKU-A', name: 'Producto A', quantity: 2 }],
    baseline: saved, baselineStatus: 'AVAILABLE', after, afterUnavailable: false, context: saved.context };
}
function Harness() { const impact = useInventoryImpact(); return <><InventoryImpactSummaryCard impact={impact} onNavigate={vi.fn()} /><InventoryImpactDetailCard impact={impact} /></>; }

describe('InventoryImpact observational flow', () => {
  beforeEach(() => {
    clearLatestInventoryImpact(); clearLatestForecastImpactSale(); TestBroadcastChannel.channels = []; vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    vi.spyOn(apiClient, 'analyzeMlTestScenario'); vi.spyOn(apiClient, 'createMlTestCheckpoint');
    vi.spyOn(apiClient, 'requestForecastMlUpdate');
  });
  afterEach(() => { vi.useRealTimers(); clearLatestInventoryImpact(); clearLatestForecastImpactSale(); vi.unstubAllGlobals(); });

  it('reads only real product inventory fields and aggregates duplicate SKUs', async () => {
    setReadMocks();
    const snapshot = await readInventoryImpactSnapshot(products);
    expect(apiClient.getBusinessIntelligenceProductInventory).toHaveBeenCalledTimes(2);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.products['SKU-A'].stock).toEqual({ onHand: 16, incoming: 0, inventoryPosition: 16 });
    expect(snapshot.products['SKU-A'].demand).toEqual({ expectedDaily: 1.2, expectedUnitsNext7d: 8.4, expectedUnitsNext14d: 16.8 });
    expect(snapshot.products['SKU-A'].inventoryPolicy).toEqual({ safetyStock: 2, reorderPoint: 5 });
    expect('targetStock' in snapshot.products['SKU-A']).toBe(false);
  });

  it.each(['SALE', 'SALE_CANCELLED', 'PURCHASE_CREATED', 'INVENTORY_ADJUSTMENT'] as const)(
    'publishes one scoped %s impact after success and leaves failed operations unpublished', async type => {
      setReadMocks();
      const submit = vi.fn(async () => ({ success: true, id: 'operation-1' }));
      await recordInventoryOperation({ type, products, submit, isSuccessful: result => result.success,
        getMetadata: result => ({ operationId: result.id, reference: 'OP-1' }) });
      expect(readLatestInventoryImpact()?.type).toBe(type);
      expect(readLatestInventoryImpact()?.products).toEqual([
        { sku: 'SKU-A', name: 'Producto A', quantity: 5 }, { sku: 'SKU-B', name: 'Producto B', quantity: 1 },
      ]);
      expect(apiClient.getBusinessIntelligenceProductInventory).toHaveBeenCalledTimes(4);
      expect(readLatestInventoryImpact()?.after?.complete).toBe(true);
      for (const sku of ['SKU-A', 'SKU-B']) {
        expect(readLatestInventoryImpact()?.baseline.products[sku].demand).toEqual(
          readLatestInventoryImpact()?.after?.products[sku].demand);
      }
      clearLatestInventoryImpact();
      await recordInventoryOperation({ type, products, submit: async () => ({ success: false }), isSuccessful: result => result.success,
        getMetadata: () => ({ operationId: null }) });
      expect(readLatestInventoryImpact()).toBeNull();
    });

  it('keeps commercial operations successful when the read-only baseline is unavailable', async () => {
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockRejectedValue(new Error('offline'));
    vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockRejectedValue(new Error('offline'));
    const result = await recordInventoryOperation({ type: 'SALE', products: [products[0]],
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ operationId: 'ok' }) });
    expect(result.success).toBe(true);
    expect(readLatestInventoryImpact()?.baseline.complete).toBe(false);
    expect(readLatestInventoryImpact()?.baselineStatus).toBe('BASELINE_UNAVAILABLE');
  });

  it('does not publish an event when the operation fails', async () => {
    setReadMocks();
    await recordInventoryOperation({ type: 'SALE', products: [products[0]], submit: async () => ({ success: false }),
      isSuccessful: result => result.success, getMetadata: () => ({ operationId: 'failed' }) });
    expect(window.sessionStorage.getItem(INVENTORY_IMPACT_SESSION_KEY)).toBeNull();
  });

  it('correlates the inventory sale impact with the existing ForecastImpact without changing its contract', async () => {
    setReadMocks();
    const forecastBaseline: ForecastImpactSnapshot = { context: { businessId: 'demo', scenarioId: 'v3', datasetVersion: 'v1' },
      complete: true, revision: '173', capturedAt: '2026-10-20T17:00:00.000Z',
      horizons: { 7: { pending: false, signals: 0, activeVersion: 1, eligibility: 'READY', reasonCode: null,
        currentlyRunning: false, lastEvaluatedAt: null, lastResult: null },
        14: { pending: false, signals: 0, activeVersion: 1, eligibility: 'READY', reasonCode: null,
          currentlyRunning: false, lastEvaluatedAt: null, lastResult: null } }, forecasts: {} };
    const saleProducts = [products[0]];
    await recordInventoryOperation({ type: 'SALE', products: saleProducts,
      submit: () => registerSaleWithImpact({ products: saleProducts, captureBefore: async () => forecastBaseline,
        submit: async () => ({ success: true, data: { transaction: { _id: 'same-operation-id', date: forecastBaseline.capturedAt } } }),
        isSuccessful: result => result.success,
        onSuccess: ({ response, baseline: saved, products: affected }) => publishForecastImpactSale({ version: 2,
          type: 'SALE_COMPLETED', transactionId: response.data.transaction._id, occurredAt: response.data.transaction.date,
          hasCustomer: false, customerRef: null, products: affected, baseline: saved, baselineUnavailable: false,
          context: saved!.context }) }),
      isSuccessful: result => result.success,
      getMetadata: result => ({ operationId: result.data.transaction._id, occurredAt: result.data.transaction.date }) });
    expect(readLatestForecastImpactSale()?.transactionId).toBe('same-operation-id');
    expect(readLatestInventoryImpact()?.operationId).toBe('same-operation-id');
    expect(readLatestInventoryImpact()?.after?.complete).toBe(true);
  });

  it('restores only matching business/scenario/dataset and renders operational vs Ridge semantics', async () => {
    setReadMocks(16);
    publishInventoryImpact(event());
    render(<Harness />);
    await waitFor(() => expect(document.body.textContent).toContain('18 → 16'));
    expect(document.body.textContent).toContain('8.4 → 8.4');
    expect(document.body.textContent).toContain('16.8 → 16.8');
    expect(document.body.textContent).toContain('Pronóstico Ridge 7 días (P7)');
    expect(document.body.textContent).toContain('Pronóstico Ridge 14 días (P14)');
    expect(screen.getAllByText('Dato operativo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pronóstico directo acumulado').length).toBe(2);
    expect(screen.getByRole('region', { name: 'Pronóstico Ridge' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Operativo' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Reglas derivadas' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Clasificación' })).toBeTruthy();
    expect(screen.getByText(/Tasa diaria derivada/).closest('div')?.textContent).toContain('1.2 → 1.2');
    act(() => publishInventoryImpact(event('PURCHASE_CREATED')));
    await waitFor(() => expect(document.body.textContent).toContain('Compra inmediata: aumenta el stock.'));
    expect(apiClient.analyzeMlTestScenario).not.toHaveBeenCalled();
    expect(apiClient.createMlTestCheckpoint).not.toHaveBeenCalled();
    expect(apiClient.requestForecastMlUpdate).not.toHaveBeenCalled();
  });

  it('shows unavailable direct Ridge forecasts without substituting zero', async () => {
    setReadMocks();
    const missingForecast = event();
    for (const snapshot of [missingForecast.baseline, missingForecast.after!]) {
      for (const row of Object.values(snapshot.products)) {
        if (row.demand) {
          row.demand.expectedUnitsNext7d = null;
          row.demand.expectedUnitsNext14d = null;
        }
      }
    }
    publishInventoryImpact(missingForecast);
    render(<Harness />);
    await waitFor(() => expect(screen.getByText('Pronóstico Ridge 7 días (P7)').parentElement?.textContent)
      .toContain('No disponible → No disponible'));
    expect(screen.getByText('Pronóstico Ridge 14 días (P14)').parentElement?.textContent)
      .toContain('No disponible → No disponible');
    expect(screen.getByText('Pronóstico Ridge 7 días (P7)').parentElement?.textContent).not.toContain('0 → 0');
    expect(screen.queryByText(/Tasa diaria derivada/)).toBeNull();
  });

  it('clears a stored operation when current tenant/scenario/dataset differs', async () => {
    setReadMocks();
    vi.mocked(apiClient.getIntelligenceRevision).mockResolvedValue({ success: true, data: {
      businessId: 'other', scenarioId: 'v3', datasetVersion: 'v1', asOf: '2026-10-20', dataVersion: '174',
    } } as never);
    publishInventoryImpact(event());
    render(<Harness />);
    await waitFor(() => expect(window.sessionStorage.getItem(INVENTORY_IMPACT_SESSION_KEY)).toBeNull());
    expect(screen.queryByText(/Producto A · SKU-A/)).toBeNull();
  });

  it('preserves InventoryImpact through a temporary 429 and displays it after a bounded context retry', async () => {
    vi.useFakeTimers();
    setReadMocks();
    vi.mocked(apiClient.getIntelligenceRevision)
      .mockResolvedValueOnce({ success: false, code: 'ANALYTICS_RATE_LIMITED' } as never);
    publishInventoryImpact(event('PURCHASE_CREATED'));
    render(<Harness />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(window.sessionStorage.getItem(INVENTORY_IMPACT_SESSION_KEY)).not.toBeNull();
    expect(screen.queryByText(/Impacto de la última operación/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText('Impacto de la última operación')).toBeTruthy();
    expect(document.body.textContent).toContain('18 → 16');
    expect(readLatestInventoryImpact()?.type).toBe('PURCHASE_CREATED');
    expect(apiClient.getBusinessIntelligenceProductInventory).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(apiClient.getIntelligenceRevision).toHaveBeenCalledTimes(2);
  });

  it.each([
    { field: 'scenarioId', value: 'other-scenario' },
    { field: 'datasetVersion', value: 'other-dataset' },
  ] as const)('rejects a saved impact with a different $field', async ({ field, value }) => {
    setReadMocks();
    vi.mocked(apiClient.getIntelligenceRevision).mockResolvedValue({ success: true, data: {
      businessId: 'demo', scenarioId: field === 'scenarioId' ? value : 'v3',
      datasetVersion: field === 'datasetVersion' ? value : 'v1', asOf: '2026-10-20', dataVersion: '174',
    } } as never);
    publishInventoryImpact(event());
    render(<Harness />);
    await waitFor(() => expect(window.sessionStorage.getItem(INVENTORY_IMPACT_SESSION_KEY)).toBeNull());
    expect(screen.queryByText(/Producto A · SKU-A/)).toBeNull();
  });

  it('serializes one latest event and replaces the prior operation', () => {
    const first = event('SALE');
    const second = { ...event('INVENTORY_ADJUSTMENT'), operationId: 'new-operation' };
    publishInventoryImpact(first);
    publishInventoryImpact(second);
    expect(readLatestInventoryImpact()).toEqual(second);
    window.sessionStorage.setItem(INVENTORY_IMPACT_SESSION_KEY, JSON.stringify({ ...second, version: 99 }));
    expect(readLatestInventoryImpact()).toBeNull();
    expect(window.sessionStorage.getItem(INVENTORY_IMPACT_SESSION_KEY)).toBeNull();
  });
});
