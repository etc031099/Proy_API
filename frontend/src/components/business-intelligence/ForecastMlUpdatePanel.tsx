'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ForecastMlUpdateHorizonStatus, ForecastMlUpdateStatus } from '@/types/businessIntelligence';

const POLL_INTERVAL_MS = 8_000;
const SLOW_POLL_INTERVAL_MS = 15_000;
const FAST_POLL_WINDOW_MS = 2 * 60_000;
const POLL_WINDOW_MS = 8 * 60_000;
const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;

export function nextAutomaticReview(now = new Date()): string {
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(17);
  while (candidate <= now || candidate.getUTCMinutes() !== 17 || candidate.getUTCHours() % 6 !== 0) candidate.setTime(candidate.getTime() + 60_000);
  const time = new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' }).format(candidate);
  const dateKey = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  const relative = dateKey(candidate) === dateKey(now) ? 'hoy' : 'mañana';
  return `${relative}, ${time} (hora Perú; aproximado)`;
}

const formatDate = (value: string | null | undefined) => {
  if (!value) return 'Aún no registrada';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'No disponible' : new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima',
  }).format(date);
};
const formatClosedDay = (value: string | null | undefined) => {
  if (!value) return 'No disponible';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? 'No disponible' : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
};
const modelVersion = (row?: ForecastMlUpdateHorizonStatus) => row?.activeModelVersion == null ? 'No disponible' : `v${row.activeModelVersion}`;
const signalLabels: Record<string, string> = { SALE_COMPLETED: 'Venta completada',
  SALE_CANCELLED: 'Venta cancelada', PRODUCT_UPDATED: 'Cambio en datos del producto relevantes para Ridge' };

export function readinessMessage(status: NonNullable<ForecastMlUpdateHorizonStatus['readiness']>['status'], pendingSignalCount = 0): string {
  switch (status) {
    case 'NO_CHANGES': return 'Sin cambios nuevos para revisar.';
    case 'SIGNALS_PENDING': return 'Hay señales nuevas registradas que todavía no se reflejan en el estado del worker.';
    case 'WAITING_DEBOUNCE': return pendingSignalCount > 0
      ? 'Hay señales registradas. Se agrupan antes de revisar el trabajo.'
      : 'El trabajo pendiente se agrupa antes de la próxima revisión.';
    case 'WAITING_MATURITY': return pendingSignalCount > 0
      ? 'Hay señales nuevas registradas. Aún están esperando madurez.'
      : 'La evidencia del horizonte aún está esperando madurez.';
    case 'WAITING_COOLDOWN': return 'Esperando el intervalo de seguridad antes de la próxima revisión.';
    case 'READY_FOR_WORKER_REVIEW': return 'Listo para que el worker revise la nueva evidencia; esto no implica aprobación de promoción.';
    case 'WORKER_ACTIVE': return 'Hay una revisión en curso.';
    default: return 'Estado de preparación no disponible; consulta los detalles técnicos.';
  }
}

const signalDate = (value: string | null) => value ? formatDate(value) : 'No registrada';

function hasPendingEvidence(status: ForecastMlUpdateStatus | null): boolean {
  return Boolean(status?.horizons.some(row => row.pending || row.readiness?.hasPendingSignals
    || (row.readiness?.pendingSignalCount ?? 0) > 0));
}

function headline(status: ForecastMlUpdateStatus | null, failure: string | null): string {
  if (failure) return 'ERROR';
  if (!status || status.horizons.length !== 2) return 'CONSULTANDO';
  if (status.horizons.some(row => row.currentlyRunning)) return 'ACTUALIZANDO';
  if (status.horizons.some(row => row.requestStatus === 'ALREADY_PENDING')) return 'SOLICITUD PENDIENTE';
  if (status.horizons.some(row => row.lastResult === 'LAST_RESULT_FAILED')) return 'ERROR';
  if (hasPendingEvidence(status)) return 'EVIDENCIA PENDIENTE';
  if (status.horizons.some(row => row.lastResult === 'LAST_RESULT_INSUFFICIENT_HISTORY'
    || ['NOT_MATURE', 'COOLDOWN_ACTIVE', 'PREVIOUS_FAILURE_NOT_RETRYABLE'].includes(row.lastEvaluationReason || ''))) return 'NO ELEGIBLE';
  if (status.horizons.every(row => row.lastResult === 'LAST_RESULT_NO_PENDING')) return 'SIN CAMBIOS';
  if (status.horizons.every(row => row.activeModelVersion != null)) return 'ACTIVO';
  return 'NO DISPONIBLE';
}

