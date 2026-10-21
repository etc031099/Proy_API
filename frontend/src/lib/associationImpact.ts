import type { AssociationRule, AssociationsAnalytics } from '@/types/businessIntelligence';
import type { ForecastImpactSaleMessage } from './forecastImpactChannel';
import { sameCustomerImpactContext } from './customerImpactSnapshot';

export type AssociationCounts = { totalTickets: number; antecedentCount: number; consequentCount: number; jointCount: number };
export type AssociationMetrics = { support: number; confidence: number; lift: number };
type FrozenAssociationSource = Pick<AssociationsAnalytics, 'businessContext' | 'analysisVersion' | 'artifactIdentity'
  | 'cutoff' | 'available' | 'items' | 'total' | 'offset'>;
export type AssociationRuleImpact = {
  historical: AssociationRule;
  presence: { antecedent: boolean; consequent: boolean; both: boolean };
  beforeCounts: AssociationCounts | null; afterCounts: AssociationCounts | null;
  provisional: AssociationMetrics | null;
};
export type AssociationImpactEvent = {
  version: 1; purpose: 'HISTORICAL_PLUS_SINGLE_BASKET'; status: 'COMPLETE' | 'PARTIAL' | 'CANCELLED';
  transactionId: string | null; occurredAt: string;
  businessContext: NonNullable<AssociationsAnalytics['businessContext']>;
  products: ForecastImpactSaleMessage['products']; analysisVersion: string | null; cutoff: string;
  artifactIdentity: string | null; rules: AssociationRuleImpact[]; hasUnruledCooccurrence: boolean;
};
export const ASSOCIATION_IMPACT_KEY = 'business-intelligence.latest-association-impact.v1';
export const ASSOCIATION_IMPACT_CHANNEL = 'business-intelligence-association-impact-v1';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const close = (a: unknown, b: number) => finite(a) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
const skuSet = (items: string[]) => Array.isArray(items) && items.length > 0
  && items.every(item => typeof item === 'string' && item.length > 0) && new Set(items).size === items.length;
export const associationMetrics = (c: AssociationCounts): AssociationMetrics => ({
  support: c.jointCount / c.totalTickets, confidence: c.jointCount / c.antecedentCount,
  lift: c.jointCount * c.totalTickets / (c.antecedentCount * c.consequentCount),
});
export function compareAssociationRule(rule: AssociationRule, basket: ReadonlySet<string>): AssociationRuleImpact {
  const hasA = skuSet(rule.antecedent) && rule.antecedent.every(sku => basket.has(sku));
  const hasB = skuSet(rule.consequent) && rule.consequent.every(sku => basket.has(sku));
  const empty = { historical: rule, presence: { antecedent: hasA, consequent: hasB, both: hasA && hasB },
    beforeCounts: null, afterCounts: null, provisional: null };
  const n = rule.totalTickets, a = rule.antecedentCount, b = rule.consequentCount, j = rule.jointCount;
  if (![n, a, b, j].every(value => Number.isSafeInteger(value) && value! > 0)
    || !skuSet(rule.antecedent) || !skuSet(rule.consequent)
    || rule.antecedent.some(sku => rule.consequent.includes(sku))
    || new Set([...rule.antecedent, ...rule.consequent]).size > 3
    || j! > Math.min(a!, b!) || Math.max(a!, b!) > n! || a! + b! - j! > n! || rule.ticketCount !== j
    || !Number.isSafeInteger(n! + 1)) return empty;
  const beforeCounts = { totalTickets: n!, antecedentCount: a!, consequentCount: b!, jointCount: j! };
  const metrics = associationMetrics(beforeCounts);
  if (!close(rule.support, metrics.support) || !close(rule.confidence, metrics.confidence) || !close(rule.lift, metrics.lift)) return empty;
  const afterCounts = { totalTickets: n! + 1, antecedentCount: a! + Number(hasA),
    consequentCount: b! + Number(hasB), jointCount: j! + Number(hasA && hasB) };
  return { ...empty, beforeCounts, afterCounts, provisional: associationMetrics(afterCounts) };
}

