'use client';

import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type {
  AssociationsAnalytics, BusinessHealthAnalytics, CustomerAnalyticsDetail, CustomersAnalytics,
  InventorySummary, RelatedProductAnalytics, SalesAnalytics, SalesPeriod, SupplierAnalyticsDetail, SuppliersAnalytics,
} from '@/types/businessIntelligence';
import { ChartCard, MetricInfo, MetricLabel } from './MetricInfo';
import { CustomerClusteringPanel } from './CustomerClusteringPanel';
import { SalesAnomalyPanel } from './SalesAnomalyPanel';
import { MethodologyCard } from './MethodologyCard';
import { AnalyticsErrorBoundary } from './AnalyticsErrorBoundary';

export type ExtendedTab = 'sales' | 'customers' | 'suppliers' | 'related' | 'health';
type LoadStatus = 'loading' | 'ready' | 'error';
type AnalyticsData = SalesAnalytics | CustomersAnalytics | SuppliersAnalytics | AssociationsAnalytics | BusinessHealthAnalytics;
const domainLabels: Record<string, string> = { sales: 'Ventas', margin: 'Margen', customers: 'Clientes', inventory: 'Inventario', suppliers: 'Proveedores', forecast: 'Pronóstico', marketBasket: 'Productos relacionados' };
const statusLabels: Record<string, string> = { READY: 'Disponible', PARTIAL: 'Parcial', UNAVAILABLE: 'No disponible', COLD_START: 'Sin historial suficiente', INSUFFICIENT_HISTORY: 'Historial insuficiente', NOT_AVAILABLE: 'No disponible', FROZEN: 'Histórico hasta 12 oct. 2026', LIVE: 'Actualizado con datos operativos', AVAILABLE: 'Disponible', NOT_REQUESTED: 'No solicitado' };
const healthMetricLabels: Record<string, string> = {
  CUSTOMER_AT_RISK_COUNT: 'Clientes en riesgo', customerAtRiskCount: 'Clientes en riesgo', customersAtRisk: 'Clientes en riesgo',
  grossMarginCents: 'Margen bruto', grossMargin: 'Margen bruto', grossMarginPct: 'Margen bruto (%)',
  criticalInventoryExposure: 'Productos con riesgo crítico', criticalInventoryCount: 'Productos con riesgo crítico',
  revenueCents: 'Ingresos', revenue: 'Ingresos', unitsSold: 'Unidades vendidas', ticketCount: 'Tickets',
  pendingPurchaseCount: 'Compras pendientes', reorderCount: 'Productos a reponer', inventoryValueCents: 'Valor del inventario',
  averageTicketCents: 'Ticket promedio', forecastSource: 'Método de pronóstico', anomalyCount: 'Días con comportamiento atípico',
  marketBasketRuleCount: 'Reglas de asociación disponibles',
  kpis: 'Indicadores principales', segmentDistribution: 'Distribución de clientes', atRiskCount: 'Clientes en riesgo',
  inactiveCount: 'Clientes inactivos', cogsCents: 'Costo de ventas', products: 'Productos', analyzedCount: 'Productos analizados',
  unavailableCount: 'Productos sin análisis', summary: 'Resumen', topSpendShares: 'Participación principal del gasto',
  available: 'Disponible', analysisVersion: 'Versión del análisis', stableCrossSellRuleCount: 'Reglas estables de venta cruzada',
  horizons: 'Horizontes disponibles', source: 'Método de pronóstico', critical: 'Productos críticos', high: 'Productos con riesgo alto',
  medium: 'Productos con riesgo medio', low: 'Productos con riesgo bajo', total: 'Total', suppliers: 'Proveedores',
  customers: 'Clientes', activeCount: 'Clientes activos', newCount: 'Clientes nuevos', totalRegistered: 'Clientes registrados',
  revenueShare: 'Participación de ingresos', purchaseSpendCents: 'Gasto en compras', pendingOrders: 'Pedidos pendientes',
  receivedOrders: 'Pedidos recibidos', skuCount: 'Productos', singleSourceSkuCount: 'Productos con una sola fuente',
};
const segmentLabels: Record<string, string> = { HIGH_VALUE: 'Alto valor', POTENTIAL: 'Potencial', NEW: 'Nuevo', AT_RISK: 'En riesgo', INACTIVE: 'Inactivo', ACTIVE: 'Activo', LOYAL: 'Fiel', CHAMPION: 'Cliente frecuente', PROMISING: 'Prometedor', NEEDS_ATTENTION: 'Requiere atención', HIBERNATING: 'Inactivo reciente' };
const chartColors = ['#2563eb', '#0f766e', '#7c3aed', '#d97706', '#db2777', '#0891b2', '#65a30d'];

