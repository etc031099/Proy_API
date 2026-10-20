'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clearLatestForecastImpactSale, isForecastImpactSaleMessage, readLatestForecastImpactSale, FORECAST_IMPACT_CHANNEL, type ForecastImpactSaleMessage } from '@/lib/forecastImpactChannel';
import { readForecastImpactSnapshot, type ForecastImpactSnapshot } from '@/lib/forecastImpactSnapshot';

type ForecastImpactState = { baseline: ForecastImpactSnapshot | null; after: ForecastImpactSnapshot | null;
  sale: ForecastImpactSaleMessage | null; pendingSale: ForecastImpactSaleMessage | null; allowUnknownScope: boolean;
  loadingAfter: boolean; error: string | null };

function display(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'No disponible' : String(value);
}
function units(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value)
    : 'No disponible';
}
function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(date);
}
function reasonCopy(value: string | null): string {
  const copy: Record<string, string> = { NO_PENDING_WORK: 'No hay trabajo pendiente.', PENDING: 'Hay nueva evidencia pendiente.',
    SIGNALS_PENDING: 'Hay nuevas señales pendientes.', DEBOUNCE_NOT_ELAPSED: 'Agrupando cambios recientes.',
    NOT_MATURE: 'Esperando observaciones cerradas y evidencia madura.', COOLDOWN_ACTIVE: 'En espera del intervalo de seguridad.',
    NOT_ELIGIBLE: 'La evidencia aún no es elegible para evaluación.',
    PREVIOUS_FAILURE_NOT_RETRYABLE: 'La ejecución anterior requiere una condición nueva antes de reintentar.',
    READY_FOR_WORKER_REVIEW: 'Elegible para revisión del worker.', WORKER_ACTIVE: 'El worker está procesando la actualización.' };
  return value ? copy[value] || 'Estado informado por el servicio.' : 'Estado no disponible.';
}

export function useForecastImpact() {
  const [state, setState] = useState<ForecastImpactState>({ baseline: null, after: null, sale: null,
    pendingSale: null, allowUnknownScope: false, loadingAfter: false, error: null });
  const afterRequest = useRef(0);
  const refreshAfterSale = useCallback(async (sale: ForecastImpactSaleMessage, allowUnknownScope = false) => {
    const requestId = ++afterRequest.current;
    setState({ baseline: null, after: null, sale: null, pendingSale: sale, allowUnknownScope, loadingAfter: true,
      error: sale.baselineUnavailable ? 'Estado previo no disponible; la venta sí se registró.' : null });
    try {
      const snapshot = await readForecastImpactSnapshot(sale.products.map(({ sku, name }) => ({ sku, name })));
      const hasSaleScope = Boolean(sale.context.businessId && sale.context.scenarioId && sale.context.datasetVersion);
      const hasCurrentScope = Boolean(snapshot.context.businessId && snapshot.context.scenarioId && snapshot.context.datasetVersion);
      const scoped = hasSaleScope && hasCurrentScope
        && snapshot.context.businessId === sale.context.businessId
        && snapshot.context.scenarioId === sale.context.scenarioId
        && snapshot.context.datasetVersion === sale.context.datasetVersion;
      if (hasSaleScope && hasCurrentScope && !scoped) {
        if (requestId === afterRequest.current) {
          const saved = readLatestForecastImpactSale();
          if (saved?.transactionId === sale.transactionId && saved.occurredAt === sale.occurredAt) clearLatestForecastImpactSale();
          setState({ baseline: null, after: null, sale: null, pendingSale: null, allowUnknownScope: false, loadingAfter: false, error: null });
        }
        return;
      }
      const verified = scoped || (hasCurrentScope && !hasSaleScope && allowUnknownScope);
      if (!verified) {
        setState(current => requestId === afterRequest.current ? { ...current, sale: null, baseline: null, after: null,
          loadingAfter: false, error: 'No se pudo confirmar el contexto actual. Reintenta la lectura para validar la operación.' } : current);
        return;
      }
      setState(current => requestId === afterRequest.current ? { ...current, sale, pendingSale: null, baseline: sale.baseline,
        after: snapshot, loadingAfter: false, error: !snapshot.complete ? 'La lectura posterior quedó incompleta.'
          : sale.baselineUnavailable ? 'Estado previo no disponible; la venta sí se registró.' : null } : current);
    } catch {
      setState(current => requestId === afterRequest.current ? { ...current, sale: null, baseline: null, after: null,
        loadingAfter: false, error: 'No se pudo leer ni validar el estado posterior. Reintenta la lectura.' } : current);
    }
  }, []);

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(FORECAST_IMPACT_CHANNEL);
    if (channel) channel.onmessage = event => { if (isForecastImpactSaleMessage(event.data)) void refreshAfterSale(event.data, true); };
    const saved = readLatestForecastImpactSale();
    if (saved) void refreshAfterSale(saved);
    return () => channel?.close();
  }, [refreshAfterSale]);

  return { ...state, retryAfterSale: () => {
    const sale = state.sale || state.pendingSale;
    if (sale) void refreshAfterSale(sale, state.allowUnknownScope);
  } };
}

