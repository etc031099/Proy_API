'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ProductOperationDetail, ProductOperationFilter, ProductOperationHistoryItem, ProductOperationHistoryPage } from '@/types/businessIntelligence';

const labels: Record<ProductOperationFilter, string> = {
  ALL: 'Todos', SALE: 'Ventas', SALE_CANCELLED: 'Cancelaciones', PURCHASE_CREATED: 'Compras creadas',
  PURCHASE_RECEIVED: 'Recepciones', INVENTORY_ADJUSTMENT: 'Ajustes',
};
const quantityLabel = (item: ProductOperationHistoryItem) => item.type === 'SALE' ? 'Vendidas'
  : item.type === 'PURCHASE_CREATED' ? 'Solicitadas' : item.type === 'PURCHASE_RECEIVED' ? 'Recibidas'
    : item.type === 'SALE_CANCELLED' ? 'Venta cancelada' : 'Cambio de stock';
const dateLabel = (value: string) => new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(value));

export function ProductOperationHistoryPanel({ sku }: { sku: string }) {
  const [type, setType] = useState<ProductOperationFilter>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState<ProductOperationHistoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [details, setDetails] = useState<Record<string, ProductOperationDetail | 'loading' | 'error'>>({});
  const requestControllers = useRef(new Set<AbortController>());

  useEffect(() => {
    const controller = new AbortController();
    const activeControllers = requestControllers.current;
    activeControllers.add(controller);
    let current = true;
    setPage(null); setDetails({}); setLoading(true); setError(false);
    apiClient.getProductOperations(sku, { type, ...(from ? { from } : {}), ...(to ? { to } : {}), limit: 20 }, controller.signal)
      .then((response: AuthenticatedDiagnosticResult<ProductOperationHistoryPage>) => {
        if (!current) return;
        if (response.httpStatus !== 200 || !response.data) throw new Error('HISTORY_UNAVAILABLE');
        setPage(response.data);
      }).catch(() => { if (current && !controller.signal.aborted) setError(true); })
      .finally(() => { activeControllers.delete(controller); if (current) setLoading(false); });
    return () => { current = false; activeControllers.forEach(active => active.abort()); activeControllers.clear(); };
  }, [sku, type, from, to, retry]);

  const loadMore = async () => {
    if (!page?.nextCursor || loading) return;
    const controller = new AbortController(); requestControllers.current.add(controller);
    setLoading(true); setError(false);
    try {
      const response = await apiClient.getProductOperations(sku, { type, ...(from ? { from } : {}), ...(to ? { to } : {}), limit: 20, cursor: page.nextCursor }, controller.signal);
      if (controller.signal.aborted) return;
      if (response.httpStatus !== 200 || !response.data) throw new Error('HISTORY_UNAVAILABLE');
      setPage(current => current ? { ...current, items: [...current.items, ...response.data!.items], hasMore: response.data!.hasMore, nextCursor: response.data!.nextCursor } : response.data!);
    } catch { if (!controller.signal.aborted) setError(true); } finally { requestControllers.current.delete(controller); setLoading(false); }
  };
  const loadDetail = async (item: ProductOperationHistoryItem) => {
    if (details[item.operationId] && details[item.operationId] !== 'error') return;
    setDetails(current => ({ ...current, [item.operationId]: 'loading' }));
    const controller = new AbortController(); requestControllers.current.add(controller);
    try {
      const response = await apiClient.getProductOperationDetail(sku, item.operationId, controller.signal);
      if (!controller.signal.aborted) setDetails(current => ({ ...current, [item.operationId]: response.httpStatus === 200 && response.data ? response.data : 'error' }));
    } catch { if (!controller.signal.aborted) setDetails(current => ({ ...current, [item.operationId]: 'error' })); }
    finally { requestControllers.current.delete(controller); }
  };

  return <Card aria-label="Historial de operaciones del producto">
    <CardHeader className="pb-3"><CardTitle>Historial de operaciones</CardTitle><CardDescription>Movimientos comerciales e inventario persistidos para este producto. No reconstruye impactos históricos del modelo.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">Tipo<select aria-label="Filtrar por tipo" className="h-9 rounded-md border bg-background px-2" value={type} onChange={event => setType(event.target.value as ProductOperationFilter)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Desde<input aria-label="Fecha desde" type="date" className="h-9 rounded-md border bg-background px-2" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label className="grid gap-1 text-sm">Hasta<input aria-label="Fecha hasta" type="date" className="h-9 rounded-md border bg-background px-2" value={to} onChange={event => setTo(event.target.value)} /></label>
      </div>
      {loading && !page && <p role="status" className="text-sm text-muted-foreground">Cargando operaciones…</p>}
      {error && <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">No se pudo cargar el historial. <Button variant="link" className="h-auto p-0" onClick={() => setRetry(value => value + 1)}>Reintentar</Button></div>}
      {!loading && !error && page?.items.length === 0 && <p className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">No hay operaciones para los filtros seleccionados.</p>}
      {page?.items.map(item => <OperationRow key={item.operationId} item={item} detail={details[item.operationId]} onOpen={() => loadDetail(item)} />)}
      {page?.hasMore && <Button variant="outline" disabled={loading} onClick={loadMore}>{loading ? 'Cargando…' : 'Cargar más'}</Button>}
    </CardContent>
  </Card>;
}

function OperationRow({ item, detail, onOpen }: { item: ProductOperationHistoryItem; detail?: ProductOperationDetail | 'loading' | 'error'; onOpen: () => void }) {
  const expectedSignalType = item.type === 'SALE' ? 'SALE_COMPLETED' : item.type === 'SALE_CANCELLED' ? 'SALE_CANCELLED' : null;
  const hasPersistedSignal = item.ridgeImpact.status === 'persisted'
    && expectedSignalType !== null
    && item.ridgeImpact.horizons.some(signal => signal.eventType === expectedSignalType);
  const ridgeCopy = item.type === 'SALE' ? hasPersistedSignal
    ? 'Esta venta aportó evidencia de demanda al pipeline Ridge. No implica reentrenamiento ni promoción inmediata.'
    : 'Esta venta representa demanda observada, pero no existe una señal Ridge persistida que permita confirmar su incorporación al pipeline.'
    : item.type === 'SALE_CANCELLED' ? hasPersistedSignal
      ? 'Esta cancelación corrigió evidencia previamente registrada en el pipeline Ridge.'
      : 'Esta cancelación revierte una venta registrada, pero no existe una señal Ridge persistida que permita confirmar una corrección histórica en el pipeline.'
      : item.type === 'PURCHASE_CREATED' || item.type === 'PURCHASE_RECEIVED' ? 'Esta compra afecta inventario, pero no representa demanda observada por Ridge.'
        : 'Este ajuste modifica inventario, no demanda observada.';
  const badges = [hasPersistedSignal ? item.type === 'SALE_CANCELLED' ? 'Corrección Ridge' : 'Evidencia Ridge'
    : 'Sin evidencia Ridge',
  item.inventoryImpact.status === 'persisted' ? 'Impacto inventario' : null,
  item.relationQuality === 'LIMITED_LEGACY' ? 'Histórico limitado' : null].filter(Boolean);
  return <details className="rounded-lg border p-3" onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open) onOpen(); }}>
    <summary className="cursor-pointer list-none"><span className="flex flex-wrap items-center justify-between gap-2"><span><strong>{labels[item.type]}</strong><span className="ml-2 text-sm text-muted-foreground">{dateLabel(item.occurredAt)}</span></span><span className="text-sm">{quantityLabel(item)}: {item.quantity ?? 'No disponible'} · Ref. {item.reference || 'No disponible'}</span></span><span className="mt-2 flex flex-wrap gap-1">{badges.map(badge => <span key={badge} className="rounded-full border px-2 py-0.5 text-xs">{badge}</span>)}</span></summary>
    <div className="mt-4 space-y-3 border-t pt-3 text-sm"><p>{ridgeCopy}</p>
      {detail === 'loading' && <p role="status">Cargando detalle…</p>}{detail === 'error' && <p role="alert">No se pudo cargar el detalle de esta operación.</p>}
      {detail && typeof detail === 'object' && <><section><h4 className="font-medium">Operación</h4><p>Producto {detail.facts.product.name} · {detail.facts.product.sku}; cantidad {detail.facts.quantity ?? 'No disponible'}; referencia {detail.facts.reference || 'No disponible'}.</p>{detail.facts.customer && <p>Cliente: {detail.facts.customer}</p>}{detail.facts.supplier && <p>Proveedor: {detail.facts.supplier}</p>}</section>
        {detail.inventoryMovements.length > 0 && <section><h4 className="font-medium">Impacto en inventario</h4>{detail.inventoryMovements.map((movement, index) => <p key={`${movement.occurredAt}-${index}`}>Δ {movement.quantityDelta}; stock {movement.stockBefore} → {movement.stockAfter}; {dateLabel(movement.occurredAt)}.</p>)}</section>}
        <section><h4 className="font-medium">Relación con Ridge</h4>{detail.ridgeEvidence.horizons.length ? detail.ridgeEvidence.horizons.map(signal => <p key={signal.horizonDays}>{signal.eventType} · {signal.horizonDays} días · revisión {signal.dataVersion}</p>) : <p>{detail.ridgeEvidence.status === 'not_applicable' ? 'Esta operación no representa demanda Ridge.' : 'No hay señal Ridge persistida vinculada por identificador.'}</p>}</section>
        <details className="rounded border p-2"><summary className="cursor-pointer">Trazabilidad técnica</summary><dl className="mt-2 grid grid-cols-2 gap-2 text-xs"><dt>Revisión</dt><dd>{detail.traceability.revision || 'No disponible'}</dd><dt>Evento</dt><dd className="break-all">{detail.traceability.eventKey || 'No disponible'}</dd><dt>Relación</dt><dd>{detail.traceability.relationQuality}</dd></dl></details>
      </>}
    </div>
  </details>;
}
