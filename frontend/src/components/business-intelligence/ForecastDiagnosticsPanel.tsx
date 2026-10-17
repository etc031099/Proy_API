'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ForecastActiveModel, ForecastActiveModels, HealthDiagnostic } from '@/types/businessIntelligence';
import { ForecastMlUpdatePanel } from './ForecastMlUpdatePanel';

type Props = { onForecastModelsChange: (models: ForecastActiveModel[] | null) => void };
type PanelState = 'loading' | 'ready';

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
  if (result.httpStatus === 503 || result.httpStatus === 0 || result.code === 'SERVICE_TEMPORARILY_UNAVAILABLE') return 'Servicio temporalmente no disponible.';
  if (!result.data) return 'No se pudo obtener el diagnóstico.';
  return null;
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

export function ForecastDiagnosticsPanel({ onForecastModelsChange }: Props) {
  const [forecast, setForecast] = useState<AuthenticatedDiagnosticResult<ForecastActiveModels> | null>(null);
  const [health, setHealth] = useState<AuthenticatedDiagnosticResult<HealthDiagnostic> | null>(null);
  const [state, setState] = useState<PanelState>('loading');
  const [requestNumber, setRequestNumber] = useState(0);

  const refresh = useCallback(async () => {
    setState('loading');
    const [forecastResult, healthResult] = await Promise.all([
      apiClient.getForecastModelDiagnostics(), apiClient.getHealthDiagnostics(),
    ]);
    setForecast(forecastResult); setHealth(healthResult);
    onForecastModelsChange(forecastResult.httpStatus >= 200 && forecastResult.httpStatus < 300
      ? forecastResult.data?.models || null : null);
    setState('ready');
  }, [onForecastModelsChange]);

  useEffect(() => { void refresh(); }, [refresh, requestNumber]);

  return <Card aria-label="Estado del ML">
    <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Estado del ML</CardTitle><CardDescription>Estado del pronóstico y solicitudes de evaluación bajo la política vigente.</CardDescription></div>
      <Button type="button" size="sm" variant="outline" disabled={state === 'loading'} onClick={() => setRequestNumber(value => value + 1)}><RefreshCw className="mr-2 h-4 w-4" />{state === 'loading' ? 'Consultando…' : 'Actualizar estado'}</Button></div></CardHeader>
    <CardContent className="space-y-4"><ForecastMlUpdatePanel />{state === 'loading' ? <p role="status" className="text-sm text-muted-foreground">Consultando estado del servicio…</p> : <>
      {forecast && <ForecastSection result={forecast} />}
      {health && <HealthSection result={health} />}
      {!forecast && !health && <p role="status" className="text-sm text-muted-foreground">Servicio temporalmente no disponible.</p>}
    </>}</CardContent>
  </Card>;
}
