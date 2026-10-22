'use client';

import type { SalesProvisionalEvaluation } from '@/types/salesAnomalies';
import { sameCustomerImpactContext } from '@/lib/customerImpactSnapshot';
import { Badge } from '@/components/ui/badge';

const number = (value: number | null | undefined, digits = 8) => value == null ? 'No disponible'
  : new Intl.NumberFormat('es-PE', { maximumFractionDigits: digits }).format(value);
const label = (row: SalesProvisionalEvaluation | null) => !row ? 'No disponible'
  : row.status === 'NOT_EVALUABLE' ? 'No evaluable'
    : row.inference?.label === 'ANOMALOUS_SIGNAL' ? 'Señal atípica' : 'Dentro del patrón';
const reasons: Record<string, string> = { NO_TICKETS: 'Sin tickets para evaluar.', INVALID_AVERAGE_TICKET: 'Ticket promedio no válido para el modelo.',
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
  const current = after || null;
  const featureRows = current?.modelInput ? [
    ['weekdayLogTicketsDeviation', 'log1p(tickets) − mediana TRAIN del mismo día de semana', current.modelInput.weekdayLogTicketsDeviation],
    ['weekdayLogAverageTicketDeviation', 'log1p(ticket promedio) − mediana TRAIN del mismo día de semana', current.modelInput.weekdayLogAverageTicketDeviation],
  ] as const : [];

  return <section aria-label="Nuevos datos e inferencia de Isolation Forest" className="space-y-3 border-t pt-3">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">Nuevos datos e inferencia de Isolation Forest</h3><Badge variant="outline">MODELO CONGELADO</Badge><Badge variant="outline">EVALUACIÓN PROVISIONAL</Badge></div>
    <p className="text-xs text-muted-foreground">La venta registrada actualiza el agregado operativo del día. El score evalúa ese agregado diario; no está atribuido a un transactionId ni demuestra que esta venta haya causado el resultado.</p>
    {comparison.issue && <p role="alert" className="text-sm">{comparison.issue}</p>}
    {current ? <>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Periodo diario evaluado</p><p className="mt-1 text-sm font-medium">{current.localDate} · día de semana {current.modelInput?.weekday ?? 'No disponible'}</p><p className="mt-1 text-xs text-muted-foreground">Agregado disponible: {current.aggregate ? `${number(current.aggregate.tickets, 0)} tickets · ${number(current.aggregate.units, 0)} unidades` : 'No disponible'}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Inferencia sobre el día</p><p className="mt-1 text-sm font-medium">Score {number(current.inference?.anomalyScore)} · umbral {number(current.modelIdentity.threshold)}</p><p className="mt-1 text-xs">{label(current)}{current.inference ? ` · decisionFunction ${number(current.inference.decisionFunction)}` : ''}</p></div>
      </div>
      {featureRows.length > 0 ? <details className="rounded-lg border p-3"><summary className="cursor-pointer text-xs font-semibold">Características utilizadas ({featureRows.length})</summary>
        <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[34rem] text-xs"><caption className="sr-only">Features reales utilizadas en la inferencia provisional</caption><thead><tr className="text-left text-muted-foreground"><th scope="col" className="py-1 pr-3">Feature</th><th scope="col" className="py-1 pr-3">Transformación / referencia</th><th scope="col" className="py-1 text-right">Valor actual</th></tr></thead><tbody>{featureRows.map(([name, description, value]) => <tr className="border-t" key={name}><th scope="row" className="py-2 pr-3 text-left font-medium">{name}</th><td className="py-2 pr-3 text-muted-foreground">{description}</td><td className="py-2 text-right tabular-nums">{number(value)}</td></tr>)}</tbody></table></div>
        <p className="mt-2 text-xs text-muted-foreground">Las medianas TRAIN se ajustaron solo con datos de entrenamiento; el endpoint no expone sus valores individuales. Huella de referencia: {current.modelIdentity.weeklyReferenceHash.slice(0, 12)}.</p>
      </details> : <p className="text-xs text-muted-foreground">No hay features ni score disponibles para esta evaluación: {reasons[current.reason || ''] || 'estado no evaluable'}.</p>}
      <details className="rounded-lg bg-muted/40 p-3"><summary className="cursor-pointer text-xs font-semibold">Identidad y estado del modelo</summary>
        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2"><div><dt>Versión</dt><dd>{current.modelVersion}</dd></div><div><dt>Artifact</dt><dd>{current.modelIdentity.artifact} · {current.modelIdentity.artifactHash.slice(0, 12)}</dd></div>
          <div><dt>Referencia semanal TRAIN</dt><dd>{current.modelIdentity.weeklyReferenceHash.slice(0, 12)}</dd></div><div><dt>Corte de entrenamiento</dt><dd>{current.modelIdentity.trainingCutoff}</dd></div><div><dt>Corte histórico</dt><dd>{current.modelIdentity.analysisCutoff}</dd></div></dl>
        <p className="mt-2 text-xs">Revisión {current.revision} · observada {current.observedAt}. El modelo y sus referencias permanecen congelados; no hay reentrenamiento por operación.</p>
      </details>
    </> : <p className="text-xs text-muted-foreground">La evaluación diaria posterior no está disponible; no se presenta una lectura anterior como resultado de esta venta.</p>}
    {!before && <p className="text-xs text-muted-foreground">No se capturó una evaluación BEFORE; no se reconstruye ni se inventa una comparación.</p>}
    {before?.reason === 'NO_TICKETS' && <p className="text-xs text-muted-foreground">La captura BEFORE existía, pero aún no había tickets: no tenía features ni score evaluable.</p>}
    {comparison.concurrent && <p className="text-xs text-muted-foreground">Entre capturas pudieron registrarse otras operaciones del mismo día.</p>}
    {before && after && comparison.comparable && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-xs font-semibold">Capturas diarias anterior y posterior</summary>
      <p className="mt-2 text-xs">Antes: score {number(before.inference?.anomalyScore)} · {label(before)}. Después: score {number(after.inference?.anomalyScore)} · {label(after)}. Es una comparación observacional entre agregados diarios.</p>
    </details>}
    <p className="text-xs text-muted-foreground">El score es de rareza relativa, no una probabilidad de fraude. Un score menor indica mayor atipicidad; la señal no confirma una causa. El día abierto sigue siendo provisional.</p>
  </section>;
}
