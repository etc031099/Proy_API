import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import { MlTestEpochBoundary, type MlTestControlStatus } from '@/components/business-intelligence/MlTestEpochBoundary';
import { MlTestScenarioUiProvider, useMlTestScenarioUiState, type MlTestRestoreVerification } from '@/components/business-intelligence/MlTestScenarioUiContext';
const control = (resetEpoch = '1', state = 'TEST_ACTIVE', testCycleId: string | null = 'cycle'): MlTestControlStatus => ({ resetEpoch, state,
  testCycleId, maintenance: state === 'RESTORING', cloudRestoreEnabled: false });
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
    expect(screen.queryByText('Stock 50')).toBeNull(); expect(screen.getByText('Restauración en progreso. Las operaciones están temporalmente bloqueadas.')).toBeTruthy();
    read.mockResolvedValue({ httpStatus: 200, data: control('2') });
    await act(async () => { vi.advanceTimersByTime(30000); }); expect(screen.getByText('Stock 50')).toBeTruthy();
  });
  it('keeps the Prediction tab selected when a new restore epoch remounts the dashboard subtree', async () => {
    const read = vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: control('1') });
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
    function TabStateProbe() {
      const { tab, setTab } = useMlTestScenarioUiState();
      return <><button type="button" onClick={() => setTab('forecast')}>Predicción</button><p>Tab actual: {tab}</p></>;
    }
    await act(async () => { render(<MlTestScenarioUiProvider><MlTestEpochBoundary><TabStateProbe /></MlTestEpochBoundary></MlTestScenarioUiProvider>); });
    fireEvent.click(screen.getByRole('button', { name: 'Predicción' }));
    expect(screen.getByText('Tab actual: forecast')).toBeTruthy();
    read.mockResolvedValueOnce({ httpStatus: 200, data: control('2') });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.getByText('Tab actual: forecast')).toBeTruthy();
    read.mockResolvedValue({ httpStatus: 200, data: control('3', 'NO_TEST', null) });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.getByText('Tab actual: forecast')).toBeTruthy();
  });
  it.each([
    ['continue', control('2', 'TEST_ACTIVE', 'cycle')],
    ['finish', control('2', 'NO_TEST', null)],
  ] as const)('%s restore scrolls to its result only after the post-epoch tree mounts', async (mode, restoredControl) => {
    const read = vi.spyOn(apiClient, 'getMlTestControlStatus')
      .mockResolvedValueOnce({ httpStatus: 200, data: control('1') })
      .mockResolvedValue({ httpStatus: 200, data: restoredControl });
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
    let mounts = 0;
    const scroll = vi.fn(() => {
      expect(screen.getByText('Árbol montado 2')).toBeTruthy();
      expect(screen.getByText('Tab actual: forecast')).toBeTruthy();
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const baseline = {} as MlTestRestoreVerification['baseline'];
    function RestoreProbe() {
      const { tab, setTab, setRestoreVerification } = useMlTestScenarioUiState();
      const [instance] = useState(() => ++mounts);
      return <>
        <button type="button" onClick={() => setTab('forecast')}>Select Prediction</button>
        <p>Tab actual: {tab}</p><p>Árbol montado {instance}</p>
        <button type="button" onClick={() => setRestoreVerification({ phase: 'VERIFYING', mode, scenario: 'NORMAL', baseline })}>Start restore</button>
        <button type="button" onClick={() => setRestoreVerification(previous => previous ? { ...previous, phase: 'COMPLETE' } : null)}>Complete restore</button>
        <div id="ml-test-restore-result">Restore result</div>
      </>;
    }

    await act(async () => { render(<MlTestScenarioUiProvider><MlTestEpochBoundary><RestoreProbe /></MlTestEpochBoundary></MlTestScenarioUiProvider>); });
    expect(mounts).toBe(1);
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Select Prediction' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    expect(scroll).not.toHaveBeenCalled();
    read.mockResolvedValue({ httpStatus: 200, data: restoredControl });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete restore' })); });

    expect(mounts).toBe(2);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Tab actual: forecast')).toBeTruthy();
  });
  it('scrolls to a failed restore result after the operation ends without an epoch transition', async () => {
    const read = vi.spyOn(apiClient, 'getMlTestControlStatus').mockResolvedValue({ httpStatus: 200, data: control('1') });
    vi.spyOn(apiClient, 'invalidateIntelligenceReads').mockImplementation(() => {});
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const baseline = {} as MlTestRestoreVerification['baseline'];
    function FailedRestoreProbe() {
      const { setRestoreVerification, setOperation } = useMlTestScenarioUiState();
      return <>
        <button type="button" onClick={() => { setOperation('Restaurando…'); setRestoreVerification({ phase: 'VERIFYING', mode: 'continue', scenario: 'NORMAL', baseline }); }}>Start restore</button>
        <button type="button" onClick={() => setRestoreVerification(previous => previous ? { ...previous, phase: 'FAILED', message: 'No se pudo verificar' } : null)}>Fail verification</button>
        <button type="button" onClick={() => setOperation(null)}>Finish operation</button>
        <div id="ml-test-restore-result">Restore result</div>
      </>;
    }
    await act(async () => { render(<MlTestScenarioUiProvider><MlTestEpochBoundary><FailedRestoreProbe /></MlTestEpochBoundary></MlTestScenarioUiProvider>); });
    fireEvent.click(screen.getByRole('button', { name: 'Start restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fail verification' }));
    expect(scroll).not.toHaveBeenCalled();
    read.mockResolvedValue({ httpStatus: 200, data: control('1') });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Finish operation' })); });
    expect(scroll).toHaveBeenCalledTimes(1);
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
