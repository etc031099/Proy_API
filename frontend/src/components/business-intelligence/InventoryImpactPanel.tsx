'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clearLatestInventoryImpact, isInventoryImpactEvent, INVENTORY_IMPACT_CHANNEL, readLatestInventoryImpact, sameContext, saveLatestInventoryImpact } from '@/lib/inventoryImpactChannel';
import { readInventoryImpactContext, type InventoryImpactEvent, type InventoryImpactProductSnapshot, type InventoryImpactSnapshot, type InventoryImpactType } from '@/lib/inventoryImpactSnapshot';

type State = { event: InventoryImpactEvent | null; after: InventoryImpactSnapshot | null; loading: boolean; error: string | null };
const IMPACT_CONTEXT_RETRY_DELAY_MS = 30000;
const MAX_IMPACT_CONTEXT_RETRIES = 2;
const operationLabels: Record<InventoryImpactType, string> = { SALE: 'Venta', SALE_CANCELLED: 'Anulación de venta',
  PURCHASE_CREATED: 'Compra inmediata', INVENTORY_ADJUSTMENT: 'Ajuste de inventario' };
function number(value: number | null | undefined): string { return typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : 'No disponible'; }
function value<T extends string | number | boolean | null | undefined>(input: T): string {
  if (input === null || input === undefined) return 'No disponible';
  if (typeof input === 'boolean') return input ? 'Sí' : 'No';
  return String(input);
}
function date(input: string): string { const parsed = new Date(input); return Number.isNaN(parsed.getTime()) ? input
  : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(parsed); }
export function useInventoryImpact() {
  const [state, setState] = useState<State>({ event: null, after: null, loading: false, error: null });
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const retryOperation = useRef<string | null>(null);
  const retryRefresh = useRef<(event: InventoryImpactEvent) => void>(() => {});
  const scheduleRetry = (event: InventoryImpactEvent) => {
    if (retryTimer.current || retryCount.current >= MAX_IMPACT_CONTEXT_RETRIES) return;
    retryCount.current += 1;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      retryRefresh.current(event);
    }, IMPACT_CONTEXT_RETRY_DELAY_MS);
  };
  const refresh = useCallback(async (event: InventoryImpactEvent) => {
    const operationKey = `${event.operationId ?? ''}:${event.occurredAt}`;
    if (retryOperation.current !== operationKey) { retryOperation.current = operationKey; retryCount.current = 0; }
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    setState({ event: null, after: null, loading: true, error: null });
    if (!event.context.businessId || !event.context.scenarioId || !event.context.datasetVersion) {
      setState({ event: null, after: null, loading: false, error: 'No se pudo confirmar el contexto del estado previo. La operación se conserva, pero no se mostrarán comparaciones.' });
      return;
    }
    try {
      const currentContext = await readInventoryImpactContext();
      if (!currentContext) {
        setState({ event: null, after: null, loading: false, error: 'No se pudo verificar temporalmente el contexto. La operación se conserva y se reintentará.' });
        scheduleRetry(event);
        return;
      }
      if (!sameContext(event.context, currentContext)) {
        const saved = readLatestInventoryImpact();
        if (saved?.operationId === event.operationId && saved.occurredAt === event.occurredAt) clearLatestInventoryImpact();
        setState({ event: null, after: null, loading: false, error: null });
        return;
      }
      const after = event.after;
      if (after && hasContextIdentity(after.context) && !sameContext(event.context, after.context)) {
        clearLatestInventoryImpact();
        setState({ event: null, after: null, loading: false, error: null });
        return;
      }
      const verifiedEvent = { ...event, after, afterUnavailable: !after?.complete };
      if (after?.complete) retryCount.current = 0;
      setState({ event: verifiedEvent, after, loading: false, error: !after?.complete
        ? 'La operación se registró, pero no fue posible completar la comparación de inventario.'
        : event.baselineStatus === 'AVAILABLE' ? null : event.baselineStatus === 'BASELINE_UNAVAILABLE'
          ? 'Estado previo no disponible; la operación sí se registró.' : 'Comparación parcial: faltó el estado previo de uno o más productos.' });
    } catch {
      const failed = { ...event, after: event.after, afterUnavailable: !event.after?.complete };
      saveLatestInventoryImpact(failed);
      setState({ event: null, after: null, loading: false, error: 'No se pudo verificar temporalmente el contexto. La operación se conserva y se reintentará.' });
      scheduleRetry(event);
    }
  }, []);
  retryRefresh.current = refresh;
  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(INVENTORY_IMPACT_CHANNEL);
    if (channel) channel.onmessage = event => { if (isInventoryImpactEvent(event.data)) void refresh(event.data); };
    const saved = readLatestInventoryImpact();
    if (saved) void refresh(saved);
    return () => { channel?.close(); if (retryTimer.current) clearTimeout(retryTimer.current); };
  }, [refresh]);
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); }, []);
  return { ...state, retry: () => { const saved = state.event || readLatestInventoryImpact(); if (saved) { retryCount.current = 0; void refresh(saved); } } };
}

