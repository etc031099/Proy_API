'use client';

import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import { clearLatestForecastImpactSale, isForecastImpactSaleMessage, readLatestForecastImpactSale, saveLatestForecastImpactSale, FORECAST_IMPACT_CHANNEL, FORECAST_IMPACT_LOCAL_EVENT, type ForecastImpactSaleMessage } from '@/lib/forecastImpactChannel';
import { mayReplaceImpact } from '@/lib/operationImpactIdentity';
import { readForecastImpactSnapshot, type ForecastImpactSnapshot, type ForecastImpactInference } from '@/lib/forecastImpactSnapshot';
import { compareRidgeInferenceFeatures, readRidgeFeatureInputs, RIDGE_FEATURE_GROUPS, RIDGE_FEATURE_ORDER } from '@/lib/ridgeFeatures';
import type { ProductOperationDetail } from '@/types/businessIntelligence';
import type { InventoryImpactProductSnapshot } from '@/lib/inventoryImpactSnapshot';
import type { useInventoryImpact } from './InventoryImpactPanel';

type ForecastImpactState = { baseline: ForecastImpactSnapshot | null; after: ForecastImpactSnapshot | null;
  sale: ForecastImpactSaleMessage | null; pendingSale: ForecastImpactSaleMessage | null; allowUnknownScope: boolean;
  loadingAfter: boolean; error: string | null };

function display(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'No disponible' : String(value);
}
function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(date);
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
      error: null });
    if (!hasSaleScope) {
      setState(current => requestId === afterRequest.current ? { ...current, loadingAfter: false, error: null } : current);
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
        after: snapshot, loadingAfter: false, error: !snapshot.complete ? 'La lectura actual quedó incompleta o no pudo validarse.' : null } : current);
    } catch {
      setState(current => requestId === afterRequest.current ? { ...current, sale: null, baseline: null, after: null,
        loadingAfter: false, error: 'No se pudo consultar ni validar la lectura actual. Puedes reintentar.' } : current);
    }
  }, []);

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(FORECAST_IMPACT_CHANNEL);
    if (channel) channel.onmessage = event => { if (isForecastImpactSaleMessage(event.data)
      && mayReplaceImpact(event.data, readLatestForecastImpactSale())) {
      saveLatestForecastImpactSale(event.data);
      if (enabled) void refreshAfterSale(event.data, true);
      else setState({ baseline: event.data.baseline, after: null, sale: event.data, pendingSale: event.data,
        allowUnknownScope: true, loadingAfter: false, error: null });
    } };
    const onLocalImpact = (event: Event) => { const detail = (event as CustomEvent<unknown>).detail;
      if (isForecastImpactSaleMessage(detail) && mayReplaceImpact(detail, readLatestForecastImpactSale())) {
        saveLatestForecastImpactSale(detail);
        if (enabled) void refreshAfterSale(detail, true);
        else setState({ baseline: detail.baseline, after: null, sale: detail, pendingSale: detail,
          allowUnknownScope: true, loadingAfter: false, error: null });
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
          allowUnknownScope: true, loadingAfter: false, error: null });
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

