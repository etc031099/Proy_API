from __future__ import annotations

import asyncio
import json
import os
import shutil
import unittest
import uuid
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from ml.service.app import MAX_BODY_BYTES, create_app
from ml.service.model_runtime import ModelRuntime, ModelUnavailableError
from ml.service.schemas import PredictionRequest
from ml.src.common import repository_path


SERVICE_SECRET = "test-only-ml-service-secret-1234567890"
ANCHOR = date(2025, 7, 1)


def daily_sales(days: int = 181) -> list[dict[str, object]]:
    start = ANCHOR - timedelta(days=days - 1)
    return [
        {
            "date": (start + timedelta(days=index)).isoformat(),
            "unitsSold": index % 5,
        }
        for index in range(days)
    ]


def item(
    product_id: str = "product-1",
    sku: str = "M5-FOODS_1_033",
    *,
    days: int = 181,
) -> dict[str, object]:
    history = daily_sales(days)
    return {
        "productId": product_id,
        "sku": sku,
        "stockAtAnchor": 18,
        "minStockLevel": 3,
        "historyCoverage": {
            "start": history[0]["date"],
            "end": history[-1]["date"],
            "complete": True,
        },
        "dailySales": history,
    }


def payload(items: list[dict[str, object]] | None = None) -> dict[str, object]:
    return {
        "requestId": "request-r5d",
        "context": {
            "businessId": "ML-CLOUD-DEMO",
            "scenarioId": "m5-ca3-cloud-demo-v1",
            "anchorStrategy": "latest_eligible_historical_anchor",
            "anchorOperationalDate": ANCHOR.isoformat(),
            "timezone": "UTC",
        },
        "items": items or [item()],
    }


