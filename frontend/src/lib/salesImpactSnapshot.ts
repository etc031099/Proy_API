import { apiClient } from '@/lib/api';
import type { SalesProvisionalEvaluation } from '@/types/salesAnomalies';
import type { CustomerImpactContext } from './customerImpactSnapshot';

export type SalesImpactMoney = { value: number | null; currency: string | null };
export type SalesImpactSnapshot = {
  period: { startDate: string; endDate: string };
  dataVersion: number | null;
  revenue: SalesImpactMoney | null;
  units: number | null;
  tickets: number | null;
  averageTicket: SalesImpactMoney | null;
  grossMarginAmount: SalesImpactMoney | null;
  grossMarginPercent: number | null;
  costCoverage: { knownSaleLines: number | null; unknownSaleLines: number | null; status: string | null } | null;
  isolationForest?: SalesProvisionalEvaluation | null;
};
export type SalesImpactEvent = {
  version: 1;
  businessContext: CustomerImpactContext;
  transactionId: string | null;
  occurredAt: string;
  operationType: 'SALE';
  saleTotal: SalesImpactMoney | null;
  before: SalesImpactSnapshot | null;
  after: SalesImpactSnapshot | null;
  captureStatus: 'COMPLETE' | 'BEFORE_UNAVAILABLE' | 'AFTER_UNAVAILABLE' | 'BOTH_UNAVAILABLE' | 'AFTER_PENDING';
  isolationForestImpact?: { before: SalesProvisionalEvaluation | null; after: SalesProvisionalEvaluation | null;
    captureStatus: SalesImpactEvent['captureStatus'] };
};

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const money = (value: unknown): SalesImpactMoney | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as { value?: unknown; currency?: unknown };
  return { value: finite(row.value), currency: typeof row.currency === 'string' ? row.currency : null };
};

export async function captureSalesImpactSnapshot(): Promise<SalesImpactSnapshot | null> {
  try {
    const response = await apiClient.getSalesImpactAnalytics();
    const data = response.success ? response.data : undefined;
    if (!data || !isProvisionalEvaluation(data)) return null;
    const margin = data.commercial.grossMargin;
    const marginAvailable = margin?.availability === 'AVAILABLE';
    const coverage = data.commercial.costCoverage;
    return {
      period: { startDate: data.localDate, endDate: data.localDate },
      dataVersion: Number.isSafeInteger(Number(data.revision)) ? Number(data.revision) : null,
      revenue: data.aggregate ? money({ value: data.aggregate.revenuePEN, currency: 'PEN' }) : null,
      units: finite(data.aggregate?.units),
      tickets: finite(data.aggregate?.tickets),
      averageTicket: data.aggregate ? money({ value: data.aggregate.averageTicketPEN, currency: 'PEN' }) : null,
      grossMarginAmount: marginAvailable && margin ? money({ value: margin.value, currency: margin.currency }) : null,
      grossMarginPercent: marginAvailable && margin ? finite(margin.percent) : null,
      isolationForest: data,
      costCoverage: coverage ? {
        knownSaleLines: finite(coverage.knownSaleLines), unknownSaleLines: finite(coverage.unknownSaleLines),
        status: typeof coverage.status === 'string' ? coverage.status : null,
      } : null,
    };
  } catch { return null; }
}

export async function waitForSalesImpactBefore(
  capture: Promise<SalesImpactSnapshot | null>, timeoutMs = 5000,
): Promise<SalesImpactSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      capture.catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function makeSalesImpactEvent(input: {
  businessContext: CustomerImpactContext;
  transactionId: string | null;
  occurredAt: string;
  saleTotal: SalesImpactMoney | null;
  before: SalesImpactSnapshot | null;
  after: SalesImpactSnapshot | null;
  afterPending?: boolean;
}): SalesImpactEvent {
  const { before, after, afterPending = false, ...eventFields } = input;
  const captureStatus: SalesImpactEvent['captureStatus'] = afterPending ? 'AFTER_PENDING' : before && after ? 'COMPLETE'
    : before ? 'AFTER_UNAVAILABLE' : after ? 'BEFORE_UNAVAILABLE' : 'BOTH_UNAVAILABLE';
  const inferenceBefore = before?.isolationForest || null, inferenceAfter = after?.isolationForest || null;
  return { ...eventFields, businessContext: inferenceBefore?.businessContext || inferenceAfter?.businessContext || input.businessContext,
    before, after, version: 1, operationType: 'SALE', captureStatus,
    isolationForestImpact: { before: inferenceBefore, after: inferenceAfter,
      captureStatus: afterPending ? 'AFTER_PENDING' : inferenceBefore && inferenceAfter ? 'COMPLETE'
        : inferenceBefore ? 'AFTER_UNAVAILABLE' : inferenceAfter ? 'BEFORE_UNAVAILABLE' : 'BOTH_UNAVAILABLE' } };
}

