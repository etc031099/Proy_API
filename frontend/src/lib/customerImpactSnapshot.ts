import { apiClient } from '@/lib/api';
import type { CustomerClusterAssignment, CustomerClustering } from '@/types/customerClustering';
import type { ForecastImpactSnapshot } from './forecastImpactSnapshot';

export type CustomerImpactContext = ForecastImpactSnapshot['context'];
export type CustomerImpactSnapshot = {
  customerRef: string;
  captureStatus: CustomerClusterAssignment['status'];
  recency: number | null;
  frequency: number | null;
  monetary: number | null;
  rfmSegment: string | null;
  cluster: number | null;
  clusterName: string | null;
  distance: number | null;
  pc1: number | null;
  pc2: number | null;
  modelVersion: string;
  trainingCutoff: string;
  assignmentAsOfDate: string;
  assignmentSource: CustomerClustering['assignmentSource'];
};

export type CustomerImpactEvent = {
  version: 1;
  businessContext: CustomerImpactContext;
  transactionId: string | null;
  customerRef: string | null;
  displayName: string;
  occurredAt: string;
  before: CustomerImpactSnapshot | null;
  after: CustomerImpactSnapshot | null;
  captureStatus: 'COMPLETE' | 'BEFORE_UNAVAILABLE' | 'AFTER_UNAVAILABLE' | 'BOTH_UNAVAILABLE';
};

const finiteOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export async function captureCustomerImpactSnapshot(customerMongoId: string): Promise<CustomerImpactSnapshot | null> {
  if (!customerMongoId) return null;
  try {
    const response = await apiClient.getCustomerClustering(customerMongoId);
    const data = response.success ? response.data : null;
    const row = data?.assignments?.length === 1 ? data.assignments[0] : null;
    if (!data || !row || !row.customerRef) return null;
    return { customerRef: row.customerRef, captureStatus: row.status,
      recency: finiteOrNull(row.recency), frequency: finiteOrNull(row.frequency), monetary: finiteOrNull(row.monetary),
      rfmSegment: row.rfmSegment || null, cluster: finiteOrNull(row.cluster), clusterName: row.clusterName || null,
      distance: finiteOrNull(row.distance), pc1: finiteOrNull(row.pc1), pc2: finiteOrNull(row.pc2),
      modelVersion: data.version, trainingCutoff: data.trainingCutoff, assignmentAsOfDate: data.assignmentAsOfDate,
      assignmentSource: data.assignmentSource };
  } catch { return null; }
}

export function makeCustomerImpactEvent(input: Omit<CustomerImpactEvent, 'version' | 'customerRef' | 'captureStatus'>): CustomerImpactEvent {
  const before = input.before, after = input.after;
  return { ...input, version: 1, customerRef: after?.customerRef || before?.customerRef || null,
    captureStatus: before && after ? 'COMPLETE' : before ? 'AFTER_UNAVAILABLE' : after ? 'BEFORE_UNAVAILABLE' : 'BOTH_UNAVAILABLE' };
}

export function isCustomerImpactEvent(value: unknown): value is CustomerImpactEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<CustomerImpactEvent>;
  return event.version === 1 && isContext(event.businessContext)
    && (event.transactionId === null || typeof event.transactionId === 'string')
    && (event.customerRef === null || typeof event.customerRef === 'string')
    && typeof event.displayName === 'string' && typeof event.occurredAt === 'string'
    && Number.isFinite(Date.parse(event.occurredAt))
    && (event.before === null || isSnapshot(event.before)) && (event.after === null || isSnapshot(event.after))
    && ['COMPLETE', 'BEFORE_UNAVAILABLE', 'AFTER_UNAVAILABLE', 'BOTH_UNAVAILABLE'].includes(event.captureStatus || '');
}

export function sameCustomerImpactContext(a: CustomerImpactContext, b: CustomerImpactContext): boolean {
  return Boolean(a.businessId && a.scenarioId && a.datasetVersion && b.businessId && b.scenarioId && b.datasetVersion)
    && a.businessId === b.businessId && a.scenarioId === b.scenarioId && a.datasetVersion === b.datasetVersion;
}

function isContext(value: unknown): value is CustomerImpactContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as CustomerImpactContext;
  return [context.businessId, context.scenarioId, context.datasetVersion].every(item => item === null || typeof item === 'string');
}

function isSnapshot(value: unknown): value is CustomerImpactSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as CustomerImpactSnapshot;
  return typeof row.customerRef === 'string' && ['ELIGIBLE', 'ASSIGNED', 'INSUFFICIENT_HISTORY'].includes(row.captureStatus)
    && [row.recency, row.frequency, row.monetary, row.cluster, row.distance, row.pc1, row.pc2].every(item => item === null || Number.isFinite(item))
    && [row.rfmSegment, row.clusterName].every(item => item === null || typeof item === 'string')
    && typeof row.modelVersion === 'string' && typeof row.trainingCutoff === 'string'
    && typeof row.assignmentAsOfDate === 'string'
    && ['FROZEN_TRAINING_RFM', 'AUTHORIZED_CURRENT_RFM'].includes(row.assignmentSource);
}