const ridgeFeatureLabels: Record<string, { label: string; meaning: string }> = {
  sku: { label: 'SKU', meaning: 'Identidad del producto.' }, categoryCode: { label: 'Categoría', meaning: 'Clasificación del producto.' }, subcategoryCode: { label: 'Subcategoría', meaning: 'Clasificación más específica.' }, brand: { label: 'Marca', meaning: 'Marca del producto.' }, presentation: { label: 'Presentación', meaning: 'Formato de venta.' }, unit: { label: 'Unidad', meaning: 'Unidad usada para medir.' }, sizeValue: { label: 'Tamaño', meaning: 'Tamaño declarado del producto.' }, containedUnits: { label: 'Unidades contenidas', meaning: 'Contenido por presentación.' },
  weekdayNext: { label: 'Día de la semana previsto', meaning: 'Calendario del horizonte consultado.' }, weekendNextDays: { label: 'Días de fin de semana', meaning: 'Días de fin de semana del horizonte.' }, monthNext: { label: 'Mes previsto', meaning: 'Mes del horizonte consultado.' }, dayOfMonthNext: { label: 'Día del mes previsto', meaning: 'Día del calendario del horizonte.' }, paydayDays: { label: 'Días hasta fecha de pago', meaning: 'Distancia a la fecha de pago configurada.' }, monthEndDays: { label: 'Días hasta fin de mes', meaning: 'Distancia al cierre del mes.' },
  currentUnits: { label: 'Unidades del último día cerrado', meaning: 'Venta consolidada del corte cerrado más reciente.' }, lag_1: { label: 'Venta de hace 1 día cerrado', meaning: 'Unidades del primer día cerrado previo.' }, lag_7: { label: 'Venta de hace 7 días', meaning: 'Unidades del día cerrado equivalente anterior.' }, lag_14: { label: 'Venta de hace 14 días', meaning: 'Unidades del día cerrado equivalente.' }, lag_28: { label: 'Venta de hace 28 días', meaning: 'Unidades del día cerrado equivalente.' },
  rollingMean_7: { label: 'Promedio móvil 7 días', meaning: 'Media de ventas en la ventana cerrada.' }, rollingMean_14: { label: 'Promedio móvil 14 días', meaning: 'Media de ventas en la ventana cerrada.' }, rollingMean_28: { label: 'Promedio móvil 28 días', meaning: 'Media de ventas en la ventana cerrada.' }, rollingStd_7: { label: 'Variación 7 días', meaning: 'Dispersión de ventas en la ventana cerrada.' }, rollingStd_28: { label: 'Variación 28 días', meaning: 'Dispersión de ventas en la ventana cerrada.' },
  zeroSalesStreak: { label: 'Días cerrados consecutivos sin venta', meaning: 'Racha calculada sobre días consolidados.' }, daysSinceLastSale: { label: 'Días desde la última venta', meaning: 'Antigüedad de la última venta observada.' }, neverSoldInObservedWindow: { label: 'Sin ventas en la ventana observada', meaning: 'Indicador de ausencia de ventas observadas.' },
};
function FeatureComparison({ sku, days, before, after }: { sku: string; days: 7 | 14; before?: ForecastImpactInference | null; after?: ForecastImpactInference | null }) {
  const comparison = compareRidgeInferenceFeatures(before, after, sku, days);
  const current = after?.horizonDays === days && after.featureVersion === 'RIDGE_CAUSAL27_V1'
    ? readRidgeFeatureInputs(after.featureInputs) : null;
  const prior = before?.horizonDays === days && before.featureVersion === 'RIDGE_CAUSAL27_V1'
    ? readRidgeFeatureInputs(before.featureInputs) : null;
  const comparable = Boolean(comparison.complete && current && prior);
  return <div className="min-w-0 rounded-lg border p-3">
    <h4 className="text-sm font-medium">Entradas Ridge {days}d</h4>
    <dl className="mt-2 space-y-2 text-xs">{RIDGE_FEATURE_GROUPS.map(group => {
      const changed = comparable ? group.keys.filter(key => prior![key] !== current![key]).length : null;
      return <div key={group.name} className="flex justify-between gap-2"><dt>{group.name}</dt>
        <dd>{!current ? 'Lectura actual no disponible' : changed === null ? `${group.keys.length} entradas actuales` : `${changed} de ${group.keys.length} modificadas`}</dd></div>;
    })}</dl>
    <p className="mt-2 text-xs text-muted-foreground">{comparable
      ? `Comparación observacional; no atribuye por sí sola el cambio a esta venta. Corte cerrado: ${display(before?.observationsClosedThrough)} → ${display(after?.observationsClosedThrough)}.`
      : current ? `Lectura actual de CAUSAL27. BEFORE histórico no disponible; no se calcula diferencia. Observaciones cerradas hasta ${display(after?.observationsClosedThrough)}.`
        : 'Las entradas de esta inferencia no están disponibles con identidad y contrato verificables.'}</p>
    <details className="mt-3 text-xs"><summary className="cursor-pointer">Ver 27 entradas · {days}d</summary>
      <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Entradas vigentes Ridge {days}d</caption>
        <thead><tr><th className="py-1 pr-3">Entrada y significado</th>{comparable && <th className="pr-3">BEFORE capturado</th>}
          <th>{comparable ? 'AFTER capturado' : 'Valor actual'}</th>{comparable && <th>Estado</th>}</tr></thead>
        <tbody>{RIDGE_FEATURE_ORDER.map(key => {
          const row = comparison.rows.find(candidate => candidate.key === key);
          const feature = ridgeFeatureLabels[key];
          return <tr key={key} className="border-t"><th scope="row" className="py-1.5 pr-3 font-normal"><span className="block">{feature?.label || key}</span><span className="block text-muted-foreground">{feature?.meaning || 'Entrada recibida del contrato CAUSAL27.'}</span><span className="font-mono text-[10px] text-muted-foreground">{key}</span></th>
            {comparable && <td className="pr-3">{display(row?.before)}</td>}<td>{display(current?.[key])}</td>{comparable && <td>{row?.state}</td>}</tr>;
        })}</tbody>
      </table></div>
    </details>
  </div>;
}

