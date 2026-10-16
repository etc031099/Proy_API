"""Small contract tests; local Mongo bootstrap is covered separately by the JS integration."""
import unittest
import hashlib
from datetime import date
from types import SimpleNamespace

from ml.service import v3_live_ridge as live
from ml.service import v3_ridge_training as worker


class RidgeTrainingContractTests(unittest.TestCase):
    def test_feature_and_policy_hashes_are_frozen(self):
        self.assertEqual(live.FEATURE_HASH, "84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5")
        self.assertEqual(live.PROMOTION_POLICY_HASH, "522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3")

    def test_recipe_is_exact_ridge27(self):
        model = worker.recipe()
        pre = model.named_steps["preprocessing"]
        ridge = model.named_steps["estimator"]
        self.assertEqual((ridge.alpha, ridge.solver, ridge.tol), (10.0, "lsqr", 0.0001))
        self.assertEqual(pre.transformers[0][2], list(live.CATEGORICAL_FEATURES))
        self.assertEqual(pre.transformers[1][2], list(live.NUMERIC_FEATURES))
        self.assertEqual(len(live.FEATURE_ORDER), 27)

    def test_approved_bootstrap_evidence_is_exact(self):
        for horizon in (7, 14):
            evidence = worker._approved_evidence(horizon)
            self.assertTrue(evidence["eligible"])
            self.assertEqual(evidence["candidate"], live.RECIPE_ID)

    def test_horizon_one_is_never_trained(self):
        with self.assertRaises(worker.TrainingError) as failure:
            worker.train({"businessId": worker.BUSINESS_ID, "scenarioId": worker.v3_forecast.SCENARIO_ID,
                          "horizonDays": 1})
        self.assertEqual(failure.exception.code, "MODEL_NOT_APPROVED")

    def test_canonical_hash_does_not_depend_on_map_insertion_order(self):
        self.assertEqual(worker.digest({"b": 1, "a": [2, 3]}),
                         worker.digest({"a": [2, 3], "b": 1}))

    def test_open_day_sale_is_not_a_closed_label(self):
        dataset = SimpleNamespace(products=[{"productKey": "v3.PAN-001", "sku": "PAN-001"}])
        journal = [{"revision": "1", "eventOrdinal": 0, "entityType": "sale", "operation": "CREATE",
                    "projection": {"saleKey": "new", "initialStatus": "completed", "localDate": "2026-10-16",
                                   "occurredAtUtc": "2026-10-16T14:00:00Z", "lines": [{"productKey": "v3.PAN-001",
                                                                                 "sku": "PAN-001", "quantity": 3}]}}]
        _, closed_rows, _ = worker._journal_overlay(dataset, journal, date(2026, 10, 15))
        self.assertEqual(closed_rows[("v3.PAN-001", date(2026, 10, 15))]["unitsSold"], 0)

    def test_bootstrap_artifact_roundtrips_through_safe_loader(self):
        result = worker.train({"businessId": worker.BUSINESS_ID,
                               "scenarioId": worker.v3_forecast.SCENARIO_ID,
                               "horizonDays": 7, "inputDataVersion": "0",
                               "observationsClosedThrough": "2026-10-15",
                               "journal": [], "mode": "bootstrap"})
        artifact = {**result["artifact"], "modelVersion": 1}
        raw = worker.canonical(artifact)
        metadata = {"businessId": worker.BUSINESS_ID,
                    "scenarioId": worker.v3_forecast.SCENARIO_ID, "horizonDays": 7,
                    "status": "ACTIVE", "modelFamily": live.MODEL_FAMILY,
                    "recipeId": live.RECIPE_ID, "featureVersion": live.FEATURE_VERSION,
                    "featureHash": live.FEATURE_HASH,
                    "promotionPolicyVersion": live.PROMOTION_POLICY_VERSION,
                    "promotionPolicyHash": live.PROMOTION_POLICY_HASH,
                    "artifactBytes": len(raw), "artifactHash": hashlib.sha256(raw).hexdigest(),
                    "modelVersion": 1}
        loaded = live.load_verified_ridge_artifact({"metadata": metadata, "artifactData": raw},
                                                   business_id=worker.BUSINESS_ID,
                                                   scenario_id=worker.v3_forecast.SCENARIO_ID,
                                                   horizon_days=7)
        dataset = worker.v3_forecast.load_validated_dataset(worker.ROOT)
        feature = dataset.feature_row("BEB-GAS-001", date(2026, 9, 1), 7)
        row = {name: feature[name] for name in live.FEATURE_ORDER}
        self.assertGreaterEqual(live.score_ridge(row, loaded), 0.0)


if __name__ == "__main__":
    unittest.main()
