"""HTTP and JSON-contract checks for F.4C LIVE Business/Customer serving."""
from __future__ import annotations

import copy
import json
import os
import unittest
from datetime import date
from unittest.mock import patch

from fastapi.testclient import TestClient

from ml.service.app import create_app
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_live_context import LiveV3ContextStore
from ml.service.v3_schemas import BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, SCENARIO_ID, TIMEZONE
from ml.tests.test_m6_9f3_live_context import BASE_RECORDS, empty_snapshot, signed_snapshot
from ml.tests.test_m6_9f4c_live_business_customer import _adapter


SECRET = "test-only-v3-live-http-secret-000000000"


class _V1Runtime:
    available = True

    def load(self):
        return None


def _runtime():
    runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
    runtime.ready = True
    runtime.domains = {name: True for name in (
        "business", "inventory", "forecast", "crossSell", "customer", "supplier", "health")}
    runtime.records = BASE_RECORDS
    runtime.live_contexts = LiveV3ContextStore()
    runtime.live_adapter = _adapter()
    runtime.loading_metrics = {}
    runtime.domain_errors = {}
    runtime.load_error_code = None
    runtime.latencies = {}
    runtime.loading_metrics = {}
    runtime._first_request = True
    runtime.load = lambda: None
    return runtime


def _base_body(*, mode="LIVE", domain_date="2026-10-14", snapshot=True):
    value = {
        "requestId": "m69f4c-http",
        "context": {
            "businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID,
            "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
            "timezone": TIMEZONE, "asOfDate": domain_date,
        },
        "dataMode": mode,
    }
    if snapshot:
        value["operationalSnapshot"] = signed_snapshot().model_dump(mode="json")
    return value


class M69F4CLiveHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.secret_patch = patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET}, clear=False)
        cls.secret_patch.start()
        cls.runtime = _runtime()
        cls.app = create_app(_V1Runtime(), cls.runtime)
        cls.client_context = TestClient(cls.app)
        cls.client = cls.client_context.__enter__()
        cls.headers = {"X-ML-Service-Secret": SECRET}

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.secret_patch.stop()

    def _post(self, route, body):
        return self.client.post(route, headers=self.headers, json=body)

    def test_business_today_and_last7_http_json_and_direct_engine_parity(self):
        for period, expected_revenue in (
            ({"startDate": "2026-10-14", "endDate": "2026-10-14"}, 500),
            ({"startDate": "2026-10-08", "endDate": "2026-10-14"}, 800),
        ):
            body = _base_body()
            body["period"] = period
            from ml.service.v3_schemas import BusinessRequest
            request = BusinessRequest.model_validate(body)
            size = len(json.dumps(body, separators=(",", ":")).encode("utf-8"))
            _, live = self.runtime.ingest_request_context(request, request_body_bytes=size)
            direct, _ = self.runtime.live_business_data(request, live)
            response = self._post("/v3/intelligence/business", body)
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            json.dumps(result, allow_nan=False)
            expected_json = json.loads(json.dumps(direct, ensure_ascii=False, allow_nan=False, default=str))
            self.assertEqual(result["data"], expected_json)
            self.assertEqual(result["data"]["kpis"]["revenueCents"], expected_revenue)
            self.assertEqual(result["metadata"]["source"], "HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT")
            self.assertEqual(result["metadata"]["asOfDate"], "2026-10-14")
            self.assertEqual(result["status"], "PARTIAL")
            self.assertIsNone(result["data"]["kpis"]["cogsCents"])
            self.assertIsNone(result["data"]["kpis"]["grossMarginCents"])

    def test_customer_live_http_json_and_direct_engine_parity(self):
        body = _base_body()
        body["mode"] = "summary"
        from ml.service.v3_schemas import CustomerRequest
        request = CustomerRequest.model_validate(body)
        size = len(json.dumps(body, separators=(",", ":")).encode("utf-8"))
        _, live = self.runtime.ingest_request_context(request, request_body_bytes=size)
        direct, _ = self.runtime.live_customer_data(request, live)
        response = self._post("/v3/intelligence/customers", body)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        json.dumps(result, allow_nan=False)
        expected_json = json.loads(json.dumps(direct, ensure_ascii=False, allow_nan=False, default=str))
        self.assertEqual(result["data"], expected_json)
        by_code = {row["customerCode"]: row for row in result["data"]["items"]}
        self.assertEqual(by_code["C1"]["ticketCount"], 1)
        self.assertEqual(by_code["OP-C-new"]["segment"], "NEW")
        self.assertIsNone(by_code["OP-C-new"]["grossMarginContributionCents"])

    def test_cancellation_and_unknown_cost_are_serialized_without_double_count(self):
        raw = empty_snapshot()
        raw["transactionChanges"] = [{
            "eventKey": "2:cancel:LIVE-SALE-1", "effectiveAtUtc": "2026-10-14T19:00:00.000Z",
            "revision": "2", "entityType": "transaction", "entityKey": "LIVE-SALE-1",
            "transactionKey": "LIVE-SALE-1", "transactionOrigin": "LIVE", "kind": "CANCEL",
            "lineChanges": [],
        }]
        raw["metadata"]["counts"]["transactionChanges"] = 1
        raw["metadata"]["dataVersion"] = "2"
        body = _base_body()
        body["operationalSnapshot"] = signed_snapshot(raw).model_dump(mode="json")
        body["period"] = {"startDate": "2026-10-14", "endDate": "2026-10-14"}
        response = self._post("/v3/intelligence/business", body)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        json.dumps(result, allow_nan=False)
        self.assertEqual(result["data"]["kpis"]["revenueCents"], 0)
        self.assertEqual(result["data"]["kpis"]["ticketCount"], 0)

        unknown_cost = self._post("/v3/intelligence/business", _base_body())
        self.assertEqual(unknown_cost.status_code, 200, unknown_cost.text)
        unknown_data = unknown_cost.json()["data"]
        json.dumps(unknown_data, allow_nan=False)
        self.assertEqual(unknown_data["kpis"]["revenueCents"], 800)
        self.assertIsNone(unknown_data["kpis"]["cogsCents"])
        self.assertEqual(unknown_data["costCoverage"]["reasonCode"], "COST_NOT_AVAILABLE")

    def test_live_errors_other_domains_and_historical_business_customer_are_controlled(self):
        missing = self._post("/v3/intelligence/business", _base_body(snapshot=False))
        self.assertEqual(missing.status_code, 422)
        self.assertEqual(missing.json()["detail"]["code"], "LIVE_SNAPSHOT_REQUIRED")

        wrong_tenant = _base_body()
        wrong_tenant["context"]["businessId"] = "OTHER-BUSINESS"
        tenant_response = self._post("/v3/intelligence/business", wrong_tenant)
        self.assertEqual(tenant_response.status_code, 403)
        self.assertEqual(tenant_response.json()["detail"]["code"], "TENANT_MISMATCH")

        bad_hash = _base_body()
        bad_hash["operationalSnapshot"]["metadata"]["snapshotHash"] = "f" * 64
        hash_response = self._post("/v3/intelligence/business", bad_hash)
        self.assertEqual(hash_response.status_code, 422)
        self.assertEqual(hash_response.json()["detail"]["code"], "SNAPSHOT_HASH_MISMATCH")

        for route, options in (
            ("/v3/intelligence/inventory", {"mode": "summary"}),
            ("/v3/intelligence/suppliers", {"mode": "summary"}),
            ("/v3/intelligence/forecast", {"mode": "summary"}),
            ("/v3/intelligence/health", {}),
        ):
            pending = _base_body()
            pending.update(options)
            not_ready = self._post(route, pending)
            self.assertEqual(not_ready.status_code, 501, not_ready.text)
            self.assertEqual(not_ready.json()["detail"]["code"], "LIVE_ANALYTICS_NOT_READY")

        readiness = self.client.get("/v3/intelligence/health")
        self.assertEqual(readiness.status_code, 200, readiness.text)
        live_domains = readiness.json()["liveDomains"]
        self.assertTrue(live_domains["business"] and live_domains["customer"])
        self.assertFalse(live_domains["inventory"] or live_domains["supplier"]
                         or live_domains["forecast"] or live_domains["health"])
        self.assertEqual(self.client.get("/v3/intelligence/ready").status_code, 200)


