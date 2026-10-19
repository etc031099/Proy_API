'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api';
import type { ForecastMlUpdateStatus, MlTestActivity, MlTestActivityProduct, MlTestActivityVerification,
  MlTestLifecycleStatus, MlTestScenarioAnalysisResult, ProductInventory } from '@/types/businessIntelligence';
import { useMlTestScenarioUiState, type MlTestGlobalBaseline, type MlTestGlobalMlBaseline, type MlTestRestoreVerification } from './MlTestScenarioUiContext';

type Action = 'checkpoint' | 'continue' | 'finish';
type ForecastObservation = { state: 'AVAILABLE' | 'UNAVAILABLE'; units: number | null };
function lifecycleLabel(state: string): string {
  if (state === 'TEST_ACTIVE') return 'Prueba activa';
  if (state === 'NO_TEST') return 'Sin prueba activa';
  if (state === 'CHECKPOINT_CREATING') return 'Preparando punto de restauración';
  if (state === 'RESTORING') return 'Restauración en curso';
  if (state === 'FAILED') return 'Requiere atención';
  return 'Estado no disponible';
}
function friendlyFailure(httpStatus: number): string {
  if (httpStatus === 409) return 'La operación no puede ejecutarse en el estado actual. Actualiza el estado e inténtalo de nuevo si corresponde.';
  if (httpStatus === 503) return 'El entorno de pruebas está temporalmente no disponible. Los datos de la prueba se mantienen protegidos.';
  if (httpStatus === 401 || httpStatus === 403) return 'Esta cuenta no tiene autorización para administrar las pruebas locales.';
  return 'No se pudo conectar con el entorno de pruebas. Puedes volver a consultar el estado.';
}
function formatDate(value: string | null | undefined): string {
  if (!value) return 'No disponible';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'No disponible' : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(date);
}
function eligibilityCopy(reason: string | null | undefined): string {
  switch (reason) {
    case 'DEBOUNCE_NOT_ELAPSED': return 'El sistema recibió nueva evidencia, pero todavía está agrupando los cambios recientes antes de evaluar un candidato.';
    case 'NOT_MATURE': return 'Todavía no existe suficiente evidencia temporal madura para evaluar un nuevo modelo.';
    case 'COOLDOWN_ACTIVE': return 'El sistema mantiene un intervalo de seguridad antes de otra evaluación.';
    case 'NO_PENDING_WORK': return 'No hay cambios pendientes por evaluar.';
    case 'PREVIOUS_FAILURE_NOT_RETRYABLE': return 'La última evaluación requiere atención antes de poder reintentarse.';
    case 'LEASE_ACTIVE': return 'Hay una evaluación en curso.';
    default: return reason ? 'La evidencia todavía no está disponible para evaluación.' : 'Estado de elegibilidad no disponible.';
  }
}
function analysisOutcomeCopy(result: MlTestScenarioAnalysisResult): string {
  if (result.outcome === 'PROMOTED') return result.promoted ? 'Modelo promovido.' : 'El worker reportó PROMOTED, pero no se confirmó un cambio de modelo ACTIVE.';
  switch (result.outcome) {
    case 'NOT_MATURE': return 'Todavía no existe suficiente evidencia temporal madura para evaluar un nuevo modelo.';
    case 'DEBOUNCE_NOT_ELAPSED': return 'El sistema recibió nueva evidencia, pero todavía está agrupando los cambios recientes antes de evaluar un candidato.';
    case 'COOLDOWN_ACTIVE': return 'El sistema mantiene un intervalo de seguridad antes de otra evaluación.';
    case 'NO_PENDING_WORK': return 'No hay cambios pendientes por evaluar.';
    case 'LEASE_ACTIVE': return 'Ya existe una evaluación de este horizonte en curso.';
    case 'PREVIOUS_FAILURE_NOT_RETRYABLE': return 'La evaluación previa requiere atención antes de reintentarse.';
    case 'REJECTED': return 'Se evaluó un candidato, pero la política no permitió promoverlo.';
    case 'NO_PROMOTION_INSUFFICIENT_HISTORY': return 'La evidencia disponible no alcanzó los requisitos para evaluar o promover un candidato.';
    default: return 'La revisión local terminó; consulta los detalles técnicos si necesitas ampliar el resultado.';
  }
}
function analysisFailureCopy(httpStatus: number): string {
  if (httpStatus === 400) return 'La solicitud de análisis no es válida.';
  if (httpStatus === 401 || httpStatus === 403) return 'La cuenta o el entorno ya no están autorizados para esta prueba.';
  if (httpStatus === 409) return 'El ciclo de prueba cambió o existe otra operación incompatible.';
  if (httpStatus === 503) return 'El análisis local está temporalmente no disponible.';
  return 'No se pudo conectar con el análisis local. Puedes actualizar el estado e intentarlo de nuevo.';
}