function Comparison({ label, before, after }: { label: string; before: string | number | null | undefined; after: string | number | null | undefined }) {
  return <div className="flex items-baseline justify-between gap-3 border-b py-2 last:border-0"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-right text-sm font-medium">{display(before)} <span aria-hidden="true">→</span> {display(after)}</dd></div>;
}

export function ForecastImpactSummaryCard({ impact, onNavigate }: { impact: ReturnType<typeof useForecastImpact>;
  onNavigate: (tab: 'forecast' | 'inventory' | 'sales' | 'customers' | 'related') => void }) {
  const { baseline, after, sale, pendingSale, loadingAfter } = impact;
  return <Card>
    <CardHeader className="pb-3"><CardTitle>Impacto de nuevos datos</CardTitle><CardDescription>Resumen de la última venta observada; el detalle de cada área está en su pestaña.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {sale && <div className="rounded-lg border bg-muted/30 p-3 text-sm"><p className="font-medium">Última operación: Venta {sale.transactionId ? `#${sale.transactionId.slice(-8)}` : 'registrada'}</p>
        <p className="text-xs text-muted-foreground">{localDate(sale.occurredAt)} · {sale.products.length} producto(s) · {sale.products.reduce((sum, item) => sum + item.quantity, 0)} unidad(es){sale.hasCustomer ? ' · cliente asociado' : ''}</p>
        <p className="mt-1 text-xs">{sale.products.map(item => `${item.name} (${item.sku}) × ${item.quantity}`).join(' · ') || 'Detalle de productos no disponible'}</p></div>}
      {sale && <div className="grid gap-3 sm:grid-cols-2">
        <ImpactArea title="Predicción" badge="Nueva evidencia" text={after ? 'Nueva lectura de revisión, señales y modelos ACTIVE.' : loadingAfter ? 'Leyendo el estado posterior.' : 'La lectura posterior no está disponible.'} onClick={() => onNavigate('forecast')} />
        <ImpactArea title="Inventario" badge="Dato operativo" text="La operación afecta el estado operativo de stock." onClick={() => onNavigate('inventory')} />
        <ImpactArea title="Clientes" badge="RFM posible" text={sale.hasCustomer ? 'Los datos del cliente pueden actualizar su RFM.' : 'RFM aplica cuando la venta tiene un cliente identificable.'} onClick={() => onNavigate('customers')} />
        <ImpactArea title="Ventas" badge="Histórico congelado" text="El detector de anomalías disponible usa evidencia histórica congelada." onClick={() => onNavigate('sales')} />
        <ImpactArea title="Productos relacionados" badge="Histórico congelado" text="Las reglas de asociación son históricas; esta venta no las actualiza inmediatamente." onClick={() => onNavigate('related')} />
      </div>}
      {baseline && <p className="text-xs text-muted-foreground">Comparación observacional, no atómica. Otros cambios concurrentes del negocio podrían influir.</p>}
      {pendingSale && !sale && <p role="status" className="text-sm text-muted-foreground">Verificando el contexto de la última operación antes de mostrar el impacto.</p>}
      {loadingAfter && <p role="status" className="text-sm text-muted-foreground">Leyendo el estado posterior…</p>}
    </CardContent>
  </Card>;
}

function ImpactArea({ title, badge, text, onClick }: { title: string; badge: string; text: string; onClick: () => void }) {
  return <div className="rounded-lg border p-3"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{title}</h3><Badge variant="outline">{badge}</Badge></div>
    <p className="mt-1 text-xs text-muted-foreground">{text}</p><Button type="button" variant="link" size="sm" className="h-auto px-0 pt-2" onClick={onClick}>Ver análisis</Button></div>;
}

