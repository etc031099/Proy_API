import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { apiClient } from '@/lib/api';
import { MlTestEpochBoundary, type MlTestControlStatus } from '@/components/business-intelligence/MlTestEpochBoundary';
const control = (resetEpoch = '1', state = 'TEST_ACTIVE'): MlTestControlStatus => ({ resetEpoch, state,
  testCycleId: 'cycle', maintenance: state === 'RESTORING', cloudRestoreEnabled: false });
describe('test epoch boundary', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it('epoch change invalidates cached BI and remounts forecast/inventory/history once; focus refresh without aggressive polling', async () => {
    const read = vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: control() });
    const invalidated = vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
    let mounts = 0;
    function Content() { useEffect(() => { mounts++; }, []); return <p>Fresh BI</p>; }
    await act(async () => { render(<MlTestEpochBoundary><Content /></MlTestEpochBoundary>); });
    expect(mounts).toBe(1); expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(29000); }); expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue({ httpStatus: 200, data: control('2') });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(invalidated).toHaveBeenCalledTimes(2); expect(mounts).toBe(2);
  });
  it('RESTORING hides all previous values and recovery remounts clean data', async () => {
    const read = vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: control() });
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
    await act(async () => { render(<MlTestEpochBoundary><p>Stock 50</p></MlTestEpochBoundary>); });
    expect(screen.getByText('Stock 50')).toBeTruthy();
    read.mockResolvedValue({ httpStatus: 200, data: control('2', 'RESTORING') });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.queryByText('Stock 50')).toBeNull(); expect(screen.getByText('Restableciendo prueba…')).toBeTruthy();
    read.mockResolvedValue({ httpStatus: 200, data: control('2') });
    await act(async () => { vi.advanceTimersByTime(30000); }); expect(screen.getByText('Stock 50')).toBeTruthy();
  });
  it('status error fails closed and unmount cancels refresh timers', async () => {
    const read = vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 503 });
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
    let unmount!: () => void;
    await act(async () => { ({ unmount } = render(<MlTestEpochBoundary><p>Private old value</p></MlTestEpochBoundary>)); });
    expect(screen.queryByText('Private old value')).toBeNull();
    unmount(); await act(async () => { vi.advanceTimersByTime(120000); }); expect(read).toHaveBeenCalledTimes(1);
  });
});
