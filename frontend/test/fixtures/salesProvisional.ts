import type { SalesProvisionalEvaluation } from '@/types/salesAnomalies';
export const provisionalContext = { businessId: 'MINIMARKET-PASCO-V3', scenarioId: 'minimarket-pasco-v3', datasetVersion: 'dataset-v3' };
export function provisionalFixture(overrides: Partial<SalesProvisionalEvaluation> = {}): SalesProvisionalEvaluation {
  return { modelVersion: 'sales-isolation-forest-v3-v1', provisional: true, localDate: '2026-10-20', revision: '184',
    observedAt: '2026-10-20T15:00:00.000Z', businessContext: provisionalContext, status: 'EVALUATED', reason: null,
    aggregate: { revenuePEN: 45, units: 4, tickets: 2, averageTicketPEN: 22.5 },
    modelInput: { weekday: 2, weekdayLogTicketsDeviation: -1, weekdayLogAverageTicketDeviation: -.1 },
    inference: { anomalyScore: -.4, decisionFunction: .1, prediction: 1, label: 'WITHIN_PATTERN', regionSignature: 'a'.repeat(64) },
    modelIdentity: { artifact: 'model.joblib', artifactHash: 'a'.repeat(64), weeklyReferenceHash: 'b'.repeat(64),
      threshold: -.5, trainingCutoff: '2026-06-30', analysisCutoff: '2026-10-12' },
    commercial: { grossMargin: { value: null, percent: null, currency: null, availability: 'PARTIAL' },
      costCoverage: { knownSaleLines: 3, unknownSaleLines: 1, status: 'PARTIAL' } }, ...overrides };
}
