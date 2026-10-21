import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastReplayEvidencePanel } from '@/components/business-intelligence/ForecastReplayEvidencePanel';
import { apiClient } from '@/lib/api';
import type { CertifiedForecastReplayEvidence, ReplayOriginDetail, ReplayOriginsPage } from '@/types/businessIntelligence';
import summary from '../../backend/src/evidence/forecast-replay/cert-stable-2020.json';
import certificate from '../../backend/src/evidence/forecast-replay/cert-stable-2020-detail.json';

function index(selection: { horizonDays: 7 | 14; fold?: string; page?: number }): ReplayOriginsPage {
  const h = certificate.horizons.find(row => row.horizonDays === selection.horizonDays)!;
  const filtered = h.origins.filter(row => !selection.fold || row.fold === selection.fold);
  const page = selection.page ?? 1;
  return { ...certificate, ...h, totalOrigins: h.origins.length, total: filtered.length,
    page, pageSize: 10, totalPages: Math.ceil(filtered.length / 10), certificateSha256: 'fixed',
    items: filtered.slice((page - 1) * 10, page * 10).map(row => ({ ...row,
      candidateMae: row.candidate.mae, baselineMae: row.baseline.mae })) } as unknown as ReplayOriginsPage;
}

describe('certified replay origins explorer', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.spyOn(apiClient, 'getCertifiedForecastReplayEvidence').mockResolvedValue({ httpStatus: 200, data: summary as CertifiedForecastReplayEvidence });
    vi.spyOn(apiClient, 'getCertifiedForecastReplayOrigins').mockImplementation(async selection => ({ httpStatus: 200, data: index(selection) }));
    vi.spyOn(apiClient, 'getCertifiedForecastReplayOrigin').mockImplementation(async (origin, horizon) => {
      const data = certificate.horizons.find(row => row.horizonDays === horizon)!.origins.find(row => row.origin === origin);
      return data ? { httpStatus: 200, data: { ...certificate, horizonDays: horizon, ...data } as unknown as ReplayOriginDetail } : { httpStatus: 400 };
    });
  });
  async function explore() {
    render(<ForecastReplayEvidencePanel />);
    fireEvent.click(await screen.findByText('Ver evaluación completa'));
    const button = await screen.findByRole('button', { name: 'Explorar evidencia' });
    fireEvent.click(button);
    await screen.findByText(/107 orígenes maduros ·/);
    return screen.getByRole('region', { name: 'Explorador de orígenes certificados' });
  }

  it('preserves summary, lazily reads ten origins, and exposes real fold names/counts and a selectable compact flow', async () => {
    render(<ForecastReplayEvidencePanel />);
    fireEvent.click(await screen.findByText('Ver evaluación completa'));
    const open = await screen.findByRole('button', { name: 'Explorar evidencia' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(apiClient.getCertifiedForecastReplayOrigins).not.toHaveBeenCalled();
    fireEvent.click(open);
    const explorer = await screen.findByRole('region', { name: 'Explorador de orígenes certificados' });
    await within(explorer).findByText('31 orígenes');
    expect(within(explorer).getByText('30 orígenes')).toBeTruthy();
    expect(within(explorer).getByText('46 orígenes')).toBeTruthy();
    expect(within(explorer).getByText(/No representa una venta/)).toBeTruthy();
    expect(within(explorer).getByText('Fold 2 · clave F3')).toBeTruthy();
    expect(within(explorer).getAllByRole('row')).toHaveLength(11);
    fireEvent.click(within(explorer).getByRole('button', { name: '3. Folds temporales' }));
    expect(within(explorer).getByText(/no son 107 muestras independientes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Promover|Aplicar candidato|Ejecutar replay/i })).toBeNull();
    expect(screen.getAllByText('APROBADO').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RECHAZADO').length).toBeGreaterThan(0);
  });

  it('paginates, filters folds, selects a real origin and keeps horizons separate', async () => {
    const explorer = await explore();
    fireEvent.click(within(explorer).getByRole('button', { name: 'Siguiente' }));
    await waitFor(() => expect(apiClient.getCertifiedForecastReplayOrigins).toHaveBeenLastCalledWith({ horizonDays: 7, page: 2, fold: undefined }));
    await within(explorer).findByText(/Página 2 de 11/);
    expect(within(explorer).queryByRole('button', { name: '2026-04-17' })).toBeNull();
    fireEvent.change(within(explorer).getByLabelText('Fold'), { target: { value: 'F3' } });
    await within(explorer).findByText(/Página 1 de 3/);
    fireEvent.click(within(explorer).getByRole('button', { name: '2026-05-18' }));
    const detail = await within(explorer).findByRole('region', { name: 'Detalle del origen' });
    expect(within(detail).getByRole('heading').textContent).toContain('7 días');
    expect(within(detail).getByText(/80 pares SKU\/origen/)).toBeTruthy();
    expect(apiClient.getCertifiedForecastReplayOrigin).toHaveBeenLastCalledWith('2026-05-18', 7);
    fireEvent.change(within(explorer).getByLabelText('Horizonte histórico'), { target: { value: '14' } });
    await within(explorer).findByText(/107 orígenes maduros ·.*14d/);
    expect(within(explorer).queryByRole('region', { name: 'Detalle del origen' })).toBeNull();
    fireEvent.click(within(explorer).getByRole('button', { name: '2026-04-17' }));
    expect((await within(explorer).findByRole('region', { name: 'Detalle del origen' })).textContent).toContain('14 días');
    expect(apiClient.getCertifiedForecastReplayOrigin).toHaveBeenLastCalledWith('2026-04-17', 14);
  });

  it('opens the authoritative 14d F3 veto directly with real support, MAE ratio and threshold', async () => {
    const explorer = await explore();
    fireEvent.click(within(explorer).getByRole('button', { name: 'Ver evidencia del rechazo 14d' }));
    const focal = await within(explorer).findByRole('region', { name: 'Evidencia focal del rechazo' });
    expect(focal.textContent).toContain('BEB-GAS-003');
    expect(focal.textContent).toContain('30 orígenes');
    expect(focal.textContent).toContain('221 unidades observadas únicas');
    expect(focal.textContent).toMatch(/2[,.]674 \/ 1[,.]5/);
    expect(within(focal).getByText('P_FOLD_CATA_MAE:F3:BEB-GAS-003')).toBeTruthy();
    expect(apiClient.getCertifiedForecastReplayOrigins).toHaveBeenLastCalledWith({ horizonDays: 14, fold: 'F3', page: 1 });
    expect(within(explorer).getByText(/Ninguna de estas decisiones modifica el modelo LIVE/)).toBeTruthy();
  });

  it('loads a selected date on demand and reports dates outside the certificate without inventing detail', async () => {
    const explorer = await explore();
    fireEvent.change(within(explorer).getByLabelText('Fecha de origen'), { target: { value: '2026-08-02' } });
    fireEvent.click(within(explorer).getByRole('button', { name: 'Abrir origen' }));
    expect(await within(explorer).findByRole('alert')).toBeTruthy();
    expect(within(explorer).queryByRole('region', { name: 'Detalle del origen' })).toBeNull();
  });

  it('keeps the original summary usable during explorer loading and error', async () => {
    let resolve!: (value: { httpStatus: number }) => void;
    vi.mocked(apiClient.getCertifiedForecastReplayOrigins).mockReturnValue(new Promise(done => { resolve = done; }));
    render(<ForecastReplayEvidencePanel />);
    fireEvent.click(await screen.findByText('Ver evaluación completa'));
    fireEvent.click(await screen.findByRole('button', { name: 'Explorar evidencia' }));
    expect(screen.getByText('Cargando orígenes certificados…')).toBeTruthy();
    expect(screen.getAllByText('APROBADO').length).toBeGreaterThan(0);
    resolve({ httpStatus: 503 });
    expect(await screen.findByText(/No se pudieron cargar los orígenes/)).toBeTruthy();
    expect(screen.getAllByText('RECHAZADO').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar explorador de evidencia' }));
    expect(screen.queryByRole('region', { name: 'Explorador de orígenes certificados' })).toBeNull();
  });
});
