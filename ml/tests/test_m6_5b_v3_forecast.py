from __future__ import annotations

import copy
import hashlib
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from ml.src.v3_forecast import (
    DATASET_SHA256, FEATURE_SETS, FIRST_ORIGIN, FORBIDDEN_FEATURES, HISTORY_END,
    HORIZONS, MODEL_VERSION, PRIMARY_HORIZONS, SPLITS, V3Dataset,
    apply_nonnegative, baseline_prediction, build_examples, coherent_predictions,
    eligible_origins, feature_contract, load_validated_dataset, metric_bundle,
    make_estimator, predict_cold_start, predict_forecast_batch, prediction_contract, segment_membership,
    load_verified_v3_models,
)
import joblib
from sklearn.dummy import DummyRegressor
from ml.scripts import benchmark_minimarket_v3


ROOT = Path(__file__).resolve().parents[2]


class M65BV3ForecastTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dataset = load_validated_dataset(ROOT)
        cls.sku = sorted(cls.dataset.product_by_sku)[0]

    def test_dataset_identity_counts_and_approved_hash(self) -> None:
        self.assertEqual(self.dataset.manifest["scenarioId"], "minimarket-pasco-v3")
        self.assertEqual(self.dataset.manifest["datasetVersion"], "minimarket-pasco-v3-seed2026-v1")
        self.assertEqual(self.dataset.manifest["hashes"]["logicalDatasetSha256"], DATASET_SHA256)
        self.assertEqual(len(self.dataset.products), 80)
        self.assertEqual(sum(map(len, self.dataset.daily_by_sku.values())), 29_200)
        self.assertTrue(all(len(rows) == 365 for rows in self.dataset.daily_by_sku.values()))

    def test_exact_split_counts_and_horizon_purge(self) -> None:
        expected = {
            1: (18_560, 3_680, 4_640), 7: (18_080, 3_200, 4_160),
            14: (17_520, 2_640, 3_600), 28: (16_400, 1_520, 2_480),
        }
        for horizon, counts in expected.items():
            self.assertEqual(tuple(len(eligible_origins(*SPLITS[name], horizon, fit=(name == "train"))) * 80 for name in ("train", "validation", "test")), counts)
            for name, (start, end) in SPLITS.items():
                origins = eligible_origins(start, end, horizon, fit=(name == "train"))
                self.assertTrue(all(start <= origin + timedelta(days=1) and origin + timedelta(days=horizon) <= end for origin in origins))
        self.assertEqual(FIRST_ORIGIN.isoformat(), "2025-11-10")

    def test_no_label_overlap_between_training_and_validation_or_test(self) -> None:
        for horizon in HORIZONS:
            train = eligible_origins(*SPLITS["train"], horizon, fit=True)
            validation = eligible_origins(*SPLITS["validation"], horizon)
            test = eligible_origins(*SPLITS["test"], horizon)
            self.assertLessEqual(max(origin + timedelta(days=horizon) for origin in train), SPLITS["train"][1])
            self.assertGreaterEqual(min(origin + timedelta(days=1) for origin in validation), SPLITS["validation"][0])
            self.assertLessEqual(max(origin + timedelta(days=horizon) for origin in validation), SPLITS["validation"][1])
            self.assertGreaterEqual(min(origin + timedelta(days=1) for origin in test), SPLITS["test"][0])
            self.assertLessEqual(max(origin + timedelta(days=horizon) for origin in test), SPLITS["test"][1])

    def test_lags_and_rolling_windows_are_strictly_before_origin(self) -> None:
        origin = date(2026, 6, 30)
        row = self.dataset.feature_row(self.sku, origin, 7)
        history = self.dataset.inventory[self.sku]
        for lag in (1, 7, 14, 28):
            source_day = origin - timedelta(days=lag)
            self.assertLess(source_day, origin)
            self.assertEqual(row[f"lag_{lag}"], history[source_day.isoformat()]["unitsSold"])
        trailing7 = [history[(origin - timedelta(days=i)).isoformat()]["unitsSold"] for i in range(6, -1, -1)]
        trailing28 = [history[(origin - timedelta(days=i)).isoformat()]["unitsSold"] for i in range(27, -1, -1)]
        self.assertAlmostEqual(row["rollingMean_7"], float(np.mean(trailing7)))
        self.assertAlmostEqual(row["rollingStd_28"], float(np.std(trailing28, ddof=0)))

    def test_future_sales_price_promo_and_truth_mutations_do_not_change_asof_features(self) -> None:
        origin = date(2026, 6, 30)
        original = self.dataset.feature_row(self.sku, origin, 7)
        isolated = copy.deepcopy(self.dataset)
        isolated.feature_cache.clear()
        future = isolated.inventory[self.sku][(origin + timedelta(days=1)).isoformat()]
        future["unitsSold"] += 1000
        future["availableHours"] = 0
        future["endingStock"] = 0
        future["unitsDemandedSynthetic"] = 100_000
        future["lostDemandSynthetic"] = 99_000
        future["stockoutFlag"] = True
        isolated.prices.setdefault(self.sku, []).append({"sku": self.sku, "announcedAt": "2026-07-01", "effectiveFrom": "2026-07-01", "priceCents": 1})
        isolated.promotions.append({"skus": [self.sku], "announcedAt": "2026-07-01", "startDate": "2026-07-01", "endDate": "2026-07-07", "discountPct": 99})
        changed = isolated.feature_row(self.sku, origin, 7)
        self.assertEqual(original, changed)
        self.assertTrue(FORBIDDEN_FEATURES.isdisjoint(original))

    def test_feature_allowlist_is_ordered_and_truth_fields_are_absent(self) -> None:
        row = self.dataset.feature_row(self.sku, date(2026, 6, 30), 14)
        contract = feature_contract()
        self.assertEqual(set(row), set(contract["featureOrder"]))
        self.assertFalse(FORBIDDEN_FEATURES.intersection(row))
        self.assertEqual(len(FEATURE_SETS["E0"]), 29)
        self.assertEqual(len(FEATURE_SETS["E1"]), 34)
        self.assertEqual(len(FEATURE_SETS["E2"]), 38)

    def test_accumulated_horizon_sums_complete_future_days(self) -> None:
        origin = date(2026, 6, 30)
        history = self.dataset.inventory[self.sku]
        for horizon in PRIMARY_HORIZONS + (28,):
            expected = sum(history[(origin + timedelta(days=step)).isoformat()]["unitsSold"] for step in range(1, horizon + 1))
            self.assertEqual(self.dataset.target(self.sku, origin, horizon), expected)
        with self.assertRaises(ValueError):
            self.dataset.target(self.sku, HISTORY_END, 1)

    def test_baseline_formulas_and_last_closed_week_order(self) -> None:
        observed = list(range(1, 29))
        self.assertEqual(baseline_prediction(observed, 1, "B0_LAST"), 28)
        self.assertEqual(baseline_prediction(observed, 1, "B1_SEASONAL_7"), 22)
        self.assertEqual(baseline_prediction(observed, 7, "B1_SEASONAL_7"), sum(range(22, 29)))
        self.assertEqual(baseline_prediction(observed, 7, "B2_MEAN_7"), 7 * np.mean(range(22, 29)))
        self.assertEqual(baseline_prediction(observed, 14, "B3_MEAN_28"), 14 * np.mean(observed))

    def test_metrics_signed_bias_and_zero_denominator(self) -> None:
        result = metric_bundle([1, 3], [2, 2])
        self.assertAlmostEqual(result["wape"], 0.5)
        self.assertAlmostEqual(result["mae"], 1.0)
        self.assertAlmostEqual(result["bias_units"], 0.0)
        self.assertAlmostEqual(result["normalized_bias"], 0.0)
        positive_bias = metric_bundle([0, 2], [2, 2])
        self.assertGreater(positive_bias["bias_units"], 0)
        self.assertGreater(positive_bias["normalized_bias"], 0)
        empty_actual = metric_bundle([0, 0], [1, 0])
        self.assertIsNone(empty_actual["wape"])
        self.assertIsNone(empty_actual["normalized_bias"])
        self.assertEqual(empty_actual["mae"], 0.5)

    def test_nonnegative_and_monotonic_cumulative_forecasts(self) -> None:
        clipped = apply_nonnegative([-1.2, 2.5])
        self.assertEqual(clipped.tolist(), [0.0, 2.5])
        forecasts, adjusted, magnitude = coherent_predictions({1: np.array([3.0, 1.0]), 7: np.array([2.0, 5.0]), 14: np.array([8.0, 4.0])})
        self.assertEqual(forecasts[1].tolist(), [3.0, 1.0])
        self.assertTrue(np.all(forecasts[1] <= forecasts[7]))
        self.assertTrue(np.all(forecasts[7] <= forecasts[14]))
        self.assertEqual(adjusted, 2)
        self.assertGreater(magnitude, 0)

    def test_segments_are_train_only_and_match_approved_counts(self) -> None:
        segments = segment_membership(self.dataset, date(2026, 6, 30))
        self.assertEqual({name: list(segments.values()).count(name) for name in ("very_low", "intermittent", "high_stable", "medium")}, {"very_low": 12, "intermittent": 17, "high_stable": 9, "medium": 42})

    def test_cold_start_and_unknown_sku_fail_safely(self) -> None:
        self.assertEqual(predict_cold_start(sku_known=False, daily_sales=[])["status"], "INSUFFICIENT_HISTORY")
        prior = predict_cold_start(sku_known=False, daily_sales=[], category_prior=0.4)
        self.assertEqual(prior["forecastSource"], "CATEGORY_PRIOR")
        limited = predict_cold_start(sku_known=True, daily_sales=[1, 0, 2, 0, 1, 0, 3])
        self.assertEqual(limited["status"], "LIMITED_HISTORY")
        self.assertAlmostEqual(limited["expectedDailyUnits"], 1.0)
        self.assertEqual(predict_cold_start(sku_known=True, daily_sales=[1, 2, 3] )["status"], "INSUFFICIENT_HISTORY")

    def test_prediction_contract_horizons_are_accumulated_float_and_no_confidence(self) -> None:
        result = prediction_contract(
            sku=self.sku, cutoff_date=HISTORY_END,
            forecast={1: 1.25, 7: 5.5, 14: 9.125},
            model_version=MODEL_VERSION,
            source_by_horizon={1: "BASELINE_FALLBACK", 7: "ML", 14: "ML"},
        )
        self.assertEqual(result["forecast"]["expectedUnitsNext7d"], 5.5)
        self.assertIsNone(result["confidence"])
        self.assertIsNone(result["predictionInterval"])
        with self.assertRaises(ValueError):
            prediction_contract(sku=self.sku, cutoff_date=HISTORY_END, forecast={1: 2, 7: 1, 14: 3}, model_version=MODEL_VERSION, source_by_horizon={1: "ML", 7: "ML", 14: "ML"})

    def test_benchmark_runner_has_local_batch_contract_smoke_dependency(self) -> None:
        self.assertIs(benchmark_minimarket_v3.predict_forecast_batch, predict_forecast_batch)

    def test_unknown_categories_are_handled_by_fit_only_encoders(self) -> None:
        import pandas as pd

        row = self.dataset.feature_row(self.sku, date(2026, 6, 30), 7)
        training = [{**row, "brand": "KNOWN"}, {**row, "brand": "KNOWN-2"}]
        unknown = [{**row, "brand": "UNSEEN-BRAND"}]
        for candidate in ("HGB-S-E2", "ET-E2"):
            columns = FEATURE_SETS["E2"]
            preprocessor = make_estimator(candidate, columns).named_steps["preprocessing"]
            preprocessor.fit(pd.DataFrame(training).loc[:, columns])
            transformed = preprocessor.transform(pd.DataFrame(unknown).loc[:, columns])
            self.assertTrue(np.isfinite(np.asarray(transformed)).all())

    def test_candidate_pipelines_fit_and_predict_with_installed_sklearn(self) -> None:
        columns = FEATURE_SETS["E2"]
        base = self.dataset.feature_row(self.sku, date(2026, 6, 30), 7)
        rows = []
        for index in range(48):
            row = dict(base)
            row["sku"] = f"SYNTH-{index % 12:02d}"
            row["categoryCode"] = f"CAT-{index % 4}"
            row["subcategoryCode"] = f"SUB-{index % 8}"
            row["brand"] = f"BRAND-{index % 10}"
            row["presentation"] = f"PRES-{index % 3}"
            row["currentUnits"] = index % 7
            row["lag_1"] = index % 11
            rows.append(row)
        frame = pd.DataFrame(rows).loc[:, columns]
        labels = np.asarray([index % 13 for index in range(len(frame))], dtype=np.float64)
        for candidate in ("HGB-S-E0", "HGB-S-E1", "HGB-S-E2", "HGB-P-E2", "ET-E2"):
            selected = FEATURE_SETS[candidate[-2:]]
            model = make_estimator(candidate, selected)
            model.fit(frame.loc[:, selected], labels)
            prediction = model.predict(frame.loc[:, selected])
            self.assertTrue(np.isfinite(prediction).all(), candidate)
            self.assertTrue((prediction >= 0).all(), candidate)

    def test_local_prediction_contract_uses_baselines_and_is_horizon_coherent(self) -> None:
        strategies = {h: {"method": "BASELINE_FALLBACK", "baseline": "B2_MEAN_7", "fallbackSegments": [], "trainedThrough": "2026-10-12"} for h in PRIMARY_HORIZONS}
        result = predict_forecast_batch(self.dataset, prediction_origin=HISTORY_END, skus=[self.sku, "UNKNOWN-SKU"], strategy_by_horizon=strategies)
        known, unknown = result
        self.assertEqual(known["status"], "READY")
        self.assertLessEqual(known["forecast"]["expectedUnitsNext1d"], known["forecast"]["expectedUnitsNext7d"])
        self.assertLessEqual(known["forecast"]["expectedUnitsNext7d"], known["forecast"]["expectedUnitsNext14d"])
        self.assertEqual(known["horizonMetadata"][0]["forecastStart"], "2026-10-13")
        self.assertEqual(known["cutoffExclusiveUtc"], "2026-10-13T05:00:00Z")
        self.assertIsNone(known["confidence"])
        self.assertEqual(unknown["status"], "UNKNOWN_SKU")

    def test_artifact_lineage_and_file_hash_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "ml/.test-tmp") as temp_dir:
            bundle = Path(temp_dir)
            model_path = bundle / "h1.joblib"
            joblib.dump(DummyRegressor(), model_path)
            digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
            manifest = {
                "scenarioId": "minimarket-pasco-v3",
                "datasetVersion": "minimarket-pasco-v3-seed2026-v1",
                "datasetSha256": DATASET_SHA256,
                "featureVersion": "pasco-forecast-features-v1",
                "featureContract": feature_contract(),
                "featureContractSha256": feature_contract()["sha256"],
                "modelVersion": MODEL_VERSION,
                "timezone": "America/Lima",
                "targetDefinition": "effective_units_sold_cumulative_t_plus_1_through_t_plus_h",
                "horizonStrategy": {"1": {"artifactModelFile": "h1.joblib"}},
                "files": {"h1.joblib": {"sha256": digest}},
            }
            self.assertIn(1, load_verified_v3_models(bundle, manifest))
            bad_version = {**manifest, "scenarioId": "m5-cloud-demo-v2"}
            with self.assertRaises(ValueError):
                load_verified_v3_models(bundle, bad_version)
            bad_features = {**manifest, "featureContractSha256": "0" * 64}
            with self.assertRaises(ValueError):
                load_verified_v3_models(bundle, bad_features)
            bad_hash = {**manifest, "files": {"h1.joblib": {"sha256": "0" * 64}}}
            with self.assertRaises(ValueError):
                load_verified_v3_models(bundle, bad_hash)


if __name__ == "__main__":
    unittest.main()