class R5DServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.environment = patch.dict(
            os.environ,
            {"ML_SERVICE_SECRET": SERVICE_SECRET},
            clear=False,
        )
        cls.environment.start()
        cls.runtime = ModelRuntime()
        cls.client_context = TestClient(create_app(cls.runtime))
        cls.client = cls.client_context.__enter__()
        cls.headers = {"X-ML-Service-Secret": SERVICE_SECRET}

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client_context.__exit__(None, None, None)
        cls.environment.stop()

    def test_startup_health_and_ready(self) -> None:
        self.assertTrue(self.runtime.available)
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(
            health.json(),
            {
                "status": "ok",
                "modelLoaded": True,
                "modelName": "demand_forecast_v1",
                "modelVersion": "1.0.0",
                "featureSetVersion": "demand-v1",
                "featuresCount": 31,
                "joblibSha256": "82f133a33904",
            },
        )
        self.assertEqual(self.client.get("/ready").json(), {"status": "ready"})

    def test_descriptive_metadata_comes_from_lineage(self) -> None:
        response = self.client.post("/v1/predict/demand", json=payload(), headers=self.headers)
        self.assertEqual(response.status_code, 200)
        row = response.json()["results"][0]
        self.assertEqual(row["category"], "FOODS")
        self.assertEqual(row["department"], "FOODS_1")
        self.assertEqual(response.json()["featureSetVersion"], "demand-v1")

    def test_secret_missing_and_incorrect(self) -> None:
        self.assertEqual(
            self.client.post("/v1/predict/demand", json=payload()).status_code, 401
        )
        response = self.client.post(
            "/v1/predict/demand",
            json=payload(),
            headers={"X-ML-Service-Secret": "x" * 40},
        )
        self.assertEqual(response.status_code, 403)
        self.assertNotIn(SERVICE_SECRET, response.text)

    def test_malformed_json_and_structure_are_400(self) -> None:
        malformed = self.client.post(
            "/v1/predict/demand",
            content="{",
            headers={**self.headers, "Content-Type": "application/json"},
        )
        self.assertEqual(malformed.status_code, 400)
        invalid = self.client.post(
            "/v1/predict/demand", json={"requestId": "missing-fields"}, headers=self.headers
        )
        self.assertEqual(invalid.status_code, 400)

    def test_single_prediction_is_finite_and_deterministic(self) -> None:
        first = self.client.post(
            "/v1/predict/demand", json=payload(), headers=self.headers
        )
        second = self.client.post(
            "/v1/predict/demand", json=payload(), headers=self.headers
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json(), second.json())
        result = first.json()["results"][0]
        self.assertEqual(result["status"], "READY")
        self.assertTrue(np.isfinite(result["predictedDemand7d"]))
        self.assertGreaterEqual(result["predictedDemand7d"], 0)
        self.assertNotIn("recommendedQty", first.text)

    def test_item_failures_do_not_break_ready_items(self) -> None:
        mixed = payload(
            [
                item("ready"),
                item("missing", "M5-UNKNOWN"),
                item("short", "M5-FOODS_1_063", days=56),
            ]
        )
        response = self.client.post(
            "/v1/predict/demand", json=mixed, headers=self.headers
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [entry["status"] for entry in response.json()["results"]],
            ["READY", "MISSING_LINEAGE", "INSUFFICIENT_HISTORY"],
        )

    def test_duplicate_product_id_is_rejected(self) -> None:
        response = self.client.post(
            "/v1/predict/demand",
            json=payload([item("same", "M5-FOODS_1_033"), item("same", "M5-FOODS_1_034")]),
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "DUPLICATE_BATCH_ITEM")
        self.assertEqual(response.json()["detail"]["field"], "productId")

    def test_duplicate_sku_is_rejected(self) -> None:
        response = self.client.post(
            "/v1/predict/demand",
            json=payload([item("p1"), item("p2")]),
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["field"], "sku")

    def test_duplicate_sku_with_different_product_id_is_rejected(self) -> None:
        response = self.client.post(
            "/v1/predict/demand",
            json=payload([item("p1", "M5-FOODS_1_033"), item("p2", "M5-FOODS_1_033")]),
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["field"], "sku")

    def test_duplicate_product_id_with_different_sku_is_rejected(self) -> None:
        response = self.client.post(
            "/v1/predict/demand",
            json=payload([item("same", "M5-FOODS_1_033"), item("same", "M5-FOODS_1_034")]),
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["field"], "productId")

    def test_unique_batch_is_accepted(self) -> None:
        response = self.client.post(
            "/v1/predict/demand",
            json=payload([item("p1", "M5-FOODS_1_033"), item("p2", "M5-FOODS_1_063")]),
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([entry["status"] for entry in response.json()["results"]], ["READY", "READY"])

    def test_duplicate_batch_does_not_execute_pipeline(self) -> None:
        original = self.runtime.pipeline
        calls = 0

        class CountingPipeline:
            def predict(self, frame):
                nonlocal calls
                calls += 1
                return original.predict(frame)

        self.runtime.pipeline = CountingPipeline()
        try:
            response = self.client.post(
                "/v1/predict/demand",
                json=payload([item("same", "M5-FOODS_1_033"), item("same", "M5-FOODS_1_034")]),
                headers=self.headers,
            )
        finally:
            self.runtime.pipeline = original
        self.assertEqual(response.status_code, 422)
        self.assertEqual(calls, 0)

    def test_invalid_history_is_an_item_status(self) -> None:
        invalid = item()
        invalid["dailySales"][50]["date"] = invalid["dailySales"][49]["date"]
        response = self.client.post(
            "/v1/predict/demand",
            json=payload([invalid]),
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"][0]["status"], "INVALID_HISTORY")

    def test_ambiguous_zero_window_is_not_predicted_even_with_complete_coverage(self) -> None:
        ambiguous = item(days=57)
        for record in ambiguous["dailySales"]:
            record["unitsSold"] = 0
        with patch.object(self.runtime.pipeline, "predict") as predict:
            batch = self.runtime.predict_batch(PredictionRequest.model_validate(payload([ambiguous])))
            self.assertEqual(batch.ready_count, 0)
            self.assertIsNone(batch.results[0].predictedDemand7d)
            response = self.client.post(
                "/v1/predict/demand", json=payload([ambiguous]), headers=self.headers
            )
            predict.assert_not_called()
        self.assertEqual(response.status_code, 200)
        result = response.json()["results"][0]
        self.assertEqual(result["status"], "INSUFFICIENT_HISTORY")
        self.assertIsNone(result.get("predictedDemand7d"))
        self.assertIn("recency", result["message"])

    def test_57_zero_days_from_introduction_are_ready_with_gold_recency(self) -> None:
        never_sold = item(days=57)
        for record in never_sold["dailySales"]:
            record["unitsSold"] = 0
        item_id = never_sold["sku"].removeprefix("M5-")
        product = self.runtime.builder.products[item_id]
        # In-memory fixture only: introduction coincides with the coverage start.
        active_start = ANCHOR - timedelta(days=56 + self.runtime.builder.manifest["date_offset_days"])
        with patch.dict(self.runtime.builder.products, {item_id: product._replace(active_start=active_start)}):
            with patch.object(self.runtime.pipeline, "predict", wraps=self.runtime.pipeline.predict) as predict:
                response = self.client.post(
                    "/v1/predict/demand", json=payload([never_sold]), headers=self.headers
                )
                predict.assert_called_once()
                row = predict.call_args.args[0].iloc[0]
                self.assertEqual(row["has_prior_sale"], 0)
                self.assertEqual(row["days_since_last_sale"], 57)
        self.assertEqual(response.status_code, 200)
        result = response.json()["results"][0]
        self.assertEqual(result["status"], "READY")
        self.assertTrue(np.isfinite(result["predictedDemand7d"]))

    def test_ambiguous_recency_does_not_prevent_other_items_from_predicting(self) -> None:
        ambiguous = item("ambiguous", "M5-FOODS_1_063", days=57)
        for record in ambiguous["dailySales"]:
            record["unitsSold"] = 0
        with patch.object(self.runtime.pipeline, "predict", wraps=self.runtime.pipeline.predict) as predict:
            response = self.client.post(
                "/v1/predict/demand",
                json=payload([item("ready", days=57), ambiguous]),
                headers=self.headers,
            )
            predict.assert_called_once()
            self.assertEqual(len(predict.call_args.args[0]), 1)
        self.assertEqual(response.status_code, 200)
        ready, rejected = response.json()["results"]
        self.assertEqual(ready["status"], "READY")
        self.assertTrue(np.isfinite(ready["predictedDemand7d"]))
        self.assertEqual(rejected["status"], "INSUFFICIENT_HISTORY")
        self.assertIsNone(rejected.get("predictedDemand7d"))

    def test_impossible_global_context_is_422(self) -> None:
        invalid = payload()
        invalid["context"]["anchorOperationalDate"] = "2025-06-30"
        response = self.client.post(
            "/v1/predict/demand", json=invalid, headers=self.headers
        )
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("Traceback", response.text)

    def test_payload_limits_are_413(self) -> None:
        too_many = [item(f"product-{index}") for index in range(61)]
        response = self.client.post(
            "/v1/predict/demand", json=payload(too_many), headers=self.headers
        )
        self.assertEqual(response.status_code, 413)
        long_item = item()
        long_item["dailySales"] = daily_sales(367)
        long_item["historyCoverage"]["start"] = long_item["dailySales"][0]["date"]
        response = self.client.post(
            "/v1/predict/demand", json=payload([long_item]), headers=self.headers
        )
        self.assertEqual(response.status_code, 413)

    def send_body_chunks(self, chunks, *, declared_size=None, authenticated=True):
        """Exercise actual ASGI receive messages without HTTPX coalescing chunks."""
        headers = [(b"content-type", b"application/json")]
        if authenticated:
            headers.append((b"x-ml-service-secret", SERVICE_SECRET.encode()))
        if declared_size is not None:
            headers.append((b"content-length", str(declared_size).encode()))
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST", "scheme": "http", "path": "/v1/predict/demand",
            "raw_path": b"/v1/predict/demand", "query_string": b"",
            "headers": headers, "server": ("testserver", 80), "client": ("testclient", 1),
        }
        sent = []
        received = 0

        async def receive():
            nonlocal received
            if received >= len(chunks):
                raise AssertionError("Unexpected read after final body chunk")
            index = received
            received += 1
            return {"type": "http.request", "body": chunks[index], "more_body": received < len(chunks)}

        async def send(message):
            sent.append(message)

        asyncio.run(self.client.app(scope, receive, send))
        response_status = next(message["status"] for message in sent if message["type"] == "http.response.start")
        body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
        return response_status, json.loads(body), received

    def test_small_body_without_content_length_is_accepted(self) -> None:
        code, body, _ = self.send_body_chunks([json.dumps(payload()).encode()])
        self.assertEqual(code, 200)
        self.assertEqual(body["results"][0]["status"], "READY")

    def test_declared_oversize_is_rejected_without_reading_body(self) -> None:
        code, body, reads = self.send_body_chunks([b"{}"], declared_size=MAX_BODY_BYTES + 1)
        self.assertEqual(code, 413)
        self.assertEqual(body, {"detail": "Request payload is too large"})
        self.assertEqual(reads, 0)

    def test_oversize_without_content_length_is_rejected(self) -> None:
        code, body, _ = self.send_body_chunks([b" " * (MAX_BODY_BYTES + 1)])
        self.assertEqual(code, 413)
        self.assertEqual(body, {"detail": "Request payload is too large"})

    def test_chunked_oversize_stops_receiving_at_limit(self) -> None:
        chunk = b" " * (MAX_BODY_BYTES // 4)
        with patch.object(self.runtime.pipeline, "predict") as predict:
            code, body, reads = self.send_body_chunks([chunk] * 4 + [b"x", b"never read"])
            predict.assert_not_called()
        self.assertEqual(code, 413)
        self.assertEqual(body, {"detail": "Request payload is too large"})
        self.assertEqual(reads, 5)

    def test_underreported_content_length_cannot_bypass_limit(self) -> None:
        code, _, _ = self.send_body_chunks([b" " * MAX_BODY_BYTES, b"x"], declared_size=1)
        self.assertEqual(code, 413)

    def test_valid_payload_at_and_below_limit_is_accepted(self) -> None:
        encoded = json.dumps(payload()).encode()
        for size in (MAX_BODY_BYTES - 1, MAX_BODY_BYTES):
            with self.subTest(size=size):
                padding = b" " * (size - len(encoded))
                code, body, _ = self.send_body_chunks([encoded, padding], declared_size=size)
                self.assertEqual(code, 200)
                self.assertEqual(body["results"][0]["status"], "READY")

    def test_small_invalid_body_keeps_validation_error(self) -> None:
        code, body, _ = self.send_body_chunks([b"{}"])
        self.assertEqual(code, 400)
        self.assertEqual(body, {"detail": "Request validation failed"})

    def test_oversize_without_secret_is_limited_before_authentication(self) -> None:
        code, body, reads = self.send_body_chunks([b" " * MAX_BODY_BYTES, b"x", b"never read"], authenticated=False)
        self.assertEqual(code, 413)
        self.assertEqual(body, {"detail": "Request payload is too large"})
        self.assertEqual(reads, 2)

    def test_feature_order_and_negative_prediction_clipping(self) -> None:
        original = self.runtime.pipeline
        captured: dict[str, object] = {}

        class NegativePipeline:
            def predict(self, frame):
                captured["columns"] = list(frame.columns)
                return np.full(len(frame), -4.5)

        self.runtime.pipeline = NegativePipeline()
        try:
            response = self.client.post(
                "/v1/predict/demand", json=payload(), headers=self.headers
            )
        finally:
            self.runtime.pipeline = original
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"][0]["predictedDemand7d"], 0.0)
        self.assertEqual(captured["columns"], self.runtime.contract["feature_order"])

    def test_all_60_cloud_demo_products_are_ready(self) -> None:
        scenario = json.loads(
            repository_path("ml/reports/scenario_cloud_demo_manifest.json").read_text(
                encoding="utf-8"
            )
        )
        items = [
            item(str(index), f"M5-{source_item}")
            for index, source_item in enumerate(scenario["selected_products"])
        ]
        response = self.client.post(
            "/v1/predict/demand", json=payload(items), headers=self.headers
        )
        self.assertEqual(response.status_code, 200)
        results = response.json()["results"]
        self.assertEqual(len(results), 60)
        self.assertTrue(all(result["status"] == "READY" for result in results))
        self.assertTrue(
            all(np.isfinite(result["predictedDemand7d"]) for result in results)
        )


class R5DStartupFailureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = (
            repository_path("ml/.test-tmp") / f"r5d-{uuid.uuid4().hex}"
        )
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_hash_mismatch_marks_runtime_unavailable(self) -> None:
        corrupt = self.root / "model.joblib"
        shutil.copyfile(repository_path("ml/models/demand_forecast_v1.joblib"), corrupt)
        with corrupt.open("ab") as stream:
            stream.write(b"corrupt")
        runtime = ModelRuntime(model_path=corrupt)
        with self.assertRaises(ModelUnavailableError):
            runtime.load()
        self.assertFalse(runtime.available)
        with patch.dict(os.environ, {"ML_SERVICE_SECRET": SERVICE_SECRET}, clear=False):
            with TestClient(create_app(runtime)) as client:
                self.assertEqual(client.get("/health").json()["status"], "unavailable")
                self.assertEqual(client.get("/ready").status_code, 503)
                response = client.post(
                    "/v1/predict/demand",
                    json=payload(),
                    headers={"X-ML-Service-Secret": SERVICE_SECRET},
                )
                self.assertEqual(response.status_code, 503)

    def test_missing_or_reused_startup_secret_is_rejected(self) -> None:
        runtime = ModelRuntime()
        environment = dict(os.environ)
        environment.pop("ML_SERVICE_SECRET", None)
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "ML_SERVICE_SECRET"):
                with TestClient(create_app(runtime)):
                    pass
        with patch.dict(
            os.environ,
            {"ML_SERVICE_SECRET": SERVICE_SECRET, "JWT_SECRET": SERVICE_SECRET},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "JWT_SECRET"):
                with TestClient(create_app(ModelRuntime())):
                    pass


if __name__ == "__main__":
    unittest.main()
