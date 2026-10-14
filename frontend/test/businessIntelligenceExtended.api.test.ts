import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';

describe('extended business intelligence API uses the shared authenticated client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps all extended GET endpoints and safely encodes entity references', async () => {
    const instance = (apiClient as unknown as { instance: { get: (url: string, config?: unknown) => Promise<unknown> } }).instance;
    const get = vi.spyOn(instance, 'get').mockResolvedValue({ data: { success: true, data: {} } });
    await apiClient.getSalesAnalytics({ period: 'LAST_7_DAYS', includeSeries: true, compare: true, limit: 10 });
    await apiClient.getCustomersAnalytics({ limit: 20, offset: 0 });
    await apiClient.getCustomerAnalytics('CUS/01');
    await apiClient.getSuppliersAnalytics({ period: 'LAST_30_DAYS', limit: 20, offset: 0 });
    await apiClient.getSupplierAnalytics('SUP 05');
    await apiClient.getAssociations({ limit: 10, offset: 0 });
    await apiClient.getRelatedProducts('PAN-FRE-001');
    await apiClient.getBusinessHealth({ period: 'TODAY', limit: 5 });
    await apiClient.getInventoryAnalytics({ limit: 20, flag: 'slow_moving' });

    expect(get.mock.calls.map(([url]) => url)).toEqual([
      '/intelligence/sales', '/intelligence/customers', '/intelligence/customers/CUS%2F01',
      '/intelligence/suppliers', '/intelligence/suppliers/SUP%2005', '/intelligence/associations',
      '/intelligence/products/PAN-FRE-001/related', '/intelligence/health', '/intelligence/inventory',
    ]);
    expect(get.mock.calls[0]?.[1]).toEqual({ params: { period: 'LAST_7_DAYS', includeSeries: true, compare: true, limit: 10 } });
    expect(get.mock.calls[8]?.[1]).toEqual({ params: { limit: 20, flag: 'slow_moving' } });
  });
});