function sameCycle(value: MlTestLifecycleStatus | null | undefined, token: MlTestLifecycleStatus): boolean {
  return value?.state === 'TEST_ACTIVE' && value.checkpoint?.status === 'READY' && !value.maintenance
    && value.testCycleId === token.testCycleId && value.resetEpoch === token.resetEpoch && value.checkpointId === token.checkpointId;
}
function sameBaselineIdentity(value: MlTestGlobalBaseline | null, lifecycle: MlTestLifecycleStatus): boolean {
  return Boolean(value && value.checkpointId === lifecycle.checkpointId && value.testCycleId === lifecycle.testCycleId
    && value.baselineRevision === String(lifecycle.checkpoint?.dataVersion ?? ''));
}
function pendingCount(status: ForecastMlUpdateStatus | null, days: 7 | 14): number | null {
  const count = status?.horizons.find(row => row.horizonDays === days)?.readiness?.pendingSignalCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}
function baselinePendingCount(status: MlTestGlobalMlBaseline | null, days: 7 | 14): number | null {
  const count = status?.horizons.find(row => row.horizonDays === days)?.pendingSignalCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}
function activeVersion(status: ForecastMlUpdateStatus | null, days: 7 | 14): number | null {
  return status?.horizons.find(row => row.horizonDays === days)?.activeModelVersion ?? null;
}
function baselineActiveVersion(status: MlTestGlobalMlBaseline | null, days: 7 | 14): number | null {
  return status?.horizons.find(row => row.horizonDays === days)?.activeModelVersion ?? null;
}
function displayValue(value: number | string | null | undefined): string {
  return value == null ? 'No disponible' : typeof value === 'number'
    ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : value;
}
function comparisonStatus(before: number | string | null, after: number | string | null): 'Coincide' | 'Difiere' | 'No se pudo verificar' {
  if (before === null || after === null) return 'No se pudo verificar';
  return before === after ? 'Coincide' : 'Difiere';
}
async function readForecastObservation(sku: string, days: 7 | 14): Promise<ForecastObservation> {
  try {
    const response = await apiClient.getBusinessIntelligenceForecast(sku, days);
    const data = response.success ? response.data : undefined;
    const units = data?.forecastPeriod?.units ?? (days === 7 ? data?.horizons['7d'] : data?.horizons['14d']);
    if (data?.status === 'READY' && data.modelFamily === 'RIDGE_REGRESSION' && data.activeModelStatus === 'ACTIVE'
        && typeof units === 'number' && Number.isFinite(units)) return { state: 'AVAILABLE', units };
  } catch { /* Explicitly unavailable; no statistical fallback. */ }
  return { state: 'UNAVAILABLE', units: null };
}
function activityEmpty(value: MlTestActivityVerification | undefined, target: MlTestRestoreVerification, epoch: string): boolean {
  return value?.status === 'EMPTY' && value.checkpointId === target.checkpointId && value.resetEpoch === epoch
    && value.baselineRevision === target.baselineRevision && value.currentRevision === target.baselineRevision
    && value.totalSales === 0 && value.cancellationCount === 0 && value.affectedProducts === 0 && value.grossUnits === 0;
}
function restoreMatches(value: MlTestRestoreVerification): boolean {
  if (!value.baseline || !value.observed || value.activity?.status !== 'EMPTY') return false;
  return String(value.baseline.dataVersion) === value.baselineRevision
    && String(value.observed.dataVersion) === value.baselineRevision && ([7, 14] as const).every(days =>
    baselinePendingCount(value.baseline, days) !== null && baselinePendingCount(value.baseline, days) === pendingCount(value.observed!, days)
    && baselineActiveVersion(value.baseline, days) !== null && baselineActiveVersion(value.baseline, days) === activeVersion(value.observed!, days));
}
function GlobalMetrics({ baseline, current, baselineRevision }: { baseline: MlTestGlobalMlBaseline | null;
  current: ForecastMlUpdateStatus; baselineRevision: string }) {
  const row = (label: string, before: number | string | null, after: number | string | null) =>
    <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="flex flex-wrap gap-x-2"><span>{before === null ? 'Inicial no capturado' : displayValue(before)} → {displayValue(after)}</span><span className="text-muted-foreground">{comparisonStatus(before, after)}</span></dd></div>;
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">{row('Revisión', baselineRevision, String(current.dataVersion))}
    {([7, 14] as const).flatMap(days => [row('Señales pendientes ' + days + 'd', baselinePendingCount(baseline, days), pendingCount(current, days)),
      row('Modelo ACTIVE ' + days + 'd', baselineActiveVersion(baseline, days) === null ? null : 'v' + baselineActiveVersion(baseline, days),
        activeVersion(current, days) === null ? null : 'v' + activeVersion(current, days))])}</dl>;
}