function errorLabel(error: unknown): string {
  const value = error as { response?: { status?: number; data?: { code?: string } } };
  const status = value?.response?.status;
  const code = value?.response?.data?.code;
  if (status === 401 || status === 403) return 'La sesión no tiene acceso a esta analítica. Vuelve a iniciar sesión si corresponde.';
  if (status === 404) return `No se encontró la entidad solicitada${code ? ` (${code})` : ''}.`;
  if (status === 422 || code === 'INSUFFICIENT_HISTORY') return 'El historial disponible no es suficiente para esta consulta.';
  if (status === 503) return 'La analítica no está disponible temporalmente. No se sustituyeron los datos por valores históricos.';
  return `No se pudo cargar la consulta${code ? ` (${code})` : ''}.`;
}
function numberText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : 'No disponible';
}
function moneyText(value: { value: number | null; currency: string | null } | null | undefined): string {
  if (value?.value == null || !value.currency || !Number.isFinite(value.value)) return 'No disponible';
  try { return new Intl.NumberFormat('es-PE', { style: 'currency', currency: value.currency }).format(value.value); }
  catch { return 'No disponible'; }
}
function percentText(value: number | null | undefined): string { return typeof value === 'number' && Number.isFinite(value) ? `${numberText(value * 100)}%` : 'No disponible'; }
function dateText(value: string | null | undefined): string {
  if (!value) return 'No disponible';
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'America/Lima' }).format(date);
}
function statusText(value: string | null | undefined): string { return value ? statusLabels[value] || value.replace(/_/g, ' ').toLowerCase() : 'No disponible'; }
function healthMetricLabel(key: string): string {
  return healthMetricLabels[key] || segmentLabels[key] || 'Indicador adicional';
}
function healthMetricValue(key: string, value: unknown): string {
  if (key === 'horizons' && Array.isArray(value)) {
    const horizons = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0);
    return horizons.length ? horizons.map(day => `${day} ${day === 1 ? 'día' : 'días'}`).join(' · ') : 'No disponible';
  }
  if (Array.isArray(value)) {
    if (key === 'topSpendShares') return value.map(row => row && typeof row === 'object' && numeric(row.sharePct) !== null
      ? `${numberText(row.sharePct)}%` : null).filter(Boolean).join(' · ') || 'No disponible';
    return value.length ? `${value.length} registros` : 'Sin registros';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (key.toLowerCase().includes('cents')) return moneyText({ value: value / 100, currency: 'PEN' });
    if (key.toLowerCase().includes('pct') && value >= 0 && value <= 1) return percentText(value);
    return numberText(value);
  }
  if (typeof value === 'string') return value === 'MOVING_AVERAGE_28' ? 'Media móvil de 28 días' : statusLabels[value] || value;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return 'No disponible';
}
function healthEntries(metrics: Record<string, unknown>, parent = '', depth = 0): Array<{ label: string; value: string }> {
  return Object.entries(metrics).flatMap(([key, value]) => {
    const label = [parent, healthMetricLabel(key)].filter(Boolean).join(' · ');
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 3)
      return healthEntries(value as Record<string, unknown>, label, depth + 1);
    return [{ label, value: healthMetricValue(key, value) }];
  }).slice(0, 12);
}
function insightText(value: Record<string, unknown>): string | null {
  const text = value.message || value.summary || value.text;
  if (typeof text !== 'string' || !text.trim()) return null;
  const labels: Record<string, string> = {
    SALES_DOWN_VS_PREVIOUS_PERIOD: 'Los ingresos disminuyeron al menos un 10% frente al período anterior equivalente.',
    MARGIN_DOWN: 'El margen bruto disminuyó al menos un 10% frente al período anterior equivalente; no representa utilidad neta.',
    CUSTOMER_AT_RISK_COUNT: 'Hay clientes que cumplen las reglas observadas de riesgo; esto no es una probabilidad de abandono.',
    CRITICAL_STOCK_COUNT: 'El inventario contiene productos con riesgo crítico de stock.',
    OVERSTOCK_VALUE: 'Hay valor estimado de inventario excedente según las reglas operativas; no representa deterioro contable.',
    HIGH_SUPPLIER_DEPENDENCY: 'Una parte importante del gasto recibido se concentra en un proveedor.',
    SINGLE_SOURCE_INVENTORY_EXPOSURE: 'Hay productos de riesgo alto o crítico con una sola oferta de proveedor configurada.',
    CROSS_SELL_OPPORTUNITIES: 'Hay asociaciones históricas estables entre categorías; describen coocurrencias, no efectos causales.',
  };
  return typeof value.code === 'string' && labels[value.code] ? labels[value.code] : text;
}
function numeric(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function chartNumeric(value: unknown): number | null {
  return value == null || value === '' ? null : numeric(typeof value === 'string' ? Number(value) : value);
}
function basketNames(products: Array<string | Record<string, unknown>>, skus: string[]): string {
  return products.map(item => typeof item === 'string' ? item : String(item.name || item.productName || item.sku || '')).filter(Boolean).join(', ') || skus.join(', ');
}
function objectNumber(value: unknown, keys: string[]): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  for (const key of keys) if (typeof object[key] === 'number' && Number.isFinite(object[key])) return object[key] as number;
  return null;
}
function DataState({ status, message, onRetry }: { status: LoadStatus; message: string; onRetry: () => void }) {
  if (status === 'loading') return <p role="status" className="text-sm text-muted-foreground">Cargando analítica…</p>;
  if (status === 'error') return <div role="alert" className="space-y-2 text-sm"><p>{message}</p><Button variant="outline" size="sm" onClick={onRetry}>Reintentar</Button></div>;
  return null;
}
function PeriodSelect({ value, onChange }: { value: SalesPeriod; onChange: (value: SalesPeriod) => void }) {
  return <label className="flex items-center gap-2 text-sm">Período<select aria-label="Período" className="rounded-md border bg-background px-2 py-1.5" value={value} onChange={event => onChange(event.target.value as SalesPeriod)}>
    <option value="TODAY">Hoy</option><option value="LAST_7_DAYS">7 días</option><option value="LAST_30_DAYS">30 días</option>
  </select></label>;
}
function Table({ headers, rows, empty }: { headers: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{empty}</p>;
  return <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-max text-sm"><thead><tr className="bg-muted/50 text-left text-muted-foreground">{headers.map(header => <th scope="col" key={header} className="px-3 py-2 font-medium">{header}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index} className="border-t last:border-0">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top">{cell}</td>)}</tr>)}</tbody></table></div>;
}
function Kpi({ label, value, help }: { label: string; value: string; help?: React.ReactNode }) {
  return <div className="min-w-0 rounded-xl border bg-card p-3 shadow-sm"><div className="text-xs text-muted-foreground"><MetricLabel label={label} help={help} /></div><p className="mt-1 break-words text-lg font-semibold">{value}</p></div>;
}

