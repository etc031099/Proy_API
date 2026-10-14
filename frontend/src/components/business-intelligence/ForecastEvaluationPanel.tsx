'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import type { ForecastEvaluation, ModelEvaluation } from '@/types/forecastEvaluation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MetricLabel } from './MetricInfo';
import { MethodologyCard } from './MethodologyCard';
import { AnalyticsErrorBoundary } from './AnalyticsErrorBoundary';

const wapeHelp = 'Mide el error total de predicción respecto de la demanda observada. Un valor menor indica menor error.';
const baselineHelp = 'Es un método de referencia usado para comprobar si un modelo más complejo realmente aporta una mejora.';
const hgbHelp = 'Modelo supervisado basado en árboles que aprende patrones entre las variables históricas y la demanda objetivo.';
const metric = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 6 }).format(value) : 'No disponible';
const calendarDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? 'No disponible' : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
};
const baselineLabel = (value: string) => ['four_week_average', 'B3_MEAN_28'].includes(value) ? 'Media de cuatro semanas (baseline)' : value;
const workflow = ['Datos históricos', 'Preparación de variables', 'Entrenamiento HistGradientBoosting', 'Validación temporal', 'Comparación con baseline', 'Decisión operativa'];
// Approved category/top10 promotion evidence: M6.5C-TEST-RECOVERY.md and M6.9G2-FORECAST-ML-VISIBILITY.md.
const rejectionExplanation = 'El modelo obtuvo un buen resultado agregado frente al baseline, pero no cumplió todos los criterios de protección de categorías y productos prioritarios definidos para su promoción operativa. Por ello permaneció como modelo evaluado y no como método operativo.';