function requestFailure(result: AuthenticatedDiagnosticResult<unknown>): string {
  if (result.httpStatus === 401 || result.httpStatus === 403) return 'Tu sesión no tiene acceso a esta solicitud. Revisa tu sesión y vuelve a intentar.';
  if (result.httpStatus === 429) return 'Se alcanzó el límite de solicitudes. Espera un minuto antes de volver a intentar.';
  if (result.httpStatus === 400) return 'La solicitud no fue aceptada. Recarga el estado y vuelve a intentar.';
  if (result.httpStatus === 0 || result.httpStatus >= 500) return 'No se pudo confirmar la respuesta del servicio. Revisa el estado antes de volver a solicitar.';
  return 'No se pudo enviar la solicitud. Revisa el estado antes de volver a intentar.';
}

function requestMessage(result: AuthenticatedDiagnosticResult<import('@/types/businessIntelligence').ForecastMlUpdateRequestResult>) {
  if (!result.data) return requestFailure(result);
  if (result.data.dispatchStatus === 'DEFERRED') return 'Solicitud guardada; se procesará automáticamente.';
  if (result.data.requestStatus === 'ALREADY_PENDING') return 'Ya existe una actualización pendiente.';
  if (result.data.requestStatus === 'RUNNING') return 'La actualización está en curso.';
  if (result.data.requestStatus === 'REQUEST_ACCEPTED') return 'Actualización solicitada.';
  return 'Solicitud recibida. Consulta el estado para ver el avance.';
}

function reasonMessage(status: ForecastMlUpdateStatus | null) {
  if (!status) return null;
  const reasons = status.horizons.map(row => row.lastEvaluationReason);
  if (reasons.includes('NO_PROMOTION_INSUFFICIENT_HISTORY')
      || status.horizons.some(row => row.lastResult === 'LAST_RESULT_INSUFFICIENT_HISTORY')) {
    return 'El sistema recibió la solicitud, pero aún no hay suficiente evidencia madura para generar un nuevo modelo.';
  }
  if (reasons.includes('NOT_MATURE')) return 'La evidencia todavía debe completar su período de madurez antes de evaluar un nuevo modelo.';
  if (reasons.includes('COOLDOWN_ACTIVE')) return 'El sistema esperará el intervalo de seguridad antes de una nueva evaluación.';
  if (status.horizons.some(row => row.lastResult === 'LAST_RESULT_REJECTED')) return 'La evaluación no cumplió los criterios de promoción. El modelo activo se conserva.';
  if (status.horizons.some(row => row.lastResult === 'LAST_RESULT_FAILED')) return 'No se pudo completar la evaluación. El modelo activo se conserva; puedes consultar el estado nuevamente.';
  return null;
}

function preparationSummary(status: ForecastMlUpdateStatus | null, statusError: string | null): string {
  if (statusError) return 'No se pudo confirmar el estado del ML. Actualiza el estado para volver a consultar.';
  if (!status) return 'Consultando la preparación de los modelos activos.';
  if (status.horizons.some(row => row.currentlyRunning)) return 'Hay una revisión en curso para uno de los horizontes.';
  if (hasPendingEvidence(status)) {
    const readiness = status.horizons.map(row => row.readiness?.status);
    if (readiness.includes('WAITING_MATURITY')) return 'Hay evidencia pendiente, pero todavía no es madura.';
    if (readiness.includes('WAITING_DEBOUNCE')) return 'Hay evidencia pendiente; el sistema agrupa los cambios antes de revisar.';
    if (readiness.includes('WAITING_COOLDOWN')) return 'Hay evidencia pendiente; se espera el intervalo de seguridad para revisarla.';
    if (readiness.includes('READY_FOR_WORKER_REVIEW')) return 'Hay evidencia lista para revisión; esto no implica que un modelo vaya a promoverse.';
    return 'Hay evidencia pendiente de revisión.';
  }
  return reasonMessage(status) || 'No hay señales pendientes; los modelos LIVE siguen disponibles.';
}

function friendlyHeadline(value: string): string {
  switch (value) {
    case 'ACTUALIZANDO': return 'Revisión en curso';
    case 'SOLICITUD PENDIENTE': return 'Solicitud pendiente';
    case 'EVIDENCIA PENDIENTE': return 'Evidencia pendiente';
    case 'NO ELEGIBLE': return 'Aún no elegible';
    case 'SIN CAMBIOS': return 'Sin cambios pendientes';
    case 'ACTIVO': return 'Modelos activos';
    case 'ERROR': return 'Error';
    case 'CONSULTANDO': return 'Consultando';
    default: return 'No disponible';
  }
}