export function ExtendedAnalyticsPanel({ tab, inventory }: { tab: ExtendedTab; inventory: InventorySummary | null }) {
  return <AnalyticsErrorBoundary key={tab} label={(domainLabels[tab] || 'Productos relacionados').toLocaleLowerCase('es-PE')}><ExtendedAnalyticsContent tab={tab} inventory={inventory} /></AnalyticsErrorBoundary>;
}

function ExtendedAnalyticsContent({ tab, inventory }: { tab: ExtendedTab; inventory: InventorySummary | null }) {
  const [period, setPeriod] = useState<SalesPeriod>('TODAY');
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [message, setMessage] = useState('');
  const [rawData, setData] = useState<AnalyticsData | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [reload, setReload] = useState(0);
  const [customerDetail, setCustomerDetail] = useState<CustomerAnalyticsDetail | null>(null);
  const [supplierDetail, setSupplierDetail] = useState<SupplierAnalyticsDetail | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<{ kind: 'customer' | 'supplier'; ref: string } | null>(null);
  const [detailMessage, setDetailMessage] = useState('');
  const [detailStatus, setDetailStatus] = useState<LoadStatus>('ready');
  const [sku, setSku] = useState('');
  const [related, setRelated] = useState<RelatedProductAnalytics | null>(null);
  const [relatedStatus, setRelatedStatus] = useState<LoadStatus>('ready');
  const [relatedMessage, setRelatedMessage] = useState('');
  const requestKey = `${tab}:${period}:${reload}`;
  const currentKey = useRef(requestKey); currentKey.current = requestKey;
  const detailRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const data = loadedKey === requestKey ? rawData : null;

  useEffect(() => {
    let current = true;
    setStatus('loading'); setMessage(''); setData(null); setCustomerDetail(null); setSupplierDetail(null);
    setDetailStatus('ready'); setDetailMessage(''); setSelectedDetail(null); detailRequest.current++;
    const request = tab === 'sales' ? apiClient.getSalesAnalytics({ period, includeSeries: true, compare: true, limit: 10 })
      : tab === 'customers' ? apiClient.getCustomersAnalytics({ limit: 20, offset: 0 })
      : tab === 'suppliers' ? apiClient.getSuppliersAnalytics({ period, limit: 20, offset: 0 })
      : tab === 'related' ? apiClient.getAssociations({ limit: 10, offset: 0 })
      : apiClient.getBusinessHealth({ period, limit: 5 });
    void request.then(response => {
      if (!current) return;
      if (!response.success || !response.data) throw new Error('No se recibió un contrato de analítica.');
      if (tab === 'suppliers' && (!response.data || !('summary' in response.data) || !response.data.summary || !('items' in response.data) || !Array.isArray(response.data.items))) throw new Error('Invalid supplier contract');
      setData(response.data as AnalyticsData); setLoadedKey(requestKey); setStatus('ready');
    }).catch(error => { if (current) { setData(null); setLoadedKey(requestKey); setMessage(errorLabel(error)); setStatus('error'); } });
    return () => { current = false; };
  }, [tab, period, reload, requestKey]);

  const selectedSku = sku || inventory?.items?.[0]?.sku || '';
  useEffect(() => {
    if (tab !== 'related' || !selectedSku) { setRelated(null); setRelatedStatus('ready'); return; }
    let current = true;
    setRelatedStatus('loading'); setRelatedMessage(''); setRelated(null);
    void apiClient.getRelatedProducts(selectedSku).then(response => {
      if (!current) return;
      if (!response.success || !response.data) throw new Error('No se recibió un contrato de recomendaciones.');
      setRelated(response.data); setRelatedStatus('ready');
    }).catch(error => { if (current) { setRelated(null); setRelatedMessage(errorLabel(error)); setRelatedStatus('error'); } });
    return () => { current = false; };
  }, [tab, selectedSku, reload]);

  const openDetail = async (kind: 'customer' | 'supplier', ref: string) => {
    const id = ++detailRequest.current, key = requestKey;
    const current = () => mounted.current && detailRequest.current === id && currentKey.current === key;
    setSelectedDetail({ kind, ref }); setDetailStatus('loading'); setDetailMessage(''); setCustomerDetail(null); setSupplierDetail(null);
    try {
      if (kind === 'customer') {
        const response = await apiClient.getCustomerAnalytics(ref);
        if (!current()) return;
        if (!response.success || !response.data) throw new Error('No se recibió el detalle del cliente.');
        setCustomerDetail(response.data);
      } else {
        const response = await apiClient.getSupplierAnalytics(ref);
        if (!current()) return;
        if (!response.success || !response.data?.item) throw new Error('No se recibió el detalle del proveedor.');
        setSupplierDetail(response.data);
      }
      setDetailStatus('ready');
    } catch (error) { if (current()) { setDetailMessage(errorLabel(error)); setDetailStatus('error'); } }
  };
  const retry = () => setReload(value => value + 1);
  const retryDetail = () => { if (selectedDetail) void openDetail(selectedDetail.kind, selectedDetail.ref); };
  const freshness = data && 'mode' in data ? `${data.mode === 'LIVE' ? 'Actualizado con datos operativos' : 'Histórico hasta 12 oct. 2026'}${data.dataThrough ? ` · Datos hasta ${dateText(data.dataThrough)}` : ''}` : null;

  if (tab === 'related') {
    const source = data && 'cutoff' in data ? data as AssociationsAnalytics : null;
    const basket = source ? { ...source, items: (Array.isArray(source.items) ? source.items : []).map(rule => ({ ...rule,
      antecedent: Array.isArray(rule.antecedent) ? rule.antecedent : [], consequent: Array.isArray(rule.consequent) ? rule.consequent : [],
      antecedentProducts: Array.isArray(rule.antecedentProducts) ? rule.antecedentProducts : [],
      consequentProducts: Array.isArray(rule.consequentProducts) ? rule.consequentProducts : [] })) } : null;
    return <div className="space-y-4"><Card><CardHeader><CardTitle className="flex items-center gap-1">Análisis de cesta de compra <MetricInfo label="Market Basket">Analiza productos que aparecen juntos en los mismos tickets. Describe asociaciones estadísticas, no causa de compra.</MetricInfo></CardTitle><CardDescription>Datos históricos hasta 12 oct. 2026. Las asociaciones no se actualizan con las ventas de hoy.</CardDescription></CardHeader><CardContent className="space-y-4">
      <DataState status={status} message={message} onRetry={retry} />{basket && <><MethodologyCard algorithm="FP-Growth + reglas de asociación" learningType="Minería de patrones frecuentes" objective="Descubrir productos que coocurren en tickets históricos" explanation="FP-Growth comprime patrones frecuentes en una estructura eficiente y descubre conjuntos de productos que suelen coincidir en los tickets." summary={<>{basket.total} reglas · corte histórico {dateText(basket.cutoff)}</>} fields={[
        { label: 'Cómo funciona', value: 'Resume transacciones en patrones frecuentes y deriva reglas de asociación sin interpretar coocurrencia como causalidad.' },
        { label: 'Métricas', value: 'Support: proporción de tickets con la combinación. Confidence: proporción de tickets con A que también contienen B. Lift compara la frecuencia observada con la esperada bajo independencia.' },
        { label: 'Estado', value: `Histórico congelado (FROZEN) · cutoff ${basket.cutoff}; no se recalcula con ventas operativas.` },
        { label: 'Interpretación', value: 'Lift > 1 indica asociación positiva según el contrato; no demuestra que un producto cause la compra del otro.' },
      ]} /><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">Histórico congelado</Badge><span className="text-xs text-muted-foreground">Corte: {dateText(basket.cutoff)} · {basket.total} reglas disponibles</span></div><p className="text-xs text-muted-foreground">FROZEN · cutoff {basket.cutoff}</p>{basket.items.find(rule => rule.lift != null && rule.lift > 1) && <p className="rounded-md bg-muted/50 p-3 text-sm">Entre las reglas visibles hay una coocurrencia más frecuente que la esperada bajo independencia (lift &gt; 1). Es una asociación histórica, no una relación causal.</p>}
        {basket.items.length ? <div className="grid gap-3 xl:grid-cols-2">{basket.items.map((rule, index) => <article key={`${rule.antecedent.join('-')}-${rule.consequent.join('-')}-${index}`} className="rounded-xl border p-4"><p className="font-semibold leading-relaxed">{basketNames(rule.antecedentProducts, rule.antecedent)} <span aria-label="se asocia con" className="text-primary">→</span> {basketNames(rule.consequentProducts, rule.consequent)}</p><div className="mt-1 space-y-0.5 text-xs text-muted-foreground"><p>SKU: {rule.antecedent.join(', ')} → {rule.consequent.join(', ')}</p></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Kpi label="Soporte" value={percentText(rule.support)} help="Proporción de tickets donde aparece esta combinación." /><Kpi label="Confianza" value={percentText(rule.confidence)} help="De quienes compraron el producto A, qué proporción también compró B." /><Kpi label="Lift" value={numberText(rule.lift)} help="Compara la frecuencia observada con la esperada si los productos fueran independientes; no implica causalidad." /><Kpi label="Tickets" value={numberText(rule.ticketCount)} /></div><p className="mt-2 text-xs text-muted-foreground">Estabilidad: {statusText(rule.stability || rule.status)}</p></article>)}</div> : <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{basket.available ? 'No se encontraron reglas para mostrar.' : 'El análisis histórico no tiene reglas disponibles.'}</p>}
      </>}</CardContent></Card><Card><CardHeader><CardTitle>Productos relacionados</CardTitle><CardDescription>Recomendaciones de productos que aparecen en los mismos tickets. Se leen del análisis histórico aprobado.</CardDescription></CardHeader><CardContent className="space-y-4">
        {inventory?.items.length ? <label className="flex flex-wrap items-center gap-2 text-sm">Producto<select aria-label="Producto relacionado" className="max-w-full rounded-md border bg-background px-2 py-1.5" value={selectedSku} onChange={event => setSku(event.target.value)}>{inventory.items.map(item => <option key={item.sku} value={item.sku}>{item.productName} · SKU: {item.sku}</option>)}</select></label> : <p className="text-sm text-muted-foreground">No hay productos del ranking disponibles para consultar.</p>}
        <DataState status={relatedStatus} message={relatedMessage} onRetry={retry} />{related && <><p className="text-sm"><strong>{related.sourceProduct.name}</strong><span className="ml-2 text-xs text-muted-foreground">SKU: {related.sourceProduct.sku}</span></p><div className="flex items-center gap-2"><Badge variant="outline">Histórico congelado</Badge><span className="text-xs text-muted-foreground">Corte: {dateText(related.cutoff)}</span></div><p className="text-xs text-muted-foreground">FROZEN · cutoff {related.cutoff}</p>
          {related.items.length ? <div className="grid gap-3 md:grid-cols-2">{related.items.map((item, index) => <article key={`${item.relatedProduct.sku || item.relatedProduct.name}-${index}`} className="rounded-xl border p-4"><h3 className="font-semibold">{item.relatedProduct.name || 'Producto relacionado'}</h3><p className="text-xs text-muted-foreground">SKU: {item.relatedProduct.sku || 'No disponible'}</p><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Kpi label="Soporte" value={percentText(item.support)} help="Proporción de tickets donde aparecen juntos los productos." /><Kpi label="Confianza" value={percentText(item.confidence)} help="De los tickets con el producto elegido, proporción que también contiene este producto." /><Kpi label="Lift" value={numberText(item.lift)} help="Frecuencia de la asociación respecto de lo esperado por independencia estadística; no implica causalidad." /><Kpi label="Tickets" value={numberText(item.ticketCount)} /></div><p className="mt-2 text-xs text-muted-foreground">{item.lift != null && item.lift > 1 ? 'Asociación positiva observada; no implica causalidad.' : 'La métrica describe coocurrencia histórica, no causalidad.'}</p></article>)}</div> : <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{related.available ? 'No se encontraron asociaciones suficientes para este producto.' : 'El análisis histórico no tiene recomendaciones disponibles.'}</p>}
        </>}
      </CardContent></Card></div>;
  }

  const title: Record<Exclude<ExtendedTab, 'related'>, string> = { sales: 'Ventas', customers: 'Clientes', suppliers: 'Proveedores', health: 'Salud del negocio' };
  return <Card><CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3"><div><CardTitle>{title[tab]}</CardTitle><CardDescription>{freshness || 'Analítica del negocio'}</CardDescription></div>{['sales', 'suppliers', 'health'].includes(tab) && <PeriodSelect value={period} onChange={setPeriod} />}</CardHeader><CardContent className="space-y-5">
    <DataState status={loadedKey === requestKey ? status : 'loading'} message={message} onRetry={retry} />
    {tab === 'sales' && data && 'summary' in data && <SalesView data={data as SalesAnalytics} />}
    {tab === 'sales' && <SalesAnomalyPanel />}
    {tab === 'customers' && data && 'items' in data && <CustomersView data={data as CustomersAnalytics} detail={customerDetail} detailStatus={detailStatus} detailMessage={detailMessage} onSelect={ref => void openDetail('customer', ref)} onRetry={retryDetail} />}
    {tab === 'suppliers' && data && 'items' in data && <SuppliersView data={data as SuppliersAnalytics} detail={supplierDetail} detailStatus={detailStatus} detailMessage={detailMessage} onSelect={ref => void openDetail('supplier', ref)} onRetry={retryDetail} />}
    {tab === 'health' && data && 'domains' in data && <HealthView data={data as BusinessHealthAnalytics} />}
  </CardContent></Card>;
}

