import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from ml.src.sales_isolation_forest_v3 import ARTIFACT_DIR, PARAMS, FEATURES, START, TRAIN_END, build_daily, matrix, train

ROOT = Path(__file__).resolve().parents[2]


class SalesAnomalyTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = ROOT / ARTIFACT_DIR
        cls.meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        cls.rows = json.loads((directory / "training-daily.json").read_text(encoding="utf-8"))
        cls.daily = json.loads((directory / "daily-results.json").read_text(encoding="utf-8"))
        cls.bundle = joblib.load(directory / "model.joblib")

    def test_daily_completeness_and_cutoffs(self):
        self.assertEqual(len(self.rows), 365)
        self.assertEqual(self.rows[0]["date"], START)
        self.assertEqual(self.rows[-1]["date"], "2026-10-12")
        self.assertEqual(self.meta["sampleCount"], 261)
        self.assertEqual(self.meta["splitCounts"], {"train": 261, "validation": 46, "retrospective": 58})
        self.assertEqual(sum(row["tickets"] for row in self.rows), 12647)

    def test_zero_vs_missing_is_not_imputed(self):
        dates = [row["date"] for row in self.rows]
        runtime = SimpleNamespace(records={"sales": [], "saleItems": []}, dataset=SimpleNamespace(
            calendar={day: {"holidayCode": None} for day in dates}, product_by_sku={"A": {}},
            inventory={"A": {day: {"unitsSold": 0} for day in dates}}))
        zero = build_daily(runtime)
        self.assertEqual(zero[0]["status"], "ZERO_ACTIVITY")
        self.assertIsNone(zero[0]["averageTicket"])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "ZERO_ACTIVITY_NOT_SCORED"):
                train(zero, self.meta["sourceLogicalHash"], directory)
        del runtime.dataset.calendar[dates[1]]
        missing = build_daily(runtime)
        self.assertEqual(missing[1], {"date": dates[1], "status": "DATA_INCOMPLETE"})
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "DATA_INCOMPLETE"):
                train(missing, self.meta["sourceLogicalHash"], directory)

    def test_features_use_train_only_weekday_references(self):
        self.assertEqual(FEATURES, ["weekdayLogTicketsDeviation", "weekdayLogAverageTicketDeviation"])
        x = matrix(self.rows)
        prep = self.bundle["preprocessing"]
        for weekday in range(1, 8):
            train_mask = np.array([r["date"] <= TRAIN_END and r["weekday"] == weekday for r in self.rows])
            np.testing.assert_allclose(prep.weekday_medians_[weekday], np.median(np.log1p(x[train_mask, 1:]), axis=0))
        mutated = x.copy()
        mutated[300:, 1:] *= 10000
        from ml.src.sales_isolation_forest_v3 import WeeklyLogResiduals
        another = WeeklyLogResiduals().fit(mutated[:261])
        for weekday in range(1, 8):
            np.testing.assert_array_equal(another.weekday_medians_[weekday], prep.weekday_medians_[weekday])

    def test_contamination_candidates_match_sklearn_and_scores(self):
        self.assertEqual([r["contamination"] for r in self.meta["candidates"]], ["auto", .01, .02, .03, .05])
        transformed = self.bundle["preprocessing"].transform(matrix(self.rows))
        numeric = IsolationForest(**(PARAMS | {"contamination": .05})).fit(transformed[:261])
        candidate = self.meta["candidates"][-1]
        self.assertAlmostEqual(numeric.offset_, candidate["threshold"])
        self.assertEqual(int((numeric.predict(transformed) == -1).sum()), candidate["anomalyCount"])
        scores = self.bundle["model"].score_samples(transformed)
        np.testing.assert_array_equal(scores, [row["anomalyScore"] for row in self.daily])
        self.assertEqual(self.meta["anomalyCount"], 71)
        self.assertEqual(sum(row["isAnomaly"] for row in self.daily), 71)

    def test_deterministic_training_and_frozen_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            again = train(self.rows, self.meta["sourceLogicalHash"], directory, self.meta["trainingTimestamp"])
            self.assertEqual({k: v for k, v in again.items() if k != "artifactHash"},
                             {k: v for k, v in self.meta.items() if k != "artifactHash"})

    def test_canonical_daily_source_matches_projection(self):
        from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
        runtime = V3IntelligenceRuntime(ROOT)
        runtime.load()
        self.assertEqual(build_daily(runtime), self.rows)

    def test_past_only_temporal_folds_and_no_classification_metrics(self):
        self.assertEqual([f["fitCutoff"] for f in self.meta["temporalFolds"]], ["2026-03-31", "2026-05-31"])
        self.assertGreater(self.meta["stability"]["developmentJaccardMean"], .7)
        for forbidden in ("accuracy", "precision", "recall", "f1", "probability"):
            self.assertNotIn(f'"{forbidden}"', json.dumps(self.meta))
