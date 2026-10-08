'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api';
import type { PendingActionPreview } from '@/types/agent';
const labels: Record<string, string> = { name: 'Nombre', sku: 'SKU', price: 'Precio', currency: 'Moneda', stock: 'Stock inicial',
  resultingStock: 'Stock resultante', minStockLevel: 'Stock mínimo', category: 'Categoría', costPrice: 'Costo', description: 'Descripción',
  total: 'Total', paymentMethod: 'Pago', contact: 'Cliente / Proveedor' };
const statuses = { PENDING: 'Pendiente', CONFIRMED: 'Confirmada', EXECUTED: 'Ejecutada', CANCELLED: 'Cancelada', EXPIRED: 'Expirada', FAILED: 'Fallida' };
export function PendingActionCard({ action, conversationId }: { action: PendingActionPreview; conversationId: string }) {
  const [current, setCurrent] = useState(action);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(Date.parse(action.expiresAt) <= Date.now());
  const lock = useRef(false);
  useEffect(() => {
    setCurrent(action);
    setExpired(Date.parse(action.expiresAt) <= Date.now());
  }, [action]);
  useEffect(() => {
    if (current.status !== 'PENDING') return;
    const remaining = Date.parse(current.expiresAt) - Date.now();
    if (remaining <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2147483647));
    return () => clearTimeout(timer);
  }, [current.expiresAt, current.status]);
  async function decide(decision: 'confirm' | 'cancel') {
    if (lock.current || expired || current.status !== 'PENDING') return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await apiClient.decideAgentAction(current.pendingActionId, conversationId, decision);
      if (!result.data) throw new Error();
      setCurrent(result.data);
    } catch { setError('No se pudo confirmar el estado. Puedes reintentar la misma confirmación sin crear otra acción.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section aria-label="Acción pendiente" className="mt-3 rounded-lg border p-3 space-y-2 text-sm">
    <p className="font-medium">{current.summary}</p>
    <dl>{Object.entries(current.fields).map(([key, value]) => <div key={key} className="flex flex-wrap gap-2"><dt>{labels[key] || key}:</dt><dd className="break-all">{value}</dd></div>)}</dl>
    {current.items?.map((item, index) => <div key={index} className="rounded border p-2">
      <p>{item.name} · {item.sku}</p><p>{item.quantity} unidades · Precio unitario: {item.price} {current.fields.currency} · Total: {item.total} {current.fields.currency}</p>
      <p>Stock actual: {item.stock} · Stock después: {item.resultingStock}</p>
    </div>)}
    <p>Estado: {statuses[expired && current.status === 'PENDING' ? 'EXPIRED' : current.status]} · Confirmación sin IA</p>
    {expired && current.status === 'PENDING' && <p>Esta acción expiró.</p>}
    {current.status === 'EXPIRED' && <p>Esta acción expiró.</p>}
    {current.result && <div role="status"><p>Operación registrada correctamente.</p>
      {current.result.sku && <p>{current.result.sku} · Stock: {current.result.stock}</p>}
      {current.result.items?.map((item, index) => <p key={index}>{item.quantity} unidades de {item.sku} · Stock resultante: {item.stock}</p>)}
      {current.result.total !== undefined && <p>Total: {current.result.total} {current.result.currency}</p>}
      <p className="break-all">Identificador: {current.result.id}</p>
    </div>}
    {current.status === 'PENDING' && !expired && current.requiresConfirmation && <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => void decide('confirm')}>Confirmar</Button>
      <Button variant="outline" disabled={busy} onClick={() => void decide('cancel')}>Cancelar</Button>
    </div>}
    {busy && <p role="status">Procesando acción…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
