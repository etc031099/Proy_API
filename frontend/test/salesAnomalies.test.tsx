import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiClient } from '@/lib/api';
import { SalesAnomalyPanel, SalesAnomalyTooltip } from '@/components/business-intelligence/SalesAnomalyPanel';
import type { DailySalesAnomaly, SalesAnomalies } from '@/types/salesAnomalies';
import metadata from '../../ml/artifacts/sales-isolation-forest-v3/metadata.json';
import daily from '../../ml/artifacts/sales-isolation-forest-v3/daily-results.json';

vi.mock('recharts', () => {
  const Wrapper = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { CartesianGrid: () => null, Line: () => null, LineChart: Wrapper, ResponsiveContainer: Wrapper,
    Tooltip: () => null, XAxis: () => null, YAxis: () => null };
});
const series = daily as DailySalesAnomaly[];
const data = { ...metadata, mode: 'FROZEN', period: { startDate: '2025-10-13', endDate: '2026-10-12' }, series,
  filteredDays: 365, filteredAnomalyCount: 71,
  topAnomalies: series.filter(row => row.isAnomaly).sort((a, b) => a.anomalyScore-b.anomalyScore).slice(0, 20) } as SalesAnomalies;
const envelope = { success: true as const, data };
afterEach(cleanup);

describe('frozen daily sales anomaly panel', () => {
  it('shows actual KPIs, frozen training/analysis dates and descriptive top anomalies', async () => {
    const get = vi.spyOn(apiClient, 'getSalesAnomalies').mockResolvedValue(envelope);
    render(<SalesAnomalyPanel />);
    expect(await screen.findByText(/Modelo exploratorio entrenado con 261 días/)).toBeTruthy();
    expect(screen.getByText(/analiza 365 días/)).toBeTruthy();
    expect(screen.getByText('71')).toBeTruthy();
    expect(screen.getByText(/^19[.,]45%$/)).toBeTruthy();
    expect(screen.getByText(`× ${data.topAnomalies[0].date}`)).toBeTruthy();
    expect(screen.getByText('Ventas históricas y días atípicos')).toBeTruthy();
    expect(screen.queryByText(/accuracy|fraude|sospechosa/i)).toBeNull();
    expect(get).toHaveBeenCalledWith({ limit: 20 });
  });
  it('tooltip exposes evidence and a symbol, not color alone', () => {
    render(<SalesAnomalyTooltip active payload={[{ payload: data.topAnomalies[0] }]} />);
    expect(screen.getByText('Estado: × Comportamiento atípico')).toBeTruthy();
    expect(screen.getByText(/Unidades:/)).toBeTruthy();
    expect(screen.getByText(/Tickets:/)).toBeTruthy();
    expect(screen.getByText(/Ticket promedio:/)).toBeTruthy();
    expect(screen.getByText(/Score:/)).toBeTruthy();
  });
  it('academic help describes unsupervised algorithm and threshold', async () => {
    vi.spyOn(apiClient, 'getSalesAnomalies').mockResolvedValue(envelope);
    render(<SalesAnomalyPanel />);
    await screen.findByText('Metodología del detector');
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda: Isolation Forest' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/aislarse más fácilmente/);
    fireEvent.click(screen.getByText('Metodología del detector'));
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda: Contamination' }));
    expect(screen.getAllByRole('tooltip').some(element => element.textContent?.includes('no fija una tasa objetivo'))).toBe(true);
  });
  it('safe failure retries and empty anomalies remain valid', async () => {
    const normal = series.find(row => !row.isAnomaly)!;
    const get = vi.spyOn(apiClient, 'getSalesAnomalies').mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ success: true, data: { ...data, topAnomalies: [], series: [normal], filteredDays: 1,
        filteredAnomalyCount: 0, period: { startDate: normal.date, endDate: normal.date } } });
    render(<SalesAnomalyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar anomalías' }));
    expect(await screen.findByText('No hay días señalados en el período histórico solicitado.')).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('uses existing authenticated API and never calls ML directly', async () => {
    const client = apiClient as unknown as { instance: { get: (url: string, params: unknown) => Promise<unknown> } };
    const get = vi.spyOn(client.instance, 'get').mockResolvedValue({ data: envelope });
    await apiClient.getSalesAnomalies({ limit: 5, startDate: '2026-10-01', endDate: '2026-10-12' });
    expect(get).toHaveBeenCalledWith('/intelligence/sales/anomalies', { params: { limit: 5, startDate: '2026-10-01', endDate: '2026-10-12' } });
  });
});
