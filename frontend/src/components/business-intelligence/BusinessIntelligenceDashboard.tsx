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
import { ForecastMlUpdatePanel } from './ForecastMlUpdatePanel';
import { ForecastMlUpdateHistoryPanel } from './ForecastMlUpdateHistoryPanel';
import { ForecastReplayEvidencePanel } from './ForecastReplayEvidencePanel';
import { ProductOperationHistoryPanel } from './ProductOperationHistoryPanel';
import { MlTestControlPanel } from './MlTestControlPanel';
import { MlTestScenarioUiProvider, useMlTestScenarioUiState } from './MlTestScenarioUiContext';
import { AnalyticsErrorBoundary } from './AnalyticsErrorBoundary';
import { MlTestEpochBoundary } from './MlTestEpochBoundary';
import { ForecastImpactDetailCard, useForecastImpact } from './ForecastImpactPanel';
import { InventoryImpactDetailCard, useInventoryImpact } from './InventoryImpactPanel';

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
function ExecutiveMetric({ title, value, hint, help }: { title: string; value: string; hint?: string; help?: React.ReactNode }) {
  return <Card className="min-w-0"><CardContent className="px-4 py-3.5"><p className="text-xs font-medium text-muted-foreground"><MetricLabel label={title} help={help} /></p><p className="mt-2 break-words text-2xl font-semibold tracking-tight">{value}</p>{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}</CardContent></Card>;
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

function RecentOperationStrip({ forecastImpact, inventoryImpact, onNavigate }: {
  forecastImpact: ReturnType<typeof useForecastImpact>;
  inventoryImpact: ReturnType<typeof useInventoryImpact>;
  onNavigate: (tab: TabKey) => void;
}) {
  const event = inventoryImpact.event;
  const sale = forecastImpact.sale;
  const preferSale = Boolean(sale && (!event || Date.parse(sale.occurredAt) > Date.parse(event.occurredAt)));
  const operationAt = preferSale ? sale?.occurredAt : event?.occurredAt;
  const operationType = preferSale ? 'Venta' : event ? ({ SALE: 'Venta', SALE_CANCELLED: 'Anulación de venta', PURCHASE_CREATED: 'Compra inmediata', INVENTORY_ADJUSTMENT: 'Ajuste de inventario' } as const)[event.type] : null;
  const products = preferSale ? sale?.products : event?.products;
  const hasCustomer = Boolean(sale?.hasCustomer && (preferSale || event?.type === 'SALE'));
  const hasForecastEvidence = Boolean(sale || event?.type === 'SALE' || event?.type === 'SALE_CANCELLED');
  const links: Array<{ tab: TabKey; label: string }> = [];
  if (event || sale) links.push({ tab: 'inventory', label: 'Ver inventario' });
  if (hasForecastEvidence) links.push({ tab: 'forecast', label: 'Ver predicción' });
  if (hasCustomer) links.push({ tab: 'customers', label: 'Ver cliente' });
  const count = products?.reduce((sum, product) => sum + product.quantity, 0) ?? null;
  const dateLabel = operationAt ? new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(operationAt)) : null;
  return <section aria-label="Última operación" className="flex flex-col gap-2 rounded-xl border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0">{operationType ? <><p className="text-sm font-medium">{operationType}{preferSale && sale?.transactionId ? ` · #${sale.transactionId.slice(-8)}` : event?.reference ? ` · ${event.reference}` : ''}{dateLabel ? ` · ${dateLabel}` : ''}</p><p className="text-xs text-muted-foreground">{products?.length ?? 0} producto(s){count == null ? '' : ` · ${count} unidad(es)`}{event || sale ? ' · Inventario operativo afectado' : ''}{hasForecastEvidence ? ' · Evidencia para revisar en Predicción' : ''}{hasCustomer ? ' · Cliente asociado' : ''}</p></> : <p className="text-sm text-muted-foreground">Sin una operación reciente para comparar.</p>}</div>
    {links.length > 0 && <nav aria-label="Accesos a la última operación" className="flex flex-wrap gap-x-4 gap-y-1">{links.map(link => <button key={link.tab} type="button" onClick={() => onNavigate(link.tab)} className="text-sm font-medium text-primary underline underline-offset-4">{link.label}</button>)}</nav>}
  </section>;
}

