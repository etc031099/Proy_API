export interface EvaluationMetrics { wape: number; mae: number; rmse: number | null; rmsse: number | null; }
export interface EvaluationPeriod { startDate: string; endDate: string; rows: number | null; }
export interface ModelEvaluation {
  modelId: string;
  algorithm: 'HistGradientBoostingRegressor';
  modelType: 'MACHINE_LEARNING_REGRESSOR';
  learningType: 'SUPERVISED_REGRESSION';
  task: string;
  target: string;
  horizonDays: number;
  features: string[];
  featureGroups: string[];
  dataset: { name: string; version: string; synthetic: boolean; rows: number; products: number; logicalHash: string };
  trainPeriod: EvaluationPeriod;
  validationPeriod: EvaluationPeriod;
  testPeriod: EvaluationPeriod;
  metrics: { validation?: EvaluationMetrics; test: EvaluationMetrics };
  baseline: { algorithm: string; modelStatus: 'BASELINE'; testMetrics: EvaluationMetrics };
  relativeTestWapeImprovementPct: number | null;
  modelStatus: 'EVALUATED' | 'REJECTED_FOR_OPERATIONAL_USE';
  version: string;
  trainingCutoff: string;
  artifactHash: string | null;
  evaluationEvidenceHash: string;
  limitations: string[];
}
export interface ForecastEvaluation {
  contractVersion: 'forecast-model-evaluation-v1';
  modelEvaluation: ModelEvaluation[];
  selectedOperationalMethod: {
    algorithm: 'MOVING_AVERAGE_28'; label: string;
    modelType: 'STATISTICAL_BASELINE'; learningType: 'NOT_APPLICABLE'; modelStatus: 'OPERATIONAL';
    horizons: Array<1 | 7 | 14>; version: string; selectionReason: string;
  };
  operationalEvaluation: Array<{ horizonDays: 1 | 7 | 14; modelStatus: 'BASELINE'; testMetrics: EvaluationMetrics }>;
  analysisCutoff: string;
  historicalSeries: { available: false; reasonCode: 'TEST_PREDICTIONS_NOT_PERSISTED'; points: never[] };
}
