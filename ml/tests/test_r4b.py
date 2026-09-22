from __future__ import annotations

import unittest

import numpy as np
import pandas as pd
from sklearn.compose import TransformedTargetRegressor

from ml.src.training.metrics import (
    RMSSE_SCALE_DEFINITION,
    clip_predictions,
    mae,
    rmsse,
    rotation_class,
    rotation_thresholds,
    wape,
    zero_target_metrics,
)
from ml.src.training.train_ridge import (
    CATEGORICAL_FEATURES,
    TARGET,
    attach_segments,
    build_ridge,
    build_ridge_pipeline,
    direct_baselines,
)


class R4BMetricsTests(unittest.TestCase):
    def test_wape_and_mae(self) -> None:
        actual = np.array([0, 2, 4], dtype=np.float32)
        prediction = np.array([1, 1, 5], dtype=np.float32)
        self.assertAlmostEqual(wape(actual, prediction), 0.5)
        self.assertAlmostEqual(mae(actual, prediction), 1.0)
        self.assertTrue(np.isnan(wape([0, 0], [1, 2])))

    def test_rmsse_uses_explicit_train_target_scale(self) -> None:
        self.assertIn("7-day target", RMSSE_SCALE_DEFINITION)
        expected = np.sqrt(np.mean(np.array([1.0, 4.0]) / np.array([1.0, 4.0])))
        self.assertAlmostEqual(rmsse([2, 4], [1, 2], [1, 4]), expected)
        self.assertTrue(np.isnan(rmsse([1], [0], [np.nan])))

    def test_clipping_counts_negative_predictions(self) -> None:
        clipped, negatives = clip_predictions([-2.0, 0.0, 3.5])
        np.testing.assert_array_equal(clipped, [0.0, 0.0, 3.5])
        self.assertEqual(negatives, 1)

    def test_zero_target_metrics_do_not_report_wape(self) -> None:
        metrics = zero_target_metrics([0, 0, 2], [1, 0, 3])
        self.assertIsNone(metrics["wape"])
        self.assertEqual(metrics["rows"], 2)
        self.assertAlmostEqual(metrics["positive_prediction_pct"], 50.0)
        self.assertAlmostEqual(metrics["total_overprediction"], 1.0)

    def test_rotation_thresholds_and_classes(self) -> None:
        low, high = rotation_thresholds([0.0, 1.0, 2.0, 3.0])
        self.assertLess(low, high)
        self.assertEqual(rotation_class(low, low, high), "low")
        self.assertEqual(rotation_class((low + high) / 2, low, high), "medium")
        self.assertEqual(rotation_class(high + 1, low, high), "high")

    def test_train_only_segmentation_marks_cold_start(self) -> None:
        metadata = pd.DataFrame({"item_id": ["A", "B"], "source_date": ["2020-01-01", "2020-01-01"]})
        stats = pd.DataFrame({"item_id": ["A"], "mean_daily_units": [0.5], "rmsse_scale": [2.0]})
        result, thresholds = attach_segments(metadata, stats)
        self.assertTrue(result.loc[1, "cold_start"])
        self.assertEqual(result.loc[1, "rotation_class"], "cold_start")
        self.assertEqual(thresholds["low_demand_max_mean_daily_units"], 1.0)

    def test_pipeline_contract_excludes_metadata_and_target(self) -> None:
        features = CATEGORICAL_FEATURES + ["current_units", "rolling_sum_7"]
        pipeline = build_ridge_pipeline(features, 1.0)
        columns = sum((list(transformer[2]) for transformer in pipeline["preprocessing"].transformers), [])
        for forbidden in ["item_id", "store_id", "source_date", "split", TARGET]:
            self.assertNotIn(forbidden, columns)

    def test_baseline_formulas(self) -> None:
        frame = pd.DataFrame({"rolling_sum_7": [7, 14], "rolling_mean_28": [2.0, 3.0]})
        baselines = direct_baselines(frame)
        np.testing.assert_array_equal(baselines["zero"], [0, 0])
        np.testing.assert_array_equal(baselines["last7"], [7, 14])
        np.testing.assert_array_equal(baselines["four_week_average"], [14, 21])

    def test_log1p_inverse_round_trip(self) -> None:
        values = np.array([0.0, 1.0, 10.0, 100.0])
        np.testing.assert_allclose(np.expm1(np.log1p(values)), values)
        estimator = TransformedTargetRegressor(
            regressor=build_ridge(1.0), func=np.log1p, inverse_func=np.expm1
        )
        self.assertIs(estimator.func, np.log1p)


if __name__ == "__main__":
    unittest.main()
