'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clearLatestForecastImpactSale, isForecastImpactSaleMessage, readLatestForecastImpactSale, saveLatestForecastImpactSale, FORECAST_IMPACT_CHANNEL, FORECAST_IMPACT_LOCAL_EVENT, type ForecastImpactSaleMessage } from '@/lib/forecastImpactChannel';
import { mayReplaceImpact } from '@/lib/operationImpactIdentity';
import { readForecastImpactSnapshot, type ForecastImpactSnapshot, type ForecastImpactInference } from '@/lib/forecastImpactSnapshot';
import { compareRidgeInferenceFeatures } from '@/lib/ridgeFeatures';

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

export function useForecastImpact(enabled = true) {
  const [state, setState] = useState<ForecastImpactState>({ baseline: null, after: null, sale: null,
    pendingSale: null, allowUnknownScope: false, loadingAfter: false, error: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const afterRequest = useRef(0);
  const refreshAfterSale = useCallback(async (sale: ForecastImpactSaleMessage, allowUnknownScope = false) => {
    const requestId = ++afterRequest.current;
    const hasSaleScope = Boolean(sale.context.businessId && sale.context.scenarioId && sale.context.datasetVersion);
    setState({ baseline: null, after: null, sale: null, pendingSale: sale, allowUnknownScope, loadingAfter: true,
      error: sale.baselineUnavailable ? 'Estado previo no disponible; la venta sí se registró.' : null });
    if (!hasSaleScope) {
      setState(current => requestId === afterRequest.current ? { ...current, loadingAfter: true,
        error: 'Venta confirmada; esperando contexto verificable para leer el estado posterior.' } : current);
      return;
    }
    try {
      const snapshot = await readForecastImpactSnapshot(sale.products.map(({ sku, name }) => ({ sku, name })));
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
    if (channel) channel.onmessage = event => { if (isForecastImpactSaleMessage(event.data)
      && mayReplaceImpact(event.data, readLatestForecastImpactSale())) {
      saveLatestForecastImpactSale(event.data);
      if (enabled) void refreshAfterSale(event.data, true);
      else setState({ baseline: event.data.baseline, after: null, sale: event.data, pendingSale: event.data,
        allowUnknownScope: true, loadingAfter: false, error: event.data.baselineUnavailable ? 'Estado previo no disponible; la venta sí se registró.' : null });
    } };
    const onLocalImpact = (event: Event) => { const detail = (event as CustomEvent<unknown>).detail;
      if (isForecastImpactSaleMessage(detail) && mayReplaceImpact(detail, readLatestForecastImpactSale())) {
        saveLatestForecastImpactSale(detail);
        if (enabled) void refreshAfterSale(detail, true);
        else setState({ baseline: detail.baseline, after: null, sale: detail, pendingSale: detail,
          allowUnknownScope: true, loadingAfter: false, error: detail.baselineUnavailable ? 'Estado previo no disponible; la venta sí se registró.' : null });
      } };
    window.addEventListener(FORECAST_IMPACT_LOCAL_EVENT, onLocalImpact);
    const saved = readLatestForecastImpactSale();
    if (saved) {
      const current = stateRef.current;
      const sameSale = current.sale?.transactionId === saved.transactionId && current.sale?.occurredAt === saved.occurredAt;
      if (enabled) {
        if (!sameSale || !current.after) void refreshAfterSale(saved);
      } else if (!sameSale || !current.after) {
        setState({ baseline: saved.baseline, after: null, sale: saved, pendingSale: saved,
          allowUnknownScope: true, loadingAfter: false, error: saved.baselineUnavailable ? 'Estado previo no disponible; la venta sí se registró.' : null });
      }
    }
    return () => { channel?.close(); window.removeEventListener(FORECAST_IMPACT_LOCAL_EVENT, onLocalImpact); };
  }, [enabled, refreshAfterSale]);

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

function FeatureComparison({ sku, days, before, after }: { sku: string; days: 7 | 14; before?: ForecastImpactInference | null; after?: ForecastImpactInference | null }) {
  const comparison = compareRidgeInferenceFeatures(before, after, sku, days);
  return <div className="min-w-0 rounded-lg border p-3">
    <h4 className="text-sm font-medium">Entradas Ridge {days}d</h4>
    <dl className="mt-2 space-y-2 text-xs">{comparison.groups.map(group => <div key={group.name} className="flex justify-between gap-2">
      <dt>{group.name}</dt><dd>{group.changed === null ? 'Comparación no disponible' : `${group.changed} de ${group.total} modificadas`}</dd>
    </div>)}</dl>
    <p className="mt-2 text-xs text-muted-foreground">Observaciones cerradas: {display(before?.observationsClosedThrough)} → {display(after?.observationsClosedThrough)}</p>
    <details className="mt-3 text-xs"><summary className="cursor-pointer">Ver 27 entradas · {days}d</summary>
      <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Entradas Ridge {days}d BEFORE y AFTER</caption>
        <thead><tr><th className="py-1 pr-3">Feature</th><th className="pr-3">BEFORE</th><th className="pr-3">AFTER</th><th>Estado</th></tr></thead>
        <tbody>{comparison.rows.map(row => <tr key={row.key} className="border-t"><th scope="row" className="py-1.5 pr-3 font-normal">{row.key}</th>
          <td className="pr-3">{display(row.before)}</td><td className="pr-3">{display(row.after)}</td><td>{row.state}</td></tr>)}</tbody>
      </table></div>
    </details>
  </div>;
}

const version = (value?: number | null) => value == null ? null : `v${value}`;
const shortHash = (value?: string | null) => value ? `${value.slice(0, 12)}…` : null;
function ModelComparison({ days, before, after }: { days: 7 | 14; before?: ForecastImpactInference | null; after?: ForecastImpactInference | null }) {
  return <div className="min-w-0 rounded-lg border px-3 text-xs"><dl>
    <Comparison label={`Modelo ACTIVE ${days}d`} before={version(before?.modelVersion)} after={version(after?.modelVersion)} />
    <Comparison label="Versión de features" before={before?.featureVersion} after={after?.featureVersion} />
    <Comparison label="Revisión de inferencia (dataVersion)" before={before?.dataVersion} after={after?.dataVersion} />
    <Comparison label="Snapshot evaluado" before={shortHash(before?.snapshotHash)} after={shortHash(after?.snapshotHash)} />
    <Comparison label="Corte observado" before={before?.observationsClosedThrough} after={after?.observationsClosedThrough} />
    </dl><details className="py-2"><summary className="cursor-pointer">Binding técnico · {days}d</summary><div className="mt-2 break-all"><dl>
      <Comparison label="Artifact" before={shortHash(before?.artifactHash)} after={shortHash(after?.artifactHash)} />
      <Comparison label="Revisión entrenada" before={before?.trainedDataVersion} after={after?.trainedDataVersion} />
      <Comparison label="Corte de entrenamiento" before={before?.dataCutoff} after={after?.dataCutoff} />
      <Comparison label="Contrato de features" before={shortHash(before?.featureHash)} after={shortHash(after?.featureHash)} />
      </dl><p>Snapshot BEFORE: {display(before?.snapshotHash)}</p><p>Snapshot AFTER: {display(after?.snapshotHash)}</p>
    </div></details>
  </div>;
}

function ridgeExplanation(baseline: ForecastImpactSnapshot | null, after: ForecastImpactSnapshot | null, sku: string, occurredAt: string) {
  const pairs = ([7, 14] as const).map(days => ({ days,
    before: baseline?.forecasts[sku]?.inferences?.[days], after: after?.forecasts[sku]?.inferences?.[days] }));
  const modelChanges = pairs.filter(pair => pair.before?.modelVersion != null && pair.after?.modelVersion != null
    && (pair.before.modelVersion !== pair.after.modelVersion || pair.before.artifactHash && pair.after.artifactHash
      && pair.before.artifactHash !== pair.after.artifactHash));
  if (modelChanges.length) return modelChanges.map(pair => `La inferencia AFTER de Ridge ${pair.days}d usó otra versión ACTIVE o artifact (${version(pair.before?.modelVersion)} → ${version(pair.after?.modelVersion)}).`).join(' ');
  if (pairs.some(pair => !compareRidgeInferenceFeatures(pair.before, pair.after, sku, pair.days).complete)) {
    return 'La comparación de entradas está incompleta. No se puede afirmar que las 27 entradas permanecieron iguales.';
  }
  const changed = pairs.map(pair => ({ days: pair.days,
    groups: compareRidgeInferenceFeatures(pair.before, pair.after, sku, pair.days).groups.filter(group => group.changed! > 0) }));
  if (changed.some(pair => pair.groups.length)) return changed.filter(pair => pair.groups.length).map(pair =>
    `Ridge ${pair.days}d: ${pair.groups.map(group => `${group.changed} ${group.changed === 1 ? 'entrada modificada' : 'entradas modificadas'} en ${group.name.toLowerCase()}`).join('; ')}.`).join(' ')
    + ' La comparación describe las lecturas; otros cambios concurrentes podrían influir.';
  const sameModelAndOutput = pairs.every(pair => pair.before!.status === 'READY' && pair.after!.status === 'READY'
    && pair.before!.modelVersion != null && pair.before!.modelVersion === pair.after!.modelVersion
    && pair.before!.artifactHash && pair.before!.artifactHash === pair.after!.artifactHash
    && pair.before!.predictionUnits != null && pair.before!.predictionUnits === pair.after!.predictionUnits);
  const date = new Date(occurredAt);
  const saleDay = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) : null;
  const closedUnchanged = pairs.every(pair => pair.before!.observationsClosedThrough
    && pair.before!.observationsClosedThrough === pair.after!.observationsClosedThrough
    && saleDay && saleDay > pair.after!.observationsClosedThrough!);
  const evidenceIncreased = baseline?.revision && after?.revision && /^\d+$/.test(baseline.revision) && /^\d+$/.test(after.revision)
    && BigInt(after.revision) > BigInt(baseline.revision) && pairs.every(pair => {
      const a = baseline.horizons[pair.days].signals, b = after.horizons[pair.days].signals;
      return a != null && b != null && b > a && pair.before!.dataVersion === baseline.revision && pair.after!.dataVersion === after.revision;
    });
  if (baseline?.complete && after?.complete && sameModelAndOutput && closedUnchanged && evidenceIncreased) return 'La venta añadió evidencia pendiente, pero el día actual todavía está abierto. Las 27 entradas utilizadas por Ridge permanecieron iguales y el modelo ACTIVE no cambió; por eso P7 y P14 permanecieron iguales.';
  return sameModelAndOutput ? 'Las 27 entradas, el modelo ACTIVE y las salidas permanecieron iguales en ambas lecturas.'
    : 'Las 27 entradas recibidas son iguales. La información disponible no permite confirmar igualdad completa de modelo y salida.';
}

export function ForecastImpactDetailCard({ impact }: { impact: ReturnType<typeof useForecastImpact> }) {
  const { baseline, after, sale, pendingSale, loadingAfter, error } = impact;
  const before7 = baseline?.horizons[7], after7 = after?.horizons[7];
  const before14 = baseline?.horizons[14], after14 = after?.horizons[14];
  if (!sale && !pendingSale && !baseline && !after && !error && !loadingAfter) return <section aria-label="Impacto de nuevos datos en el ML" className="rounded-lg border bg-muted/20 px-4 py-3">
    <h2 className="text-sm font-semibold">Impacto de nuevos datos</h2>
    <p className="mt-1 text-sm text-muted-foreground">Sin una operación reciente para comparar. La próxima venta mostrará aquí revisión, señales y estado del modelo antes y después.</p>
  </section>;
  return <Card>
    <CardHeader><CardTitle>Impacto de nuevos datos en Ridge</CardTitle><CardDescription>Operación → evidencia → entradas Ridge → modelo ACTIVE → P7/P14. No ejecuta entrenamiento.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {sale && <><p className="text-sm">Venta {sale.transactionId ? `#${sale.transactionId.slice(-8)}` : 'registrada'} · {localDate(sale.occurredAt)}</p>
        <p className="text-sm">{sale.products.length} productos afectados · {sale.products.reduce((sum, item) => sum + item.quantity, 0)} unidades{sale.hasCustomer ? ' · cliente asociado' : ''}</p></>}
      {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><span>{error}</span>
        {(sale || pendingSale) && <Button type="button" size="sm" variant="outline" disabled={loadingAfter} onClick={impact.retryAfterSale}>Reintentar lectura</Button>}</div>}
      <p className="text-xs text-muted-foreground">Los valores representan lecturas antes y después de la operación. Otros cambios concurrentes del negocio podrían influir; la comparación no es atómica.</p>
      <section aria-label="Operación y evidencia"><h3 className="mb-2 text-sm font-semibold">Operación y evidencia</h3><dl className="divide-y rounded-lg border px-3">
        <Comparison label="Revisión" before={baseline?.revision} after={after?.revision} />
        <Comparison label="Señales pendientes 7d" before={before7?.signals} after={after7?.signals} />
        <Comparison label="Señales pendientes 14d" before={before14?.signals} after={after14?.signals} />
        <Comparison label="Elegibilidad 7d" before={before7?.eligibility} after={after7?.eligibility} />
        <Comparison label="Elegibilidad 14d" before={before14?.eligibility} after={after14?.eligibility} />
      </dl></section>
      {(sale || baseline || after) && <section aria-label="Comparación de pronóstico Ridge" className="space-y-3">
        <p className="text-sm font-medium">Pronóstico por producto</p>
        {sale?.products.length ? <>{sale.products.map(({ sku, name }) => {
            const before = baseline?.forecasts[sku];
            const current = after?.forecasts[sku];
            return <details key={sku} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{before?.name || name} · {sku}</summary>
              <div className="mt-3 space-y-4">
                <section aria-label={`Entradas Ridge ${sku}`}><h3 className="mb-2 text-sm font-semibold">Entradas Ridge</h3>
          <div className="grid gap-3 lg:grid-cols-2">{([7, 14] as const).map(days => <FeatureComparison key={days} sku={sku} days={days} before={before?.inferences?.[days]} after={current?.inferences?.[days]} />)}</div>
                </section>
                <section aria-label={`Modelo ACTIVE ${sku}`}><h3 className="mb-2 text-sm font-semibold">Modelo ACTIVE</h3>
                  <p className="mb-2 text-xs text-muted-foreground">El modelo ACTIVE no se reentrena por esta operación. Una actualización usa el pipeline y la política vigentes.</p>
                  <div className="grid gap-3 lg:grid-cols-2">{([7, 14] as const).map(days => <ModelComparison key={days} days={days} before={before?.inferences?.[days]} after={current?.inferences?.[days]} />)}</div>
                </section>
                <section aria-label={`Salida Ridge ${sku}`} className="space-y-1 text-sm"><h3 className="font-semibold">Salida</h3>
                  <p>Ridge 7d: {units(before?.seven)} → {units(current?.seven)}</p><p>Ridge 14d: {units(before?.fourteen)} → {units(current?.fourteen)}</p>
                </section>
                <p className="rounded-lg bg-muted/40 p-3 text-sm">{ridgeExplanation(baseline, after, sku, sale.occurredAt)}</p>
              </div></details>;
          })}</>
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
        <p className="mt-2 text-xs text-muted-foreground">Señal pendiente ≠ entrada incorporada · revisión/dataVersion ≠ versión del modelo · dirty ≠ entrenamiento · candidate ≠ ACTIVE. Una venta no implica que el pronóstico cambie.</p>
        <p className="mt-2 text-xs text-muted-foreground">Política requerida: 107 orígenes maduros. El conteo disponible no se muestra porque este status no lo conoce de forma autoritativa.</p>
        {(after7?.lastResult || after14?.lastResult || after7?.currentlyRunning || after14?.currentlyRunning) && <p className="mt-2 text-xs">Estado real del worker: 7d {after7?.currentlyRunning ? 'en curso' : display(after7?.lastResult)} · 14d {after14?.currentlyRunning ? 'en curso' : display(after14?.lastResult)}</p>}
        <details className="mt-2 text-xs"><summary className="cursor-pointer">Detalles técnicos</summary><p className="mt-1">7d: {display(after7?.eligibility)} · {display(after7?.reasonCode)}; 14d: {display(after14?.eligibility)} · {display(after14?.reasonCode)}</p></details>
      </section>
      {loadingAfter && <p role="status" className="text-sm text-muted-foreground">Leyendo valores posteriores a la venta…</p>}
      {!sale && !pendingSale && <p className="text-sm text-muted-foreground">El estado previo se capturará automáticamente para los productos de la próxima venta.</p>}
    </CardContent>
  </Card>;
}