function unruledCooccurrence(skus: string[], rules: AssociationRule[]): boolean {
  const known = new Set(rules.map(rule => [...rule.antecedent, ...rule.consequent].sort().join('|')));
  for (let i = 0; i < skus.length; i++) for (let j = i + 1; j < skus.length; j++) {
    if (!known.has([skus[i], skus[j]].sort().join('|'))) return true;
    for (let k = j + 1; k < skus.length; k++) if (!known.has([skus[i], skus[j], skus[k]].sort().join('|'))) return true;
  }
  return false;
}
export function makeAssociationImpact(sale: ForecastImpactSaleMessage, data: FrozenAssociationSource, cancelled = false): AssociationImpactEvent | null {
  if (!data.businessContext || !sale.context
    || ![...Object.values(sale.context), ...Object.values(data.businessContext)].every(value => typeof value === 'string' && value.length > 0)
    || !sameCustomerImpactContext(sale.context, data.businessContext)
    || !(sale.transactionId === null || typeof sale.transactionId === 'string') || !Array.isArray(sale.products)
    || typeof sale.occurredAt !== 'string' || !Number.isFinite(Date.parse(sale.occurredAt))
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.cutoff)) return null;
  const products = new Map<string, ForecastImpactSaleMessage['products'][number]>();
  for (const product of sale.products) {
    if (!product || typeof product.sku !== 'string' || !product.sku || typeof product.name !== 'string'
      || !Number.isSafeInteger(product.quantity) || product.quantity < 1) return null;
    const previous = products.get(product.sku);
    const quantity = product.quantity + (previous?.quantity || 0);
    if (!Number.isSafeInteger(quantity)) return null;
    products.set(product.sku, { ...product, quantity });
  }
  const artifactIdentity = /^[a-f0-9]{64}$/.test(data.artifactIdentity || '') ? data.artifactIdentity! : null;
  const analysisVersion = data.analysisVersion || null;
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sale.occurredAt));
  const eligible = Boolean(artifactIdentity && analysisVersion && sale.transactionId && products.size
    && localDay > data.cutoff && data.available);
  const isCancelled = cancelled && Boolean(sale.transactionId);
  const basket = new Set(products.keys());
  const rules = data.items.map(rule => {
    const result = compareAssociationRule(rule, basket);
    return eligible && !isCancelled ? result : { ...result, afterCounts: null, provisional: null };
  });
  const complete = eligible && data.offset === 0 && data.items.length === data.total && data.total > 0
    && rules.every(rule => rule.provisional !== null);
  return { version: 1, purpose: 'HISTORICAL_PLUS_SINGLE_BASKET', status: isCancelled ? 'CANCELLED' : complete ? 'COMPLETE' : 'PARTIAL',
    transactionId: sale.transactionId, occurredAt: sale.occurredAt, businessContext: { ...data.businessContext },
    products: [...products.values()], analysisVersion, cutoff: data.cutoff, artifactIdentity, rules,
    hasUnruledCooccurrence: unruledCooccurrence([...basket], data.items) };
}
export function associationExplanation(row: AssociationRuleImpact): string {
  if (row.presence.both) return 'Esta venta contiene antecedente y consecuente. En «histórico + esta cesta» aumentan N, antecedente, consecuente y coocurrencia; la regla histórica permanece congelada.';
  if (row.presence.antecedent) return 'La cesta contiene el antecedente pero no el consecuente; aumenta la evidencia del antecedente sin nueva coocurrencia.';
  if (row.presence.consequent) return 'La cesta contiene el consecuente pero no el antecedente; no añade coocurrencia a esta regla.';
  return 'La cesta no contiene antecedente ni consecuente; solo aumenta el denominador de tickets.';
}
export function relatedAssociationRules(event: AssociationImpactEvent): AssociationRuleImpact[] {
  const rank = (row: AssociationRuleImpact) => row.presence.both ? 0 : row.presence.antecedent ? 1 : 2;
  return event.rules.filter(row => row.presence.antecedent || row.presence.consequent).sort((a, b) => rank(a) - rank(b));
}

export function readAssociationImpact(): AssociationImpactEvent | null {
  try {
    const raw = window.sessionStorage.getItem(ASSOCIATION_IMPACT_KEY);
    if (!raw) return null;
    const event = JSON.parse(raw) as AssociationImpactEvent;
    if (event.version !== 1 || event.purpose !== 'HISTORICAL_PLUS_SINGLE_BASKET'
      || !['COMPLETE', 'PARTIAL', 'CANCELLED'].includes(event.status) || !Array.isArray(event.rules)
      || !Array.isArray(event.products) || !event.businessContext) return null;
    // Revalidate stored arithmetic and bindings using the same pure calculation.
    const rebuilt = makeAssociationImpact({ version: 2, type: 'SALE_COMPLETED', transactionId: event.transactionId,
      occurredAt: event.occurredAt, context: event.businessContext, products: event.products,
      hasCustomer: false, customerRef: null, baseline: null, baselineUnavailable: true }, {
      businessContext: event.businessContext, analysisVersion: event.analysisVersion, artifactIdentity: event.artifactIdentity,
      cutoff: event.cutoff, available: true, items: event.rules.map(row => row.historical), total: event.rules.length,
      offset: 0,
    }, event.status === 'CANCELLED');
    if (!rebuilt) return null;
    return { ...rebuilt, status: event.status === 'PARTIAL' ? 'PARTIAL' : rebuilt.status };
  } catch { return null; }
}
export function saveAssociationImpact(event: AssociationImpactEvent): void {
  try {
    const raw = JSON.stringify(event);
    if (window.sessionStorage.getItem(ASSOCIATION_IMPACT_KEY) === raw) return;
    window.sessionStorage.setItem(ASSOCIATION_IMPACT_KEY, raw);
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(ASSOCIATION_IMPACT_CHANNEL);
      channel.postMessage(event); channel.close();
    }
  } catch { /* The completed sale is independent of temporary evidence storage. */ }
}
