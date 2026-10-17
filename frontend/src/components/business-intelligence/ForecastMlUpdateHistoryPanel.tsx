'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { ForecastMlExecutionHorizon, ForecastMlProductImpact,
  ForecastMlUpdateExecution, ForecastMlUpdateExecutionDetail, ForecastMlUpdateHistoryPage } from '@/types/businessIntelligence';

const statusCopy: Record<string, string> = {
  NO_PENDING_WORK: 'Se revisó el sistema y no había trabajo pendiente.',
  NOT_ELIGIBLE: 'Se recibieron cambios, pero todavía no existe evidencia suficiente para evaluar o promover un nuevo modelo.',
  EVALUATED_NO_PROMOTION: 'Se evaluó un candidato, pero no superó la política de promoción.',
  PROMOTED: 'Se activó una nueva versión del modelo.',
  PARTIAL: 'Los horizontes tuvieron resultados diferentes.',
  FAILED: 'La ejecución no pudo completarse.',
  INTERRUPTED: 'La ejecución quedó interrumpida.',
  DEFERRED: 'La solicitud quedó pendiente para una ejecución posterior.',
  REQUESTED: 'La solicitud fue registrada.',
  PENDING: 'La ejecución está pendiente.',
  RUNNING: 'La ejecución está en curso.',
};
const statusLabel: Record<string, string> = {
  NO_PENDING_WORK: 'Sin trabajo pendiente', NOT_ELIGIBLE: 'No elegible', EVALUATED_NO_PROMOTION: 'Evaluado · sin promoción',
  PROMOTED: 'Promovido', PARTIAL: 'Parcial', FAILED: 'Fallido', INTERRUPTED: 'Interrumpido', DEFERRED: 'Diferido',
  REQUESTED: 'Solicitado', PENDING: 'Pendiente', RUNNING: 'En curso', UNKNOWN: 'No capturado',
};
const sourceLabel: Record<string, string> = { MANUAL: 'Manual', SCHEDULED: 'Automático', CLI: 'CLI', UNKNOWN: 'No capturado' };
const safeText = (value: unknown) => typeof value === 'string' && value.length ? value : 'No capturado';
const safeNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : 'No capturado';
const safeVersion = (value: number | null | undefined) => Number.isSafeInteger(value) ? `v${value}` : 'No capturado';
const localDate = (value: string | null | undefined, withTime = true) => {
  if (!value) return 'No capturado';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'No capturado' : new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' as const } : {}), timeZone: 'America/Lima',
  }).format(parsed);
};
const pendingLabel = (value: boolean | null | undefined) => value === true ? 'Sí' : value === false ? 'No' : 'No capturado';
const triggerLabel = (value: string) => sourceLabel[value] || 'No capturado';
const friendlyStatus = (value: string) => statusLabel[value] || 'No capturado';
const summaryNumber = (summary: Record<string, unknown> | null | undefined, key: string) => safeNumber(summary?.[key]);
function horizon(rows: ForecastMlExecutionHorizon[], days: 7 | 14) { return rows.find(row => row.horizonDays === days); }
function statusVariant(value: string): 'default' | 'destructive' | 'outline' {
  return value === 'FAILED' ? 'destructive' : value === 'PROMOTED' ? 'default' : 'outline';
}
function executionSummary(row: ForecastMlUpdateExecution) {
  return <>
    <div className="flex flex-wrap items-center gap-2"><Badge variant={statusVariant(row.status)}>{friendlyStatus(row.status)}</Badge>
      <span className="text-sm text-muted-foreground">{triggerLabel(row.triggerSource)}</span>
      <span className="text-sm text-muted-foreground">· Solicitud {localDate(row.requestedAt)}</span></div>
    <p className="mt-2 text-sm">{statusCopy[row.status] || 'El estado de esta ejecución no está capturado.'}</p>
    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
      <p><span className="text-muted-foreground">Revisión evaluada: </span>{safeText(row.dataVersionEvaluated)}</p>
      {[7, 14].map(days => {
        const item = horizon(row.horizons, days as 7 | 14);
        return <p key={days}><span className="text-muted-foreground">{days}d: </span>{safeVersion(item?.activeVersionBefore)} → {safeVersion(item?.activeVersionAfter)}</p>;
      })}
      <p><span className="text-muted-foreground">Resultado: </span>{friendlyStatus(row.status)}</p>
    </div>
    {row.availableOrigins == null || row.requiredOrigins == null
      ? <p className="mt-2 text-xs text-muted-foreground">Orígenes maduros: No capturado.</p>
      : <p className="mt-2 text-xs text-muted-foreground">{row.availableOrigins} / {row.requiredOrigins} orígenes maduros. El sistema requiere {row.requiredOrigins} orígenes maduros para una evaluación elegible.</p>}
  </>;
}

