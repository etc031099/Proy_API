'use client';
import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiClient } from '@/lib/api';
import type { DailySalesAnomaly, SalesAnomalies } from '@/types/salesAnomalies';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard, MetricInfo } from './MetricInfo';
import { Badge } from '@/components/ui/badge';

const number = (value: number, digits = 3) => new Intl.NumberFormat('es-PE', { maximumFractionDigits: digits }).format(value);
const money = (value: number) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(value);
const featureLabels: Record<string, string> = {
  weekdayLogTicketsDeviation: 'Desviación de log1p(tickets) respecto de la mediana TRAIN del mismo día de semana',
  weekdayLogAverageTicketDeviation: 'Desviación de log1p(ticket promedio) respecto de la mediana TRAIN del mismo día de semana',
};

export function SalesAnomalyTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: DailySalesAnomaly }> }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return <div className="rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg"><strong>{row.date}</strong><p>Ingresos: {money(row.revenue)}</p><p>Unidades: {number(row.units, 0)}</p><p>Tickets: {number(row.tickets, 0)}</p><p>Ticket promedio: {money(row.averageTicket)}</p><p>Score: {number(row.anomalyScore, 6)}</p><p>Estado: {row.isAnomaly ? '× Comportamiento atípico' : 'Dentro del patrón de referencia'}</p></div>;
}

function anomalyDot(props: unknown) {
  const { cx, cy, payload } = props as { cx?: number; cy?: number; payload: DailySalesAnomaly };
  const key = `anomaly-dot-${payload.date}`;
  if (cx === undefined || cy === undefined || !payload.isAnomaly) return <g key={key} />;
  return <g key={key} aria-label={`Comportamiento atípico ${payload.date}`}><path d={`M ${cx-4} ${cy-4} L ${cx+4} ${cy+4} M ${cx-4} ${cy+4} L ${cx+4} ${cy-4}`} stroke="#dc2626" strokeWidth={2} /></g>;
}

function AnomalyRow({ row }: { row: DailySalesAnomaly }) {
  return <tr className="border-t align-top">
    <td className="whitespace-nowrap px-2 py-2">× {row.date}</td>
    <td className="whitespace-nowrap px-2 py-2">{money(row.revenue)}</td>
    <td className="px-2 py-2">{number(row.units, 0)}</td>
    <td className="px-2 py-2">{number(row.tickets, 0)}</td>
    <td className="whitespace-nowrap px-2 py-2">{money(row.averageTicket)}</td>
    <td className="px-2 py-2">{number(row.anomalyScore, 6)}</td>
    <td className="min-w-48 max-w-sm whitespace-normal px-2 py-2"><p className="line-clamp-2">{row.interpretation}</p><p className="mt-1 text-xs text-muted-foreground">{row.weekend ? 'Fin de semana' : 'Día de semana'}{row.holidayCode ? ` · Feriado: ${row.holidayCode}` : ''} · {row.promotionTickets} tickets con promoción</p></td>
  </tr>;
}

function AnomalyMethodology({ data }: { data: SalesAnomalies }) {
  const fields = [
    ['Cómo funciona', 'Aísla observaciones mediante árboles aleatorios; las que se aíslan con menos divisiones quedan más alejadas del patrón aprendido.'],
    ['Variables', `${data.features.map(feature => featureLabels[feature] || feature).join('; ')}. Ingresos y unidades se muestran solo como contexto.`],
    ['Preparación', data.transformations.join(' · ')],
    ['Score', `${data.scoreSemantics} Valores menores indican mayor atipicidad relativa; no es una probabilidad.`],
    ['Umbral y contamination', `${data.contamination} · umbral ${number(data.threshold)}. Auto usa el criterio interno del algoritmo; la tasa observada no es una tasa objetivo.`],
    ['Estabilidad', `Jaccard medio ${number(data.stability.jaccardMean)}, mínimo ${number(data.stability.jaccardMin)}; correlación de ranking ${number(data.stability.rankCorrelationMean)}.`],
    ['Limitaciones', data.limitations.join(' ')],
  ] as const;
  return <details className="rounded-md border px-3 py-2 text-sm">
    <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Metodología y limitaciones</summary>
    <dl className="mt-3 grid gap-3 sm:grid-cols-2">{fields.map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="break-words text-muted-foreground">{value}{label === 'Umbral y contamination' && <> <MetricInfo label="Contamination">En opciones numéricas, define la proporción usada para establecer el umbral. Auto emplea el criterio interno de scikit-learn y no fija una tasa objetivo.</MetricInfo></>}</dd></div>)}</dl>
  </details>;
}

