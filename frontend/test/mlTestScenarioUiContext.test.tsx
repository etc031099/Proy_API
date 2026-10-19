import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MlTestScenarioUiProvider, useMlTestScenarioUiState } from '@/components/business-intelligence/MlTestScenarioUiContext';

const baseline = { checkpointId: 'checkpoint-a', testCycleId: 'cycle-a', baselineRevision: '173', resetEpoch: '4',
  globalMl: { dataVersion: '173', horizons: [
    { horizonDays: 7 as const, activeModelVersion: 1, pendingSignalCount: 90 },
    { horizonDays: 14 as const, activeModelVersion: 1, pendingSignalCount: 90 },
  ] } };

function BaselineHarness() {
  const state = useMlTestScenarioUiState();
  return <><p>{state.baseline?.checkpointId || 'baseline-none'}</p>
    <button onClick={() => state.setBaseline(baseline)}>Save baseline</button>
    <button onClick={() => state.setBaseline(null)}>Clear baseline</button></>;
}

describe('MlTestScenarioUiContext global baseline persistence', () => {
  afterEach(() => { cleanup(); window.sessionStorage.clear(); });

  it('persists only the compact global values and restores them in a new provider mount', () => {
    const first = render(<MlTestScenarioUiProvider><BaselineHarness /></MlTestScenarioUiProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Save baseline' }));
    expect(screen.getByText('checkpoint-a')).toBeTruthy();
    const stored = JSON.parse(window.sessionStorage.getItem('ml-test-global-baseline:v1') || 'null');
    expect(stored).toEqual(baseline);
    first.unmount();

    render(<MlTestScenarioUiProvider><BaselineHarness /></MlTestScenarioUiProvider>);
    expect(screen.getByText('checkpoint-a')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear baseline' }));
    expect(window.sessionStorage.getItem('ml-test-global-baseline:v1')).toBeNull();
  });

  it('discards malformed or internally inconsistent stored baselines', () => {
    window.sessionStorage.setItem('ml-test-global-baseline:v1', JSON.stringify({ ...baseline,
      globalMl: { ...baseline.globalMl, dataVersion: '172' } }));
    render(<MlTestScenarioUiProvider><BaselineHarness /></MlTestScenarioUiProvider>);
    expect(screen.getByText('baseline-none')).toBeTruthy();
    expect(window.sessionStorage.getItem('ml-test-global-baseline:v1')).toBeNull();
  });
});