export function ForecastMlUpdateHistoryPanel() {
  const [page, setPage] = useState<ForecastMlUpdateHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setLoadingMore(false); setError(false); setPage(null);
    try {
      const result = await apiClient.getForecastMlUpdateHistory({ limit: 20 });
      if (id !== requestId.current) return;
      if (!result.data) throw new Error('History unavailable');
      setPage(result.data);
    } catch { if (id === requestId.current) setError(true); }
    finally { if (id === requestId.current) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const loadMore = async () => {
    if (!page?.page.nextCursor || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const result = await apiClient.getForecastMlUpdateHistory({ limit: page.page.limit, cursor: page.page.nextCursor });
      if (id !== requestId.current) return;
      if (!result.data) throw new Error('History unavailable');
      setPage(current => current ? { ...result.data!, items: [...current.items, ...result.data!.items] } : result.data!);
    } catch { if (id === requestId.current) setError(true); }
    finally { if (id === requestId.current) setLoadingMore(false); }
  };

  return <Card role="region" aria-label="Historial de actualizaciones ML">
    <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div>
      <CardTitle>Historial de actualizaciones ML</CardTitle>
      <CardDescription>Revisiones y cambios de modelo registrados. La lista no vuelve a calcular impactos.</CardDescription>
    </div><Button type="button" size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
      <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />Actualizar historial
    </Button></div></CardHeader>
    <CardContent className="space-y-3">
      {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Cargando historial…</p>}
      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 p-3 text-sm">
        <span>No se pudo cargar una parte del historial. El estado del ML y los pronósticos siguen disponibles.</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>Reintentar</Button>
      </div>}
      {!loading && !error && page?.items.length === 0 && <p className="text-sm text-muted-foreground">Aún no hay ejecuciones históricas capturadas.</p>}
      {page?.items.map(row => <ExecutionCard key={row.executionId} row={row} />)}
      {page?.page.nextCursor && <div className="flex justify-center"><Button type="button" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
        {loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}{loadingMore ? 'Cargando…' : 'Cargar más'}
      </Button></div>}
    </CardContent>
  </Card>;
}

