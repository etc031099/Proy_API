'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api';
import type { PendingActionPreview } from '@/types/agent';
const labels: Record<string, string> = { name: 'Nombre', sku: 'SKU', price: 'Precio', currency: 'Moneda', stock: 'Stock inicial',
  resultingStock: 'Stock resultante', minStockLevel: 'Stock mínimo', category: 'Categoría', costPrice: 'Costo', description: 'Descripción' };
export function PendingActionCard({ action, conversationId }: { action: PendingActionPreview; conversationId: string }) {
  const [current, setCurrent] = useState(action);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function decide(decision: 'confirm' | 'cancel') {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await apiClient.decideAgentAction(current.pendingActionId, conversationId, decision);
      if (!result.data) throw new Error();
      setCurrent(result.data);
    } catch { setError('No se pudo confirmar el estado. Puedes reintentar la misma confirmación sin crear otra acción.'); }
    finally { lock.current = false; setBusy(false); }
  }
  const expired = Date.parse(current.expiresAt) <= Date.now();
  return <section aria-label="Acción pendiente" className="mt-3 rounded-lg border p-3 space-y-2 text-sm">
    <p className="font-medium">{current.summary}</p>
    <dl>{Object.entries(current.fields).map(([key, value]) => <div key={key} className="flex flex-wrap gap-2"><dt>{labels[key] || key}:</dt><dd className="break-all">{value}</dd></div>)}</dl>
    <p>Estado: {expired && current.status === 'PENDING' ? 'EXPIRED' : current.status} · 0 llamadas IA · 0 tokens</p>
    {current.status === 'PENDING' && !expired && current.requiresConfirmation && <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => void decide('confirm')}>Confirmar</Button>
      <Button variant="outline" disabled={busy} onClick={() => void decide('cancel')}>Cancelar</Button>
    </div>}
    {busy && <p role="status">Procesando acción…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