function completionMessage(status: ForecastMlUpdateStatus): string {
  if (status.horizons.some(row => row.lastResult === 'LAST_RESULT_FAILED')) {
    return 'No se pudo completar la evaluación. El modelo activo se conserva; puedes consultar el estado nuevamente.';
  }
  if (status.horizons.some(row => row.lastResult === 'LAST_RESULT_PROMOTED')) {
    return 'Evaluación completada. Se activó una nueva versión.';
  }
  if (status.horizons.some(row => row.lastResult === 'LAST_RESULT_REJECTED')) {
    return 'Evaluación completada. El candidato no cumplió los criterios y se conserva el modelo activo.';
  }
  if (status.horizons.every(row => row.lastResult === 'LAST_RESULT_NO_PENDING')) {
    return 'Revisión completada: no había trabajo pendiente. El modelo activo no cambió.';
  }
  if (status.horizons.some(row => row.lastEvaluationReason === 'NOT_MATURE')) {
    return 'Revisión completada. La evidencia todavía debe completar su período de madurez antes de evaluar un nuevo modelo.';
  }
  return reasonMessage(status) || 'Estado actualizado. Las versiones activas siguen disponibles.';
}

const isSettled = (status: ForecastMlUpdateStatus) => status.horizons.length === 2
  && status.horizons.every(row => !row.currentlyRunning
    && row.requestStatus !== 'ALREADY_PENDING' && row.requestStatus !== 'RUNNING');

function technicalValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return safeCode(value) || (typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : 'No disponible');
}

