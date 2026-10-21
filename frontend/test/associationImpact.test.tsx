import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import artifact from '../../ml/data/minimarket-pasco-v3-market-basket-v1.json';
import { apiClient } from '@/lib/api';
import { AssociationImpactPanel } from '@/components/business-intelligence/AssociationImpactPanel';
import { ExtendedAnalyticsPanel } from '@/components/business-intelligence/ExtendedAnalyticsPanel';
import { ASSOCIATION_IMPACT_KEY, associationExplanation, associationMetrics, compareAssociationRule,
  makeAssociationImpact, readAssociationImpact, relatedAssociationRules, saveAssociationImpact } from '@/lib/associationImpact';
import { FORECAST_IMPACT_SESSION_KEY, publishForecastImpactSale, type ForecastImpactSaleMessage } from '@/lib/forecastImpactChannel';
import { INVENTORY_IMPACT_SESSION_KEY } from '@/lib/inventoryImpactChannel';
import type { AssociationRule, AssociationsAnalytics } from '@/types/businessIntelligence';

const context = { businessId: 'MINIMARKET-PASCO-V3', scenarioId: 'minimarket-pasco-v3', datasetVersion: artifact.datasetVersion };
const key = (skus: string[]) => [...skus].sort().join('|');
const counts = new Map(artifact.frequentItemsets.map(row => [key(row.itemSkus), row.ticketCount]));
const historical: AssociationRule[] = artifact.rules.filter(row => row.classification === 'CROSS_SELL' && row.stability.status === 'STABLE').map(row => ({
  antecedent: row.antecedentSkus, consequent: row.consequentSkus, antecedentProducts: row.antecedentProducts,
  consequentProducts: row.consequentProducts, support: row.support, confidence: row.confidence, lift: row.lift,
  ticketCount: row.ticketCount, totalTickets: artifact.transactionCount, antecedentCount: counts.get(key(row.antecedentSkus))!,
  consequentCount: counts.get(key(row.consequentSkus))!, jointCount: row.ticketCount, stability: row.stability.status, status: row.classification,
}));
const rule = historical.find(row => row.ticketCount === 113)!;
const a = rule.antecedent[0], b = rule.consequent[0];
function data(): AssociationsAnalytics {
  return { asOf: artifact.cutoffDate, timezone: 'America/Lima', mode: 'FROZEN', updatedAt: null, dataThrough: null,
    freshness: { mode: 'FROZEN', cutoff: artifact.cutoffDate }, dataVersion: null, snapshotHash: null, source: 'CANONICAL_V3_BUNDLE',
    engineVersion: 'v3', cutoff: artifact.cutoffDate, businessContext: context, summary: { validTickets: artifact.transactionCount,
      analysisVersion: artifact.analysisVersion }, analysisVersion: artifact.analysisVersion, artifactIdentity: artifact.reproducibilitySha256,
    available: true, items: structuredClone(historical), total: 18, limit: 20, offset: 0 };
}
function sale(skus = [a, b]): ForecastImpactSaleMessage {
  return { version: 2, type: 'SALE_COMPLETED', transactionId: 'sale-1', occurredAt: '2026-10-20T18:00:00Z',
    context, products: skus.map(sku => ({ sku, name: `Producto ${sku}`, quantity: 1 })),
    hasCustomer: false, customerRef: null, baseline: null, baselineUnavailable: true };
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('one binary sale basket over frozen association evidence', () => {
  it.each([
    { skus: [a, b], da: 1, db: 1, dj: 1, case: 'both' },
    { skus: [a], da: 1, db: 0, dj: 0, case: 'antecedent only' },
    { skus: [b], da: 0, db: 1, dj: 0, case: 'consequent only' },
    { skus: ['OTHER'], da: 0, db: 0, dj: 0, case: 'neither' },
  ])('computes exact counts and full precision metrics for $case without changing historical values', ({ skus, da, db, dj }) => {
    const before = structuredClone(rule);
    const row = compareAssociationRule(rule, new Set(skus));
    expect(row.beforeCounts).toEqual({ totalTickets: 12647, antecedentCount: 596, consequentCount: 2030, jointCount: 113 });
    expect(row.afterCounts).toEqual({ totalTickets: 12648, antecedentCount: 596 + da, consequentCount: 2030 + db, jointCount: 113 + dj });
    expect(row.provisional).toEqual(associationMetrics(row.afterCounts!));
    expect(row.provisional!.support).toBe((113 + dj) / 12648);
    expect(row.provisional!.confidence).toBe((113 + dj) / (596 + da));
    expect(row.provisional!.lift).toBe((113 + dj) * 12648 / ((596 + da) * (2030 + db)));
    expect(rule).toEqual(before);
    expect(associationExplanation(row)).not.toContain('nueva regla');
  });

  it('includes Consumer Final, deduplicates repeated SKU and never weights presence by quantity', () => {
    const single = makeAssociationImpact(sale(), data())!;
    const multiple = sale([a, b, a]); multiple.products[0].quantity = 5;
    const event = makeAssociationImpact(multiple, data())!;
    expect(event.products).toHaveLength(2);
    expect(event.products.find(product => product.sku === a)?.quantity).toBe(6);
    expect(event.rules).toEqual(single.rules);
    expect(event.status).toBe('COMPLETE');
  });

  it('preserves a multi-SKU basket and prioritizes both, antecedent and consequent stably', () => {
    const event = makeAssociationImpact(sale([a, b, 'THIRD']), data())!;
    expect(event.products).toHaveLength(3);
    const related = relatedAssociationRules(event);
    expect(related[0].presence.both).toBe(true);
    expect(related.every(row => row.presence.antecedent || row.presence.consequent)).toBe(true);
    const bothEnd = related.findIndex(row => !row.presence.both);
    if (bothEnd !== -1) expect(related.slice(bothEnd).every(row => !row.presence.both)).toBe(true);
  });

  it('records unruled cooccurrence without discovering or adding a rule', () => {
    const event = makeAssociationImpact(sale(['UNSEEN-A', 'UNSEEN-B', 'UNSEEN-C']), data())!;
    expect(event.hasUnruledCooccurrence).toBe(true);
    expect(event.rules).toHaveLength(18);
    expect(relatedAssociationRules(event)).toEqual([]);
    expect(event.rules.every(row => row.afterCounts?.jointCount === row.beforeCounts?.jointCount)).toBe(true);
    expect(makeAssociationImpact(sale(['UNSEEN-A']), data())!.hasUnruledCooccurrence).toBe(false);
  });

  it('keeps missing integer counts partial rather than inferring them from support', () => {
    const source = data(); source.items[0].antecedentCount = null;
    const event = makeAssociationImpact(sale(), source)!;
    expect(event.status).toBe('PARTIAL');
    expect(event.rules[0].provisional).toBeNull();
    expect(event.rules[0].historical.support).toBe(source.items[0].support);
    const missingIdentity = makeAssociationImpact(sale(), { ...data(), artifactIdentity: null })!;
    expect(missingIdentity.rules.every(row => row.provisional === null)).toBe(true);
  });

  it('rejects inconsistent counts and historical metrics without replacing missing by zero', () => {
    expect(compareAssociationRule({ ...rule, ticketCount: 114 }, new Set([a, b])).provisional).toBeNull();
    expect(compareAssociationRule({ ...rule, support: .89 }, new Set([a, b])).provisional).toBeNull();
    expect(compareAssociationRule({ ...rule, antecedentCount: 0 }, new Set([a, b])).beforeCounts).toBeNull();
  });

  it('supports all-SKU antecedents and consequents using set inclusion', () => {
    const multi = { ...rule, antecedent: ['A', 'B'], consequent: ['C'] };
    expect(compareAssociationRule(multi, new Set(['A', 'C'])).presence).toEqual({ antecedent: false, consequent: true, both: false });
    expect(compareAssociationRule(multi, new Set(['A', 'B', 'C'])).presence.both).toBe(true);
  });

  it('excludes cancelled baskets and never subtracts them from historical N', () => {
    const event = makeAssociationImpact(sale(), data(), true)!;
    expect(event.status).toBe('CANCELLED');
    expect(event.rules.every(row => row.afterCounts === null && row.provisional === null)).toBe(true);
    expect(event.rules[0].beforeCounts!.totalTickets).toBe(12647);
  });

  it('does not add a sale already inside the historical cutoff or a foreign tenant', () => {
    expect(makeAssociationImpact({ ...sale(), occurredAt: '2026-10-12T18:00:00Z' }, data())!.rules.every(row => !row.provisional)).toBe(true);
    expect(makeAssociationImpact({ ...sale(), context: { ...context, businessId: 'OTHER' } }, data())).toBeNull();
    expect(makeAssociationImpact(sale(), { ...data(), items: data().items.slice(0, 10) })!.status).toBe('PARTIAL');
    const noReference = makeAssociationImpact({ ...sale(), transactionId: null }, data(), true)!;
    expect(noReference.status).toBe('PARTIAL');
    expect(noReference.rules.every(row => row.provisional === null)).toBe(true);
  });

  it('stores full evidence readably and revalidates temporary arithmetic on read', () => {
    const event = makeAssociationImpact(sale(), data())!;
    saveAssociationImpact(event);
    expect(readAssociationImpact()).toEqual(event);
    const corrupted = structuredClone(event); corrupted.rules[0].provisional!.support = 999;
    sessionStorage.setItem(ASSOCIATION_IMPACT_KEY, JSON.stringify(corrupted));
    expect(readAssociationImpact()!.rules[0].provisional!.support).toBe(event.rules[0].provisional!.support);
    const legacy = structuredClone(event); legacy.status = 'PARTIAL';
    legacy.rules.forEach(row => { delete row.historical.antecedentCount; });
    sessionStorage.setItem(ASSOCIATION_IMPACT_KEY, JSON.stringify(legacy));
    expect(readAssociationImpact()!.status).toBe('PARTIAL');
    expect(readAssociationImpact()!.rules.every(row => !row.provisional)).toBe(true);
  });

  it('repeated delivery of one transaction always represents one additional ticket', () => {
    const event = makeAssociationImpact(sale(), data())!;
    saveAssociationImpact(event);
    saveAssociationImpact(makeAssociationImpact(sale(), data())!);
    expect(readAssociationImpact()).toEqual(event);
    expect(readAssociationImpact()!.rules.every(row => row.afterCounts?.totalTickets === 12648)).toBe(true);
  });
});

describe('association impact and historical rules UI', () => {
  it('reuses an existing legacy sale event and renders all evidence without requests', async () => {
    const get = vi.spyOn(apiClient, 'getAssociations');
    sessionStorage.setItem(FORECAST_IMPACT_SESSION_KEY, JSON.stringify(sale()));
    render(<AssociationImpactPanel data={data()} />);
    expect(await screen.findByText('Histórico congelado + esta cesta')).toBeTruthy();
    expect(screen.getByText(/2 SKU únicos · 1 ticket/)).toBeTruthy();
    expect(screen.getByText(/596 → 597/)).toBeTruthy();
    expect(screen.getByText(/113 → 114/)).toBeTruthy();
    expect(screen.getByText(/mismo análisis histórico BEFORE\/AFTER/)).toBeTruthy();
    expect(screen.getByText('FP-Growth ejecutado nuevamente: No')).toBeTruthy();
    expect(readAssociationImpact()!.artifactIdentity).toBe(artifact.reproducibilitySha256);
    expect(get).not.toHaveBeenCalled();
  });

  it('renders a partial event and never invents provisional metrics', async () => {
    sessionStorage.setItem(FORECAST_IMPACT_SESSION_KEY, JSON.stringify(sale()));
    render(<AssociationImpactPanel data={{ ...data(), artifactIdentity: null }} />);
    expect(await screen.findByText(/Comparación parcial:/)).toBeTruthy();
    expect(screen.getAllByText(/→ No disponible/).length).toBeGreaterThan(0);
  });

  it('invalidates a known cancellation of the same sale via existing operation evidence', async () => {
    sessionStorage.setItem(FORECAST_IMPACT_SESSION_KEY, JSON.stringify(sale()));
    sessionStorage.setItem(INVENTORY_IMPACT_SESSION_KEY, JSON.stringify({ version: 1, type: 'SALE_CANCELLED', operationId: 'sale-1',
      occurredAt: '2026-10-20T19:00:00Z', reference: null, operationSucceeded: true, products: sale().products, context,
      baseline: { context, complete: true, capturedAt: '2026-10-20T18:00:00Z', products: {} },
      baselineStatus: 'AVAILABLE', after: null, afterUnavailable: true }));
    render(<AssociationImpactPanel data={data()} />);
    expect(await screen.findByText(/Venta cancelada: se invalida/)).toBeTruthy();
    expect(screen.queryByText('Histórico congelado + esta cesta')).toBeNull();
    expect(readAssociationImpact()!.status).toBe('CANCELLED');
  });

  it('shows Top 8 and all 18 in artifact order with exactly one existing read', async () => {
    const get = vi.spyOn(apiClient, 'getAssociations').mockResolvedValue({ success: true, data: data() });
    render(<ExtendedAnalyticsPanel tab="related" inventory={null} />);
    await waitFor(() => expect(screen.getAllByRole('article', { name: /Regla histórica/ })).toHaveLength(8));
    expect(get).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    const method = screen.getByText('Metodología FP-Growth y reglas de asociación').closest('details')!;
    expect(method.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ver todas las reglas' }));
    expect(screen.getAllByRole('article', { name: /Regla histórica/ })).toHaveLength(18);
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/no representa el catálogo completo/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar Top 8' }));
    expect(screen.getAllByRole('article', { name: /Regla histórica/ })).toHaveLength(8);
  });

  it('keeps the basket while historical evidence loads and persists the completed comparison', async () => {
    publishForecastImpactSale(sale());
    const { rerender } = render(<AssociationImpactPanel data={null} loading />);
    expect(screen.getByText(/Cargando evidencia histórica/)).toBeTruthy();
    await act(async () => { rerender(<AssociationImpactPanel data={data()} />); });
    expect(await screen.findByText('Histórico congelado + esta cesta')).toBeTruthy();
    expect(readAssociationImpact()!.transactionId).toBe('sale-1');
  });

  it('observes the existing sale channel without additional reads and updates the same transaction', async () => {
    const channels: Array<{ name: string; onmessage: ((message: { data: unknown }) => void) | null }> = [];
    class Channel {
      onmessage: ((message: { data: unknown }) => void) | null = null;
      constructor(public name: string) { channels.push(this); }
      postMessage(value: unknown) { channels.filter(channel => channel !== this && channel.name === this.name).forEach(channel => channel.onmessage?.({ data: value })); }
      close() { const index = channels.indexOf(this); if (index >= 0) channels.splice(index, 1); }
    }
    vi.stubGlobal('BroadcastChannel', Channel);
    render(<AssociationImpactPanel data={data()} />);
    await act(async () => { publishForecastImpactSale(sale()); });
    expect(await screen.findByText('Histórico congelado + esta cesta')).toBeTruthy();
    await act(async () => { publishForecastImpactSale(sale()); });
    expect(readAssociationImpact()!.rules.every(row => row.afterCounts?.totalTickets === 12648)).toBe(true);
  });
});
