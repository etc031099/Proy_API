"""Internal CLI orchestration with validated synthetic context; no fit or Mongo."""
import unittest
from unittest.mock import patch

from ml.service import v3_ridge_prediction_impact as driver
from ml.service.v3_live_ridge import LiveRidgeError
from ml.tests.test_m6_9f3_live_context import signed_snapshot, BASE_RECORDS


class PredictionImpactDriverTests(unittest.TestCase):
    def payload(self):
        snapshot = signed_snapshot()
        return {"snapshot": snapshot.model_dump(mode="json", by_alias=True),
            "audit": {"businessId": snapshot.metadata.businessId, "scenarioId": snapshot.metadata.scenarioId,
                "horizons": [{"horizonDays": h, "beforeVersion": 1, "afterVersion": 2,
                    "before": {}, "after": {}, "comparable": True} for h in (7, 14)]},
            "products": [{"sku": "P1", "productName": "Producto"}]}

    def test_one_validated_context_reused_for_both_horizons(self):
        payload = self.payload()
        contexts = []
        def score(**kwargs):
            contexts.append(kwargs["live"])
            self.assertEqual(kwargs["skus"], ["P1"])
            return {"horizonDays": kwargs["horizon_days"], "rows": []}
        with patch.object(driver, "load_validated_dataset", return_value=object()), \
                patch.object(driver, "load_local_sources", return_value=BASE_RECORDS), \
                patch.object(driver, "score_audit_horizon", side_effect=score):
            result = driver.evaluate(payload)
        self.assertEqual(len(result["horizons"]), 2)
        self.assertIs(contexts[0], contexts[1])
        self.assertEqual(contexts[0].context_hash, payload["snapshot"]["metadata"]["snapshotHash"])

    def test_snapshot_mismatch_fails_before_scoring(self):
        payload = self.payload(); payload["snapshot"]["stockStates"][0]["onHand"] = 999
        with patch.object(driver, "load_validated_dataset", return_value=object()), \
                patch.object(driver, "load_local_sources", return_value=BASE_RECORDS), \
                patch.object(driver, "score_audit_horizon") as scorer:
            with self.assertRaises(Exception):
                driver.evaluate(payload)
            scorer.assert_not_called()

    def test_one_bad_artifact_retains_other_horizon_and_safe_reason(self):
        payload = self.payload()
        def score(**kwargs):
            if kwargs["horizon_days"] == 7:
                raise LiveRidgeError("ARTIFACT_INVALID", "raw must never appear")
            return {"horizonDays": 14, "rows": []}
        with patch.object(driver, "load_validated_dataset", return_value=object()), \
                patch.object(driver, "load_local_sources", return_value=BASE_RECORDS), \
                patch.object(driver, "score_audit_horizon", side_effect=score):
            result = driver.evaluate(payload)
        self.assertEqual([h["horizonDays"] for h in result["horizons"]], [14])
        self.assertEqual(result["errors"], [{"horizonDays": 7, "reasonCode": "ARTIFACT_INTEGRITY_FAILED"}])


if __name__ == "__main__":
    unittest.main()
