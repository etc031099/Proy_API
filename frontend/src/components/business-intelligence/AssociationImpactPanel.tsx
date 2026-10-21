'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AssociationsAnalytics } from '@/types/businessIntelligence';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FORECAST_IMPACT_CHANNEL, isForecastImpactSaleMessage, readLatestForecastImpactSale, type ForecastImpactSaleMessage } from '@/lib/forecastImpactChannel';
import { INVENTORY_IMPACT_CHANNEL, isInventoryImpactEvent, readLatestInventoryImpact, sameContext } from '@/lib/inventoryImpactChannel';
import { associationExplanation, makeAssociationImpact, readAssociationImpact, relatedAssociationRules, saveAssociationImpact, type AssociationImpactEvent } from '@/lib/associationImpact';

function latestSale(): ForecastImpactSaleMessage | null {
  const sale = readLatestForecastImpactSale();
  if (sale) return sale;
  const stored = readAssociationImpact();
  return stored ? { version: 2, type: 'SALE_COMPLETED', transactionId: stored.transactionId, occurredAt: stored.occurredAt,
    context: stored.businessContext, products: stored.products, baseline: null, baselineUnavailable: true,
    hasCustomer: false, customerRef: null } : null;
}
const formatted = (value: number | null | undefined, percent = false) => value == null ? 'No disponible'
  : `${new Intl.NumberFormat('es-PE', { maximumFractionDigits: 6 }).format(percent ? value * 100 : value)}${percent ? ' %' : ''}`;
const ruleTitle = (names: Array<string | Record<string, unknown>>, skus: string[]) => skus.map((sku, index) => typeof names[index] === 'string' ? names[index] : sku).join(' + ');