class M69F4CHistoricalHttpParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.secret_patch = patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET}, clear=False)
        cls.secret_patch.start()
        cls.runtime = V3IntelligenceRuntime()
        cls.runtime.load()
        cls.client_context = TestClient(create_app(_V1Runtime(), cls.runtime))
        cls.client = cls.client_context.__enter__()
        cls.headers = {"X-ML-Service-Secret": SECRET}

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.secret_patch.stop()

    def test_historical_business_and_customer_http_match_direct_runtime(self):
        from ml.service.v3_schemas import BusinessRequest, CustomerRequest

        business_body = {
            "requestId": "m69f4c-historical-business",
            "context": {"businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID,
                        "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
                        "timezone": TIMEZONE, "asOfDate": "2026-10-12"},
            "dataMode": "HISTORICAL",
            "period": {"startDate": "2026-10-06", "endDate": "2026-10-12"},
        }
        business_request = BusinessRequest.model_validate(business_body)
        expected_business, cutoff = self.runtime.business_data(business_request)
        business_response = self.client.post("/v3/intelligence/business", headers=self.headers,
                                             json=business_body)
        self.assertEqual(business_response.status_code, 200, business_response.text)
        self.assertEqual(business_response.json()["data"], expected_business)
        self.assertEqual(business_response.json()["metadata"]["asOfDate"], cutoff.isoformat())
        self.assertEqual(business_response.json()["metadata"]["source"], "CANONICAL_V3_BUNDLE")

        customer_body = {
            "requestId": "m69f4c-historical-customer",
            "context": business_body["context"], "dataMode": "HISTORICAL",
            "mode": "detail", "customerCode": "CLI-001",
        }
        customer_request = CustomerRequest.model_validate(customer_body)
        expected_customer, customer_cutoff = self.runtime.customer_data(customer_request)
        customer_response = self.client.post("/v3/intelligence/customers", headers=self.headers,
                                             json=customer_body)
        self.assertEqual(customer_response.status_code, 200, customer_response.text)
        self.assertEqual(customer_response.json()["data"], expected_customer)
        self.assertEqual(customer_response.json()["metadata"]["asOfDate"], customer_cutoff.isoformat())
        self.assertEqual(customer_response.json()["metadata"]["source"], "CANONICAL_V3_BUNDLE")


if __name__ == "__main__":
    unittest.main()
