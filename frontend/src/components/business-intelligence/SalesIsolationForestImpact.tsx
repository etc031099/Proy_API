'use client';

import type { SalesProvisionalEvaluation } from '@/types/salesAnomalies';
import { sameCustomerImpactContext } from '@/lib/customerImpactSnapshot';
import { Badge } from '@/components/ui/badge';

const numeric = (value: number | null | undefined) => value == null ? 'No evaluable'
  : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 8 }).format(value);
const label = (row: SalesProvisionalEvaluation | null) => !row ? 'No capturado'
  : row.status === 'NOT_EVALUABLE' ? 'No evaluable'
    : row.inference?.label === 'ANOMALOUS_SIGNAL' ? 'Señal atípica' : 'Dentro del patrón';
const reasonText: Record<string, string> = { NO_TICKETS: 'Sin tickets para evaluar.', INVALID_AVERAGE_TICKET: 'Ticket promedio no válido para el modelo.',
  INVALID_DAILY_AGGREGATE: 'Agregado diario no válido.', UNSUPPORTED_CURRENCY: 'La evaluación requiere importes en PEN.',
  DATE_MISMATCH: 'La fecha no coincide con el día operativo actual.', INVALID_DATE: 'Fecha no válida.' };

export function provisionalComparison(before: SalesProvisionalEvaluation | null, after: SalesProvisionalEvaluation | null) {
  if (!before || !after) return { comparable: false, issue: null, concurrent: false };
  if (!sameCustomerImpactContext(before.businessContext, after.businessContext)) return { comparable: false, issue: 'Los contextos de ambas capturas no coinciden.', concurrent: false };
  if (before.localDate !== after.localDate || before.modelInput && after.modelInput && before.modelInput.weekday !== after.modelInput.weekday)
    return { comparable: false, issue: 'Cambió la fecha local entre capturas; no se comparan días distintos.', concurrent: false };
  const sameModel = before.modelVersion === after.modelVersion && (['artifactHash', 'weeklyReferenceHash', 'threshold', 'trainingCutoff', 'analysisCutoff'] as const)
    .every(key => before.modelIdentity[key] === after.modelIdentity[key]);
  if (!sameModel) return { comparable: false, issue: 'La identidad del modelo o de su referencia semanal cambió; no se comparan estas inferencias.', concurrent: false };
  if (BigInt(after.revision) <= BigInt(before.revision) || Date.parse(after.observedAt) < Date.parse(before.observedAt))
    return { comparable: false, issue: 'La lectura posterior no acredita una revisión más reciente que la inicial.', concurrent: false };
  return { comparable: true, issue: null, concurrent: BigInt(after.revision) - BigInt(before.revision) > BigInt(1) };
}

