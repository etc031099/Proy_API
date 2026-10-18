'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ForecastActiveModel, ForecastActiveModels, HealthDiagnostic } from '@/types/businessIntelligence';
import { ForecastMlUpdatePanel } from './ForecastMlUpdatePanel';

type Props = { onForecastModelsChange: (models: ForecastActiveModel[] | null) => void;
  onManualRequestFinished?: () => void };
type SectionState = 'loading' | 'retrying' | 'ready' | 'error';

const DIAGNOSTIC_RETRY_DELAY_MS = 2500;
const TRANSIENT_DIAGNOSTIC_CODES = new Set(['SERVICE_TEMPORARILY_UNAVAILABLE', 'HEALTH_DIAGNOSTIC_TIMEOUT']);
const NON_TRANSIENT_DIAGNOSTIC_CODES = new Set([
  'AUTH_REQUIRED', 'SESSION_UNAUTHORIZED',
  'MODEL_NOT_APPROVED', 'PROMOTION_POLICY_FAILED', 'MODEL_UNAVAILABLE',
  'FEATURE_CONTRACT_MISMATCH', 'ARTIFACT_HASH_MISMATCH', 'ARTIFACT_INTEGRITY_FAILED',
  'ARTIFACT_INVALID', 'ARTIFACT_NOT_FOUND', 'ACTIVE_ARTIFACT_NOT_FOUND', 'ACTIVE_POINTER_MISSING',
  'ML_ARTIFACT_LOAD_FAILED', 'MODEL_LOAD_FAILED', 'MODEL_INTEGRITY_FAILED', 'MODEL_SCHEMA_INVALID',
]);

const codeText = (value?: string | null) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
const safeText = (value?: string | null) => typeof value === 'string' && /^[A-Z0-9_-]{1,64}$/.test(value) ? value : null;
const statusLabel = (value?: string | null) => {
  if (value === 'ACTIVE') return 'Activo';
  if (value === 'MODEL_NOT_APPROVED') return 'No aprobado';
  if (value === 'MODEL_UNAVAILABLE') return 'No disponible';
  if (value === 'READY') return 'Listo';
  if (value === 'PARTIAL') return 'Parcial';
  if (value === 'FAILED') return 'Fallido';
  if (value === 'UNKNOWN') return 'Desconocido';
  if (value === 'NOT_CHECKED') return 'No comprobado';
  return safeText(value) || 'No disponible';
};
const presence = (value?: boolean) => value === true ? 'Sí' : value === false ? 'No' : 'No comprobado';
const horizonLabel = (days: number) => days === 1 ? '1 día' : `${days} días`;
const dateLabel = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
};

function requestMessage<T>(result: AuthenticatedDiagnosticResult<T>): string | null {
  if (result.httpStatus === 401 || result.code === 'SESSION_UNAUTHORIZED') return 'Sesión no autorizada. Inicia sesión nuevamente.';
  if ([0, 502, 503, 504].includes(result.httpStatus) || result.code === 'SERVICE_TEMPORARILY_UNAVAILABLE') return 'Servicio temporalmente no disponible.';
  if (!result.data) return 'No se pudo obtener el diagnóstico.';
  return null;
}

function isTransientDiagnosticFailure<T>(result: AuthenticatedDiagnosticResult<T>, section: 'forecast' | 'health'): boolean {
  const diagnosticData = result.data as (HealthDiagnostic & { models?: ForecastActiveModel[] }) | undefined;
  const codes = [
    result.code,
    diagnosticData && 'reasonCode' in diagnosticData ? diagnosticData.reasonCode : null,
    ...(diagnosticData?.models || []).map(model => model.reasonCode),
  ].filter((code): code is string => typeof code === 'string');

  if (codes.some(code => NON_TRANSIENT_DIAGNOSTIC_CODES.has(code))) return false;
  if (result.httpStatus >= 400 && result.httpStatus < 500) return false;
  if (TRANSIENT_DIAGNOSTIC_CODES.has(result.code || '')) return true;
  if (section === 'health' && (diagnosticData?.httpStatus === 504 || diagnosticData?.reasonCode === 'HEALTH_DIAGNOSTIC_TIMEOUT')) return true;
  if (result.httpStatus === 0) return true;
  return result.httpStatus === 502 || result.httpStatus === 503 || result.httpStatus === 504;
}

function waitForRetry(delay: number, timers: Map<ReturnType<typeof setTimeout>, () => void>): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, delay);
    timers.set(timer, resolve);
  });
}