export function SalesAnomalyPanel() {
  const [data, setData] = useState<SalesAnomalies | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let current = true;
    setError(false);
    void apiClient.getSalesAnomalies({ limit: 20 }).then(response => {
      if (!response.success || !response.data) throw new Error('Invalid anomaly contract');
      if (current) setData(response.data);
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [retry]);
  const rows = data ? (showAll ? data.topAnomalies : data.topAnomalies.slice(0, 10)) : [];
  return <Card aria-label="Isolation Forest · histórico congelado"><CardHeader className="space-y-2 pb-3">
    <div className="flex flex-wrap items-center gap-2"><CardTitle>Isolation Forest</CardTitle><Badge variant="outline">HISTÓRICO CONGELADO</Badge><MetricInfo label="Isolation Forest">Algoritmo no supervisado que identifica observaciones que pueden aislarse más fácilmente del comportamiento habitual.</MetricInfo></div>
    <CardDescription>Detecta días de ventas inusuales respecto al patrón histórico. Este detector no se actualiza ni reentrena con ventas nuevas.</CardDescription>
  </CardHeader><CardContent className="space-y-4 pt-0">
    <p className="text-sm text-muted-foreground">Una señal atípica describe un patrón inusual; no implica fraude ni confirma una causa.</p>
    {error ? <div role="alert"><p>No se pudo cargar el análisis de anomalías.</p><Button variant="outline" onClick={() => setRetry(value => value+1)}>Reintentar anomalías</Button></div> : !data ? <p role="status">Cargando análisis histórico…</p> : <>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{[['Días analizados', number(data.analysisDays, 0)], ['Días atípicos', number(data.anomalyCount, 0)], ['Tasa de señales', `${number(data.anomalyRate*100, 2)}%`], ['Estado', 'Exploratorio']].map(([label, value]) => <div key={label} className="rounded-lg border px-3 py-2"><p className="text-xs text-muted-foreground">{label}</p><p className="text-base font-semibold">{value}</p></div>)}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>Versión: {data.version}</span><span>{data.sampleCount} días TRAIN</span><span>Período: {data.period.startDate} – {data.period.endDate}</span><span>Training cutoff: {data.trainingCutoff}</span><span>Análisis cutoff: {data.analysisCutoff}</span><span>Jaccard medio: {number(data.stability.jaccardMean)}</span></div>
      <AnomalyMethodology data={data} />
      <ChartCard title="Ventas históricas y señales atípicas" description={`${data.period.startDate} → ${data.period.endDate}. La línea muestra ingresos diarios; la marca × señala un día atípico.`}><div className="h-72"><ResponsiveContainer width="100%" height="100%"><LineChart data={data.series}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" minTickGap={35} tickFormatter={value => String(value).slice(5)} /><YAxis tickFormatter={value => `S/ ${number(Number(value), 0)}`} /><Tooltip content={<SalesAnomalyTooltip />} /><Line dataKey="revenue" stroke="#2563eb" strokeWidth={1.5} dot={anomalyDot} activeDot={{ r: 4 }} connectNulls={false} /></LineChart></ResponsiveContainer></div></ChartCard>
      <section aria-label="Días más atípicos" className="space-y-2"><div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="font-semibold">Días más atípicos</h3><p className="text-xs text-muted-foreground">Ordenados por score menor primero.</p></div><MetricInfo label="Score del detector">Valores más extremos representan mayor rareza relativa; el score no es una probabilidad.</MetricInfo></div>
        <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[46rem] text-sm"><caption className="sr-only">Días más atípicos, ordenados por score menor primero</caption><thead><tr className="bg-muted/50 text-left text-muted-foreground">{['Fecha', 'Ingresos', 'Unidades', 'Tickets', 'Ticket promedio', 'Score', 'Interpretación'].map(label => <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row => <AnomalyRow key={row.date} row={row} />)}</tbody></table>{!data.topAnomalies.length && <p className="p-3 text-sm">No hay días señalados en el período histórico solicitado.</p>}</div>
        {data.topAnomalies.length > 10 && <Button type="button" variant="link" className="h-auto px-0" onClick={() => setShowAll(value => !value)}>{showAll ? 'Mostrar menos' : 'Ver todos los días atípicos →'}</Button>}
      </section>
    </>}
  </CardContent></Card>;
}
