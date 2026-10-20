'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, CalendarClock, Loader2, PackageSearch, RefreshCw } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { BusinessSummary, ForecastActiveModel, ForecastResponse, IntelligenceMode, InventorySummary, ProductInventory, ProductOption, RiskLevel, SeriesStatus } from '@/types/businessIntelligence';
import { ProductSearchPicker } from './ProductSearchPicker';
import { ExtendedAnalyticsPanel, type ExtendedTab } from './ExtendedAnalyticsPanel';
import { ChartCard, MetricInfo, MetricLabel } from './MetricInfo';
import { ForecastEvaluationPanel } from './ForecastEvaluationPanel';
import { ForecastDiagnosticsPanel } from './ForecastDiagnosticsPanel';
import { ForecastMlUpdateHistoryPanel } from './ForecastMlUpdateHistoryPanel';
import { ForecastReplayEvidencePanel } from './ForecastReplayEvidencePanel';
import { ProductOperationHistoryPanel } from './ProductOperationHistoryPanel';
import { MlTestControlPanel } from './MlTestControlPanel';
import { MlTestScenarioUiProvider, useMlTestScenarioUiState } from './MlTestScenarioUiContext';
import { AnalyticsErrorBoundary } from './AnalyticsErrorBoundary';
import { MlTestEpochBoundary } from './MlTestEpochBoundary';
import { ForecastImpactDetailCard, ForecastImpactSummaryCard, useForecastImpact } from './ForecastImpactPanel';

type TabKey = 'summary' | 'forecast' | 'inventory' | ExtendedTab;
type LoadState = 'loading' | 'ready' | 'error';
type RidgeHorizon = 7 | 14;
type Horizon = RidgeHorizon;
type ForecastRead = { state: LoadState; data: ForecastResponse | null };
const horizons: Horizon[] = [7, 14];
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatLocalDay(value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'America/Lima' }).format(date);
}
function formatLocalDay(value: string | null | undefined): string {
  if (!value) return 'No disponible';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}
function statusLabel(mode: IntelligenceMode): string { return mode === 'LIVE' ? 'En vivo' : 'Histórico'; }
function freshnessLine(value: { mode: IntelligenceMode; updatedAt: string | null; dataThrough: string | null }): string {
  const date = value.updatedAt || value.dataThrough;
  return `${statusLabel(value.mode)}${date ? ` · Actualizado ${formatDate(date)}` : ''}`;
}

function MetricCard({ title, value, hint, help }: { title: string; value: string; hint?: string; help?: React.ReactNode }) {
  return <Card><CardHeader className="pb-2"><div className="text-sm text-muted-foreground"><MetricLabel label={title} help={help} /></div><CardTitle className="text-2xl">{value}</CardTitle></CardHeader>{hint && <CardContent className="pt-0 text-xs text-muted-foreground">{hint}</CardContent>}</Card>;
}
function SkeletonGrid() {
  return <div role="status" aria-label="Cargando resumen general" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-xl border bg-muted/40" />)}<span className="sr-only">Cargando resumen general…</span></div>;
}
function ErrorPanel({ retry, message = 'No se pudo cargar la inteligencia del negocio.' }: { retry: () => void; message?: string }) {
  return <Card role="alert" className="border-destructive/40"><CardContent className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center"><AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0 text-destructive" /><div className="flex-1"><p className="font-medium">{message}</p><p className="text-sm text-muted-foreground">La información no se reemplaza con datos de otro período. Puedes volver a intentarlo.</p></div><Button variant="outline" onClick={retry}><RefreshCw className="mr-2 h-4 w-4" />Reintentar</Button></CardContent></Card>;
}
function RiskBadge({ risk }: { risk: RiskLevel | null }) {
  if (!risk || !riskLabels[risk]) return <span>No disponible</span>;
  return <Badge variant="outline" className="gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: riskColors[risk] }} />{riskLabels[risk]}</Badge>;
}
export function BusinessIntelligenceDashboard() {
  return <MlTestScenarioUiProvider><MlTestEpochBoundary><BusinessIntelligenceContent /></MlTestEpochBoundary></MlTestScenarioUiProvider>;
}

