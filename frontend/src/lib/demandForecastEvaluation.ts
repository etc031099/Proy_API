import metadata from '../../../ml/models/model_metadata.json';

// Display the sealed evaluation values from the official artifact metadata.
export const demandForecastEvaluation = {
  name: metadata.model_name,
  algorithm: metadata.model_type,
  version: metadata.model_version,
  featuresCount: metadata.feature_names.length,
  horizonDays: metadata.prediction_horizon_days,
  artifact: `${metadata.model_name}.joblib`,
  testWapePct: metadata.final_test_metrics.wape * 100,
  baselineWapePct: metadata.baseline_test.wape * 100,
  improvementPct: metadata.relative_test_improvement_pct,
};
