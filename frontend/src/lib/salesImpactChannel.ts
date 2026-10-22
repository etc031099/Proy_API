import { captureSalesImpactSnapshot, isSalesImpactEvent, makeSalesImpactEvent, type SalesImpactEvent, type SalesImpactMoney, type SalesImpactSnapshot } from './salesImpactSnapshot';
import { mayReplaceImpact } from './operationImpactIdentity';

export const SALES_IMPACT_CHANNEL = 'business-intelligence-sales-impact-v1';
export const SALES_IMPACT_SESSION_KEY = 'business-intelligence.latest-sales-impact.v1';
export const SALES_IMPACT_LOCAL_EVENT = 'business-intelligence:sales-impact';
let activeCapture = 0;

export function saveLatestSalesImpact(event: SalesImpactEvent): void {
  if (!mayReplaceImpact(event, readLatestSalesImpact())) return;
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
  if (!mayReplaceImpact(event, readLatestSalesImpact())) return;
  saveLatestSalesImpact(event);
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SALES_IMPACT_LOCAL_EVENT, { detail: event })); } catch { /* Same-tab delivery is optional. */ }
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
    publishSalesImpactIfCurrent(makeSalesImpactEvent({ ...input, after }));
  }).catch(() => {
    if (capture !== activeCapture) return;
    publishSalesImpactIfCurrent(makeSalesImpactEvent({ ...input, after: null }));
  });
}

function publishSalesImpactIfCurrent(event: SalesImpactEvent): void {
  const current = readLatestSalesImpact();
  if (event.transactionId && current?.transactionId === event.transactionId
    && current.operationType === event.operationType && mayReplaceImpact(event, current)) publishSalesImpact(event);
}
