import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
import { confirmedPurchaseImpactProducts, publishConfirmedInventoryOperation, recordInventoryOperation, type InventoryImpactProduct } from '@/lib/inventoryImpactSnapshot';
import { clearLatestInventoryImpact, readLatestInventoryImpact } from '@/lib/inventoryImpactChannel';
import { clearLatestCustomerImpact, readLatestCustomerImpact } from '@/lib/customerImpactChannel';
import { clearLatestForecastImpactSale, readLatestForecastImpactSale } from '@/lib/forecastImpactChannel';
import { clearLatestSalesImpact, readLatestSalesImpact } from '@/lib/salesImpactChannel';
import { registerSaleWithImpacts } from '@/lib/saleImpactOrchestration';
import { mayReplaceImpact } from '@/lib/operationImpactIdentity';
import type { ProductInventory } from '@/types/businessIntelligence';

const context = { businessId: 'demo-v3', scenarioId: 'scenario-v3', datasetVersion: 'seed-v1' };
const product: InventoryImpactProduct = { sku: 'SKU-1', name: 'Producto Uno', quantity: 2 };
const occurredAt = '2026-10-22T16:00:00.000Z';
function inventory(onHand: number): ProductInventory {
  return { asOf: '2026-10-22', timezone: 'America/Lima', mode: 'LIVE', updatedAt: null, dataThrough: null,
    status: 'READY', availability: 'READY', freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null },
    product: { sku: product.sku, name: product.name }, stock: { onHand, incoming: 0, inventoryPosition: onHand },
    demand: { expectedDaily: null, expectedUnitsNext1d: null, expectedUnitsNext7d: null, expectedUnitsNext14d: null },
    coverage: { daysCover: null, status: 'UNAVAILABLE', availabilityStatus: 'UNAVAILABLE', reasonCode: null },
    inventoryPolicy: { safetyStock: null, reorderPoint: null }, recommendation: { reorderNow: null, preventiveRecommendation: false, recommendedQty: null },
    risk: { level: null, lowStock: null, reasonCodes: [] }, classification: { abc: null, xyz: null } } as ProductInventory;
}
function configureReads() {
  vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => undefined);
  vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue({ success: true, data: { ...context, dataVersion: '184' } } as never);
  vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockImplementation(async () => ({ success: true, data: inventory(12) } as never));
  vi.spyOn(apiClient, 'getProductOperationDetail').mockResolvedValue({ httpStatus: 200,
    data: { inventoryMovements: [{ movementType: 'purchase', quantityDelta: 2, stockBefore: 10, stockAfter: 12, occurredAt }] } } as never);
  vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockRejectedValue(new Error('optional analytics unavailable'));
  vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValue(new Error('optional analytics unavailable'));
  vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockRejectedValue(new Error('optional analytics unavailable'));
  vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 503 } as never);
}
function clearImpacts() {
  clearLatestInventoryImpact(); clearLatestCustomerImpact(); clearLatestForecastImpactSale(); clearLatestSalesImpact();
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => { vi.restoreAllMocks(); clearImpacts(); });
afterEach(() => { clearImpacts(); vi.restoreAllMocks(); });

