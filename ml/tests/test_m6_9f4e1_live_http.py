"""Focused HTTP validation for the F.4E LIVE forecast and health routes."""
from __future__ import annotations

import json
import os
import unittest
from copy import deepcopy
from datetime import date
from unittest.mock import patch

from fastapi.testclient import TestClient

from ml.service.app import create_app
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_schemas import (
    BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, REFERENCE_DATE, SCENARIO_ID, TIMEZONE,
    ForecastRequest, HealthRequest, InventoryRequest,
)
from ml.tests.test_m6_9f3_live_context import empty_snapshot, signed_snapshot


SECRET = "test-only-m69f4e1-http-secret-000000000"
AS_OF = date(2026, 10, 14)
CLOSED_THROUGH = date(2026, 10, 13)


def _live_body(runtime: V3IntelligenceRuntime, **domain_fields):
    products = runtime.records["products"]
    raw = empty_snapshot()
    raw["catalogChanges"] = []
    raw["sales"] = []
    raw["purchases"] = []
    raw["transactionChanges"] = []
    raw["stockStates"] = [
        {"productKey": row["productKey"], "sku": row["sku"],
         "onHand": row["endingStock"], "stockBasis": "MONGO_LEDGER"}
        for row in products
    ]
    raw["closedSalesDays"] = [
        {"productKey": row["productKey"], "localDate": CLOSED_THROUGH.isoformat(),
         "unitsSold": 0, "completeness": "COMPLETE", "availability": "UNKNOWN",
         "availableHours": None, "onHandUsableAtOrigin": None}
        for row in products
    ]
    metadata = raw["metadata"]
    metadata["counts"] = {"catalogChanges": 0, "sales": 0, "purchases": 0,
                          "transactionChanges": 0, "stockStates": len(products),
                          "closedSalesDays": len(products)}
    metadata["costCoverage"] = {"knownSaleLines": 0, "unknownSaleLines": 0}
    snapshot = signed_snapshot(raw).model_dump(mode="json")
    return {
        "requestId": "m69f4e1-http",
        "context": {"businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID,
                    "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
                    "timezone": TIMEZONE, "asOfDate": AS_OF.isoformat()},
        "dataMode": "LIVE", "operationalSnapshot": snapshot, **domain_fields,
    }


class _V1Runtime:
    available = True

    def load(self):
        return None

    def public_health(self):
        return {"status": "ok"}


