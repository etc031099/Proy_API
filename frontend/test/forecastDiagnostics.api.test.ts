import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';

describe('authenticated forecast diagnostics API', () => {
  afterEach(() => vi.restoreAllMocks());

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
