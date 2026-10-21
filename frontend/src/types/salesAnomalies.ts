export interface DailySalesAnomaly {
  date: string; status: 'COMPLETE'; revenue: number; units: number; tickets: number; averageTicket: number;
  weekday: number; weekend: boolean; holidayCode: string | null; promotionTickets: number;
  anomalyScore: number; decisionFunction: number; isAnomaly: boolean; prediction: -1 | 1;
  interpretation: string; split: 'TRAIN' | 'VALIDATION' | 'RETROSPECTIVE';
}
export interface SalesAnomalies {
  contractVersion: string; modelId: string; version: string; algorithm: 'IsolationForest'; learningType: 'unsupervised';
  task: 'sales_anomaly_detection'; mode: 'FROZEN'; trainingCutoff: string; analysisCutoff: string;
  sampleCount: number; analysisDays: number; trainingTimestamp: string; features: string[]; transformations: string[];
  contamination: 'auto'; threshold: number; anomalyCount: number; anomalyRate: number;
  stability: { jaccardMean: number; jaccardMin: number; top10JaccardMean: number; rankCorrelationMean: number;
    developmentJaccardMean: number; developmentRankCorrelationMean: number };
  scoreSemantics: string; selectionReason: string; status: 'EXPLORATORY'; artifactHash: string; limitations: string[];
  reference: Record<'revenue' | 'units' | 'tickets' | 'averageTicket', { min: number; q25: number; median: number; q75: number; p90: number; max: number; mean: number; skewness: number; zeros: number; iqrOutliers: number }>;
  candidates: Array<{ contamination: 'auto' | number; threshold: number; anomalyCount: number; anomalyRate: number; dates: string[]; jaccardMean: number; jaccardMin: number }>;
  period: { startDate: string; endDate: string }; filteredDays: number; filteredAnomalyCount: number;
  topAnomalies: DailySalesAnomaly[]; series: DailySalesAnomaly[];
}
export interface SalesProvisionalEvaluation {
  modelVersion: string; provisional: true; localDate: string; revision: string; observedAt: string;
  businessContext: { businessId: string; scenarioId: string; datasetVersion: string };
  status: 'EVALUATED' | 'NOT_EVALUABLE'; reason: string | null;
  aggregate: { revenuePEN: number; units: number; tickets: number; averageTicketPEN: number | null } | null;
  modelInput: { weekday: number; weekdayLogTicketsDeviation: number; weekdayLogAverageTicketDeviation: number } | null;
  inference: { anomalyScore: number; decisionFunction: number; prediction: -1 | 1;
    label: 'WITHIN_PATTERN' | 'ANOMALOUS_SIGNAL'; regionSignature: string } | null;
  modelIdentity: { artifact: string; artifactHash: string; weeklyReferenceHash: string; threshold: number;
    trainingCutoff: string; analysisCutoff: string };
  commercial: { grossMargin: { value: number | null; currency: string | null; percent: number | null;
    availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE' } | null;
    costCoverage: { knownSaleLines: number | null; unknownSaleLines: number | null; status: string | null } | null };
}
