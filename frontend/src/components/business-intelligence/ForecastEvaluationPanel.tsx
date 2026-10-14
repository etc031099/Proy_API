'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import type { ForecastEvaluation, ModelEvaluation } from '@/types/forecastEvaluation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MetricLabel } from './MetricInfo';

const wapeHelp = 'WAPE mide el error total de predicción en relación con la demanda real. Un valor menor indica mejor desempeño.';
const metric = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 6 }).format(value) : 'No disponible';
const calendarDate = (value: string) => new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
const baselineLabel = (value: string) => ['four_week_average', 'B3_MEAN_28'].includes(value) ? 'Media de cuatro semanas (baseline)' : value;

function EvaluationCard({ model }: { model: ModelEvaluation }) {
  return <Card>
    <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle className="text-lg">{model.dataset.name} · {model.horizonDays} días</CardTitle><Badge variant="outline">{model.modelStatus === 'EVALUATED' ? 'Evaluado' : 'No aprobado para uso operativo'}</Badge></div><CardDescription>Evaluación histórica del modelo ML · {model.algorithm}</CardDescription></CardHeader>
    <CardContent className="space-y-4 text-sm">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div><dt className="font-medium"><MetricLabel label="Algoritmo" help="HistGradientBoosting aprende relaciones entre las variables y las ventas futuras mediante árboles que corrigen errores de predicción." /></dt><dd className="break-words text-muted-foreground">{model.algorithm}</dd></div>
        <div><dt className="font-medium"><MetricLabel label="Tipo de aprendizaje" help="La regresión supervisada aprende con ejemplos que incluyen las unidades vendidas en el horizonte futuro como resultado conocido." /></dt><dd className="text-muted-foreground">Aprendizaje supervisado — regresión</dd></div>
        <div><dt className="font-medium">Objetivo</dt><dd className="text-muted-foreground">{model.task}</dd></div>
        <div><dt className="font-medium">Dataset</dt><dd className="break-words text-muted-foreground">{model.dataset.version}{model.dataset.synthetic ? ' · Sintético' : ''}</dd></div>
      </dl>
      <p><strong>Variables:</strong> {model.featureGroups.join(' · ')}.</p>
      <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium">Validación temporal y variables ({model.features.length})</summary>
        <div className="mt-3 space-y-2"><MetricLabel label="Train / Validation / Test" help="Train ajusta el modelo, Validation compara métodos y Test evalúa la elección congelada sobre otro tramo temporal. Las métricas de datasets u horizontes distintos no son equivalentes." />
          {([['Train', model.trainPeriod], ['Validation', model.validationPeriod], ['Test', model.testPeriod]] as const).map(([label, period]) => <p key={label}>{label}: {calendarDate(period.startDate)} → {calendarDate(period.endDate)}{period.rows !== null ? ` · ${new Intl.NumberFormat('es-PE').format(period.rows)} ejemplos` : ''}</p>)}
          <p className="break-words text-xs text-muted-foreground">{model.features.join(', ')}</p>
        </div>
      </details>
      <div className="overflow-x-auto"><table className="w-full min-w-[460px] text-left text-sm"><caption className="mb-2 text-left font-medium">Comparación TEST · mismo dataset y horizonte</caption><thead><tr className="border-b"><th className="p-2 font-medium">Modelo / método</th><th className="p-2 font-medium"><MetricLabel label="WAPE" help={wapeHelp} /></th><th className="p-2 font-medium">MAE</th><th className="p-2 font-medium">Estado</th></tr></thead><tbody>
        <tr className="border-b"><td className="p-2">HGB</td><td className="p-2">{metric(model.metrics.test.wape)}</td><td className="p-2">{metric(model.metrics.test.mae)}</td><td className="p-2">{model.modelStatus === 'EVALUATED' ? 'Evaluado' : 'Rechazado para operación'}</td></tr>
        <tr><td className="p-2"><MetricLabel label={baselineLabel(model.baseline.algorithm)} help="Un baseline es un método de referencia con el que se compara el desempeño del modelo evaluado." /></td><td className="p-2">{metric(model.baseline.testMetrics.wape)}</td><td className="p-2">{metric(model.baseline.testMetrics.mae)}</td><td className="p-2">Referencia estadística</td></tr>
      </tbody></table></div>
      <p className="text-muted-foreground">{model.metrics.test.rmse !== null ? `RMSE TEST: ${metric(model.metrics.test.rmse)}` : `RMSSE TEST: ${metric(model.metrics.test.rmsse)}`}{model.metrics.validation ? ` · WAPE Validation: ${metric(model.metrics.validation.wape)}` : ''}</p>
      {model.relativeTestWapeImprovementPct !== null && <p>Mejora relativa de WAPE frente al baseline: {metric(model.relativeTestWapeImprovementPct)}%.</p>}
      <details><summary className="cursor-pointer text-muted-foreground">Alcance y limitaciones</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{model.limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
      <p className="break-words text-xs text-muted-foreground">Versión: {model.version} · Corte de entrenamiento/refit: {calendarDate(model.trainingCutoff)}</p>
    </CardContent>
  </Card>;
}

export function ForecastEvaluationPanel() {
  const [evaluation, setEvaluation] = useState<ForecastEvaluation | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setEvaluation(null); setError(false);
    void apiClient.getForecastModelEvaluation().then(response => {
      if (!response.success || !response.data) throw new Error('Evaluation unavailable');
      if (active) setEvaluation(response.data);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [retry]);
  return <section aria-label="Machine Learning aplicado" className="space-y-4">
    <div><h2 className="text-xl font-semibold">Machine Learning aplicado</h2><p className="text-sm text-muted-foreground">Modelos evaluados y método operativo seleccionado, con evidencia histórica.</p></div>
    {error ? <Card role="alert"><CardContent className="space-y-3 p-5"><p>No se pudo cargar la evaluación histórica de modelos.</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Reintentar evaluación</Button></CardContent></Card> : !evaluation ? <p role="status" className="text-sm text-muted-foreground">Cargando evidencia de evaluación…</p> : <>
      <Card><CardHeader><CardTitle className="text-lg">Método operativo seleccionado</CardTitle><CardDescription>{evaluation.selectedOperationalMethod.label} · Método estadístico</CardDescription></CardHeader><CardContent className="space-y-2 text-sm"><p>{evaluation.selectedOperationalMethod.selectionReason}</p><p>Horizontes aprobados: {evaluation.selectedOperationalMethod.horizons.join(' / ')} días.</p><p className="break-words text-xs text-muted-foreground">Versión: {evaluation.selectedOperationalMethod.version}</p></CardContent></Card>
      {evaluation.modelEvaluation.map(model => <EvaluationCard key={model.modelId} model={model} />)}
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">Evaluación histórica del método operativo V3</summary><p className="my-3 text-sm text-muted-foreground">MA28 · TEST sintético V3 · corte {calendarDate(evaluation.analysisCutoff)}. Cada horizonte tiene un target distinto.</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Horizonte</th><th className="p-2"><MetricLabel label="WAPE" help={wapeHelp} /></th><th className="p-2">MAE</th><th className="p-2">RMSE</th></tr></thead><tbody>{evaluation.operationalEvaluation.map(row => <tr key={row.horizonDays} className="border-b last:border-0"><td className="p-2">{row.horizonDays} {row.horizonDays === 1 ? 'día' : 'días'}</td><td className="p-2">{metric(row.testMetrics.wape)}</td><td className="p-2">{metric(row.testMetrics.mae)}</td><td className="p-2">{metric(row.testMetrics.rmse)}</td></tr>)}</tbody></table></div></details>
      <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">Real vs. predicho: los reportes conservan métricas agregadas, pero no una serie TEST de predicciones por fecha. Esa curva histórica no está disponible.</p>
    </>}
  </section>;
}