export function ForecastImpactDetailCard({ impact }: { impact: ReturnType<typeof useForecastImpact> }) {
  const { baseline, after, sale, pendingSale, loadingAfter, error } = impact;
  const before7 = baseline?.horizons[7], after7 = after?.horizons[7];
  const before14 = baseline?.horizons[14], after14 = after?.horizons[14];
  return <Card>
    <CardHeader><CardTitle>Impacto de nuevos datos en el ML</CardTitle><CardDescription>Comparación temporal del estado Ridge 7d/14d antes y después de la venta. No ejecuta entrenamiento.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {sale && <><p className="text-sm">Venta {sale.transactionId ? `#${sale.transactionId.slice(-8)}` : 'registrada'} · {localDate(sale.occurredAt)}</p>
        <p className="text-sm">{sale.products.length} productos afectados · {sale.products.reduce((sum, item) => sum + item.quantity, 0)} unidades{sale.hasCustomer ? ' · cliente asociado' : ''}</p></>}
      {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><span>{error}</span>
        {(sale || pendingSale) && <Button type="button" size="sm" variant="outline" disabled={loadingAfter} onClick={impact.retryAfterSale}>Reintentar lectura</Button>}</div>}
      <p className="text-xs text-muted-foreground">Los valores representan lecturas antes y después de la operación. Otros cambios concurrentes del negocio podrían influir; la comparación no es atómica.</p>
      <dl className="divide-y rounded-lg border px-3">
        <Comparison label="Revisión" before={baseline?.revision} after={after?.revision} />
        <Comparison label="Señales pendientes 7d" before={before7?.signals} after={after7?.signals} />
        <Comparison label="Señales pendientes 14d" before={before14?.signals} after={after14?.signals} />
        <Comparison label="Modelo ACTIVE 7d" before={before7?.activeVersion == null ? null : `v${before7.activeVersion}`} after={after7?.activeVersion == null ? null : `v${after7.activeVersion}`} />
        <Comparison label="Modelo ACTIVE 14d" before={before14?.activeVersion == null ? null : `v${before14.activeVersion}`} after={after14?.activeVersion == null ? null : `v${after14.activeVersion}`} />
        <Comparison label="Elegibilidad 7d" before={before7?.eligibility} after={after7?.eligibility} />
        <Comparison label="Elegibilidad 14d" before={before14?.eligibility} after={after14?.eligibility} />
      </dl>
      {(sale || baseline || after) && <section aria-label="Comparación de pronóstico Ridge" className="space-y-3">
        <p className="text-sm font-medium">Pronóstico por producto</p>
        {sale?.products.length ? <>{sale.products.map(({ sku, name }) => {
            const before = baseline?.forecasts[sku];
            const current = after?.forecasts[sku];
            return <details key={sku} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{before?.name || name} · {sku}</summary>
              <div className="mt-2 space-y-1 text-sm"><p>Ridge 7d: {units(before?.seven)} → {units(current?.seven)}</p><p>Ridge 14d: {units(before?.fourteen)} → {units(current?.fourteen)}</p></div></details>;
          })}<p className="text-xs text-muted-foreground">Si un valor no cambia, también es válido: la venta generó evidencia, pero las observaciones cerradas y el modelo ACTIVE pueden seguir iguales.</p></>
          : <p className="text-sm text-muted-foreground">Los productos de la venta aparecerán aquí después de registrarla correctamente.</p>}
      </section>}
      <section className="rounded-lg bg-muted/40 p-3"><h3 className="text-sm font-semibold">Cómo avanza la evidencia</h3>
        <ol className="mt-2 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <li><strong>Venta</strong><br />La pantalla de ventas anuncia el POST completado.</li>
          <li><strong>Evidencia y señales</strong><br />La revisión y las señales 7d/14d se leen del backend.</li>
          <li><strong>Maduración / elegibilidad real</strong><br />7d: {reasonCopy(after7?.reasonCode || after7?.eligibility || null)} 14d: {reasonCopy(after14?.reasonCode || after14?.eligibility || null)}</li>
          <li><strong>Evaluación</strong><br />El worker evalúa solo cuando la evidencia es elegible y las protecciones lo permiten.</li>
          <li><strong>Promoción o rechazo</strong><br />ACTIVE cambia únicamente si el candidato supera la política.</li>
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">Política requerida: 107 orígenes maduros. El conteo disponible no se muestra porque este status no lo conoce de forma autoritativa.</p>
        {(after7?.lastResult || after14?.lastResult || after7?.currentlyRunning || after14?.currentlyRunning) && <p className="mt-2 text-xs">Estado real del worker: 7d {after7?.currentlyRunning ? 'en curso' : display(after7?.lastResult)} · 14d {after14?.currentlyRunning ? 'en curso' : display(after14?.lastResult)}</p>}
        <details className="mt-2 text-xs"><summary className="cursor-pointer">Detalles técnicos</summary><p className="mt-1">7d: {display(after7?.eligibility)} · {display(after7?.reasonCode)}; 14d: {display(after14?.eligibility)} · {display(after14?.reasonCode)}</p></details>
      </section>
      {loadingAfter && <p role="status" className="text-sm text-muted-foreground">Leyendo valores posteriores a la venta…</p>}
      {!sale && !pendingSale && <p className="text-sm text-muted-foreground">El estado previo se capturará automáticamente para los productos de la próxima venta.</p>}
    </CardContent>
  </Card>;
}