const version = (value?: number | null) => value == null ? null : `v${value}`;
const shortHash = (value?: string | null) => value ? `${value.slice(0, 12)}…` : null;
function modelBinding(inference?: ForecastImpactInference | null) {
  if (!inference) return null;
  return [inference.activeModelStatus, inference.modelFamily, version(inference.modelVersion)].filter(Boolean).join(' · ') || inference.status;
}
function EvidenceValue({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div className="flex items-baseline justify-between gap-3 border-b py-2 last:border-0"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-right text-sm font-medium">{display(value)}</dd></div>;
}
function ModelComparison({ days, before, after }: { days: 7 | 14; before?: ForecastImpactInference | null; after?: ForecastImpactInference | null }) {
  if (!before || !after) return <div className="min-w-0 rounded-lg border px-3 text-xs"><dl>
    <EvidenceValue label={`Modelo Ridge ${days}d`} value={modelBinding(after) || 'No hay inferencia actual'} />
    <EvidenceValue label="Contrato de features" value={after?.featureVersion} />
    <EvidenceValue label="Revisión de inferencia (dataVersion)" value={after?.dataVersion} />
    <EvidenceValue label="Snapshot evaluado" value={shortHash(after?.snapshotHash)} />
    <EvidenceValue label="Observaciones cerradas" value={after?.observationsClosedThrough} />
    <EvidenceValue label="Versión de entrenamiento" value={after?.trainedDataVersion} />
  </dl></div>;
  return <div className="min-w-0 rounded-lg border px-3 text-xs"><dl>
    <EvidenceOrComparison label={`Modelo · ${days}d`} before={modelBinding(before)} after={modelBinding(after)} />
    <EvidenceOrComparison label="Versión de features" before={before.featureVersion} after={after.featureVersion} />
    <EvidenceOrComparison label="Revisión de inferencia (dataVersion)" before={before.dataVersion} after={after.dataVersion} />
    <EvidenceOrComparison label="Snapshot evaluado" before={shortHash(before.snapshotHash)} after={shortHash(after.snapshotHash)} />
    <EvidenceOrComparison label="Corte observado" before={before.observationsClosedThrough} after={after.observationsClosedThrough} />
    </dl><details className="py-2"><summary className="cursor-pointer">Binding técnico · {days}d</summary><div className="mt-2 break-all"><dl>
      <EvidenceOrComparison label="Artifact" before={shortHash(before.artifactHash)} after={shortHash(after.artifactHash)} />
      <EvidenceOrComparison label="Revisión entrenada" before={before.trainedDataVersion} after={after.trainedDataVersion} />
      <EvidenceOrComparison label="Corte de entrenamiento" before={before.dataCutoff} after={after.dataCutoff} />
      <EvidenceOrComparison label="Contrato de features" before={shortHash(before.featureHash)} after={shortHash(after.featureHash)} />
      </dl><p>Snapshot BEFORE: {display(before.snapshotHash)}</p><p>Snapshot AFTER: {display(after.snapshotHash)}</p>
    </div></details>
  </div>;
}function ridgeExplanation(baseline: ForecastImpactSnapshot | null, after: ForecastImpactSnapshot | null, sku: string, occurredAt: string) {
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

function SaleOperationEvidence({ sale, sku, currentInventory, inventoryCapturedAt }: {
  sale: ForecastImpactSaleMessage; sku: string;
  currentInventory: InventoryImpactProductSnapshot | null; inventoryCapturedAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ProductOperationDetail | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'retryable-error' | 'authorization-error' | 'contract-error'>('idle');
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    if (!open) return;
    let current = true;
    const controller = new AbortController();
    const transactionId = sale.transactionId;
    if (!transactionId || !/^[a-f\d]{24}$/i.test(transactionId)) {
      setDetail(null); setStatus('unavailable');
      return () => { current = false; controller.abort(); };
    }
    const operationId = `SALE:${transactionId}`;
    setDetail(null); setStatus('loading'); setHttpStatus(null);
    void apiClient.getProductOperationDetail(sku, operationId, controller.signal).then(response => {
      if (!current) return;
      setHttpStatus(response.httpStatus);
      if (response.httpStatus === 404) { setDetail(null); setStatus('unavailable'); return; }
      if (response.httpStatus === 401 || response.httpStatus === 403) {
        setDetail(null); setStatus('authorization-error'); return;
      }
      if (response.httpStatus !== 200) {
        setDetail(null);
        setStatus(response.httpStatus === 0 || [408, 425, 429].includes(response.httpStatus) || response.httpStatus >= 500
          ? 'retryable-error' : 'contract-error');
        return;
      }
      const candidate = response.httpStatus === 200 ? response.data : null;
      const exactMatch = Boolean(candidate && candidate.operation?.operationId === operationId
        && typeof candidate.operation.sourceId === 'string'
        && candidate.operation.sourceId.toLowerCase() === transactionId.toLowerCase()
        && candidate.operation.type === 'SALE' && candidate.facts?.product?.sku === sku);
      if (!candidate || !exactMatch) { setDetail(null); setStatus('contract-error'); return; }
      setDetail(candidate); setStatus('ready');
    }).catch(() => { if (current) { setDetail(null); setHttpStatus(0); setStatus('retryable-error'); } });
    return () => { current = false; controller.abort(); };
  }, [open, retryCount, sale.transactionId, sku]);

  return <details className="rounded-lg border p-3" onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">Evidencia de la transacción · {sku}</summary>
    <div className="mt-3 space-y-3 text-sm">
      {status === 'loading' && <p role="status">Consultando movimiento y señal persistidos para esta transacción…</p>}
      {status === 'unavailable' && <p role="status">No hay detalle durable registrado para este ID y producto. No se infiere un movimiento ni una señal.</p>}
      {status === 'retryable-error' && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        <span>No se pudo cargar temporalmente la evidencia durable{httpStatus ? ` (HTTP ${httpStatus})` : ''}. La venta sigue confirmada.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => setRetryCount(value => value + 1)}>Reintentar evidencia durable</Button>
      </div>}
      {status === 'authorization-error' && <p role="alert" className="text-sm text-destructive">No se pudo acceder a la evidencia durable por permisos o sesión (HTTP {httpStatus}). La venta sigue confirmada.</p>}
      {status === 'contract-error' && <p role="alert" className="text-sm text-destructive">La respuesta de evidencia durable no coincide con la transacción y el producto solicitados. La venta sigue confirmada.</p>}
      {detail && <>
        <section aria-label={`Movimiento durable ${sku}`} className="rounded-md bg-muted/30 p-3">
          <h4 className="font-medium">Movimiento de inventario ligado por transactionId</h4>
          <p>{detail.inventoryMovements.length ? detail.inventoryMovements.map((movement, index) => <span key={`${movement.occurredAt}-${index}`} className="block">Δ {movement.quantityDelta} · stock {movement.stockBefore} → {movement.stockAfter} · {localDate(movement.occurredAt)}</span>) : 'No se encontró movimiento persistido para esta venta.'}</p>
          <p className="mt-1 text-xs text-muted-foreground">Revisión del journal: {display(detail.traceability.revision)} · Relación: {detail.traceability.relationQuality}.</p>
        </section>
        <section aria-label={`Señales Ridge durables ${sku}`} className="rounded-md bg-muted/30 p-3">
          <h4 className="font-medium">Señal durable de demanda</h4>
          {detail.ridgeEvidence.status === 'persisted' && detail.ridgeEvidence.horizons.length
            ? detail.ridgeEvidence.horizons.map(signal => <p key={`${signal.eventType}-${signal.horizonDays}-${signal.dataVersion}`}>{signal.eventType} · Ridge {signal.horizonDays}d · dataVersion {signal.dataVersion} · {signal.historicalCorrection ? 'corrección histórica' : 'registrada'}</p>)
            : <p>{detail.ridgeEvidence.status === 'not_applicable' ? 'Esta operación no es demanda Ridge.' : 'No existe una señal Ridge persistida vinculada por el identificador exacto.'}</p>}
          <p className="mt-1 text-xs text-muted-foreground">Una señal pendiente no significa que se hayan actualizado las entradas ni que el modelo se haya reentrenado.</p>
        </section>
      </>}
      <section aria-label={`Lectura operativa posterior ${sku}`} className="rounded-md bg-muted/30 p-3">
        <h4 className="font-medium">Lectura operativa posterior</h4>
        {currentInventory?.captureStatus === 'AVAILABLE' ? <>
          <p>Stock {display(currentInventory.stock?.onHand)} · cobertura {currentInventory.coverage?.daysCover == null ? 'No disponible' : `${currentInventory.coverage.daysCover} días`} · riesgo {display(currentInventory.risk?.level)} · reponer {display(currentInventory.recommendation?.reorderNow)}.</p>
          <p className="text-xs text-muted-foreground">Cobertura, riesgo y reposición son reglas operativas; Ridge aporta demanda acumulada P7/P14 como insumo cuando está disponible.{inventoryCapturedAt ? ` Captura: ${localDate(inventoryCapturedAt)}.` : ''}</p>
        </> : <p>No hay una captura de inventario posterior verificada para esta misma transacción y contexto.</p>}
      </section>
    </div>
  </details>;
}

