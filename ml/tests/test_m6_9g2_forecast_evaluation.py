"""Persisted evidence and the authenticated forecast evaluation mode; no fit/predict."""
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from ml.service.app import create_app
from ml.service.forecast_evaluation import ForecastEvaluation, load_forecast_evaluation
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_schemas import BUSINESS_ID, SCENARIO_ID, DATASET_SHA256, DATASET_VERSION

ROOT = Path(__file__).resolve().parents[2]
SECRET = "test-only-g2-evaluation-secret-123456"


class _V1:
    available = True

    def load(self):
        pass


class _EvidenceRuntime(V3IntelligenceRuntime):
    def load(self):
        self.ready = True
        self.domains["forecast"] = True


def body(**overrides):
    return {"requestId": "g2-evaluation", "mode": "evaluation", "context": {
        "businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID, "datasetVersion": DATASET_VERSION,
        "datasetSha256": DATASET_SHA256, "asOfDate": "2026-10-12"}, **overrides}


class EvaluationEvidenceTests(unittest.TestCase):
    def test_metrics_and_artifact_are_persisted_evidence(self):
        data = load_forecast_evaluation(ROOT)
        m5 = json.loads((ROOT / "ml/models/model_metadata.json").read_text())
        old, v3 = data["modelEvaluation"]
        self.assertEqual(old["metrics"]["test"]["wape"], m5["final_test_metrics"]["wape"])
        self.assertEqual(old["baseline"]["testMetrics"]["wape"], m5["baseline_test"]["wape"])
        self.assertEqual(old["artifactHash"], m5["joblib_sha256"])
        self.assertEqual(len(old["features"]), 31)
        self.assertEqual(len(v3["features"]), 38)
        self.assertEqual(v3["artifactHash"], None)
        self.assertEqual(v3["modelStatus"], "REJECTED_FOR_OPERATIONAL_USE")
        self.assertEqual(old["modelStatus"], "EVALUATED")
        self.assertEqual(v3["trainPeriod"]["endDate"], "2026-06-30")
        self.assertEqual(v3["validationPeriod"]["startDate"], "2026-07-01")
        self.assertEqual(v3["testPeriod"]["endDate"], "2026-10-12")
        self.assertEqual(data["selectedOperationalMethod"]["modelType"], "STATISTICAL_BASELINE")
        self.assertEqual(data["selectedOperationalMethod"]["horizons"], [1, 7, 14])
        self.assertFalse(data["historicalSeries"]["available"])
        self.assertEqual(data["historicalSeries"]["points"], [])
        for forbidden in ("accuracy", "precision", "recall", "artifactPath", "secret"):
            self.assertNotIn(f'"{forbidden}"', json.dumps(data))
        json.dumps(data, allow_nan=False)

    def test_cached_evidence_cannot_be_mutated_by_a_caller(self):
        data = load_forecast_evaluation(ROOT)
        data["modelEvaluation"][0]["metrics"]["test"]["wape"] = 999
        self.assertNotEqual(load_forecast_evaluation(ROOT)["modelEvaluation"][0]["metrics"]["test"]["wape"], 999)

    def test_contract_rejects_invented_metrics_and_nonfinite_values(self):
        data = load_forecast_evaluation(ROOT)
        data["modelEvaluation"][0]["metrics"]["test"]["accuracy"] = 0.99
        with self.assertRaises(ValidationError):
            ForecastEvaluation.model_validate(data)
        data = load_forecast_evaluation(ROOT)
        data["modelEvaluation"][0]["metrics"]["test"]["wape"] = float("nan")
        with self.assertRaises(ValidationError):
            ForecastEvaluation.model_validate(data)

    def test_m5_projection_matches_original_manifest_when_local_source_exists(self):
        manifest = json.loads((ROOT / "ml/data/gold/demand_features_v1_manifest.json").read_text())
        periods = json.loads((ROOT / "ml/data/forecast-evaluation-periods-v1.json").read_text())
        for split in ("train", "validation", "test"):
            period = periods[f"{split}Period"]
            self.assertEqual([period["startDate"], period["endDate"]], manifest["split_ranges"][split])


class EvaluationHttpTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET})
        self.env.start()
        self.runtime = _EvidenceRuntime(ROOT)
        self.client_context = TestClient(create_app(_V1(), self.runtime))
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.env.stop()

    def post(self, payload=None, headers=None):
        return self.client.post("/v3/intelligence/forecast", json=payload or body(),
                                headers={"X-ML-Service-Secret": SECRET} if headers is None else headers)

    def test_http_serializes_same_validated_evidence_without_forecasting(self):
        with patch("ml.src.v3_baseline_bundle.predict_many", side_effect=AssertionError("No new predictions allowed")):
            response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"], load_forecast_evaluation(ROOT))
        self.assertEqual(response.json()["metadata"]["asOfDate"], "2026-10-12")

    def test_auth_and_tenant_are_enforced(self):
        self.assertEqual(self.post(headers={}).status_code, 401)
        self.assertEqual(self.post(headers={"X-ML-Service-Secret": "wrong-secret-value-123456789012345"}).status_code, 403)
        request = body()
        request["context"]["businessId"] = "OTHER-TENANT"
        self.assertEqual(self.post(request).status_code, 403)

    def test_live_or_other_cutoff_is_not_a_historical_fallback(self):
        self.assertEqual(self.post(body(dataMode="LIVE")).status_code, 422)
        request = body()
        request["context"]["asOfDate"] = "2026-10-11"
        self.assertEqual(self.post(request).status_code, 422)

    def test_missing_evidence_is_a_safe_functional_error(self):
        with patch("ml.service.forecast_evaluation.load_forecast_evaluation", side_effect=FileNotFoundError("private/path")):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "ARTIFACT_UNAVAILABLE")
        self.assertNotIn("private/path", response.text)


if __name__ == "__main__":
    unittest.main()