function hasContextIdentity(context: InventoryImpactSnapshot['context']): boolean {
  return Boolean(context.businessId || context.scenarioId || context.datasetVersion);
}

export function InventoryImpactSummaryCard({ impact, onNavigate }: { impact: ReturnType<typeof useInventoryImpact>;
  onNavigate: () => void }) {
  const event = impact.event;
  if (!event) return null;
  const count = event.products.reduce((sum, row) => sum + row.quantity, 0);
  return <Card><CardHeader className="pb-3"><CardTitle>Impacto operativo reciente</CardTitle>
    <CardDescription>La comparación completa está en la pestaña Inventario.</CardDescription></CardHeader>
    <CardContent className="space-y-2 text-sm"><p><span className="font-medium">{operationLabels[event.type]}</span>{event.reference ? ` · ${event.reference}` : ''} · {date(event.occurredAt)}</p>
      <p className="text-muted-foreground">{event.products.length} producto(s) · {count} unidad(es) · Inventario: {impact.loading ? 'lectura posterior en curso' : impact.after ? 'estado posterior consultado' : 'comparación parcial'}</p>
      <Button type="button" size="sm" variant="link" className="h-auto px-0" onClick={onNavigate}>Ver impacto en Inventario</Button></CardContent></Card>;
}

export function InventoryImpactDetailCard({ impact }: { impact: ReturnType<typeof useInventoryImpact> }) {
  const { event, after, loading, error } = impact;
  if (!event) return <section aria-label="Impacto de última operación" className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">{loading ? 'Validando el contexto de la última operación…' : error || 'La próxima venta, anulación, compra inmediata o ajuste de stock se comparará aquí con el estado de inventario.'}</section>;
  const unavailableBefore = event.baselineStatus !== 'AVAILABLE';
  return <Card><CardHeader><CardTitle>Impacto de la última operación</CardTitle>
    <CardDescription>{operationLabels[event.type]}{event.reference ? ` · ${event.reference}` : ''} · {date(event.occurredAt)} · {event.products.length} producto(s) · {event.products.reduce((sum, row) => sum + row.quantity, 0)} unidad(es)</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">Comparación observacional</Badge><span>Otros cambios concurrentes podrían influir en los valores posteriores; la comparación no es atómica.</span></div>
      {error && <div role="status" className="flex flex-wrap items-center gap-2 text-sm"><span>{error}</span>{!loading && !event.afterUnavailable && <Button type="button" size="sm" variant="outline" onClick={impact.retry}>Revalidar contexto</Button>}</div>}
      {loading && <p role="status" className="text-sm text-muted-foreground">Leyendo el estado posterior del inventario…</p>}
      <div className="space-y-3">{event.products.map(product => {
        const before = event.baseline.products[product.sku];
        const current = after?.products[product.sku];
        return <details key={product.sku} className="rounded-lg border p-3" open={event.products.length === 1}>
          <summary className="cursor-pointer text-sm font-medium">{before?.name || product.name} · {product.sku} · {product.quantity} unidad(es)</summary>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg bg-muted/30 p-3" aria-label="Pronóstico Ridge"><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pronóstico Ridge · ML directo</h4><dl className="divide-y">
            <Metric label="Pronóstico Ridge 7 días (P7)" semantic="Pronóstico directo acumulado" before={before} after={current}
              select={row => row.demand?.expectedUnitsNext7d} formatter={number} hideUnavailable={false} showWhenMissing />
            <Metric label="Pronóstico Ridge 14 días (P14)" semantic="Pronóstico directo acumulado" before={before} after={current}
              select={row => row.demand?.expectedUnitsNext14d} formatter={number} hideUnavailable={false} showWhenMissing />
          </dl></section>
          <section className="rounded-lg bg-muted/30 p-3" aria-label="Operativo"><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Operativo</h4><dl className="divide-y">
            <Metric label="Stock" semantic="Dato operativo" before={before} after={current} select={row => row.stock?.onHand} formatter={number} hideUnavailable={unavailableBefore} />
            <Metric label="Entradas pendientes" semantic="Dato operativo" before={before} after={current} select={row => row.stock?.incoming} formatter={number} hideUnavailable={unavailableBefore} />
            <Metric label="Posición de inventario" semantic="Cálculo operativo" before={before} after={current} select={row => row.stock?.inventoryPosition} formatter={number} hideUnavailable={unavailableBefore} />
          </dl></section>
          <section className="rounded-lg bg-muted/30 p-3 lg:col-span-2" aria-label="Reglas derivadas"><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reglas derivadas · usan Ridge como insumo cuando está disponible</h4><dl className="divide-y">
            <Metric label="Cobertura" semantic="Regla con Ridge" before={before} after={current} select={row => row.coverage?.daysCover} formatter={v => v == null ? 'No disponible' : `${number(v)} días`} hideUnavailable={unavailableBefore} />
            <Metric label="Estado de cobertura" semantic="Regla con Ridge" before={before} after={current} select={row => row.coverage?.status} formatter={value} hideUnavailable={unavailableBefore} />
            <Metric label="Riesgo" semantic="Regla con Ridge" before={before} after={current} select={row => row.risk?.level} formatter={value} hideUnavailable={unavailableBefore} />
            <Metric label="Stock bajo" semantic="Regla de mínimo operativo" before={before} after={current} select={row => row.risk?.lowStock} formatter={value} hideUnavailable={unavailableBefore} />
            <Metric label="Stock de seguridad" semantic="Regla con Ridge" before={before} after={current} select={row => row.inventoryPolicy?.safetyStock} formatter={number} hideUnavailable={unavailableBefore} />
            <Metric label="Punto de reorden" semantic="Regla con Ridge" before={before} after={current} select={row => row.inventoryPolicy?.reorderPoint} formatter={number} hideUnavailable={unavailableBefore} />
            <Metric label="Reponer ahora" semantic="Regla con Ridge" before={before} after={current} select={row => row.recommendation?.reorderNow} formatter={value} hideUnavailable={unavailableBefore} />
            <Metric label="Cantidad recomendada" semantic="Regla con Ridge" before={before} after={current} select={row => row.recommendation?.recommendedQty} formatter={number} hideUnavailable={unavailableBefore} />
            <Metric label="Tasa diaria derivada" semantic="Tasa derivada de Ridge, no forecast 1 día" before={before} after={current} select={ridgeDerivedDailyRate} formatter={number} hideUnavailable={unavailableBefore} />
          </dl></section>
          <section className="rounded-lg bg-muted/30 p-3" aria-label="Clasificación"><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Clasificación descriptiva</h4><dl className="divide-y">
            <Metric label="ABC" semantic="Clasificación" before={before} after={current} select={row => row.classification?.abc} formatter={value} hideUnavailable={unavailableBefore} />
            <Metric label="XYZ" semantic="Clasificación" before={before} after={current} select={row => row.classification?.xyz} formatter={value} hideUnavailable={unavailableBefore} />
          </dl></section></div>
          {before?.captureStatus === 'UNAVAILABLE' && <p className="mt-2 text-xs text-muted-foreground">Estado previo no disponible para este producto.</p>}
          {current?.captureStatus === 'UNAVAILABLE' && <p className="mt-2 text-xs text-muted-foreground">Estado posterior no disponible para este producto.</p>}
        </details>;
      })}</div>
      {event.type === 'PURCHASE_CREATED' && <p className="text-xs text-muted-foreground">Compra inmediata: aumenta el stock. No se registra como entrada pendiente ni como evidencia Ridge de demanda.</p>}
      <p className="text-xs text-muted-foreground">El stock y las entradas son datos operativos; cobertura, riesgo y reposición son reglas/cálculos que pueden usar Ridge como insumo. Ridge muestra únicamente pronósticos directos de 7 y 14 días; la tasa diaria es derivada, no un pronóstico de 1 día.</p>
    </CardContent>
  </Card>;
}

