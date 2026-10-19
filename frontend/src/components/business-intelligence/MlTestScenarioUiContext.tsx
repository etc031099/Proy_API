'use client';

import { createContext, useContext, useState } from 'react';
import type { ForecastMlUpdateStatus, ProductInventory } from '@/types/businessIntelligence';

export type MlTestScenario = 'NORMAL' | 'OUTLIER' | 'SHIFT';
export type MlTestForecastObservation = { state: 'AVAILABLE' | 'UNAVAILABLE'; units: number | null };
export type MlTestScenarioSnapshot = { inventory: ProductInventory; ml: ForecastMlUpdateStatus;
  forecast: Record<7 | 14, MlTestForecastObservation>; resetEpoch: string; testCycleId: string | null };
export type MlTestRestoreVerification = { phase: 'VERIFYING' | 'COMPLETE' | 'FAILED'; mode: 'continue' | 'finish';
  scenario: MlTestScenario; baseline: MlTestScenarioSnapshot; observed?: MlTestScenarioSnapshot; message?: string };
type MlTestScenarioUiState = { tab: string; setTab: React.Dispatch<React.SetStateAction<string>>;
  restoreVerification: MlTestRestoreVerification | null; setRestoreVerification: React.Dispatch<React.SetStateAction<MlTestRestoreVerification | null>>;
  restoreScrollPending: boolean; setRestoreScrollPending: React.Dispatch<React.SetStateAction<boolean>>;
  operation: string | null; setOperation: React.Dispatch<React.SetStateAction<string | null>> };

const MlTestScenarioUiContext = createContext<MlTestScenarioUiState | null>(null);

export function MlTestScenarioUiProvider({ children }: { children: React.ReactNode }) {
  const [tab, setTab] = useState('summary');
  const [restoreVerification, setRestoreVerification] = useState<MlTestRestoreVerification | null>(null);
  const [restoreScrollPending, setRestoreScrollPending] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  return <MlTestScenarioUiContext.Provider value={{ tab, setTab, restoreVerification, setRestoreVerification, restoreScrollPending, setRestoreScrollPending, operation, setOperation }}>{children}</MlTestScenarioUiContext.Provider>;
}

export function useMlTestScenarioUiState() {
  const shared = useContext(MlTestScenarioUiContext);
  const [tab, setTab] = useState('summary');
  const [restoreVerification, setRestoreVerification] = useState<MlTestRestoreVerification | null>(null);
  const [restoreScrollPending, setRestoreScrollPending] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  return shared || { tab, setTab, restoreVerification, setRestoreVerification, restoreScrollPending, setRestoreScrollPending, operation, setOperation };
}
