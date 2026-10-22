'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clearLatestSalesImpact, readLatestSalesImpact, SALES_IMPACT_CHANNEL, SALES_IMPACT_LOCAL_EVENT, saveLatestSalesImpact } from '@/lib/salesImpactChannel';
import { mayReplaceImpact } from '@/lib/operationImpactIdentity';
import { sameCustomerImpactContext } from '@/lib/customerImpactSnapshot';
import type { SalesImpactEvent, SalesImpactMoney, SalesImpactSnapshot } from '@/lib/salesImpactSnapshot';
import { isSalesImpactEvent } from '@/lib/salesImpactSnapshot';
import { SalesIsolationForestImpact } from './SalesIsolationForestImpact';

type ViewState = { event: SalesImpactEvent | null; verified: boolean; checking: boolean; message: string | null };
const numberText = (value: number | null) => value === null ? 'No disponible' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value);
function moneyText(value: SalesImpactMoney | null): string {
  if (value?.value === null || value?.value === undefined) return 'No disponible';
  const currency = value.currency && /^[A-Z]{3}$/.test(value.currency) ? value.currency : 'PEN';
  try { return new Intl.NumberFormat('es-PE', { style: 'currency', currency }).format(value.value); }
  catch { return `${numberText(value.value)} ${currency}`; }
}
function pair<T>(before: T | null | undefined, after: T | null | undefined, format: (value: T | null) => string): string {
  if (before == null && after == null) return 'No disponible';
  if (before == null) return `Actual: ${format(after ?? null)}`;
  if (after == null) return `BEFORE: ${format(before)}`;
  return `${format(before ?? null)} → ${format(after ?? null)}`;
}
function coverageText(snapshot: SalesImpactSnapshot | null): string {
  const coverage = snapshot?.costCoverage;
  if (!coverage || coverage.knownSaleLines === null || coverage.unknownSaleLines === null) return 'Cobertura de costos no disponible.';
  return `Costos registrados para ${numberText(coverage.knownSaleLines)} de ${numberText(coverage.knownSaleLines + coverage.unknownSaleLines)} líneas.`;
}

