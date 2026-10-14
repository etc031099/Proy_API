import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient
from ml.service.app import create_app
from ml.service.sales_anomalies import anomalies_data, load_anomalies
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_schemas import BUSINESS_ID, SCENARIO_ID
from ml.src.sales_isolation_forest_v3 import ARTIFACT_DIR

ROOT = Path(__file__).resolve().parents[2]
SECRET = "test-only-g4-internal-service-secret-123"


class V1:
    available = True
    def load(self):
        pass


class EvidenceRuntime(V3IntelligenceRuntime):
    def load(self):
        self.ready = True
        self.domains["business"] = True


def body(**overrides):
    return {"requestId": "g4", "mode": "anomalies", "limit": 10, "context": {
        "businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID, "asOfDate": "2026-10-12"}, **overrides}


class AnomalyServingTests(unittest.TestCase):
    def test_verified_artifact_count_serialization_and_score_semantics(self):
        _, model = load_anomalies(ROOT)
        data = model.model_dump(mode="json")
        json.dumps(data, allow_nan=False)
        self.assertEqual(data["anomalyCount"], 71)
        self.assertEqual(data["mode"], "FROZEN")
        for row in data["series"]:
            self.assertAlmostEqual(row["decisionFunction"], row["anomalyScore"]-data["threshold"])
            self.assertEqual(row["isAnomaly"], row["prediction"] == -1)
        for word in ('"accuracy"', '"probability"', "fraude", "sospechosa"):
            self.assertNotIn(word, json.dumps(data).lower())

    def test_date_filter_limit_and_read_only_copies(self):
        data = anomalies_data(ROOT, "2026-10-01", "2026-10-12", 3)
        self.assertEqual(data["filteredDays"], 12)
        self.assertLessEqual(len(data["topAnomalies"]), 3)
        data["series"][0]["revenue"] = 999999
        self.assertNotEqual(anomalies_data(ROOT)["series"][0]["revenue"], 999999)
        with self.assertRaises(ValueError):
            anomalies_data(ROOT, end="2026-10-13")
        with self.assertRaises(ValueError):
            anomalies_data(ROOT, limit=21)

    def test_corrupt_artifact_denied_before_pickle_and_cache_root_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                load_anomalies(root)
            shutil.copytree(ROOT / ARTIFACT_DIR, root / ARTIFACT_DIR)
            (root / ARTIFACT_DIR / "model.joblib").write_bytes(b"untrusted")
            with patch("ml.service.sales_anomalies.joblib.load", side_effect=AssertionError("unsafe")):
                with self.assertRaises(ValueError):
                    load_anomalies(root)

    def test_concurrent_readers(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: anomalies_data(ROOT), range(8)))
        self.assertTrue(all(r == results[0] for r in results))


class AnomalyHttpTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET})
        self.env.start()
        self.client = TestClient(create_app(runtime=V1(), v3_runtime=EvidenceRuntime(ROOT)))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()

    def post(self, payload=None, auth=SECRET):
        return self.client.post("/v3/intelligence/business", json=payload or body(),
            headers={"X-ML-Service-Secret": auth} if auth else {})

    def test_http_direct_parity_no_training(self):
        with patch("ml.src.sales_isolation_forest_v3.IsolationForest.fit", side_effect=AssertionError("fit in serving")):
            response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"], anomalies_data(ROOT, limit=10))
        self.assertEqual(response.json()["metadata"]["engineVersion"], "sales-isolation-forest-v3-v1")

    def test_auth_tenant_and_no_live_scoring(self):
        self.assertEqual(self.post(auth=None).status_code, 401)
        self.assertEqual(self.post(auth="wrong").status_code, 403)
        payload = body()
        payload["context"]["businessId"] = "OTHER"
        self.assertEqual(self.post(payload).status_code, 403)
        self.assertEqual(self.post(body(dataMode="LIVE")).status_code, 422)

    def test_dates_filters_and_limits_fail_safely(self):
        for payload, expected in [(body(period={"startDate": "2026-10-12", "endDate": "2026-10-13"}), 422),
                                  (body(period={"startDate": "2025-10-12", "endDate": "2026-10-12"}), 422),
                                  (body(productSku="PAN-FRE-001"), 400), (body(limit=21), 400)]:
            self.assertEqual(self.post(payload).status_code, expected)

    def test_missing_artifact_controlled(self):
        with patch("ml.service.sales_anomalies.load_anomalies", side_effect=FileNotFoundError("private path")):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private path", response.text)