export function ForecastMlUpdatePanel({ refreshToken = 0, onManualRequestFinished }: {
  refreshToken?: number; onManualRequestFinished?: () => void;
}) {
  const [status, setStatus] = useState<ForecastMlUpdateStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [requestActive, setRequestActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestLock = useRef(false);
  const requestActiveRef = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPollWait = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const finishRequest = useCallback((finishedStatus: ForecastMlUpdateStatus, notifyHistory = false) => {
    const wasTrackingRequest = requestActiveRef.current;
    requestActiveRef.current = false;
    setRequestActive(false);
    setMessage(completionMessage(finishedStatus));
    if (wasTrackingRequest || notifyHistory) onManualRequestFinished?.();
  }, [onManualRequestFinished]);
  const refreshStatus = useCallback(async () => {
    const result = await apiClient.getForecastMlUpdateStatus();
    if (!alive.current) return result;
    if (result.httpStatus >= 200 && result.httpStatus < 300 && result.data) {
      setStatus(result.data); setStatusError(null);
      if (requestActiveRef.current && isSettled(result.data)) {
        finishRequest(result.data);
      }
    } else {
      setStatusError(result.httpStatus === 401 ? 'Sesión no autorizada. Inicia sesión nuevamente.'
        : 'No se pudo consultar el estado del ML. Puedes reintentar.');
    }
    setLoading(false);
    return result;
  }, [finishRequest]);

  useEffect(() => {
    alive.current = true;
    void refreshStatus();
    return () => {
      alive.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
      cancelPollWait.current?.();
      cancelPollWait.current = null;
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (refreshToken > 0) void refreshStatus();
  }, [refreshStatus, refreshToken]);

  const rows = useMemo(() => status?.horizons || [], [status]);

  const pollAfterRequest = useCallback(async () => {
    const startedAt = Date.now();
    const expiresAt = startedAt + POLL_WINDOW_MS;
    while (alive.current && Date.now() < expiresAt) {
      await new Promise<void>(resolve => {
        const elapsed = Date.now() - startedAt;
        const interval = elapsed < FAST_POLL_WINDOW_MS ? POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
        const delay = Math.min(interval, Math.max(0, expiresAt - Date.now()));
        const finish = () => { pollTimer.current = null; cancelPollWait.current = null; resolve(); };
        cancelPollWait.current = finish;
        pollTimer.current = setTimeout(finish, delay);
      });
      if (!alive.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') continue;
      const result = await apiClient.getForecastMlUpdateStatus();
      if (!alive.current) return;
      if (result.httpStatus >= 200 && result.httpStatus < 300 && result.data) {
        setStatus(result.data); setStatusError(null);
        if (isSettled(result.data)) {
          // One final read prevents stale intermediate status from ending the follow-up.
          const finalResult = await apiClient.getForecastMlUpdateStatus();
          if (!alive.current) return;
          if (finalResult.httpStatus >= 200 && finalResult.httpStatus < 300 && finalResult.data) {
            setStatus(finalResult.data); setStatusError(null);
            if (isSettled(finalResult.data)) {
              finishRequest(finalResult.data);
              return;
            }
          }
        }
      } else if (result.httpStatus === 401) {
        setStatusError('Sesión no autorizada. Inicia sesión nuevamente.'); return;
      }
    }
    if (alive.current && requestActiveRef.current) {
      setMessage('La evaluación continúa en segundo plano. Puedes actualizar el estado manualmente más tarde.');
    }
  }, [finishRequest]);

  const submit = useCallback(async () => {
    if (requestLock.current || requestActiveRef.current || rows.some(row => row.currentlyRunning || row.requestStatus === 'ALREADY_PENDING' || row.requestStatus === 'RUNNING')) return;
    requestLock.current = true; setSending(true); setMessage('Solicitando actualización…');
    try {
      const result = await apiClient.requestForecastMlUpdate();
      if (!alive.current) return;
      if (!result.data) {
        setMessage(requestFailure(result));
        await refreshStatus();
        return;
      }
      setMessage(requestMessage(result));
      const latest = await refreshStatus();
      if (latest?.data && isSettled(latest.data)) {
        finishRequest(latest.data, true);
      } else if (!latest?.data || !isSettled(latest.data)) {
        requestActiveRef.current = true;
        setRequestActive(true);
        void pollAfterRequest();
      }
    } catch {
      if (alive.current) setMessage('No se pudo confirmar la solicitud. Revisa el estado antes de volver a intentar.');
    } finally {
      requestLock.current = false;
      if (alive.current) setSending(false);
    }
  }, [finishRequest, pollAfterRequest, refreshStatus, rows]);

  const byHorizon = (horizon: 7 | 14) => rows.find(row => row.horizonDays === horizon);
  const currentHeadline = headline(status, statusError);
  const explanation = preparationSummary(status, statusError);
  const messageIsFinalResult = Boolean(message && (/^(Revisión|Evaluación) completada/.test(message)
    || message.startsWith('No se pudo completar la evaluación')));
  const statusTone = currentHeadline === 'ERROR' ? 'destructive' : currentHeadline === 'ACTIVO' ? 'default' : 'outline';
  const pending7 = byHorizon(7)?.readiness?.pendingSignalCount;
  const pending14 = byHorizon(14)?.readiness?.pendingSignalCount;
  const evaluationAt = rows.map(row => row.lastEvaluatedAt).filter((value): value is string => Boolean(value)).sort().at(-1);

  return <section aria-label="Resumen del ML" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">Resumen del ML</h3>
      <Button type="button" onClick={() => { void submit(); }} disabled={sending || requestActive || rows.some(row => row.currentlyRunning || row.requestStatus === 'ALREADY_PENDING' || row.requestStatus === 'RUNNING')}>
        {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
        {sending ? 'Solicitando actualización…' : 'Actualizar ML ahora'}
      </Button>
    </div>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <div className="rounded-md bg-muted/40 p-3"><p className="text-xs text-muted-foreground">Estado general</p><Badge className="mt-1" variant={statusTone}>{loading ? 'Consultando' : friendlyHeadline(currentHeadline)}</Badge></div>
      <div className="rounded-md bg-muted/40 p-3"><p className="text-xs text-muted-foreground">Ridge LIVE · 7 días</p><p className="mt-1 font-semibold">{modelVersion(byHorizon(7))} · {byHorizon(7)?.activeModelVersion == null ? 'No disponible' : 'Activo'}</p></div>
      <div className="rounded-md bg-muted/40 p-3"><p className="text-xs text-muted-foreground">Ridge LIVE · 14 días</p><p className="mt-1 font-semibold">{modelVersion(byHorizon(14))} · {byHorizon(14)?.activeModelVersion == null ? 'No disponible' : 'Activo'}</p></div>
      <div className="rounded-md bg-muted/40 p-3"><p className="text-xs text-muted-foreground">Revisión de datos</p><p className="mt-1 font-semibold">{technicalValue(status?.dataVersion)}</p></div>
      <div className="min-w-0 rounded-md bg-muted/40 p-3"><p className="text-xs text-muted-foreground">Última evaluación</p><p className="mt-1 whitespace-nowrap font-semibold">{formatDate(evaluationAt)}</p></div>
      <div className="rounded-md bg-muted/40 p-3"><p className="text-xs text-muted-foreground">Actualización automática</p><p className="mt-1 font-semibold">Activa · cada 6 h</p></div>
    </div>
    {statusError && <p role="alert" className="text-sm text-destructive">{statusError}</p>}
    {message && <p role="status" aria-live="polite" className="text-sm">{message}</p>}
    {status && <>
      <section aria-label="Preparación para próxima evaluación" className="rounded-lg border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h4 className="font-medium">Preparación para próxima evaluación</h4>{!messageIsFinalResult && <p role="status" className="mt-1 text-sm text-muted-foreground">{explanation}</p>}</div>
          <Badge variant="outline">{hasPendingEvidence(status) ? 'Evidencia pendiente' : 'Sin evidencia pendiente'}</Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Señales pendientes: 7d {pending7 ?? 'No disponible'} · 14d {pending14 ?? 'No disponible'}</p>
        <details className="mt-2 border-t pt-2 text-sm"><summary className="cursor-pointer font-medium">Ver detalles</summary>
          <dl className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div><dt>Cierre operativo vigente</dt><dd>{formatClosedDay(status.closedThrough)}</dd></div>
            {rows.map(row => <div key={`ready-${row.horizonDays}`}><dt>Ridge {row.horizonDays}d · estado / elegibilidad / motivo</dt><dd>{technicalValue(row.readiness?.status)} / {technicalValue(row.readiness?.eligibility)} / {technicalValue(row.readiness?.reasonCode)}</dd></div>)}
            {rows.map(row => <div key={`count-${row.horizonDays}`}><dt>Ridge {row.horizonDays}d · tipos de señal</dt><dd>{row.readiness?.pendingSignalTypes?.length ? row.readiness.pendingSignalTypes.map(type => signalLabels[type] || 'Otra señal').join(', ') : 'Ninguna registrada'}</dd></div>)}
            {rows.map(row => <div key={`time-${row.horizonDays}`}><dt>Ridge {row.horizonDays}d · primera / última señal</dt><dd>{signalDate(row.readiness?.firstPendingSignalAt || null)} / {signalDate(row.readiness?.lastPendingSignalAt || null)}</dd></div>)}
            {rows.map(row => <div key={`revision-${row.horizonDays}`}><dt>Ridge {row.horizonDays}d · revisión procesada / última con señales</dt><dd>{technicalValue(row.readiness?.processedRevision)} / {technicalValue(row.readiness?.latestPendingRevision)}</dd></div>)}
            {rows.map(row => <div key={`origins-${row.horizonDays}`}><dt>Ridge {row.horizonDays}d · orígenes disponibles / requeridos</dt><dd>{row.readiness?.availableOriginsActual == null ? 'No disponible' : row.readiness.availableOriginsActual} / {row.readiness?.requiredOrigins ?? row.requiredOrigins}</dd></div>)}
            {rows.map(row => <div key={`next-${row.horizonDays}`}><dt>Ridge {row.horizonDays}d · próxima elegibilidad</dt><dd>{formatDate(row.readiness?.nextEligibleAt || row.nextEligibleAt)}</dd></div>)}
            {rows.map(row => <div key={`trigger-${row.horizonDays}`}><dt>Ridge {row.horizonDays}d · origen / resultado</dt><dd>{technicalValue(row.trigger)} / {technicalValue(row.lastEvaluationReason || row.lastResult)}</dd></div>)}
            <div><dt>Política de evidencia</dt><dd>107 orígenes maduros no significan 107 ventas.</dd></div>
          </dl>
        </details>
      </section>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Ver detalles operativos</summary>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          <div><dt>Próxima revisión automática aproximada</dt><dd>{nextAutomaticReview()}</dd></div>
          <div><dt>Última solicitud manual</dt><dd>{formatDate(rows.map(row => row.lastRequestAt).filter(Boolean).sort().at(-1))}</dd></div>
          <div><dt>Último intento elegible del worker</dt><dd>{formatDate(rows.map(row => row.lastAttemptAt).filter(Boolean).sort().at(-1))}</dd></div>
          <div><dt>Último resultado operativo</dt><dd>{rows.map(row => technicalValue(row.lastEvaluationReason || row.lastResult)).filter(value => value !== 'No disponible').join(' · ') || 'No registrado'}</dd></div>
          {rows.map(row => <div key={`trained-${row.horizonDays}`}><dt>Revisión de datos usada por Ridge {row.horizonDays}d</dt><dd>{technicalValue(row.trainedDataVersion)}</dd></div>)}
        </dl>
      </details>
    </>}
  </section>;
}
