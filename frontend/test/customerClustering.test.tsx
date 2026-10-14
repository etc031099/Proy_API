import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerClusteringPanel } from '@/components/business-intelligence/CustomerClusteringPanel';
import { apiClient } from '@/lib/api';
import type { CustomerClustering } from '@/types/customerClustering';
import evidence from '../../ml/artifacts/customer-kmeans-v3/metadata.json';

vi.mock('recharts', () => {
  const Wrapper = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Bar: Wrapper, BarChart: Wrapper, CartesianGrid: () => null, Cell: () => null,
    ResponsiveContainer: Wrapper, Scatter: () => null, ScatterChart: Wrapper, Tooltip: () => null, XAxis: () => null, YAxis: () => null };
});
const data = { ...evidence, assignmentAsOfDate: '2026-10-12', assignmentSource: 'FROZEN_TRAINING_RFM' } as unknown as CustomerClustering;
const envelope = (value = data) => ({ success: true as const, data: value });
afterEach(cleanup);

describe('K-Means customer panel', () => {
  it('shows frozen real sample, four profiles and no-history exclusions alongside rule RFM', async () => {
    vi.spyOn(apiClient, 'getCustomerClustering').mockResolvedValue(envelope());
    const onSelect = vi.fn();
    render(<CustomerClusteringPanel onSelect={onSelect} />);
    await screen.findByText(/Modelo exploratorio entrenado con 38 clientes/);
    expect(screen.getByText(/2 clientes sin historial/)).toBeTruthy();
    expect(screen.getByText(/RFM existente usa reglas/)).toBeTruthy();
    expect(screen.getByText('Distribución por cluster')).toBeTruthy();
    expect(screen.getByText('PCA: proyección de RFM')).toBeTruthy();
    expect(screen.getAllByText('Historial insuficiente')).toHaveLength(2);
    expect(screen.getByText('Metodología y evaluación')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: data.assignments[0].customerRef }));
    expect(onSelect).toHaveBeenCalledWith(data.assignments[0].customerRef);
    expect(screen.queryByText(/accuracy/i)).toBeNull();
  });
  it('dated current ML assignment and rule RFM remain distinct', async () => {
    const assigned = { ...data.assignments.find(row => row.cluster === 4)!, status: 'ASSIGNED' as const };
    const get = vi.spyOn(apiClient, 'getCustomerClustering').mockImplementation(async ref => envelope(ref
      ? { ...data, assignments: [assigned], assignmentAsOfDate: '2026-10-14' } : data));
    render(<CustomerClusteringPanel selectedRef={assigned.customerRef} selectedRfmSegment="En riesgo" onSelect={vi.fn()} />);
    expect(await screen.findByText(/Segmentación ML actual: Cluster 4/)).toBeTruthy();
    expect(screen.getByText('Segmentación RFM actual por reglas: En riesgo')).toBeTruthy();
    expect(screen.getByText(/RFM observado al 2026-10-14; modelo congelado al 2026-10-12/)).toBeTruthy();
    expect(screen.getByText(/no es una probabilidad/)).toBeTruthy();
    expect(get).toHaveBeenCalledWith(assigned.customerRef);
  });
  it('no-history selected customer is not assigned an invented cluster', async () => {
    const excluded = data.assignments.find(row => row.cluster === null)!;
    vi.spyOn(apiClient, 'getCustomerClustering').mockImplementation(async ref => envelope(ref ? { ...data, assignments: [excluded] } : data));
    render(<CustomerClusteringPanel selectedRef={excluded.customerRef} onSelect={vi.fn()} />);
    expect(await screen.findByText('Segmentación ML actual: Historial insuficiente')).toBeTruthy();
  });
  it('controlled load error can retry without fabricated data', async () => {
    const get = vi.spyOn(apiClient, 'getCustomerClustering').mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(envelope());
    render(<CustomerClusteringPanel onSelect={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar segmentación' }));
    await screen.findByText(/Modelo exploratorio entrenado con 38 clientes/);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('uses existing authenticated client and sends only reference', async () => {
    const client = apiClient as unknown as { instance: { get: (url: string, options: unknown) => Promise<unknown> } };
    const get = vi.spyOn(client.instance, 'get').mockResolvedValue({ data: envelope() });
    await apiClient.getCustomerClustering('CUS-01');
    expect(get).toHaveBeenCalledWith('/intelligence/customers/clustering', { params: { customerRef: 'CUS-01' } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  });
});
