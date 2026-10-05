import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DemandForecastPage from '@/app/demand-forecast/page';
import { apiClient, DemandForecastApiError } from '@/lib/api';
import type { ApiResponse, DemandForecastResponse } from '@/types';

vi.mock('@/components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/Layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiClient: { getDemandForecast: vi.fn() } };
});

const product = {
  productId: 'product-1',
  sku: 'M5-FOODS_1_033',
  name: 'Producto de prueba',
  stockAtAnchor: 8,
  salesLast7Days: 4,
  predictedDemand7d: 0.802037,
  safetyStock: 3,
  recommendedQty: 0,
  inventoryStatus: 'OK' as const,
  mlStatus: 'READY',
};

const success = (): ApiResponse<DemandForecastResponse> => ({
  success: true,
  data: {
    status: 'READY',
    model: {
      name: 'demand_forecast_v1', version: '1.0.0', featureSetVersion: 'demand-v1',
      algorithm: 'HistGradientBoostingRegressor', featuresCount: 31, horizonDays: 7,
      execution: 'cloud',
    },
    anchorOperationalDate: '2025-07-01',
    products: [product],
  },
});

const request = vi.mocked(apiClient.getDemandForecast);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('demand forecast page behavior', () => {
  beforeEach(() => request.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('loads and shows prediction results', async () => {
    request.mockResolvedValue(success());
    render(<DemandForecastPage />);

    expect(await screen.findByText('Producto de prueba')).toBeTruthy();
    expect(screen.getByText('Productos listos')).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shows temporary-service guidance and manual retry after a 503', async () => {
    request.mockRejectedValue(new DemandForecastApiError('unavailable', 503));
    render(<DemandForecastPage />);

    expect(await screen.findByText(/está iniciándose o no está disponible temporalmente/i)).toBeTruthy();
    expect(screen.getByText(/puede tardar unos segundos en iniciar/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar predicción' })).toBeTruthy();
  });

  it('retries once, exposes loading, blocks a second click and then renders success', async () => {
    const retry = deferred<ApiResponse<DemandForecastResponse>>();
    request.mockRejectedValueOnce(new DemandForecastApiError('unavailable', 503));
    request.mockReturnValueOnce(retry.promise);
    render(<DemandForecastPage />);

    const button = await screen.findByRole('button', { name: 'Reintentar predicción' });
    fireEvent.click(button);
    expect((await screen.findAllByText('Analizando demanda con el modelo ML…')).length).toBe(2);
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(request).toHaveBeenCalledTimes(2);

    await act(async () => retry.resolve(success()));
    expect(await screen.findByText('Producto de prueba')).toBeTruthy();
    expect(screen.queryByText(/está iniciándose o no está disponible temporalmente/i)).toBeNull();
  });

  it('keeps the temporary error and retry after another 503', async () => {
    request.mockRejectedValue(new DemandForecastApiError('unavailable', 503));
    render(<DemandForecastPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar predicción' }));
    expect(await screen.findByRole('button', { name: 'Reintentar predicción' })).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('shows preparation guidance for HTTP 409 ML_NOT_READY without cold-start retry', async () => {
    request.mockRejectedValue(new DemandForecastApiError('not-ready', 409));
    render(<DemandForecastPage />);
    expect(await screen.findByText(/no cuenta con historial o configuración suficiente/i)).toBeTruthy();
    expect(screen.queryByText(/iniciándose|disponible temporalmente/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reintentar predicción' })).toBeNull();
  });

  it('uses a safe generic message for unknown errors', async () => {
    request.mockRejectedValue(new Error('https://private.internal/path?secret=hidden'));
    render(<DemandForecastPage />);

    expect(await screen.findByText('No se pudo cargar la predicción.')).toBeTruthy();
    expect(screen.queryByText(/El servicio de predicción está iniciándose/i)).toBeNull();
    expect(screen.queryByText(/private\.internal|secret=hidden/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reintentar predicción' })).toBeNull();
  });

  it('handles a valid empty READY response with its existing empty-state message', async () => {
    request.mockResolvedValue({ success: true, data: { status: 'READY', products: [] } });
    render(<DemandForecastPage />);

    expect(await screen.findByText('No hay productos disponibles para analizar.')).toBeTruthy();
    expect(screen.queryByText(/iniciándose o no está disponible temporalmente/i)).toBeNull();
  });

});
