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
  const [boundaryKey, setBoundaryKey] = useState('initial');
  const identityRef = useRef<string | null>(null);
  const unavailableRef = useRef(false);
  const readingRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const mountedRef = useRef(false);
  const lastEventRefreshRef = useRef(0);

  const refresh = useCallback(async function refreshControl(queueIfBusy = false) {
    if (document.visibilityState === 'hidden') return;
    if (readingRef.current) { if (queueIfBusy) refreshQueuedRef.current = true; return; }
    readingRef.current = true;
    try {
      const response = await apiClient.getMlTestControlStatus();
      if (!mountedRef.current) return;
      if (!response.data || response.httpStatus !== 200) throw new Error('Unavailable');
      const next = response.data;
      const nextIdentity = `${next.testCycleId ?? ''}:${next.resetEpoch}:${next.state}`;
      if ((identityRef.current !== null && identityRef.current !== nextIdentity) || unavailableRef.current) {
        apiClient.invalidateIntelligenceReads();
        setBoundaryKey(nextIdentity);
      }
      identityRef.current = nextIdentity;
      setControl(next);
      unavailableRef.current = false;
      setUnavailable(false);
    } catch {
      if (!mountedRef.current) return;
      unavailableRef.current = true;
      setUnavailable(true);
    } finally {
      readingRef.current = false;
      if (refreshQueuedRef.current && mountedRef.current) {
        refreshQueuedRef.current = false;
        void refreshControl(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30000);
    const focus = () => {
      const now = Date.now();
      if (now - lastEventRefreshRef.current < 1000) return;
      lastEventRefreshRef.current = now;
      void refresh();
    };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { mountedRef.current = false; clearInterval(timer); window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);

  // A terminal restore result may arrive before the normal 30-second read.
  // Refresh immediately so the existing epoch boundary can invalidate and
  // remount its subtree; scrolling is owned by the result component itself.
  useEffect(() => {
    if (restoreVerification?.phase === 'COMPLETE' || restoreVerification?.phase === 'FAILED') void refresh(true);
  }, [operation, refresh, restoreVerification?.phase]);

  if (control?.maintenance) return <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
    <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
    <span>{operation || 'Restauración en progreso. Las operaciones están temporalmente bloqueadas.'}</span>
  </div>;
  return <>
    {unavailable && <p role="status" className="mb-3 text-sm text-muted-foreground">No se pudo verificar el estado de prueba. BI sigue disponible; se volverá a consultar automáticamente.</p>}
    {!unavailable && !control && <p role="status" className="mb-3 text-sm text-muted-foreground">Comprobando estado de prueba…</p>}
    <div key={boundaryKey}>{children}</div>
  </>;
}