export function MlTestControlPanel() {
  const { baseline, setBaseline, restoreVerification, setRestoreVerification, restoreScrollPending, setRestoreScrollPending, operation, setOperation } = useMlTestScenarioUiState();
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<MlTestLifecycleStatus | null>(null);
  const [activity, setActivity] = useState<MlTestActivity | null>(null);
  const [currentMl, setCurrentMl] = useState<ForecastMlUpdateStatus | null>(null);
  const [reading, setReading] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(5);
  const [readVersion, setReadVersion] = useState(0);
  const [filter, setFilter] = useState('');
  const [analysisResults, setAnalysisResults] = useState<Partial<Record<7 | 14, MlTestScenarioAnalysisResult>>>({});
  const [analysisErrors, setAnalysisErrors] = useState<Partial<Record<7 | 14, string>>>({});
  const [analysisRunning, setAnalysisRunning] = useState<7 | 14 | null>(null);
  const baselineRef = useRef(baseline); baselineRef.current = baseline;
  const generationRef = useRef(0);
  const readingRef = useRef(false);
  const operationRef = useRef(false);
  const mounted = useRef(false);
  const restoreResultRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (force = false) => {
    if (readingRef.current || (operationRef.current && !force)) return;
    const generation = ++generationRef.current;
    readingRef.current = true; setReading(true); setError(null);
    const valid = () => mounted.current && generationRef.current === generation;
    try {
      const gate = await apiClient.getMlTestControlStatus();
      if (!valid()) return;
      const capability = gate.data?.capabilities?.destructiveMlTestControls;
      if (gate.httpStatus !== 200 || capability?.allowed !== true || capability.target !== 'LOCAL') { setReady(false); return; }
      const response = await apiClient.getMlTestLifecycleStatus(); const cycle = response.data;
      if (!valid()) return;
      if (response.httpStatus !== 200 || !cycle) throw new Error('STATE_UNAVAILABLE');
      if (baselineRef.current && !sameBaselineIdentity(baselineRef.current, cycle)) {
        baselineRef.current = null; setBaseline(null);
      }
      setStatus(cycle); setReady(true);
      if (cycle.state !== 'TEST_ACTIVE' || cycle.checkpoint?.status !== 'READY' || cycle.maintenance) {
        setActivity(null); setCurrentMl(null);
        if (cycle.state === 'NO_TEST') { setBaseline(null); baselineRef.current = null; }
        return;
      }
      apiClient.invalidateIntelligenceReads();
      const [activities, ml] = await Promise.all([apiClient.getMlTestActivity(), apiClient.getForecastMlUpdateStatus()]);
      if (!valid()) return;
      const data = activities.data;
      if (activities.httpStatus !== 200 || !data || data.testCycleId !== cycle.testCycleId || data.resetEpoch !== cycle.resetEpoch || data.checkpointId !== cycle.checkpointId)
        throw new Error('ACTIVITY_UNAVAILABLE');
      setActivity(data); setVisibleCount(5); setReadVersion(version => version + 1);
      setCurrentMl(ml.httpStatus === 200 && ml.data ? ml.data : null);
      // A baseline is captured only by the explicit checkpoint action. Reopening
      // an existing cycle cannot reconstruct the original global ML state.
    } catch { if (valid()) { setActivity(null); setCurrentMl(null); setError('No se pudo verificar toda la actividad. Actualiza el estado para volver a consultarla.'); } }
    finally { readingRef.current = false; if (valid()) setReading(false); }
  }, [setBaseline]);

  useEffect(() => {
    mounted.current = true; void refresh();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);

  useEffect(() => {
    if (!ready || operation !== null || !restoreScrollPending || !restoreResultRef.current
        || !['COMPLETE', 'FAILED'].includes(restoreVerification?.phase || '')) return;
    let second: number | null = null;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      restoreResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setRestoreScrollPending(false);
    }); });
    return () => { cancelAnimationFrame(first); if (second !== null) cancelAnimationFrame(second); };
  }, [operation, ready, restoreScrollPending, restoreVerification?.phase, setRestoreScrollPending]);

  const run = async (requested: Action) => {
    if (operationRef.current || readingRef.current || !status || status.maintenance) return;
    const confirmations = { checkpoint: 'Se guardará un punto de restauración para esta prueba libre.',
      continue: 'Se restaurará el punto inicial y la prueba continuará activa.', finish: 'Se restaurará el punto inicial y se finalizará la prueba.' };
    if (!window.confirm(confirmations[requested])) return;
    const checkpointId = status.checkpointId, baselineRevision = status.checkpoint?.dataVersion;
    const initial = baselineRef.current;
    const target: MlTestRestoreVerification | null = requested !== 'checkpoint' && checkpointId && baselineRevision ? {
      phase: 'VERIFYING', mode: requested, checkpointId, baselineRevision, resetEpoch: status.resetEpoch, testCycleId: status.testCycleId,
      baseline: sameBaselineIdentity(initial, status) ? initial!.globalMl : null,
    } : null;
    if (requested !== 'checkpoint' && !target) { setError('No se pudo identificar el punto de restauración. Actualiza el estado.'); return; }
    operationRef.current = true; generationRef.current++; setAction(requested); setError(null); setMessage(null);
    setOperation(requested === 'checkpoint' ? 'Creando punto de restauración…' : requested === 'finish' ? 'Finalizando prueba y restaurando el punto…' : 'Restaurando punto de restauración…');
    if (target) { setRestoreScrollPending(true); setRestoreVerification(target); }
    else { setRestoreVerification(null); setBaseline(null); baselineRef.current = null; }
    try {
      // Capture ML state immediately before opening the cycle. It is accepted
      // only when its dataVersion matches the revision recorded by the checkpoint.
      const checkpointBaseline = requested === 'checkpoint'
        ? await apiClient.getForecastMlUpdateStatus().catch(() => null) : null;
      const response = requested === 'checkpoint' ? await apiClient.createMlTestCheckpoint() : await apiClient.restoreMlTestCheckpoint(requested);
      if (response.httpStatus < 200 || response.httpStatus >= 300 || !response.data) throw new Error(friendlyFailure(response.httpStatus));
      if (requested === 'checkpoint') {
        const created = response.data;
        const createdCheckpointId = created.checkpointId || created.checkpoint?.checkpointId || null;
        const createdRevision = created.checkpoint?.dataVersion;
        const validBaseline = checkpointBaseline?.httpStatus === 200 && checkpointBaseline.data && createdCheckpointId
          && created.testCycleId && created.resetEpoch && createdRevision != null
          && String(checkpointBaseline.data.dataVersion) === String(createdRevision);
        if (createdCheckpointId && created.testCycleId && created.resetEpoch && /^\d+$/.test(String(createdRevision ?? ''))) {
          const captured = { checkpointId: createdCheckpointId, testCycleId: created.testCycleId,
            baselineRevision: String(createdRevision ?? ''), resetEpoch: created.resetEpoch,
            globalMl: validBaseline ? { dataVersion: checkpointBaseline.data!.dataVersion,
              horizons: ([7, 14] as const).map(days => ({ horizonDays: days,
                activeModelVersion: activeVersion(checkpointBaseline.data!, days),
                pendingSignalCount: pendingCount(checkpointBaseline.data!, days) })) } : null };
          baselineRef.current = captured;
          setBaseline(captured);
        }
      }
      if (target) {
        apiClient.invalidateIntelligenceReads();
        const lifecycle = await apiClient.getMlTestLifecycleStatus(); const next = lifecycle.data;
        const advanced = next && /^\d+$/.test(next.resetEpoch) && BigInt(next.resetEpoch) > BigInt(target.resetEpoch);
        const correctState = target.mode === 'continue' ? next?.state === 'TEST_ACTIVE' && next.checkpoint?.status === 'READY'
          && next.checkpointId === target.checkpointId && next.testCycleId === target.testCycleId : next?.state === 'NO_TEST' && next.testCycleId === null;
        if (lifecycle.httpStatus !== 200 || !next || !advanced || !correctState) throw new Error('No se pudo confirmar el ciclo después de restaurar.');
        const ml = await apiClient.getForecastMlUpdateStatus();
        let verification = response.data.activityAfterRestore;
        if (target.mode === 'continue') {
          const observed = await apiClient.getMlTestActivity();
          if (observed.httpStatus === 200 && observed.data && observed.data.testCycleId === next.testCycleId) {
            verification = { ...observed.data.summary, checkpointId: observed.data.checkpointId, resetEpoch: observed.data.resetEpoch,
              status: observed.data.summary.totalSales === 0 && observed.data.summary.cancellationCount === 0 ? 'EMPTY' : 'NOT_EMPTY' };
          } else verification = { status: 'UNAVAILABLE' };
        }
        if (ml.httpStatus !== 200 || !ml.data || !activityEmpty(verification, target, next.resetEpoch))
          throw new Error('La restauración terminó, pero no se pudo confirmar la revisión y la ausencia de actividad posterior.');
        setRestoreVerification({ ...target, phase: 'COMPLETE', observed: ml.data, activity: verification });
        if (target.mode === 'continue' && sameBaselineIdentity(initial, status)) {
          const continued = { ...initial!, resetEpoch: next.resetEpoch };
          baselineRef.current = continued; setBaseline(continued);
        } else {
          setBaseline(null); baselineRef.current = null;
        }
        setActivity(null); setCurrentMl(ml.data); setAnalysisResults({}); setAnalysisErrors({});
      } else setMessage('Punto de restauración creado. Puedes usar normalmente el sistema.');
      await refresh(true);
    } catch (failure) {
      const text = failure instanceof Error ? failure.message : 'No se pudo completar la operación local.';
      setError(text); if (target) setRestoreVerification({ ...target, phase: 'FAILED', message: text });
    } finally { operationRef.current = false; setAction(null); setOperation(null); }
  };

  const loadMore = async () => {
    if (!activity?.page.nextCursor || readingRef.current || operationRef.current) return;
    const previous = activity; readingRef.current = true; setReading(true);
    try {
      const response = await apiClient.getMlTestActivity({ cursor: previous.page.nextCursor!, limit: 20 });
      const next = response.data;
      if (response.httpStatus !== 200 || !next || next.checkpointId !== previous.checkpointId || next.resetEpoch !== previous.resetEpoch
          || next.testCycleId !== previous.testCycleId || next.summary.currentRevision !== previous.summary.currentRevision) throw new Error();
      if (!mounted.current) return;
      const products = [...new Map([...previous.products, ...next.products].map(product => [product.sku, product])).values()];
      setActivity({ ...next, products }); setVisibleCount(count => count + 5);
    } catch { if (mounted.current) setError('No se pudieron cargar más productos. Actualiza la actividad.'); }
    finally { readingRef.current = false; if (mounted.current) setReading(false); }
  };

  const analyze = async () => {
    if (!status || !activity || operationRef.current || readingRef.current) return;
    if (!window.confirm('Se revisará la evidencia global para 7 y 14 días respetando madurez, debounce, cooldown y 107 orígenes.')) return;
    const token = status; operationRef.current = true; setAnalysisResults({}); setAnalysisErrors({}); setMessage(null);
    try {
      for (const days of [7, 14] as const) {
        setAnalysisRunning(days);
        const before = await apiClient.getMlTestLifecycleStatus();
        if (before.httpStatus !== 200 || !sameCycle(before.data, token)) { setActivity(null); setCurrentMl(null); setError('El ciclo cambió; el análisis se detuvo.'); return; }
        let response; try { response = await apiClient.analyzeMlTestScenario(days); } catch { response = { httpStatus: 0 }; }
        const result = response.data;
        if (response.httpStatus !== 200 || !result) { setAnalysisErrors(previous => ({ ...previous, [days]: analysisFailureCopy(response.httpStatus) })); break; }
        if (result.horizonDays !== days || result.testCycleId !== token.testCycleId || result.resetEpoch !== token.resetEpoch) { setActivity(null); setCurrentMl(null); setError('El ciclo cambió; el análisis se detuvo.'); return; }
        setAnalysisResults(previous => ({ ...previous, [days]: result }));
      }
      await refresh(true);
    } catch { setError('No se pudo completar la revisión global. Actualiza el estado.'); }
    finally { operationRef.current = false; setAnalysisRunning(null); }
  };

  if (!ready || !status) return null;
  const active = status.state === 'TEST_ACTIVE' && status.checkpoint?.status === 'READY' && !status.maintenance;
  const busy = Boolean(action) || analysisRunning !== null || reading;
  const filtered = activity?.products.filter(product => (product.name + ' ' + product.sku).toLowerCase().includes(filter.toLowerCase())) || [];
  const globalBaseline = sameBaselineIdentity(baseline, status) ? baseline!.globalMl : null;
  return <section id="ml-test-controls" aria-labelledby="ml-test-controls-title" className="space-y-4">
    <div><h2 id="ml-test-controls-title" className="text-xl font-semibold">Pruebas del Machine Learning</h2><p className="font-medium">Prueba libre del Machine Learning</p><p className="text-sm text-muted-foreground">Usa normalmente el sistema. Las ventas de la pantalla habitual y del asistente se observan desde el diario operacional. Pruebas habilitadas solo localmente.</p></div>
    <Card><CardHeader><CardTitle className="text-base">Estado de la prueba</CardTitle><CardDescription>El punto de restauración permite volver al estado inicial.</CardDescription></CardHeader><CardContent className="space-y-3">
      <Badge>{lifecycleLabel(status.state)}</Badge><p>Punto de restauración: {status.checkpoint?.status === 'READY' ? 'Listo' : 'Aún no disponible'}</p>
      <details className="text-xs"><summary className="cursor-pointer">Detalles técnicos del ciclo</summary><p>Ciclo: {status.testCycleId || 'Ninguno'} · Época: {status.resetEpoch}</p><p>Revisión capturada: {status.checkpoint?.dataVersion || 'No disponible'}</p></details>
      {operation && <p role="status" className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" />{operation}</p>}
      <div className="flex flex-wrap gap-2">{status.state === 'NO_TEST' && <Button disabled={busy} onClick={() => void run('checkpoint')}>Iniciar prueba</Button>}
        {active && <><Button variant="outline" disabled={busy} onClick={() => void run('continue')}>Restaurar punto de restauración</Button><Button variant="destructive" disabled={busy} onClick={() => void run('finish')}>Finalizar prueba</Button></>}
        <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>Actualizar estado</Button></div>
      {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    </CardContent></Card>
    {active && <>
      <Card><CardHeader><CardTitle className="text-base">Actividad de esta prueba</CardTitle><CardDescription>Ventas y cancelaciones posteriores a la revisión del punto de restauración. Las compras no se cuentan como evidencia Ridge de demanda.</CardDescription></CardHeader><CardContent className="space-y-4">
        {activity ? <dl className="grid gap-3 text-sm sm:grid-cols-3">{[['Ventas registradas', activity.summary.totalSales], ['Unidades vendidas', activity.summary.grossUnits], ['Productos afectados', activity.summary.affectedProducts], ['Cancelaciones', activity.summary.cancellationCount]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}<div><dt className="text-muted-foreground">Revisión inicial → actual</dt><dd>{activity.summary.baselineRevision} → {activity.summary.currentRevision}</dd></div></dl> : <p>No hay una lectura de actividad verificada.</p>}
        {activity && activity.summary.totalSales === 0 && activity.summary.cancellationCount === 0 && <p>Aún no se detectaron ventas ni cancelaciones en esta prueba.</p>}
        <p className="text-xs text-muted-foreground">Las unidades son ventas brutas registradas. Las cancelaciones se muestran aparte y no se cuentan como ventas nuevas.</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void refresh()}>{reading ? 'Consultando actividad…' : 'Actualizar actividad'}</Button><Button variant="outline" asChild><Link href="/transactions/sale" target="_blank" rel="noopener noreferrer">Abrir pantalla de ventas</Link></Button></div>
        <p className="text-xs text-muted-foreground">La pantalla de ventas se abrirá en otra pestaña para conservar esta prueba.</p>
        {activity && activity.products.length > 0 && <section aria-label="Productos afectados" className="space-y-3"><h3 className="font-medium">Productos afectados</h3><label className="block text-sm">Filtrar productos cargados por nombre o SKU<Input value={filter} onChange={event => { setFilter(event.target.value); setVisibleCount(5); }} /></label>
          {filtered.slice(0, visibleCount).map(product => <ActivityProduct key={product.sku + ':' + readVersion} product={product} />)}
          {filtered.length === 0 && <p>No hay coincidencias entre los productos cargados.</p>}
          <div className="flex gap-2">{filtered.length > visibleCount ? <Button variant="outline" disabled={busy} onClick={() => setVisibleCount(count => count + 5)}>Ver más productos</Button> : activity.page.nextCursor && <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>Cargar más productos</Button>}{visibleCount > 5 && <Button variant="ghost" onClick={() => setVisibleCount(5)}>Mostrar menos</Button>}</div>
        </section>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Impacto global del ML</CardTitle><CardDescription>La revisión, las señales y los modelos ACTIVE pertenecen al negocio; no se atribuyen a cada SKU.</CardDescription></CardHeader><CardContent className="space-y-4">
        {currentMl ? <GlobalMetrics baseline={globalBaseline} current={currentMl} baselineRevision={status.checkpoint?.dataVersion || 'No disponible'} /> : <p>No se pudo leer el estado global del ML.</p>}
        {!globalBaseline && <p className="text-xs text-muted-foreground">No se capturó una referencia global en la revisión inicial; no se inventan señales ni versiones anteriores.</p>}
        {currentMl?.horizons.map(row => <div key={row.horizonDays}><p className="font-medium">Ridge {row.horizonDays} días</p><p className="text-sm">{eligibilityCopy(row.eligibility)}</p></div>)}
        <p className="text-sm">107 orígenes maduros no significan 107 ventas. Una venta nueva no garantiza entrenamiento ni promoción de v1 a v2.</p>
        <Button disabled={busy || !activity} onClick={() => void analyze()}>{analysisRunning ? 'Analizando ' + analysisRunning + ' días…' : 'Analizar ML'}</Button>
        {(analysisResults[7] || analysisResults[14] || analysisErrors[7] || analysisErrors[14]) && <AnalysisResults results={analysisResults} errors={analysisErrors} />}
      </CardContent></Card>
    </>}
    {restoreVerification && <Card ref={restoreResultRef} id="ml-test-restore-result" role="region" aria-label="Verificación de restauración" className="scroll-mt-24"><CardHeader><CardTitle className="text-base">{restoreVerification.phase === 'VERIFYING' ? 'Restaurando punto de restauración…' : restoreVerification.phase === 'COMPLETE' ? 'Restauración completada' : 'No se pudo verificar la restauración'}</CardTitle><CardDescription>Verificación de revisión, señales globales, modelos ACTIVE y ausencia de actividad posterior. No incluye comparación analítica inicial por SKU.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm">
      {restoreVerification.phase === 'VERIFYING' ? <p>Al finalizar, se volverán a consultar el ciclo y el estado global.</p> : restoreVerification.phase === 'FAILED' ? <p role="alert">{restoreVerification.message}</p> : restoreVerification.observed && <>
        {restoreMatches(restoreVerification) ? <p className="font-medium text-emerald-700">Coincide con el punto de restauración en las métricas globales verificadas</p> : <p role="alert">La verificación global contiene diferencias o valores iniciales no capturados; no se presenta como coincidencia completa.</p>}
        <section aria-label="Verificación global restaurada"><GlobalMetrics baseline={restoreVerification.baseline} current={restoreVerification.observed} baselineRevision={restoreVerification.baselineRevision} /></section>
        <p>Actividad posterior al punto de restauración: vacía y verificada.</p>
        {restoreVerification.mode === 'finish' && <p>Prueba finalizada.</p>}
      </>}
      {restoreVerification.phase !== 'VERIFYING' && <Button variant="ghost" onClick={() => { setRestoreVerification(null); setRestoreScrollPending(false); }}>Cerrar resultado</Button>}
    </CardContent></Card>}
  </section>;
}

function ActivityProduct({ product }: { product: MlTestActivityProduct }) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<ProductInventory | null>(null);
  const [forecast, setForecast] = useState<Record<7 | 14, ForecastObservation> | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!open || loaded) return;
    let active = true;
    void Promise.all([apiClient.getBusinessIntelligenceProductInventory(product.sku).catch(() => null),
      readForecastObservation(product.sku, 7), readForecastObservation(product.sku, 14)]).then(([response, seven, fourteen]) => {
      if (!active) return;
      setInventory(response?.success && response.data?.product.sku === product.sku ? response.data : null);
      setForecast({ 7: seven, 14: fourteen }); setLoaded(true);
    });
    return () => { active = false; };
  }, [loaded, open, product.sku]);
  return <details className="rounded-md border p-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm"><span className="font-medium">{product.name} · {product.sku}</span><span className="mt-1 block text-muted-foreground">{product.saleCount} ventas · {product.totalQuantity} unidades · {product.cancellationCount} cancelaciones · Última actividad: {formatDate(product.latestActivityAt)}</span></summary>
    {open && <div className="mt-3 space-y-3"><div><h4 className="font-medium">Operaciones recientes</h4><ul className="space-y-1 text-xs">{product.operations.map((operation, index) => <li key={operation.revision + ':' + index}>{operation.kind === 'SALE_COMPLETED' ? 'Venta completada al registrar' : 'Cancelación de venta'} · {operation.quantity} unidades · {formatDate(operation.occurredAt)} · Revisión {operation.revision} · Ref. {operation.transactionId}</li>)}</ul>{product.operationCount > product.operations.length && <p className="text-xs text-muted-foreground">Se muestran las últimas {product.operations.length} de {product.operationCount} operaciones; los totales incluyen todas.</p>}</div>
      <section aria-label={'Estado actual ' + product.sku}><h4 className="font-medium">Estado actual</h4><p className="text-xs text-muted-foreground">Estas métricas reflejan el estado actual del producto después de las operaciones detectadas.</p>
        {!loaded ? <p>Consultando métricas actuales…</p> : <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2"><div><dt>Stock</dt><dd>{displayValue(inventory?.stock.onHand)}</dd></div>{([7, 14] as const).map(days => <div key={days}><dt>Pronóstico Ridge {days}d</dt><dd>{forecast?.[days].state === 'AVAILABLE' ? displayValue(forecast[days].units) + ' unidades' : 'No disponible'}</dd></div>)}<div><dt>Cobertura</dt><dd>{inventory?.coverage.daysCover == null ? 'No disponible' : displayValue(inventory.coverage.daysCover) + ' días'}</dd></div><div><dt>Riesgo</dt><dd>{inventory?.risk.level || 'No disponible'}</dd></div><div><dt>Cantidad para el nivel objetivo</dt><dd>{displayValue(inventory?.recommendation.recommendedQty)}</dd></div></dl>}
      </section></div>}
  </details>;
}