export function AssociationImpactPanel({ data, loading = false }: { data: AssociationsAnalytics | null; loading?: boolean }) {
  const [sale, setSale] = useState(latestSale);
  const [cancellation, setCancellation] = useState(readLatestInventoryImpact);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const sales = new BroadcastChannel(FORECAST_IMPACT_CHANNEL);
    const inventory = new BroadcastChannel(INVENTORY_IMPACT_CHANNEL);
    sales.onmessage = message => { if (isForecastImpactSaleMessage(message.data)) setSale(message.data); };
    inventory.onmessage = message => {
      if (isInventoryImpactEvent(message.data) && message.data.type === 'SALE_CANCELLED') setCancellation(message.data);
    };
    return () => { sales.close(); inventory.close(); };
  }, []);
  const event = useMemo<AssociationImpactEvent | null>(() => {
    if (!sale || !data) return null;
    const stored = readAssociationImpact();
    // Only a known same-transaction, same-scope cancellation invalidates this
    // temporary overlay. No cancellation lookup or historical subtraction runs.
    const cancelled = Boolean(sale.transactionId && (cancellation?.type === 'SALE_CANCELLED' && cancellation.operationId === sale.transactionId
      && sameContext(cancellation.context, sale.context)
      || stored?.status === 'CANCELLED' && stored.transactionId === sale.transactionId
      && sameContext(stored.businessContext, sale.context)));
    return makeAssociationImpact(sale, data, cancelled);
  }, [sale, data, cancellation]);
  useEffect(() => { if (event) saveAssociationImpact(event); }, [event]);
  const related = event ? relatedAssociationRules(event) : [];
  return <Card aria-label="Impacto de la última venta en asociaciones">
    <CardHeader className="pb-3"><CardTitle className="flex flex-wrap items-center gap-2">Impacto de la última venta en asociaciones <Badge variant="outline">PROVISIONAL</Badge></CardTitle>
      <CardDescription>Comparación del análisis histórico congelado con esta única cesta.</CardDescription></CardHeader>
    <CardContent className="space-y-4 text-sm">
      {!event ? <p className="text-muted-foreground">{sale ? !data
        ? loading ? 'Cargando evidencia histórica; la cesta de la venta se conserva.' : 'No se pudo cargar la evidencia histórica. La cesta se conserva.'
        : 'No se pudo confirmar el contexto de la comparación. La evidencia de la venta se conserva.'
        : 'Sin una venta reciente para comparar. Consumer Final también aporta una cesta.'}</p> : <>
        <section aria-label="Cesta de la venta"><h3 className="font-semibold">Cesta</h3>
          <p className="text-xs text-muted-foreground">{event.products.length} SKU únicos · 1 ticket · {new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(event.occurredAt))}</p>
          <ul className="mt-2 flex flex-wrap gap-2">{event.products.map(product => <li key={product.sku} className="rounded-md bg-muted/50 px-2 py-1">{product.name} · {product.sku} · {product.quantity} unidad(es)</li>)}</ul>
          <p className="mt-1 text-xs text-muted-foreground">La cantidad se muestra como contexto; cada SKU aporta presencia una sola vez.</p>
        </section>
        {event.status === 'CANCELLED' ? <p role="status">Venta cancelada: se invalida su contribución provisional. El histórico permanece intacto.</p> : <>
          <h3 className="font-semibold">Histórico congelado + esta cesta</h3>
          <p className="text-xs text-muted-foreground">Representa únicamente esta venta, no todas las ventas posteriores al corte.</p>
          {event.status === 'PARTIAL' && <p role="status">Comparación parcial: faltan conteos, identidad o una lectura completa; una venta dentro del corte histórico tampoco se añade otra vez. No se inventan métricas.</p>}
          {related.map((row, index) => <article key={`${row.historical.antecedent.join('|')}->${row.historical.consequent.join('|')}`} className="space-y-3 rounded-lg border p-3" aria-label={`Regla relacionada ${index + 1}`}>
            <h4 className="font-semibold">{ruleTitle(row.historical.antecedentProducts, row.historical.antecedent)} → {ruleTitle(row.historical.consequentProducts, row.historical.consequent)}</h4>
            <p className="text-xs">Antecedente: {row.presence.antecedent ? 'Sí' : 'No'} · Consecuente: {row.presence.consequent ? 'Sí' : 'No'} · Ambos: {row.presence.both ? 'Sí' : 'No'}</p>
            <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">{([
              ['Tickets históricos N', 'totalTickets'], ['Antecedente a', 'antecedentCount'], ['Consecuente b', 'consequentCount'], ['Coocurrencias j', 'jointCount'],
            ] as const).map(([label, key]) => <div key={key}><dt className="text-xs text-muted-foreground">{label}</dt><dd>{formatted(row.beforeCounts?.[key])} → {formatted(row.afterCounts?.[key])}</dd></div>)}</dl>
            <dl className="grid gap-2 sm:grid-cols-3">{(['support', 'confidence', 'lift'] as const).map(key => <div key={key}><dt className="text-xs text-muted-foreground">{key === 'support' ? 'Support' : key === 'confidence' ? 'Confidence' : 'Lift'} · histórico → provisional</dt><dd>{formatted(row.historical[key], key !== 'lift')} → {formatted(row.provisional?.[key], key !== 'lift')}</dd></div>)}</dl>
            <p className="text-xs text-muted-foreground">{associationExplanation(row)}</p>
          </article>)}
          {related.length === 0 && <p className="text-muted-foreground">No hay reglas históricas consultadas relacionadas con esta cesta.</p>}
          {event.hasUnruledCooccurrence && <p className="text-xs text-muted-foreground">Coocurrencia observada en esta venta; no corresponde a una regla del conjunto histórico consultado.</p>}
        </>}
        <section className="rounded-md bg-muted/40 p-3" aria-label="Identidad del análisis congelado"><p>Versión: {event.analysisVersion || 'No disponible'} · Corte: {event.cutoff}</p>
          <p>Artifact: {event.artifactIdentity ? `${event.artifactIdentity.slice(0, 12)}… · mismo análisis histórico BEFORE/AFTER` : 'No disponible'}</p>
          <p>FP-Growth ejecutado nuevamente: No</p>
          <details className="mt-2 break-all text-xs text-muted-foreground"><summary className="cursor-pointer">Detalles técnicos</summary><p>Identidad reproducible: {event.artifactIdentity || 'No disponible'}</p><p>Transacción: {event.transactionId || 'Sin referencia'}</p></details>
        </section>
      </>}
      <p className="text-xs text-muted-foreground">La venta aporta nueva evidencia, pero FP-Growth no se vuelve a ejecutar y las reglas históricas aprobadas permanecen congeladas.</p>
    </CardContent>
  </Card>;
}