function HorizonStatus({ model }: { model?: ForecastActiveModel }) {
  if (!model) return <div><h4 className="font-medium">Horizonte no devuelto</h4><p className="text-sm text-muted-foreground">Sin diagnóstico para este horizonte.</p></div>;
  const reason = codeText(model.reasonCode);
  return <div className="rounded-md border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{horizonLabel(model.horizonDays)}</h4><Badge variant={model.status === 'ACTIVE' ? 'default' : 'outline'}>{statusLabel(model.status)}</Badge></div>
    {reason && <p className="mt-1 text-sm text-muted-foreground">Motivo: <code>{reason}</code></p>}
    {model.horizonDays !== 1 && <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
      {model.modelVersion != null && <div><dt>Versión activa</dt><dd>{model.modelVersion}</dd></div>}
      <div><dt>Registry / pointer / artefacto</dt><dd>{presence(model.registryFound)} / {presence(model.activePointerFound)} / {presence(model.artifactFound)}{safeText(model.artifactStatus) ? ` · ${safeText(model.artifactStatus)}` : ''}</dd></div>
      {model.mlLoadStatus && <div><dt>Carga ML</dt><dd>{statusLabel(model.mlLoadStatus)}{codeText(model.mlLoadReasonCode) ? ` · ${codeText(model.mlLoadReasonCode)}` : ''}</dd></div>}
      {typeof model.horizonMatches === 'boolean' && <div><dt>Horizonte compatible</dt><dd>{presence(model.horizonMatches)}</dd></div>}
      {typeof model.recipeMatches === 'boolean' && <div><dt>Receta compatible</dt><dd>{presence(model.recipeMatches)}</dd></div>}
      {typeof model.featureHashMatches === 'boolean' && <div><dt>Features compatibles</dt><dd>{presence(model.featureHashMatches)}</dd></div>}
      {typeof model.artifactHashValid === 'boolean' && <div><dt>Integridad del artefacto</dt><dd>{model.artifactHashValid ? 'Válida' : 'No válida'}</dd></div>}
    </dl>}
  </div>;
}

function ForecastSection({ result }: { result: AuthenticatedDiagnosticResult<ForecastActiveModels> }) {
  const message = requestMessage(result);
  const serving = result.data?.forecastServing;
  const models = result.data?.models || [];
  const modelFor = (days: number) => models.find(model => model.horizonDays === days);
  return <section aria-label="Diagnóstico de pronósticos" className="space-y-3">
    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Pronósticos</h3><span className="text-xs text-muted-foreground">HTTP {result.httpStatus || 'sin respuesta'}</span></div>
    {message ? <p role={result.httpStatus === 401 ? 'alert' : 'status'} className="text-sm text-muted-foreground">{message}{codeText(result.code) ? ` · ${codeText(result.code)}` : ''}</p> : <>
      {serving?.dataVersion != null && <p className="text-xs text-muted-foreground">Revisión de datos: {safeText(serving.dataVersion) || 'No disponible'}</p>}
      {serving?.observationsClosedThrough && <p className="text-xs text-muted-foreground">Observaciones cerradas hasta: {dateLabel(serving.observationsClosedThrough) || 'No disponible'}</p>}
      <div className="grid gap-2 sm:grid-cols-3"><HorizonStatus model={modelFor(1)} /><HorizonStatus model={modelFor(7)} /><HorizonStatus model={modelFor(14)} /></div>
    </>}
  </section>;
}

function HealthSection({ result }: { result: AuthenticatedDiagnosticResult<HealthDiagnostic> }) {
  const message = requestMessage(result);
  const diagnostic = result.data;
  const nestedFailure = diagnostic && diagnostic.httpStatus >= 500;
  const reason = codeText(diagnostic?.reasonCode) || codeText(result.code);
  return <section aria-label="Diagnóstico de salud" className="space-y-3 border-t pt-4">
    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Health</h3>{diagnostic && <span className="text-xs text-muted-foreground">HTTP {diagnostic.httpStatus}</span>}</div>
    {message ? <p role={result.httpStatus === 401 ? 'alert' : 'status'} className="text-sm text-muted-foreground">{message}{reason ? ` · ${reason}` : ''}</p> : diagnostic && <>
      <Badge variant={nestedFailure ? 'destructive' : 'outline'}>{nestedFailure ? 'Servicio temporalmente no disponible' : statusLabel(diagnostic.dependencyStatus.healthAssembly)}</Badge>
      {reason && <p className="text-sm text-muted-foreground">Motivo: <code>{reason}</code></p>}
      <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Forecast</dt><dd>{statusLabel(diagnostic.dependencyStatus.forecast)}</dd></div>
        <div><dt className="text-muted-foreground">Inventario</dt><dd>{statusLabel(diagnostic.dependencyStatus.inventory)}</dd></div>
        <div><dt className="text-muted-foreground">Proveedores</dt><dd>{statusLabel(diagnostic.dependencyStatus.supplier)}</dd></div>
        <div><dt className="text-muted-foreground">Ensamblado Health</dt><dd>{statusLabel(diagnostic.dependencyStatus.healthAssembly)}</dd></div></dl>
    </>}
  </section>;
}