export function isSalesImpactEvent(value: unknown): value is SalesImpactEvent {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<SalesImpactEvent>;
  return row.version === 1 && row.operationType === 'SALE'
    && isContext(row.businessContext)
    && (row.transactionId === null || typeof row.transactionId === 'string')
    && typeof row.occurredAt === 'string' && Number.isFinite(Date.parse(row.occurredAt))
    && (row.saleTotal === null || isMoney(row.saleTotal))
    && (row.before === null || isSnapshot(row.before)) && (row.after === null || isSnapshot(row.after))
    && (row.isolationForestImpact === undefined || Boolean(row.isolationForestImpact
      && [row.isolationForestImpact.before, row.isolationForestImpact.after].every(item => item === null || isProvisionalEvaluation(item))))
    && ['COMPLETE', 'BEFORE_UNAVAILABLE', 'AFTER_UNAVAILABLE', 'BOTH_UNAVAILABLE', 'AFTER_PENDING'].includes(row.captureStatus || '');
}

function isContext(value: unknown): value is CustomerImpactContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as CustomerImpactContext;
  return [context.businessId, context.scenarioId, context.datasetVersion].every(part => part === null || typeof part === 'string');
}
function isMoney(value: unknown): value is SalesImpactMoney {
  if (!value || typeof value !== 'object') return false;
  const row = value as SalesImpactMoney;
  return (row.value === null || finite(row.value) !== null) && (row.currency === null || typeof row.currency === 'string');
}
function isSnapshot(value: unknown): value is SalesImpactSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as SalesImpactSnapshot;
  return typeof row.period?.startDate === 'string' && typeof row.period?.endDate === 'string'
    && (row.dataVersion === null || finite(row.dataVersion) !== null)
    && [row.revenue, row.averageTicket, row.grossMarginAmount].every(item => item === null || isMoney(item))
    && [row.units, row.tickets, row.grossMarginPercent].every(item => item === null || finite(item) !== null)
    && (row.isolationForest === undefined || row.isolationForest === null || isProvisionalEvaluation(row.isolationForest))
    && (row.costCoverage === null || Boolean(row.costCoverage &&
      [row.costCoverage.knownSaleLines, row.costCoverage.unknownSaleLines].every(item => item === null || finite(item) !== null)
      && (row.costCoverage.status === null || typeof row.costCoverage.status === 'string')));
}

export function isProvisionalEvaluation(value: unknown): value is SalesProvisionalEvaluation {
  if (!value || typeof value !== 'object') return false;
  const row = value as SalesProvisionalEvaluation;
  if (row.provisional !== true || row.modelVersion !== 'sales-isolation-forest-v3-v1'
    || !/^\d{4}-\d{2}-\d{2}$/.test(row.localDate) || typeof row.revision !== 'string' || !/^\d+$/.test(row.revision)
    || !Number.isFinite(Date.parse(row.observedAt)) || !isContext(row.businessContext)
    || !row.businessContext.businessId || !row.businessContext.scenarioId || !row.businessContext.datasetVersion
    || row.modelIdentity?.threshold !== -.5 || row.modelIdentity?.artifact !== 'model.joblib'
    || !/^[a-f0-9]{64}$/.test(row.modelIdentity.artifactHash) || !/^[a-f0-9]{64}$/.test(row.modelIdentity.weeklyReferenceHash)
    || !row.commercial) return false;
  if (row.status === 'NOT_EVALUABLE') return row.inference === null && row.modelInput === null
    && ['NO_TICKETS', 'INVALID_AVERAGE_TICKET', 'INVALID_DAILY_AGGREGATE', 'UNSUPPORTED_CURRENCY', 'DATE_MISMATCH', 'INVALID_DATE'].includes(row.reason || '');
  if (row.status !== 'EVALUATED' || row.reason !== null || !row.aggregate || !row.modelInput || !row.inference) return false;
  return [row.aggregate.revenuePEN, row.aggregate.units, row.aggregate.tickets, row.aggregate.averageTicketPEN,
      row.modelInput.weekdayLogTicketsDeviation, row.modelInput.weekdayLogAverageTicketDeviation,
      row.inference.anomalyScore, row.inference.decisionFunction].every(item => finite(item) !== null)
    && row.aggregate.tickets > 0 && (row.aggregate.averageTicketPEN ?? 0) > 0
    && /^[a-f0-9]{64}$/.test(row.inference.regionSignature)
    && Math.abs(row.inference.decisionFunction - (row.inference.anomalyScore + .5)) <= 1e-12
    && row.inference.prediction === (row.inference.decisionFunction < 0 ? -1 : 1)
    && row.inference.label === (row.inference.prediction === -1 ? 'ANOMALOUS_SIGNAL' : 'WITHIN_PATTERN');
}
