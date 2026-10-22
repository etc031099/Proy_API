import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
import { registerSaleWithImpacts } from '@/lib/saleImpactOrchestration';
import { clearLatestInventoryImpact, readLatestInventoryImpact } from '@/lib/inventoryImpactChannel';
import { clearLatestForecastImpactSale, readLatestForecastImpactSale } from '@/lib/forecastImpactChannel';
import { clearLatestSalesImpact, readLatestSalesImpact } from '@/lib/salesImpactChannel';
import { clearLatestCustomerImpact, readLatestCustomerImpact } from '@/lib/customerImpactChannel';
import type { CustomerClustering } from '@/types/customerClustering';
import type { ProductInventory } from '@/types/businessIntelligence';

const customerId = '507f1f77bcf86cd799439011';
const context = { businessId: 'demo-v3', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'seed-v1' };
const products = [{ sku: 'PAN-FRE-001', name: 'Pan Francés', quantity: 2 }];
const occurredAt = '2026-10-22T15:30:00.000Z';

function productInventory(): ProductInventory {
  return { asOf: '2026-10-22', timezone: 'America/Lima', mode: 'LIVE', updatedAt: null, dataThrough: null,
    status: 'READY', availability: 'READY', freshness: { mode: 'LIVE', updatedAt: null, dataThrough: null },
    product: { sku: products[0].sku, name: products[0].name }, stock: { onHand: 12, incoming: 0, inventoryPosition: 12 },
    demand: { expectedDaily: null, expectedUnitsNext1d: null, expectedUnitsNext7d: null, expectedUnitsNext14d: null },
    coverage: { daysCover: null, status: 'UNAVAILABLE', availabilityStatus: 'UNAVAILABLE', reasonCode: null },
    inventoryPolicy: { safetyStock: null, reorderPoint: null },
    recommendation: { reorderNow: null, preventiveRecommendation: false, recommendedQty: null },
    risk: { level: null, lowStock: null, reasonCodes: [] }, classification: { abc: null, xyz: null } };
}

function customerClustering(frequency: number): CustomerClustering {
  const row = { customerRef: customerId, status: 'ASSIGNED' as const, recency: 2, frequency, monetary: 42,
    rfmSegment: 'LOYAL', cluster: 1, clusterName: 'Frecuentes', distance: 0.2, pc1: 0.4, pc2: -0.1 };
  return { contractVersion: 'customer-kmeans-v3-v1', modelId: 'customer-kmeans-v3', version: 'customer-kmeans-v3-v1',
    algorithm: 'KMeans', learningType: 'unsupervised', task: 'clustering', trainingCutoff: '2026-10-12', sampleCount: 10,
    excludedCount: 0, features: ['recency', 'frequency', 'monetary'], featureWindow: '90d', transformations: ['log1p'],
    scaler: 'StandardScaler', k: 4, randomState: 2026, nInit: 20, status: 'EXPLORATORY', artifactHash: 'a'.repeat(64),
    metrics: {}, candidates: [], scalerSensitivityAri: 1, selectionReason: '', protocolDeviation: '', limitations: [], clusters: [],
    assignments: [row], pca: { explainedVarianceRatio: [0.6, 0.2], visualizationOnly: true }, assignmentAsOfDate: '2026-10-22',
    assignmentSource: 'AUTHORIZED_CURRENT_RFM', assignmentBinding: { ...context, revision: '180', snapshotHash: 'b'.repeat(64),
      observedAt: occurredAt } } as unknown as CustomerClustering;
}

