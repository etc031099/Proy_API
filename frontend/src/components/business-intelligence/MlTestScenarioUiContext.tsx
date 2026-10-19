'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import type { ForecastMlUpdateStatus, MlTestActivityVerification } from '@/types/businessIntelligence';

export type MlTestGlobalMlBaseline = { dataVersion: string | number;
  horizons: Array<{ horizonDays: 7 | 14; activeModelVersion: number | null; pendingSignalCount: number | null }> };
export type MlTestGlobalBaseline = { checkpointId: string; baselineRevision: string; globalMl: MlTestGlobalMlBaseline | null;
  resetEpoch: string; testCycleId: string };
export type MlTestRestoreVerification = { phase: 'VERIFYING' | 'COMPLETE' | 'FAILED'; mode: 'continue' | 'finish';
  checkpointId: string; baselineRevision: string; resetEpoch: string; testCycleId: string | null;
  baseline: MlTestGlobalMlBaseline | null; observed?: ForecastMlUpdateStatus;
  activity?: MlTestActivityVerification; message?: string };
type MlTestScenarioUiState = { tab: string; setTab: React.Dispatch<React.SetStateAction<string>>;
  baseline: MlTestGlobalBaseline | null; setBaseline: React.Dispatch<React.SetStateAction<MlTestGlobalBaseline | null>>;
  restoreVerification: MlTestRestoreVerification | null; setRestoreVerification: React.Dispatch<React.SetStateAction<MlTestRestoreVerification | null>>;
  restoreScrollPending: boolean; setRestoreScrollPending: React.Dispatch<React.SetStateAction<boolean>>;
  operation: string | null; setOperation: React.Dispatch<React.SetStateAction<string | null>> };

const MlTestScenarioUiContext = createContext<MlTestScenarioUiState | null>(null);
const BASELINE_STORAGE_KEY = 'ml-test-global-baseline:v1';

function isStoredBaseline(value: unknown): value is MlTestGlobalBaseline {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<MlTestGlobalBaseline>;
  if (typeof row.checkpointId !== 'string' || !row.checkpointId || typeof row.testCycleId !== 'string' || !row.testCycleId
      || typeof row.baselineRevision !== 'string' || !/^\d+$/.test(row.baselineRevision)
      || typeof row.resetEpoch !== 'string' || !/^\d+$/.test(row.resetEpoch)) return false;
  if (row.globalMl === null) return true;
  if (!row.globalMl || typeof row.globalMl !== 'object' || String(row.globalMl.dataVersion) !== row.baselineRevision
      || !Array.isArray(row.globalMl.horizons) || row.globalMl.horizons.length !== 2) return false;
  return ([7, 14] as const).every(days => {
    const horizon = row.globalMl!.horizons.find(item => item.horizonDays === days);
    return Boolean(horizon) && (horizon!.activeModelVersion === null
      || (Number.isSafeInteger(horizon!.activeModelVersion) && horizon!.activeModelVersion > 0))
      && (horizon!.pendingSignalCount === null
        || (Number.isSafeInteger(horizon!.pendingSignalCount) && horizon!.pendingSignalCount >= 0));
  });
}

function readStoredBaseline(): MlTestGlobalBaseline | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(BASELINE_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (isStoredBaseline(value)) return value;
    window.sessionStorage.removeItem(BASELINE_STORAGE_KEY);
  } catch { /* Storage may be unavailable; an in-memory baseline still works. */ }
  return null;
}

function usePersistedBaseline() {
  const [baseline, setBaselineState] = useState<MlTestGlobalBaseline | null>(readStoredBaseline);
  const setBaseline = useCallback<React.Dispatch<React.SetStateAction<MlTestGlobalBaseline | null>>>(value => {
    setBaselineState(previous => {
      const next = typeof value === 'function' ? value(previous) : value;
      if (typeof window !== 'undefined') {
        try {
          if (next) window.sessionStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(next));
          else window.sessionStorage.removeItem(BASELINE_STORAGE_KEY);
        } catch { /* Keep the live context usable when storage is unavailable. */ }
      }
      return next;
    });
  }, []);
  return [baseline, setBaseline] as const;
}

export function MlTestScenarioUiProvider({ children }: { children: React.ReactNode }) {
  const [tab, setTab] = useState('summary');
  const [baseline, setBaseline] = usePersistedBaseline();
  const [restoreVerification, setRestoreVerification] = useState<MlTestRestoreVerification | null>(null);
  const [restoreScrollPending, setRestoreScrollPending] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  return <MlTestScenarioUiContext.Provider value={{ tab, setTab, baseline, setBaseline, restoreVerification, setRestoreVerification, restoreScrollPending, setRestoreScrollPending, operation, setOperation }}>{children}</MlTestScenarioUiContext.Provider>;
}

export function useMlTestScenarioUiState() {
  const shared = useContext(MlTestScenarioUiContext);
  const [tab, setTab] = useState('summary');
  const [baseline, setBaseline] = useState<MlTestGlobalBaseline | null>(null);
  const [restoreVerification, setRestoreVerification] = useState<MlTestRestoreVerification | null>(null);
  const [restoreScrollPending, setRestoreScrollPending] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  return shared || { tab, setTab, baseline, setBaseline, restoreVerification, setRestoreVerification, restoreScrollPending, setRestoreScrollPending, operation, setOperation };
}
