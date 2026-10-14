import json
import os
import shutil
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
import numpy as np
from fastapi.testclient import TestClient
from pydantic import ValidationError
from threadpoolctl import threadpool_limits
from ml.service.app import create_app
from ml.service.customer_clustering import clustering_data, load_clustering, RfmInput
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_schemas import CustomerRequest, BUSINESS_ID, SCENARIO_ID
from ml.src.customer_kmeans_v3 import ARTIFACT_DIR

ROOT = Path(__file__).resolve().parents[2]
SECRET = "test-only-g3-internal-secret-12345678"


class V1:
    available = True
    def load(self):
        pass


class EvidenceRuntime(V3IntelligenceRuntime):
    def load(self):
        self.ready = True
        self.domains["customer"] = True


def body(**overrides):
    return {"requestId": "g3-test", "mode": "clustering", "context": {
        "businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID, "asOfDate": "2026-10-12"}, **overrides}


class ClusteringServingTests(unittest.TestCase):
    def test_load_hash_and_assignments_match_frozen_pipeline(self):
        bundle, data = load_clustering(ROOT)
        with threadpool_limits(limits=1):
            for row in data.assignments:
                if row.status == "ELIGIBLE":
                    again = clustering_data(ROOT, row.customerRef, row.model_dump(include={"recency", "frequency", "monetary"}))
                    self.assertEqual(again["assignments"][0]["cluster"], row.cluster)
                    self.assertAlmostEqual(again["assignments"][0]["distance"], row.distance)
        self.assertEqual(bundle["pipeline"][-1].n_features_in_, 3)
        public = clustering_data(ROOT)
        json.dumps(public, allow_nan=False)
        for key in ("accuracy", "probability", "confidence", "email", "phone", "displayName"):
            self.assertNotIn(f'"{key}"', json.dumps(public))

    def test_new_customer_assignment_and_insufficient_history(self):
        with threadpool_limits(limits=1):
            data = clustering_data(ROOT, "NEW-REGISTERED", {"recency": 1, "frequency": 3, "monetary": 45}, "2026-10-14")
        self.assertEqual(data["assignments"][0]["status"], "ASSIGNED")
        self.assertEqual(data["assignmentAsOfDate"], "2026-10-14")
        no_history = clustering_data(ROOT, "NEW-REGISTERED", {"recency": None, "frequency": 0, "monetary": 0})
        self.assertEqual(no_history["assignments"][0]["status"], "INSUFFICIENT_HISTORY")
        self.assertIsNone(no_history["assignments"][0]["cluster"])
        with self.assertRaises(LookupError):
            clustering_data(ROOT, "FOREIGN")
        with self.assertRaises(ValidationError):
            RfmInput(recency=1, frequency=float("nan"), monetary=1)

    def test_hash_tampering_rejected_before_deserialization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / ARTIFACT_DIR, root / ARTIFACT_DIR)
            artifact = root / ARTIFACT_DIR / "model.joblib"
            artifact.write_bytes(b"not a pickle")
            with patch("ml.service.customer_clustering.joblib.load", side_effect=AssertionError("unsafe load")):
                with self.assertRaises(ValueError):
                    load_clustering(root)

    def test_response_copy_and_schema_scope(self):
        data = clustering_data(ROOT)
        data["clusters"][0]["name"] = "changed"
        self.assertNotEqual(clustering_data(ROOT)["clusters"][0]["name"], "changed")
        with self.assertRaises(ValidationError):
            CustomerRequest.model_validate(body(period={"startDate": "2026-10-01", "endDate": "2026-10-12"}))
        with self.assertRaises(ValidationError):
            CustomerRequest.model_validate(body(assignmentRfm={"recency": 1, "frequency": 3, "monetary": 45}))

    def test_concurrent_readers_and_root_cache_isolation(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: clustering_data(ROOT), range(8)))
        self.assertTrue(all(result == results[0] for result in results))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                clustering_data(Path(directory))


class ClusteringHttpTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET})
        self.env.start()
        self.client = TestClient(create_app(runtime=V1(), v3_runtime=EvidenceRuntime(ROOT)))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()

    def post(self, payload=None, auth=SECRET):
        return self.client.post("/v3/intelligence/customers", json=payload or body(),
                                headers={"X-ML-Service-Secret": auth} if auth else {})

    def test_http_contract_direct_parity_no_training(self):
        with patch("ml.src.customer_kmeans_v3.KMeans.fit", side_effect=AssertionError("HTTP must never fit")):
            response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"], clustering_data(ROOT))

    def test_security(self):
        self.assertEqual(self.post(auth=None).status_code, 401)
        self.assertEqual(self.post(auth="wrong").status_code, 403)
        payload = body()
        payload["context"]["businessId"] = "OTHER"
        self.assertEqual(self.post(payload).status_code, 403)
        self.assertEqual(self.post(body(customerCode="FOREIGN")).status_code, 404)

    def test_future_input_is_assignment_not_training_and_historical_guard(self):
        with threadpool_limits(limits=1):
            response = self.post(body(customerCode="NEW", assignmentRfm={"recency": 1, "frequency": 3, "monetary": 45}, assignmentAsOfDate="2026-10-14"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"]["trainingCutoff"], "2026-10-12")
        self.assertEqual(response.json()["data"]["assignmentAsOfDate"], "2026-10-14")
        payload = body()
        payload["context"]["asOfDate"] = "2026-10-11"
        self.assertEqual(self.post(payload).status_code, 422)
        self.assertEqual(self.post(body(dataMode="LIVE")).status_code, 422)

    def test_missing_artifact_controlled(self):
        with patch("ml.service.customer_clustering.load_clustering", side_effect=FileNotFoundError("private path")):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private path", response.text)
