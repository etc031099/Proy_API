'use client';

import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DemandForecastProduct, DemandForecastResponse } from '@/types';
import {
  formatForecastNumber, getForecastExplanation, getForecastSummary,
  getStatusClass, getStatusLabel, getTopForecastProducts, getVisibleForecastProducts,
} from '@/lib/demandForecast';
import { demandForecastEvaluation as evaluation } from '@/lib/demandForecastEvaluation';

const COLORS = { demand: '#6366f1', stock: '#64748b', REPONER: '#dc2626', VIGILAR: '#d97706', OK: '#059669' };
const formatDate = (date?: string) => date
  ? new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) : '—';

type ChartRow = { label: string; name?: string; [key: string]: string | number | null | undefined };
type Series = { key: string; label: string; color: string };

function MetricChart({ data, series, height }: { data: ChartRow[]; series: Series[]; height?: number }) {
  if (!data.length) return <p className="py-10 text-center text-sm text-muted-foreground">No hay datos válidos para esta comparación.</p>;
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {series.map(item => <span key={item.key} className="flex items-center gap-2"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />{item.label}</span>)}
      </div>
      <div className="w-full min-w-0 overflow-hidden" style={{ height: height || Math.max(190, data.length * 35 + 35) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 0 }} accessibilityLayer>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" opacity={0.12} />
            <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="label" width={115} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip
              formatter={value => formatForecastNumber(value, 2)}
              labelFormatter={(label, payload) => payload?.[0]?.payload?.name || label}
              contentStyle={{ background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', borderRadius: 8, maxWidth: 180, whiteSpace: 'normal', overflowWrap: 'anywhere' }}
              cursor={{ fill: 'currentColor', opacity: 0.05 }}
            />
            {series.map(item => <Bar key={item.key} dataKey={item.key} name={item.label} fill={item.color} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="sr-only" aria-label="Valores del gráfico">
        {data.map(row => <li key={row.label}>{row.name || row.label}: {series.map(item => `${item.label}: ${formatForecastNumber(row[item.key], 2)}`).join('; ')}</li>)}
      </ul>
    </>
  );
}

function ChartCard({ title, description, data, series }: { title: string; description: string; data: ChartRow[]; series: Series[] }) {
  return <Card className="min-w-0"><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><MetricChart data={data} series={series} /></CardContent></Card>;
}

function StatusBadge({ product }: { product: DemandForecastProduct }) {
  return <Badge variant="outline" className={`whitespace-nowrap ${getStatusClass(product.inventoryStatus)}`}>{getStatusLabel(product.inventoryStatus)}</Badge>;
}

function ProductDetail({ product, anchor }: { product: DemandForecastProduct; anchor?: string }) {
  const values = [
    { label: 'Stock al ancla', value: product.stockAtAnchor, color: COLORS.stock },
    { label: 'Ventas últimos 7 días', value: product.salesLast7Days, color: '#0284c7' },
    { label: 'Predicción ML 7 días', value: product.predictedDemand7d, color: COLORS.demand },
    { label: 'Stock de seguridad', value: product.safetyStock, color: '#d97706' },
    { label: 'Reposición sugerida', value: product.recommendedQty, color: COLORS.REPONER },
  ];
  const ready = product.mlStatus === 'READY';
  return (
    <section id="forecast-product-detail" aria-label="Detalle de producto" className="scroll-mt-24 space-y-4 rounded-xl border border-primary/20 bg-primary/[0.02] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-lg font-semibold">{product.name}</h3><p className="text-sm text-muted-foreground">SKU: {product.sku} · Ancla: {formatDate(anchor)}</p></div>
        <StatusBadge product={product} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {values.map(item => <div key={item.label} className={`rounded-lg border p-3 ${item.label === 'Predicción ML 7 días' ? 'border-primary/30 bg-primary/5' : 'bg-background'}`}><p className="text-xs text-muted-foreground">{item.label}</p><p className="mt-1 text-xl font-semibold">{formatForecastNumber(item.value, 2)}</p><p className="text-xs text-muted-foreground">unidades</p></div>)}
      </div>
      <p className="rounded-lg bg-background p-3 text-sm leading-relaxed">{getForecastExplanation(product)}</p>
      {ready ? <div className="min-w-0"><p className="mb-3 text-sm font-medium">Comparación de unidades para este producto</p><MetricChart data={values.map(item => ({ label: item.label, units: item.value }))} series={[{ key: 'units', label: 'Unidades (demanda agregada de 7 días)', color: COLORS.demand }]} height={230} /></div>
        : <p className="text-sm text-muted-foreground">Preparación ML: {product.mlStatus}. No se presenta una predicción ni una reposición como cero.</p>}
      <p className="text-xs text-muted-foreground">La predicción es una estimación agregada de 7 días. La reposición es una regla del sistema basada en stock y seguridad; no representa otra salida del modelo.</p>
    </section>
  );
}

export function ForecastDashboard({ forecast }: { forecast: DemandForecastResponse }) {
  const products = useMemo(() => forecast.products || [], [forecast.products]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('recommendedQty');
  const [selectedId, setSelectedId] = useState(products[0]?.productId || '');
  const summary = useMemo(() => getForecastSummary(products), [products]);
  const topDemand = useMemo(() => getTopForecastProducts(products, 'predictedDemand7d'), [products]);
  const topRestock = useMemo(() => getTopForecastProducts(products, 'recommendedQty'), [products]);
  const matches = useMemo(() => getVisibleForecastProducts(products, search, 'all', sort), [products, search, sort]);
  const visible = useMemo(() => getVisibleForecastProducts(products, search, status, sort), [products, search, status, sort]);
  const selected = products.find(product => product.productId === selectedId) || products[0];
  const revealProduct = (productId: string) => {
    setSelectedId(productId);
    document.getElementById('forecast-product-detail')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  const kpis = [
    ['Productos analizados', summary.total], ['Productos listos', summary.ready],
    ['REPONER', summary.restock], ['VIGILAR', summary.watch], ['OK', summary.ok],
    ['Demanda prevista total 7 días', formatForecastNumber(summary.totalDemand, 2)],
    ['Reposición sugerida total', formatForecastNumber(summary.totalRecommended, 0)],
  ];
  const model = forecast.model;
  const productRows = (items: DemandForecastProduct[]): ChartRow[] => items.map(product => ({
    label: product.sku, name: product.name, demand: product.predictedDemand7d,
    restock: product.recommendedQty, stock: product.stockAtAnchor,
  }));

  return (
    <div className="space-y-6">
      <Card className="border-primary/20 bg-primary/[0.03]">
        <CardHeader className="pb-3"><CardDescription>Modelo ML · inferencia actual</CardDescription><CardTitle>{model?.name || evaluation.name}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium">{model?.algorithm || evaluation.algorithm}</p>
          <div className="flex flex-wrap gap-2"><Badge variant="outline">Versión {model?.version || evaluation.version}</Badge><Badge variant="outline">{model?.featuresCount || evaluation.featuresCount} features</Badge><Badge variant="outline">Horizonte: {model?.horizonDays || evaluation.horizonDays} días</Badge><Badge variant="outline">{evaluation.artifact}</Badge><Badge variant="outline">{model?.execution === 'cloud' ? 'Cloud / FastAPI' : 'FastAPI'}</Badge></div>
          <p className="text-sm text-muted-foreground">Entrenado previamente con M5 CA_3: 3,049 productos y 5,918,109 observaciones. CLOUD-DEMO aporta {summary.total} productos operacionales preparados para inferencia; no representa el tamaño del entrenamiento. Esta consulta no reentrena el modelo.</p>
          <p className="text-xs text-muted-foreground">Replay histórico · datos al ancla {formatDate(forecast.anchorOperationalDate)}. Los totales y gráficos incluyen todos los productos analizados; los valores ML solo incluyen productos READY.</p>
        </CardContent>
      </Card>

      <section aria-label="Resumen ML" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map(([label, value]) => <Card key={label}><CardContent className="p-4"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums">{value}</p></CardContent></Card>)}
      </section>

      <section aria-label="Visualizaciones globales" className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Estado de inventario" description={`${summary.ready} productos listos; ${summary.total - summary.ready} sin predicción disponible. La clasificación es una recomendación del sistema.`} data={[
          { label: 'REPONER', restock: summary.restock }, { label: 'VIGILAR', watch: summary.watch }, { label: 'OK', ok: summary.ok },
        ]} series={[{ key: 'restock', label: 'REPONER', color: COLORS.REPONER }, { key: 'watch', label: 'VIGILAR', color: COLORS.VIGILAR }, { key: 'ok', label: 'OK', color: COLORS.OK }]} />
        <ChartCard title="Mayor demanda prevista — próximos 7 días" description="Top 10 por predicción ML. Son unidades estimadas, no ventas reales." data={productRows(topDemand)} series={[{ key: 'demand', label: 'Predicción ML 7 días', color: COLORS.demand }]} />
        <ChartCard title="Productos con mayor reposición sugerida" description="Top 10 con reposición mayor que cero. Es una regla del sistema, no la predicción del modelo." data={productRows(topRestock)} series={[{ key: 'restock', label: 'Reposición sugerida', color: COLORS.REPONER }]} />
        <ChartCard title="Stock al ancla vs. demanda prevista" description="Seis productos con mayor demanda prevista. Una barra de demanda más larga que la de stock señala posible necesidad de atención." data={productRows(topDemand.slice(0, 6))} series={[{ key: 'stock', label: 'Stock al ancla', color: COLORS.stock }, { key: 'demand', label: 'Predicción ML 7 días', color: COLORS.demand }]} />
      </section>

      <Card><CardHeader><CardTitle className="text-base">Evaluación del modelo</CardTitle><CardDescription>WAPE es error: menor es mejor. Corresponde al TEST histórico antes del refit final TRAIN + VALIDATION.</CardDescription></CardHeader><CardContent className="grid gap-5 md:grid-cols-2">
        <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-1 xl:grid-cols-3">
          <div><p className="text-xs text-muted-foreground">WAPE TEST · modelo</p><p className="mt-1 text-xl font-semibold">{formatForecastNumber(evaluation.testWapePct, 2)} %</p></div>
          <div><p className="text-xs text-muted-foreground">WAPE TEST · baseline</p><p className="mt-1 text-xl font-semibold">{formatForecastNumber(evaluation.baselineWapePct, 2)} %</p></div>
          <div><p className="text-xs text-muted-foreground">Mejora relativa</p><p className="mt-1 text-xl font-semibold text-emerald-600">{formatForecastNumber(evaluation.improvementPct, 2)} %</p></div>
          <p className="text-xs text-muted-foreground sm:col-span-3 md:col-span-1 xl:col-span-3">Estas métricas no son accuracy ni una garantía de ventas futuras.</p>
        </div>
        <MetricChart data={[{ label: 'Baseline 4 semanas', baseline: evaluation.baselineWapePct }, { label: 'Modelo ML', model: evaluation.testWapePct }]} series={[{ key: 'baseline', label: 'Baseline · WAPE (%)', color: COLORS.stock }, { key: 'model', label: 'Modelo · WAPE (%)', color: COLORS.demand }]} height={170} />
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Explorador de producto</CardTitle><CardDescription>Busca por nombre o SKU y selecciona un producto para interpretar sus resultados.</CardDescription></CardHeader><CardContent className="space-y-5">
        <div className="max-w-xl"><label htmlFor="forecast-search" className="mb-2 block text-sm font-medium">Buscar producto o SKU</label><Input id="forecast-search" placeholder="Escribe un nombre o SKU…" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div role="group" aria-label="Seleccionar producto" className="flex max-h-44 flex-wrap gap-2 overflow-y-auto rounded-lg border p-3">
          {matches.map(product => <Button key={product.productId} variant={selected?.productId === product.productId ? 'default' : 'outline'} size="sm" aria-pressed={selected?.productId === product.productId} className="max-w-full" onClick={() => setSelectedId(product.productId)}><span className="truncate">{product.name} · {product.sku}</span></Button>)}
          {!matches.length && <p className="text-sm text-muted-foreground">No hay productos que coincidan con la búsqueda.</p>}
        </div>
        {selected && <ProductDetail product={selected} anchor={forecast.anchorOperationalDate} />}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Resultados por producto</CardTitle><CardDescription>Datos analizados hasta: {formatDate(forecast.anchorOperationalDate)}. La predicción se redondea solo para presentación.</CardDescription></CardHeader><CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="space-y-1 text-sm"><span className="block font-medium">Filtrar por estado</span><select className="h-9 rounded-md border bg-background px-3" value={status} onChange={event => setStatus(event.target.value)}><option value="all">Todos</option><option value="REPONER">REPONER</option><option value="VIGILAR">VIGILAR</option><option value="OK">OK</option><option value="ML_NO_DISPONIBLE">ML no disponible</option></select></label>
          <label className="w-full min-w-0 space-y-1 text-sm sm:w-auto"><span className="block font-medium">Ordenar por</span><select className="h-9 w-full max-w-full rounded-md border bg-background px-3" value={sort} onChange={event => setSort(event.target.value)}><option value="recommendedQty">Reposición sugerida (mayor primero)</option><option value="predictedDemand7d">Predicción ML (mayor primero)</option><option value="stockAtAnchor">Stock al ancla (mayor primero)</option><option value="status">Estado (prioridad de atención)</option></select></label>
          <p className="text-sm text-muted-foreground">{visible.length} de {summary.total} productos visibles. Los totales globales no cambian con los filtros.</p>
        </div>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm" aria-label="Resultados de predicción"><thead><tr className="border-b text-left text-muted-foreground">{['Producto', 'SKU', 'Stock', 'Ventas 7 días', 'Predicción ML 7 días', 'Reposición sugerida', 'Estado'].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>
          {visible.map(product => <tr key={product.productId} onClick={() => revealProduct(product.productId)} className={`cursor-pointer border-b hover:bg-muted/50 ${selected?.productId === product.productId ? 'bg-primary/[0.04]' : ''}`}><td className="px-3 py-3"><button type="button" className="text-left font-medium underline-offset-4 hover:underline focus-visible:underline" aria-label={`Ver detalle de ${product.name}`}>{product.name}</button></td><td className="px-3 py-3 text-muted-foreground">{product.sku}</td><td className="px-3 py-3">{formatForecastNumber(product.stockAtAnchor, 0)}</td><td className="px-3 py-3">{formatForecastNumber(product.salesLast7Days, 0)}</td><td className="bg-primary/5 px-3 py-3 font-semibold text-primary">{formatForecastNumber(product.predictedDemand7d, 2)}</td><td className="px-3 py-3">{formatForecastNumber(product.recommendedQty, 0)}</td><td className="px-3 py-3"><StatusBadge product={product} /></td></tr>)}
          {!visible.length && <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">No hay productos que coincidan con los filtros.</td></tr>}
        </tbody></table></div>
      </CardContent></Card>

      <details className="rounded-xl border bg-card p-5"><summary className="cursor-pointer font-semibold">Entrenamiento, escenario y flujo ML</summary><div className="mt-4 space-y-4 text-sm">
        <p><strong>Entrenamiento del modelo:</strong> M5 Forecasting — store CA_3, 3,049 productos y 5,918,109 observaciones procesadas. El modelo fue entrenado previamente; cada consulta usa el artefacto ya entrenado.</p>
        <p><strong>Escenario operativo de demostración:</strong> ML-CLOUD-DEMO. Los {summary.total} productos operacionales no son el tamaño del dataset de entrenamiento. La inferencia usa historial y lineage preparados para replay histórico.</p>
        <ol className="flex flex-wrap gap-2" aria-label="Flujo de Machine Learning">{['Datos M5', 'Preparación y 31 features', 'Entrenamiento previo', 'Modelo .joblib', 'Historial operacional y 31 features', 'FastAPI / inferencia', 'Predicción agregada 7 días', 'Recomendación del sistema'].map((step, index) => <li key={step} className="rounded-md border px-3 py-2">{index + 1}. {step}</li>)}</ol>
        <p><strong>predictedDemand7d:</strong> salida ML. <strong>recommendedQty:</strong> sugerencia del sistema; no ejecuta compras automáticamente. Un producto sin preparación suficiente permanece sin predicción.</p>
      </div></details>
    </div>
  );
}
