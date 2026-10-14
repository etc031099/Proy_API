import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntelligenceReadCache } from '@/lib/intelligenceReadCache';
import { apiClient } from '@/lib/api';

const initial = { businessId: 'test-business', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'v1', asOf: '2026-10-14', dataVersion: '0' };
const body = { success: true, data: { total: 80, dataVersion: '0' } };
function fixture() {
  let stamp = { ...initial };
  const revision = vi.fn(async () => ({ ...stamp }));
  const load = vi.fn(async () => structuredClone(body));
  const cache = new IntelligenceReadCache(revision);
  return { cache, revision, load, change: (next: Partial<typeof initial>) => { stamp = { ...stamp, ...next }; } };
}
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem('token'); apiClient.invalidateIntelligenceReads(); });

describe('revision-validated intelligence reads', () => {
  it('reuses the same revision (including zero), but validates it on every revisit', async () => {
    const { cache, revision, load } = fixture();
    const first = await cache.read('customers:limit20', load);
    first.data.total = 123;
    expect((await cache.read('customers:limit20', load)).data.total).toBe(80);
    expect(load).toHaveBeenCalledTimes(1);
    expect(revision).toHaveBeenCalledTimes(3);
  });
  it.each([{ dataVersion: '9007199254740993' }, { asOf: '2026-10-15' }, { datasetVersion: 'v2' }, { businessId: 'other-business' }])('invalidates for changed context %j', async change => {
    const { cache, load, change: update } = fixture();
    await cache.read('customers', load); update(change);
    await cache.read('customers', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('separates periods, filters and entities', async () => {
    const { cache, load } = fixture();
    for (const key of ['sales:TODAY', 'sales:LAST_7_DAYS', 'inventory:HIGH', 'supplier:SUP-01', 'supplier:SUP-02']) await cache.read(key, load);
    expect(load).toHaveBeenCalledTimes(5);
  });
  it('deduplicates simultaneous identical reads and their revision checks', async () => {
    const { cache, revision, load } = fixture();
    const values = await Promise.all([cache.read('health', load), cache.read('health', load)]);
    expect(values[0]).toEqual(values[1]); expect(load).toHaveBeenCalledTimes(1); expect(revision).toHaveBeenCalledTimes(2);
  });
  it('does not return a cached value when revision verification fails', async () => {
    const { cache, revision, load } = fixture();
    await cache.read('health', load);
    revision.mockRejectedValueOnce(new Error('backend unavailable'));
    await expect(cache.read('health', load)).rejects.toThrow('backend unavailable');
    await cache.read('health', load); expect(load).toHaveBeenCalledTimes(2);
  });
  it('rejects a response spanning a revision change and never caches a failed request', async () => {
    const { cache, load, change } = fixture();
    await expect(cache.read('health', async () => { change({ dataVersion: '1' }); return body; })).rejects.toThrow('revision changed');
    await expect(cache.read('health', async () => { throw new Error('ML unavailable'); })).rejects.toThrow('ML unavailable');
    await cache.read('health', load); expect(load).toHaveBeenCalledTimes(1);
  });
  it('invalidates in-flight reads on logout/manual refresh and allows a new read', async () => {
    const { cache, load } = fixture();
    let resolve!: (value: typeof body) => void;
    const task = cache.read('health', () => new Promise<typeof body>(done => { resolve = done; }));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    cache.clear(); resolve(body);
    await expect(task).rejects.toThrow('session changed');
    await cache.read('health', load); expect(load).toHaveBeenCalledTimes(1);
  });
  it('uses the authenticated client, normalized filters, and clears on session replacement', async () => {
    const instance = (apiClient as unknown as { instance: { get: (url: string, config?: unknown) => Promise<unknown> } }).instance;
    localStorage.setItem('token', 'fictitious-session-one');
    const get = vi.spyOn(instance, 'get').mockImplementation(async url => ({ data: url.endsWith('/revision') ? { success: true, data: initial } : body }));
    await apiClient.getCustomersAnalytics({ limit: 20, offset: 0 });
    await apiClient.getCustomersAnalytics({ offset: 0, limit: 20 });
    expect(get.mock.calls.filter(([url]) => url === '/intelligence/customers')).toHaveLength(1);
    localStorage.setItem('token', 'fictitious-session-two');
    await apiClient.getCustomersAnalytics({ limit: 20, offset: 0 });
    expect(get.mock.calls.filter(([url]) => url === '/intelligence/customers')).toHaveLength(2);
  });
  it('revisits Summary → Customers → Suppliers → Health → Customers → Suppliers without repeating analytic requests', async () => {
    const instance = (apiClient as unknown as { instance: { get: (url: string, config?: unknown) => Promise<unknown> } }).instance;
    localStorage.setItem('token', 'fictitious-navigation-session');
    const get = vi.spyOn(instance, 'get').mockImplementation(async url => ({ data: url.endsWith('/revision') ? { success: true, data: initial } : body }));
    const summary = () => Promise.all([apiClient.getBusinessIntelligenceSummary(), apiClient.getInventoryAnalytics({ limit: 20 })]);
    const customers = () => Promise.all([apiClient.getCustomersAnalytics({ limit: 20, offset: 0 }), apiClient.getCustomerClustering()]);
    const suppliers = () => apiClient.getSuppliersAnalytics({ period: 'TODAY', limit: 20, offset: 0 });
    await summary(); await customers(); await suppliers(); await apiClient.getBusinessHealth({ period: 'TODAY', limit: 5 });
    const beforeRevisit = get.mock.calls.filter(([url]) => !url.endsWith('/revision')).length;
    await customers(); await suppliers();
    expect(beforeRevisit).toBe(6);
    // Frozen clustering revalidates its artifact; operational customer/supplier queries are reused.
    expect(get.mock.calls.filter(([url]) => !url.endsWith('/revision'))).toHaveLength(7);
    expect(get.mock.calls.filter(([url]) => url.endsWith('/revision'))).toHaveLength(10);
  });
  it('deduplicates frozen requests without requiring LIVE bootstrap or caching the artifact indefinitely', async () => {
    const { cache, revision, load } = fixture();
    revision.mockRejectedValue(new Error('LIVE bootstrap pending'));
    await Promise.all([cache.read('basket', load, false), cache.read('basket', load, false)]);
    expect(load).toHaveBeenCalledTimes(1); expect(revision).not.toHaveBeenCalled();
    await cache.read('basket', load, false); expect(load).toHaveBeenCalledTimes(2);
  });
});
