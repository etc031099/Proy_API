import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiClient, DemandForecastApiError } from '@/lib/api';

describe('demand forecast API error mapping', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves a sanitized 409 ML_NOT_READY classification', async () => {
    const instance = (apiClient as unknown as {
      instance: { get: (url: string, config?: unknown) => Promise<unknown> };
    }).instance;
    vi.spyOn(instance, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { code: 'ML_NOT_READY', message: 'private backend detail' } },
    });

    await expect(apiClient.getDemandForecast()).rejects.toMatchObject({
      name: 'DemandForecastApiError', category: 'not-ready', status: 409, code: 'ML_NOT_READY',
      message: 'Demand forecast request failed',
    });
  });

  it('preserves a sanitized 503 ML_SERVICE_UNAVAILABLE classification', async () => {
    const instance = (apiClient as unknown as {
      instance: { get: (url: string, config?: unknown) => Promise<unknown> };
    }).instance;
    vi.spyOn(instance, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status: 503, data: { code: 'ML_SERVICE_UNAVAILABLE', detail: 'private internal URL' } },
    });

    await expect(apiClient.getDemandForecast()).rejects.toMatchObject({
      name: 'DemandForecastApiError', category: 'unavailable', status: 503,
      code: 'ML_SERVICE_UNAVAILABLE', message: 'Demand forecast request failed',
    });
  });

  it('does not misclassify an unrelated status or backend error code', async () => {
    const instance = (apiClient as unknown as {
      instance: { get: (url: string, config?: unknown) => Promise<unknown> };
    }).instance;
    const get = vi.spyOn(instance, 'get');
    const unrelated = { isAxiosError: true, response: { status: 409, data: { code: 'OTHER' } } };
    get.mockRejectedValueOnce(unrelated);
    await expect(apiClient.getDemandForecast()).rejects.toBe(unrelated);
    const wrongStatus = { isAxiosError: true, response: { status: 500, data: { code: 'ML_SERVICE_UNAVAILABLE' } } };
    get.mockRejectedValueOnce(wrongStatus);
    await expect(apiClient.getDemandForecast()).rejects.toBe(wrongStatus);
  });

  it('exports the typed UI error categories', () => {
    expect(new DemandForecastApiError('not-ready', 409)).toMatchObject({
      category: 'not-ready', status: 409, code: 'ML_NOT_READY',
    });
  });
});
