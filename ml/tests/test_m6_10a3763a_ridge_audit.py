"""Offline audit-scoring contract; synthetic artifacts, no fit/Mongo/network."""
import base64
import copy
import hashlib
import json
import unittest
from datetime import date
from unittest.mock import patch

from ml.service import v3_ridge_audit as audit
from ml.service.v3_live_ridge import LiveRidgeError, load_verified_ridge_artifact, ridge_live_forecast, SCENARIO_ID
from ml.tests.test_m6_10a32_live_ridge import _artifact, _fixture, BUSINESS, SKU


def envelope(version, horizon=7, intercept=1):
    body, result = _artifact(model_version=version, horizon=horizon)
    body["coefficients"] = [0.0] * len(body["coefficients"])
    body["intercept"] = intercept
    raw = json.dumps(body).encode()
    result["metadata"].update(status="SUPERSEDED", artifactBytes=len(raw),
                              artifactHash=hashlib.sha256(raw).hexdigest())
    return {"metadata": result["metadata"], "artifactBase64": base64.b64encode(raw).decode()}


class AuditTests(unittest.TestCase):
    def test_both_exact_versions_score_same_snapshot_and_same_features_without_mutation(self):
        for horizon in (7, 14):
            dataset, live, *_ = _fixture()
            old, new = envelope(2, horizon, 3), envelope(4, horizon, 5)
            original = copy.deepcopy(live.__dict__)
            with patch.object(audit, 'build_live_features', wraps=audit.build_live_features) as build:
                result = audit.score_audit_horizon(dataset=dataset, live=live, business_id=BUSINESS,
                    scenario_id=SCENARIO_ID, horizon_days=horizon, before_version=2, after_version=4,
                    before=old, after=new, skus=[SKU])
                self.assertEqual(build.call_count, 1)
                self.assertIs(build.call_args.args[0], dataset)
                self.assertIs(build.call_args.args[1], live)
            self.assertEqual(result["rows"], [{"sku": SKU, "oldPrediction": 3.0,
                "newPrediction": 5.0, "reasonCode": None}])
            self.assertEqual(result["snapshotHash"], live.context_hash)
            self.assertEqual(live.__dict__, original)
            self.assertEqual(old["metadata"]["status"], "SUPERSEDED")

    def test_public_loader_and_live_serving_still_reject_superseded(self):
        item = envelope(2)
        raw = {"metadata": item["metadata"], "artifactData": base64.b64decode(item["artifactBase64"])}
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact(raw, business_id=BUSINESS, scenario_id=SCENARIO_ID, horizon_days=7)
        dataset, live, *_ = _fixture()
        result = ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7, registry_loader=lambda **_: raw)
        self.assertIsNone(result["predictionUnits"])
        self.assertEqual(result["reasonCode"], "ARTIFACT_INVALID")

    def test_integrity_scope_version_recipe_and_schema_are_not_relaxed(self):
        mutations = [lambda x: x["metadata"].update(artifactHash="0" * 64),
            lambda x: x["metadata"].update(businessId="OTHER"),
            lambda x: x["metadata"].update(scenarioId="OTHER"),
            lambda x: x["metadata"].update(horizonDays=14),
            lambda x: x["metadata"].update(modelVersion=99),
            lambda x: x["metadata"].update(recipeId="OTHER"),
            lambda x: x["metadata"].update(featureHash="0" * 64),
            lambda x: x["metadata"].update(status="CANDIDATE"),
            lambda x: x.update(artifactBase64="not base64!")]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                item = envelope(2); mutate(item)
                with self.assertRaises(LiveRidgeError):
                    audit.load_audit_ridge_artifact(item, expected_version=2, business_id=BUSINESS,
                        scenario_id=SCENARIO_ID, horizon_days=7)

    def test_unavailable_features_do_not_become_zero(self):
        dataset, live, *_ = _fixture(missing_day=date(2026, 10, 14))
        result = audit.score_audit_horizon(dataset=dataset, live=live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, horizon_days=7, before_version=2, after_version=4,
            before=envelope(2), after=envelope(4), skus=[SKU])
        self.assertIsNone(result["rows"][0]["oldPrediction"])
        self.assertIsNone(result["rows"][0]["newPrediction"])
        self.assertIsNotNone(result["rows"][0]["reasonCode"])

    def test_rehashed_invalid_schema_or_parameters_still_fail(self):
        for field, value in (("extra", "invalid"), ("schemaVersion", "wrong"),
                             ("modelVersion", 99), ("scalerScale", [0.0] * 21)):
            item = envelope(2)
            body = json.loads(base64.b64decode(item["artifactBase64"]))
            body[field] = value
            raw = json.dumps(body).encode()
            item.update(artifactBase64=base64.b64encode(raw).decode())
            item["metadata"].update(artifactHash=hashlib.sha256(raw).hexdigest(), artifactBytes=len(raw))
            with self.subTest(field=field), self.assertRaises(LiveRidgeError):
                audit.load_audit_ridge_artifact(item, expected_version=2, business_id=BUSINESS,
                    scenario_id=SCENARIO_ID, horizon_days=7)

    def test_one_day_is_rejected_without_forecast(self):
        with self.assertRaises(LiveRidgeError):
            audit.load_audit_ridge_artifact(envelope(2, 1), expected_version=2,
                business_id=BUSINESS, scenario_id=SCENARIO_ID, horizon_days=1)

    def test_duplicate_or_oversized_universe_is_rejected(self):
        dataset, live, *_ = _fixture()
        for skus in ([SKU, SKU], [str(i) for i in range(201)]):
            with self.assertRaises(LiveRidgeError):
                audit.score_audit_horizon(dataset=dataset, live=live, business_id=BUSINESS,
                    scenario_id=SCENARIO_ID, horizon_days=7, before_version=2, after_version=4,
                    before=envelope(2), after=envelope(4), skus=skus)


if __name__ == "__main__":
    unittest.main()