export function ForecastDiagnosticsPanel({ onForecastModelsChange, onManualRequestFinished }: Props) {
  const [forecast, setForecast] = useState<AuthenticatedDiagnosticResult<ForecastActiveModels> | null>(null);
  const [health, setHealth] = useState<AuthenticatedDiagnosticResult<HealthDiagnostic> | null>(null);
  const [forecastState, setForecastState] = useState<SectionState>('loading');
  const [healthState, setHealthState] = useState<SectionState>('loading');
  const [requestNumber, setRequestNumber] = useState(0);
  const cycleRef = useRef<{
    requestNumber: number;
    forecast: Promise<AuthenticatedDiagnosticResult<ForecastActiveModels>>;
    health: Promise<AuthenticatedDiagnosticResult<HealthDiagnostic>>;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    const currentCycle = cycleRef.current?.requestNumber === requestNumber
      ? cycleRef.current
      : {
        requestNumber,
        forecast: Promise.resolve().then(() => apiClient.getForecastModelDiagnostics()),
        health: Promise.resolve().then(() => apiClient.getHealthDiagnostics()),
      };
    cycleRef.current = currentCycle;
    setForecastState('loading');
    setHealthState('loading');

    const loadForecast = async () => {
      let result: AuthenticatedDiagnosticResult<ForecastActiveModels> | null = null;
      try { result = await currentCycle.forecast; } catch { /* Retry once below for a network/fetch failure. */ }
      if (!active) return;
      if (!result || isTransientDiagnosticFailure(result, 'forecast')) {
        setForecastState('retrying');
        await waitForRetry(DIAGNOSTIC_RETRY_DELAY_MS, timers);
        if (!active) return;
        try { result = await apiClient.getForecastModelDiagnostics(); } catch { result = null; }
      }
      if (!active) return;
      if (!result) {
        setForecast(null);
        onForecastModelsChange(null);
        setForecastState('error');
        return;
      }
      setForecast(result);
      onForecastModelsChange(result.httpStatus >= 200 && result.httpStatus < 300 ? result.data?.models || null : null);
      setForecastState('ready');
    };

    const loadHealth = async () => {
      let result: AuthenticatedDiagnosticResult<HealthDiagnostic> | null = null;
      try { result = await currentCycle.health; } catch { /* Retry once below for a network/fetch failure. */ }
      if (!active) return;
      if (!result || isTransientDiagnosticFailure(result, 'health')) {
        setHealthState('retrying');
        await waitForRetry(DIAGNOSTIC_RETRY_DELAY_MS, timers);
        if (!active) return;
        try { result = await apiClient.getHealthDiagnostics(); } catch { result = null; }
      }
      if (!active) return;
      if (!result) {
        setHealth(null);
        setHealthState('error');
        return;
      }
      setHealth(result);
      setHealthState('ready');
    };

    void loadForecast();
    void loadHealth();
    return () => {
      active = false;
      for (const [timer, resolve] of timers) {
        clearTimeout(timer);
        resolve();
      }
      timers.clear();
    };
  }, [onForecastModelsChange, requestNumber]);

  const isBusy = forecastState === 'loading' || forecastState === 'retrying' || healthState === 'loading' || healthState === 'retrying';

  return <Card aria-label="Estado del ML">
    <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Estado del ML</CardTitle><CardDescription>Estado del pronóstico y solicitudes de evaluación bajo la política vigente.</CardDescription></div>
      <Button type="button" size="sm" variant="outline" disabled={isBusy} onClick={() => setRequestNumber(value => value + 1)}><RefreshCw className="mr-2 h-4 w-4" />{isBusy ? 'Consultando…' : 'Actualizar estado'}</Button></div></CardHeader>
    <CardContent className="space-y-4"><ForecastMlUpdatePanel refreshToken={requestNumber} onManualRequestFinished={onManualRequestFinished} />
      {forecastState === 'loading' && <p role="status" className="text-sm text-muted-foreground">Cargando pronósticos…</p>}
      {forecastState === 'retrying' && <p role="status" className="text-sm text-muted-foreground">Preparando servicio de pronósticos…</p>}
      {forecastState === 'error' && <p role="alert" className="text-sm text-muted-foreground">No se pudo consultar el diagnóstico de pronósticos. Puedes actualizar el estado e intentarlo nuevamente.</p>}
      {forecastState === 'ready' && forecast && <ForecastSection result={forecast} />}
      {(healthState === 'loading' || healthState === 'retrying') && <section aria-label="Diagnóstico de salud" className="space-y-3 border-t pt-4"><h3 className="font-semibold">Health</h3><p role="status" className="text-sm text-muted-foreground">{healthState === 'retrying' ? 'Preparando diagnóstico Health…' : 'Cargando Health…'}</p></section>}
      {healthState === 'error' && <section aria-label="Diagnóstico de salud" className="space-y-3 border-t pt-4"><h3 className="font-semibold">Health</h3><p role="alert" className="text-sm text-muted-foreground">No se pudo consultar Health. Puedes actualizar el estado e intentarlo nuevamente.</p></section>}
      {healthState === 'ready' && health && <HealthSection result={health} />}
    </CardContent>
  </Card>;
}