function BusinessIntelligenceContent() {
  const scenarioUi = useMlTestScenarioUiState();
  const tab = scenarioUi.tab as TabKey;
  const activeTab = useRef<TabKey>(tab);
  activeTab.current = tab;
  const setTab = scenarioUi.setTab as React.Dispatch<React.SetStateAction<TabKey>>;
  const [mlHistoryRefreshToken, setMlHistoryRefreshToken] = useState(0);
  const [summary, setSummary] = useState<BusinessSummary | null>(null);
  const [inventory, setInventory] = useState<InventorySummary | null>(null);
  const [summaryState, setSummaryState] = useState<LoadState>('loading');
  const [inventoryState, setInventoryState] = useState<LoadState>('loading');
  const [summaryError, setSummaryError] = useState(false);
  const [inventoryError, setInventoryError] = useState(false);
  const [selected, setSelected] = useState<ProductOption | null>(null);
  const forecastImpact = useForecastImpact(tab === 'forecast');
  const inventoryImpact = useInventoryImpact();
  const [horizon, setHorizon] = useState<Horizon>(7);
  const [forecastByHorizon, setForecastByHorizon] = useState<Partial<Record<RidgeHorizon, ForecastRead>>>({});
  const [activeForecastModels, setActiveForecastModels] = useState<ForecastActiveModel[] | null>(null);
  const [productInventory, setProductInventory] = useState<ProductInventory | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('loading');
  const [detailError, setDetailError] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const [localToolsMounted, setLocalToolsMounted] = useState(false);
  const [forecastDiagnosticsMounted, setForecastDiagnosticsMounted] = useState(false);
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
    } catch {
      if (requestId === summaryRequest.current) { setSummary(null); setSummaryError(true); setSummaryState('error'); } }
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
    } catch {
      if (requestId === inventoryRequest.current) { setInventory(null); setInventoryError(true); setInventoryState('error'); } }
  }, []);
  const loadOverview = useCallback((prioritizeInventory = false) => {
    if (prioritizeInventory) {
      void loadSummary();
      void loadInventory();
      return;
    }
    void loadSummary().then(() => { if (activeTab.current === 'summary') loadInventory(); });
  }, [loadInventory, loadSummary]);
  useEffect(() => { if (tab === 'summary' || tab === 'inventory') void loadOverview(tab === 'inventory'); }, [tab, loadOverview]);
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
  const selectFromSummaryRanking = (row: InventorySummary['items'][number]) => {
    setSelected({ id: row.sku, sku: row.sku, name: row.productName, presentation: row.presentation });
    setTab('inventory');
  };
  const freshness = summary ? freshnessLine(summary) : null;
  const riskRows = inventory ? ([
    { key: 'critical' as const, label: 'Crítico', value: inventory.summary.riskCounts.critical },
    { key: 'high' as const, label: 'Alto', value: inventory.summary.riskCounts.high },
    { key: 'medium' as const, label: 'Medio', value: inventory.summary.riskCounts.medium },
    { key: 'low' as const, label: 'Bajo', value: inventory.summary.riskCounts.low },
  ]) : [];
  const riskCountsComplete = riskRows.every(row => typeof row.value === 'number');
  const riskAggregateUnavailable = summary?.inventory.riskCounts.critical == null || summary?.inventory.riskCounts.high == null;
  const reorderAggregateUnavailable = summary?.inventory.reorderCount == null;
  const riskUnavailableCount = inventory?.summary.riskUnavailableCount ?? null;
  const recommendationUnavailableCount = inventory?.summary.recommendationUnavailableCount ?? null;
  const riskEvaluableCounts = inventory?.summary.riskEvaluableCounts;
  const riskEvaluableCount = inventory?.summary.riskEvaluableCount ?? null;
  const riskCriticalCount = riskUnavailableCount != null && riskUnavailableCount > 0
    ? riskEvaluableCounts?.critical ?? null
    : inventory?.summary.riskCounts.critical ?? riskEvaluableCounts?.critical ?? null;
  const riskHighCount = riskUnavailableCount != null && riskUnavailableCount > 0
    ? riskEvaluableCounts?.high ?? null
    : inventory?.summary.riskCounts.high ?? riskEvaluableCounts?.high ?? null;
  const riskCriticalHighTotal = typeof riskCriticalCount === 'number' && typeof riskHighCount === 'number'
    ? riskCriticalCount + riskHighCount : null;
  const riskDistributionRows = riskRows.flatMap(row => {
    const value = riskUnavailableCount != null && riskUnavailableCount > 0
      ? riskEvaluableCounts?.[row.key]
      : row.value ?? riskEvaluableCounts?.[row.key];
    return typeof value === 'number' ? [{ ...row, value }] : [];
  });
  const reorderCountEvaluable = inventory?.summary.reorderCountEvaluable ?? null;
  const reorderEvaluableCount = inventory?.summary.reorderEvaluableCount ?? null;
  const reorderDecisionUnavailableCount = inventory?.summary.reorderDecisionUnavailableCount ?? null;
  const partialReorderCountAvailable = reorderCountEvaluable != null && reorderEvaluableCount != null && reorderEvaluableCount > 0;
  const grossMarginCostCoverage = summary?.grossMargin.costCoverage;

  return <div className="space-y-6">
    <header className="space-y-2"><div className="flex items-center gap-2 text-primary"><BarChart3 className="h-5 w-5" aria-hidden="true" /><span className="text-sm font-semibold uppercase tracking-wider">Inteligencia del negocio</span></div><h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Analítica e Inteligencia del Negocio</h1><p className="max-w-3xl text-muted-foreground">Pronósticos, inventario y análisis del negocio en una sola vista.</p></header>
    {freshness && <p className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarClock aria-hidden="true" className="h-4 w-4" />{freshness}</p>}
    <div>
      <div className="w-full overflow-x-auto">
        <div role="tablist" aria-label="Secciones de inteligencia del negocio" className="flex w-max min-w-full justify-start gap-2 rounded-lg bg-muted p-1 xl:justify-center">
          {([{ key: 'summary', label: 'Resumen' }, { key: 'forecast', label: 'Predicción' }, { key: 'inventory', label: 'Inventario' },
          { key: 'sales', label: 'Ventas' }, { key: 'customers', label: 'Clientes' }, { key: 'suppliers', label: 'Proveedores' },
          { key: 'related', label: 'Productos relacionados' }, { key: 'health', label: 'Salud' }] as const).map(item => <button key={item.key} id={`intelligence-tab-${item.key}`} type="button" role="tab" aria-controls={`intelligence-panel-${item.key}`} aria-selected={tab === item.key} onClick={() => setTab(item.key)} className={`flex-none whitespace-nowrap rounded-md border px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item.key ? 'border-primary bg-background text-foreground shadow' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{item.label}</button>)}
        </div>
      </div>
      <AnalyticsErrorBoundary key={tab} label={{ summary: 'resumen', forecast: 'predicción', inventory: 'inventario', sales: 'ventas', customers: 'clientes', suppliers: 'proveedores', related: 'productos relacionados', health: 'salud' }[tab]}>
      {tab === 'summary' && <section id="intelligence-panel-summary" role="tabpanel" aria-labelledby="intelligence-tab-summary" tabIndex={0} className="mt-4 space-y-6">
        {summaryState === 'loading' && <SkeletonGrid />}
        {summaryError && <ErrorPanel retry={() => void loadSummary(true)} />}
        {summaryState === 'ready' && summary && <>
          <section aria-label="Actividad de hoy" className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Actividad de hoy</h2><div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
            <ExecutiveMetric title="Ventas" value={summary.salesToday ? money(summary.salesToday.value, summary.salesToday.currency) : 'No disponible'} />
            <ExecutiveMetric title="Unidades vendidas" value={safeNumber(summary.unitsToday)} />
            <ExecutiveMetric title="Tickets" value={safeNumber(summary.ticketsToday)} />
            <ExecutiveMetric title="Ticket promedio" value={summary.averageTicket ? money(summary.averageTicket.value, summary.averageTicket.currency) : 'No disponible'} />
            <ExecutiveMetric title="Margen bruto" value={summary.grossMargin.availability === 'PARTIAL' || summary.grossMargin.availability === 'UNAVAILABLE' ? 'No disponible' : `${money(summary.grossMargin.value, summary.grossMargin.currency)}${summary.grossMargin.percent !== null ? ` · ${safeNumber(summary.grossMargin.percent, 1)}%` : ''}`} hint={summary.grossMargin.availability === 'PARTIAL'
              ? grossMarginCostCoverage?.knownSaleLines != null && grossMarginCostCoverage.unknownSaleLines != null
                ? `Costos registrados para ${safeNumber(grossMarginCostCoverage.knownSaleLines)} de ${safeNumber(grossMarginCostCoverage.knownSaleLines + grossMarginCostCoverage.unknownSaleLines)} líneas de venta.`
                : 'Cobertura de costos parcial; no se muestra un margen total.'
              : summary.grossMargin.availability === 'UNAVAILABLE' ? 'No hay costos suficientes para calcularlo.' : undefined}
              help="El margen bruto suma ingresos menos costo histórico capturado por línea. Si falta costo en alguna línea relevante, no se estima el total." />
          </div></section>
          <section aria-label="Inventario y atención" className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Inventario y atención</h2><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <ExecutiveMetric title="Productos en riesgo" value={riskAggregateUnavailable ? 'No disponible' : `${safeNumber(summary.inventory.riskCounts.critical)} críticos · ${safeNumber(summary.inventory.riskCounts.high)} altos`} hint={riskAggregateUnavailable
              ? `Conteo global no disponible; análisis parcial disponible abajo${riskUnavailableCount != null && riskUnavailableCount > 0 ? ` (${safeNumber(riskUnavailableCount)} sin riesgo calculable)` : ''}.`
              : 'Crítico y alto'} help="Conteo global contractual. Si algún producto carece de riesgo calculable, no se presenta un total incompleto como global." />
            <ExecutiveMetric title="Productos a reponer" value={safeNumber(summary.inventory.reorderCount)} hint={reorderAggregateUnavailable
              ? `Conteo global no disponible; revisa las acciones por producto abajo${recommendationUnavailableCount != null && recommendationUnavailableCount > 0 ? ` (${safeNumber(recommendationUnavailableCount)} sin recomendación calculable)` : ''}.`
              : undefined} help="Conteo global de productos cuyo shouldReorder es verdadero; no es un conteo del Top visible." />
            <ExecutiveMetric title="Compras pendientes" value={safeNumber(summary.inventory.pendingPurchasesCount)} />
          </div></section>
          <RecentOperationStrip forecastImpact={forecastImpact} inventoryImpact={inventoryImpact} onNavigate={setTab} />
          <section aria-labelledby="analytics-techniques-title" className="space-y-3">
            <div><h2 id="analytics-techniques-title" className="text-lg font-semibold">Técnicas de análisis</h2></div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {([
                { key: 'forecast', title: 'Predicción', algorithm: 'Ridge Regression', type: 'LIVE', objective: 'Demanda acumulada a 7 y 14 días', status: '1 día no aprobado', help: 'Pronóstico servido con modelos activos por horizonte.' },
                { key: 'customers', title: 'Clientes', algorithm: 'RFM + K-Means', type: 'OPERACIONAL + ML', objective: 'Actividad y grupos por similitud', status: 'Modelo de referencia', help: 'RFM describe actividad; K-Means asigna al modelo congelado.' },
                { key: 'sales', title: 'Ventas', algorithm: 'Isolation Forest', type: 'HISTÓRICO', objective: 'Días con patrones inusuales', status: 'No implica fraude', help: 'Analiza una ventana histórica congelada.' },
                { key: 'related', title: 'Productos relacionados', algorithm: 'FP-Growth', type: 'REGLA · HISTÓRICO', objective: 'Productos que coocurren en tickets', status: 'No se actualiza por venta individual', help: 'Resume reglas históricas de asociación; no implica causalidad.' },
              ] as const).map(item => <article key={item.key} className="min-w-0 rounded-xl border bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{item.title}</h3><Badge variant="outline" className="text-[10px]">{item.type}</Badge></div>
                <p className="mt-1 text-xs text-muted-foreground">{item.objective}</p><p className="mt-2 flex items-center gap-1 text-sm font-semibold">{item.algorithm}<MetricInfo label={item.algorithm}>{item.help}</MetricInfo></p>
                <button type="button" onClick={() => setTab(item.key)} className="mt-2 rounded-sm text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Ver análisis</button>
              </article>)}
            </div>
          </section>
          {summary.salesToday?.value === 0 && summary.unitsToday === 0 && summary.ticketsToday === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Hoy aún no hay ventas registradas. Los valores cero son válidos para el período.</p>}
        </>}
        {inventoryState === 'loading' && <LoadingDetail label="Cargando inventario y ranking…" />}
        {inventoryError && <ErrorPanel message="No se pudo cargar el inventario." retry={() => void loadInventory(true)} />}
        {inventoryState === 'ready' && inventory && <>
          <section aria-labelledby="inventory-overview-title" className="space-y-3"><h2 id="inventory-overview-title" className="text-lg font-semibold">Panorama de inventario</h2><div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0"><CardHeader className="pb-2"><CardTitle className="text-base">Distribución de riesgo</CardTitle><CardDescription>{safeNumber(inventory.summary.totalProducts)} productos analizados</CardDescription></CardHeader><CardContent>{riskCountsComplete ? <div className="mx-auto h-36 w-full max-w-2xl" role="img" aria-label={`Distribución de riesgo: ${riskRows.map(row => `${row.label} ${safeNumber(row.value)}`).join(', ')}`}><ResponsiveContainer width="100%" height="100%"><BarChart data={riskRows} layout="vertical" margin={{ left: 4, right: 16, top: 2, bottom: 2 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="label" width={58} /><Tooltip formatter={value => [safeNumber(typeof value === 'number' ? value : null), 'Productos']} /><Bar dataKey="value" name="Productos" radius={[0, 5, 5, 0]}>{riskRows.map(row => <Cell key={row.key} fill={riskColors[riskKeyLevels[row.key]]} />)}</Bar></BarChart></ResponsiveContainer></div> : <p role="status" className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Distribución parcial: {riskUnavailableCount == null ? 'Cantidad sin riesgo calculable no disponible.' : `${safeNumber(riskUnavailableCount)} productos no tienen un nivel de riesgo calculable`}; no se cuentan como riesgo bajo.</p>}</CardContent></Card>
            <Card className="min-w-0"><CardHeader className="pb-2"><CardTitle className="text-base">Estabilidad de demanda (XYZ)</CardTitle><CardDescription>Clasificación descriptiva · no es un pronóstico</CardDescription></CardHeader><CardContent><ClassificationChart title="Distribución XYZ" compact counts={inventory.summary.xyzCounts} colors={{ X: '#16a34a', Y: '#84cc16', Z: '#facc15', UNCLASSIFIED: '#94a3b8' }} requiredLabels={['X', 'Y', 'Z', 'UNCLASSIFIED']} help="X indica demanda estable, Y variable y Z irregular." /></CardContent></Card>
          </div></section>
          <section aria-label="Productos que requieren atención" className="space-y-3"><h2 className="text-lg font-semibold">Productos que requieren atención</h2><SummaryRanking rows={inventory.items.slice(0, 8)} onSelect={selectFromSummaryRanking} onViewAll={() => setTab('inventory')} /></section>
        </>}
      </section>}
      {tab === 'forecast' && <ForecastMlUpdatePanel onManualRequestFinished={() => setMlHistoryRefreshToken(value => value + 1)}>
        {({ statusSummary, preparation }) => <section id="intelligence-panel-forecast" role="tabpanel" aria-labelledby="intelligence-tab-forecast" tabIndex={0} className="mt-4 space-y-4">
          <Card aria-label="Pronóstico Ridge LIVE" className="overflow-hidden">
            <CardHeader className="pb-3"><div><CardTitle>Pronóstico Ridge LIVE</CardTitle><CardDescription>Horizontes aprobados: 7 y 14 días. El horizonte de 1 día no está aprobado.</CardDescription></div></CardHeader>
            <CardContent className="space-y-3 pt-0">
              {statusSummary}
              <details onToggle={event => { if (event.currentTarget.open) setForecastDiagnosticsMounted(true); }} className="border-t pt-2 text-sm"><summary className="cursor-pointer font-medium">Detalles técnicos</summary>
                {forecastDiagnosticsMounted && <div className="mt-3"><ForecastDiagnosticsPanel showUpdatePanel={false} onForecastModelsChange={setActiveForecastModels} /></div>}
              </details>
            </CardContent>
          </Card>
          <Card><CardHeader className="pb-3"><CardTitle>Pronóstico por producto</CardTitle><CardDescription>Selecciona un producto para consultar P7 y P14; son valores directos del modelo Ridge.</CardDescription></CardHeader><CardContent className="pt-0"><ProductSearchPicker id="intelligence-product-search" selected={selected} onSelect={chooseProduct} /></CardContent></Card>
          {!selected && <EmptyProductState />}
          {selected && <ForecastPanel product={selected} forecasts={forecastByHorizon} horizon={horizon} setHorizon={setHorizon} activeModels={activeForecastModels} onRetry={() => { apiClient.invalidateIntelligenceReads(); setDetailRetry(value => value + 1); }} />}
          <ForecastImpactDetailCard impact={forecastImpact} />
          {preparation}
          <ForecastMlUpdateHistoryPanel refreshToken={mlHistoryRefreshToken} />
          <ForecastReplayEvidencePanel />
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Evidencia histórica y comparación de modelos</summary>
            <div className="mt-4 space-y-3"><p className="text-sm text-muted-foreground">Esta sección contiene experimentos y evaluaciones históricas. No corresponde al modelo LIVE utilizado actualmente para predicciones operativas.</p>
              <p className="text-sm text-muted-foreground">MA28 es un baseline estadístico de referencia. HistGradientBoosting (HGB) es un modelo histórico/experimental, no usado para serving LIVE.</p>
              <ForecastEvaluationPanel />
            </div>
          </details>
          <details onToggle={event => { if (event.currentTarget.open) setLocalToolsMounted(true); }} className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Herramientas avanzadas de demostración local</summary>{localToolsMounted && <div className="mt-4"><MlTestControlPanel /></div>}</details>
        </section>}
      </ForecastMlUpdatePanel>}
      {tab === 'inventory' && <section id="intelligence-panel-inventory" role="tabpanel" aria-labelledby="intelligence-tab-inventory" tabIndex={0} className="mt-4 space-y-5">
        <div><h2 className="text-xl font-semibold">Inventario operativo</h2><p className="text-sm text-muted-foreground">Resumen de existencias, prioridades y reglas de reposición.</p></div>
        {inventoryError && <ErrorPanel message="No se pudo cargar el inventario." retry={() => void loadInventory(true)} />}
        {inventoryState === 'loading' && <LoadingDetail label="Cargando inventario…" />}
        {inventory && <>
          <section aria-label="Resumen operativo de inventario" className="space-y-2">
            <h3 className="text-sm font-semibold">Resumen operativo</h3>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <ExecutiveMetric title="Stock bajo" value={safeNumber(inventory.summary.lowStockCount)} />
              <ExecutiveMetric title="Productos a reponer" value={inventory.summary.reorderCount != null ? safeNumber(inventory.summary.reorderCount) : partialReorderCountAvailable ? safeNumber(reorderCountEvaluable) : 'No disponible'} hint={inventory.summary.reorderCount == null
                ? partialReorderCountAvailable && reorderDecisionUnavailableCount != null
                  ? `${safeNumber(reorderCountEvaluable)} de ${safeNumber(reorderEvaluableCount)} productos evaluables · ${safeNumber(reorderDecisionUnavailableCount)} sin decisión de reposición.`
                  : 'Conteo global no disponible; el ranking conserva el análisis por producto.'
                : undefined} />
              <ExecutiveMetric title="Compras pendientes" value={safeNumber(summary?.inventory.pendingPurchasesCount)} />
              <Card className="min-w-0"><CardContent className="px-4 py-3.5"><p className="text-xs font-medium text-muted-foreground">Riesgo crítico / alto</p>
                <p className="mt-2 break-words text-2xl font-semibold tracking-tight">{riskCriticalHighTotal == null ? 'No disponible' : `${safeNumber(riskCriticalHighTotal)} productos`}</p>
                <p className="mt-1 text-xs text-muted-foreground">{typeof riskCriticalCount === 'number' && typeof riskHighCount === 'number' ? `${safeNumber(riskCriticalCount)} críticos · ${safeNumber(riskHighCount)} altos` : 'No están disponibles ambos conteos.'}</p>
                {riskEvaluableCount != null && inventory.summary.totalProducts != null && <p className="mt-1 text-xs text-muted-foreground">{safeNumber(riskEvaluableCount)} de {safeNumber(inventory.summary.totalProducts)} productos evaluables{riskUnavailableCount != null ? ` · ${safeNumber(riskUnavailableCount)} sin riesgo calculable` : ''}.</p>}
              </CardContent></Card>
            </div>
          </section>
        </>}
        <InventoryImpactDetailCard impact={inventoryImpact} />
        <Card><CardContent className="p-3 sm:p-4"><ProductSearchPicker id="intelligence-inventory-product-search" selected={selected} onSelect={chooseProduct} />{!selected && inventory && <p className="mt-2 text-xs text-muted-foreground">Selecciona un producto del buscador o del ranking para ver su detalle.</p>}</CardContent></Card>
        {inventory && <section aria-label="Panorama de inventario" className="space-y-2">
          <div><h3 className="text-lg font-semibold">Panorama de inventario</h3><p className="text-xs text-muted-foreground">Distribución de riesgo y clasificación descriptiva de estabilidad.</p></div>
          {inventory.availabilityStatus === 'PARTIAL' && <p role="status" className="text-xs text-muted-foreground">Análisis parcial: los valores sin evidencia suficiente permanecen como no disponibles.</p>}
          <div className="grid items-stretch gap-3 lg:grid-cols-2">
            <Card className="h-full min-w-0"><CardHeader className="pb-1"><CardTitle className="text-base">Distribución de riesgo</CardTitle><CardDescription>{safeNumber(inventory.summary.totalProducts)} productos analizados</CardDescription></CardHeader><CardContent className="space-y-1 pt-0 pb-3">
              {riskDistributionRows.length > 0 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{riskDistributionRows.map(row => <div key={row.key} className="rounded-md border p-2"><RiskBadge risk={riskKeyLevels[row.key]} /><p className="mt-1 text-lg font-semibold">{safeNumber(row.value)}</p></div>)}</div>}
              {(riskUnavailableCount != null && riskUnavailableCount > 0) || (riskEvaluableCount != null && inventory.summary.totalProducts != null) ? <div role="status" className="space-y-1 text-xs text-muted-foreground">
                {riskEvaluableCount != null && inventory.summary.totalProducts != null && <p>Distribución parcial sobre {safeNumber(riskEvaluableCount)} de {safeNumber(inventory.summary.totalProducts)} productos evaluables.</p>}
                {riskUnavailableCount != null && riskUnavailableCount > 0 && <p>{safeNumber(riskUnavailableCount)} {riskUnavailableCount === 1 ? 'producto sin riesgo calculable' : 'productos sin riesgo calculable'}</p>}
                {riskUnavailableCount == null && (riskEvaluableCount == null || inventory.summary.totalProducts == null) && <p>Distribución parcial; cantidad sin riesgo calculable no disponible.</p>}
              </div> : riskDistributionRows.length === 0 && <p role="status" className="text-xs text-muted-foreground">No hay conteos evaluables disponibles.</p>}
            </CardContent></Card>
            <Card className="h-full min-w-0"><CardHeader className="pb-2"><CardTitle className="text-base">Estabilidad de demanda (XYZ)</CardTitle><CardDescription>Clasificación descriptiva; no es un pronóstico.</CardDescription></CardHeader><CardContent><ClassificationChart title="Distribución XYZ" compact counts={inventory.summary.xyzCounts} colors={{ X: '#16a34a', Y: '#84cc16', Z: '#facc15', UNCLASSIFIED: '#94a3b8' }} requiredLabels={['X', 'Y', 'Z', 'UNCLASSIFIED']} help="X indica demanda estable, Y variable y Z irregular." /></CardContent></Card>
          </div>
        </section>}
        {inventory && <RankingTable rows={inventory.items} onSelect={selectFromRanking} />}
        {selected && detailState === 'loading' && <LoadingDetail label="Cargando detalle del producto…" />}
        {selected && detailError && <ErrorPanel retry={() => { apiClient.invalidateIntelligenceReads(); setDetailError(false); setDetailRetry(value => value + 1); }} />}
        {selected && detailState === 'ready' && productInventory && <ProductInventoryPanel inventory={productInventory} />}
      </section>}
      {(['sales', 'customers', 'suppliers', 'related', 'health'] as const).includes(tab as ExtendedTab) && <section id={`intelligence-panel-${tab}`} role="tabpanel" aria-labelledby={`intelligence-tab-${tab}`} tabIndex={0} className="mt-4"><ExtendedAnalyticsPanel tab={tab as ExtendedTab} inventory={inventory} /></section>}
      </AnalyticsErrorBoundary>
    </div>
  </div>;
}

function EmptyProductState() { return <div className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground"><PackageSearch className="h-5 w-5 shrink-0" aria-hidden="true" /><p>Elige un producto para ver sus pronósticos Ridge de 7 y 14 días.</p></div>; }
function ClassificationChart({ title, counts, colors, help, compact = false, requiredLabels }: { title: string; counts?: Record<string, number> | null; colors: Record<string, string>; help: string; compact?: boolean; requiredLabels?: string[] }) {
  const data = counts ? Object.entries(counts).map(([key, value]) => ({ name: key, value })) : [];
  const labels = requiredLabels?.map(label => ({ name: label, value: counts && typeof counts[label] === 'number' ? counts[label] : null }));
  return <section><h3 className={`mb-2 flex items-center gap-1 text-sm font-medium ${compact ? 'sr-only' : ''}`}>{title}<MetricInfo label={title}>{help}</MetricInfo></h3>{data.length ? <><div className={compact ? 'h-32' : 'h-40'} role="img" aria-label={`${title}: ${data.map(row => `${row.name}, ${safeNumber(row.value)}`).join('; ')}`}><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 6, right: 12, left: -18, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip formatter={value => [`${safeNumber(Number(value))} productos`, title]} /><Bar dataKey="value" name="Productos" radius={[5, 5, 0, 0]}>{data.map(row => <Cell key={row.name} fill={colors[row.name] || '#64748b'} />)}</Bar></BarChart></ResponsiveContainer></div><p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{labels ? labels.map(row => <span key={row.name}>{row.name}: {row.value == null ? 'No disponible' : safeNumber(row.value)}</span>) : data.map(row => <span key={row.name}>{row.name}: {safeNumber(row.value)}</span>)}</p></> : <p className="text-sm text-muted-foreground">Clasificación no disponible en este contrato.</p>}</section>;
}
function LoadingDetail({ label }: { label: string }) { return <Card role="status"><CardContent className="flex min-h-40 items-center justify-center gap-3 p-6"><Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />{label}</CardContent></Card>; }
function RankingTable({ rows, onSelect }: { rows: InventorySummary['items']; onSelect: (row: InventorySummary['items'][number]) => void }) {
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? rows : rows.slice(0, 8);
  return <Card><CardHeader className="pb-2"><CardTitle className="text-base">Productos que requieren atención</CardTitle><CardDescription>Prioridad recibida del análisis; conserva el orden del sistema.</CardDescription></CardHeader><CardContent className="space-y-2">{visibleRows.length ? <>
    <div className="hidden md:block"><table className="w-full table-fixed text-sm"><caption className="sr-only">Productos priorizados por el ranking de inventario</caption><colgroup><col className="w-[42%]" /><col className="w-[12%]" /><col className="w-[16%]" /><col className="w-[14%]" /><col className="w-[16%]" /></colgroup><thead><tr className="border-b text-left text-muted-foreground">{['Producto', 'Stock', 'Cobertura', 'Riesgo', 'Acción'].map(label => <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{visibleRows.map(row => <tr key={row.sku} className="border-b last:border-0"><td className="px-2 py-2"><button type="button" onClick={() => onSelect(row)} className="max-w-full text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="block truncate">{row.productName}</span><span className="block truncate text-xs font-normal text-muted-foreground">{row.sku}</span></button></td><td className="px-2 py-2">{safeNumber(row.stock)}</td><td className="px-2 py-2">{row.coverageDays === null ? 'No disponible' : `${safeNumber(row.coverageDays, 1)} días`}</td><td className="px-2 py-2"><RiskBadge risk={row.risk} /></td><td className="px-2 py-2">{row.reorderNow === null ? 'No disponible' : row.reorderNow ? 'Reponer ahora' : 'Sin urgencia'}</td></tr>)}</tbody></table></div>
    <ul className="space-y-2 md:hidden">{visibleRows.map(row => <li key={row.sku} className="rounded-md border p-3"><button type="button" onClick={() => onSelect(row)} className="text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row.productName}<span className="block text-xs font-normal text-muted-foreground">{row.sku}</span></button><dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm"><div><dt className="text-xs text-muted-foreground">Stock</dt><dd>{safeNumber(row.stock)}</dd></div><div><dt className="text-xs text-muted-foreground">Cobertura</dt><dd>{row.coverageDays === null ? 'No disponible' : `${safeNumber(row.coverageDays, 1)} días`}</dd></div><div><dt className="text-xs text-muted-foreground">Riesgo</dt><dd><RiskBadge risk={row.risk} /></dd></div><div><dt className="text-xs text-muted-foreground">Acción</dt><dd>{row.reorderNow === null ? 'No disponible' : row.reorderNow ? 'Reponer ahora' : 'Sin urgencia'}</dd></div></dl></li>)}</ul>
    {rows.length > 8 && <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => setShowAll(value => !value)}>{showAll ? 'Mostrar solo los 8 prioritarios' : 'Ver ranking completo →'}</Button>}
    </> : <p className="py-3 text-sm text-muted-foreground">No hay productos para mostrar en el ranking.</p>}</CardContent></Card>;
}
function SummaryRanking({ rows, onSelect, onViewAll }: { rows: InventorySummary['items']; onSelect: (row: InventorySummary['items'][number]) => void; onViewAll: () => void }) {
  return <Card><CardContent className="p-3 sm:p-4">{rows.length ? <>
    <div className="hidden md:block"><table className="w-full table-fixed text-sm"><caption className="sr-only">Hasta ocho productos priorizados por el ranking de inventario</caption><colgroup><col className="w-[42%]" /><col className="w-[12%]" /><col className="w-[16%]" /><col className="w-[14%]" /><col className="w-[16%]" /></colgroup><thead><tr className="border-b text-left text-muted-foreground">{['Producto', 'Stock', 'Cobertura', 'Riesgo', 'Acción'].map(label => <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.sku} className="border-b last:border-0"><td className="px-2 py-2"><button type="button" onClick={() => onSelect(row)} className="max-w-full text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="block truncate">{row.productName}</span><span className="block truncate text-xs font-normal text-muted-foreground">{row.sku}</span></button></td><td className="px-2 py-2">{safeNumber(row.stock)}</td><td className="px-2 py-2">{row.coverageDays === null ? 'No disponible' : `${safeNumber(row.coverageDays, 1)} días`}</td><td className="px-2 py-2"><RiskBadge risk={row.risk} /></td><td className="px-2 py-2">{row.reorderNow === null ? 'No disponible' : row.reorderNow ? 'Reponer ahora' : 'Sin urgencia'}</td></tr>)}</tbody></table></div>
    <ul className="space-y-2 md:hidden">{rows.map(row => <li key={row.sku} className="rounded-lg border p-3"><button type="button" onClick={() => onSelect(row)} className="text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row.productName}<span className="block text-xs font-normal text-muted-foreground">{row.sku}</span></button><dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm"><div><dt className="text-xs text-muted-foreground">Stock</dt><dd>{safeNumber(row.stock)}</dd></div><div><dt className="text-xs text-muted-foreground">Cobertura</dt><dd>{row.coverageDays === null ? 'No disponible' : `${safeNumber(row.coverageDays, 1)} días`}</dd></div><div><dt className="text-xs text-muted-foreground">Riesgo</dt><dd><RiskBadge risk={row.risk} /></dd></div><div><dt className="text-xs text-muted-foreground">Acción</dt><dd>{row.reorderNow === null ? 'No disponible' : row.reorderNow ? 'Reponer ahora' : 'Sin urgencia'}</dd></div></dl></li>)}</ul>
    </> : <p className="py-3 text-sm text-muted-foreground">No hay productos para mostrar en el ranking.</p>}<Button type="button" variant="link" size="sm" className="mt-2 h-auto px-0" onClick={onViewAll}>Ver todos los productos en Inventario →</Button></CardContent></Card>;
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
  const operationalCards: Array<[string, string]> = [
    ['Stock actual', safeNumber(inventory.stock.onHand)], ['Entrante', safeNumber(inventory.stock.incoming)],
    ['Posición de inventario', safeNumber(inventory.stock.inventoryPosition)],
  ];
  const explanation = inventory.risk.level === 'CRITICAL' || inventory.risk.level === 'HIGH' ? 'El producto presenta riesgo elevado de quiebre.' : inventory.coverage.daysCover !== null ? `Stock suficiente para aproximadamente ${safeNumber(inventory.coverage.daysCover, 1)} días.` : 'La cobertura no está disponible.';
  const action = inventory.recommendation.reorderNow === true ? 'Se recomienda reposición inmediata.' : hasPreventiveQuantity ? 'No se recomienda reposición inmediata; la cantidad mostrada es una referencia para completar el nivel objetivo.' : inventory.recommendation.reorderNow === false ? 'No se recomienda reposición inmediata.' : 'La recomendación de reposición no está disponible.';
  const partialReason = inventory.recommendation.reasonCode === 'UNSUPPORTED_LEAD_TIME'
    ? 'No hay un horizonte ML aprobado para este plazo.'
    : inventory.recommendation.reasonCode || inventory.risk.reasonCode
      ? 'Pronóstico insuficiente para este cálculo.' : null;
  return <div className="space-y-3"><div><h2 className="text-lg font-semibold">{inventory.product.name || inventory.product.sku}</h2><p className="text-xs text-muted-foreground">{inventory.product.presentation || 'Presentación no especificada'} · SKU: {inventory.product.sku} · {freshnessLine(inventory.freshness)}</p></div>
    <section aria-label="Ridge directo" className="rounded-lg border p-3"><div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ridge directo</h3><Badge variant="outline">ML acumulado · LIVE</Badge></div><div className="grid gap-2 sm:grid-cols-2"><MetricCard title="P7 · Demanda acumulada en 7 días" value={inventory.demand.expectedUnitsNext7d == null ? 'No disponible' : `${safeNumber(inventory.demand.expectedUnitsNext7d, 2)} unidades`} /><MetricCard title="P14 · Demanda acumulada en 14 días" value={inventory.demand.expectedUnitsNext14d == null ? 'No disponible' : `${safeNumber(inventory.demand.expectedUnitsNext14d, 2)} unidades`} /></div></section>
    <section aria-label="Operativo" className="rounded-lg border p-3"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Operativo</h3><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{operationalCards.map(([title, value]) => <MetricCard key={title} title={title} value={value} />)}</div></section>
    <section aria-label="Reglas" className="rounded-lg border p-3"><div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reglas derivadas</h3><Badge variant="outline">Política con Ridge</Badge></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      <MetricCard title="Cobertura" value={inventory.coverage.daysCover === null ? 'No disponible' : `${safeNumber(inventory.coverage.daysCover, 1)} días`} help="Estimación de política usando la tasa aproximada derivada de los horizontes Ridge 7/14." />
      <MetricCard title="Riesgo" value={inventory.risk.level ? riskLabels[inventory.risk.level] : 'No disponible'} />
      <MetricCard title="Stock bajo" value={inventory.risk.lowStock == null ? 'No disponible' : inventory.risk.lowStock ? 'Sí' : 'No'} />
      <MetricCard title="Stock de seguridad" value={safeNumber(policy.safetyStock)} help="Reserva heurística existente; requiere historial observable y variabilidad de entrega." />
      <MetricCard title="Punto de reorden" value={safeNumber(policy.reorderPoint)} help="Referencia operativa disponible cuando la demanda del plazo de entrega está respaldada." />
      <MetricCard title="Reponer ahora" value={inventory.recommendation.reorderNow == null ? 'No disponible' : inventory.recommendation.reorderNow ? 'Sí' : 'No'} />
      <MetricCard title={quantityLabel} value={inventory.recommendation.recommendedQty === null ? 'No disponible' : `${safeNumber(inventory.recommendation.recommendedQty)} unidades`} />
      <MetricCard title="Tasa diaria derivada" value={inventory.demand.expectedDaily === null ? 'No disponible' : `${safeNumber(inventory.demand.expectedDaily, 2)} unidades`} help="Tasa operativa derivada de Ridge acumulado a 7 y 14 días; no es un pronóstico ML de 1 día." />
      <MetricCard title="Estado de cobertura" value={inventory.coverage.status || 'No disponible'} />
    </div>
      <p className="mt-2 text-xs text-muted-foreground">{explanation} {action}{inventory.recommendation.recommendedQty != null ? ` Cantidad para el nivel objetivo: ${safeNumber(inventory.recommendation.recommendedQty)} unidades.` : ''}</p>
      {partialReason && <p role="status" className="mt-1 text-xs text-muted-foreground">{partialReason}</p>}
      {inventory.recommendation.preventiveRecommendation === true && <p className="mt-1 text-xs text-muted-foreground">Reposición preventiva sugerida</p>}
    </section>
    <section aria-label="Clasificación" className="rounded-lg border p-3"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Clasificación descriptiva</h3><div className="flex flex-wrap gap-2">{hasClassifiedAbc && <Badge variant="outline"><MetricLabel label={`ABC: ${inventory.classification.abc}`} help="ABC clasifica la importancia económica: A alta, B intermedia y C menor." /></Badge>}<Badge variant="outline"><MetricLabel label={`XYZ: ${inventory.classification.xyz || 'No disponible'}`} help="XYZ describe la estabilidad de la demanda: X estable, Y variable y Z irregular." /></Badge></div></section></div>;
}
