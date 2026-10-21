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
import { CustomerImpactPanel } from './CustomerImpactPanel';
import { SalesAnomalyPanel } from './SalesAnomalyPanel';
import { SalesImpactPanel } from './SalesImpactPanel';
import { MethodologyCard } from './MethodologyCard';
import { AnalyticsErrorBoundary } from './AnalyticsErrorBoundary';
import { AssociationImpactPanel } from './AssociationImpactPanel';

export type ExtendedTab = 'sales' | 'customers' | 'suppliers' | 'related' | 'health';
type LoadStatus = 'loading' | 'ready' | 'error';
type AnalyticsData = SalesAnalytics | CustomersAnalytics | SuppliersAnalytics | AssociationsAnalytics | BusinessHealthAnalytics;
const domainLabels: Record<string, string> = { sales: 'Ventas', margin: 'Margen', customers: 'Clientes', inventory: 'Inventario', suppliers: 'Proveedores', forecast: 'Pronóstico', marketBasket: 'Productos relacionados' };
const statusLabels: Record<string, string> = { READY: 'Disponible', PARTIAL: 'Parcial', UNAVAILABLE: 'No disponible', COLD_START: 'Sin historial suficiente', INSUFFICIENT_HISTORY: 'Historial insuficiente', NOT_AVAILABLE: 'No disponible', NOT_EXPOSED_BY_ENGINE: 'No disponible', 'not exposed by engine': 'No disponible', FROZEN: 'Histórico hasta 12 oct. 2026', historical: 'Histórico', LIVE: 'Actualizado con datos operativos', AVAILABLE: 'Disponible', NOT_REQUESTED: 'No solicitado' };
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
  units: 'Unidades vendidas', tickets: 'Tickets',
  trends: 'Tendencias', customerMix: 'Composición de clientes', forecastHorizons: 'Horizontes del pronóstico',
  forecastExpectedUnitsNext1d: 'Unidades previstas para el próximo día', forecastExpectedUnitsNext7d: 'Unidades previstas para los próximos 7 días',
  forecastExpectedUnitsNext14d: 'Unidades previstas para los próximos 14 días', expectedUnitsNext1d: 'Unidades previstas para el próximo día',
  expectedUnitsNext7d: 'Unidades previstas para los próximos 7 días', expectedUnitsNext14d: 'Unidades previstas para los próximos 14 días',
  knownCount: 'Pronósticos disponibles', missingCount: 'Pronósticos no disponibles', usefulRuleCount: 'Reglas útiles',
  topExamples: 'Ejemplos de asociaciones', categoryAssociations: 'Asociaciones entre categorías', sourceArtifactCutoff: 'Corte del análisis',
  purchaseSpendSharePct: 'Participación del gasto (%)', singleSourceCriticalOrHighSkuCount: 'Productos de riesgo alto/crítico con proveedor único',
  riskUnavailableCount: 'Riesgo no disponible', recommendationUnavailableCount: 'Reposición no disponible',
  abcUnavailableCount: 'Clasificación ABC no disponible', xyzUnavailableCount: 'Clasificación XYZ no disponible',
  slowMovingUnavailableCount: 'Rotación lenta no disponible', deadStockUnavailableCount: 'Inventario sin movimiento no disponible',
  overstockEstimatedValueCents: 'Valor estimado de sobrestock',
  classificationMethod: 'Criterio de clasificación', p90Method: 'Método de cálculo del percentil 90',
  averageTicket: 'Ticket promedio', averageDistinctSkusPerTicket: 'Productos distintos por ticket',
  averageUnitsPerTicket: 'Unidades promedio por ticket', cogs: 'Costo de ventas',
  highRevenueLowMargin: 'Alto ingreso y bajo margen', lowRevenueHighMargin: 'Bajo ingreso y alto margen', highMarginProducts: 'Productos con margen alto',
  incomingUnits: 'Unidades por recibir', lowStock: 'Productos con stock bajo', shouldReorder: 'Productos que requieren reposición',
  overstock: 'Productos con sobrestock', slowMoving: 'Productos con rotación lenta', deadStock: 'Productos sin movimiento',
  forecastAvailability: 'Disponibilidad del pronóstico', abcAvailable: 'Clasificación ABC disponible', xyzAvailable: 'Clasificación XYZ disponible',
  purchaseOrders: 'Órdenes de compra', receivedSpendCents: 'Gasto recibido', committedSpendCents: 'Gasto comprometido',
  pendingCommitmentCents: 'Compromiso pendiente', exposures: 'Productos expuestos al riesgo',
  unitsOrdered: 'Unidades pedidas', unitsReceived: 'Unidades recibidas', fillRate: 'Tasa de cumplimiento de unidades',
  pendingOrderCount: 'Órdenes pendientes', overdueOrUnknownExpectedArrivalUnits: 'Unidades vencidas o sin fecha prevista',
  recommendedProducts: 'Productos con cantidad de reposición sugerida', riskCounts: 'Distribución del riesgo',
  registeredTickets: 'Tickets de clientes registrados', consumerFinalTickets: 'Tickets de consumidor final',
  registeredTicketSharePct: 'Participación de tickets registrados (%)', consumerFinalTicketSharePct: 'Participación de tickets de consumidor final (%)',
  registeredRevenue: 'Ingresos de clientes registrados', consumerFinalRevenue: 'Ingresos de consumidor final',
  registeredRevenueSharePct: 'Participación de ingresos registrados (%)', consumerFinalRevenueSharePct: 'Participación de ingresos de consumidor final (%)',
  value: 'Valor actual', previousValue: 'Valor anterior', absoluteChange: 'Variación absoluta', percentChange: 'Variación (%)',
  comparisonAvailable: 'Comparación disponible', comparableDurations: 'Períodos de duración equivalente', status: 'Estado',
  TOP_HIGH_VALUE: 'Mayor valor', singleSource: 'Productos con proveedor único',
  registeredCustomerCount: 'Clientes registrados', totalSuppliers: 'Proveedores',
  knownSaleLines: 'Líneas con costo conocido', unknownSaleLines: 'Líneas sin costo conocido', costCoverage: 'Cobertura de costos',
  totalProducts: 'Productos',
};
const segmentLabels: Record<string, string> = { HIGH_VALUE: 'Alto valor', TOP_HIGH_VALUE: 'Alto valor', POTENTIAL: 'Potencial', NEW: 'Nuevo', AT_RISK: 'En riesgo', INACTIVE: 'Inactivo', ACTIVE: 'Activo', LOYAL: 'Fiel', CHAMPION: 'Cliente frecuente', PROMISING: 'Prometedor', NEEDS_ATTENTION: 'Requiere atención', HIBERNATING: 'Inactivo reciente' };
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
function healthStatusBucket(status: string | null | undefined, freshness?: Record<string, unknown> | null): 'available' | 'partial' | 'unavailable' | null {
  const normalized = String(status || '').toUpperCase();
  if (['READY', 'AVAILABLE', 'LIVE', 'HISTORICAL'].includes(normalized) || (normalized === 'FROZEN' && freshness?.mode === 'FROZEN')) return 'available';
  if (normalized === 'PARTIAL') return 'partial';
  if (['UNAVAILABLE', 'NOT_AVAILABLE', 'NOT_EXPOSED_BY_ENGINE', 'INSUFFICIENT_HISTORY', 'COLD_START', 'NOT_REQUESTED'].includes(normalized)) return 'unavailable';
  return null;
}
function healthStatusLabel(status: string | null | undefined): string {
  const bucket = healthStatusBucket(status);
  return bucket === 'available' ? 'Disponible' : bucket === 'partial' ? 'Parcial' : bucket === 'unavailable' ? 'No disponible' : statusText(status);
}
function dateTimeText(value: string | null | undefined): string {
  if (!value) return 'No disponible';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(date);
}
function healthMetricLabel(key: string): string {
  if (healthMetricLabels[key] || segmentLabels[key]) return healthMetricLabels[key] || segmentLabels[key];
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^./, character => character.toLocaleUpperCase('es-PE'));
}
function healthMetricValue(key: string, value: unknown): string {
  if (value == null) return 'No disponible';
  if (key === 'classificationMethod' && value === 'relative product percentiles: revenue p75/p25 and gross-margin-rate p25/p75; no net-profit claim') return 'Percentiles relativos de ingresos (p75/p25) y margen bruto (p25/p75); no representa utilidad neta.';
  if (key === 'p90Method' && value === 'nearest rank') return 'Rango más cercano';
  if (['horizons', 'forecastHorizons'].includes(key) && Array.isArray(value)) {
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
    if (['revenue', 'grossMargin', 'cogs', 'averageTicket', 'registeredRevenue', 'consumerFinalRevenue'].includes(key)) return moneyText({ value, currency: 'PEN' });
    if (key.toLowerCase().includes('pct') || key === 'percentChange') return `${numberText(value)}%`;
    return numberText(value);
  }
  if (typeof value === 'string') return value === 'MOVING_AVERAGE_28' ? 'Media móvil de 28 días' : statusLabels[value] || value;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return 'No disponible';
}
export function healthEntries(metrics: Record<string, unknown>, parent = '', depth = 0): Array<{ label: string; value: string }> {
  return Object.entries(metrics).flatMap(([key, value]) => {
    // These fields are freshness, routing, or explanatory metadata—not dashboard metrics.
    if (['alerts', 'freshness', 'meaning', 'interpretation', 'engineVersion', 'datasetVersion', 'datasetSha256', 'contractVersion'].includes(key)) return [];
    // Unknown schema fields are not automatically promoted to visible business indicators.
    if (!healthMetricLabels[key] && !segmentLabels[key]) return [];
    const cents = metrics[`${key}Cents`];
    if (['revenue', 'grossMargin', 'cogs', 'averageTicket'].includes(key) && `${key}Cents` in metrics
      && (value === null && cents === null || typeof value === 'number' && typeof cents === 'number' && Math.abs(value * 100 - cents) < 1e-8)) return [];
    const label = [parent, healthMetricLabel(key)].filter(Boolean).join(' · ');
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 3)
      return healthEntries(value as Record<string, unknown>, label, depth + 1);
    // Trend values for these metrics are cents in M6.8, unlike their KPI aliases.
    const trendMoney = ['value', 'previousValue', 'absoluteChange'].includes(key)
      && /Tendencias · (Ingresos|Margen bruto|Ticket promedio)$/.test(parent);
    return [{ label, value: trendMoney ? healthMetricValue('amountCents', value) : healthMetricValue(key, value) }];
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
function Kpi({ label, value, help, featured = false }: { label: string; value: string; help?: React.ReactNode; featured?: boolean }) {
  return <div className={`min-w-0 rounded-xl border bg-card p-3 shadow-sm${featured ? ' border-primary/30 bg-muted/30' : ''}`}><div className="text-xs text-muted-foreground"><MetricLabel label={label} help={help} /></div><p className="mt-1 break-words text-lg font-semibold">{value}</p></div>;
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
  const [showAllRules, setShowAllRules] = useState(false);
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
      : tab === 'related' ? apiClient.getAssociations({ limit: 20, offset: 0 })
      : apiClient.getBusinessHealth({ period, limit: 5 });
    void request.then(response => {
      if (!current) return;
      if (!response.success || !response.data) throw new Error('No se recibió un contrato de analítica.');
      if (tab === 'suppliers' && (!response.data || !('summary' in response.data) || !response.data.summary || !('items' in response.data) || !Array.isArray(response.data.items))) throw new Error('Invalid supplier contract');
      setData(response.data as AnalyticsData); setLoadedKey(requestKey); setStatus('ready');
    }).catch(error => { if (current) { setData(null); setLoadedKey(requestKey); setMessage(errorLabel(error)); setStatus('error'); } });
    return () => { current = false; };
  }, [tab, period, reload, requestKey]);

  const selectedSku = sku;
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
  const retry = () => { apiClient.invalidateIntelligenceReads(); setReload(value => value + 1); };
  const retryDetail = () => { apiClient.invalidateIntelligenceReads(); if (selectedDetail) void openDetail(selectedDetail.kind, selectedDetail.ref); };
  const freshness = data && 'mode' in data ? `${data.mode === 'LIVE' ? 'Actualizado con datos operativos' : 'Histórico hasta 12 oct. 2026'}${data.dataThrough ? ` · Datos hasta ${dateText(data.dataThrough)}` : ''}` : null;

  if (tab === 'related') {
    const source = data && 'cutoff' in data ? data as AssociationsAnalytics : null;
    const basket = source ? { ...source, items: (Array.isArray(source.items) ? source.items : []).map(rule => ({ ...rule,
      antecedent: Array.isArray(rule.antecedent) ? rule.antecedent : [], consequent: Array.isArray(rule.consequent) ? rule.consequent : [],
      antecedentProducts: Array.isArray(rule.antecedentProducts) ? rule.antecedentProducts : [],
      consequentProducts: Array.isArray(rule.consequentProducts) ? rule.consequentProducts : [] })) } : null;
    return <div className="space-y-4"><AssociationImpactPanel data={basket} loading={status === 'loading'} /><Card><CardHeader><CardTitle className="flex items-center gap-2">Reglas de asociación históricas <Badge variant="outline">HISTÓRICO · FP-Growth</Badge><MetricInfo label="Reglas de asociación">Analiza productos que aparecen juntos en los mismos tickets. Describe coocurrencias, no causa de compra.</MetricInfo></CardTitle><CardDescription>Productos que suelen comprarse juntos según el histórico disponible; no se actualiza con cada venta.</CardDescription></CardHeader><CardContent className="space-y-4">
      <DataState status={status} message={message} onRetry={retry} />{basket && <><details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-semibold">Metodología FP-Growth y reglas de asociación</summary><div className="mt-3"><MethodologyCard algorithm="FP-Growth + reglas de asociación" learningType="Minería de patrones frecuentes" objective="Descubrir productos que coocurren en tickets históricos" explanation="FP-Growth comprime patrones frecuentes en una estructura eficiente y descubre conjuntos de productos que suelen coincidir en los tickets." summary={<>{basket.total} reglas · corte histórico {dateText(basket.cutoff)}</>} fields={[
        { label: 'Cómo funciona', value: 'Resume transacciones en patrones frecuentes y deriva reglas de asociación sin interpretar coocurrencia como causalidad.' },
        { label: 'Métricas', value: 'Support: proporción de tickets con la combinación. Confidence: proporción de tickets con A que también contienen B. Lift compara la frecuencia observada con la esperada bajo independencia.' },
        { label: 'Estado', value: `Histórico congelado (FROZEN) · cutoff ${basket.cutoff}; no se recalcula con ventas operativas.` },
        { label: 'Interpretación', value: 'Lift > 1 indica asociación positiva según el contrato; no demuestra que un producto cause la compra del otro.' },
      ]} /></div></details><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">Corte: {dateText(basket.cutoff)}</Badge><Badge variant="outline">Versión: {basket.analysisVersion || (typeof basket.summary?.analysisVersion === 'string' ? basket.summary.analysisVersion : 'No disponible')}</Badge><span className="text-xs text-muted-foreground">{basket.total} reglas · análisis congelado; las asociaciones no implican causalidad.</span>{basket.artifactIdentity && <span className="text-xs text-muted-foreground">Artifact: {basket.artifactIdentity.slice(0, 12)}…</span>}</div>{basket.items.find(rule => rule.lift != null && rule.lift > 1) && <p className="rounded-md bg-muted/50 p-3 text-sm">Entre las reglas visibles hay una coocurrencia más frecuente que la esperada bajo independencia (lift &gt; 1). Es una asociación histórica, no una relación causal.</p>}
        {basket.items.length ? <><div className="grid gap-3 xl:grid-cols-2">{(showAllRules ? basket.items : basket.items.slice(0, 8)).map((rule, index) => <article aria-label={`Regla histórica ${index + 1}`} key={`${rule.antecedent.join('-')}-${rule.consequent.join('-')}-${index}`} className="rounded-xl border p-4"><p className="font-semibold leading-relaxed">{basketNames(rule.antecedentProducts, rule.antecedent)} <span aria-label="se asocia con" className="text-primary">→</span> {basketNames(rule.consequentProducts, rule.consequent)}</p><div className="mt-1 space-y-0.5 text-xs text-muted-foreground"><p>SKU: {rule.antecedent.join(', ')} → {rule.consequent.join(', ')}</p></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Kpi label="Soporte" value={percentText(rule.support)} help="Proporción de tickets donde aparece esta combinación." /><Kpi label="Confianza" value={percentText(rule.confidence)} help="De quienes compraron el producto A, qué proporción también compró B." /><Kpi label="Lift" value={numberText(rule.lift)} help="Compara la frecuencia observada con la esperada si los productos fueran independientes; no implica causalidad." /><Kpi label="Tickets" value={numberText(rule.ticketCount)} /></div><p className="mt-2 text-xs text-muted-foreground">Estabilidad: {statusText(rule.stability || rule.status)}</p></article>)}</div>{basket.items.length > 8 && <Button variant="outline" onClick={() => setShowAllRules(value => !value)}>{showAllRules ? 'Mostrar Top 8' : 'Ver todas las reglas'}</Button>}</> : <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{basket.available ? 'No se encontraron reglas para mostrar.' : 'El análisis histórico no tiene reglas disponibles.'}</p>}
      </>}</CardContent></Card><Card><CardHeader><CardTitle>Productos relacionados</CardTitle><CardDescription>Recomendaciones de productos que aparecen en los mismos tickets. Se leen del análisis histórico aprobado.</CardDescription></CardHeader><CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">El selector utiliza productos del ranking cargado; no representa el catálogo completo.</p>
        {inventory?.items.length ? <label className="flex flex-wrap items-center gap-2 text-sm">Producto<select aria-label="Producto relacionado" className="max-w-full rounded-md border bg-background px-2 py-1.5" value={selectedSku} onChange={event => setSku(event.target.value)}><option value="">Elige un producto</option>{inventory.items.map(item => <option key={item.sku} value={item.sku}>{item.productName} · SKU: {item.sku}</option>)}</select></label> : <p className="text-sm text-muted-foreground">No hay productos del ranking disponibles para consultar.</p>}
        <DataState status={relatedStatus} message={relatedMessage} onRetry={retry} />{related && <><p className="text-sm"><strong>{related.sourceProduct.name}</strong><span className="ml-2 text-xs text-muted-foreground">SKU: {related.sourceProduct.sku}</span></p><div className="flex items-center gap-2"><Badge variant="outline">Histórico congelado</Badge><span className="text-xs text-muted-foreground">Corte: {dateText(related.cutoff)}</span></div><p className="text-xs text-muted-foreground">FROZEN · cutoff {related.cutoff}</p>
          {related.items.length ? <div className="grid gap-3 md:grid-cols-2">{related.items.map((item, index) => <article key={`${item.relatedProduct.sku || item.relatedProduct.name}-${index}`} className="rounded-xl border p-4"><h3 className="font-semibold">{item.relatedProduct.name || 'Producto relacionado'}</h3><p className="text-xs text-muted-foreground">SKU: {item.relatedProduct.sku || 'No disponible'}</p><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Kpi label="Soporte" value={percentText(item.support)} help="Proporción de tickets donde aparecen juntos los productos." /><Kpi label="Confianza" value={percentText(item.confidence)} help="De los tickets con el producto elegido, proporción que también contiene este producto." /><Kpi label="Lift" value={numberText(item.lift)} help="Frecuencia de la asociación respecto de lo esperado por independencia estadística; no implica causalidad." /><Kpi label="Tickets" value={numberText(item.ticketCount)} /></div><p className="mt-2 text-xs text-muted-foreground">{item.lift != null && item.lift > 1 ? 'Asociación positiva observada; no implica causalidad.' : 'La métrica describe coocurrencia histórica, no causalidad.'}</p></article>)}</div> : <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{related.available ? 'No se encontraron asociaciones suficientes para este producto.' : 'El análisis histórico no tiene recomendaciones disponibles.'}</p>}
        </>}
      </CardContent></Card></div>;
  }

  const title: Record<Exclude<ExtendedTab, 'related'>, string> = { sales: 'Ventas', customers: 'Clientes', suppliers: 'Análisis operacional de proveedores', health: 'Estado del sistema analítico' };
  return <Card><CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3"><div><CardTitle>{title[tab]}</CardTitle><CardDescription>{freshness || 'Analítica del negocio'}</CardDescription></div>{['sales', 'suppliers', 'health'].includes(tab) && <PeriodSelect value={period} onChange={setPeriod} />}</CardHeader><CardContent className="space-y-5">
    <DataState status={loadedKey === requestKey ? status : 'loading'} message={message} onRetry={retry} />
    {tab === 'sales' && <SalesView data={data && 'summary' in data ? data as SalesAnalytics : null} />}
    {tab === 'sales' && <SalesAnomalyPanel />}
    {tab === 'sales' && data && 'summary' in data && <SalesPeriodSeries data={data as SalesAnalytics} />}
    {tab === 'customers' && data && 'items' in data && <CustomersView data={data as CustomersAnalytics} detail={customerDetail} detailStatus={detailStatus} detailMessage={detailMessage} onSelect={ref => void openDetail('customer', ref)} onRetry={retryDetail} />}
    {tab === 'suppliers' && data && 'items' in data && <SuppliersView data={data as SuppliersAnalytics} detail={supplierDetail} detailStatus={detailStatus} detailMessage={detailMessage} onSelect={ref => void openDetail('supplier', ref)} onRetry={retryDetail} />}
    {tab === 'health' && data && 'domains' in data && <HealthView data={data as BusinessHealthAnalytics} />}
  </CardContent></Card>;
}