function EvidenceOrComparison({ label, before, after }: { label: string; before: string | number | null | undefined; after: string | number | null | undefined }) {
  if (before != null && after != null) return <Comparison label={label} before={before} after={after} />;
  return <EvidenceValue label={label} value={after} />;
}

export function ForecastImpactDetailCard({ impact, inventoryImpact }: { impact: ReturnType<typeof useForecastImpact>;
  inventoryImpact?: ReturnType<typeof useInventoryImpact> }) {
  const { baseline, after, sale, pendingSale, loadingAfter, error } = impact;
  const before7 = baseline?.horizons[7], after7 = after?.horizons[7];
  const before14 = baseline?.horizons[14], after14 = after?.horizons[14];
  if (!sale && !pendingSale && !baseline && !after && !error && !loadingAfter) return <section aria-label="Impacto de nuevos datos en el ML" className="rounded-lg border bg-muted/20 px-4 py-3">
    <h2 className="text-sm font-semibold">Impacto de nuevos datos</h2><p className="mt-1 text-sm text-muted-foreground">Sin venta reciente disponible. Se mostrará evidencia durable y lectura actual; una comparación solo aparecerá si existe una captura anterior real.</p>
  </section>;
  const inventoryEvent = inventoryImpact?.event;
  const sameSaleContext = Boolean(sale?.transactionId && inventoryEvent?.type === 'SALE'
    && inventoryEvent.operationId === sale.transactionId && inventoryEvent.transactionId === sale.transactionId
    && sale.context.businessId && sale.context.scenarioId && sale.context.datasetVersion
    && inventoryEvent.context.businessId === sale.context.businessId && inventoryEvent.context.scenarioId === sale.context.scenarioId
    && inventoryEvent.context.datasetVersion === sale.context.datasetVersion
    && inventoryImpact?.after?.context.businessId === sale.context.businessId
    && inventoryImpact?.after?.context.scenarioId === sale.context.scenarioId
    && inventoryImpact?.after?.context.datasetVersion === sale.context.datasetVersion);
  return <Card>
    <CardHeader><CardTitle>Venta, evidencia y Ridge</CardTitle><CardDescription>La venta y el movimiento son hechos operativos. Ridge consulta señales, features CAUSAL27 y un modelo ACTIVE versionado; P7/P14 son acumulados. No se entrena por operación.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {sale && <div className="rounded-lg border bg-muted/30 p-3 text-sm"><p className="font-medium">Venta confirmada · {localDate(sale.occurredAt)}</p>
        <p className="break-all text-xs text-muted-foreground">transactionId: {sale.transactionId || 'No disponible'}</p>
        <p className="mt-1">{sale.products.map(item => `${item.name} (${item.sku}) × ${item.quantity}`).join(' · ') || 'Productos no disponibles'} · {sale.products.reduce((sum, item) => sum + item.quantity, 0)} unidad(es)</p></div>}
      {sale?.baselineUnavailable && <section role="status" className="rounded-lg border bg-muted/30 p-3 text-sm">
        <h3 className="font-medium">Venta registrada correctamente.</h3>
        <p className="mt-1">{after?.complete
          ? 'La lectura actual se completó; cada pronóstico se muestra solo cuando existe evidencia Ridge ACTIVE válida.'
          : loadingAfter ? 'La lectura actual todavía está en curso.'
            : after ? 'La lectura actual está incompleta o no pudo validarse; no se presenta como completa.'
              : error ? 'La lectura actual no está disponible; revisa el aviso de error para reintentar.'
                : 'La lectura actual todavía no está disponible.'}
          {' '}{baseline ? 'La captura BEFORE histórica es parcial; solo se comparan los datos disponibles.'
            : 'No existe una captura BEFORE histórica válida para comparar antes y después.'}</p>
      </section>}
      {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><span>{error}</span>{(sale || pendingSale) && <Button type="button" size="sm" variant="outline" disabled={loadingAfter} onClick={impact.retryAfterSale}>Reintentar lectura</Button>}</div>}
      <section aria-label="Lecturas actuales Ridge"><h3 className="mb-2 text-sm font-semibold">Revisión y estado consultados</h3><dl className="divide-y rounded-lg border px-3">
        {!baseline && <EvidenceValue label="Captura BEFORE histórica" value="No disponible; no se presenta como cambio" />}<EvidenceOrComparison label="Revisión de datos" before={baseline?.revision} after={after?.revision} />
        <EvidenceOrComparison label="Señales pendientes 7d · estado global" before={before7?.signals} after={after7?.signals} />
        <EvidenceOrComparison label="Señales pendientes 14d · estado global" before={before14?.signals} after={after14?.signals} />
        <EvidenceOrComparison label="Elegibilidad 7d · estado global" before={before7?.eligibility} after={after7?.eligibility} />
        <EvidenceOrComparison label="Elegibilidad 14d · estado global" before={before14?.eligibility} after={after14?.eligibility} />
      </dl><p className="mt-2 text-xs text-muted-foreground">El estado global no demuestra que esta venta generó una señal. La evidencia durable por transactionId se consulta en el detalle de cada producto.</p></section>
      {(sale || baseline || after) && <section aria-label="Lecturas de pronóstico Ridge" className="space-y-3"><p className="text-sm font-medium">Lecturas actuales por producto</p>
        {sale?.products.length ? sale.products.map(({ sku, name }) => {
          const before = baseline?.forecasts[sku], current = after?.forecasts[sku];
          const inventoryRow = sameSaleContext && inventoryImpact?.after ? inventoryImpact.after.products[sku] || null : null;
          return <article key={sku} className="space-y-3 rounded-lg border p-3"><h4 className="text-sm font-semibold">{name || current?.name} · {sku}</h4>
            <div className="grid gap-3 sm:grid-cols-2"><EvidenceOrComparison label="Ridge P7 · demanda acumulada" before={before?.seven} after={current?.seven} /><EvidenceOrComparison label="Ridge P14 · demanda acumulada" before={before?.fourteen} after={current?.fourteen} /></div>
            <section aria-label={`Modelo ACTIVE ${sku}`}><h5 className="mb-2 text-sm font-medium">Modelo y entradas</h5><div className="grid gap-3 lg:grid-cols-2">{([7, 14] as const).map(days => <div key={days}>
              <ModelComparison days={days} before={before?.inferences?.[days]} after={current?.inferences?.[days]} /><FeatureComparison sku={sku} days={days} before={before?.inferences?.[days]} after={current?.inferences?.[days]} />
            </div>)}</div></section>
            <p className="rounded-lg bg-muted/40 p-3 text-xs">{baseline ? ridgeExplanation(baseline, after, sku, sale.occurredAt) : 'BEFORE histórico no disponible. Se muestra la evidencia durable y la lectura actual, sin atribuir diferencias a la venta.'}</p>
            {sale.transactionId && <SaleOperationEvidence sale={sale} sku={sku} currentInventory={inventoryRow} inventoryCapturedAt={sameSaleContext ? inventoryImpact?.after?.capturedAt || null : null} />}
          </article>;
        }) : <p className="text-sm text-muted-foreground">No hay productos verificables asociados a esta venta.</p>}
      </section>}
      <section className="rounded-lg bg-muted/40 p-3"><h3 className="text-sm font-semibold">Qué cambia y cuándo</h3><ul className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
        <li><strong>Venta:</strong> puede dejar un evento durable pendiente para Ridge.</li><li><strong>Día abierto:</strong> las features de demanda pueden conservar datos del último día cerrado hasta consolidar el día.</li>
        <li><strong>Modelo:</strong> la revisión de datos no es una versión de modelo. ACTIVE no se reentrena por venta.</li><li><strong>Decisión:</strong> P7/P14 son demanda acumulada; stock, cobertura, riesgo y reposición son reglas operativas separadas.</li>
      </ul><p className="mt-2 text-xs text-muted-foreground">Una señal pendiente no equivale a features actualizadas ni a una predicción distinta. La promoción requiere entrenamiento, evaluación y política controlados.</p>
        <details className="mt-2 text-xs"><summary className="cursor-pointer">Estado técnico de evaluación</summary><p className="mt-1">7d: {display(after7?.eligibility)} · {display(after7?.reasonCode)}; 14d: {display(after14?.eligibility)} · {display(after14?.reasonCode)}. 1 día no está aprobado y no se interpola.</p></details></section>
      {loadingAfter && <p role="status" className="text-sm text-muted-foreground">Leyendo valores actuales después de la venta…</p>}{!sale && pendingSale && <p role="status" className="text-sm text-muted-foreground">Verificando contexto de la operación antes de mostrar sus datos.</p>}
    </CardContent>
  </Card>;
}
