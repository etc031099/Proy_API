from __future__ import annotations

import unittest
import shutil
import uuid
from pathlib import Path

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
    load_split,
)
from ml.src.training.train_hgb_sample import (
    build_hgb,
    build_hgb_preprocessor,
    load_train_sample,
    sampling_rule,
)
from ml.src.m5 import connect_duckdb
from ml.src.training.freeze_r4_selection import selection_is_eligible
from ml.src.training.evaluate_r4_test import ensure_test_unopened


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


class R4BHGSampleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1] / ".test-tmp" / f"hgb-{uuid.uuid4().hex}"
        cls.root.mkdir(parents=True)
        cls.gold = cls.root / "gold.parquet"
        connection = connect_duckdb()
        try:
            connection.execute(
                """
                CREATE TABLE fixture AS
                SELECT 'ITEM_' || item AS item_id,
                       DATE '2020-01-01' + day::INTEGER AS source_date,
                       CASE WHEN day < 8 THEN 'train' ELSE 'validation' END AS split,
                       'CAT'::VARCHAR AS cat_id, 'DEPT'::VARCHAR AS dept_id,
                       '__NONE__'::VARCHAR AS event_name_1,
                       '__NONE__'::VARCHAR AS event_type_1,
                       '__NONE__'::VARCHAR AS event_name_2,
                       '__NONE__'::VARCHAR AS event_type_2,
                       day::FLOAT AS current_units,
                       (day + 1)::INTEGER AS target_units_next_7_days
                FROM range(3) items(item), range(10) days(day)
                """
            )
            connection.execute(f"COPY fixture TO '{cls.gold.as_posix()}' (FORMAT PARQUET)")
        finally:
            connection.close()
        cls.features = CATEGORICAL_FEATURES + ["current_units"]

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_sampling_is_deterministic_and_keeps_every_product(self) -> None:
        first = load_train_sample(self.gold, self.features, seed=2026, modulus=100, threshold=0)
        second = load_train_sample(self.gold, self.features, seed=2026, modulus=100, threshold=0)
        self.assertEqual(len(first[0]), 3)
        self.assertEqual(first[3]["products"], 3)
        self.assertEqual(first[2], second[2])
        self.assertIn("TRAIN only", sampling_rule(2026, 100, 0))

    def test_hgb_preprocessor_indices_and_no_metadata(self) -> None:
        preprocessor, indices = build_hgb_preprocessor(self.features)
        columns = sum((list(transformer[2]) for transformer in preprocessor.transformers), [])
        self.assertEqual(indices, list(range(1, 7)))
        for forbidden in ["item_id", "store_id", "source_date", "split", TARGET]:
            self.assertNotIn(forbidden, columns)
        estimator = build_hgb(
            {"max_iter": 2, "learning_rate": 0.1, "max_leaf_nodes": 3,
             "min_samples_leaf": 2, "l2_regularization": 1.0},
            indices,
            2026,
            {"loss": "squared_error", "early_stopping": True,
             "validation_fraction": 0.05, "n_iter_no_change": 2},
        )
        self.assertEqual(estimator.categorical_features, indices)

    def test_validation_is_loaded_completely(self) -> None:
        frame, target, metadata = load_split(self.gold, "validation", self.features, metadata=True)
        self.assertEqual(len(frame), 6)
        self.assertEqual(len(target), 6)
        self.assertEqual(len(metadata), 6)

    def test_pretest_selection_rule_and_single_access_guard(self) -> None:
        self.assertTrue(selection_is_eligible(0.333, 0.358, 0.361, 3_000, 12_000))
        self.assertFalse(selection_is_eligible(0.360, 0.358, 0.361, 3_000, 12_000))
        marker = self.root / "access.json"
        report = self.root / "final.json"
        ensure_test_unopened(marker, report)
        marker.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "second access"):
            ensure_test_unopened(marker, report)


if __name__ == "__main__":
    unittest.main()
