import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';

describe('authenticated forecast diagnostics API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads local test activity through the authenticated client with only cursor pagination', async () => {
    const instance = (apiClient as unknown as { instance: { get: (path: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ status: 200, data: { success: true, data: { products: [] } } });
    await expect(apiClient.getMlTestActivity({ limit: 20, cursor: 'opaque' })).resolves.toMatchObject({ httpStatus: 200, data: { products: [] } });
    expect(get).toHaveBeenCalledWith('/ml-test/activity', expect.objectContaining({ params: { limit: 20, cursor: 'opaque' }, timeout: 15000 }));
  });

  it('gets forecast model diagnostics through the existing authenticated Axios instance', async () => {
    const instance = (apiClient as unknown as { instance: { get: (path: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ status: 200, data: { success: true, data: { models: [] } } });
    const result = await apiClient.getForecastModelDiagnostics();
    expect(result).toMatchObject({ httpStatus: 200, data: { models: [] } });
    expect(get).toHaveBeenCalledWith('/intelligence/forecast/models/active', expect.objectContaining({ timeout: 15_000, validateStatus: expect.any(Function) }));
    expect((get.mock.calls[0][1] as { validateStatus: (status: number) => boolean }).validateStatus(401)).toBe(true);
  });

  it('gets Health diagnostics through the same shared client', async () => {
    const instance = (apiClient as unknown as { instance: { get: (path: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ status: 200, data: { success: true, data: { httpStatus: 200 } } });
    const result = await apiClient.getHealthDiagnostics();
    expect(result).toMatchObject({ httpStatus: 200, data: { httpStatus: 200 } });
    expect(get).toHaveBeenCalledWith('/intelligence/health/diagnostics', expect.objectContaining({ timeout: 15_000 }));
  });

  it('reads the manual update status through the authenticated client', async () => {
    const instance = (apiClient as unknown as { instance: { get: (path: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ status: 200,
      data: { success: true, data: { dataVersion: '83', closedThrough: '2026-10-16', horizons: [] } } });
    await expect(apiClient.getForecastMlUpdateStatus()).resolves.toMatchObject({ httpStatus: 200,
      data: { dataVersion: '83' } });
    expect(get).toHaveBeenCalledWith('/intelligence/forecast/ml-update/status', expect.objectContaining({ timeout: 15_000 }));
  });

  it('posts only the fixed 7d/14d horizon payload to the local ML test analysis route', async () => {
    const instance = (apiClient as unknown as { instance: { post: (path: string, body: unknown, config?: unknown) => Promise<unknown> } }).instance;
    const post = vi.spyOn(instance, 'post').mockResolvedValue({ status: 200,
      data: { success: true, data: { horizonDays: 7, testCycleId: 'cycle', resetEpoch: '4' } } });
    await expect(apiClient.analyzeMlTestScenario(7)).resolves.toMatchObject({ httpStatus: 200, data: { horizonDays: 7 } });
    expect(post).toHaveBeenCalledWith('/ml-test/analyze', { horizonDays: 7 },
      expect.objectContaining({ timeout: 180_000, validateStatus: expect.any(Function) }));
  });

  it('posts exactly an empty body and sanitizes API failures', async () => {
    const instance = (apiClient as unknown as { instance: { post: (path: string, body: unknown, config?: unknown) => Promise<unknown> } }).instance;
    const post = vi.spyOn(instance, 'post').mockResolvedValueOnce({ status: 202,
      data: { success: true, data: { requestStatus: 'REQUEST_ACCEPTED', dispatchStatus: 'DISPATCHED' } } })
      .mockResolvedValueOnce({ status: 429, data: { success: false, code: 'ML_UPDATE_RATE_LIMITED', message: 'private' } });
    await expect(apiClient.requestForecastMlUpdate()).resolves.toMatchObject({ httpStatus: 202,
      data: { requestStatus: 'REQUEST_ACCEPTED' } });
    expect(post).toHaveBeenNthCalledWith(1, '/intelligence/forecast/ml-update/request', {},
      expect.objectContaining({ timeout: 90_000, validateStatus: expect.any(Function) }));
    await expect(apiClient.requestForecastMlUpdate()).resolves.toMatchObject({ httpStatus: 429, code: 'ML_UPDATE_RATE_LIMITED' });
    expect(post.mock.calls[0][1]).toEqual({});
  });

  it('normalizes 401, 503 and network failures without exposing error internals', async () => {
    const instance = (apiClient as unknown as { instance: { get: (path: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get');
    get.mockResolvedValueOnce({ status: 401, data: { success: false, code: 'AUTH_REQUIRED', message: 'private detail' } });
    const unauthorized = await apiClient.getForecastModelDiagnostics();
    expect(unauthorized).toMatchObject({ httpStatus: 401, code: 'AUTH_REQUIRED' });
    expect(JSON.stringify(unauthorized)).not.toContain('private detail');
    get.mockResolvedValueOnce({ status: 503, data: { success: false, code: 'SERVICE_UNAVAILABLE', message: 'private detail' } });
    const unavailable = await apiClient.getHealthDiagnostics();
    expect(unavailable).toMatchObject({ httpStatus: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(unavailable)).not.toContain('private detail');
    get.mockRejectedValueOnce(new Error('private transport detail'));
    await expect(apiClient.getHealthDiagnostics()).resolves.toEqual({ httpStatus: 0, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' });
  });
});
