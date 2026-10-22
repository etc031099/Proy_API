import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
import { registerSaleWithImpacts } from '@/lib/saleImpactOrchestration';
import { clearLatestInventoryImpact, readLatestInventoryImpact } from '@/lib/inventoryImpactChannel';
import { clearLatestForecastImpactSale, readLatestForecastImpactSale } from '@/lib/forecastImpactChannel';
import { clearLatestSalesImpact, readLatestSalesImpact } from '@/lib/salesImpactChannel';
import { clearLatestCustomerImpact, readLatestCustomerImpact } from '@/lib/customerImpactChannel';
import type { CustomerClustering } from '@/types/customerClustering';

const customerId = '507f1f77bcf86cd799439011';
const context = { businessId: 'demo-v3', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'seed-v1' };
const products = [{ sku: 'PAN-FRE-001', name: 'Pan Francés', quantity: 2 }];
const occurredAt = '2026-10-22T15:30:00.000Z';

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
  it('publishes inventory, Ridge, sales, and customer impacts once for an Assistant sale with a customer', async () => {
    const readCustomer = configureReads();
    const submit = vi.fn(async () => ({ success: true, transaction: { id: 'sale-assistant-1', customerId, date: occurredAt, total: 42, currency: 'PEN' } }));
    await registerSaleWithImpacts({ products, customerId, displayName: 'Cliente demo', actionKey: 'action-assistant-1', submit,
      isSuccessful: result => result.success, getMetadata: result => ({ transactionId: result.transaction.id,
        occurredAt: result.transaction.date, customerId: result.transaction.customerId, total: result.transaction.total,
        currency: result.transaction.currency }) });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(readCustomer.mock.calls).toEqual([[customerId], [customerId]]);
    expect(readLatestInventoryImpact()?.operationId).toBe('sale-assistant-1');
    expect(readLatestForecastImpactSale()).toMatchObject({ transactionId: 'sale-assistant-1', hasCustomer: true,
      customerRef: customerId, products });
    expect(readLatestSalesImpact()?.transactionId).toBe('sale-assistant-1');
    expect(readLatestCustomerImpact()).toMatchObject({ transactionId: 'sale-assistant-1', customerRef: customerId,
      captureStatus: 'COMPLETE', before: { frequency: 5 }, after: { frequency: 6 } });
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
    const options = { products, customerId: null, displayName: 'Cliente', actionKey: 'action-retry-1', submit,
      isSuccessful: (result: SaleResponse) => result.success,
      getMetadata: (result: SaleResponse) => ({ transactionId: result.transaction.id,
        occurredAt: result.transaction.date, customerId: null, total: null, currency: null }) };
    await expect(registerSaleWithImpacts(options)).rejects.toThrow('response uncertain');
    await registerSaleWithImpacts(options);
    const inventoryReadsAfterFirstSuccess = vi.mocked(apiClient.getBusinessIntelligenceProductInventory).mock.calls.length;
    await registerSaleWithImpacts(options);
    expect(submit).toHaveBeenCalledTimes(3); // The server action endpoint remains the idempotency authority.
    expect(vi.mocked(apiClient.getBusinessIntelligenceProductInventory)).toHaveBeenCalledTimes(inventoryReadsAfterFirstSuccess);
    expect(readLatestInventoryImpact()?.operationId).toBe('sale-retry-1');
    expect(readLatestForecastImpactSale()?.transactionId).toBe('sale-retry-1');
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
});
