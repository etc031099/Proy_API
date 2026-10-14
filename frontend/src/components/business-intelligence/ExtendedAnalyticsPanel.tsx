'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type {
  AssociationsAnalytics, BusinessHealthAnalytics, CustomerAnalyticsDetail, CustomersAnalytics,
  InventorySummary, RelatedProductAnalytics, SalesAnalytics, SalesPeriod, SupplierAnalyticsDetail, SuppliersAnalytics,
} from '@/types/businessIntelligence';

export type ExtendedTab = 'sales' | 'customers' | 'suppliers' | 'related' | 'health';
type LoadStatus = 'loading' | 'ready' | 'error';
type AnalyticsData = SalesAnalytics | CustomersAnalytics | SuppliersAnalytics | AssociationsAnalytics | BusinessHealthAnalytics;

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
  return <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-muted-foreground">{headers.map(header => <th key={header} className="px-3 py-2 font-medium">{header}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index} className="border-b last:border-0">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top">{cell}</td>)}</tr>)}</tbody></table></div>;
}

export function ExtendedAnalyticsPanel({ tab, inventory }: { tab: ExtendedTab; inventory: InventorySummary | null }) {
  const [period, setPeriod] = useState<SalesPeriod>('TODAY');
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [message, setMessage] = useState('');
  const [data, setData] = useState<AnalyticsData | null>(null);
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

  useEffect(() => {
    let current = true;
    setStatus('loading'); setMessage(''); setData(null); setCustomerDetail(null); setSupplierDetail(null);
    setDetailStatus('ready'); setDetailMessage(''); setSelectedDetail(null);
    const request = tab === 'sales' ? apiClient.getSalesAnalytics({ period, includeSeries: true, compare: true, limit: 10 })
      : tab === 'customers' ? apiClient.getCustomersAnalytics({ limit: 20, offset: 0 })
      : tab === 'suppliers' ? apiClient.getSuppliersAnalytics({ period, limit: 20, offset: 0 })
      : tab === 'related' ? apiClient.getAssociations({ limit: 10, offset: 0 })
      : apiClient.getBusinessHealth({ period, limit: 5 });
    void request.then(response => {
      if (!current) return;
      if (!response.success || !response.data) throw new Error('No se recibió un contrato de analítica.');
      setData(response.data as AnalyticsData); setStatus('ready');
    }).catch(error => { if (current) { setData(null); setMessage(errorLabel(error)); setStatus('error'); } });
    return () => { current = false; };
  }, [tab, period, reload]);

  const selectedSku = sku || inventory?.items[0]?.sku || '';
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
    setSelectedDetail({ kind, ref });
    setDetailStatus('loading'); setDetailMessage(''); setCustomerDetail(null); setSupplierDetail(null);
    try {
      if (kind === 'customer') {
        const response = await apiClient.getCustomerAnalytics(ref);
        if (!response.success || !response.data) throw new Error('No se recibió el detalle del cliente.');
        setCustomerDetail(response.data);
      } else {
        const response = await apiClient.getSupplierAnalytics(ref);
        if (!response.success || !response.data) throw new Error('No se recibió el detalle del proveedor.');
        setSupplierDetail(response.data);
      }
      setDetailStatus('ready');
    } catch (error) { setDetailMessage(errorLabel(error)); setDetailStatus('error'); }
  };
  const retry = () => setReload(value => value + 1);
  const retryDetail = () => {
    if (selectedDetail) void openDetail(selectedDetail.kind, selectedDetail.ref);
  };
  const freshness = data && 'mode' in data ? `${data.mode === 'LIVE' ? 'En vivo' : 'Histórico'}${data.dataThrough ? ` · Datos hasta ${data.dataThrough}` : ''}` : null;

  if (tab === 'related') {
    const basket = data && 'cutoff' in data ? data as AssociationsAnalytics : null;
    return <div className="space-y-4"><Card><CardHeader><CardTitle>Análisis de cesta de compra</CardTitle><CardDescription>Estado histórico/congelado · Cutoff: 12 oct. 2026</CardDescription></CardHeader><CardContent className="space-y-3">
      <DataState status={status} message={message} onRetry={retry} />{basket && <><p className="text-sm">Estado: {basket.mode} · cutoff {basket.cutoff} · No representa causalidad.</p>
        <Table headers={['Antecedente → consecuente', 'Support', 'Confidence', 'Lift', 'Tickets', 'Estabilidad']} empty={basket.available ? 'No hay reglas para mostrar.' : 'El artifact congelado no tiene reglas disponibles.'} rows={basket.items.map(rule => [`${rule.antecedentProducts.map(item => String(item.name || item.sku || '')).join(', ') || rule.antecedent.join(', ')} → ${rule.consequentProducts.map(item => String(item.name || item.sku || '')).join(', ') || rule.consequent.join(', ')}`, numberText(rule.support), numberText(rule.confidence), numberText(rule.lift), numberText(rule.ticketCount), rule.stability || rule.status || 'No disponible'])} />
      </>}</CardContent></Card><Card><CardHeader><CardTitle>Productos relacionados por SKU</CardTitle><CardDescription>Recomendaciones de cross-sell desde el artifact congelado; no se recalculan en la interfaz.</CardDescription></CardHeader><CardContent className="space-y-3">
        {inventory?.items.length ? <label className="flex flex-wrap items-center gap-2 text-sm">Producto<select aria-label="SKU del producto" className="max-w-full rounded-md border bg-background px-2 py-1.5" value={selectedSku} onChange={event => setSku(event.target.value)}>{inventory.items.map(item => <option key={item.sku} value={item.sku}>{item.productName} · {item.sku}</option>)}</select></label> : <p className="text-sm text-muted-foreground">No hay SKU disponible en el ranking actual para consultar.</p>}
        <DataState status={relatedStatus} message={relatedMessage} onRetry={retry} />{related && <><p className="text-sm">Fuente: <strong>{related.sourceProduct.name}</strong> ({related.sourceProduct.sku}) · {related.mode} · cutoff {related.cutoff}</p>
          <Table headers={['Producto relacionado', 'Support', 'Confidence', 'Lift', 'Evidencia', 'Estado']} empty={related.available ? 'No hay recomendaciones relacionadas para este SKU.' : 'El artifact congelado no tiene recomendaciones disponibles.'} rows={related.items.map(item => [<>{item.relatedProduct.name || 'Producto relacionado'}<span className="block text-xs text-muted-foreground">{item.relatedProduct.sku || ''}</span></>, numberText(item.support), numberText(item.confidence), numberText(item.lift), numberText(item.ticketCount), item.stability || item.classification || 'No disponible'])} />
        </>}
      </CardContent></Card></div>;
  }

  const title: Record<Exclude<ExtendedTab, 'related'>, string> = { sales: 'Ventas', customers: 'Clientes', suppliers: 'Proveedores', health: 'Salud del negocio' };
  return <Card><CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3"><div><CardTitle>{title[tab]}</CardTitle><CardDescription>{freshness || 'Analítica V3 autenticada del negocio'}</CardDescription></div>{['sales', 'suppliers', 'health'].includes(tab) && <PeriodSelect value={period} onChange={setPeriod} />}</CardHeader><CardContent className="space-y-5">
    <DataState status={status} message={message} onRetry={retry} />
    {tab === 'sales' && data && 'summary' in data && <SalesView data={data as SalesAnalytics} />}
    {tab === 'customers' && data && 'items' in data && <CustomersView data={data as CustomersAnalytics} detail={customerDetail} detailStatus={detailStatus} detailMessage={detailMessage} onSelect={ref => void openDetail('customer', ref)} onRetry={retryDetail} />}
    {tab === 'suppliers' && data && 'items' in data && <SuppliersView data={data as SuppliersAnalytics} detail={supplierDetail} detailStatus={detailStatus} detailMessage={detailMessage} onSelect={ref => void openDetail('supplier', ref)} onRetry={retryDetail} />}
    {tab === 'health' && data && 'domains' in data && <HealthView data={data as BusinessHealthAnalytics} />}
  </CardContent></Card>;
}

