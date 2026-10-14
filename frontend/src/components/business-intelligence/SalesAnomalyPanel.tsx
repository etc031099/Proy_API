'use client';
import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiClient } from '@/lib/api';
import type { DailySalesAnomaly, SalesAnomalies } from '@/types/salesAnomalies';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard, MetricInfo } from './MetricInfo';
import { MethodologyCard } from './MethodologyCard';

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
  const { cx, cy, payload } = props as { cx?: number; cy?: number; payload?: DailySalesAnomaly };
  if (!payload?.isAnomaly || cx === undefined || cy === undefined) return <g />;
  return <g aria-label={`Comportamiento atípico ${payload.date}`}><path d={`M ${cx-4} ${cy-4} L ${cx+4} ${cy+4} M ${cx-4} ${cy+4} L ${cx+4} ${cy-4}`} stroke="#dc2626" strokeWidth={2} /></g>;
}

export function SalesAnomalyPanel() {
  const [data, setData] = useState<SalesAnomalies | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setError(false);
    void apiClient.getSalesAnomalies({ limit: 20 }).then(response => {
      if (!response.success || !response.data) throw new Error('Invalid anomaly contract');
      if (current) setData(response.data);
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [retry]);
  return <Card><CardHeader><CardTitle>Detección de anomalías con Machine Learning</CardTitle><CardDescription>Isolation Forest · Aprendizaje no supervisado <MetricInfo label="Isolation Forest">Algoritmo no supervisado que identifica observaciones que pueden aislarse más fácilmente del comportamiento habitual.</MetricInfo></CardDescription></CardHeader><CardContent className="space-y-5">
    <p className="text-sm">Objetivo: detectar días con comportamiento de ventas atípico respecto al patrón histórico. Una señal requiere revisar el contexto y no determina su causa.</p>
    {error ? <div role="alert"><p>No se pudo cargar el análisis de anomalías.</p><Button variant="outline" onClick={() => setRetry(value => value+1)}>Reintentar anomalías</Button></div> : !data ? <p role="status">Cargando anomalías de ventas…</p> : <>
      <p className="rounded-lg bg-muted/50 p-3 text-sm">Histórico congelado al {data.analysisCutoff}. Modelo exploratorio entrenado con {data.sampleCount} días hasta {data.trainingCutoff}; analiza {data.analysisDays} días. No incorpora ventas operativas posteriores al corte.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['Días analizados', number(data.analysisDays, 0)], ['Días atípicos', number(data.anomalyCount, 0)], ['Tasa de señales', `${number(data.anomalyRate*100, 2)}%`], ['Estado', 'Exploratorio']].map(([label, value]) => <div key={label} className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="text-lg font-semibold">{value}</p></div>)}</div>
      <p className="rounded-md bg-muted/50 p-3 text-sm">El modelo señaló {number(data.anomalyCount, 0)} de {number(data.analysisDays, 0)} días para revisión contextual. Una señal describe un comportamiento atípico; no confirma su causa.</p>
      <MethodologyCard algorithm={data.algorithm} learningType="Aprendizaje no supervisado" objective="Detectar días de ventas fuera del patrón habitual" explanation="Isolation Forest construye árboles aleatorios para aislar observaciones. Los días que requieren menos divisiones para quedar aislados se consideran más atípicos respecto del patrón aprendido." summary={<>{data.sampleCount} días TRAIN · {data.analysisDays} días históricos evaluados · Jaccard medio {number(data.stability.jaccardMean)}</>} fields={[
        { label: 'Cómo funciona', value: 'Aísla observaciones mediante árboles aleatorios; las que se aíslan con menos divisiones quedan más alejadas del patrón aprendido.' },
        { label: 'Variables', value: <>{data.features.map(feature => featureLabels[feature] || feature).join('; ')}. Ingresos y unidades se muestran solo como contexto.</> },
        { label: 'Preparación', value: data.transformations.join(' · ') },
        { label: 'Score', value: `${data.scoreSemantics} Valores menores indican mayor atipicidad; no es una probabilidad.` },
        { label: 'Umbral y contamination', value: <>{data.contamination} · umbral {number(data.threshold)}. Auto usa el criterio interno del algoritmo; la tasa observada no es una tasa objetivo. <MetricInfo label="Contamination">En opciones numéricas, define la proporción usada para establecer el umbral. Auto emplea el criterio interno de scikit-learn y no fija una tasa objetivo.</MetricInfo></> },
        { label: 'Estabilidad', value: `Jaccard medio ${number(data.stability.jaccardMean)}, mínimo ${number(data.stability.jaccardMin)}; correlación de ranking ${number(data.stability.rankCorrelationMean)}.` },
        { label: 'Corte y versión', value: `TRAIN hasta ${data.trainingCutoff}; histórico hasta ${data.analysisCutoff}; ${data.version} · ${data.status}.` },
        { label: 'Limitaciones', value: data.limitations.join(' ') },
      ]} />
      <ChartCard title="Ventas históricas y días atípicos" description={`${data.period.startDate} → ${data.period.endDate}. × indica señal del modelo; línea azul muestra ingresos.`}><div className="h-72"><ResponsiveContainer width="100%" height="100%"><LineChart data={data.series}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" minTickGap={35} tickFormatter={value => String(value).slice(5)} /><YAxis tickFormatter={value => `S/ ${number(Number(value), 0)}`} /><Tooltip content={<SalesAnomalyTooltip />} /><Line dataKey="revenue" stroke="#2563eb" strokeWidth={1.5} dot={anomalyDot} activeDot={{ r: 4 }} connectNulls={false} /></LineChart></ResponsiveContainer></div></ChartCard>
      <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-max text-sm"><caption className="p-2 text-left">Días más atípicos · ordenados por score menor primero</caption><thead><tr>{['Fecha', 'Ingresos', 'Unidades', 'Tickets', 'Ticket promedio', 'Score', 'Interpretación y contexto'].map(label => <th key={label} scope="col" className="p-2 text-left">{label}</th>)}</tr></thead><tbody>{data.topAnomalies.map(row => <tr key={row.date} className="border-t"><td className="p-2">× {row.date}</td><td className="p-2">{money(row.revenue)}</td><td className="p-2">{number(row.units, 0)}</td><td className="p-2">{number(row.tickets, 0)}</td><td className="p-2">{money(row.averageTicket)}</td><td className="p-2">{number(row.anomalyScore, 6)}</td><td className="max-w-sm whitespace-normal p-2">{row.interpretation}<p className="text-xs text-muted-foreground">{row.weekend ? 'Fin de semana' : 'Día de semana'}{row.holidayCode ? ` · Feriado del calendario: ${row.holidayCode}` : ''} · {row.promotionTickets} tickets con promoción</p></td></tr>)}</tbody></table>{!data.topAnomalies.length && <p className="p-3">No hay días señalados en el período histórico solicitado.</p>}</div>
      <p className="text-xs text-muted-foreground">Referencia descriptiva del histórico: mediana de ingresos {money(data.reference.revenue.median)} (Q25–Q75: {money(data.reference.revenue.q25)}–{money(data.reference.revenue.q75)}); mediana de tickets {number(data.reference.tickets.median, 0)} y ticket promedio {money(data.reference.averageTicket.median)}. Es contexto, sin atribuir causas.</p>
    </>}
  </CardContent></Card>;
}
