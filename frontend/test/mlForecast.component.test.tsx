import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

// DOM behavior tests assert the displayed data; chart sizing is checked in a real browser.
vi.mock('recharts', async importOriginal => ({
  ...await importOriginal<typeof import('recharts')>(),
  ResponsiveContainer: () => null,
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

    expect(await screen.findByRole('button', { name: 'Ver detalle de Producto de prueba' })).toBeTruthy();
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
    expect(await screen.findByRole('button', { name: 'Ver detalle de Producto de prueba' })).toBeTruthy();
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

  it('searches a SKU, selects its detail and shows a deterministic explanation from batch values', async () => {
    const response = success();
    response.data!.products!.push({ ...product, productId: 'product-2', sku: 'DEMO-MILK', name: 'Leche de prueba', predictedDemand7d: 48.75, stockAtAnchor: 26, salesLast7Days: 22, safetyStock: 9.75, recommendedQty: 41, inventoryStatus: 'REPONER' });
    request.mockResolvedValue(response);
    render(<DemandForecastPage />);
    await screen.findByLabelText('Buscar producto o SKU');
    fireEvent.change(screen.getByLabelText('Buscar producto o SKU'), { target: { value: 'demo-milk' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Seleccionar producto' })).getByRole('button', { name: 'Leche de prueba · DEMO-MILK' }));
    const detail = within(screen.getByRole('region', { name: 'Detalle de producto' }));
    expect(detail.getByRole('heading', { name: 'Leche de prueba' })).toBeTruthy();
    expect(detail.getByText(/SKU: DEMO-MILK · Ancla: 1\/7\/2025/)).toBeTruthy();
    expect(detail.getByText(/El modelo estima una demanda de 48.75 unidades/)).toBeTruthy();
    expect(detail.getByText(/recomienda reponer 41 unidades/)).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Resultados de predicción' })).queryByRole('button', { name: 'Ver detalle de Producto de prueba' })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('filters and sorts the table while keeping the full-batch KPIs unchanged', async () => {
    const response = success();
    response.data!.products!.push({ ...product, productId: 'product-2', sku: 'HIGH', name: 'Demanda alta', predictedDemand7d: 30, recommendedQty: 28, inventoryStatus: 'REPONER' });
    request.mockResolvedValue(response);
    render(<DemandForecastPage />);
    await screen.findByLabelText('Ordenar por');
    fireEvent.change(screen.getByLabelText('Ordenar por'), { target: { value: 'predictedDemand7d' } });
    const table = within(screen.getByRole('table', { name: 'Resultados de predicción' }));
    expect(table.getAllByRole('row')[1].textContent).toContain('Demanda alta');
    fireEvent.change(screen.getByLabelText('Filtrar por estado'), { target: { value: 'OK' } });
    expect(table.queryByRole('button', { name: 'Ver detalle de Demanda alta' })).toBeNull();
    expect(screen.getByText('1 de 2 productos visibles. Los totales globales no cambian con los filtros.')).toBeTruthy();
    const kpis = within(screen.getByRole('region', { name: 'Resumen ML' }));
    expect(kpis.getByText('Productos analizados').parentElement?.textContent).toBe('Productos analizados2');
    expect(kpis.getByText('Reposición sugerida total').parentElement?.textContent).toBe('Reposición sugerida total28');
  });

  it('opens detail from a table row and preserves an unavailable prediction as missing', async () => {
    const response = success();
    response.data!.products!.push({ ...product, productId: 'new', sku: 'NEW', name: 'Producto nuevo', mlStatus: 'INSUFFICIENT_HISTORY', inventoryStatus: 'ML_NO_DISPONIBLE', predictedDemand7d: null, safetyStock: null, recommendedQty: null });
    request.mockResolvedValue(response);
    render(<DemandForecastPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalle de Producto nuevo' }));
    const detail = within(screen.getByRole('region', { name: 'Detalle de producto' }));
    expect(detail.getByText(/aún no dispone de una predicción válida/)).toBeTruthy();
    expect(detail.getAllByText('—')).toHaveLength(3);
    expect(detail.queryByText(/recomienda reponer 0 unidades/)).toBeNull();
  });

  it('keeps sixty READY products and their original predictions/recommendations with one batch request', async () => {
    const response = success();
    response.data!.products = Array.from({ length: 60 }, (_, index) => ({ ...product, productId: `id-${index}`, sku: `SKU-${index}`, name: `Producto ${index}` }));
    const original = JSON.stringify(response);
    request.mockResolvedValue(response);
    render(<DemandForecastPage />);
    await screen.findByRole('button', { name: 'Ver detalle de Producto 59' });
    const kpis = within(screen.getByRole('region', { name: 'Resumen ML' }));
    expect(kpis.getByText('Productos listos').parentElement?.textContent).toBe('Productos listos60');
    expect(within(screen.getByRole('table', { name: 'Resultados de predicción' })).getAllByRole('row')).toHaveLength(61);
    expect(JSON.stringify(response)).toBe(original);
    expect(request).toHaveBeenCalledTimes(1);
  });

});
