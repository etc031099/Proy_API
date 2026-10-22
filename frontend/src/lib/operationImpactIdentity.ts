type ImpactIdentity = {
  transactionId: string | null;
  operationType?: string;
  type?: string;
  occurredAt: string;
  businessContext?: { businessId: string | null; scenarioId: string | null; datasetVersion: string | null };
};

export function mayReplaceImpact<T extends ImpactIdentity>(candidate: T, current: T | null): boolean {
  if (!current) return true;
  if (!candidate.transactionId || !current.transactionId) return false;
  const candidateType = candidate.operationType || candidate.type;
  const currentType = current.operationType || current.type;
  const a = candidate.businessContext, b = current.businessContext;
  if (a?.businessId && a.scenarioId && a.datasetVersion && b?.businessId && b.scenarioId && b.datasetVersion
    && (a.businessId !== b.businessId || a.scenarioId !== b.scenarioId || a.datasetVersion !== b.datasetVersion)) return false;
  if (candidate.transactionId === current.transactionId) return candidateType === currentType;
  const candidateTime = Date.parse(candidate.occurredAt), currentTime = Date.parse(current.occurredAt);
  if (!Number.isFinite(candidateTime) || !Number.isFinite(currentTime)) return false;
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return /^[a-f\d]{24}$/i.test(candidate.transactionId) && /^[a-f\d]{24}$/i.test(current.transactionId)
    && candidate.transactionId.toLowerCase() > current.transactionId.toLowerCase();
}
