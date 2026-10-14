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
