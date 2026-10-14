'use client';

import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { apiClient } from '@/lib/api';
import type { CustomerClustering } from '@/types/customerClustering';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChartCard, MetricInfo } from './MetricInfo';
import { MethodologyCard } from './MethodologyCard';

const colors = ['#2563eb', '#0f766e', '#7c3aed', '#d97706'];
const number = (value: number | null | undefined, digits = 3) => typeof value !== 'number' || !Number.isFinite(value) ? 'No disponible' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: digits }).format(value);
const money = (value: number) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(value);

export function CustomerClusteringPanel({ selectedRef, selectedRfmSegment, onSelect }: {
  selectedRef?: string | null; selectedRfmSegment?: string | null; onSelect: (ref: string) => void;
}) {
  const [data, setData] = useState<CustomerClustering | null>(null);
  const [detail, setDetail] = useState<CustomerClustering | null>(null);
  const [error, setError] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void apiClient.getCustomerClustering().then(response => {
      if (!response.success || !response.data) throw new Error('Invalid clustering response');
      if (active) setData(response.data);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [retry]);
  useEffect(() => {
    let active = true;
    setDetail(null); setDetailError(false);
    if (selectedRef) void apiClient.getCustomerClustering(selectedRef).then(response => {
      if (!response.success || !response.data) throw new Error('Invalid clustering response');
      if (active) setDetail(response.data);
    }).catch(() => { if (active) setDetailError(true); });
    return () => { active = false; };
  }, [selectedRef, retry]);
  const assignment = detail?.assignments[0];
  const largestCluster = data?.clusters.reduce<CustomerClustering['clusters'][number] | null>((largest, cluster) => !largest || cluster.size > largest.size ? cluster : largest, null) || null;
  return <Card><CardHeader><CardTitle>Segmentación con Machine Learning</CardTitle><CardDescription>K-Means · Aprendizaje no supervisado <MetricInfo label="K-Means">Agrupa clientes con comportamientos similares sin utilizar etiquetas previas.</MetricInfo></CardDescription></CardHeader>
    <CardContent className="space-y-5">
      {error ? <div role="alert"><p>No se pudo cargar el modelo de segmentación.</p><Button variant="outline" onClick={() => setRetry(value => value+1)}>Reintentar segmentación</Button></div>
        : !data ? <p role="status">Cargando segmentación ML…</p> : <>
          <MethodologyCard algorithm="K-Means" learningType="Aprendizaje no supervisado" objective="Agrupar clientes por similitud en sus variables RFM" explanation="K-Means busca centroides que representen grupos similares y asigna cada cliente al centro más cercano, usando variables RFM transformadas y escaladas." summary={<>{data.k} clusters · {data.sampleCount} clientes · Silhouette {number(data.metrics.silhouetteMean, 6)} · estabilidad ARI por submuestras {number(data.metrics.subsampleAriMean, 6)}</>} fields={[
            { label: 'Cómo funciona', value: 'Busca centroides representativos y asigna cada cliente al grupo cuyo centro queda más cerca.' },
            { label: 'Variables', value: `${data.features.join(', ')} · ventana ${data.featureWindow} · ${data.transformations.join(' · ')} · ${data.scaler}` },
            { label: 'Evaluación', value: `Silhouette ${number(data.metrics.silhouetteMean, 6)} (separación entre grupos); ARI de estabilidad por submuestras ${number(data.metrics.subsampleAriMean, 6)}. No son medidas de exactitud.` },
            { label: 'Visualización PCA', value: `PC1 + PC2 explican ${number(data.pca.explainedVarianceRatio.reduce((a, b) => a+b, 0)*100)}% de la variación. PCA solo facilita la visualización; no entrena el clustering ni demuestra separación perfecta.` },
            { label: 'Corte y versión', value: `${data.trainingCutoff} · ${data.version} · ${data.status}` },
            { label: 'Limitaciones', value: `Modelo exploratorio con ${data.sampleCount} clientes con historial suficiente; ${data.excludedCount} clientes sin historial excluidos. Consumer Final no se trata como cliente individual. ${data.limitations.join(' ')}` },
          ]} />
          <p className="text-sm text-muted-foreground">RFM tradicional usa reglas y umbrales; K-Means agrupa por similitud. Son análisis complementarios.</p>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="Distribución por cluster" help="Grupo descubierto automáticamente por similitud. El número del cluster es un identificador arbitrario, no una posición de calidad."><div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.clusters}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="cluster" /><YAxis allowDecimals={false} /><Tooltip formatter={value => [`${value} clientes`, 'Tamaño']} /><Bar dataKey="size">{data.clusters.map((c, i) => <Cell key={c.cluster} fill={colors[i % colors.length]} />)}</Bar></BarChart></ResponsiveContainer></div></ChartCard>
            <ChartCard title="PCA: proyección de RFM" description={`PC1 + PC2 explican ${number(data.pca.explainedVarianceRatio.reduce((a, b) => a+b, 0)*100)}% de la variación. Solo visualización; no demuestra calidad por sí misma.`}><div className="h-64"><ResponsiveContainer width="100%" height="100%"><ScatterChart><CartesianGrid strokeDasharray="3 3" /><XAxis type="number" dataKey="pc1" name="PC1" /><YAxis type="number" dataKey="pc2" name="PC2" /><Tooltip cursor={{ strokeDasharray: '3 3' }} />{data.clusters.map((c, i) => <Scatter key={c.cluster} name={`Cluster ${c.cluster}`} fill={colors[i % colors.length]} data={data.assignments.filter(row => row.cluster === c.cluster)} />)}</ScatterChart></ResponsiveContainer></div></ChartCard>
          </div>
          {largestCluster && <p className="rounded-md bg-muted/50 p-3 text-sm">El grupo más numeroso es “{largestCluster.name}”: {largestCluster.size} de {data.sampleCount} clientes.</p>}
          <div className="grid gap-3 sm:grid-cols-2">{data.clusters.map(c => <article key={c.cluster} className="rounded-lg border p-3 text-sm"><h4 className="font-semibold">Cluster {c.cluster} — {c.name}</h4><p>{c.size} clientes · {number(c.proportion*100)}%</p><p>Perfil representativo del cluster: R {number(c.centroidOriginal.recency)} días · F {number(c.centroidOriginal.frequency)} · M {money(c.centroidOriginal.monetary)}</p><p>Promedio: R {number(c.mean.recency)} · F {number(c.mean.frequency)} · M {money(c.mean.monetary)}</p><p>Mediana: R {number(c.median.recency)} · F {number(c.median.frequency)} · M {money(c.median.monetary)}</p></article>)}</div>
          <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-max text-sm"><caption className="p-2 text-left">Clientes al corte de entrenamiento · referencias sin datos de contacto</caption><thead><tr>{['Cliente', 'RFM por reglas', 'Cluster ML', 'R (días)', 'F (90d)', 'M (90d)'].map(label => <th key={label} scope="col" className="p-2 text-left">{label}</th>)}</tr></thead><tbody>{data.assignments.map(row => <tr key={row.customerRef} className="border-t"><td className="p-2"><button className="text-primary underline" onClick={() => onSelect(row.customerRef)}>{row.customerRef}</button></td><td className="p-2">{row.rfmSegment}</td><td className="p-2">{row.cluster === null ? 'Historial insuficiente' : `Cluster ${row.cluster} — ${row.clusterName}`}</td><td className="p-2">{number(row.recency)}</td><td className="p-2">{number(row.frequency)}</td><td className="p-2">{money(row.monetary)}</td></tr>)}</tbody></table></div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>Inertia: {number(data.metrics.inertia)}</span><MetricInfo label="Silhouette">Indica qué tan bien separado está cada grupo respecto de los demás. No mide exactitud.</MetricInfo><span>ARI submuestras: {number(data.metrics.subsampleAriMean)} (mín. {number(data.metrics.subsampleAriMin)})</span><MetricInfo label="ARI / estabilidad">Compara agrupaciones obtenidas bajo muestras o configuraciones controladas; no es accuracy ni una probabilidad.</MetricInfo><span>ARI entre semillas: {number(data.metrics.seedAriMean, 6)} · Seed {data.randomState} · n_init {data.nInit} · sensibilidad Standard/Robust ARI {number(data.scalerSensitivityAri)}</span></div>
        </>}
      {selectedRef && <section className="rounded-lg border p-3 text-sm" aria-label="Segmentación del cliente seleccionado"><h4 className="font-semibold">Cliente seleccionado: {selectedRef}</h4><p>Segmentación RFM actual por reglas: {selectedRfmSegment || 'No disponible'}</p>{detailError ? <p role="alert">No se pudo calcular la asignación ML actual.</p> : !detail ? <p role="status">Consultando asignación ML…</p> : <><p>Segmentación ML actual: {assignment?.cluster == null ? 'Historial insuficiente' : `Cluster ${assignment.cluster} — ${assignment.clusterName}`}</p><p>RFM observado al {detail.assignmentAsOfDate}; modelo congelado al {detail.trainingCutoff}.</p>{assignment?.distance != null && <p>Distancia al centro: {number(assignment.distance)} en escala transformada; no es una probabilidad.</p>}</>}</section>}
    </CardContent></Card>;
}