function BusinessIntelligenceContent() {
  const scenarioUi = useMlTestScenarioUiState();
  const tab = scenarioUi.tab as TabKey;
  const setTab = scenarioUi.setTab as React.Dispatch<React.SetStateAction<TabKey>>;
  const [mlHistoryRefreshToken, setMlHistoryRefreshToken] = useState(0);
  const [summary, setSummary] = useState<BusinessSummary | null>(null);
  const [inventory, setInventory] = useState<InventorySummary | null>(null);
  const [summaryState, setSummaryState] = useState<LoadState>('loading');
  const [inventoryState, setInventoryState] = useState<LoadState>('loading');
  const [summaryError, setSummaryError] = useState(false);
  const [inventoryError, setInventoryError] = useState(false);
  const [selected, setSelected] = useState<ProductOption | null>(null);
  const forecastImpact = useForecastImpact();
  const [horizon, setHorizon] = useState<Horizon>(7);
  const [forecastByHorizon, setForecastByHorizon] = useState<Partial<Record<RidgeHorizon, ForecastRead>>>({});
  const [activeForecastModels, setActiveForecastModels] = useState<ForecastActiveModel[] | null>(null);
  const [productInventory, setProductInventory] = useState<ProductInventory | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('loading');
  const [detailError, setDetailError] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const detailsRequest = useRef(0);
  const summaryRequest = useRef(0);
  const inventoryRequest = useRef(0);
  const loadSummary = useCallback(async (invalidate = false) => {
    const requestId = ++summaryRequest.current;
    if (invalidate) apiClient.invalidateIntelligenceReads();
    setSummaryState('loading'); setSummaryError(false); setSummary(null);
    try {
      const response = await apiClient.getBusinessIntelligenceSummary();
      if (requestId !== summaryRequest.current) return;
      if (!response.success || !response.data) throw new Error('Unavailable');
      setSummary(response.data); setSummaryState('ready');
    } catch { if (requestId === summaryRequest.current) { setSummary(null); setSummaryError(true); setSummaryState('error'); } }
  }, []);
  const loadInventory = useCallback(async (invalidate = false) => {
    const requestId = ++inventoryRequest.current;
    if (invalidate) apiClient.invalidateIntelligenceReads();
    setInventoryState('loading'); setInventoryError(false); setInventory(null);
    try {
      const response = await apiClient.getInventoryAnalytics({ limit: 20 });
      if (requestId !== inventoryRequest.current) return;
      if (!response.success || !response.data) throw new Error('Unavailable');
      setInventory(response.data); setInventoryState('ready');
    } catch { if (requestId === inventoryRequest.current) { setInventory(null); setInventoryError(true); setInventoryState('error'); } }
  }, []);
  const loadOverview = useCallback(() => {
    void loadSummary();
    void loadInventory();
  }, [loadInventory, loadSummary]);
  useEffect(() => { if (tab === 'summary' || tab === 'inventory') void loadOverview(); }, [tab, loadOverview]);
  useEffect(() => () => { summaryRequest.current++; inventoryRequest.current++; detailsRequest.current++; }, []);

  useEffect(() => {
    const requestId = ++detailsRequest.current;
    setProductInventory(null); setDetailError(false);
    if (!selected || !['forecast', 'inventory'].includes(tab)) { setDetailState('ready'); return; }
    if (tab === 'forecast') {
      setDetailState('ready');
      setForecastByHorizon({ 7: { state: 'loading', data: null }, 14: { state: 'loading', data: null } });
      for (const days of [7, 14] as const) {
        void apiClient.getBusinessIntelligenceForecast(selected.sku, days).then(response => {
          if (requestId !== detailsRequest.current) return;
          if (!response.success || !response.data) throw new Error('Unavailable');
          setForecastByHorizon(current => ({ ...current, [days]: { state: 'ready', data: response.data as ForecastResponse } }));
        }).catch(() => {
          if (requestId === detailsRequest.current) setForecastByHorizon(current => ({ ...current, [days]: { state: 'error', data: null } }));
        });
      }
      return;
    }
    setForecastByHorizon({});
    setDetailState('loading');
    void apiClient.getBusinessIntelligenceProductInventory(selected.sku).then(response => {
      if (requestId !== detailsRequest.current) return;
      if (!response.success || !response.data) throw new Error('Unavailable');
      setProductInventory(response.data as ProductInventory);
      setDetailState('ready');
    }).catch(() => { if (requestId === detailsRequest.current) { setDetailError(true); setDetailState('error'); } });
  }, [selected, tab, detailRetry]);

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
  const riskCountsComplete = riskRows.every(row => typeof row.value === 'number');
  const unavailableRiskCount = inventory?.summary.riskUnavailableCount || 0;
  const hasAbcClassifiedProducts = ['A', 'B', 'C'].some(key => (inventory?.summary.abcCounts?.[key] ?? 0) > 0);

  return <div className="space-y-6">
    <header className="space-y-2"><div className="flex items-center gap-2 text-primary"><BarChart3 className="h-5 w-5" aria-hidden="true" /><span className="text-sm font-semibold uppercase tracking-wider">Inteligencia del negocio</span></div><h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Analítica e Inteligencia del Negocio</h1><p className="max-w-3xl text-muted-foreground">Pronósticos, inventario y análisis del negocio en una sola vista.</p></header>
    {freshness && <p className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarClock aria-hidden="true" className="h-4 w-4" />{freshness}</p>}
    <div>
      <div role="tablist" aria-label="Secciones de inteligencia del negocio" className="flex w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1 sm:grid sm:grid-cols-4 xl:inline-grid xl:grid-cols-8">
          {([{ key: 'summary', label: 'Resumen' }, { key: 'forecast', label: 'Predicción' }, { key: 'inventory', label: 'Inventario' },
          { key: 'sales', label: 'Ventas' }, { key: 'customers', label: 'Clientes' }, { key: 'suppliers', label: 'Proveedores' },
          { key: 'related', label: 'Productos relacionados' }, { key: 'health', label: 'Salud' }] as const).map(item => <button key={item.key} id={`intelligence-tab-${item.key}`} type="button" role="tab" aria-controls={`intelligence-panel-${item.key}`} aria-selected={tab === item.key} onClick={() => setTab(item.key)} className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:shrink ${tab === item.key ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}>{item.label}</button>)}
      </div>
      <AnalyticsErrorBoundary key={tab} label={{ summary: 'resumen', forecast: 'predicción', inventory: 'inventario', sales: 'ventas', customers: 'clientes', suppliers: 'proveedores', related: 'productos relacionados', health: 'salud' }[tab]}>
      {tab === 'summary' && <section id="intelligence-panel-summary" role="tabpanel" aria-labelledby="intelligence-tab-summary" tabIndex={0} className="mt-4 space-y-6">
        {summaryState === 'loading' && <SkeletonGrid />}
        {summaryError && <ErrorPanel retry={() => void loadSummary(true)} />}
        {summaryState === 'ready' && summary && <>
          <section aria-label="Indicadores de hoy" className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Actividad comercial · hoy</h2><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="Ventas de hoy" value={summary.salesToday ? money(summary.salesToday.value, summary.salesToday.currency) : 'No disponible'} />
            <MetricCard title="Unidades vendidas hoy" value={safeNumber(summary.unitsToday)} />
            <MetricCard title="Tickets hoy" value={safeNumber(summary.ticketsToday)} />
            <MetricCard title="Ticket promedio" value={summary.averageTicket ? money(summary.averageTicket.value, summary.averageTicket.currency) : 'No disponible'} />
            <MetricCard title="Margen bruto" value={summary.grossMargin.availability === 'UNAVAILABLE' ? 'No disponible' : `${summary.grossMargin.availability === 'PARTIAL' ? 'Parcial · ' : ''}${money(summary.grossMargin.value, summary.grossMargin.currency)}${summary.grossMargin.percent !== null ? ` · ${safeNumber(summary.grossMargin.percent, 1)}%` : ''}`} hint={summary.grossMargin.availability === 'PARTIAL' ? 'Algunos costos no están disponibles.' : summary.grossMargin.availability === 'UNAVAILABLE' ? 'El costo disponible no permite calcularlo.' : undefined} help="El margen bruto resta el costo de los productos vendidos a sus ingresos. Si faltan costos, no se estima." />
          </div></section>
          <section aria-label="Indicadores de inventario" className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Inventario y atención</h2><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="Productos en riesgo" value={summary.inventory.riskCounts.critical === null || summary.inventory.riskCounts.high === null ? 'No disponible' : `${safeNumber(summary.inventory.riskCounts.critical)} críticos · ${safeNumber(summary.inventory.riskCounts.high)} altos`} hint={summary.inventory.riskCounts.critical === null || summary.inventory.riskCounts.high === null ? 'Análisis parcial; el riesgo no disponible no se cuenta como bajo.' : 'Riesgo crítico o alto'} help="Conteo del análisis de inventario para productos con riesgo crítico o alto." />
            <MetricCard title="Productos a reponer" value={safeNumber(summary.inventory.reorderCount)} help="Cantidad de productos para los que el motor recomienda reponer inventario." />
            <MetricCard title="Compras pendientes" value={safeNumber(summary.inventory.pendingPurchasesCount)} />
          </div></section>
          <ForecastImpactSummaryCard impact={forecastImpact} onNavigate={target => setTab(target)} />
          <section aria-labelledby="analytics-techniques-title" className="space-y-3">
            <div><h2 id="analytics-techniques-title" className="inline text-lg font-semibold">Técnicas analíticas utilizadas</h2><span className="ml-2"><MetricInfo label="Machine Learning">Machine Learning permite aprender patrones a partir de datos, en lugar de depender únicamente de reglas definidas manualmente.</MetricInfo></span><p className="text-sm text-muted-foreground">3 técnicas de Machine Learning y 1 técnica de minería de patrones, elegidas según el problema.</p></div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {([
                { key: 'forecast', title: 'Predicción', algorithm: 'Ridge Regression', type: 'Aprendizaje supervisado', objective: 'Pronóstico LIVE 7/14 días', status: 'Modelo ACTIVE según registro', help: 'Predice demanda con un modelo promovido para el horizonte, SKU y artefacto activos; el horizonte de 1 día no está aprobado.' },
                { key: 'customers', title: 'Clientes', algorithm: 'K-Means', type: 'Aprendizaje no supervisado', objective: 'Agrupación por similitud', status: 'Exploratorio · histórico', help: 'Busca estructuras en los datos sin utilizar etiquetas previas.' },
                { key: 'sales', title: 'Ventas', algorithm: 'Isolation Forest', type: 'Aprendizaje no supervisado', objective: 'Detección de comportamientos atípicos', status: 'Exploratorio · histórico', help: 'Busca observaciones que se separan del patrón aprendido sin etiquetas previas.' },
                { key: 'related', title: 'Productos relacionados', algorithm: 'FP-Growth', type: 'Minería de patrones', objective: 'Coocurrencias en tickets', status: 'Histórico congelado', help: 'Descubre combinaciones frecuentes de productos en datos históricos.' },
              ] as const).map(item => <article key={item.key} className="rounded-xl border bg-card p-4">
                <div className="flex items-center gap-1"><h3 className="font-semibold">{item.title}</h3><MetricInfo label={item.algorithm}>{item.help}</MetricInfo></div>
                <p className="mt-1 text-xs text-muted-foreground">{item.algorithm}</p><div className="mt-2 flex items-center gap-1"><Badge variant="outline">{item.type}</Badge><MetricInfo label={item.type}>{item.key === 'forecast' ? 'Aprende una relación entre variables de entrada y un objetivo conocido.' : item.key === 'related' ? 'Descubre combinaciones frecuentes y relaciones de coocurrencia dentro de datos históricos.' : 'Busca estructuras o comportamientos en los datos sin utilizar etiquetas previas.'}</MetricInfo></div>
                <p className="mt-2 text-sm">{item.objective}</p><p className="mt-1 text-xs text-muted-foreground">{item.status}</p>
                <button type="button" onClick={() => setTab(item.key)} className="mt-3 rounded-sm text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Ver análisis</button>
              </article>)}
            </div>
          </section>
          {summary.salesToday?.value === 0 && summary.unitsToday === 0 && summary.ticketsToday === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Hoy aún no hay ventas registradas. Los valores cero son válidos para el período.</p>}
        </>}
        {inventoryState === 'loading' && <LoadingDetail label="Cargando inventario y ranking…" />}
        {inventoryError && <ErrorPanel message="No se pudo cargar el inventario." retry={() => void loadInventory(true)} />}
        {inventoryState === 'ready' && inventory && <>
          <section className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,.9fr)]">
            <Card><CardHeader><CardTitle>Distribución de riesgo de inventario</CardTitle><CardDescription>{safeNumber(inventory.summary.totalProducts)} productos en el análisis del motor.</CardDescription></CardHeader><CardContent>{riskCountsComplete ? <div className="h-64 w-full" role="img" aria-label={`Distribución de riesgo: ${riskRows.map(row => `${row.label} ${safeNumber(row.value)}`).join(', ')}`}><ResponsiveContainer width="100%" height="100%"><BarChart data={riskRows} layout="vertical" margin={{ left: 6, right: 20, top: 4, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="label" width={65} /><Tooltip formatter={value => [safeNumber(typeof value === 'number' ? value : null), 'Productos']} /><Bar dataKey="value" name="Productos" radius={[0, 5, 5, 0]}>{riskRows.map(row => <Cell key={row.key} fill={riskColors[riskKeyLevels[row.key]]} />)}</Bar></BarChart></ResponsiveContainer></div> : <p role="status" className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">Distribución parcial: {safeNumber(unavailableRiskCount)} productos no tienen un nivel de riesgo calculable y no se cuentan como riesgo bajo.</p>}</CardContent></Card>
            <RankingTable rows={inventory.items} onSelect={selectFromRanking} />
          </section>
          <Card><CardHeader><CardTitle>Clasificación de productos</CardTitle><CardDescription>Distribución calculada por el motor de inventario.</CardDescription></CardHeader><CardContent className={`grid gap-6 ${hasAbcClassifiedProducts ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
            {hasAbcClassifiedProducts && <ClassificationChart title="Importancia económica (ABC)" counts={inventory.summary.abcCounts} colors={{ A: '#2563eb', B: '#60a5fa', C: '#bfdbfe' }} help="A agrupa productos de mayor importancia económica, B de importancia intermedia y C de menor importancia." />}
            <ClassificationChart title="Estabilidad de demanda (XYZ)" counts={inventory.summary.xyzCounts} colors={{ X: '#16a34a', Y: '#84cc16', Z: '#facc15' }} help="X indica demanda más estable, Y demanda variable y Z demanda irregular." />
          </CardContent></Card>
        </>}
      </section>}
      {tab === 'forecast' && <section id="intelligence-panel-forecast" role="tabpanel" aria-labelledby="intelligence-tab-forecast" tabIndex={0} className="mt-4 space-y-6">
        <div><h2 className="text-xl font-semibold">Pronóstico operativo</h2><p className="text-sm text-muted-foreground">Pronósticos operativos Ridge para horizontes acumulados de 7 y 14 días.</p><details className="mt-2 text-sm"><summary className="w-fit cursor-pointer font-medium">Sobre los modelos</summary><p className="mt-2 max-w-3xl text-muted-foreground">MA28 es un baseline estadístico de referencia. HistGradientBoosting (HGB) es un modelo histórico/experimental y no se utiliza para serving LIVE.</p></details></div>
        <ForecastDiagnosticsPanel onForecastModelsChange={setActiveForecastModels}
          onManualRequestFinished={() => setMlHistoryRefreshToken(value => value + 1)} />
        <ForecastImpactDetailCard impact={forecastImpact} />
          <Card><CardHeader className="pb-3"><CardTitle>Pronóstico por producto</CardTitle><CardDescription>Consulta la demanda acumulada estimada para los próximos 7 o 14 días.</CardDescription></CardHeader><CardContent className="pt-0"><ProductSearchPicker id="intelligence-product-search" selected={selected} onSelect={chooseProduct} /></CardContent></Card>
        {!selected && <EmptyProductState />}
        {selected && <ForecastPanel product={selected} forecasts={forecastByHorizon} horizon={horizon} setHorizon={setHorizon} activeModels={activeForecastModels} onRetry={() => { apiClient.invalidateIntelligenceReads(); setDetailRetry(value => value + 1); }} />}
        <ForecastMlUpdateHistoryPanel refreshToken={mlHistoryRefreshToken} />
        <ForecastReplayEvidencePanel />
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Evidencia histórica y comparación de modelos</summary>
          <div className="mt-4 space-y-3"><p className="text-sm text-muted-foreground">Esta sección contiene experimentos y evaluaciones históricas. No corresponde al modelo LIVE utilizado actualmente para predicciones operativas.</p>
            <p className="text-sm text-muted-foreground">MA28 es un baseline estadístico de referencia. HistGradientBoosting (HGB) es un modelo histórico/experimental, no usado para serving LIVE.</p>
            <ForecastEvaluationPanel />
          </div>
        </details>
        <MlTestControlPanel />
      </section>}
      {tab === 'inventory' && <section id="intelligence-panel-inventory" role="tabpanel" aria-labelledby="intelligence-tab-inventory" tabIndex={0} className="mt-4 space-y-6">
        <Card><CardContent className="p-5"><ProductSearchPicker id="intelligence-inventory-product-search" selected={selected} onSelect={chooseProduct} /></CardContent></Card>
        {!selected && <>
          {inventoryError && <ErrorPanel message="No se pudo cargar el inventario." retry={() => void loadInventory(true)} />}
          {inventoryState === 'loading' && <LoadingDetail label="Cargando ranking de inventario…" />}
            {inventory && <>
              <Card>
                <CardHeader><CardTitle>Riesgo de inventario</CardTitle><CardDescription>Distribución del análisis de inventario.</CardDescription></CardHeader>
                <CardContent>
                  <p className="mb-4 text-sm text-muted-foreground">La reposición combina pronósticos acumulados Ridge de 7/14 días con reglas operativas. La tasa diaria y la cobertura son aproximaciones de política, no un modelo de 1 día. {hasAbcClassifiedProducts ? 'ABC/XYZ' : 'XYZ'} y estas políticas no son modelos de Machine Learning.</p>
                  {inventory.availabilityStatus === 'PARTIAL' && <p role="status" className="mb-4 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Análisis parcial: los cálculos sin evidencia suficiente se muestran como no disponibles; no se sustituyen por cero ni por riesgo bajo.</p>}
                  {riskCountsComplete ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{riskRows.map(row => <div key={row.key} className="rounded-lg border p-3"><RiskBadge risk={riskKeyLevels[row.key]} /><p className="mt-2 text-xl font-semibold">{safeNumber(row.value)}</p></div>)}</div> : <p role="status" className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Distribución parcial: {safeNumber(unavailableRiskCount)} productos no tienen un nivel de riesgo calculable y no se cuentan como riesgo bajo.</p>}
                  <div className={`mt-5 grid gap-4 ${hasAbcClassifiedProducts ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
                    {hasAbcClassifiedProducts && <ClassificationChart title="Importancia económica (ABC)" counts={inventory.summary.abcCounts} colors={{ A: '#2563eb', B: '#60a5fa', C: '#bfdbfe' }} help="A representa mayor importancia económica, B importancia intermedia y C menor importancia." />}
                    <ClassificationChart title="Estabilidad de demanda (XYZ)" counts={inventory.summary.xyzCounts} colors={{ X: '#16a34a', Y: '#84cc16', Z: '#facc15' }} help="X es una demanda más estable, Y variable y Z irregular." />
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Reposición recomendada</p><p className="text-lg font-semibold">{safeNumber(inventory.summary.reorderCount)}</p></div>{inventory.summary.lowStockCount != null && <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Stock bajo</p><p className="text-lg font-semibold">{safeNumber(inventory.summary.lowStockCount)}</p></div>}{inventory.summary.overstockCount != null && <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Sobreinventario</p><p className="text-lg font-semibold">{safeNumber(inventory.summary.overstockCount)}</p></div>}{inventory.summary.slowMovingCount != null && <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Movimiento lento</p><p className="text-lg font-semibold">{safeNumber(inventory.summary.slowMovingCount)}</p></div>}{inventory.summary.deadStockCount != null && <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Sin movimiento</p><p className="text-lg font-semibold">{safeNumber(inventory.summary.deadStockCount)}</p></div>}</div>
                </CardContent>
              </Card>
              <RankingTable rows={inventory.items} onSelect={selectFromRanking} />
            </>}
        </>}
        {selected && detailState === 'loading' && <LoadingDetail label="Cargando inventario del producto…" />}
        {selected && detailError && <ErrorPanel retry={() => { apiClient.invalidateIntelligenceReads(); setDetailError(false); setDetailRetry(value => value + 1); }} />}
        {selected && detailState === 'ready' && productInventory && <ProductInventoryPanel inventory={productInventory} />}
      </section>}
      {(['sales', 'customers', 'suppliers', 'related', 'health'] as const).includes(tab as ExtendedTab) && <section id={`intelligence-panel-${tab}`} role="tabpanel" aria-labelledby={`intelligence-tab-${tab}`} tabIndex={0} className="mt-4"><ExtendedAnalyticsPanel tab={tab as ExtendedTab} inventory={inventory} /></section>}
      </AnalyticsErrorBoundary>
    </div>
  </div>;
}

function EmptyProductState() { return <Card><CardContent className="flex min-h-32 flex-col items-center justify-center gap-2 p-6 text-center"><PackageSearch className="h-8 w-8 text-muted-foreground" aria-hidden="true" /><p className="font-medium">Elige un producto para consultar su pronóstico.</p></CardContent></Card>; }
function ClassificationChart({ title, counts, colors, help }: { title: string; counts?: Record<string, number> | null; colors: Record<string, string>; help: string }) {
  const data = counts ? Object.entries(counts).map(([key, value]) => ({ name: key, value })) : [];
  return <section><h3 className="mb-2 flex items-center gap-1 text-sm font-medium">{title}<MetricInfo label={title}>{help}</MetricInfo></h3>{data.length ? <><div className="h-40" role="img" aria-label={`${title}: ${data.map(row => `${row.name}, ${safeNumber(row.value)}`).join('; ')}`}><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 6, right: 12, left: -18, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip formatter={value => [`${safeNumber(Number(value))} productos`, title]} /><Bar dataKey="value" name="Productos" radius={[5, 5, 0, 0]}>{data.map(row => <Cell key={row.name} fill={colors[row.name] || '#64748b'} />)}</Bar></BarChart></ResponsiveContainer></div><p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{data.map(row => <span key={row.name}>{row.name}: {safeNumber(row.value)}</span>)}</p></> : <p className="text-sm text-muted-foreground">Clasificación no disponible en este contrato.</p>}</section>;
}
function LoadingDetail({ label }: { label: string }) { return <Card role="status"><CardContent className="flex min-h-40 items-center justify-center gap-3 p-6"><Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />{label}</CardContent></Card>; }
function RankingTable({ rows, onSelect }: { rows: InventorySummary['items']; onSelect: (row: InventorySummary['items'][number]) => void }) {
  return <Card><CardHeader><CardTitle>Productos que requieren atención</CardTitle><CardDescription>Ranking entregado por la analítica de inventario; selecciona un producto para ver su detalle.</CardDescription></CardHeader><CardContent>{rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><caption className="sr-only">Ranking de riesgo y reposición</caption><thead><tr className="border-b text-left text-muted-foreground">{['Producto', 'Stock', 'Cobertura', 'Riesgo', 'Reposición', 'Cantidad sugerida'].map(label => <th key={label} scope="col" className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.sku} className="border-b last:border-0"><td className="px-3 py-3"><button type="button" onClick={() => onSelect(row)} className="text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row.productName}{row.presentation ? <span className="block text-xs font-normal text-muted-foreground">{row.presentation}</span> : null}<span className="block text-xs font-normal text-muted-foreground">{row.sku}</span></button></td><td className="px-3 py-3">{safeNumber(row.stock)}</td><td className="px-3 py-3">{row.coverageDays === null ? 'No disponible' : `${safeNumber(row.coverageDays, 1)} días`}</td><td className="px-3 py-3"><RiskBadge risk={row.risk} /></td><td className="px-3 py-3">{row.reorderNow === null ? 'No disponible' : row.reorderNow ? 'Sí' : 'No'}</td><td className="px-3 py-3">{row.recommendedQty === null ? 'No disponible' : `${safeNumber(row.recommendedQty)} unidades`}</td></tr>)}</tbody></table></div> : <p className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">El análisis no devolvió productos en el ranking.</p>}</CardContent></Card>;
}
function ForecastPanel({ product, forecasts, horizon, setHorizon, activeModels, onRetry }: { product: ProductOption; forecasts: Partial<Record<RidgeHorizon, ForecastRead>>; horizon: Horizon; setHorizon: (horizon: Horizon) => void; activeModels: ForecastActiveModel[] | null; onRetry: () => void }) {
  const [section, setSection] = useState<'forecast' | 'history' | 'explanation'>('forecast');
  const selectedRead = forecasts[horizon];
  const forecast = selectedRead?.data || forecasts[7]?.data || forecasts[14]?.data || null;
  const selectedUnits = forecast?.forecastPeriod?.selectedHorizonDays === horizon
    ? forecast.forecastPeriod.units
    : forecast?.horizons[`${horizon}d` as '7d' | '14d'] ?? forecast?.predictionUnits ?? null;
  const activeModel = activeModels?.find(model => model.horizonDays === horizon) || null;
  const historical = forecast?.mode === 'HISTORICAL';
  const activeVersion = activeModel?.modelVersion ?? forecast?.modelVersion ?? null;
  const selectedForecast = selectedRead?.data;
  const unavailable = selectedForecast?.status === 'MODEL_UNAVAILABLE' || selectedForecast?.status === 'FEATURE_UNAVAILABLE';
  const insufficient = selectedForecast?.status === 'INSUFFICIENT_HISTORY' || selectedForecast?.status === 'COLD_START' || selectedForecast?.status === 'NOT_AVAILABLE';
  const observed = (forecast?.observedSeries || []).map(point => ({ ...point,
    observed: point.status === 'MISSING' || point.status === 'PARTIAL' ? null : point.units,
    partial: point.status === 'PARTIAL' ? point.units : null,
    statusLabel: seriesLabels[point.status] }));
  return <div className="space-y-4"><div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-lg font-semibold">{product.name || product.sku}</h3><p className="text-sm text-muted-foreground">{product.presentation || 'Presentación no especificada'} · SKU: {product.sku}</p></div><p className="text-xs text-muted-foreground">{forecast ? freshnessLine(forecast) : 'Consultando horizontes Ridge…'}</p></div>
    <nav aria-label="Secciones del producto" className="flex flex-wrap gap-2 border-b pb-2">{([['forecast', 'Pronóstico'], ['history', 'Historial de operaciones'], ['explanation', 'Explicación ML']] as const).map(([key, label]) => <Button key={key} type="button" variant={section === key ? 'default' : 'outline'} aria-pressed={section === key} onClick={() => setSection(key)}>{label}</Button>)}</nav>
    {section === 'history' ? <ProductOperationHistoryPanel key={product.sku} sku={product.sku} />
      : section === 'explanation' ? <Card><CardHeader><CardTitle>Cómo se relacionan las operaciones con Ridge</CardTitle><CardDescription>El historial muestra hechos persistidos; no atribuye promociones a una operación individual.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm"><p><strong>Venta</strong> → evidencia de demanda para Ridge.</p><p><strong>Cancelación</strong> → corrección de evidencia previamente registrada.</p><p><strong>Compra o recepción</strong> → afecta inventario, no demanda observada.</p><p><strong>Ajuste</strong> → modifica inventario, no demanda observada.</p><p className="rounded-md bg-muted p-3">Evidencia → debounce → maduración → candidato → evaluación → promoción o rechazo. Los 107 origins son orígenes maduros de evaluación, no 107 ventas.</p><p>Una señal no garantiza reentrenamiento ni promoción inmediata; Ridge LIVE solo sirve 7 y 14 días.</p></CardContent></Card>
      : <>
      <div className="grid gap-4 sm:grid-cols-2">{horizons.map(days => {
        const entry = forecasts[days];
        const data = entry?.data;
        const model = activeModels?.find(candidate => candidate.horizonDays === days);
        const value = historical ? forecast?.horizons[`${days}d` as '7d' | '14d'] : data?.forecastPeriod?.selectedHorizonDays === days ? data.forecastPeriod.units : data?.predictionUnits ?? data?.horizons[`${days}d` as '7d' | '14d'];
        const cardValue = entry?.state === 'loading' ? 'Cargando…'
          : entry?.state === 'error' ? 'Error'
          : data?.status === 'MODEL_UNAVAILABLE' || data?.status === 'FEATURE_UNAVAILABLE' || model?.status === 'MODEL_UNAVAILABLE' ? 'No disponible'
              : safeNumber(value, 2);
        const cardHint = entry?.state === 'loading' ? 'Consultando Ridge…'
          : entry?.state === 'error' ? 'No se pudo consultar este horizonte'
            : data?.status === 'MODEL_UNAVAILABLE' || data?.status === 'FEATURE_UNAVAILABLE' ? 'Modelo no disponible'
              : days === horizon ? 'detalle seleccionado' : historical ? 'total histórico MA28' : 'total Ridge del horizonte';
        return <button key={days} type="button" aria-pressed={horizon === days} onClick={() => setHorizon(days)} className={`rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${horizon === days ? 'border-primary bg-primary/5' : 'bg-card hover:bg-muted/50'}`}><span className="text-sm text-muted-foreground">Pronóstico {days} días</span><span className="mt-1 block text-3xl font-bold tracking-tight">{cardValue}</span><span className="text-xs text-muted-foreground">{cardHint}</span></button>;
      })}</div>
    <div className="text-center"><span className="text-xs text-muted-foreground">{historical ? 'Modelo histórico · MA28' : `Modelo LIVE · Ridge ${activeVersion == null ? 'versión no disponible' : `v${activeVersion}`}`}</span></div>
    {selectedRead?.state === 'loading' || !selectedRead ? <LoadingDetail label={`Cargando pronóstico de ${horizon} días…`} />
        : selectedRead?.state === 'error' ? <ErrorPanel retry={onRetry} />
          : unavailable || insufficient || selectedForecast?.status !== 'READY' ? <Card role="status"><CardContent className="p-5"><p className="font-medium">{insufficient ? 'Historial insuficiente para generar un pronóstico.' : 'El modelo LIVE no está disponible para este producto y horizonte.'}</p><p className="mt-1 text-sm text-muted-foreground">No se sustituye por el baseline ni por un pronóstico histórico.</p>{selectedForecast?.reasonCode && <details className="mt-2 text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">Ver motivo técnico</summary><p className="mt-1">{selectedForecast.reasonCode}</p></details>}</CardContent></Card>
            : forecast ? <>
      <ChartCard title="Historial observado" description="El modelo Ridge informa el total del horizonte; no se inventa una distribución diaria."><div className="h-72 w-full" role="img" aria-label="Serie diaria observada de unidades vendidas; días faltantes se muestran sin valor y el pronóstico se informa por separado"><ResponsiveContainer width="100%" height="100%"><LineChart data={observed} margin={{ top: 12, right: 16, left: 0, bottom: 5 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={value => String(value).slice(5)} minTickGap={28} /><YAxis allowDecimals={false} label={{ value: 'Unidades', angle: -90, position: 'insideLeft' }} /><Tooltip labelFormatter={value => formatDate(String(value))} formatter={(value, _name, item) => [typeof value === 'number' ? `${safeNumber(value)} unidades` : value === null ? 'Sin dato' : String(value), item.payload?.statusLabel || 'Unidades observadas']} /><Line type="monotone" dataKey="observed" name="Días cerrados" stroke="#2563eb" strokeWidth={2} connectNulls={false} dot={{ r: 2 }} activeDot={{ r: 5 }} /><Line type="monotone" dataKey="partial" name="Día parcial" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 4" connectNulls={false} dot={{ r: 4, fill: '#f59e0b' }} /></LineChart></ResponsiveContainer></div><div className="mt-3 flex flex-wrap gap-1.5 text-xs" aria-label="Estados de la serie">{(['CLOSED', 'ZERO', 'MISSING', 'PARTIAL'] as SeriesStatus[]).map(status => <Badge key={status} variant="outline" className="font-normal text-muted-foreground">{seriesLabels[status]}</Badge>)}</div><p className="mt-4 rounded-md bg-primary/5 p-4 text-base">Total para {horizon} días: <strong className="text-xl">{safeNumber(selectedUnits, 2)} unidades</strong>.</p></ChartCard>
      <details className="rounded-lg border p-3 text-sm"><summary className="w-fit cursor-pointer font-medium">Ver detalles del modelo</summary><dl className="mt-3 grid gap-2 text-muted-foreground sm:grid-cols-2">
        <div><dt>Método seleccionado</dt><dd>{historical ? 'Media móvil de 28 días (histórico)' : forecast.modelFamily === 'RIDGE_REGRESSION' ? 'Machine Learning Ridge' : 'No disponible'}</dd></div>
        <div><dt>Datos observados hasta</dt><dd>{formatDate(forecast.observationCutoff)}</dd></div>
        {forecast.forecastStartDate && forecast.forecastEndDate && <div><dt>Período cubierto</dt><dd>{formatLocalDay(forecast.forecastStartDate)}–{formatLocalDay(forecast.forecastEndDate)} · total acumulado.</dd></div>}
        {forecast.modelVersion != null && <div><dt>Versión activa</dt><dd>v{forecast.modelVersion}</dd></div>}
        {forecast.featureVersion && <div><dt>Versión de features</dt><dd>{forecast.featureVersion}</dd></div>}
        {(forecast.recipeId || activeModel?.recipeId) && <div><dt>Receta</dt><dd>{forecast.recipeId || activeModel?.recipeId}</dd></div>}
        {forecast.promotionPolicyVersion && <div><dt>Política de promoción</dt><dd>{forecast.promotionPolicyVersion}</dd></div>}
        {forecast.dataCutoff && <div><dt>Corte de entrenamiento</dt><dd>{formatDate(forecast.dataCutoff)}</dd></div>}
        {forecast.modelVersion != null && <div><dt>Revisión del artefacto / snapshot</dt><dd>{forecast.trainedDataVersion ?? 'No disponible'} / {forecast.dataVersion ?? 'No disponible'}</dd></div>}
        {forecast.snapshotHash && <div><dt>Huella del snapshot</dt><dd className="break-all font-mono text-xs">{forecast.snapshotHash}</dd></div>}
        {forecast.isTrainingPending != null && <div><dt>Actualización del modelo</dt><dd>{forecast.isTrainingPending ? 'Pendiente de datos posteriores' : 'Incluye la revisión consultada'}</dd></div>}
        {activeModel?.metrics && <div><dt>Validación (WAPE / MAE / sesgo)</dt><dd>{safeNumber(activeModel.metrics.wape, 3)} / {safeNumber(activeModel.metrics.mae, 3)} / {safeNumber(activeModel.metrics.bias, 3)}</dd></div>}
        {!historical && forecast.baselineUnits != null && <div><dt>Baseline estadístico MA28</dt><dd>{safeNumber(forecast.baselineUnits, 2)} unidades; solo referencia, no sustituye el modelo.</dd></div>}
      </dl></details>
    </> : <Card role="status"><CardContent className="p-5 text-sm text-muted-foreground">El pronóstico no está disponible para este período.</CardContent></Card>}
      </>}
  </div>;
}
function ProductInventoryPanel({ inventory }: { inventory: ProductInventory }) {
  const policy = inventory.inventoryPolicy;
  const hasClassifiedAbc = ['A', 'B', 'C'].includes(inventory.classification.abc || '');
  const hasPreventiveQuantity = inventory.recommendation.reorderNow === false
    && typeof inventory.recommendation.recommendedQty === 'number' && inventory.recommendation.recommendedQty > 0;
  const quantityLabel = hasPreventiveQuantity ? 'Cantidad para el nivel objetivo' : 'Cantidad recomendada';
  const cards: Array<[string, string]> = [
    ['Stock actual', safeNumber(inventory.stock.onHand)], ['Entrante', safeNumber(inventory.stock.incoming)],
    ['Posición de inventario', safeNumber(inventory.stock.inventoryPosition)], ['Tasa diaria aproximada', inventory.demand.expectedDaily === null ? 'No disponible' : `${safeNumber(inventory.demand.expectedDaily, 2)} unidades`],
    ['Días de cobertura', inventory.coverage.daysCover === null ? 'No disponible' : `${safeNumber(inventory.coverage.daysCover, 1)} días`],
    ['Stock de seguridad', safeNumber(policy.safetyStock)], ['Punto de reorden', safeNumber(policy.reorderPoint)],
    [quantityLabel, inventory.recommendation.recommendedQty === null ? 'No disponible' : `${safeNumber(inventory.recommendation.recommendedQty)} unidades`],
  ];
  const explanation = inventory.risk.level === 'CRITICAL' || inventory.risk.level === 'HIGH' ? 'El producto presenta riesgo elevado de quiebre.' : inventory.coverage.daysCover !== null ? `Stock suficiente para aproximadamente ${safeNumber(inventory.coverage.daysCover, 1)} días.` : 'La cobertura no está disponible.';
  const action = inventory.recommendation.reorderNow === true ? 'Se recomienda reposición inmediata.' : hasPreventiveQuantity ? 'No se recomienda reposición inmediata; la cantidad mostrada es una referencia para completar el nivel objetivo.' : inventory.recommendation.reorderNow === false ? 'No se recomienda reposición inmediata.' : 'La recomendación de reposición no está disponible.';
  const partialReason = inventory.recommendation.reasonCode === 'UNSUPPORTED_LEAD_TIME'
    ? 'No hay un horizonte ML aprobado para este plazo.'
    : inventory.recommendation.reasonCode || inventory.risk.reasonCode
      ? 'Pronóstico insuficiente para este cálculo.' : null;
  return <div className="space-y-5"><div><h2 className="text-xl font-semibold">{inventory.product.name || inventory.product.sku}</h2><p className="text-sm text-muted-foreground">{inventory.product.presentation || 'Presentación no especificada'} · SKU: {inventory.product.sku} · {freshnessLine(inventory.freshness)}</p></div><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores de inventario del producto">{cards.map(([title, value]) => <MetricCard key={title} title={title} value={value} help={title === 'Tasa diaria aproximada' ? 'Tasa operativa derivada de Ridge acumulado a 7 y 14 días; no es un pronóstico ML de 1 día.' : title === 'Días de cobertura' ? 'Estimación de política usando la tasa aproximada derivada de los horizontes Ridge 7/14.' : title === 'Stock de seguridad' ? 'Reserva heurística existente; requiere historial observable y variabilidad de entrega.' : title === 'Punto de reorden' ? 'Referencia operativa disponible cuando la demanda del plazo de entrega está respaldada.' : undefined} />)}</section><Card><CardHeader><CardTitle>Estado y recomendación</CardTitle><CardDescription>Valores reportados por el análisis de inventario.</CardDescription></CardHeader><CardContent className="flex flex-wrap items-center gap-3"><RiskBadge risk={inventory.risk.level} />{hasClassifiedAbc && <Badge variant="outline"><MetricLabel label={`ABC: ${inventory.classification.abc}`} help="ABC clasifica la importancia económica: A alta, B intermedia y C menor." /></Badge>}<Badge variant="outline"><MetricLabel label={`XYZ: ${inventory.classification.xyz || 'No disponible'}`} help="XYZ describe la estabilidad de la demanda: X estable, Y variable y Z irregular." /></Badge>{partialReason && <p role="status" className="w-full rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{partialReason}</p>}<p className="w-full rounded-lg bg-muted/50 p-3 text-sm">{explanation} {action}{inventory.recommendation.recommendedQty != null ? ` Cantidad para el nivel objetivo: ${safeNumber(inventory.recommendation.recommendedQty)} unidades.` : ''}</p><p className="w-full text-sm"><strong>Reposición inmediata:</strong> {inventory.recommendation.reorderNow === null ? 'No disponible' : inventory.recommendation.reorderNow ? 'Sí' : 'No'}</p>{inventory.recommendation.preventiveRecommendation === true && <p className="w-full text-sm">Reposición preventiva sugerida</p>}</CardContent></Card></div>;
}
