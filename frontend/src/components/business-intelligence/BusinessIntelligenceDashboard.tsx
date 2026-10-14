'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, CalendarClock, Loader2, PackageSearch, RefreshCw, Search } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api';
import type { BusinessSummary, ForecastResponse, IntelligenceMode, InventorySummary, ProductInventory, ProductOption, RiskLevel, SeriesStatus } from '@/types/businessIntelligence';

type TabKey = 'summary' | 'forecast' | 'inventory';
type LoadState = 'loading' | 'ready' | 'error';
type Horizon = 1 | 7 | 14;
const horizons: Horizon[] = [1, 7, 14];
const riskLabels: Record<RiskLevel, string> = { CRITICAL: 'Crítico', HIGH: 'Alto', MEDIUM: 'Medio', LOW: 'Bajo' };
const riskColors: Record<RiskLevel, string> = { CRITICAL: '#dc2626', HIGH: '#f97316', MEDIUM: '#eab308', LOW: '#16a34a' };
const riskKeyLevels: Record<'critical' | 'high' | 'medium' | 'low', RiskLevel> = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
const seriesLabels: Record<SeriesStatus, string> = { CLOSED: 'Día cerrado', ZERO: 'Día cerrado sin ventas', MISSING: 'Dato faltante', PARTIAL: 'Día parcial' };

function safeNumber(value: number | null | undefined, digits = 0): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
    : 'No disponible';
}
function money(value: number | null | undefined, currency: string | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || !currency) return 'No disponible';
  try { return new Intl.NumberFormat('es-PE', { style: 'currency', currency }).format(value); }
  catch { return 'No disponible'; }
}
function formatDate(value: string | null | undefined): string {
  if (!value) return 'No disponible';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'America/Lima' }).format(date);
}
function statusLabel(mode: IntelligenceMode): string { return mode === 'LIVE' ? 'En vivo' : 'Histórico'; }
function freshnessLine(value: { mode: IntelligenceMode; updatedAt: string | null; dataThrough: string | null }): string {
  const date = value.updatedAt || value.dataThrough;
  return `${statusLabel(value.mode)}${date ? ` · Actualizado ${formatDate(date)}` : ''}`;
}

function MetricCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return <Card><CardHeader className="pb-2"><CardDescription>{title}</CardDescription><CardTitle className="text-2xl">{value}</CardTitle></CardHeader>{hint && <CardContent className="pt-0 text-xs text-muted-foreground">{hint}</CardContent>}</Card>;
}
function SkeletonGrid() {
  return <div role="status" aria-label="Cargando inteligencia del negocio" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-xl border bg-muted/40" />)}<span className="sr-only">Cargando resumen y ranking…</span></div>;
}
function ErrorPanel({ retry, message = 'No se pudo cargar la inteligencia del negocio.' }: { retry: () => void; message?: string }) {
  return <Card role="alert" className="border-destructive/40"><CardContent className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center"><AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0 text-destructive" /><div className="flex-1"><p className="font-medium">{message}</p><p className="text-sm text-muted-foreground">La información no se reemplaza con datos de otro período. Puedes volver a intentarlo.</p></div><Button variant="outline" onClick={retry}><RefreshCw className="mr-2 h-4 w-4" />Reintentar</Button></CardContent></Card>;
}
function RiskBadge({ risk }: { risk: RiskLevel | null }) {
  if (!risk || !riskLabels[risk]) return <span>No disponible</span>;
  return <Badge variant="outline" className="gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: riskColors[risk] }} />{riskLabels[risk]}</Badge>;
}
function ProductPicker({ selected, onSelect }: { selected: ProductOption | null; onSelect: (product: ProductOption) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    if (!query.trim()) { setResults([]); setBusy(false); setError(false); return; }
    const current = ++request.current;
    setBusy(true); setError(false);
    const timer = setTimeout(() => {
      void apiClient.searchBusinessIntelligenceProducts(query.trim()).then(response => {
        if (current !== request.current) return;
        if (!response.success || !response.data) throw new Error('Search unavailable');
        setResults(response.data.products);
      }).catch(() => { if (current === request.current) { setResults([]); setError(true); } })
        .finally(() => { if (current === request.current) setBusy(false); });
    }, 300);
    return () => { clearTimeout(timer); };
  }, [query]);

  return <div className="space-y-2">
    <label htmlFor="intelligence-product-search" className="text-sm font-medium">Producto</label>
    <div className="relative"><Search aria-hidden="true" className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input id="intelligence-product-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por nombre o SKU…" className="pl-9" autoComplete="off" /></div>
    {selected && <div className="rounded-md bg-muted/50 px-3 py-2 text-sm" aria-live="polite"><span className="font-medium">{selected.name}{selected.presentation ? ` · ${selected.presentation}` : ''}</span><span className="ml-2 text-xs text-muted-foreground">SKU: {selected.sku}</span></div>}
    {query.trim() && <div className="max-h-56 overflow-auto rounded-md border" aria-label="Resultados de productos">
      {busy ? <p className="p-3 text-sm text-muted-foreground">Buscando productos…</p> : error ? <p role="alert" className="p-3 text-sm text-destructive">No fue posible buscar productos.</p> : results.length ? results.map(product => <button type="button" key={product.id} onClick={() => { onSelect(product); setQuery(''); setResults([]); }} className="block w-full border-b px-3 py-2 text-left last:border-0 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="block font-medium">{product.name}{product.presentation ? ` · ${product.presentation}` : ''}</span><span className="text-xs text-muted-foreground">SKU: {product.sku}</span></button>) : <p className="p-3 text-sm text-muted-foreground">No se encontraron productos con SKU.</p>}
    </div>}
    {!selected && !query.trim() && <p className="text-sm text-muted-foreground">Busca y elige un producto para consultar sus datos.</p>}
  </div>;
}

export function BusinessIntelligenceDashboard() {
  const [tab, setTab] = useState<TabKey>('summary');
  const [summary, setSummary] = useState<BusinessSummary | null>(null);
  const [inventory, setInventory] = useState<InventorySummary | null>(null);
  const [overviewState, setOverviewState] = useState<LoadState>('loading');
  const [overviewError, setOverviewError] = useState(false);
  const [selected, setSelected] = useState<ProductOption | null>(null);
  const [horizon, setHorizon] = useState<Horizon>(7);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [productInventory, setProductInventory] = useState<ProductInventory | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('loading');
  const [detailError, setDetailError] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const detailsRequest = useRef(0);
  const loadOverview = useCallback(async () => {
    setOverviewState('loading'); setOverviewError(false);
    try {
      const [summaryResponse, inventoryResponse] = await Promise.all([apiClient.getBusinessIntelligenceSummary(), apiClient.getBusinessIntelligenceInventory()]);
      if (!summaryResponse.success || !summaryResponse.data || !inventoryResponse.success || !inventoryResponse.data) throw new Error('Unavailable');
      setSummary(summaryResponse.data); setInventory(inventoryResponse.data); setOverviewState('ready');
    } catch { setSummary(null); setInventory(null); setOverviewError(true); setOverviewState('error'); }
  }, []);
  useEffect(() => { void loadOverview(); }, [loadOverview]);

  useEffect(() => {
    const requestId = ++detailsRequest.current;
    setForecast(null); setProductInventory(null); setDetailError(false);
    if (!selected || tab === 'summary') { setDetailState('ready'); return; }
    setDetailState('loading');
    const request = tab === 'forecast' ? apiClient.getBusinessIntelligenceForecast(selected.sku, horizon) : apiClient.getBusinessIntelligenceProductInventory(selected.sku);
    void request.then(response => {
      if (requestId !== detailsRequest.current) return;
      if (!response.success || !response.data) throw new Error('Unavailable');
      if (tab === 'forecast') setForecast(response.data as ForecastResponse);
      else setProductInventory(response.data as ProductInventory);
      setDetailState('ready');
    }).catch(() => { if (requestId === detailsRequest.current) { setDetailError(true); setDetailState('error'); } });
  }, [selected, tab, horizon, detailRetry]);

  const chooseProduct = (product: ProductOption) => { setSelected(product); };
  const selectFromRanking = (row: InventorySummary['items'][number]) => {
    setSelected({ id: row.sku, sku: row.sku, name: row.productName, presentation: row.presentation });
    setTab('forecast');
  };
  const freshness = summary ? freshnessLine(summary) : null;
  const riskRows = inventory ? ([
    { key: 'critical' as const, label: 'Crítico', value: inventory.summary.riskCounts.critical },
    { key: 'high' as const, label: 'Alto', value: inventory.summary.riskCounts.high },
    { key: 'medium' as const, label: 'Medio', value: inventory.summary.riskCounts.medium },
    { key: 'low' as const, label: 'Bajo', value: inventory.summary.riskCounts.low },
  ]) : [];

  return <div className="space-y-6">
    <header className="space-y-2"><div className="flex items-center gap-2 text-primary"><BarChart3 className="h-5 w-5" aria-hidden="true" /><span className="text-sm font-semibold uppercase tracking-wider">Inteligencia del negocio</span></div><h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Analítica e Inteligencia del Negocio</h1><p className="max-w-3xl text-muted-foreground">Pronósticos, inventario y análisis del negocio en una sola vista.</p></header>
    {freshness && <p className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarClock aria-hidden="true" className="h-4 w-4" />{freshness}</p>}
    <div>
      <div role="tablist" aria-label="Secciones de inteligencia del negocio" className="grid w-full grid-cols-3 gap-1 rounded-lg bg-muted p-1 sm:w-auto sm:inline-grid">
        {([{ key: 'summary', label: 'Resumen' }, { key: 'forecast', label: 'Predicción' }, { key: 'inventory', label: 'Inventario' }] as const).map(item => <button key={item.key} id={`intelligence-tab-${item.key}`} type="button" role="tab" aria-controls={`intelligence-panel-${item.key}`} aria-selected={tab === item.key} onClick={() => setTab(item.key)} className={`rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item.key ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}>{item.label}</button>)}
      </div>
      {tab === 'summary' && <section id="intelligence-panel-summary" role="tabpanel" aria-labelledby="intelligence-tab-summary" tabIndex={0} className="mt-4 space-y-6">
        {overviewState === 'loading' && <SkeletonGrid />}
        {overviewError && <ErrorPanel retry={() => void loadOverview()} />}
        {overviewState === 'ready' && summary && inventory && <>
          <section aria-label="Indicadores de hoy" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="Ventas de hoy" value={summary.salesToday ? money(summary.salesToday.value, summary.salesToday.currency) : 'No disponible'} />
            <MetricCard title="Unidades vendidas hoy" value={safeNumber(summary.unitsToday)} />
            <MetricCard title="Tickets hoy" value={safeNumber(summary.ticketsToday)} />
            <MetricCard title="Ticket promedio" value={summary.averageTicket ? money(summary.averageTicket.value, summary.averageTicket.currency) : 'No disponible'} />
            <MetricCard title="Margen bruto" value={summary.grossMargin.availability === 'UNAVAILABLE' ? 'No disponible' : `${summary.grossMargin.availability === 'PARTIAL' ? 'Parcial · ' : ''}${money(summary.grossMargin.value, summary.grossMargin.currency)}${summary.grossMargin.percent !== null ? ` · ${safeNumber(summary.grossMargin.percent, 1)}%` : ''}`} hint={summary.grossMargin.availability === 'PARTIAL' ? 'Algunos costos no están disponibles.' : undefined} />
            <MetricCard title="Productos en riesgo" value={summary.inventory.riskCounts.critical === null || summary.inventory.riskCounts.high === null ? 'No disponible' : `${safeNumber(summary.inventory.riskCounts.critical)} críticos · ${safeNumber(summary.inventory.riskCounts.high)} altos`} hint="Riesgo crítico o alto" />
            <MetricCard title="Productos a reponer" value={safeNumber(summary.inventory.reorderCount)} />
            <MetricCard title="Compras pendientes" value={safeNumber(summary.inventory.pendingPurchasesCount)} />
          </section>
          {summary.salesToday?.value === 0 && summary.unitsToday === 0 && summary.ticketsToday === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Hoy aún no hay ventas registradas. Los valores cero son válidos para el período.</p>}
          <section className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,.9fr)]">
            <Card><CardHeader><CardTitle>Distribución de riesgo de inventario</CardTitle><CardDescription>{safeNumber(inventory.summary.totalProducts)} productos en el análisis del motor.</CardDescription></CardHeader><CardContent><div className="h-64 w-full" role="img" aria-label={`Distribución de riesgo: ${riskRows.map(row => `${row.label} ${safeNumber(row.value)}`).join(', ')}`}><ResponsiveContainer width="100%" height="100%"><BarChart data={riskRows} layout="vertical" margin={{ left: 6, right: 20, top: 4, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="label" width={65} /><Tooltip formatter={value => [safeNumber(typeof value === 'number' ? value : null), 'Productos']} /><Bar dataKey="value" name="Productos" radius={[0, 5, 5, 0]}>{riskRows.map(row => <Cell key={row.key} fill={riskColors[riskKeyLevels[row.key]]} />)}</Bar></BarChart></ResponsiveContainer></div></CardContent></Card>
            <RankingTable rows={inventory.items} onSelect={selectFromRanking} />
          </section>
        </>}
      </section>}
      {tab === 'forecast' && <section id="intelligence-panel-forecast" role="tabpanel" aria-labelledby="intelligence-tab-forecast" tabIndex={0} className="mt-4 space-y-6">
        <Card><CardContent className="p-5"><ProductPicker selected={selected} onSelect={chooseProduct} /></CardContent></Card>
        {!selected && <EmptyProductState />}
        {selected && detailState === 'loading' && <LoadingDetail label="Cargando predicción…" />}
        {selected && detailError && <ErrorPanel retry={() => { setDetailError(false); setDetailRetry(value => value + 1); }} />}
        {selected && detailState === 'ready' && forecast && <ForecastPanel forecast={forecast} horizon={horizon} setHorizon={setHorizon} />}
      </section>}
      {tab === 'inventory' && <section id="intelligence-panel-inventory" role="tabpanel" aria-labelledby="intelligence-tab-inventory" tabIndex={0} className="mt-4 space-y-6">
        <Card><CardContent className="p-5"><ProductPicker selected={selected} onSelect={chooseProduct} /></CardContent></Card>
        {!selected && <>
          {overviewError && <ErrorPanel retry={() => void loadOverview()} />}
          {overviewState === 'loading' && <LoadingDetail label="Cargando ranking de inventario…" />}
          {inventory && <><Card><CardHeader><CardTitle>Riesgo de inventario</CardTitle><CardDescription>Distribución del análisis de inventario.</CardDescription></CardHeader><CardContent><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{riskRows.map(row => <div key={row.key} className="rounded-lg border p-3"><RiskBadge risk={riskKeyLevels[row.key]} /><p className="mt-2 text-xl font-semibold">{safeNumber(row.value)}</p></div>)}</div></CardContent></Card><RankingTable rows={inventory.items} onSelect={selectFromRanking} /></>}
        </>}
        {selected && detailState === 'loading' && <LoadingDetail label="Cargando inventario del producto…" />}
        {selected && detailError && <ErrorPanel retry={() => { setDetailError(false); setDetailRetry(value => value + 1); }} />}
        {selected && detailState === 'ready' && productInventory && <ProductInventoryPanel inventory={productInventory} />}
      </section>}
    </div>
  </div>;
}

function EmptyProductState() { return <Card><CardContent className="flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-center"><PackageSearch className="h-8 w-8 text-muted-foreground" aria-hidden="true" /><p className="font-medium">Elige un producto para consultar su pronóstico.</p><p className="text-sm text-muted-foreground">No se seleccionó ningún producto automáticamente.</p></CardContent></Card>; }
function LoadingDetail({ label }: { label: string }) { return <Card role="status"><CardContent className="flex min-h-40 items-center justify-center gap-3 p-6"><Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />{label}</CardContent></Card>; }
function RankingTable({ rows, onSelect }: { rows: InventorySummary['items']; onSelect: (row: InventorySummary['items'][number]) => void }) {
  return <Card><CardHeader><CardTitle>Productos que requieren atención</CardTitle><CardDescription>Ranking entregado por la analítica de inventario; selecciona un producto para ver su detalle.</CardDescription></CardHeader><CardContent>{rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><caption className="sr-only">Ranking de riesgo y reposición</caption><thead><tr className="border-b text-left text-muted-foreground">{['Producto', 'Stock', 'Cobertura', 'Riesgo', 'Reposición', 'Cantidad sugerida'].map(label => <th key={label} scope="col" className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.sku} className="border-b last:border-0"><td className="px-3 py-3"><button type="button" onClick={() => onSelect(row)} className="text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row.productName}{row.presentation ? <span className="block text-xs font-normal text-muted-foreground">{row.presentation}</span> : null}<span className="block text-xs font-normal text-muted-foreground">{row.sku}</span></button></td><td className="px-3 py-3">{safeNumber(row.stock)}</td><td className="px-3 py-3">{row.coverageDays === null ? 'No disponible' : `${safeNumber(row.coverageDays, 1)} días`}</td><td className="px-3 py-3"><RiskBadge risk={row.risk} /></td><td className="px-3 py-3">{row.reorderNow === null ? 'No disponible' : row.reorderNow ? 'Sí' : 'No'}</td><td className="px-3 py-3">{row.recommendedQty === null ? 'No disponible' : `${safeNumber(row.recommendedQty)} unidades`}</td></tr>)}</tbody></table></div> : <p className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">El análisis no devolvió productos en el ranking.</p>}</CardContent></Card>;
}
function ForecastPanel({ forecast, horizon, setHorizon }: { forecast: ForecastResponse; horizon: Horizon; setHorizon: (horizon: Horizon) => void }) {
  const insufficient = forecast.status === 'INSUFFICIENT_HISTORY' || forecast.status === 'COLD_START' || forecast.status === 'NOT_AVAILABLE';
  const observed = forecast.observedSeries.map(point => ({ ...point,
    observed: point.status === 'MISSING' || point.status === 'PARTIAL' ? null : point.units,
    partial: point.status === 'PARTIAL' ? point.units : null,
    statusLabel: seriesLabels[point.status] }));
  return <div className="space-y-6"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-semibold">{forecast.product.name || forecast.product.sku}</h2><p className="text-sm text-muted-foreground">{forecast.product.presentation || 'Presentación no especificada'} · SKU: {forecast.product.sku}</p></div><p className="text-xs text-muted-foreground">{freshnessLine(forecast)}</p></div>
    {insufficient ? <Card role="status"><CardContent className="p-5"><p className="font-medium">Historial insuficiente para generar un pronóstico.</p><p className="mt-1 text-sm text-muted-foreground">No se muestra una curva de pronóstico para este producto.</p></CardContent></Card> : <>
      <div className="grid gap-4 sm:grid-cols-3">{horizons.map(days => <button key={days} type="button" aria-pressed={horizon === days} onClick={() => setHorizon(days)} className={`rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${horizon === days ? 'border-primary bg-primary/5' : 'bg-card hover:bg-muted/50'}`}><span className="text-sm text-muted-foreground">Pronóstico {days} {days === 1 ? 'día' : 'días'}</span><span className="mt-1 block text-2xl font-semibold">{safeNumber(forecast.horizons[`${days}d` as '1d' | '7d' | '14d'], 2)}</span><span className="text-xs text-muted-foreground">unidades totales del período</span></button>)}</div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm"><span><span className="font-medium">Método:</span> Media móvil de 28 días</span><span><span className="font-medium">Datos observados hasta:</span> {formatDate(forecast.observationCutoff)}</span></div>
      <Card><CardHeader><CardTitle>Historial observado</CardTitle><CardDescription>El pronóstico se presenta como total del horizonte; no se distribuye en valores diarios.</CardDescription></CardHeader><CardContent><div className="h-72 w-full" role="img" aria-label="Serie diaria observada de unidades vendidas; días faltantes se muestran sin valor y el pronóstico se informa por separado"><ResponsiveContainer width="100%" height="100%"><LineChart data={observed} margin={{ top: 12, right: 16, left: 0, bottom: 5 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={value => String(value).slice(5)} minTickGap={28} /><YAxis allowDecimals={false} /><Tooltip labelFormatter={value => formatDate(String(value))} formatter={(value, _name, item) => [typeof value === 'number' ? safeNumber(value) : value === null ? 'Sin dato' : String(value), item.payload?.statusLabel || 'Unidades observadas']} /><Line type="monotone" dataKey="observed" name="Observado · días cerrados" stroke="#2563eb" strokeWidth={2} connectNulls={false} dot={{ r: 2 }} activeDot={{ r: 5 }} /><Line type="monotone" dataKey="partial" name="Día parcial" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 4" connectNulls={false} dot={{ r: 4, fill: '#f59e0b' }} /></LineChart></ResponsiveContainer></div><div className="mt-4 flex flex-wrap gap-2" aria-label="Estados de la serie">{(['CLOSED', 'ZERO', 'MISSING', 'PARTIAL'] as SeriesStatus[]).map(status => <Badge key={status} variant="outline">{seriesLabels[status]}</Badge>)}</div><p className="mt-4 rounded-md bg-muted/50 p-3 text-sm">Pronóstico total para los próximos {horizon} {horizon === 1 ? 'día' : 'días'}: <strong>{safeNumber(forecast.horizons[`${horizon}d` as '1d' | '7d' | '14d'], 2)} unidades</strong>.</p></CardContent></Card>
    </>}
  </div>;
}
function ProductInventoryPanel({ inventory }: { inventory: ProductInventory }) {
  const policy = inventory.inventoryPolicy;
  const cards: Array<[string, string]> = [
    ['Stock actual', safeNumber(inventory.stock.onHand)], ['Entrante', safeNumber(inventory.stock.incoming)],
    ['Posición de inventario', safeNumber(inventory.stock.inventoryPosition)], ['Demanda esperada diaria', inventory.demand.expectedDaily === null ? 'No disponible' : `${safeNumber(inventory.demand.expectedDaily, 2)} unidades`],
    ['Días de cobertura', inventory.coverage.daysCover === null ? 'No disponible' : `${safeNumber(inventory.coverage.daysCover, 1)} días`],
    ['Stock de seguridad', safeNumber(policy.safetyStock)], ['Punto de reorden', safeNumber(policy.reorderPoint)],
    ['Cantidad recomendada', inventory.recommendation.recommendedQty === null ? 'No disponible' : `${safeNumber(inventory.recommendation.recommendedQty)} unidades`],
  ];
  return <div className="space-y-5"><div><h2 className="text-xl font-semibold">{inventory.product.name || inventory.product.sku}</h2><p className="text-sm text-muted-foreground">{inventory.product.presentation || 'Presentación no especificada'} · SKU: {inventory.product.sku} · {freshnessLine(inventory.freshness)}</p></div><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores de inventario del producto">{cards.map(([title, value]) => <MetricCard key={title} title={title} value={value} />)}</section><Card><CardHeader><CardTitle>Estado y recomendación</CardTitle><CardDescription>Valores reportados por el análisis de inventario.</CardDescription></CardHeader><CardContent className="flex flex-wrap items-center gap-3"><RiskBadge risk={inventory.risk.level} /><Badge variant="outline">ABC: {inventory.classification.abc || 'No disponible'}</Badge><Badge variant="outline">XYZ: {inventory.classification.xyz || 'No disponible'}</Badge><p className="w-full text-sm"><strong>Reposición inmediata:</strong> {inventory.recommendation.reorderNow === null ? 'No disponible' : inventory.recommendation.reorderNow ? 'Sí' : 'No'}</p>{inventory.recommendation.preventiveRecommendation === true && <p className="w-full text-sm">Reposición preventiva sugerida</p>}</CardContent></Card></div>;
}