function configureReads(customer = true) {
  vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => undefined);
  vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue({ success: true, data: { ...context, dataVersion: '180' } } as never);
  vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockRejectedValue(new Error('analytics unavailable'));
  vi.spyOn(apiClient, 'getProductOperationDetail').mockResolvedValue({ success: true, data: { inventoryMovements: [] } } as never);
  vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 503 } as never);
  vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockRejectedValue(new Error('forecast unavailable'));
  vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockRejectedValue(new Error('sales unavailable'));
  const readCustomer = vi.spyOn(apiClient, 'getCustomerClustering');
  if (customer) readCustomer.mockResolvedValueOnce({ success: true, data: customerClustering(5) } as never)
    .mockResolvedValueOnce({ success: true, data: customerClustering(6) } as never);
  else readCustomer.mockRejectedValue(new Error('not requested'));
  return readCustomer;
}

function clearEvents() {
  clearLatestInventoryImpact(); clearLatestForecastImpactSale(); clearLatestSalesImpact(); clearLatestCustomerImpact();
}

beforeEach(() => { vi.restoreAllMocks(); clearEvents(); });
afterEach(() => { clearEvents(); vi.restoreAllMocks(); });

describe('shared sale impact orchestration', () => {
  it('publishes confirmed operation impacts without fabricating a customer BEFORE when analytics is unavailable', async () => {
    const readCustomer = configureReads();
    const submit = vi.fn(async () => ({ success: true, transaction: { id: 'sale-assistant-1', customerId, date: occurredAt, total: 42, currency: 'PEN' } }));
    await registerSaleWithImpacts({ products, customerId, displayName: 'Cliente demo', actionKey: 'action-assistant-1', submit,
      isSuccessful: result => result.success, getMetadata: result => ({ transactionId: result.transaction.id,
        occurredAt: result.transaction.date, customerId: result.transaction.customerId, total: result.transaction.total,
        currency: result.transaction.currency }) });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(readCustomer).not.toHaveBeenCalled();
    expect(readLatestInventoryImpact()?.operationId).toBe('sale-assistant-1');
    expect(readLatestForecastImpactSale()).toMatchObject({ transactionId: 'sale-assistant-1', hasCustomer: true,
      customerRef: customerId, products });
    expect(readLatestSalesImpact()?.transactionId).toBe('sale-assistant-1');
    expect(readLatestCustomerImpact()).toBeNull();
  });

  it('does not invent or query a customer for an unassociated sale', async () => {
    const readCustomer = configureReads(false);
    const submit = vi.fn(async () => ({ success: true, transaction: { id: 'sale-no-customer', date: occurredAt } }));
    await registerSaleWithImpacts({ products, customerId: null, displayName: 'Cliente', submit,
      isSuccessful: result => result.success, getMetadata: result => ({ transactionId: result.transaction.id,
        occurredAt: result.transaction.date, customerId: null, total: null, currency: null }) });
    expect(submit).toHaveBeenCalledOnce();
    expect(readCustomer).not.toHaveBeenCalled();
    expect(readLatestCustomerImpact()).toBeNull();
    expect(readLatestForecastImpactSale()?.hasCustomer).toBe(false);
  });

  it('reuses the original BEFORE across an uncertain retry and does not republish an executed action', async () => {
    configureReads(false);
    type SaleResponse = { success: boolean; transaction: { id: string; date: string } };
    const submit = vi.fn<() => Promise<SaleResponse>>().mockRejectedValueOnce(new Error('response uncertain'))
      .mockResolvedValueOnce({ success: true, transaction: { id: 'sale-retry-1', date: occurredAt } });
    const options = { products, customerId: null, displayName: 'Cliente', actionKey: 'action-retry-1', actionScope: 'business-1:conversation-1', submit,
      isSuccessful: (result: SaleResponse) => result.success,
      getMetadata: (result: SaleResponse) => ({ transactionId: result.transaction.id,
        occurredAt: result.transaction.date, customerId: null, total: null, currency: null }) };
    await expect(registerSaleWithImpacts(options)).rejects.toThrow('response uncertain');
    await registerSaleWithImpacts(options);
    const inventoryReadsAfterFirstSuccess = vi.mocked(apiClient.getBusinessIntelligenceProductInventory).mock.calls.length;
    const confirmed = await registerSaleWithImpacts(options);
    await expect(registerSaleWithImpacts(options)).resolves.toBe(confirmed);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiClient.getBusinessIntelligenceProductInventory)).toHaveBeenCalledTimes(inventoryReadsAfterFirstSuccess);
    expect(readLatestInventoryImpact()?.operationId).toBe('sale-retry-1');
    expect(readLatestForecastImpactSale()?.transactionId).toBe('sale-retry-1');
  });

  it('confirms a different Assistant action independently after returning the exact cached result for a repeat', async () => {
    configureReads(false);
    const makeOptions = (actionKey: string, tx: string) => ({ products, customerId: null, displayName: 'Cliente',
      actionKey, actionScope: 'business-2:conversation-9',
      submit: vi.fn(async () => ({ success: true, transaction: { id: tx, date: occurredAt } })),
      isSuccessful: (value: { success: boolean }) => value.success,
      getMetadata: (value: { transaction: { id: string; date: string } }) => ({ transactionId: value.transaction.id,
        occurredAt: value.transaction.date, customerId: null, total: null, currency: null }) });
    const first = makeOptions('action-A', 'sale-A');
    const second = makeOptions('action-B', 'sale-B');
    const resultA = await registerSaleWithImpacts(first);
    await expect(registerSaleWithImpacts(first)).resolves.toBe(resultA);
    const resultB = await registerSaleWithImpacts(second);
    expect(first.submit).toHaveBeenCalledOnce();
    expect(second.submit).toHaveBeenCalledOnce();
    expect(resultB.transaction.id).toBe('sale-B');
  });

  it('coalesces overlapping confirmation requests for one scoped Assistant action', async () => {
    configureReads(false);
    type Response = { success: boolean; transaction: { id: string; date: string } };
    let resolve!: (value: Response) => void;
    const submit = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const options = { products, customerId: null, displayName: 'Cliente', actionKey: 'action-overlap',
      actionScope: 'business-overlap:conversation-overlap', submit, isSuccessful: (value: Response) => value.success,
      getMetadata: (value: Response) => ({ transactionId: value.transaction.id, occurredAt: value.transaction.date,
        customerId: null, total: null, currency: null }) };
    const first = registerSaleWithImpacts(options);
    const second = registerSaleWithImpacts(options);
    expect(submit).toHaveBeenCalledOnce();
    resolve({ success: true, transaction: { id: 'sale-overlap', date: occurredAt } });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(submit).toHaveBeenCalledOnce();
  });

  it('keeps the successful commercial write when every analytical capture is unavailable', async () => {
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => { throw new Error('offline'); });
    vi.spyOn(apiClient, 'getSalesImpactAnalytics').mockRejectedValue(new Error('offline'));
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockRejectedValue(new Error('offline'));
    vi.spyOn(apiClient, 'getBusinessIntelligenceProductInventory').mockRejectedValue(new Error('offline'));
    vi.spyOn(apiClient, 'getBusinessIntelligenceForecast').mockRejectedValue(new Error('offline'));
    vi.spyOn(apiClient, 'getForecastMlUpdateStatus').mockResolvedValue({ httpStatus: 503 } as never);
    vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValue(new Error('offline'));
    const submit = vi.fn(async () => ({ success: true, transaction: { id: 'sale-analytics-failed', date: occurredAt } }));
    const result = await registerSaleWithImpacts({ products, customerId, displayName: 'Cliente demo', submit,
      isSuccessful: value => value.success, getMetadata: value => ({ transactionId: value.transaction.id,
        occurredAt: value.transaction.date, customerId, total: null, currency: null }) });
    expect(result.success).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    expect(readLatestInventoryImpact()?.operationSucceeded).toBe(true);
    expect(readLatestForecastImpactSale()?.baselineUnavailable).toBe(true);
  });

  it('does not wait for or start BEFORE analytics reads before the sale write', async () => {
    const readCustomer = configureReads();
    let failInventoryAfter!: (error: Error) => void;
    vi.mocked(apiClient.getBusinessIntelligenceProductInventory).mockImplementationOnce(() => new Promise((_, reject) => {
      failInventoryAfter = reject;
    }) as never);
    const submit = vi.fn(async () => {
      expect(apiClient.getIntelligenceRevision).not.toHaveBeenCalled();
      expect(apiClient.getSalesImpactAnalytics).not.toHaveBeenCalled();
      expect(readCustomer).not.toHaveBeenCalled();
      return { success: true, transaction: { id: 'sale-before-parallel', date: occurredAt } };
    });
    const sale = registerSaleWithImpacts({ products, customerId, displayName: 'Cliente demo', submit,
      isSuccessful: value => value.success, getMetadata: value => ({ transactionId: value.transaction.id,
        occurredAt: value.transaction.date, customerId, total: null, currency: null }) });

    // The sale is already confirmed while its optional AFTER capture is pending.
    await sale;
    await vi.waitFor(() => expect(apiClient.getBusinessIntelligenceProductInventory).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledOnce();
    expect(apiClient.getBusinessIntelligenceProductInventory).toHaveBeenCalledOnce();
    expect(apiClient.getForecastMlUpdateStatus).not.toHaveBeenCalled();
    expect(readCustomer).not.toHaveBeenCalled();
    expect(readLatestInventoryImpact()).toMatchObject({ operationId: 'sale-before-parallel',
      baselineStatus: 'BASELINE_UNAVAILABLE', afterPending: true });

    failInventoryAfter(new Error('inventory AFTER unavailable'));
    await vi.waitFor(() => expect(readLatestInventoryImpact()?.afterPending).toBe(false));
    expect(readLatestInventoryImpact()).toMatchObject({ afterPending: false, afterUnavailable: true });
  });

  it('publishes Inventory and customer AFTER only after the post-sale inventory scope is verified', async () => {
    configureReads();
    let resolveInventoryAfter!: (value: { success: true; data: ProductInventory }) => void;
    vi.mocked(apiClient.getBusinessIntelligenceProductInventory).mockImplementationOnce(
      () => new Promise(resolve => { resolveInventoryAfter = resolve; }) as never);
    vi.mocked(apiClient.getCustomerClustering).mockReset()
      .mockResolvedValueOnce({ success: true, data: customerClustering(6) } as never);
    vi.mocked(apiClient.getCustomerClustering).mockResolvedValueOnce({ success: true, data: customerClustering(6) } as never);
    const submit = vi.fn(async () => ({ success: true, transaction: { id: 'sale-after-parallel', customerId, date: occurredAt } }));
    const sale = registerSaleWithImpacts({ products, customerId, displayName: 'Cliente demo', submit,
      isSuccessful: value => value.success, getMetadata: value => ({ transactionId: value.transaction.id,
        occurredAt: value.transaction.date, customerId, total: null, currency: null }) });
    await sale;
    await vi.waitFor(() => expect(apiClient.getBusinessIntelligenceProductInventory).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledOnce();
    expect(apiClient.getBusinessIntelligenceProductInventory).toHaveBeenCalledOnce();
    expect(apiClient.getCustomerClustering).not.toHaveBeenCalled();
    expect(readLatestInventoryImpact()).toMatchObject({ operationId: 'sale-after-parallel', afterPending: true,
      baselineStatus: 'BASELINE_UNAVAILABLE' });
    expect(readLatestCustomerImpact()).toBeNull();

    resolveInventoryAfter({ success: true, data: productInventory() });
    await vi.waitFor(() => expect(apiClient.getCustomerClustering).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(readLatestCustomerImpact()).toMatchObject({ transactionId: 'sale-after-parallel',
      captureStatus: 'BEFORE_UNAVAILABLE', before: null, after: { frequency: 6 } }));
    expect(readLatestInventoryImpact()?.afterPending).toBe(false);
  });
});
