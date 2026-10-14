import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
from threadpoolctl import threadpool_limits
from ml.src.customer_kmeans_v3 import ARTIFACT_DIR, FEATURES, dataset_from_customers, matrix, pipeline, train, logical_hash

ROOT = Path(__file__).resolve().parents[2]


class CustomerTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta = json.loads((ROOT / ARTIFACT_DIR / "metadata.json").read_text(encoding="utf-8"))
        cls.rows = json.loads((ROOT / ARTIFACT_DIR / "training-rfm.json").read_text(encoding="utf-8"))

    def test_eligibility_zeros_and_consumer_final(self):
        self.assertEqual(len(self.rows), 40)
        self.assertEqual(len(matrix(self.rows)), 38)
        self.assertEqual(sum(r["status"] == "INSUFFICIENT_HISTORY" for r in self.rows), 2)
        self.assertEqual(sum(r["frequency"] == 0 for r in self.rows if r["status"] == "ELIGIBLE"), 3)
        self.assertNotIn("CONSUMER_FINAL", [r["customerRef"] for r in self.rows])
        raw = {"customerCode": "CONSUMER_FINAL", "ticketCount": 1, "segment": "INACTIVE",
               "rfm90d": {"raw": {"recencyDays": 1, "frequency90d": 1, "monetary90dCents": 10}}}
        converted = dataset_from_customers([raw, {**raw, "customerCode": "A"}])
        self.assertEqual([r["customerRef"] for r in converted], ["A"])
        with self.assertRaises(ValueError):
            dataset_from_customers([{**raw, "customerCode": "A"}]*2)

    def test_preprocessing_is_finite_and_identifiers_are_not_features(self):
        self.assertEqual(FEATURES, ["recency", "frequency", "monetary"])
        x = matrix(self.rows)
        with threadpool_limits(limits=1):
            p = pipeline(4).fit(x)
        np.testing.assert_allclose(p["log"].transform(x), np.log1p(x))
        np.testing.assert_allclose(p[:-1].transform(x).mean(axis=0), 0, atol=1e-12)
        with self.assertRaises(ValueError):
            matrix([{**self.rows[0], "status": "ELIGIBLE", "recency": -1}])

    def test_candidates_and_stability_are_real(self):
        self.assertEqual({c["k"] for c in self.meta["candidates"]}, {2, 3, 4, 5})
        self.assertEqual(len(self.meta["candidates"]), 8)
        self.assertEqual(self.meta["k"], 4)
        self.assertGreater(self.meta["metrics"]["subsampleAriMin"], .8)
        self.assertEqual(self.meta["scalerSensitivityAri"], 1)
        self.assertEqual(sum(c["size"] for c in self.meta["clusters"]), 38)
        self.assertEqual(self.meta["trainingDataHash"], logical_hash(self.rows))

    def test_deterministic_rerun(self):
        with tempfile.TemporaryDirectory() as directory:
            again = train(self.rows, self.meta["sourceLogicalHash"], directory)
            self.assertEqual(again, self.meta)

    def test_canonical_read_only_dataset_matches_frozen_training_rows(self):
        from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
        runtime = V3IntelligenceRuntime(ROOT)
        runtime.load()
        rows = dataset_from_customers(runtime.customers.snapshot()["customers"])
        self.assertEqual(rows, self.rows)
