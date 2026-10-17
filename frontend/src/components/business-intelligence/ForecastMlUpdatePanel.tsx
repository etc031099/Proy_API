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

function headline(status: ForecastMlUpdateStatus | null, failure: string | null): string {
  if (failure) return 'ERROR';
  if (!status || status.horizons.length !== 2) return 'CONSULTANDO';
  if (status.horizons.some(row => row.currentlyRunning)) return 'ACTUALIZANDO';
  if (status.horizons.some(row => row.pending)) return 'PENDIENTE';
  if (status.horizons.some(row => row.lastResult === 'LAST_RESULT_FAILED')) return 'ERROR';
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
    return 'Evaluación completada. No fue necesario cambiar el modelo.';
  }
  return reasonMessage(status) || 'Estado actualizado. Las versiones activas siguen disponibles.';
}

const isSettled = (status: ForecastMlUpdateStatus) => status.horizons.length === 2
  && status.horizons.every(row => !row.pending && !row.currentlyRunning);

function technicalValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return safeCode(value) || (typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : 'No disponible');
}

export function ForecastMlUpdatePanel({ refreshToken = 0 }: { refreshToken?: number }) {
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
  const refreshStatus = useCallback(async () => {
    const result = await apiClient.getForecastMlUpdateStatus();
    if (!alive.current) return result;
    if (result.httpStatus >= 200 && result.httpStatus < 300 && result.data) {
      setStatus(result.data); setStatusError(null);
      if (requestActiveRef.current && isSettled(result.data)) {
        requestActiveRef.current = false;
        setRequestActive(false);
        setMessage(completionMessage(result.data));
      }
    } else {
      setStatusError(result.httpStatus === 401 ? 'Sesión no autorizada. Inicia sesión nuevamente.'
        : 'No se pudo consultar el estado del ML. Puedes reintentar.');
    }
    setLoading(false);
    return result;
  }, []);

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
              requestActiveRef.current = false;
              setRequestActive(false);
              setMessage(completionMessage(finalResult.data));
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
  }, []);

  const submit = useCallback(async () => {
    if (requestLock.current || requestActiveRef.current || rows.some(row => row.pending || row.currentlyRunning)) return;
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
      const hasWork = Boolean(result.data.pending || latest?.data?.horizons.some(row => row.pending || row.currentlyRunning));
      if (hasWork) {
        requestActiveRef.current = true;
        setRequestActive(true);
        void pollAfterRequest();
      } else if (latest?.data) {
        setMessage(completionMessage(latest.data));
      }
    } catch {
      if (alive.current) setMessage('No se pudo confirmar la solicitud. Revisa el estado antes de volver a intentar.');
    } finally {
      requestLock.current = false;
      if (alive.current) setSending(false);
    }
  }, [pollAfterRequest, refreshStatus, rows]);

  const byHorizon = (horizon: 7 | 14) => rows.find(row => row.horizonDays === horizon);
  const currentHeadline = headline(status, statusError);
  const explanation = reasonMessage(status);
  const statusTone = currentHeadline === 'ERROR' ? 'destructive' : currentHeadline === 'ACTIVO' ? 'default' : 'outline';

  return <section aria-label="Actualización del ML" className="space-y-3 border-b pb-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold">Actualización del ML</h3><p className="mt-1 text-sm text-muted-foreground">La solicitud utiliza el mismo proceso automático y no garantiza una nueva versión.</p></div>
      <Button type="button" onClick={() => { void submit(); }} disabled={sending || requestActive || rows.some(row => row.pending || row.currentlyRunning)}>
        {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
        {sending ? 'Solicitando actualización…' : 'Actualizar ML ahora'}
      </Button>
    </div>
    <div className="flex flex-wrap items-center gap-2"><Badge variant={statusTone}>{loading ? 'CONSULTANDO' : currentHeadline}</Badge><span className="text-sm text-muted-foreground">Actualización automática: <span className="font-medium text-foreground">Activa · cada 6 horas</span></span></div>
    {statusError && <p role="alert" className="text-sm text-destructive">{statusError}</p>}
    {message && <p role="status" aria-live="polite" className="text-sm">{message}</p>}
    {explanation && <p role="status" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{explanation}</p>}
    <p className="text-xs text-muted-foreground">Próxima revisión automática: {nextAutomaticReview()}.</p>
    {status && <>
      <dl className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div><dt className="text-muted-foreground">Modelo activo 7d</dt><dd>{modelVersion(byHorizon(7))}</dd></div>
        <div><dt className="text-muted-foreground">Modelo activo 14d</dt><dd>{modelVersion(byHorizon(14))}</dd></div>
        <div><dt className="text-muted-foreground">Revisión de datos</dt><dd>{technicalValue(status.dataVersion)}</dd></div>
        <div><dt className="text-muted-foreground">Datos pendientes</dt><dd>{rows.some(row => row.pending) ? 'Sí' : 'No'}</dd></div>
        <div><dt className="text-muted-foreground">Última solicitud</dt><dd>{formatDate(rows.map(row => row.lastRequestAt).filter(Boolean).sort().at(-1))}</dd></div>
        <div><dt className="text-muted-foreground">Última ejecución</dt><dd>{formatDate(rows.map(row => row.lastAttemptAt).filter(Boolean).sort().at(-1))}</dd></div>
        <div><dt className="text-muted-foreground">Último resultado</dt><dd>{currentHeadline === 'SIN CAMBIOS' ? 'Sin cambios pendientes' : currentHeadline === 'NO ELEGIBLE' ? 'Aún no elegible' : currentHeadline === 'ERROR' ? 'Evaluación no completada' : rows.some(row => row.lastResult === 'LAST_RESULT_PROMOTED') ? 'Candidato promovido' : 'No hay un resultado nuevo'}</dd></div>
      </dl>
      <details className="rounded-md border p-3 text-sm"><summary className="cursor-pointer font-medium">Detalles técnicos</summary>
        <dl className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div><dt>Datos cerrados hasta</dt><dd>{formatClosedDay(status.closedThrough)}</dd></div>
          {rows.map(row => <div key={row.horizonDays}><dt>Horizonte {row.horizonDays}d · trigger / elegibilidad / resultado</dt><dd>{technicalValue(row.trigger)} / {technicalValue(row.eligibility)} / {technicalValue(row.lastEvaluationReason || row.lastResult)}</dd></div>)}
          {rows.map(row => <div key={`origins-${row.horizonDays}`}><dt>Horizonte {row.horizonDays}d · evidencia para promoción</dt><dd>{row.availableOrigins == null ? 'Se valida en la ejecución del worker' : `${row.availableOrigins}/${row.requiredOrigins}`}</dd></div>)}
          {rows.map(row => <div key={`version-${row.horizonDays}`}><dt>trainedDataVersion {row.horizonDays}d</dt><dd>{technicalValue(row.trainedDataVersion)}</dd></div>)}
          {rows.map(row => <div key={`dispatch-${row.horizonDays}`}><dt>Dispatch {row.horizonDays}d</dt><dd>{technicalValue(row.dispatchStatus)}</dd></div>)}
          <div><dt>Política</dt><dd>Horizontes 7d/14d · 107 origins · 1d no aprobado</dd></div>
        </dl>
      </details>
    </>}
  </section>;
}