function AnalysisResults({ results, errors }: { results: Partial<Record<7 | 14, MlTestScenarioAnalysisResult>>; errors: Partial<Record<7 | 14, string>> }) {
  return <section aria-label="Resultado de la revisión ML" className="space-y-3"><div><p className="font-medium">Resultado global de la revisión ML</p><p className="text-sm text-muted-foreground">Los resultados pertenecen al negocio y no a un producto individual. La política vigente decide la promoción.</p></div>{([7, 14] as const).map(days => { const result = results[days]; const error = errors[days]; if (!result && !error) return null; return <article key={days} className="rounded-md border p-3 text-sm"><h4 className="font-medium">{days} días</h4>{error ? <p role="alert" className="mt-1 text-destructive">{error}</p> : result && <><p className="mt-1">{analysisOutcomeCopy(result)}</p><dl className="mt-2 grid gap-2 sm:grid-cols-2"><div><dt className="text-muted-foreground">Entrenamiento</dt><dd>{result.trained ? 'Sí' : 'No'}</dd></div><div><dt className="text-muted-foreground">Candidato creado</dt><dd>{result.candidateCreated ? 'Sí' : 'No'}</dd></div><div><dt className="text-muted-foreground">Modelo promovido</dt><dd>{result.promoted ? 'Sí' : 'No'}</dd></div><div><dt className="text-muted-foreground">Orígenes requeridos / disponibles</dt><dd>{result.requiredOrigins} / {result.availableOrigins ?? 'No disponible'}</dd></div></dl>{result.activeModelBefore && result.activeModelAfter && <p className="mt-2 text-muted-foreground">ACTIVE: {result.activeModelBefore.modelVersion == null ? 'No disponible' : `v${result.activeModelBefore.modelVersion}`} → {result.activeModelAfter.modelVersion == null ? 'No disponible' : `v${result.activeModelAfter.modelVersion}`}</p>}<details className="mt-2 rounded border px-2 py-1 text-xs"><summary className="cursor-pointer">Ver detalles técnicos</summary><dl className="mt-2 grid gap-1"><div><dt className="text-muted-foreground">reasonCode</dt><dd>{result.reasonCode || 'No disponible'}</dd></div><div><dt className="text-muted-foreground">Resultado técnico</dt><dd>{result.outcome}</dd></div></dl></details></>}</article>; })}{errors[7] && <p className="text-sm text-muted-foreground">No se ejecutó el horizonte de 14 días porque falló la solicitud de 7 días.</p>}</section>;
}
