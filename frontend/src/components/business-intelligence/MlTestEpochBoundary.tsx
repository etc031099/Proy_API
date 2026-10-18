'use client';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';

export type MlTestControlStatus = { state: string; resetEpoch: string; testCycleId: string | null;
  maintenance: boolean; cloudRestoreEnabled: false };
// Slow, visible-tab-only read + immediate focus refresh. Remounting discards
// component state and makes outstanding responses from the old tree harmless.
export function MlTestEpochBoundary({ children }: { children: React.ReactNode }) {
  const [control, setControl] = useState<MlTestControlStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let disposed = false, reading = false, identity: string | null = null;
    const refresh = async () => {
      if (disposed || reading || document.visibilityState === 'hidden') return;
      reading = true;
      try {
        const response = await apiClient.getMlTestControlStatus();
        if (disposed) return;
        if (!response.data || response.httpStatus !== 200) throw new Error('Unavailable');
        const next = response.data;
        const nextIdentity = `${next.testCycleId ?? ''}:${next.resetEpoch}:${next.state}`;
        if (identity !== nextIdentity) apiClient.invalidateIntelligenceReads();
        identity = nextIdentity; setControl(next); setUnavailable(false);
      } catch {
        if (!disposed) { apiClient.invalidateIntelligenceReads(); setUnavailable(true); }
      } finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus); };
  }, []);
  if (unavailable) return <p role="status">No se pudo verificar el estado de prueba. Se volverá a consultar automáticamente.</p>;
  if (!control) return <p role="status">Comprobando estado de prueba…</p>;
  if (control.maintenance) return <p role="status">{control.state === 'RESTORING' ? 'Restableciendo prueba…' : 'Prueba bloqueada hasta recuperación administrativa.'}</p>;
  return <div key={`${control.testCycleId ?? ''}:${control.resetEpoch}`}>{children}</div>;
}