export function SalesImpactPanel() {
  const [state, setState] = useState<ViewState>({ event: null, verified: false, checking: false, message: null });
  const mounted = useRef(true);
  const verification = useRef(0);
  const verify = useCallback(async (event: SalesImpactEvent) => {
    const attempt = ++verification.current;
    setState({ event, verified: false, checking: true, message: null });
    if (!event.businessContext.businessId || !event.businessContext.scenarioId || !event.businessContext.datasetVersion) {
      if (mounted.current) setState({ event, verified: false, checking: false,
        message: 'Venta confirmada; esperando contexto verificable para la comparación.' });
      return;
    }
    try {
      const response = await apiClient.getIntelligenceRevision();
      if (!mounted.current || attempt !== verification.current) return;
      if (!response.success || !response.data) throw new Error('revision unavailable');
      const context = { businessId: response.data.businessId, scenarioId: response.data.scenarioId, datasetVersion: response.data.datasetVersion };
      if (!sameCustomerImpactContext(event.businessContext, context)) {
        clearLatestSalesImpact();
        if (mounted.current) setState({ event: null, verified: false, checking: false, message: null });
        return;
      }
      if (mounted.current) setState({ event, verified: true, checking: false, message: null });
    } catch {
      if (!mounted.current || attempt !== verification.current) return;
      saveLatestSalesImpact(event);
      if (mounted.current) setState({ event, verified: false, checking: false,
        message: 'No se pudo confirmar temporalmente el contexto. La comparación se conserva.' });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const saved = readLatestSalesImpact();
    if (saved) void verify(saved);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SALES_IMPACT_CHANNEL);
    if (channel) channel.onmessage = message => {
      const event = message.data as SalesImpactEvent;
      if (isSalesImpactEvent(event) && mayReplaceImpact(event, readLatestSalesImpact())) {
        saveLatestSalesImpact(event); void verify(event);
      }
    };
    const onLocalImpact = (message: Event) => { const event = (message as CustomEvent<unknown>).detail;
      if (isSalesImpactEvent(event) && mayReplaceImpact(event, readLatestSalesImpact())) { saveLatestSalesImpact(event); void verify(event); } };
    window.addEventListener(SALES_IMPACT_LOCAL_EVENT, onLocalImpact);
    return () => { mounted.current = false; channel?.close(); window.removeEventListener(SALES_IMPACT_LOCAL_EVENT, onLocalImpact); };
  }, [verify]);

  const event = state.event;
  if (!event) return <Card aria-label="Impacto comercial de la última venta" className="border-dashed">
    <CardContent className="flex flex-wrap items-center gap-2 py-4 text-sm text-muted-foreground">
      <Badge variant="outline">OPERACIONAL</Badge>
      <span>Sin una venta reciente para comparar. La próxima venta mostrará aquí su impacto comercial.</span>
    </CardContent>
  </Card>;

  const before = event.before, after = event.after;
  const commercialComparable = Boolean(before && after && before.period.startDate === after.period.startDate
    && before.period.endDate === after.period.endDate && before.dataVersion !== null && after.dataVersion !== null
    && after.dataVersion > before.dataVersion);
  const beforeMargin = before?.grossMarginAmount?.value != null;
  const afterMargin = after?.grossMarginAmount?.value != null;
  const formatMargin = (snapshot: SalesImpactSnapshot | null) => `${moneyText(snapshot?.grossMarginAmount || null)}${snapshot?.grossMarginPercent == null ? '' : ` · ${numberText(snapshot.grossMarginPercent)}%`}`;
  const marginAvailable = Boolean(commercialComparable && beforeMargin && afterMargin);
  const marginPair = marginAvailable ? `${formatMargin(before)} → ${formatMargin(after)}`
    : afterMargin ? `Actual: ${formatMargin(after)}` : beforeMargin ? `BEFORE: ${formatMargin(before)}` : 'No disponible';
  const metrics: Array<{ label: string; value: string; note?: string }> = [
    { label: 'Ingresos', value: pair(commercialComparable ? before?.revenue : null, after?.revenue, moneyText) },
    { label: 'Unidades', value: pair(commercialComparable ? before?.units : null, after?.units, numberText) },
    { label: 'Tickets', value: pair(commercialComparable ? before?.tickets : null, after?.tickets, numberText) },
    { label: 'Ticket promedio', value: pair(commercialComparable ? before?.averageTicket : null, after?.averageTicket, moneyText) },
    { label: 'Margen bruto', value: marginPair,
      note: marginAvailable ? undefined : `Antes: ${coverageText(before)} Después: ${coverageText(after)}` },
  ];

  return <Card aria-label="Impacto comercial de la última venta">
    <CardHeader className="space-y-1 pb-3"><div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">Impacto comercial de la última venta</CardTitle><Badge variant="outline">OPERACIONAL</Badge></div>
      <CardDescription>Comparación de las métricas del periodo antes y después de la operación.</CardDescription>
      <p className="text-xs text-muted-foreground">Venta {moneyText(event.saleTotal)} · {event.transactionId || 'sin referencia'} · {new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(event.occurredAt))}</p>
    </CardHeader>
    <CardContent className="space-y-3">
      {state.checking && <p role="status" className="text-xs text-muted-foreground">Verificando el contexto de la comparación…</p>}
      {state.message && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs"><span>{state.message}</span><button type="button" className="underline" onClick={() => void verify(event)}>Reintentar verificación</button></div>}
    {state.verified && <><h3 className="text-sm font-semibold">Cambios comerciales</h3>{(before || after) && <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">{metrics.map(metric => <div key={metric.label} className="min-w-0 rounded-lg border p-3">
        <p className="text-xs text-muted-foreground">{metric.label}</p><p className="mt-1 break-words text-sm font-semibold">{metric.value}</p>
        {metric.note && <p className="mt-1 text-xs text-muted-foreground">{metric.note}</p>}
      </div>)}</div>}{!commercialComparable && <p className="text-xs text-muted-foreground">La captura comercial es parcial; los valores disponibles se muestran como lecturas, no como diferencias verificadas.</p>}<SalesIsolationForestImpact before={event.isolationForestImpact?.before || null} after={event.isolationForestImpact?.after || null} /></>}
      {state.verified && event.captureStatus !== 'COMPLETE' && <p className="text-xs text-muted-foreground">
        {event.captureStatus === 'AFTER_PENDING' ? 'La venta se completó; se está capturando el estado posterior.' : 'Comparación parcial: uno o ambos momentos no pudieron capturarse.'}
      </p>}
    </CardContent>
  </Card>;
}