function SalesView({ data }: { data: SalesAnalytics }) {
  const values = data.summary;
  return <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[
    ['Ingresos', moneyText(values.revenue)], ['Unidades', numberText(values.units)], ['Tickets', numberText(values.tickets)],
    ['Ticket promedio', moneyText(values.averageTicket)], ['Margen bruto', `${moneyText(values.grossMargin)} · ${values.grossMargin.availability}`],
  ].map(([label, value]) => <div className="rounded-lg border p-3" key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-semibold">{value}</p></div>)}</div>
    <p className="text-xs text-muted-foreground">{data.period.startDate} – {data.period.endDate} · Serie: {data.seriesStatus} · Margen: {data.grossMarginAvailability}</p>
    <Table headers={['Fecha', 'Ingresos', 'Unidades', 'Tickets', 'Estado']} empty={data.series === null ? 'La serie no fue solicitada.' : 'No hay puntos diarios para el período.'} rows={(data.series || []).map(point => [point.date, moneyText(point.revenue), numberText(point.units), numberText(point.tickets), point.status])} />
    <div className="grid gap-5 xl:grid-cols-2"><Ranking title="Productos principales" rows={data.rankings.topProducts} /><Ranking title="Categorías principales" rows={data.rankings.topCategories} /></div>
  </div>;
}
function Ranking({ title, rows }: { title: string; rows: Array<Record<string, unknown>> }) {
  return <section className="space-y-2"><h3 className="font-medium">{title}</h3><Table headers={['Nombre', 'Ingresos', 'Unidades', 'Tickets']} empty="Sin resultados para este período." rows={rows.map(row => [String(row.name || row.category || row.sku || 'No disponible'), moneyText(row.revenue as SalesAnalytics['summary']['revenue']), numberText(row.units as number | null), numberText(row.tickets as number | null)])} /></section>;
}
function CustomersView({ data, detail, detailStatus, detailMessage, onSelect, onRetry }: { data: CustomersAnalytics; detail: CustomerAnalyticsDetail | null; detailStatus: LoadStatus; detailMessage: string; onSelect: (ref: string) => void; onRetry: () => void }) {
  return <div className="space-y-5"><div className="flex flex-wrap gap-2 text-sm">{[['Registrados', data.summary.totalRegistered], ['Activos', data.summary.active], ['Nuevos', data.summary.new], ['En riesgo', data.summary.atRisk], ['Alto valor', data.summary.highValue]].map(([label, count]) => <span key={String(label)} className="rounded-md bg-muted px-3 py-2">{label}: {numberText(count as number | null)}</span>)}</div>
    <p className="text-xs text-muted-foreground">Consumer Final incluido como cliente RFM individual: {data.summary.consumerFinalIncludedInIndividualRfm ? 'Sí' : 'No'}.</p>
    <div className="space-y-2">{data.items.length ? data.items.map(row => <button key={row.customerId || row.displayName} type="button" disabled={!row.customerId} onClick={() => row.customerId && onSelect(row.customerId)} className="block w-full rounded-md border px-3 py-2 text-left hover:bg-muted/50 disabled:opacity-60"><span className="font-medium">{row.displayName || 'Cliente'}</span><span className="ml-2 text-xs text-muted-foreground">{row.segment || 'Segmento no disponible'} · gasto {moneyText(row.spend)} · frecuencia {numberText(row.frequency)}</span></button>) : <p className="text-sm text-muted-foreground">No hay clientes RFM para mostrar.</p>}</div>
    <DataState status={detailStatus} message={detailMessage} onRetry={onRetry} />{detail && <DetailCard title={detail.item.displayName || 'Detalle de cliente'} status={detail.status} data={{ segmento: detail.item.segment, recencia: detail.item.recency, frecuencia90d: detail.item.frequency, monetario90d: moneyText(detail.item.monetary), gastoVida: moneyText(detail.item.spend), ticketPromedio: moneyText(detail.item.averageTicket), disponibilidad: detail.historyAvailability }} />}
  </div>;
}
function SuppliersView({ data, detail, detailStatus, detailMessage, onSelect, onRetry }: { data: SuppliersAnalytics; detail: SupplierAnalyticsDetail | null; detailStatus: LoadStatus; detailMessage: string; onSelect: (ref: string) => void; onRetry: () => void }) {
  return <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Proveedores', data.summary.totalSuppliers], ['Gasto recibido', moneyText(data.summary.totalSpend)], ['Órdenes pendientes', data.summary.pendingOrders], ['Órdenes recibidas', data.summary.receivedOrders]].map(([label, value]) => <div className="rounded-lg border p-3" key={String(label)}><p className="text-xs text-muted-foreground">{label}</p><p className="font-semibold">{typeof value === 'number' ? numberText(value) : value}</p></div>)}</div>
    <div className="space-y-2">{data.items.length ? data.items.map(row => <button key={row.supplierId || row.name} type="button" disabled={!row.supplierId} onClick={() => row.supplierId && onSelect(row.supplierId)} className="block w-full rounded-md border px-3 py-2 text-left hover:bg-muted/50 disabled:opacity-60"><span className="font-medium">{row.name || 'Proveedor'}</span><span className="ml-2 text-xs text-muted-foreground">gasto {moneyText(row.spend)} · órdenes {numberText(row.orders)} · lead time {numberText(row.leadTime?.averageDays as number | null)} días ({row.leadTimeAvailability})</span></button>) : <p className="text-sm text-muted-foreground">No hay proveedores para mostrar.</p>}</div>
    <DataState status={detailStatus} message={detailMessage} onRetry={onRetry} />{detail && <DetailCard title={detail.item.name || 'Detalle de proveedor'} status={detail.status} data={{ gastoRecibido: moneyText(detail.item.spend), órdenes: detail.item.orders, pendientes: detail.item.pending, recibidas: detail.item.received, leadTime: detail.item.leadTime, puntualidad: detail.item.punctuality, dependencia: detail.item.dependency, costTrends: detail.item.costTrends, disponibilidad: detail.historyAvailability }} />}
  </div>;
}
function HealthView({ data }: { data: BusinessHealthAnalytics }) {
  const rows = useMemo(() => Object.entries(data.domains).map(([domain, value]) => [domain, value.status, value.freshness ? String(value.freshness.mode || value.freshness.status || 'No disponible') : 'No disponible', value.metrics ? 'Disponible' : 'No disponible']), [data]);
  return <div className="space-y-4"><p className="text-sm">Estado general: {data.status} · Período {data.period.startDate} – {data.period.endDate}. No se calcula un score global.</p><Table headers={['Dominio', 'Estado', 'Frescura', 'Métricas']} empty="No hay dominios disponibles." rows={rows} />
    {data.insights.length > 0 && <section><h3 className="mb-2 font-medium">Insights del motor</h3><ul className="list-disc space-y-1 pl-5 text-sm">{data.insights.map((item, index) => <li key={index}>{String(item.message || item.code || 'Insight disponible')}</li>)}</ul></section>}</div>;
}
function DetailCard({ title, status, data }: { title: string; status: string; data: Record<string, unknown> }) {
  const rows = Object.entries(data).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? 'No disponible')]);
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>Estado: {status}</CardDescription></CardHeader><CardContent><Table headers={['Campo', 'Valor']} rows={rows} empty="Sin detalle disponible." /></CardContent></Card>;
}
