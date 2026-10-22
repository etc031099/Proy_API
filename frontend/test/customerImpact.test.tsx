import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerImpactPanel } from '@/components/business-intelligence/CustomerImpactPanel';
import { apiClient } from '@/lib/api';
import { clearLatestCustomerImpact, CUSTOMER_IMPACT_SESSION_KEY, publishCustomerImpact, readLatestCustomerImpact, registerCustomerSaleImpact } from '@/lib/customerImpactChannel';
import { captureCustomerImpactSnapshot, isCustomerImpactEvent, makeCustomerImpactEvent } from '@/lib/customerImpactSnapshot';
import type { CustomerClusterAssignment, CustomerClustering } from '@/types/customerClustering';

const context = { businessId: 'demo-v3', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'seed-v1' };
function clustering(overrides: Partial<CustomerClusterAssignment> = {}, extra: Partial<CustomerClustering> = {}): CustomerClustering {
  const row: CustomerClusterAssignment = { customerRef: 'CUS-01', status: 'ASSIGNED', recency: 12, frequency: 5,
    monetary: 180, rfmSegment: 'POTENTIAL', cluster: 2, clusterName: 'Frecuentes', distance: 0.84, pc1: 1.2, pc2: -0.4, ...overrides };
  if (!('featureInputs' in overrides)) row.featureInputs = row.recency === null ? null
    : (['recency', 'frequency', 'monetary'] as const).map((name, index) => ({ name,
      rawValue: row[name]!, log1pValue: Math.log1p(row[name]!), scaledValue: index - 1.25 }));
  return { contractVersion: 'customer-kmeans-v3-v1', modelId: 'customer-kmeans-v3', version: 'customer-kmeans-v3-v1',
    algorithm: 'KMeans', learningType: 'unsupervised', task: 'clustering', trainingCutoff: '2026-10-12',
    sampleCount: 38, excludedCount: 2, features: ['recency', 'frequency', 'monetary'], featureWindow: '90d',
    transformations: ['log1p'], scaler: 'StandardScaler', k: 4, randomState: 2026, nInit: 20, status: 'EXPLORATORY', artifactHash: 'a'.repeat(64),
    metrics: {} as CustomerClustering['metrics'], candidates: [], scalerSensitivityAri: 1, selectionReason: '', protocolDeviation: '',
    limitations: [], clusters: [], assignments: [row], pca: { explainedVarianceRatio: [0.6, 0.2], visualizationOnly: true },
    assignmentAsOfDate: '2026-10-20', assignmentSource: 'AUTHORIZED_CURRENT_RFM',
    assignmentBinding: { ...context, revision: '184', snapshotHash: 'b'.repeat(64), observedAt: '2026-10-20T18:00:00Z' }, ...extra };
}
const revision = () => ({ success: true as const, data: { ...context, asOf: '2026-10-20', dataVersion: '184' } });
const response = (data: CustomerClustering) => ({ success: true as const, data });
afterEach(() => { cleanup(); clearLatestCustomerImpact(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('CustomerImpact observational sale flow', () => {
  it('captures one BEFORE and one AFTER for a registered customer and saves one event for the whole sale', async () => {
    const read = vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValueOnce(response(clustering({}, {
      assignmentBinding: { ...context, revision: '183', snapshotHash: 'c'.repeat(64), observedAt: '2026-10-20T17:59:00Z' } })))
      .mockResolvedValueOnce(response(clustering({ recency: 0, frequency: 6, monetary: 205, distance: 0.62, rfmSegment: 'LOYAL' })));
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    const submit = vi.fn(async () => ({ success: true, transactionId: 'sale-1' }));
    const result = await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Carmen',
      getContext: () => context, submit, isSuccessful: value => value.success,
      getMetadata: value => ({ transactionId: value.transactionId, occurredAt: '2026-10-20T18:00:00.000Z' }) });
    expect(result.success).toBe(true);
    expect(read.mock.calls).toEqual([['507f1f77bcf86cd799439011'], ['507f1f77bcf86cd799439011']]);
    expect(readLatestCustomerImpact()).toMatchObject({ transactionId: 'sale-1', customerRef: 'CUS-01', captureStatus: 'COMPLETE',
      before: { frequency: 5, revision: '183', artifactHash: 'a'.repeat(64), snapshotHash: 'c'.repeat(64) },
      after: { frequency: 6, monetary: 205, rfmSegment: 'LOYAL', revision: '184', observedAt: '2026-10-20T18:00:00Z',
        featureOrder: ['recency', 'frequency', 'monetary'], artifactHash: 'a'.repeat(64), binding: context } });
    expect(readLatestCustomerImpact()?.after?.featureInputs).toEqual(clustering({ recency: 0, frequency: 6, monetary: 205 }).assignments[0].featureInputs);
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

  it('explains Consumer Final without rendering individual RFM or K-Means values', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    const read = vi.spyOn(apiClient, 'getCustomerClustering');
    publishCustomerImpact(makeCustomerImpactEvent({ businessContext: context, transactionId: 'sale-final-ui',
      customerKind: 'CONSUMER_FINAL', displayName: 'Consumidor final', occurredAt: '2026-10-20T18:00:00.000Z', before: null, after: null }));
    render(<CustomerImpactPanel />);
    expect(await screen.findByText(/corresponde a Consumidor final/)).toBeTruthy();
    expect(screen.getByText(/No se calcula RFM ni se asigna un cluster individual a Consumer Final/)).toBeTruthy();
    expect(screen.queryByText('Cambio RFM')).toBeNull();
    expect(read).not.toHaveBeenCalled();
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

  it('allows a newer partial transaction to replace an older complete same-context event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T18:00:00.000Z'));
    vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValueOnce(response(clustering()))
      .mockResolvedValueOnce(response(clustering({ frequency: 6 })))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'));
    const completeSale = { customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: (value: { success: boolean }) => value.success,
      getMetadata: () => ({ transactionId: '507f1f77bcf86cd799439011' }) };
    await registerCustomerSaleImpact(completeSale);
    const previous = readLatestCustomerImpact();
    await registerCustomerSaleImpact({ ...completeSale, displayName: 'Cliente',
      submit: async () => ({ success: true }), getMetadata: () => ({ transactionId: '507f1f77bcf86cd799439012' }) });
    const next = readLatestCustomerImpact();
    expect(next).not.toEqual(previous);
    expect(next?.occurredAt).toBe(previous?.occurredAt);
    expect(next).toMatchObject({ transactionId: '507f1f77bcf86cd799439012', captureStatus: 'BOTH_UNAVAILABLE',
      before: null, after: null });
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
    expect(screen.getByText('El modelo no se reentrenó; se volvió a ejecutar inferencia con nuevas entradas RFM.')).toBeTruthy();
    expect(screen.getByText('Entradas K-Means')).toBeTruthy();
    expect(screen.getByText('Escalado')).toBeTruthy();
    expect(screen.getByText(/-1[.,]25 → -1[.,]25/)).toBeTruthy();
    expect(screen.getByText('POTENTIAL → POTENTIAL')).toBeTruthy();
    expect(screen.getByText('Sí')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
      'Impacto de la última venta en el cliente', 'Cambio RFM', 'Entradas K-Means', 'Modelo congelado', 'Salida K-Means',
    ]);
    expect(screen.getByText(/PC1/)).toBeTruthy();
    const pca = screen.getByText('Coordenadas PCA · solo visualización').closest('details')!;
    expect(pca.open).toBe(false);
    fireEvent.click(screen.getByText('Coordenadas PCA · solo visualización'));
    expect(pca.open).toBe(true);
    expect(screen.getByText('PCA solo visualiza la posición del cliente; no determina el cluster.')).toBeTruthy();
  });

  it.each([
    { label: 'same cluster and changed distance', row: { frequency: 6, monetary: 205, distance: 0.62 }, extra: {}, expected: /cambiaron 2 de las 3 entradas RFM.*El cluster permaneció igual; la distancia al centroide cambió/ },
    { label: 'changed cluster', row: { frequency: 6, cluster: 3 }, extra: {}, expected: /El cluster cambió de 2 a 3/ },
    { label: 'different artifact', row: {}, extra: { artifactHash: 'd'.repeat(64) }, expected: /El artifact cambió entre BEFORE y AFTER/ },
    { label: 'missing feature evidence', row: { featureInputs: null }, extra: {}, expected: /Comparación parcial: falta evidencia/ },
    { label: 'missing artifact identity', row: {}, extra: { artifactHash: '' }, expected: /Comparación parcial: falta evidencia/ },
  ])('explains $label without inventing training or identity', async ({ row, extra, expected }) => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    const read = vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValueOnce(response(clustering()))
      .mockResolvedValueOnce(response(clustering(row, extra)));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'explanation' }) });
    render(<CustomerImpactPanel />);
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    if (extra.artifactHash !== undefined) expect(screen.queryByText(/El mismo K-Means congelado/)).toBeNull();
  });

  it('preserves a missing BEFORE as a partial comparison', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(response(clustering()));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'partial' }) });
    render(<CustomerImpactPanel />);
    expect(await screen.findByText('Comparación parcial: falta la captura BEFORE o AFTER.')).toBeTruthy();
    expect(screen.getAllByText('Actual: 12').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('No disponible → 12');
    expect(screen.getByText(/BEFORE histórico durable no disponible/)).toBeTruthy();
  });

  it('does not mislabel a missing identified-customer capture as Consumer Final', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    publishCustomerImpact(makeCustomerImpactEvent({ businessContext: context, transactionId: 'sale-customer-unavailable',
      customerKind: 'IDENTIFIED', displayName: 'Cliente identificado', occurredAt: '2026-10-20T18:00:00.000Z', before: null, after: null }));
    render(<CustomerImpactPanel />);
    expect(await screen.findByText(/no se obtuvo una asignación individual verificable/)).toBeTruthy();
    expect(screen.queryByText(/No se calcula RFM ni se asigna/)).toBeNull();
  });

  it('states clearly when both captures failed instead of implying only one is missing', async () => {
    vi.spyOn(apiClient, 'getIntelligenceRevision').mockResolvedValue(revision() as never);
    vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValue(new Error('unavailable'));
    await registerCustomerSaleImpact({ customerMongoId: '507f1f77bcf86cd799439011', displayName: 'Cliente', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'both-missing' }) });
    render(<CustomerImpactPanel />);
    expect(await screen.findByText(/no se obtuvo una asignación individual verificable/)).toBeTruthy();
  });

  it('excludes the explicit Consumer Final code without assignment or fictional event', async () => {
    const read = vi.spyOn(apiClient, 'getCustomerClustering');
    await registerCustomerSaleImpact({ customerMongoId: 'CONSUMER_FINAL', displayName: 'Consumer Final', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'consumer' }) });
    expect(read).not.toHaveBeenCalled();
    expect(readLatestCustomerImpact()).toBeNull();
  });

  it('preserves supplied transformed values and rejects missing, reordered or mismatched feature evidence', async () => {
    const valid = clustering().assignments[0].featureInputs!;
    const custom = valid.map(feature => ({ ...feature, log1pValue: 9.87654321, scaledValue: -8.7654321 }));
    const read = vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValueOnce(response(clustering({ featureInputs: custom })))
      .mockResolvedValueOnce(response(clustering({ featureInputs: [...valid].reverse() })))
      .mockResolvedValueOnce(response(clustering({ featureInputs: [{ ...valid[0], rawValue: 999 }, ...valid.slice(1)] })));
    expect((await captureCustomerImpactSnapshot('customer'))?.featureInputs).toEqual(custom);
    expect((await captureCustomerImpactSnapshot('customer'))?.featureInputs).toBeNull();
    expect((await captureCustomerImpactSnapshot('customer'))?.featureInputs).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps legacy session captures partial and rejects foreign binding evidence', async () => {
    vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValue(response(clustering()));
    await registerCustomerSaleImpact({ customerMongoId: 'customer', displayName: 'Cliente', getContext: () => context,
      submit: async () => ({ success: true }), isSuccessful: value => value.success, getMetadata: () => ({ transactionId: 'legacy' }) });
    const event = readLatestCustomerImpact()!;
    const legacy = structuredClone(event);
    for (const snapshot of [legacy.before!, legacy.after!]) {
      delete snapshot.featureInputs; delete snapshot.featureOrder; delete snapshot.artifactHash;
      delete snapshot.revision; delete snapshot.snapshotHash; delete snapshot.observedAt; delete snapshot.binding;
    }
    expect(isCustomerImpactEvent(legacy)).toBe(true);
    const foreign = structuredClone(event);
    foreign.after!.binding!.businessId = 'foreign';
    expect(isCustomerImpactEvent(foreign)).toBe(false);
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
