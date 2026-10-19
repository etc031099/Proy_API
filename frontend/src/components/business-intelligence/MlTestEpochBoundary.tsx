'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { apiClient } from '@/lib/api';
import type { MlTestControlStatus } from '@/types/businessIntelligence';
import { useMlTestScenarioUiState } from './MlTestScenarioUiContext';
export type { MlTestControlStatus } from '@/types/businessIntelligence';
// Slow, visible-tab-only read + immediate focus refresh. Remounting discards
// component state and makes outstanding responses from the old tree harmless.
export function MlTestEpochBoundary({ children }: { children: React.ReactNode }) {
  const { operation, restoreVerification } = useMlTestScenarioUiState();
  const [control, setControl] = useState<MlTestControlStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const identityRef = useRef<string | null>(null);
  const renderedIdentityRef = useRef<string | null>(null);
  const readingRef = useRef(false);
  const mountedRef = useRef(false);
  const restoreWasVerifyingRef = useRef(restoreVerification?.phase === 'VERIFYING');
  const scrolledRestoreRef = useRef<typeof restoreVerification>(null);

  const refresh = useCallback(async () => {
    if (document.visibilityState === 'hidden' || readingRef.current) return;
    readingRef.current = true;
    try {
      const response = await apiClient.getMlTestControlStatus();
      if (!mountedRef.current) return;
      if (!response.data || response.httpStatus !== 200) throw new Error('Unavailable');
      const next = response.data;
      const nextIdentity = `${next.testCycleId ?? ''}:${next.resetEpoch}:${next.state}`;
      if (identityRef.current !== nextIdentity) apiClient.invalidateIntelligenceReads();
      identityRef.current = nextIdentity;
      setControl(next);
      setUnavailable(false);
    } catch {
      if (!mountedRef.current) return;
      apiClient.invalidateIntelligenceReads();
      setUnavailable(true);
    } finally { readingRef.current = false; }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { mountedRef.current = false; clearInterval(timer); window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);

  // A terminal restore result may arrive before the epoch boundary's own
  // 30-second refresh. Read the new control immediately so its keyed subtree
  // remounts before we try to scroll to the result.
  useEffect(() => {
    if (restoreVerification?.phase === 'COMPLETE' || restoreVerification?.phase === 'FAILED') void refresh();
  }, [operation, refresh, restoreVerification?.phase]);

  useEffect(() => {
    if (restoreVerification?.phase === 'VERIFYING') restoreWasVerifyingRef.current = true;
    if (!control) return;

    const identity = `${control.testCycleId ?? ''}:${control.resetEpoch}`;
    // The control identity is set by refresh before React commits this effect,
    // so keep a separate identity for the last committed subtree.
    const lastRenderedIdentity = renderedIdentityRef.current;
    renderedIdentityRef.current = identity;
    const epochChanged = lastRenderedIdentity !== null && lastRenderedIdentity !== identity;
    const terminal = restoreVerification?.phase === 'COMPLETE' || restoreVerification?.phase === 'FAILED';
    const failedWithoutEpochChange = restoreVerification?.phase === 'FAILED' && operation === null
      && restoreWasVerifyingRef.current;
    if (!terminal || (!epochChanged && !failedWithoutEpochChange) || scrolledRestoreRef.current === restoreVerification) return;

    scrolledRestoreRef.current = restoreVerification;
    restoreWasVerifyingRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById('ml-test-restore-result') || document.getElementById('ml-test-controls');
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [control, operation, restoreVerification]);
  if (unavailable) return <p role="status">No se pudo verificar el estado de prueba. Se volverá a consultar automáticamente.</p>;
  if (!control) return <p role="status">Comprobando estado de prueba…</p>;
  if (control.maintenance) return <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
    <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
    <span>{operation || 'Restauración en progreso. Las operaciones están temporalmente bloqueadas.'}</span>
  </div>;
  return <div key={`${control.testCycleId ?? ''}:${control.resetEpoch}`}>{children}</div>;
}
