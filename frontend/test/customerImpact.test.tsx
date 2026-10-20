import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { CustomerImpactPanel } from '@/components/business-intelligence/CustomerImpactPanel';
import { apiClient } from '@/lib/api';
import { clearLatestCustomerImpact, CUSTOMER_IMPACT_SESSION_KEY, readLatestCustomerImpact, registerCustomerSaleImpact } from '@/lib/customerImpactChannel';
import type { CustomerClusterAssignment, CustomerClustering } from '@/types/customerClustering';

const context = { businessId: 'demo-v3', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'seed-v1' };
function clustering(overrides: Partial<CustomerClusterAssignment> = {}): CustomerClustering {
  return { contractVersion: 'customer-kmeans-v3-v1', modelId: 'customer-kmeans-v3', version: 'customer-kmeans-v3-v1',
    algorithm: 'KMeans', learningType: 'unsupervised', task: 'clustering', trainingCutoff: '2026-10-12',
    sampleCount: 38, excludedCount: 2, features: ['recency', 'frequency', 'monetary'], featureWindow: '90d',
    transformations: [], scaler: 'standard', k: 4, randomState: 2020, nInit: 10, status: 'EXPLORATORY', artifactHash: 'test',
    metrics: {} as CustomerClustering['metrics'], candidates: [], scalerSensitivityAri: 1, selectionReason: '', protocolDeviation: '',
    limitations: [], clusters: [], assignments: [{ customerRef: 'CUS-01', status: 'ASSIGNED', recency: 12, frequency: 5,
      monetary: 180, rfmSegment: 'FRECUENTE', cluster: 2, clusterName: 'Frecuentes', distance: 0.84, pc1: 1.2, pc2: -0.4,
      ...overrides }], pca: { explainedVarianceRatio: [0.6, 0.2], visualizationOnly: true },
    assignmentAsOfDate: '2026-10-20', assignmentSource: 'AUTHORIZED_CURRENT_RFM' };
}
const revision = () => ({ success: true as const, data: { ...context, asOf: '2026-10-20', dataVersion: '184' } });
const response = (data: CustomerClustering) => ({ success: true as const, data });
afterEach(() => { cleanup(); clearLatestCustomerImpact(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('CustomerImpact observational sale flow', () => {
  it('captures one BEFORE and one AFTER for a registered customer and saves one event for the whole sale', async () => {
    const read = vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValueOnce(response(clustering()))
      .mockResolvedValueOnce(response(clustering({ recency: 0, frequency: 6, monetary: 205, distance: 0.62 })));
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    const submit = vi.fn(async () => ({ success: true, transactionId: 'sale-1' }));
    const result = await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Carmen',
      getContext: () => context, submit, isSuccessful: value => value.success,
      getMetadata: value => ({ transactionId: value.transactionId, occurredAt: '2026-10-20T18:00:00.000Z' }) });
    expect(result.success).toBe(true);
    expect(read.mock.calls).toEqual([['507f1f77bcf86cd799439011'], ['507f1f77bcf86cd799439011']]);
    expect(readLatestCustomerImpact()).toMatchObject({ transactionId: 'sale-1', customerRef: 'CUS-01', captureStatus: 'COMPLETE',
      before: { frequency: 5 }, after: { frequency: 6, monetary: 205 } });
  });

  it('keeps transaction frequency as tickets, independent of line quantities and SKU count', async () => {
    vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValueOnce(response(clustering({ frequency: 5 })))
      .mockResolvedValueOnce(response(clustering({ frequency: 6 })));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'multi-sku-sale' }) });
    expect(readLatestCustomerImpact()?.before?.frequency).toBe(5);
    expect(readLatestCustomerImpact()?.after?.frequency).toBe(6);
  });

  it('does not request an individual assignment for Consumer Final', async () => {
    const read = vi.spyOn(apiClient, 'getCustomerClustering');
    await registerCustomerSaleImpact({ customerMongoId: null, displayName: 'Consumer Final', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'sale-consumer' }) });
    expect(read).not.toHaveBeenCalled();
    expect(readLatestCustomerImpact()).toBeNull();
  });

  it('does not block a successful sale when BEFORE capture fails and preserves an incomplete event', async () => {
    vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(response(clustering()));
    const submit = vi.fn(async () => ({ success: true }));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit, isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'sale-before-failed' }) });
    expect(submit).toHaveBeenCalledOnce();
    expect(readLatestCustomerImpact()?.captureStatus).toBe('BEFORE_UNAVAILABLE');
  });

  it('does not block the successful sale when AFTER capture fails', async () => {
    vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValueOnce(response(clustering()))
      .mockRejectedValueOnce(new Error('temporary'));
    const submit = vi.fn(async () => ({ success: true }));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit, isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'sale-after-failed' }) });
    expect(submit).toHaveBeenCalledOnce();
    expect(readLatestCustomerImpact()?.captureStatus).toBe('AFTER_UNAVAILABLE');
  });

  it('renders RFM and frozen K-Means comparisons without claiming retraining', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValue(response(clustering()));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Carmen', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'sale-ui' }) });
    render(<CustomerImpactPanel />);
    expect(await screen.findByText('Impacto de la última venta en el cliente')).toBeTruthy();
    expect(screen.getByText('Frecuencia 90 días · compras/tickets')).toBeTruthy();
    expect(screen.getByText(/Cluster 2 → Cluster 2 · Sin cambio/)).toBeTruthy();
    expect(screen.getByText(/0\.84 → 0\.84 · Sin cambio/)).toBeTruthy();
    expect(screen.getByText('El modelo K-Means no fue reentrenado. Se recalculó el RFM del cliente y el modelo congelado realizó una nueva inferencia.')).toBeTruthy();
    expect(screen.getByText(/PC1/)).toBeTruthy();
  });

  it('renders insufficient history without inventing cluster or zero values', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValue(response(clustering({ status: 'INSUFFICIENT_HISTORY', recency: null,
      frequency: 0, monetary: 0, cluster: null, clusterName: null, distance: null })));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'sale-empty' }) });
    render(<CustomerImpactPanel />);
    expect((await screen.findAllByText(/Historial insuficiente → Historial insuficiente/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Cluster 0/)).toBeNull();
  });

  it('does not poll or issue clustering requests when there is no saved impact', async () => {
    const revisionRead = vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    const clusteringRead = vi.spyOn(apiClient, 'getCustomerClustering');
    render(<CustomerImpactPanel />);
    await waitFor(() => expect(screen.getByText(/La próxima venta a un cliente identificado/)).toBeTruthy());
    expect(revisionRead).not.toHaveBeenCalled();
    expect(clusteringRead).not.toHaveBeenCalled();
  });

  it('keeps a saved comparison if context verification temporarily fails', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockRejectedValue(new Error('429'));
    vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValue(response(clustering()));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'sale-kept' }) });
    render(<CustomerImpactPanel />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(readLatestCustomerImpact()?.transactionId).toBe('sale-kept');
    expect(window.sessionStorage.getItem(CUSTOMER_IMPACT_SESSION_KEY)).not.toBeNull();
  });
});