function EvaluationCard({ model }: { model: ModelEvaluation }) {
  const rejected = model.modelStatus === 'REJECTED_FOR_OPERATIONAL_USE';
  const title = rejected ? `Evaluación histórica V3 · Horizonte de ${model.horizonDays} días`
    : `Evaluación histórica del modelo ML — Horizonte de ${model.horizonDays} días`;
  const limitations = model.limitations.filter(text => !/sint[eé]tic|synthetic/i.test(text));
  return <Card>
    <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle className="text-lg">{title}</CardTitle><Badge variant="outline">{rejected ? 'Evaluado — no aprobado para operación' : 'Modelo ML evaluado'}</Badge></div><CardDescription>{!rejected && /M5/.test(model.dataset.name) ? 'M5 · CA_3 · ' : ''}Evaluación histórica · corte {calendarDate(model.trainingCutoff)}</CardDescription></CardHeader>
    <CardContent className="space-y-4 text-sm">
      <MethodologyCard algorithm={model.algorithm} learningType="Aprendizaje supervisado — regresión" objective="Predicción de demanda" explanation={hgbHelp} summary={<>WAPE TEST: {metric(model.metrics.test.wape)} · baseline WAPE: {metric(model.baseline.testMetrics.wape)}</>} fields={[
        { label: 'Cómo funciona', value: 'HistGradientBoosting construye árboles de decisión de forma secuencial. Cada nuevo árbol intenta reducir parte del error del conjunto anterior, permitiendo modelar relaciones no lineales entre las variables y la demanda.' },
        { label: 'Variables', value: model.features.join(', ') },
        { label: 'Train', value: `${calendarDate(model.trainPeriod.startDate)} → ${calendarDate(model.trainPeriod.endDate)}` },
        { label: 'Validation', value: `${calendarDate(model.validationPeriod.startDate)} → ${calendarDate(model.validationPeriod.endDate)}` },
        { label: 'Test', value: `${calendarDate(model.testPeriod.startDate)} → ${calendarDate(model.testPeriod.endDate)}` },
        { label: 'Evaluación', value: `WAPE TEST ${metric(model.metrics.test.wape)}; baseline ${metric(model.baseline.testMetrics.wape)}. WAPE expresa error relativo a la demanda real; no representa una tasa de aciertos.` },
        { label: 'Decisión operativa', value: rejected ? rejectionExplanation : 'Evaluado históricamente; la operación V3 utiliza el método estadístico seleccionado.' },
        { label: 'Limitaciones', value: limitations.join(' ') || 'La evaluación corresponde al período y horizonte indicados.' },
      ]} />
      <p><strong>Variables:</strong> {model.featureGroups.join(' · ')}.</p>
      <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium">Validación temporal y variables ({model.features.length})</summary>
        <div className="mt-3 space-y-2"><MetricLabel label="Train / Validation / Test" help="Train ajusta el modelo, Validation compara métodos y Test evalúa la elección congelada sobre otro tramo temporal. Las métricas de datasets u horizontes distintos no son equivalentes." />
          {([['Train', model.trainPeriod], ['Validation', model.validationPeriod], ['Test', model.testPeriod]] as const).map(([label, period]) => <p key={label}>{label}: {calendarDate(period.startDate)} → {calendarDate(period.endDate)}{period.rows !== null ? ` · ${new Intl.NumberFormat('es-PE').format(period.rows)} ejemplos` : ''}</p>)}
          <p className="break-words text-xs text-muted-foreground">{model.features.join(', ')}</p>
        </div>
      </details>
      <div className="overflow-x-auto"><table className="w-full min-w-[460px] text-left text-sm"><caption className="mb-2 text-left font-medium">Comparación TEST · mismo dataset y horizonte</caption><thead><tr className="border-b"><th className="p-2 font-medium">Modelo / método</th><th className="p-2 font-medium"><MetricLabel label="WAPE TEST" help={wapeHelp} /></th><th className="p-2 font-medium">MAE</th><th className="p-2 font-medium">Estado</th></tr></thead><tbody>
        <tr className="border-b"><td className="p-2"><MetricLabel label="HGB" help={hgbHelp} /></td><td className="p-2">{metric(model.metrics.test.wape)}</td><td className="p-2">{metric(model.metrics.test.mae)}</td><td className="p-2">{rejected ? 'No aprobado para operación' : 'Evaluado'}</td></tr>
        <tr><td className="p-2"><MetricLabel label={baselineLabel(model.baseline.algorithm)} help={baselineHelp} /><p className="text-xs text-muted-foreground">Baseline WAPE</p></td><td className="p-2">{metric(model.baseline.testMetrics.wape)}</td><td className="p-2">{metric(model.baseline.testMetrics.mae)}</td><td className="p-2">Referencia estadística</td></tr>
      </tbody></table></div>
      {rejected && <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium"><MetricLabel label="¿Por qué no fue seleccionado?" help={rejectionExplanation} /></summary><p className="mt-2 text-muted-foreground">{rejectionExplanation}</p></details>}
      <p className="text-muted-foreground">{model.metrics.test.rmse !== null ? `RMSE TEST: ${metric(model.metrics.test.rmse)}` : `RMSSE TEST: ${metric(model.metrics.test.rmsse)}`}{model.metrics.validation ? ` · WAPE Validation: ${metric(model.metrics.validation.wape)}` : ''}</p>
      {model.relativeTestWapeImprovementPct !== null && <p>Mejora relativa de WAPE frente al baseline: {metric(model.relativeTestWapeImprovementPct)}%.</p>}
      <details><summary className="cursor-pointer text-muted-foreground">Alcance y limitaciones</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
      <details className="rounded-md border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Detalles técnicos</summary><dl className="mt-2 space-y-2">
        <div><dt>Identificador del modelo</dt><dd>{model.modelId}</dd></div><div><dt>Versión</dt><dd>{model.version}</dd></div>
        <div><dt>Dataset</dt><dd>{model.dataset.version}</dd></div><div><dt>Artifact</dt><dd className="break-all">{model.artifactHash || 'No disponible: modelo no promovido'}</dd></div>
      </dl></details>
    </CardContent>
  </Card>;
}

export function ForecastEvaluationPanel() {
  return <AnalyticsErrorBoundary label="evaluación de predicción"><ForecastEvaluationContent /></AnalyticsErrorBoundary>;
}
function ForecastEvaluationContent() {
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
    <div><h2 className="text-xl font-semibold">Machine Learning aplicado</h2><p className="mt-1 text-sm">Para la predicción de demanda se entrenó y evaluó HistGradientBoostingRegressor, un modelo de aprendizaje supervisado.</p><p className="mt-1 text-sm text-muted-foreground">El pronóstico operativo actual utiliza Media Móvil de 28 días.</p></div>
    <section aria-label="Cómo se aplicó Machine Learning" className="rounded-xl border p-4"><h3 className="mb-3 font-semibold">Cómo se aplicó Machine Learning</h3><ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{workflow.map((step, index) => <li key={step} className="rounded-md bg-muted/50 p-3 text-sm"><span className="mb-1 block text-xs font-semibold text-primary">Paso {index + 1}</span>{step}</li>)}</ol></section>
    {error ? <Card role="alert"><CardContent className="space-y-3 p-5"><p>No se pudo cargar la evaluación histórica de modelos.</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Reintentar evaluación</Button></CardContent></Card> : !evaluation ? <p role="status" className="text-sm text-muted-foreground">Cargando evidencia de evaluación…</p> : <>
      {evaluation.modelEvaluation.map(model => <EvaluationCard key={model.modelId} model={model} />)}
      <Card><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle className="text-lg">Método operativo seleccionado</CardTitle><Badge variant="outline">Método estadístico</Badge></div><CardDescription>{evaluation.selectedOperationalMethod.label} · Método estadístico</CardDescription></CardHeader><CardContent className="space-y-2 text-sm"><p>{evaluation.selectedOperationalMethod.selectionReason}</p><p>Horizontes aprobados: {evaluation.selectedOperationalMethod.horizons.join(' / ')} días.</p><MetricLabel label="Por qué MA28" help="El sistema comparó métodos estadísticos y modelos de Machine Learning. Para los horizontes operativos actuales se seleccionó MA28 según los criterios de validación establecidos." /></CardContent></Card>
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">Evaluación histórica del método operativo V3</summary><p className="my-3 text-sm text-muted-foreground">MA28 · TEST V3 · corte {calendarDate(evaluation.analysisCutoff)}. Cada horizonte tiene un target distinto.</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Horizonte</th><th className="p-2"><MetricLabel label="WAPE TEST" help={wapeHelp} /></th><th className="p-2">MAE</th><th className="p-2">RMSE</th></tr></thead><tbody>{evaluation.operationalEvaluation.map(row => <tr key={row.horizonDays} className="border-b last:border-0"><td className="p-2">{row.horizonDays} {row.horizonDays === 1 ? 'día' : 'días'}</td><td className="p-2">{metric(row.testMetrics.wape)}</td><td className="p-2">{metric(row.testMetrics.mae)}</td><td className="p-2">{metric(row.testMetrics.rmse)}</td></tr>)}</tbody></table></div></details>
      <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">Real vs. predicho: los reportes conservan métricas agregadas, pero no una serie TEST de predicciones por fecha. Esa curva histórica no está disponible.</p>
    </>}
  </section>;
}