function ExecutionCard({ row }: { row: ForecastMlUpdateExecution }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ForecastMlUpdateExecutionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const loadDetail = async () => {
    if (detail || detailLoading) return;
    setDetailLoading(true); setDetailError(false);
    try {
      const result = await apiClient.getForecastMlUpdateExecution(row.executionId);
      if (!result.data) throw new Error('Detail unavailable');
      setDetail(result.data);
    } catch { setDetailError(true); }
    finally { setDetailLoading(false); }
  };
  const toggle = () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (!detail) void loadDetail();
  };
  const id = `ml-execution-${row.executionId}`;
  return <article className="rounded-lg border p-4">
    {executionSummary(row)}
    <Button type="button" variant="ghost" size="sm" className="mt-3 px-2" aria-expanded={expanded} aria-controls={id} onClick={() => void toggle()}>
      {expanded ? 'Ocultar detalle' : 'Ver detalle'}<ChevronDown className={`ml-2 h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
    </Button>
    {expanded && <div id={id} className="mt-3 space-y-4 border-t pt-4">
      {detailLoading && <p role="status" className="text-sm text-muted-foreground">Cargando detalle de la ejecución…</p>}
      {detailError && <div role="alert" className="flex items-center justify-between gap-2 text-sm"><span>No se pudo cargar este detalle.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void loadDetail()}>Reintentar</Button></div>}
      {detail && <ExecutionDetail detail={detail} />}
    </div>}
  </article>;
}

function ExecutionDetail({ detail }: { detail: ForecastMlUpdateExecutionDetail }) {
  const promoted = detail.horizons.some(item => item.resultStatus === 'PROMOTED' || item.promotionDecision === 'PROMOTED');
  return <>
    <section aria-label="Resumen de ejecución" className="space-y-2"><h4 className="font-semibold">Resumen</h4>
      <div className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <p>Ejecución: <span className="font-mono text-xs">{detail.executionId}</span></p><p>Origen: {triggerLabel(detail.triggerSource)}</p>
        <p>Solicitada: {localDate(detail.requestedAt)}</p><p>Inicio: {localDate(detail.startedAt)}</p><p>Fin: {localDate(detail.finishedAt)}</p>
        <p>Revisión anterior: {safeText(detail.dataVersionBefore)}</p><p>Revisión evaluada: {safeText(detail.dataVersionEvaluated)}</p>
        <p>Datos cerrados hasta: {localDate(detail.observationsClosedThrough, false)}</p>
        <p>Trabajo pendiente antes/después: {pendingLabel(detail.pendingBefore)} / {pendingLabel(detail.pendingAfter)}</p>
      </div>
      {detail.availableOrigins == null || detail.requiredOrigins == null ? <p className="text-sm text-muted-foreground">Orígenes maduros: No capturado.</p>
        : <p className="text-sm text-muted-foreground">{detail.availableOrigins} / {detail.requiredOrigins} orígenes maduros. Se requieren {detail.requiredOrigins} orígenes maduros para una evaluación elegible.</p>}
    </section>
    <section aria-label="Resultado ML por horizonte" className="space-y-2"><h4 className="font-semibold">Resultado ML · solo Ridge 7d y 14d</h4>
      <div className="grid gap-3 sm:grid-cols-2">{([7, 14] as const).map(days => {
        const item = horizon(detail.horizons, days);
        return <div key={days} className="rounded-md bg-muted/40 p-3 text-sm"><h5 className="font-medium">Horizonte {days} días</h5>
          <p>Activo antes: {safeVersion(item?.activeVersionBefore)}</p><p>Candidato: {safeVersion(item?.candidateVersion)}</p>
          <p>Resultado: {friendlyStatus(item?.resultStatus || 'UNKNOWN')}</p><p>Decisión de promoción: {safeText(item?.promotionDecision)}</p>
          <p>Activo después: {safeVersion(item?.activeVersionAfter)}</p>
          {item?.promotionReason && <p>Motivo: {item.promotionReason}</p>}
        </div>;
      })}</div>
      {!promoted && <p className="text-sm text-muted-foreground">El modelo activo no cambió.</p>}
    </section>
    <ImpactSection detail={detail} promoted={promoted} />
    <details className="rounded-md border p-3 text-sm"><summary className="cursor-pointer font-medium">Detalles técnicos</summary>
      <dl className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div><dt>Estado durable</dt><dd>{safeText(detail.status)}</dd></div><div><dt>Etapa</dt><dd>{safeText(detail.stage)}</dd></div>
        <div><dt>Elegibilidad</dt><dd>{safeText(detail.eligibility)}</dd></div><div><dt>Motivo</dt><dd>{safeText(detail.reasonCode)}</dd></div>
        <div><dt>Impacto</dt><dd>{detail.impact.status} · {safeText(detail.impact.reasonCode)}</dd></div>
        <div><dt>Prediction</dt><dd>{detail.impact.prediction.status} · {safeText(detail.impact.prediction.reasonCode)}</dd></div>
        <div><dt>Inventory</dt><dd>{detail.impact.inventory.status} · {safeText(detail.impact.inventory.reasonCode)}</dd></div>
        {detail.attempts.map(attempt => <div key={attempt.runAttempt}><dt>Intento {safeText(attempt.runAttempt)} · {attempt.status}</dt><dd>{safeText(attempt.reasonCode)}</dd></div>)}
        {detail.signalTypes.length > 0 && <div><dt>Señales</dt><dd>{detail.signalTypes.join(', ')}</dd></div>}
      </dl>
    </details>
  </>;
}

function ImpactSection({ detail, promoted }: { detail: ForecastMlUpdateExecutionDetail; promoted: boolean }) {
  const [showProducts, setShowProducts] = useState(false);
  const [items, setItems] = useState<ForecastMlProductImpact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const loaded = useRef(false);
  const availableImpact = ['COMPLETE', 'PARTIAL'].includes(detail.impact.prediction.status)
    || ['COMPLETE', 'PARTIAL'].includes(detail.impact.inventory.status);
  const loadProducts = useCallback(async (nextCursor?: string) => {
    if (loading || loadingMore) return;
    setError(false);
    if (nextCursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const result = await apiClient.getForecastMlUpdateProducts(detail.executionId,
        { limit: 25, ...(nextCursor ? { cursor: nextCursor } : {}) });
      if (!result.data) throw new Error('Products unavailable');
      setItems(current => nextCursor ? [...current, ...result.data!.items] : result.data!.items);
      setCursor(result.data.page.nextCursor); loaded.current = true;
    } catch { setError(true); }
    finally { setLoading(false); setLoadingMore(false); }
  }, [detail.executionId, loading, loadingMore]);
  const openProducts = () => {
    setShowProducts(value => !value);
    if (!showProducts && !loaded.current) void loadProducts();
  };
  const prediction = detail.impact.prediction.summary as Record<string, unknown> | null;
  const inventory = detail.impact.inventory.summary as Record<string, unknown> | null;
  const p7 = prediction?.p7 as Record<string, unknown> | undefined;
  const p14 = prediction?.p14 as Record<string, unknown> | undefined;
  const noPromotion = !promoted;
  const notApplicable = detail.impact.status === 'NOT_APPLICABLE' || (noPromotion && detail.impact.prediction.status === 'NOT_CAPTURED'
    && detail.impact.inventory.status === 'NOT_CAPTURED');
  return <section aria-label="Impacto atribuible al nuevo modelo" className="space-y-3">
    <h4 className="font-semibold">Impacto atribuible al nuevo modelo</h4>
    {notApplicable ? <p className="text-sm text-muted-foreground">No aplica porque no se activó una nueva versión.</p> : <>
      {availableImpact && <p className="text-xs text-muted-foreground">El impacto mostrado compara el modelo anterior y el nuevo utilizando el mismo snapshot operacional. Así se evita atribuir al ML cambios provocados por ventas, compras o ajustes de stock posteriores.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border p-3 text-sm"><h5 className="font-medium">Predicciones · {detail.impact.prediction.status}</h5>
          <p>Productos evaluados: {summaryNumber(prediction, 'totalProductsEvaluated')}</p>
          <p>Productos con cambios: {summaryNumber(prediction, 'predictionChangedCount')}</p>
          <p>P7 aumentó / disminuyó: {summaryNumber(p7, 'increasedCount')} / {summaryNumber(p7, 'decreasedCount')}</p>
          <p>P14 aumentó / disminuyó: {summaryNumber(p14, 'increasedCount')} / {summaryNumber(p14, 'decreasedCount')}</p>
          <p>No comparables: {summaryNumber(prediction, 'notComparableCount')}</p>
        </div>
        <div className="rounded-md border p-3 text-sm"><h5 className="font-medium">Inventory · {detail.impact.inventory.status}</h5>
          <p>Riesgo: {summaryNumber(inventory, 'riskChangedCount')} productos con cambio</p>
          <p>Decisión de reposición: {summaryNumber(inventory, 'reorderDecisionChangedCount')} cambios</p>
          <p>Cantidad objetivo: {summaryNumber(inventory, 'recommendedQtyChangedCount')} cambios</p>
          <p>Punto de reposición: {summaryNumber(inventory, 'reorderPointChangedCount')} cambios</p>
          <p>Cobertura: {summaryNumber(inventory, 'coverageChangedCount')} cambios</p>
          <p>Ranking: {summaryNumber(inventory, 'rankingChangedCount')} cambios</p>
          <p>No comparables: {summaryNumber(inventory, 'notComparableCount')}</p>
        </div>
      </div>
      {availableImpact && <Button type="button" variant="outline" size="sm" aria-expanded={showProducts} onClick={openProducts}>
        {showProducts ? 'Ocultar productos afectados' : 'Ver productos afectados'}
      </Button>}
      {showProducts && <div className="space-y-3">
        {loading && <p role="status" className="text-sm text-muted-foreground">Cargando productos afectados…</p>}
        {error && <div role="alert" className="flex items-center justify-between gap-2 text-sm"><span>No se pudieron cargar los productos.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadProducts(cursor || undefined)}>Reintentar</Button></div>}
        {items.map(item => <ProductImpactCard key={item.sku} item={item} />)}
        {cursor && <Button type="button" size="sm" variant="outline" onClick={() => void loadProducts(cursor)} disabled={loadingMore}>
          {loadingMore ? 'Cargando…' : 'Cargar más productos'}
        </Button>}
      </div>}
    </>}
  </section>;
}

function ProductImpactCard({ item }: { item: ForecastMlProductImpact }) {
  const displayPair = (before: unknown, after: unknown, formatter = safeNumber) => `${formatter(before)} → ${formatter(after)}`;
  const boolLabel = (value: unknown) => value === true ? 'Sí' : value === false ? 'No' : 'No capturado';
  return <article className="grid gap-2 rounded-md bg-muted/40 p-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
    <div className="sm:col-span-2 xl:col-span-4"><strong>{safeText(item.productName)}</strong><span className="ml-2 font-mono text-xs text-muted-foreground">{item.sku}</span></div>
    <p>P7 antes → después: {displayPair(item.prediction.p7?.old, item.prediction.p7?.new)}</p>
    <p>P14 antes → después: {displayPair(item.prediction.p14?.old, item.prediction.p14?.new)}</p>
    <p>Riesgo: {displayPair(item.inventory.risk?.before, item.inventory.risk?.after, value => safeText(value))}</p>
    <p>Reposición: {displayPair(item.inventory.shouldReorder?.before, item.inventory.shouldReorder?.after, boolLabel)}</p>
    <p>Cantidad objetivo: {displayPair(item.inventory.recommendedQty?.before, item.inventory.recommendedQty?.after)}</p>
    <p>Punto de reposición: {displayPair(item.inventory.reorderPoint?.before, item.inventory.reorderPoint?.after)}</p>
    <p>Cobertura: {displayPair(item.inventory.coverage?.daysCoverBefore, item.inventory.coverage?.daysCoverAfter, value => value == null ? 'No capturado' : `${safeNumber(value)} días`)}</p>
    {item.inventory.ranking && <p>Ranking: {displayPair(item.inventory.ranking.positionBefore, item.inventory.ranking.positionAfter)} · {safeText(item.inventory.ranking.status)}</p>}
  </article>;
}