export function SalesIsolationForestImpact({ before, after }: { before: SalesProvisionalEvaluation | null; after: SalesProvisionalEvaluation | null }) {
  const comparison = provisionalComparison(before, after);
  const model = after || before;
  const inputChanged = Boolean(before?.modelInput && after?.modelInput &&
    (before.modelInput.weekdayLogTicketsDeviation !== after.modelInput.weekdayLogTicketsDeviation
      || before.modelInput.weekdayLogAverageTicketDeviation !== after.modelInput.weekdayLogAverageTicketDeviation));
  const sameScore = Boolean(before?.inference && after?.inference && before.inference.anomalyScore === after.inference.anomalyScore);
  const sameRegion = Boolean(before?.inference?.regionSignature && before.inference.regionSignature === after?.inference?.regionSignature);
  const pair = (left: number | null | undefined, right: number | null | undefined) => `${numeric(left)} → ${numeric(right)}`;
  const rows = [
    ['Desviación de tickets vs patrón del día de semana', pair(before?.modelInput?.weekdayLogTicketsDeviation, after?.modelInput?.weekdayLogTicketsDeviation)],
    ['Desviación de ticket promedio vs patrón del día de semana', pair(before?.modelInput?.weekdayLogAverageTicketDeviation, after?.modelInput?.weekdayLogAverageTicketDeviation)],
    ['Score Isolation Forest', pair(before?.inference?.anomalyScore, after?.inference?.anomalyScore)],
    ['Resultado', `${label(before)} → ${label(after)}`],
  ];
  return <section aria-label="Evaluación provisional del día en curso" className="space-y-3 border-t pt-3">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">Impacto en Isolation Forest</h3><Badge variant="outline">EVALUACIÓN PROVISIONAL</Badge></div>
    <p className="text-xs text-muted-foreground">Evaluación provisional del agregado diario de ventas. El endpoint no asocia el score a un transactionId individual; por eso este score no se atribuye a la venta identificada arriba.</p>
    {comparison.issue && <p role="alert" className="text-sm">{comparison.issue}</p>}
    {comparison.comparable && <div className="grid gap-2 md:grid-cols-2">{rows.map(([title, value]) => <div key={title} className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{title}</p><p className="mt-1 text-sm font-medium">{value}</p></div>)}</div>}
    {!comparison.comparable && after && <div className="grid gap-2 md:grid-cols-2 rounded-lg border p-3 text-sm" aria-label="Evaluación diaria actual">
      <p>Periodo evaluado: {after.localDate} · {after.aggregate ? `${after.aggregate.tickets} tickets, ${after.aggregate.units} unidades` : 'agregado no disponible'}.</p>
      <p>Score diario: {after.inference ? numeric(after.inference.anomalyScore) : 'No evaluable'} · Clasificación provisional: {label(after)}.</p>
    </div>}
    {!comparison.comparable && !after && before && <p className="text-xs text-muted-foreground">Solo hay una captura anterior; no se presenta como evaluación posterior a esta venta.</p>}
    {!before && <p className="text-xs text-muted-foreground">La evaluación inicial no pudo capturarse.</p>}
    {!after && <p className="text-xs text-muted-foreground">La evaluación posterior todavía no está disponible.</p>}
    {before?.reason === 'NO_TICKETS' && <p className="text-xs">No existía actividad suficiente antes de la venta.</p>}
    {after?.status === 'NOT_EVALUABLE' && <p className="text-xs">El estado posterior no es evaluable con los datos disponibles.</p>}
    {[['Antes', before], ['Después', after]].map(([moment, value]) => {
      const row = value as SalesProvisionalEvaluation | null;
      return row?.status === 'NOT_EVALUABLE' ? <p key={String(moment)} className="text-xs text-muted-foreground">{String(moment)}: {reasonText[row.reason || ''] || 'No evaluable.'}</p> : null;
    })}
    {comparison.comparable && inputChanged && sameScore && <p className="text-xs">{sameRegion
      ? 'Las entradas del modelo cambiaron, pero la inferencia permaneció en la misma región del bosque.'
      : 'Las entradas del modelo cambiaron, pero el score permaneció igual.'}</p>}
    {comparison.concurrent && <p className="text-xs">Durante la ventana de comparación pudieron registrarse otros cambios operativos.</p>}
    {model && <details className="rounded-lg bg-muted/40 p-3"><summary className="cursor-pointer text-xs font-semibold">{before && after && comparison.comparable ? 'Modelo sin cambios' : 'Modelo congelado'}</summary>
      <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2"><div><dt>Versión</dt><dd>{model.modelVersion}</dd></div>
        <div><dt>Artifact</dt><dd>{model.modelIdentity.artifact} · {model.modelIdentity.artifactHash.slice(0, 12)}</dd></div>
        <div><dt>Referencia semanal TRAIN</dt><dd>{model.modelIdentity.weeklyReferenceHash.slice(0, 12)}</dd></div>
        <div><dt>Umbral</dt><dd>{model.modelIdentity.threshold}</dd></div><div><dt>Corte de entrenamiento</dt><dd>{model.modelIdentity.trainingCutoff}</dd></div>
        <div><dt>Fecha local</dt><dd>{model.localDate}</dd></div></dl>
      <p className="mt-2 text-xs">Revisión {before?.revision || 'No capturada'} → {after?.revision || 'No capturada'} · observado {before?.observedAt || 'No capturado'} → {after?.observedAt || 'No capturado'}</p>
    </details>}
    <div className="space-y-1 text-xs text-muted-foreground"><p>El modelo permanece congelado. No se afirma que esta venta haya causado reentrenamiento.</p>
      <p>El día actual todavía está abierto; el resultado no equivale a una evaluación histórica certificada.</p>
      <p>Una señal atípica no implica fraude ni confirma una causa. Un score menor indica mayor rareza relativa; no es una probabilidad.</p>
      <p>Cuando existen ambas capturas válidas, la comparación es observacional entre agregados del mismo día; pueden influir otras operaciones concurrentes.</p></div>
  </section>;
}