function SalesView({ data }: { data: SalesAnalytics }) {
  const values = data.summary;
  const series = data.series || [];
  const chartsReady = series.length > 1;
  const revenueData = series.map(point => ({ date: point.date, revenue: point.revenue?.value ?? null, tickets: point.tickets, units: point.units, status: statusText(point.status) }));
  const products = data.rankings.topProducts.map(row => ({ label: String(row.name || row.sku || 'Producto'), revenue: objectNumber(row.revenue, ['value']), units: objectNumber(row.units, ['value']) }));
  const categories = data.rankings.topCategories.map(row => ({ label: String(row.category || row.name || 'Categoría'), revenue: objectNumber(row.revenue, ['value']) }));
  return <div className="space-y-5"><p className="text-sm text-muted-foreground">Analítica descriptiva de ingresos, unidades, tickets y productos; estas métricas no implican un modelo de clasificación.</p><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
    <Kpi label="Ingresos" value={moneyText(values.revenue)} /><Kpi label="Unidades" value={numberText(values.units)} /><Kpi label="Tickets" value={numberText(values.tickets)} /><Kpi label="Ticket promedio" value={moneyText(values.averageTicket)} />
    <Kpi label="Margen bruto" value={moneyText(values.grossMargin)} help={values.grossMargin.availability === 'UNAVAILABLE' ? 'No hay costos suficientes para calcular el margen. No se sustituye por cero.' : 'Ingresos menos costo de productos vendidos.'} />
  </div>
    {values.revenue?.value === 0 && values.units === 0 && values.tickets === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No se registraron ventas en este período; los valores cero son resultados válidos.</p>}
    <p className="text-xs text-muted-foreground">{dateText(data.period.startDate)} – {dateText(data.period.endDate)} · Serie diaria: {statusText(data.seriesStatus)} · Margen: {statusText(data.grossMarginAvailability)}</p>
    {chartsReady ? <div className="grid gap-4 xl:grid-cols-2"><ChartCard title="Ingresos por día" description="Importe registrado en cada día del período."><div className="h-64"><ResponsiveContainer width="100%" height="100%"><LineChart data={revenueData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={date => String(date).slice(5)} minTickGap={24} /><YAxis tickFormatter={value => `S/ ${numberText(chartNumeric(value))}`} /><Tooltip labelFormatter={date => dateText(String(date))} formatter={(value, _name, item) => [value == null ? 'No disponible' : moneyText({ value: chartNumeric(value), currency: values.revenue?.currency || 'PEN' }), `Ingresos · ${item?.payload?.status || 'No disponible'}`]} /><Line dataKey="revenue" name="Ingresos" stroke="#2563eb" strokeWidth={2} connectNulls={false} dot={false} /></LineChart></ResponsiveContainer></div></ChartCard>
      <ChartCard title="Unidades vendidas por día"><div className="h-64"><ResponsiveContainer width="100%" height="100%"><LineChart data={revenueData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={date => String(date).slice(5)} minTickGap={24} /><YAxis allowDecimals={false} label={{ value: 'Unidades', angle: -90, position: 'insideLeft' }} /><Tooltip labelFormatter={date => dateText(String(date))} formatter={(value, _name, item) => [value == null ? 'No disponible' : `${numberText(chartNumeric(value))} unidades`, `Ventas · ${item?.payload?.status || 'No disponible'}`]} /><Line dataKey="units" name="Unidades" stroke="#0f766e" strokeWidth={2} connectNulls={false} dot={false} /></LineChart></ResponsiveContainer></div></ChartCard>
    </div> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No hay suficientes puntos diarios para mostrar una tendencia en este período.</p>}
    <div className="grid gap-4 xl:grid-cols-2">{products.some(row => row.revenue !== null) && <ChartCard title="Productos con más ingresos"><div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={products.filter(row => row.revenue !== null)} layout="vertical" margin={{ left: 12, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tickFormatter={value => `S/ ${numberText(chartNumeric(value))}`} /><YAxis type="category" dataKey="label" width={125} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [moneyText({ value: chartNumeric(value), currency: values.revenue?.currency || 'PEN' }), 'Ingresos']} /><Bar dataKey="revenue" fill="#2563eb" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div></ChartCard>}
      {categories.some(row => row.revenue !== null) && <ChartCard title="Ingresos por categoría"><div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={categories.filter(row => row.revenue !== null)} margin={{ bottom: 32 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" interval={0} angle={-25} textAnchor="end" tick={{ fontSize: 11 }} /><YAxis tickFormatter={value => `S/ ${numberText(chartNumeric(value))}`} /><Tooltip formatter={value => [moneyText({ value: chartNumeric(value), currency: values.revenue?.currency || 'PEN' }), 'Ingresos']} /><Bar dataKey="revenue" fill="#0f766e" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div></ChartCard>}</div>
    <Table headers={['Fecha', 'Ingresos', 'Unidades', 'Tickets', 'Estado del dato']} empty={data.series === null ? 'La serie diaria no fue solicitada.' : 'No hay puntos diarios para el período.'} rows={series.map(point => [dateText(point.date), moneyText(point.revenue), numberText(point.units), numberText(point.tickets), statusText(point.status)])} />
  </div>;
}

function CustomersView({ data, detail, detailStatus, detailMessage, onSelect, onRetry }: { data: CustomersAnalytics; detail: CustomerAnalyticsDetail | null; detailStatus: LoadStatus; detailMessage: string; onSelect: (ref: string) => void; onRetry: () => void }) {
  const segments = Object.entries(data.summary.segments || {}).map(([key, value]) => ({ segment: segmentLabels[key] || key.replace(/_/g, ' '), count: value }));
  return <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Kpi label="Registrados" value={numberText(data.summary.totalRegistered)} /><Kpi label="Activos" value={numberText(data.summary.active)} /><Kpi label="Nuevos" value={numberText(data.summary.new)} /><Kpi label="En riesgo" value={numberText(data.summary.atRisk)} /><Kpi label="Alto valor" value={numberText(data.summary.highValue)} /></div>
    <p className="rounded-lg bg-muted/50 p-3 text-sm">Consumer Final {data.summary.consumerFinalIncludedInIndividualRfm ? 'se incluye' : 'se excluye'} de la segmentación individual de clientes.</p>
    {segments.length > 0 && <ChartCard title="Segmentos de clientes" help="RFM agrupa clientes considerando cuánto gastan, con qué frecuencia compran y cuánto tiempo pasó desde su última compra."><div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={segments} layout="vertical" margin={{ left: 12, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="segment" width={140} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [`${numberText(chartNumeric(value))} clientes`, 'Cantidad']} /><Bar dataKey="count" name="Clientes" radius={[0, 5, 5, 0]}>{segments.map((row, index) => <Cell key={row.segment} fill={chartColors[index % chartColors.length]} />)}</Bar></BarChart></ResponsiveContainer></div></ChartCard>}
    <Table headers={['Cliente', 'Segmento', 'Recencia', 'Frecuencia', 'Valor monetario', 'Ticket promedio', 'Última compra']} empty="No hay clientes RFM para mostrar." rows={data.items.map(row => [row.customerId ? <button type="button" className="text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(row.customerId!)}>{row.displayName || 'Cliente'}<span className="block text-xs font-normal text-muted-foreground">Ver detalle</span></button> : row.displayName || 'Cliente', segmentLabels[row.segment || ''] || row.segment || 'No disponible', <>{numberText(row.recency)} <span className="text-xs text-muted-foreground">días</span></>, numberText(row.frequency), moneyText(row.monetary), moneyText(row.averageTicket), dateText(row.lastPurchaseDate)])} />
    <div className="text-xs text-muted-foreground"><MetricLabel label="Recencia" help="Cuánto tiempo pasó desde la última compra." /> · <MetricLabel label="Frecuencia" help="Cuántas compras realizó el cliente en la ventana analizada." /> · <MetricLabel label="Valor monetario" help="Cuánto gastó el cliente en la ventana analizada." />.</div>
    <DataState status={detailStatus} message={detailMessage} onRetry={onRetry} />{detail && <CustomerDetailCard detail={detail} />}
    <CustomerClusteringPanel selectedRef={detail?.item.customerId} selectedRfmSegment={segmentLabels[detail?.item.segment || ''] || detail?.item.segment} onSelect={onSelect} />
  </div>;
}
function CustomerDetailCard({ detail }: { detail: CustomerAnalyticsDetail }) {
  const row = detail.item;
  return <Card><CardHeader><CardTitle>{row.displayName || 'Detalle del cliente'}</CardTitle><CardDescription>{segmentLabels[row.segment || ''] || row.segment || 'Segmento no disponible'} · historial: {statusText(detail.historyAvailability)}</CardDescription></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Kpi label="Recencia" value={row.recency == null ? 'No disponible' : `${numberText(row.recency)} días`} help="Tiempo transcurrido desde la última compra." /><Kpi label="Frecuencia" value={numberText(row.frequency)} help="Compras dentro de la ventana RFM." /><Kpi label="Valor monetario" value={moneyText(row.monetary)} help="Gasto dentro de la ventana RFM." /><Kpi label="Gasto registrado" value={moneyText(row.spend)} /><Kpi label="Ticket promedio" value={moneyText(row.averageTicket)} /><Kpi label="Última compra" value={dateText(row.lastPurchaseDate)} /><Kpi label="Compras de vida" value={numberText(row.lifetimeTicketCount)} /><div className="rounded-xl border p-3 text-sm"><strong>Preferencias</strong><p className="mt-1 text-muted-foreground">{row.preferences ? 'Información disponible en el detalle.' : 'No disponible'}</p></div></CardContent></Card>;
}

function SuppliersView({ data, detail, detailStatus, detailMessage, onSelect, onRetry }: { data: SuppliersAnalytics; detail: SupplierAnalyticsDetail | null; detailStatus: LoadStatus; detailMessage: string; onSelect: (ref: string) => void; onRetry: () => void }) {
  const averageLead = data.summary.averageLeadTime?.days;
  const items = data.items.filter(row => row && typeof row === 'object');
  const rows = items.map(row => ({ name: row.name || 'Proveedor', spend: numeric(row.spend?.value), pending: numeric(row.pending), received: numeric(row.received), lead: objectNumber(row.leadTime, ['averageDays', 'days', 'meanDays']), punctuality: objectNumber(row.punctuality, ['onTimeRatePct']) }));
  const spendRows = rows.filter(row => row.spend !== null);
  const pendingRows = rows.filter(row => row.pending !== null || row.received !== null);
  const leadRows = rows.filter(row => row.lead !== null);
  const punctualRows = rows.filter(row => row.punctuality !== null);
  return <div className="space-y-5"><p className="text-sm text-muted-foreground">Analítica descriptiva de órdenes, tiempos de entrega, puntualidad, gasto y dependencias según el historial disponible; no se calcula un modelo ML ni una puntuación de proveedor.</p><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Kpi label="Proveedores" value={numberText(data.summary.totalSuppliers)} /><Kpi label="Gasto recibido" value={moneyText(data.summary.totalSpend)} /><Kpi label="Pedidos pendientes" value={numberText(data.summary.pendingOrders)} /><Kpi label="Pedidos recibidos" value={numberText(data.summary.receivedOrders)} /><Kpi label="Lead time promedio" value={averageLead == null ? 'No disponible' : `${numberText(averageLead)} días`} help="Tiempo promedio entre la orden de compra y su recepción, cuando hay historial suficiente." /></div>
    <div className="grid gap-4 xl:grid-cols-2">{spendRows.length > 0 && <ChartCard title="Gasto recibido por proveedor"><div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={spendRows} layout="vertical" margin={{ left: 16, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tickFormatter={value => `S/ ${numberText(chartNumeric(value))}`} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [moneyText({ value: chartNumeric(value), currency: data.summary.totalSpend?.currency || 'PEN' }), 'Gasto recibido']} /><Bar dataKey="spend" fill="#2563eb" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div></ChartCard>}
      {pendingRows.length > 0 && <ChartCard title="Pedidos por proveedor" description="Pendientes y recibidos según el estado disponible."><div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={pendingRows} layout="vertical" margin={{ left: 16, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={(value, name) => [`${numberText(chartNumeric(value))} pedidos`, name === 'pending' ? 'Pendientes' : 'Recibidos']} /><Bar dataKey="pending" name="pending" stackId="orders" fill="#d97706" /><Bar dataKey="received" name="received" stackId="orders" fill="#0f766e" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div><p className="text-xs text-muted-foreground">Naranja: pendientes · verde azulado: recibidos.</p></ChartCard>}
      {leadRows.length > 0 && <ChartCard title="Tiempo de entrega" help="Lead time es el tiempo observado entre ordenar y recibir productos; solo se muestra cuando existe evidencia."><div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={leadRows} layout="vertical" margin={{ left: 16, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" unit=" días" /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [`${numberText(chartNumeric(value))} días`, 'Tiempo promedio']} /><Bar dataKey="lead" fill="#7c3aed" /></BarChart></ResponsiveContainer></div></ChartCard>}
      {punctualRows.length > 0 && <ChartCard title="Puntualidad de entrega" help="Porcentaje de entregas recibidas a tiempo según el historial disponible del proveedor."><div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={punctualRows} layout="vertical" margin={{ left: 16, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" domain={[0, 100]} tickFormatter={value => `${numberText(chartNumeric(value))}%`} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [`${numberText(chartNumeric(value))}%`, 'Puntualidad']} /><Bar dataKey="punctuality" fill="#0f766e" /></BarChart></ResponsiveContainer></div></ChartCard>}</div>
    <Table headers={['Proveedor', 'Gasto', 'Pedidos', 'Pendientes', 'Recibidos', 'Lead time', 'Puntualidad', 'Historial']} empty="No hay proveedores para mostrar." rows={items.map(row => [row.supplierId ? <button type="button" className="text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(row.supplierId!)}>{row.name || 'Proveedor'}<span className="block text-xs font-normal text-muted-foreground">Ver detalle</span></button> : row.name || 'Proveedor', moneyText(row.spend), numberText(row.orders), numberText(row.pending), numberText(row.received), objectNumber(row.leadTime, ['averageDays', 'days', 'meanDays']) == null ? statusText(row.leadTimeAvailability) : `${numberText(objectNumber(row.leadTime, ['averageDays', 'days', 'meanDays']))} días`, objectNumber(row.punctuality, ['onTimeRatePct']) == null ? 'No disponible' : `${numberText(objectNumber(row.punctuality, ['onTimeRatePct']))}%`, statusText(row.status)])} />
    <DataState status={detailStatus} message={detailMessage} onRetry={onRetry} />{detail && <SupplierDetailCard detail={detail} />}
  </div>;
}
function SupplierDetailCard({ detail }: { detail: SupplierAnalyticsDetail }) {
  const row = detail.item;
  const products = Array.isArray(row.products) ? row.products.filter(product => product && typeof product === 'object') : [];
  const productNames = products.map(product => String(product.productName || product.name || product.sku || '')).filter(Boolean);
  return <Card><CardHeader><CardTitle>{row.name || 'Detalle del proveedor'}</CardTitle><CardDescription>Historial: {statusText(row.historyAvailability || detail.historyAvailability)}</CardDescription></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Kpi label="Gasto recibido" value={moneyText(row.spend)} /><Kpi label="Órdenes" value={numberText(row.orders)} /><Kpi label="Pendientes" value={numberText(row.pending)} /><Kpi label="Recibidas" value={numberText(row.received)} /><Kpi label="Lead time" value={objectNumber(row.leadTime, ['averageDays', 'days', 'meanDays']) == null ? statusText(row.leadTimeAvailability) : `${numberText(objectNumber(row.leadTime, ['averageDays', 'days', 'meanDays']))} días`} help="Tiempo observado entre la orden y la recepción." /><Kpi label="Puntualidad" value={objectNumber(row.punctuality, ['onTimeRatePct']) == null ? 'No disponible' : `${numberText(objectNumber(row.punctuality, ['onTimeRatePct']))}%`} help="Porcentaje de entregas puntuales cuando hay muestra suficiente." /><div className="rounded-xl border p-3 text-sm sm:col-span-2"><strong>Productos suministrados</strong>{productNames.length ? <ul className="mt-2 list-disc pl-5">{productNames.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}</ul> : <p className="mt-1 text-muted-foreground">No disponible en el detalle.</p>}</div></CardContent></Card>;
}

function HealthView({ data }: { data: BusinessHealthAnalytics }) {
  const domains = Object.entries(data.domains);
  return <div className="space-y-4"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{statusText(data.status)}</Badge><span className="text-sm text-muted-foreground">Período {dateText(data.period.startDate)} – {dateText(data.period.endDate)}</span></div><p className="text-sm text-muted-foreground">Estado por área del negocio. No se calcula una puntuación global.</p>
    <section className="rounded-xl border p-4"><h3 className="font-semibold">Contexto de las técnicas utilizadas</h3><p className="mt-1 text-sm text-muted-foreground">Predicción: modelos ML evaluados y media móvil operativa · Clientes: K-Means · Ventas: Isolation Forest · Productos relacionados: FP-Growth congelado al histórico. Inventario combina pronóstico y reglas operativas; proveedores muestran indicadores descriptivos.</p></section>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{domains.map(([key, domain]) => {
      const metrics = domain.metrics ? healthEntries(domain.metrics) : [];
      return <article key={key} className="rounded-xl border bg-card p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{domainLabels[key] || key}</h3><Badge variant="outline">{statusText(domain.status)}</Badge></div>
        {domain.freshness && <p className="mt-2 text-xs text-muted-foreground">{statusText(String(domain.freshness.mode || domain.freshness.status || ''))}{domain.freshness.mode === 'FROZEN' ? ' · FROZEN' : ''}{domain.freshness.cutoff ? ` · corte ${dateText(String(domain.freshness.cutoff))}` : ''}</p>}
        {metrics.length > 0 ? <dl className="mt-3 space-y-2">{metrics.map(({ label, value }, index) => <div key={`${label}-${index}`} className="flex justify-between gap-2 border-t pt-2 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{value}</dd></div>)}</dl> : <p className="mt-3 text-sm text-muted-foreground">Sin métricas adicionales para mostrar.</p>}
        {(Array.isArray(domain.insights) ? domain.insights : []).map(insightText).filter(Boolean).slice(0, 2).map((text, index) => <p key={index} className="mt-3 rounded-md bg-muted/50 p-2 text-sm">{text}</p>)}
      </article>;
    })}</div>
    {(data.insights || []).some(insightText) && <section><h3 className="mb-2 font-medium">Observaciones del análisis</h3><ul className="list-disc space-y-1 pl-5 text-sm">{data.insights.map(insightText).filter(Boolean).map((text, index) => <li key={index}>{text}</li>)}</ul></section>}
  </div>;
}