describe('P4-B1 commercial operation impacts', () => {
  it('orders shared/restored impact identities without confusing transactions, operation types or tenants', () => {
    const older = { transactionId: '00000000000000000000000a', operationType: 'SALE', occurredAt,
      businessContext: context };
    const newer = { transactionId: '00000000000000000000000b', operationType: 'SALE', occurredAt,
      businessContext: context };
    expect(mayReplaceImpact(newer, older)).toBe(true);
    expect(mayReplaceImpact(older, newer)).toBe(false);
    expect(mayReplaceImpact({ ...newer, transactionId: older.transactionId, operationType: 'PURCHASE' }, older)).toBe(false);
    expect(mayReplaceImpact({ ...newer, businessContext: { ...context, businessId: 'other-business' },
      occurredAt: '2026-10-22T16:01:00.000Z' }, older)).toBe(false);
  });

  it.each(['manual sale', 'Assistant sale'] as const)('%s performs exactly one write and does not wait for analytics AFTER', async flow => {
    configureReads();
    let resolveAfter!: (value: unknown) => void;
    vi.mocked(apiClient.getBusinessIntelligenceProductInventory).mockImplementationOnce(() => new Promise(resolve => { resolveAfter = resolve; }) as never);
    const submit = vi.fn(async () => {
      expect(apiClient.getIntelligenceRevision).not.toHaveBeenCalled();
      expect(apiClient.getBusinessIntelligenceProductInventory).not.toHaveBeenCalled();
      return { success: true, transaction: { _id: flow === 'Assistant sale' ? 'assistant-sale-1' : 'manual-sale-1', date: occurredAt, totalAmount: 20, currency: 'PEN' } };
    });
    const result = await registerSaleWithImpacts({ products: [product], customerId: null, displayName: 'Cliente',
      actionKey: flow === 'Assistant sale' ? 'p4b1-assistant-sale-action' : undefined, submit,
      isSuccessful: value => value.success,
      getMetadata: value => ({ transactionId: value.transaction._id, occurredAt: value.transaction.date,
        customerId: null, total: value.transaction.totalAmount, currency: value.transaction.currency }) });
    expect(result.success).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    const saleId = flow === 'Assistant sale' ? 'assistant-sale-1' : 'manual-sale-1';
    expect(readLatestInventoryImpact()).toMatchObject({ operationId: saleId, type: 'SALE', afterPending: true,
      baselineStatus: 'BASELINE_UNAVAILABLE', baseline: { products: { 'SKU-1': { stock: null } } } });
    expect(readLatestForecastImpactSale()).toMatchObject({ transactionId: saleId, baseline: null, baselineUnavailable: true });
    resolveAfter({ success: true, data: inventory(12) });
  });

  it('manual purchase returns immediately and later uses only the exact linked movement for stock BEFORE/AFTER', async () => {
    configureReads();
    let resolveAfter!: (value: unknown) => void;
    vi.mocked(apiClient.getBusinessIntelligenceProductInventory).mockImplementationOnce(() => new Promise(resolve => { resolveAfter = resolve; }) as never);
    const submit = vi.fn(async () => {
      expect(apiClient.getIntelligenceRevision).not.toHaveBeenCalled();
      return { success: true, transaction: { _id: 'purchase-1', date: occurredAt, invoiceNumber: 'INV-1' } };
    });
    const result = await recordInventoryOperation({ type: 'PURCHASE_CREATED', products: [product], submit,
      isSuccessful: value => value.success,
      getMetadata: value => ({ operationId: value.transaction._id, occurredAt: value.transaction.date,
        reference: value.transaction.invoiceNumber, counterparty: { role: 'SUPPLIER', id: 'vendor-1', name: 'Proveedor Demo' } }) });
    expect(result.success).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    expect(readLatestInventoryImpact()).toMatchObject({ operationId: 'purchase-1', transactionId: 'purchase-1', type: 'PURCHASE_CREATED',
      counterparty: { role: 'SUPPLIER', id: 'vendor-1', name: 'Proveedor Demo' }, afterPending: true,
      baselineStatus: 'BASELINE_UNAVAILABLE' });
    resolveAfter({ success: true, data: inventory(12) });
    await vi.waitFor(() => expect(readLatestInventoryImpact()?.afterPending).toBe(false));
    expect(readLatestInventoryImpact()?.baseline.products['SKU-1'].stock?.onHand).toBe(10);
    expect(readLatestInventoryImpact()?.after?.products['SKU-1'].stock?.onHand).toBe(12);
    expect(readLatestInventoryImpact()?.baselineStatus).toBe('PARTIAL');
  });

  it('Assistant purchase publishes the same operation event without sales/ML impact events', () => {
    configureReads();
    publishConfirmedInventoryOperation({ type: 'PURCHASE_CREATED', operationId: 'purchase-assistant-1', occurredAt,
      counterparty: { role: 'SUPPLIER', id: 'vendor-1', name: 'Proveedor Assistant' },
      products: [{ sku: product.sku, name: product.name, quantity: 2 }] });
    expect(readLatestInventoryImpact()).toMatchObject({ type: 'PURCHASE_CREATED', operationId: 'purchase-assistant-1',
      transactionId: 'purchase-assistant-1', counterparty: { role: 'SUPPLIER', name: 'Proveedor Assistant' } });
    expect(readLatestForecastImpactSale()).toBeNull();
    expect(readLatestSalesImpact()).toBeNull();
    expect(readLatestCustomerImpact()).toBeNull();
  });

  it('uses only confirmed action items when Assistant result.items is empty and marks absent products unavailable', () => {
    configureReads();
    const fallback = confirmedPurchaseImpactProducts([], [product]);
    expect(fallback).toEqual([product]);
    publishConfirmedInventoryOperation({ type: 'PURCHASE_CREATED', operationId: 'purchase-fallback', occurredAt,
      counterparty: { role: 'SUPPLIER', id: 'vendor-1', name: 'Proveedor Demo' }, products: fallback });
    expect(readLatestInventoryImpact()).toMatchObject({ transactionId: 'purchase-fallback', products: [product],
      counterparty: { id: 'vendor-1', role: 'SUPPLIER' } });

    const unavailable = confirmedPurchaseImpactProducts([], [{ ...product, quantity: 0 }]);
    expect(unavailable).toEqual([]);
    publishConfirmedInventoryOperation({ type: 'PURCHASE_CREATED', operationId: 'purchase-no-items', occurredAt: '2026-10-22T16:02:00.000Z',
      counterparty: { role: 'SUPPLIER', id: 'vendor-1', name: 'Proveedor Demo' }, products: unavailable });
    expect(readLatestInventoryImpact()).toMatchObject({ transactionId: 'purchase-no-items', products: [],
      baselineStatus: 'BASELINE_UNAVAILABLE', after: null, afterPending: false, afterUnavailable: true });
    expect(readLatestForecastImpactSale()).toBeNull();
    expect(readLatestSalesImpact()).toBeNull();
    expect(readLatestCustomerImpact()).toBeNull();
  });

  it('a failed BI read after commit cannot change commercial success or invent a BEFORE value', async () => {
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => undefined);
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockRejectedValue(new Error('temporary 429'));
    vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockRejectedValue(new Error('temporary 429'));
    vi.spyOn(apiClient, 'getProductOperationDetail').mockRejectedValue(new Error('temporary 429'));
    const result = await recordInventoryOperation({ type: 'PURCHASE_CREATED', products: [product],
      submit: async () => ({ success: true, transactionId: 'purchase-degraded' }), isSuccessful: value => value.success,
      getMetadata: value => ({ operationId: value.transactionId }) });
    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(readLatestInventoryImpact()?.afterPending).toBe(false));
    expect(readLatestInventoryImpact()?.baselineStatus).toBe('BASELINE_UNAVAILABLE');
    expect(readLatestInventoryImpact()?.baseline.products['SKU-1'].stock).toBeNull();
    expect(readLatestInventoryImpact()?.afterUnavailable).toBe(true);
  });

  it('a later operation cannot be overwritten by a slower completion for the prior transaction', async () => {
    configureReads();
    let resolveFirst!: (value: unknown) => void;
    vi.mocked(apiClient.getBusinessIntelligenceProductInventory)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }) as never)
      .mockResolvedValue({ success: true, data: inventory(22) } as never);
    publishConfirmedInventoryOperation({ type: 'PURCHASE_CREATED', operationId: 'purchase-old', occurredAt,
      products: [product] });
    publishConfirmedInventoryOperation({ type: 'PURCHASE_CREATED', operationId: 'purchase-new', occurredAt: '2026-10-22T16:01:00.000Z',
      products: [product] });
    await vi.waitFor(() => expect(readLatestInventoryImpact()?.operationId).toBe('purchase-new'));
    resolveFirst({ success: true, data: inventory(11) });
    await tick();
    expect(readLatestInventoryImpact()?.operationId).toBe('purchase-new');
  });

  it('does not publish an old sale AFTER or customer capture over a newer sale', async () => {
    configureReads();
    let resolveInventoryA!: (value: unknown) => void;
    vi.mocked(apiClient.getBusinessIntelligenceProductInventory)
      .mockImplementationOnce(() => new Promise(resolve => { resolveInventoryA = resolve; }) as never)
      .mockResolvedValue({ success: true, data: inventory(22) } as never);
    let resolveCustomerA!: (value: unknown) => void;
    vi.mocked(apiClient.getCustomerClustering).mockImplementationOnce(() => new Promise(resolve => { resolveCustomerA = resolve; }) as never);
    const sale = (id: string, customerId: string | null, time = occurredAt) => registerSaleWithImpacts({ products: [product], customerId,
      displayName: 'Cliente', submit: async () => ({ success: true, transactionId: id, occurredAt: time }),
      isSuccessful: value => value.success,
      getMetadata: value => ({ transactionId: value.transactionId, occurredAt: value.occurredAt,
        customerId, total: null, currency: 'PEN' }) });
    await sale('sale-A', 'customer-A');
    await vi.waitFor(() => expect(readLatestInventoryImpact()?.operationId).toBe('sale-A'));
    resolveInventoryA({ success: true, data: inventory(11) });
    await vi.waitFor(() => expect(apiClient.getCustomerClustering).toHaveBeenCalledOnce());

    await sale('sale-B', null, '2026-10-22T16:01:00.000Z');
    await vi.waitFor(() => expect(readLatestInventoryImpact()?.operationId).toBe('sale-B'));
    resolveCustomerA({ success: false });
    await tick();
    expect(readLatestInventoryImpact()?.operationId).toBe('sale-B');
    expect(readLatestForecastImpactSale()?.transactionId).toBe('sale-B');
    expect(readLatestSalesImpact()?.transactionId).toBe('sale-B');
    await vi.waitFor(() => expect(readLatestCustomerImpact()).toMatchObject({ transactionId: 'sale-B', customerKind: 'CONSUMER_FINAL' }));
  });

  it('Consumer Final is not converted into an individual customer or RFM request', async () => {
    configureReads();
    await registerSaleWithImpacts({ products: [product], customerId: 'CONSUMER_FINAL', displayName: 'Consumidor final',
      submit: async () => ({ success: true, transactionId: 'sale-final', occurredAt }), isSuccessful: value => value.success,
      getMetadata: value => ({ transactionId: value.transactionId, occurredAt: value.occurredAt,
        customerId: null, total: null, currency: 'PEN' }) });
    expect(apiClient.getCustomerClustering).not.toHaveBeenCalled();
    expect(readLatestInventoryImpact()?.counterparty).toBeNull();
    await vi.waitFor(() => expect(readLatestCustomerImpact()).toMatchObject({ transactionId: 'sale-final', customerRef: null, customerKind: 'CONSUMER_FINAL',
      captureStatus: 'BOTH_UNAVAILABLE', displayName: 'Consumidor final' }));
  });
});