function Metric({ label, semantic, before, after, select, formatter, hideUnavailable, showWhenMissing = false }: { label: string; semantic: string;
  before?: InventoryImpactProductSnapshot; after?: InventoryImpactProductSnapshot;
  select: (row: InventoryImpactProductSnapshot) => string | number | boolean | null | undefined;
  formatter: (input: never) => string; hideUnavailable: boolean; showWhenMissing?: boolean }) {
  const oldValue = before ? select(before) : null;
  const newValue = after ? select(after) : null;
  if (hideUnavailable && (oldValue == null && before?.captureStatus !== 'AVAILABLE')
      && (newValue == null && after?.captureStatus !== 'AVAILABLE')) return null;
  if (oldValue == null && newValue == null && !showWhenMissing) return null;
  const format = (input: string | number | boolean | null | undefined) => input == null ? 'No disponible' : formatter(input as never);
  const unchanged = oldValue != null && newValue != null && oldValue === newValue;
  return <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b py-2 last:border-0"><dt className="text-sm">{label}<span className="ml-2 text-[10px] text-muted-foreground">{semantic}</span></dt>
    <dd className="text-right text-sm font-medium">{format(oldValue)} <span aria-hidden="true">→</span> {format(newValue)}{unchanged && <span className="ml-2 text-xs text-muted-foreground">Sin cambio</span>}</dd></div>;
}

function ridgeDerivedDailyRate(row: InventoryImpactProductSnapshot) {
  const p7 = row.demand?.expectedUnitsNext7d;
  const p14 = row.demand?.expectedUnitsNext14d;
  if (typeof p7 !== 'number' || !Number.isFinite(p7) || p7 < 0
      || typeof p14 !== 'number' || !Number.isFinite(p14) || p14 < 0) return null;
  return row.demand?.expectedDaily ?? null;
}
