import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';

describe('authenticated ML update history API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requests cursor-based list pages through the authenticated diagnostic client', async () => {
    const instance = (apiClient as unknown as { instance: { get: (path: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ status: 200,
      data: { success: true, data: { items: [], page: { limit: 20, nextCursor: 'opaque' } } } });
    await expect(apiClient.getForecastMlUpdateHistory({ limit: 20, cursor: 'opaque' })).resolves.toMatchObject({
      httpStatus: 200, data: { page: { nextCursor: 'opaque' } },
    });
    expect(get).toHaveBeenCalledWith('/intelligence/forecast/ml-update/history', expect.objectContaining({
      params: { limit: 20, cursor: 'opaque' }, timeout: 15_000, validateStatus: expect.any(Function),
    }));
  });

  it('encodes execution IDs and uses separate detail and products endpoints', async () => {
    const instance = (apiClient as unknown as { instance: { get: (path: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ status: 200, data: { success: true, data: {} } });
    await apiClient.getForecastMlUpdateExecution('execution/id');
    await apiClient.getForecastMlUpdateProducts('execution/id', { limit: 25, cursor: 'next-page' });
    expect(get).toHaveBeenNthCalledWith(1, '/intelligence/forecast/ml-update/history/execution%2Fid', expect.objectContaining({
      timeout: 15_000, validateStatus: expect.any(Function),
    }));
    expect(get).toHaveBeenNthCalledWith(2, '/intelligence/forecast/ml-update/history/execution%2Fid/products', expect.objectContaining({
      params: { limit: 25, cursor: 'next-page' }, timeout: 15_000, validateStatus: expect.any(Function),
    }));
  });

  it('sanitizes history API failures without exposing server messages', async () => {
    const instance = (apiClient as unknown as { instance: { get: (path: string, config?: unknown) => Promise<unknown> } }).instance;
    vi.spyOn(instance, 'get').mockResolvedValue({ status: 503,
      data: { success: false, code: 'ML_HISTORY_UNAVAILABLE', message: 'private database detail' } });
    const result = await apiClient.getForecastMlUpdateHistory();
    expect(result).toMatchObject({ httpStatus: 503, code: 'ML_HISTORY_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('private database detail');
  });
});