class M69F4E1LiveHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.secret_patch = patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET}, clear=False)
        cls.secret_patch.start()
        cls.runtime = V3IntelligenceRuntime()
        cls.runtime.load()
        cls.app = create_app(_V1Runtime(), cls.runtime)
        cls.client_context = TestClient(cls.app)
        cls.client = cls.client_context.__enter__()
        cls.headers = {"X-ML-Service-Secret": SECRET}

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.secret_patch.stop()

    def _direct_context(self, route, body):
        request_type = {"forecast": ForecastRequest, "inventory": InventoryRequest,
                        "health": HealthRequest}[route]
        request = request_type.model_validate(body)
        size = len(json.dumps(body, separators=(",", ":")).encode("utf-8"))
        _, live = self.runtime.ingest_request_context(request, request_body_bytes=size)
        method = {"forecast": "live_forecast_data", "inventory": "live_inventory_data",
                  "health": "live_health_data"}[route]
        result, _ = getattr(self.runtime, method)(request, live)
        return result

    def setUp(self):
        self.runtime.live_contexts._contexts.clear()
        self.runtime.live_contexts._hash_by_boundary.clear()

    def test_forecast_live_http_horizons_match_direct_and_reject_28d(self):
        for horizon in (1, 7, 14):
            body = _live_body(self.runtime, mode="detail", skus=["PAN-FRE-001"], horizonDays=horizon)
            direct = self._direct_context("forecast", body)
            response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=body)
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            json.dumps(result, allow_nan=False)
            self.assertEqual(result["data"], json.loads(json.dumps(direct, allow_nan=False, default=str)))
            row = result["data"]["items"][0]
            self.assertEqual(row["status"], "READY")
            self.assertEqual(row["forecastSource"], "MOVING_AVERAGE_28")
            self.assertIsNotNone(row[f"expectedUnitsNext{horizon}d"])

        unsupported = _live_body(self.runtime, mode="detail", skus=["PAN-FRE-001"], horizonDays=28)
        response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=unsupported)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "UNSUPPORTED_HORIZON")

    def test_inventory_live_http_and_health_freshness_match_direct(self):
        inventory_body = _live_body(self.runtime, mode="detail", skus=["PAN-FRE-001"])
        direct_inventory = self._direct_context("inventory", inventory_body)
        response = self.client.post("/v3/intelligence/inventory", headers=self.headers, json=inventory_body)
        self.assertEqual(response.status_code, 200, response.text)
        inventory = response.json()
        json.dumps(inventory, allow_nan=False)
        self.assertEqual(inventory["data"], json.loads(json.dumps(direct_inventory, allow_nan=False, default=str)))
        row = inventory["data"]["items"][0]
        self.assertEqual(row["sku"], "PAN-FRE-001")
        self.assertIn("stock", row)
        self.assertIsNotNone(row["demand"]["expectedDaily"])
        self.assertIsNotNone(row["forecast"]["expected1d"])
        self.assertIsNotNone(row["coverage"]["daysCover"])
        self.assertIsNotNone(row["inventoryPolicy"]["safetyStock"])
        self.assertIsNotNone(row["inventoryPolicy"]["reorderPoint"])
        self.assertIsNotNone(row["recommendation"]["recommendedQty"])
        self.assertIn("level", row["risk"])
        self.assertIn("overstock", row["classification"])

        health_body = _live_body(self.runtime)
        direct_health = self._direct_context("health", health_body)
        response = self.client.post("/v3/intelligence/health", headers=self.headers, json=health_body)
        self.assertEqual(response.status_code, 200, response.text)
        health = response.json()
        json.dumps(health, allow_nan=False)
        self.assertEqual(health["data"], json.loads(json.dumps(direct_health, allow_nan=False, default=str)))
        freshness = health["data"]["freshness"]
        for domain in ("business", "customer", "inventory", "supplier", "forecast"):
            self.assertEqual(freshness[domain]["mode"], "LIVE")
        self.assertEqual(freshness["marketBasket"]["mode"], "HISTORICAL")
        self.assertEqual(freshness["marketBasket"]["analysisCutoff"], REFERENCE_DATE.isoformat())
        self.assertTrue(health["data"]["businessHealth"]["marketBasket"]["available"])
        self.assertIsNone(health["data"]["healthScore"])

    def test_live_readiness_and_snapshot_errors_are_serialized_over_http(self):
        readiness = self.client.get("/v3/intelligence/health")
        self.assertEqual(readiness.status_code, 200, readiness.text)
        body = readiness.json()
        self.assertTrue(body["serviceAlive"] and body["v1Ready"] and body["v3IntelligenceReady"])
        self.assertTrue(all(body["liveDomains"][name] for name in
                            ("business", "customer", "inventory", "supplier", "forecast", "health")))
        self.assertTrue(body["domains"]["crossSell"])
        self.assertEqual(self.client.get("/v3/intelligence/ready").status_code, 200)
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self.client.get("/ready").status_code, 200)

        missing = _live_body(self.runtime, mode="detail", skus=["PAN-FRE-001"])
        missing["operationalSnapshot"] = None
        response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=missing)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "LIVE_SNAPSHOT_REQUIRED")

        bad_tenant = _live_body(self.runtime, mode="detail", skus=["PAN-FRE-001"], horizonDays=7)
        bad_tenant["context"]["businessId"] = "OTHER-BUSINESS"
        response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=bad_tenant)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["code"], "TENANT_MISMATCH")

        bad_hash = _live_body(self.runtime, mode="detail", skus=["PAN-FRE-001"], horizonDays=7)
        bad_hash["operationalSnapshot"]["metadata"]["snapshotHash"] = "f" * 64
        response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=bad_hash)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "SNAPSHOT_HASH_MISMATCH")

    def test_partial_day_is_excluded_and_missing_close_is_not_zero_over_http(self):
        baseline = _live_body(self.runtime, mode="detail", skus=["PAN-FRE-001"], horizonDays=7)
        baseline_response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=baseline)
        self.assertEqual(baseline_response.status_code, 200, baseline_response.text)
        baseline_row = baseline_response.json()["data"]["items"][0]
        self.assertEqual(baseline_row["observationsThrough"], CLOSED_THROUGH.isoformat())

        partial = deepcopy(baseline)
        partial["requestId"] = "m69f4e1-partial-day"
        pan_product_key = next(row["productKey"] for row in self.runtime.records["products"]
                               if row["sku"] == "PAN-FRE-001")
        partial["operationalSnapshot"]["sales"] = [{
            "saleKey": "SYNTHETIC-PARTIAL-SALE", "occurredAtUtc": "2026-10-14T18:00:00Z",
            "localDate": "2026-10-14", "customerKey": None, "currency": "PEN",
            "totalCents": 99900, "initialStatus": "completed", "lines": [{
                "lineKey": "SYNTHETIC-PARTIAL-SALE:0", "productKey": pan_product_key,
                "sku": "PAN-FRE-001", "quantity": 999, "unitPriceCents": 100,
                "lineTotalCents": 99900, "unitCostAtSaleCents": None,
                "costBasis": "UNKNOWN", "costKnown": False, "promo": False,
            }],
        }]
        partial["operationalSnapshot"]["metadata"]["counts"]["sales"] = 1
        partial["operationalSnapshot"]["metadata"]["costCoverage"]["unknownSaleLines"] = 1
        partial["operationalSnapshot"]["metadata"]["dataVersion"] = "2"
        partial["operationalSnapshot"] = signed_snapshot(partial["operationalSnapshot"]).model_dump(mode="json")
        partial_response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=partial)
        self.assertEqual(partial_response.status_code, 200, partial_response.text)
        partial_row = partial_response.json()["data"]["items"][0]
        for field in ("expectedUnitsNext1d", "expectedUnitsNext7d", "expectedUnitsNext14d"):
            self.assertEqual(partial_row[field], baseline_row[field])

        missing_close = deepcopy(baseline)
        missing_close["requestId"] = "m69f4e1-missing-close"
        missing_close["operationalSnapshot"]["metadata"]["dataVersion"] = "3"
        missing_close["operationalSnapshot"]["closedSalesDays"] = []
        missing_close["operationalSnapshot"] = signed_snapshot(missing_close["operationalSnapshot"]).model_dump(mode="json")
        missing_response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=missing_close)
        self.assertEqual(missing_response.status_code, 422, missing_response.text)
        self.assertEqual(missing_response.json()["detail"]["code"], "LIVE_SNAPSHOT_INVALID")

    def test_post_cutoff_sku_is_cold_start_over_http(self):
        body = _live_body(self.runtime, mode="rank", skus=["PAN-FRE-001"], horizonDays=7)
        raw = body["operationalSnapshot"]
        product_create = next(change for change in empty_snapshot()["catalogChanges"]
                              if change["entityType"] == "product")
        raw["catalogChanges"] = [product_create]
        raw["stockStates"].append({"productKey": "OP-P-new", "sku": "P2", "onHand": 3,
                                   "stockBasis": "MONGO_LEDGER"})
        raw["closedSalesDays"].append({"productKey": "OP-P-new", "localDate": CLOSED_THROUGH.isoformat(),
            "unitsSold": 0, "completeness": "COMPLETE", "availability": "UNKNOWN",
            "availableHours": None, "onHandUsableAtOrigin": None})
        raw["metadata"]["counts"]["catalogChanges"] = 1
        raw["metadata"]["counts"]["stockStates"] += 1
        raw["metadata"]["counts"]["closedSalesDays"] += 1
        raw["metadata"]["dataVersion"] = "2"
        body["requestId"] = "m69f4e1-cold-start"
        body["skus"] = ["P2"]
        body["operationalSnapshot"] = signed_snapshot(raw).model_dump(mode="json")
        response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        row = response.json()["data"]["items"][0]
        self.assertEqual(row["status"], "COLD_START")
        self.assertIsNone(row["expectedUnitsNext7d"])

    def test_historical_forecast_inventory_and_health_http_match_direct_runtime(self):
        context = {"businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID,
                   "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
                   "timezone": TIMEZONE, "asOfDate": REFERENCE_DATE.isoformat()}
        cases = (
            ("forecast", "/v3/intelligence/forecast",
             {"mode": "detail", "skus": ["PAN-FRE-001"], "horizonDays": 7}),
            ("inventory", "/v3/intelligence/inventory",
             {"mode": "detail", "skus": ["PAN-FRE-001"]}),
            ("health", "/v3/intelligence/health", {}),
        )
        request_types = {"forecast": ForecastRequest, "inventory": InventoryRequest,
                         "health": HealthRequest}
        direct_methods = {"forecast": "forecast_data", "inventory": "inventory_data",
                          "health": "health_data"}
        for domain, route, fields in cases:
            body = {"requestId": f"m69f4e1-historical-{domain}", "context": context,
                    "dataMode": "HISTORICAL", **fields}
            request = request_types[domain].model_validate(body)
            direct, _ = getattr(self.runtime, direct_methods[domain])(request)
            response = self.client.post(route, headers=self.headers, json=body)
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            json.dumps(result, allow_nan=False)
            self.assertEqual(result["data"], json.loads(json.dumps(direct, ensure_ascii=False,
                                                                  allow_nan=False, default=str)))
            self.assertEqual(result["metadata"]["source"], "CANONICAL_V3_BUNDLE")


if __name__ == "__main__":
    unittest.main()
