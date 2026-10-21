import { captureSalesImpactSnapshot, isSalesImpactEvent, makeSalesImpactEvent, type SalesImpactEvent, type SalesImpactMoney, type SalesImpactSnapshot } from './salesImpactSnapshot';

export const SALES_IMPACT_CHANNEL = 'business-intelligence-sales-impact-v1';
export const SALES_IMPACT_SESSION_KEY = 'business-intelligence.latest-sales-impact.v1';
let activeCapture = 0;

export function saveLatestSalesImpact(event: SalesImpactEvent): void {
  try { if (typeof window !== 'undefined') window.sessionStorage.setItem(SALES_IMPACT_SESSION_KEY, JSON.stringify(event)); }
  catch { /* Storage is optional; an analytics failure must not affect a completed sale. */ }
}
export function readLatestSalesImpact(): SalesImpactEvent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SALES_IMPACT_SESSION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (isSalesImpactEvent(value)) return value;
    window.sessionStorage.removeItem(SALES_IMPACT_SESSION_KEY);
  } catch {
    try { window.sessionStorage.removeItem(SALES_IMPACT_SESSION_KEY); } catch { /* Optional storage. */ }
  }
  return null;
}
export function clearLatestSalesImpact(): void {
  try { if (typeof window !== 'undefined') window.sessionStorage.removeItem(SALES_IMPACT_SESSION_KEY); } catch { /* Optional storage. */ }
}
export function publishSalesImpact(event: SalesImpactEvent): void {
  saveLatestSalesImpact(event);
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(SALES_IMPACT_CHANNEL);
    channel.postMessage(event);
    channel.close();
  } catch { /* sessionStorage remains the same-tab fallback. */ }
}

export function publishCompletedSaleImpact(input: {
  businessContext: SalesImpactEvent['businessContext']; transactionId: string | null; occurredAt: string;
  saleTotal: SalesImpactMoney | null; before: SalesImpactSnapshot | null;
}): void {
  const capture = ++activeCapture;
  const pending = makeSalesImpactEvent({ ...input, after: null, afterPending: true });
  publishSalesImpact(pending);
  void captureSalesImpactSnapshot().then(after => {
    if (capture !== activeCapture) return;
    publishSalesImpact(makeSalesImpactEvent({ ...input, after }));
  }).catch(() => {
    if (capture !== activeCapture) return;
    publishSalesImpact(makeSalesImpactEvent({ ...input, after: null }));
  });
}