function SalesView({ data }: { data: SalesAnalytics | null }) {
  const values = data?.summary || null;
  const products = data?.rankings.topProducts.map(row => ({ label: String(row.name || row.sku || 'Producto'), revenue: objectNumber(row.revenue, ['value']) })).filter(row => row.revenue !== null && row.revenue > 0).slice(0, 8) || [];
  const categories = data?.rankings.topCategories.map(row => ({ label: String(row.category || row.name || 'Categoría'), revenue: objectNumber(row.revenue, ['value']) })).filter(row => row.revenue !== null && row.revenue > 0) || [];
  const coverage = values?.grossMargin.costCoverage;
  const marginValue = values && values.grossMargin.availability === 'AVAILABLE' && values.grossMargin.value !== null
    ? `${moneyText(values.grossMargin)}${values.grossMargin.percent === null ? '' : ` · ${numberText(values.grossMargin.percent)}%`}`
    : 'No disponible';
  const marginCoverage = values && values.grossMargin.availability !== 'AVAILABLE' && coverage?.knownSaleLines != null && coverage.unknownSaleLines != null
    ? `Costos disponibles para ${numberText(coverage.knownSaleLines)} de ${numberText(coverage.knownSaleLines + coverage.unknownSaleLines)} líneas de venta.`
    : values?.grossMargin.availability === 'PARTIAL' ? 'Cobertura de costos parcial; no se muestra un margen total.'
      : values?.grossMargin.availability === 'UNAVAILABLE' ? 'No hay costos suficientes para calcularlo; no se asume costo cero.' : null;
  return <div className="space-y-4">{data && values && <section aria-label="Rendimiento del periodo" className="space-y-2"><h3 className="text-sm font-semibold">Rendimiento del periodo</h3><p className="text-xs text-muted-foreground">{dateText(data.period.startDate)} – {dateText(data.period.endDate)} · Métricas comerciales descriptivas.</p><div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
    <Kpi label="Ingresos" value={moneyText(values.revenue)} /><Kpi label="Unidades" value={numberText(values.units)} /><Kpi label="Tickets" value={numberText(values.tickets)} /><Kpi label="Ticket promedio" value={moneyText(values.averageTicket)} />
    <div><Kpi label="Margen bruto" value={marginValue} help="Margen = ingresos menos costos históricos de las líneas vendidas. Si falta cobertura, no se presenta un total ni se sustituye costo por cero." />{marginCoverage && <p className="mt-1 px-1 text-xs text-muted-foreground">{marginCoverage}</p>}</div>
  </div></section>}
    {values?.revenue?.value === 0 && values.units === 0 && values.tickets === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No se registraron ventas en este período; los valores cero son resultados válidos.</p>}
    <SalesImpactPanel />
    {data && values && <section aria-label="Distribución comercial" className="space-y-2"><h3 className="text-sm font-semibold">Distribución comercial</h3><div className="grid gap-3 xl:grid-cols-2">{products.length > 0 && <ChartCard title="Productos con más ingresos"><div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={products} layout="vertical" margin={{ left: 12, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tickFormatter={value => `S/ ${numberText(chartNumeric(value))}`} /><YAxis type="category" dataKey="label" width={155} tick={{ fontSize: 11 }} interval={0} /><Tooltip formatter={value => [moneyText({ value: chartNumeric(value), currency: values.revenue?.currency || 'PEN' }), 'Ingresos']} /><Bar dataKey="revenue" fill="#2563eb" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div></ChartCard>}
      {categories.length > 0 && <ChartCard title="Ingresos por categoría"><div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={categories} margin={{ bottom: 42 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" angle={-25} textAnchor="end" height={52} tick={{ fontSize: 11 }} /><YAxis tickFormatter={value => `S/ ${numberText(chartNumeric(value))}`} /><Tooltip formatter={value => [moneyText({ value: chartNumeric(value), currency: values.revenue?.currency || 'PEN' }), 'Ingresos']} /><Bar dataKey="revenue" fill="#0f766e" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div></ChartCard>}</div></section>
    }
  </div>;
}

function SalesPeriodSeries({ data }: { data: SalesAnalytics }) {
  const values = data.summary;
  const series = data.series || [];
  const chartsReady = series.length > 1;
  const revenueData = series.map(point => ({ date: point.date, revenue: point.revenue?.value ?? null, tickets: point.tickets, units: point.units, status: statusText(point.status) }));
  return <section aria-label="Serie diaria del periodo" className="space-y-3"><h3 className="text-sm font-semibold">Serie diaria del periodo</h3>
    {chartsReady ? <div className="grid gap-3 xl:grid-cols-2"><ChartCard title="Ingresos por día" description="Importe registrado en cada día del período."><div className="h-64"><ResponsiveContainer width="100%" height="100%"><LineChart data={revenueData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={date => String(date).slice(5)} minTickGap={24} /><YAxis tickFormatter={value => `S/ ${numberText(chartNumeric(value))}`} /><Tooltip labelFormatter={date => dateText(String(date))} formatter={(value, _name, item) => [value == null ? 'No disponible' : moneyText({ value: chartNumeric(value), currency: values.revenue?.currency || 'PEN' }), `Ingresos · ${item?.payload?.status || 'No disponible'}`]} /><Line dataKey="revenue" name="Ingresos" stroke="#2563eb" strokeWidth={2} connectNulls={false} dot={false} /></LineChart></ResponsiveContainer></div></ChartCard>
      <ChartCard title="Unidades vendidas por día"><div className="h-64"><ResponsiveContainer width="100%" height="100%"><LineChart data={revenueData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={date => String(date).slice(5)} minTickGap={24} /><YAxis allowDecimals={false} label={{ value: 'Unidades', angle: -90, position: 'insideLeft' }} /><Tooltip labelFormatter={date => dateText(String(date))} formatter={(value, _name, item) => [value == null ? 'No disponible' : `${numberText(chartNumeric(value))} unidades`, `Ventas · ${item?.payload?.status || 'No disponible'}`]} /><Line dataKey="units" name="Ingresos" stroke="#0f766e" strokeWidth={2} connectNulls={false} dot={false} /></LineChart></ResponsiveContainer></div></ChartCard>
    </div> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No hay suficientes puntos diarios para mostrar una tendencia en este período.</p>}
    <Table headers={['Fecha', 'Ingresos', 'Unidades', 'Tickets', 'Estado del dato']} empty={data.series === null ? 'La serie diaria no fue solicitada.' : 'No hay puntos diarios para el período.'} rows={series.map(point => [dateText(point.date), moneyText(point.revenue), numberText(point.units), numberText(point.tickets), statusText(point.status)])} />
  </section>;
}

function CustomersView({ data, detail, detailStatus, detailMessage, onSelect, onRetry }: { data: CustomersAnalytics; detail: CustomerAnalyticsDetail | null; detailStatus: LoadStatus; detailMessage: string; onSelect: (ref: string) => void; onRetry: () => void }) {
  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const visibleCustomers = showAllCustomers ? data.items : data.items.slice(0, 10);
  const segments = Object.entries(data.summary.segments || {}).map(([key, value]) => ({ segment: segmentLabels[key] || key.replace(/_/g, ' '), count: value }));
  return <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Kpi label="Registrados" value={numberText(data.summary.totalRegistered)} /><Kpi label="Activos" value={numberText(data.summary.active)} /><Kpi label="Nuevos" value={numberText(data.summary.new)} /><Kpi label="En riesgo" value={numberText(data.summary.atRisk)} /><Kpi label="Alto valor" value={numberText(data.summary.highValue)} /></div>
    <p className="rounded-lg bg-muted/50 p-3 text-sm">RFM describe recencia, frecuencia y gasto. Consumer Final {data.summary.consumerFinalIncludedInIndividualRfm ? 'se incluye' : 'se excluye'} de la segmentación individual.</p>
    <CustomerImpactPanel />
    <h3 className="text-lg font-semibold">Segmentación RFM actual</h3>
    {segments.length > 0 && <ChartCard title="Segmentos de clientes" help="RFM agrupa clientes considerando cuánto gastan, con qué frecuencia compran y cuánto tiempo pasó desde su última compra."><div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={segments} layout="vertical" margin={{ left: 12, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="segment" width={140} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [`${numberText(chartNumeric(value))} clientes`, 'Cantidad']} /><Bar dataKey="count" name="Clientes" radius={[0, 5, 5, 0]}>{segments.map((row, index) => <Cell key={row.segment} fill={chartColors[index % chartColors.length]} />)}</Bar></BarChart></ResponsiveContainer></div></ChartCard>}
    <Table headers={['Cliente', 'Segmento', 'Recencia', 'Frecuencia', 'Valor monetario', 'Ticket promedio', 'Última compra']} empty="No hay clientes RFM para mostrar." rows={visibleCustomers.map(row => [row.customerId ? <button type="button" className="text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(row.customerId!)}>{row.displayName || 'Cliente'}<span className="block text-xs font-normal text-muted-foreground">Ver detalle</span></button> : row.displayName || 'Cliente', segmentLabels[row.segment || ''] || row.segment || 'No disponible', <>{numberText(row.recency)} <span className="text-xs text-muted-foreground">días</span></>, numberText(row.frequency), moneyText(row.monetary), moneyText(row.averageTicket), dateText(row.lastPurchaseDate)])} />
    {data.items.length > 10 && <Button type="button" size="sm" variant="outline" onClick={() => setShowAllCustomers(value => !value)}>{showAllCustomers ? 'Mostrar Top 10' : 'Ver todos los clientes cargados'}</Button>}
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
  const [showAllSuppliers, setShowAllSuppliers] = useState(false);
  const averageLead = data.summary.averageLeadTime?.days;
  const items = data.items.filter(row => row && typeof row === 'object');
  const rows = items.map(row => ({ supplier: row, name: row.name || 'Proveedor', spend: numeric(row.spend?.value), pending: numeric(row.pending), received: numeric(row.received), lead: objectNumber(row.leadTime, ['averageDays', 'days', 'meanDays']), punctuality: objectNumber(row.punctuality, ['onTimeRatePct']) }));
  const spendRows = rows.filter(row => row.spend !== null);
  const pendingRows = rows.flatMap(row => {
    if (row.pending === null || row.received === null) return [];
    const total = row.pending + row.received;
    if (total <= 0) return [];
    return [{ name: row.name, pending: row.pending, received: row.received, pendingCount: row.pending, receivedCount: row.received }];
  });
  const leadRows = rows.filter(row => row.lead !== null);
  const punctualRows = rows.filter(row => row.punctuality !== null);
  const attention = rows.filter(row => (row.pending ?? 0) > 0 || (row.lead ?? 0) > 0 || (row.punctuality !== null && row.punctuality < 100))
    .sort((a, b) => (b.pending ?? -1) - (a.pending ?? -1) || (b.lead ?? -1) - (a.lead ?? -1) || (a.punctuality ?? Infinity) - (b.punctuality ?? Infinity) || (a.supplier.supplierId || a.name).localeCompare(b.supplier.supplierId || b.name, 'es'))
    .slice(0, 5);
  const complianceCardCount = Number(pendingRows.length > 0) + Number(leadRows.length > 0) + Number(punctualRows.length > 0);
  const visibleItems = showAllSuppliers ? items : items.slice(0, 6);
  const leadExplanation = data.summary.averageLeadTime?.status === 'NOT_EXPOSED_BY_ENGINE'
    ? 'El motor no expone un promedio global; los tiempos observados disponibles se muestran por proveedor.'
    : data.summary.averageLeadTime?.status === 'INSUFFICIENT_HISTORY'
      ? 'El historial disponible no alcanza para publicar un promedio global.' : 'Promedio entre órdenes y recepciones cuando existe evidencia suficiente.';
  const supplierName = (row: typeof items[number]) => row.name || 'Proveedor';
  const supplierDetailButton = (row: typeof items[number]) => row.supplierId
    ? <button type="button" className="text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(row.supplierId!)}>{supplierName(row)}<span className="block text-xs font-normal text-muted-foreground">Ver detalle</span></button>
    : <span className="font-medium">{supplierName(row)}</span>;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">OPERACIONAL</Badge><p className="text-sm text-muted-foreground">Analítica descriptiva de órdenes, gasto, tiempos de entrega y puntualidad. Este módulo no utiliza un modelo ML propio.</p></div>
    <section aria-label="Resumen operativo de proveedores"><h3 className="mb-2 text-sm font-semibold text-muted-foreground">Resumen operativo</h3><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6"><div className="xl:col-span-3"><Kpi featured label="Pedidos pendientes" value={numberText(data.summary.pendingOrders)} /></div><div className="xl:col-span-3"><Kpi featured label="Lead time promedio" value={averageLead == null ? 'No disponible' : `${numberText(averageLead)} días`} help={leadExplanation} /></div><div className="xl:col-span-2"><Kpi label="Proveedores" value={numberText(data.summary.totalSuppliers)} /></div><div className="xl:col-span-2"><Kpi label="Gasto recibido" value={moneyText(data.summary.totalSpend)} /></div><div className="xl:col-span-2"><Kpi label="Pedidos recibidos" value={numberText(data.summary.receivedOrders)} /></div></div>{averageLead == null && <p className="mt-2 text-xs text-muted-foreground">{leadExplanation}</p>}</section>
    <section aria-labelledby="supplier-attention-title"><div className="mb-2"><h3 id="supplier-attention-title" className="font-semibold">Proveedores que requieren atención</h3><p className="text-xs text-muted-foreground">Señales operativas descriptivas entre los proveedores cargados; no son una puntuación ni una predicción.</p></div>{attention.length ? <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{attention.map(row => <li key={row.supplier.supplierId || row.name} className="rounded-lg border p-3"><div className="flex items-start justify-between gap-2"><strong className="text-sm">{row.name}</strong><Badge variant="secondary">Atención operativa</Badge></div><p className="mt-1 text-xs text-muted-foreground">{[
      row.pending !== null ? `${numberText(row.pending)} pendientes` : null,
      row.lead !== null ? `${numberText(row.lead)} días de entrega` : null,
      row.punctuality !== null ? `${numberText(row.punctuality)}% puntualidad` : null,
    ].filter(Boolean).join(' · ')}</p></li>)}</ul> : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No hay señales operativas observables en los proveedores cargados.</p>}</section>
    <section aria-labelledby="supplier-economy-title"><h3 id="supplier-economy-title" className="mb-2 font-semibold">Desempeño económico</h3>{spendRows.length > 0 && <ChartCard title="Gasto recibido por proveedor"><div className="h-56"><ResponsiveContainer width="100%" height="100%"><BarChart data={spendRows} layout="vertical" margin={{ left: 16, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tickFormatter={value => `S/ ${numberText(chartNumeric(value))}`} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [moneyText({ value: chartNumeric(value), currency: data.summary.totalSpend?.currency || 'PEN' }), 'Gasto recibido']} /><Bar dataKey="spend" fill="#2563eb" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div></ChartCard>}</section>
    <section aria-labelledby="supplier-compliance-title"><h3 id="supplier-compliance-title" className="mb-2 font-semibold">Cumplimiento operativo</h3><div className="grid gap-4 xl:grid-cols-2">
      {pendingRows.length > 0 && <ChartCard title="Proporción de pedidos por proveedor" description="Composición porcentual de pedidos pendientes y recibidos; los conteos absolutos se conservan en el listado."><div className="h-56"><ResponsiveContainer width="100%" height="100%"><BarChart data={pendingRows} layout="vertical" stackOffset="expand" margin={{ left: 16, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" domain={[0, 1]} tickFormatter={value => `${numberText(chartNumeric(value) == null ? null : (chartNumeric(value) as number) * 100)}%`} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={(_value, name, item) => { const count = name === 'pending' ? item?.payload?.pendingCount : item?.payload?.receivedCount; const total = (item?.payload?.pendingCount ?? 0) + (item?.payload?.receivedCount ?? 0); return [`${numberText(count)} pedidos · ${total > 0 ? `${numberText((count / total) * 100)}%` : 'No disponible'}`, name === 'pending' ? 'Pendientes' : 'Recibidos']; }} /><Bar dataKey="pending" name="pending" stackId="orders" fill="#d97706" /><Bar dataKey="received" name="received" stackId="orders" fill="#0f766e" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div><p className="text-xs text-muted-foreground">Naranja: pendientes · verde azulado: recibidos. Se muestran solo proveedores con ambos conteos conocidos.</p></ChartCard>}
      {leadRows.length > 0 && <ChartCard title="Tiempo de entrega"><div className="h-52"><ResponsiveContainer width="100%" height="100%"><BarChart data={leadRows} layout="vertical" margin={{ left: 16, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" unit=" días" /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [`${numberText(chartNumeric(value))} días`, 'Tiempo promedio observado']} /><Bar dataKey="lead" fill="#7c3aed" /></BarChart></ResponsiveContainer></div><p className="text-xs text-muted-foreground">Menor tiempo de entrega implica mayor rapidez operativa.</p></ChartCard>}
      {punctualRows.length > 0 && <div className={complianceCardCount % 2 === 1 ? 'xl:col-span-2' : undefined}><ChartCard title="Puntualidad de entrega"><div className="h-52"><ResponsiveContainer width="100%" height="100%"><BarChart data={punctualRows} layout="vertical" margin={{ left: 16, right: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" domain={[0, 100]} tickFormatter={value => `${numberText(chartNumeric(value))}%`} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [`${numberText(chartNumeric(value))}%`, 'Puntualidad observada']} /><Bar dataKey="punctuality" fill="#0f766e" /></BarChart></ResponsiveContainer></div><p className="text-xs text-muted-foreground">Mayor porcentaje implica mayor cumplimiento de entrega.</p></ChartCard></div>}</div></section>
    <section aria-labelledby="supplier-list-title"><div className="mb-2 flex flex-wrap items-end justify-between gap-2"><div><h3 id="supplier-list-title" className="font-semibold">Listado de proveedores</h3><p className="text-xs text-muted-foreground">El control solo expande los proveedores que ya llegaron en la respuesta cargada.</p></div>{items.length > 6 && <Button type="button" size="sm" variant="outline" onClick={() => setShowAllSuppliers(value => !value)}>{showAllSuppliers ? 'Mostrar Top 6' : 'Ver todos los proveedores'}</Button>}</div>
    <div className="overflow-hidden rounded-lg border"><table className="block w-full text-sm xl:table xl:table-fixed"><thead className="hidden xl:table-header-group"><tr className="bg-muted/50 text-left text-muted-foreground">{['Proveedor', 'Gasto', 'Pedidos', 'Pendientes', 'Recibidos', 'Lead time', 'Puntualidad'].map(header => <th scope="col" key={header} className="break-words px-2 py-2 font-medium">{header}</th>)}</tr></thead><tbody className="block xl:table-row-group">{visibleItems.map(row => {
      const lead = objectNumber(row.leadTime, ['averageDays', 'days', 'meanDays']);
      const punctuality = objectNumber(row.punctuality, ['onTimeRatePct']);
      const cells: Array<[string, React.ReactNode]> = [
        ['Proveedor', supplierDetailButton(row)], ['Gasto', moneyText(row.spend)], ['Pedidos', numberText(row.orders)],
        ['Pendientes', numberText(row.pending)], ['Recibidos', numberText(row.received)],
        ['Lead time', lead == null ? statusText(row.leadTimeAvailability) : `${numberText(lead)} días`],
        ['Puntualidad', punctuality == null ? 'No disponible' : `${numberText(punctuality)}%`],
      ];
      return <tr key={row.supplierId || row.name || 'supplier'} className="mb-3 block rounded-xl border bg-card p-3 last:mb-0 xl:mb-0 xl:table-row xl:rounded-none xl:border-0 xl:border-t xl:bg-transparent xl:p-0">{cells.map(([label, value]) => <td key={label} className="flex justify-between gap-3 border-t py-1.5 first:border-0 xl:table-cell xl:border-t-0 xl:px-2 xl:py-2 xl:align-top"><span className="shrink-0 text-xs text-muted-foreground xl:hidden">{label}</span><span className="min-w-0 break-words text-right xl:text-left">{value}</span></td>)}</tr>;
    })}</tbody></table></div>
    {items.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No hay proveedores para mostrar.</p>}</section>
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
  const domains = Object.entries(data.domains || {});
  const domainByKey = data.domains as Record<string, BusinessHealthAnalytics['domains'][keyof BusinessHealthAnalytics['domains']] | undefined>;
  const advancedKeys = ['forecast', 'marketBasket'];
  const operationalKeys = ['sales', 'inventory', 'customers', 'suppliers', 'margin'];
  const componentCounts = domains.reduce((counts, [, domain]) => {
    const bucket = healthStatusBucket(domain.status, domain.freshness);
    if (bucket) counts[bucket] += 1;
    return counts;
  }, { available: 0, partial: 0, unavailable: 0 });
  const canSummarizeComponents = domains.length > 0 && domains.every(([, domain]) => healthStatusBucket(domain.status, domain.freshness) !== null);
  const observations = [...new Set((data.insights || []).map(insightText).filter((text): text is string => Boolean(text)))].slice(0, 5);
  const attentionDomains = domains.filter(([, domain]) => ['partial', 'unavailable'].includes(healthStatusBucket(domain.status, domain.freshness) || ''));
  const renderDomain = (key: string, domain: BusinessHealthAnalytics['domains'][keyof BusinessHealthAnalytics['domains']]) => {
    const entries = domain.metrics ? healthEntries(domain.metrics) : [];
    const curated = healthSummaryEntries(key, domain.metrics || {}, entries);
    const bucket = healthStatusBucket(domain.status, domain.freshness);
    const forecastMethod = String(domain.metrics?.source || domain.metrics?.forecastSource || '');
    const label = key === 'forecast' ? forecastMethod === 'RIDGE_CAUSAL27' ? 'Pronóstico Ridge' : 'Pronóstico' : key === 'marketBasket' ? 'FP-Growth · reglas de asociación' : domainLabels[key] || key;
    const freshness = domain.freshness;
    const reason = domainReason(domain.metrics);
    return <article key={key} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="min-w-0 font-semibold">{label}</h4><Badge variant="outline">{healthStatusLabel(domain.status)}</Badge></div>
      {freshness && <p className="mt-1 text-xs text-muted-foreground">{freshness.mode === 'FROZEN' ? 'Histórico' : statusText(String(freshness.mode || freshness.status || ''))}{freshness.cutoff ? ` · corte ${dateText(String(freshness.cutoff))}` : ''}</p>}
      {key === 'margin' && bucket !== 'available' && <p className="mt-2 text-sm text-muted-foreground">{reason || 'El contrato no expone una causa más específica para la disponibilidad del margen en este período.'}</p>}
      {curated.length > 0 ? <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">{curated.map(({ label: metricLabel, value }) => <div key={metricLabel} className="min-w-0"><dt className="text-xs text-muted-foreground">{metricLabel}</dt><dd className="break-words font-medium">{value}</dd></div>)}</dl>
        : key !== 'margin' && <p className="mt-2 text-sm text-muted-foreground">No hay indicadores resumidos disponibles en esta respuesta.</p>}
      {key === 'marketBasket' && <p className="mt-2 text-xs text-muted-foreground">Las reglas describen asociaciones históricas; no implican causalidad.</p>}
      {key === 'forecast' && Array.isArray(domain.metrics?.horizons) && domain.metrics.horizons.some(value => value === 1) && <p className="mt-2 text-xs text-muted-foreground">El horizonte de 1 día no está aprobado para Ridge LIVE.</p>}
      <details className="mt-3 border-t pt-2"><summary className="cursor-pointer text-sm font-medium text-primary">Ver detalles</summary>
        <div className="mt-2 space-y-2">
          {entries.length > 0 ? <dl className="space-y-2">{entries.map(({ label: metricLabel, value }, index) => <div key={`${metricLabel}-${index}`} className="flex min-w-0 justify-between gap-3 border-t pt-2 text-sm first:border-0 first:pt-0"><dt className="min-w-0 text-muted-foreground">{metricLabel}</dt><dd className="break-words text-right font-medium">{metricLabel === 'Horizontes disponibles' && key === 'forecast' ? approvedHorizonText(domain.metrics || {}) : value}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">No hay métricas adicionales en esta respuesta.</p>}
          {key === 'inventory' && domain.metrics && (domain.metrics.forecastExpectedUnitsNext1d !== undefined || (Array.isArray(domain.metrics.forecastHorizons) && domain.metrics.forecastHorizons.includes(1))) && <p className="text-xs text-muted-foreground">El dato de 1 día se conserva como referencia contractual histórica; no está aprobado como pronóstico Ridge LIVE.</p>}
          {reason && key !== 'margin' && <p className="text-sm text-muted-foreground">{reason}</p>}
          {domain.insights.map(insightText).filter((text): text is string => Boolean(text)).slice(0, 2).map((text, index) => <p key={`${key}-insight-${index}`} className="rounded-md bg-muted/50 p-2 text-sm">{text}</p>)}
        </div>
      </details>
    </article>;
  };
  const renderGroup = (title: string, keys: string[], description?: string) => {
    const items = keys.flatMap(key => domainByKey[key] ? [[key, domainByKey[key]!] as const] : []);
    if (!items.length) return null;
    return <section aria-label={title} className="space-y-2"><div><h3 className="text-sm font-semibold">{title}</h3>{description && <p className="text-xs text-muted-foreground">{description}</p>}</div><div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map(([key, domain]) => renderDomain(key, domain))}</div></section>;
  };

  return <div className="space-y-5">
    <section aria-label="Estado general" className="rounded-xl border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Estado general del sistema analítico</p><p className="mt-1 text-xl font-semibold">{healthStatusLabel(data.status)}</p></div>
        <div className="text-sm text-muted-foreground"><p>Período: {dateText(data.period.startDate)} – {dateText(data.period.endDate)}</p><p>Datos hasta: {dateText(data.dataThrough || data.asOf)}</p>
          {data.updatedAt && <p>Última actualización: {dateTimeText(data.updatedAt)}</p>}{data.dataVersion != null && <p>Revisión: {data.dataVersion}</p>}</div></div>
      {canSummarizeComponents && <p className="mt-3 border-t pt-2 text-sm text-muted-foreground">Componentes disponibles: {componentCounts.available} · parciales: {componentCounts.partial} · no disponibles: {componentCounts.unavailable}</p>}
    </section>
    {String(data.status).toUpperCase() === 'PARTIAL' && <section aria-labelledby="health-attention-title" className="rounded-xl border border-amber-300/70 bg-amber-50/60 p-3 dark:bg-amber-950/20"><h3 id="health-attention-title" className="font-semibold">Requiere atención</h3>
      {attentionDomains.length ? <ul className="mt-2 grid gap-2 sm:grid-cols-2">{attentionDomains.map(([key, domain]) => <li key={key} className="rounded-lg border bg-background/70 p-2"><div className="flex items-center justify-between gap-2"><strong className="text-sm">{domainLabels[key] || key}</strong><Badge variant="outline">{healthStatusLabel(domain.status)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{domainReason(domain.metrics) || 'La respuesta indica disponibilidad parcial o no disponible, pero no expone una causa específica.'}</p></li>)}</ul>
        : <p className="mt-1 text-sm text-muted-foreground">El estado global es parcial; la respuesta no identifica un dominio específico para esta condición.</p>}</section>}
    {renderGroup('Modelos y analítica avanzada', advancedKeys, 'Estados y métricas expuestos por el diagnóstico Health; no se ejecutan modelos desde esta vista.')}
    {renderGroup('Capas operacionales', operationalKeys)}
    <p className="text-xs text-muted-foreground">Este contrato no incluye estados independientes de K-Means o Isolation Forest; no se solicitan datos adicionales desde Salud.</p>
    {observations.length > 0 && <section aria-labelledby="health-observations-title"><h3 id="health-observations-title" className="mb-2 text-sm font-semibold">Observaciones y limitaciones</h3><ul className="list-disc space-y-1 pl-5 text-sm">{observations.map((text, index) => <li key={`${text}-${index}`}>{text}</li>)}</ul></section>}
    <details className="rounded-xl border p-3"><summary className="cursor-pointer font-medium">Ver diagnóstico completo</summary><div className="mt-3 space-y-4">
      <dl className="grid gap-2 rounded-lg bg-muted/30 p-3 text-sm sm:grid-cols-2">{[
        ['Versión de Health', data.engineVersion], ['Fuente', data.source], ['Revisión', data.dataVersion],
        ['Política de completitud', (data as BusinessHealthAnalytics & { healthCompletenessPolicyVersion?: string }).healthCompletenessPolicyVersion],
      ].filter(([, value]) => value != null).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words">{String(value)}</dd></div>)}</dl>
      {Array.isArray((data as BusinessHealthAnalytics & { blockingReasons?: string[] }).blockingReasons) && (data as BusinessHealthAnalytics & { blockingReasons?: string[] }).blockingReasons!.length > 0 && <div><h3 className="text-sm font-semibold">Códigos técnicos de bloqueo</h3><ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">{(data as BusinessHealthAnalytics & { blockingReasons: string[] }).blockingReasons.map((code, index) => <li key={`${code}-${index}`}>{code}</li>)}</ul></div>}
      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">{domains.map(([key, domain]) => <article key={`diagnostic-${key}`} className="min-w-0 rounded-lg border p-3"><h3 className="font-medium">{domainLabels[key] || key} · {healthStatusLabel(domain.status)}</h3>{domain.freshness && <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">{healthFreshnessEntries(domain.freshness).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}</dl>}
        {domain.metrics && <dl className="mt-2 space-y-1">{healthEntries(domain.metrics).map(({ label, value }, index) => <div key={`${label}-${index}`} className="flex justify-between gap-2 border-t pt-1 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="text-right">{label === 'Horizontes disponibles' && key === 'forecast' ? approvedHorizonText(domain.metrics || {}) : value}</dd></div>)}</dl>}
        {domain.insights.map(insightText).filter((text): text is string => Boolean(text)).map((text, index) => <p key={`${key}-diagnostic-${index}`} className="mt-2 text-xs">{text}</p>)}</article>)}</div>
    </div></details>
  </div>;
}

function approvedHorizonText(metrics: Record<string, unknown>): string {
  const raw = Array.isArray(metrics.horizons) ? metrics.horizons : Array.isArray(metrics.forecastHorizons) ? metrics.forecastHorizons : [];
  const approved = raw.filter((value): value is number => value === 7 || value === 14);
  return approved.length === 2 ? '7 y 14 días' : approved.map(days => `${days} días`).join(' · ') || 'No disponible';
}

function healthFreshnessEntries(freshness: Record<string, unknown>): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['Modo', 'mode'], ['Estado de vigencia', 'status'], ['Fecha de corte', 'cutoff'], ['Datos hasta', 'dataThrough'],
    ['Actualizado', 'updatedAt'], ['Modelo Ridge 7d', 'modelVersion7'], ['Modelo Ridge 14d', 'modelVersion14'],
  ];
  return fields.flatMap(([label, key]) => {
    const value = freshness[key];
    if (value == null || value === '') return [];
    return [[label, key === 'cutoff' || key === 'dataThrough' ? dateText(String(value)) : key === 'updatedAt' ? dateTimeText(String(value)) : String(value)]];
  });
}

function healthSummaryEntries(key: string, metrics: Record<string, unknown>, entries: Array<{ label: string; value: string }>): Array<{ label: string; value: string }> {
  const labels: Record<string, string[]> = {
    sales: ['Ingresos', 'Unidades vendidas', 'Tickets', 'Ticket promedio'],
    margin: ['Margen bruto', 'Margen bruto (%)', 'Líneas con costo conocido', 'Líneas sin costo conocido'],
    inventory: ['Productos', 'Productos analizados', 'Productos con stock bajo', 'Disponibilidad del pronóstico'],
    customers: ['Clientes registrados', 'Clientes en riesgo', 'Clientes inactivos', 'Clientes nuevos'],
    suppliers: ['Proveedores', 'Pedidos pendientes', 'Pedidos recibidos', 'Gasto recibido'],
    forecast: ['Método de pronóstico', 'Horizontes disponibles', 'Pronósticos disponibles', 'Pronósticos no disponibles'],
    marketBasket: ['Versión del análisis', 'Corte del análisis', 'Reglas estables de venta cruzada', 'Reglas útiles'],
  };
  const selected = (labels[key] || []).flatMap(label => {
    const entry = entries.find(row => row.label === label || row.label.endsWith(` · ${label}`));
    return entry ? [{ label, value: label === 'Horizontes disponibles' ? approvedHorizonText(metrics) : entry.value }] : [];
  });
  if (key === 'forecast' && !selected.some(row => row.label === 'Método de pronóstico') && metrics.source === 'RIDGE_CAUSAL27') selected.unshift({ label: 'Método', value: 'RIDGE_CAUSAL27' });
  return selected.slice(0, 4);
}

function domainReason(metrics: Record<string, unknown> | null): string | null {
  if (!metrics) return null;
  const reason = metrics.availabilityReason || metrics.reasonCode || metrics.reason;
  if (typeof reason !== 'string' || !reason.trim()) return null;
  const known: Record<string, string> = {
    ARTIFACT_UNAVAILABLE: 'El artefacto analítico requerido no está disponible.',
    INSUFFICIENT_HISTORY: 'El historial disponible es insuficiente para este análisis.',
    CUSTOMER_HISTORICAL_COST_COVERAGE_INCOMPLETE: 'La cobertura de costos históricos está incompleta; afecta las métricas de margen.',
    COST_COVERAGE_INCOMPLETE: 'La cobertura de costos está incompleta; no se presenta un margen total.',
  };
  return known[reason] || null;
}
