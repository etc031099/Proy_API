from __future__ import annotations

import os
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from ml.service.app import create_app
from ml.service.model_runtime import ModelRuntime
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_schemas import BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, REFERENCE_DATE, SCENARIO_ID, TIMEZONE


SECRET = "test-only-v3-service-secret-000000000000"
CONTEXT = {"businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID, "datasetVersion": DATASET_VERSION,
           "datasetSha256": DATASET_SHA256, "timezone": TIMEZONE}


def body(**kwargs):
    return {"requestId": "m69b-test", "context": dict(CONTEXT), **kwargs}


class M69BV3ServingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.environment = patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET}, clear=False)
        cls.environment.start()
        cls.v3 = V3IntelligenceRuntime()
        cls.v3.load()
        cls.client_context = TestClient(create_app(ModelRuntime(), cls.v3))
        cls.client = cls.client_context.__enter__()
        cls.headers = {"X-ML-Service-Secret": SECRET}

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.environment.stop()

    def post(self, route, data):
        return self.client.post(route, headers=self.headers, json=body(**data))

    def test_readiness_and_v1_health_contract_are_independent(self):
        old_health = self.client.get("/health")
        old_ready = self.client.get("/ready")
        v3_health = self.client.get("/v3/intelligence/health").json()
        self.assertEqual(old_health.status_code, 200)
        self.assertEqual(old_ready.status_code, 200)
        self.assertTrue(v3_health["serviceAlive"])
        self.assertTrue(v3_health["v1Ready"])
        self.assertTrue(v3_health["v3IntelligenceReady"])
        self.assertTrue(all(v3_health["domains"].values()))
        self.assertEqual(self.client.get("/v3/intelligence/ready").status_code, 200)

    def test_business_last_7_days_matches_approved_engine(self):
        response = self.post("/v3/intelligence/business", {"period": {"startDate": "2026-10-06", "endDate": "2026-10-12"}})
        self.assertEqual(response.status_code, 200, response.text)
        expected = self.v3.business.summary({"startDate": "2026-10-06", "endDate": "2026-10-12"}, as_of_date=REFERENCE_DATE)
        self.assertEqual(response.json()["data"]["kpis"], expected["kpis"])
        self.assertEqual(response.json()["metadata"]["source"], "CANONICAL_V3_BUNDLE")
        self.assertNotIn("rankings", response.json()["data"])
        self.assertNotIn("categoryIntelligence", response.json()["data"])

    def test_business_product_filter_matches_approved_engine(self):
        response = self.post("/v3/intelligence/business", {
            "period": {"startDate": "2026-10-06", "endDate": "2026-10-12"},
            "productSku": "PAN-FRE-001",
        })
        self.assertEqual(response.status_code, 200, response.text)
        expected = self.v3.business.summary({"startDate": "2026-10-06", "endDate": "2026-10-12"},
                                            as_of_date=REFERENCE_DATE, product_sku="PAN-FRE-001")
        self.assertEqual(response.json()["data"]["kpis"], expected["kpis"])
        self.assertEqual(response.json()["data"]["filters"]["productSku"], "PAN-FRE-001")

    def test_inventory_single_sku_matches_approved_engine(self):
        sku = "PAN-FRE-001"
        response = self.post("/v3/intelligence/inventory", {"mode": "detail", "skus": [sku]})
        self.assertEqual(response.status_code, 200, response.text)
        expected = self.v3.inventory.snapshot(REFERENCE_DATE)
        row = next(item for item in expected["products"] if item["sku"] == sku)
        served = response.json()["data"]["items"][0]
        self.assertEqual(served, self.v3._public_inventory_row(row))
        self.assertNotIn("purchaseCode", str(served))

    def test_inventory_ranking_applies_limit(self):
        response = self.post("/v3/intelligence/inventory", {"mode": "rank", "metric": "reorder", "limit": 3})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["data"]["items"]), 3)
        expected_total = len(self.v3.inventory.snapshot(REFERENCE_DATE)["rankings"]["reorder"])
        self.assertEqual(response.json()["data"]["total"], expected_total)

    def test_forecast_single_approved_horizon_matches_engine(self):
        sku = "BEB-GAS-003"
        response = self.post("/v3/intelligence/forecast", {"mode": "detail", "skus": [sku], "horizonDays": 7})
        self.assertEqual(response.status_code, 200, response.text)
        from ml.src import v3_baseline_bundle
        engine = v3_baseline_bundle.predict(self.v3.dataset, sku=sku, cutoff=REFERENCE_DATE)
        self.assertEqual(response.json()["data"]["items"][0], engine)
        self.assertEqual(response.json()["metadata"]["engineVersion"], v3_baseline_bundle.STRATEGY_VERSION)

    def test_unapproved_28_day_forecast_is_controlled(self):
        response = self.post("/v3/intelligence/forecast", {"skus": ["BEB-GAS-003"], "horizonDays": 28})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "UNSUPPORTED_HORIZON")

    def test_cross_sell_reads_approved_artifact_without_remining(self):
        response = self.post("/v3/intelligence/cross-sell", {"sku": "PAN-FRE-001", "limit": 5})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"]["items"], self.v3.basket["recommendationsBySku"].get("PAN-FRE-001", [])[:5])
        self.assertIn("not causality", response.json()["data"]["interpretation"])

    def test_missing_basket_artifact_is_partial_without_disabling_other_domains(self):
        original_artifact = self.v3.basket
        original_flag = self.v3.domains["crossSell"]
        self.v3.basket = None
        self.v3.domains["crossSell"] = False
        try:
            response = self.post("/v3/intelligence/cross-sell", {"sku": "PAN-FRE-001"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], "PARTIAL")
            self.assertEqual(response.json()["data"]["reasonCode"], "ARTIFACT_UNAVAILABLE")
            self.assertTrue(self.v3.domains["business"])
        finally:
            self.v3.basket = original_artifact
            self.v3.domains["crossSell"] = original_flag

    def test_missing_basket_on_startup_keeps_other_domains_ready(self):
        runtime = V3IntelligenceRuntime()
        def without_basket(path):
            if path.name == "minimarket-pasco-v3-market-basket-v1.json":
                raise FileNotFoundError
            import json
            return json.loads(path.read_text(encoding="utf-8"))
        with patch("ml.service.v3_intelligence_runtime._read_json", side_effect=without_basket):
            runtime.load()
        self.assertTrue(runtime.ready)
        self.assertTrue(runtime.domains["business"])
        self.assertFalse(runtime.domains["crossSell"])
        self.assertEqual(runtime.domain_errors["crossSell"], "ARTIFACT_UNAVAILABLE")

    def test_missing_forecast_manifest_keeps_nonforecast_domains_ready(self):
        runtime = V3IntelligenceRuntime()
        with patch("ml.service.v3_intelligence_runtime.v3_baseline_bundle.load_manifest",
                   side_effect=FileNotFoundError):
            runtime.load()
        self.assertTrue(runtime.ready)
        self.assertTrue(runtime.domains["business"])
        self.assertTrue(runtime.domains["customer"])
        self.assertTrue(runtime.domains["supplier"])
        self.assertFalse(runtime.domains["forecast"])
        self.assertFalse(runtime.domains["inventory"])
        self.assertFalse(runtime.domains["health"])

    def test_customer_single_code_is_projected_without_contacts(self):
        response = self.post("/v3/intelligence/customers", {"mode": "detail", "customerCode": "CLI-001"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()["data"]["items"][0]
        self.assertEqual(data["customerCode"], "CLI-001")
        self.assertNotIn("email", data)
        self.assertNotIn("phone", data)
        self.assertNotIn("syntheticProfileAudit", data)

    def test_supplier_single_code_is_projected(self):
        response = self.post("/v3/intelligence/suppliers", {"mode": "detail", "supplierCode": "SUP-05"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()["data"]["items"][0]
        self.assertEqual(data["supplierCode"], "SUP-05")
        self.assertNotIn("legalNameDemo", data)

    def test_business_health_composes_approved_domains_without_score(self):
        response = self.post("/v3/intelligence/health", {})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()["data"]
        self.assertIsNone(data["healthScore"])
        self.assertIn("sales", data["businessHealth"])
        self.assertIn("inventory", data["businessHealth"])
        self.assertIn("marketBasket", data["businessHealth"])
        self.assertLessEqual(len(data["alerts"]), 5)
        self.assertLessEqual(len(data["businessHealth"]["marketBasket"].get("topExamples", [])), 5)
        self.assertLessEqual(len(data["businessHealth"]["marketBasket"].get("categoryAssociations", [])), 5)

    def test_business_health_observation_limit_is_capped_at_five(self):
        response = self.post("/v3/intelligence/health", {"limit": 6})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "INVALID_REQUEST")

    def test_internal_auth_is_required_and_compared(self):
        payload = body(period={"startDate": "2026-10-06", "endDate": "2026-10-12"})
        self.assertEqual(self.client.post("/v3/intelligence/business", json=payload).status_code, 401)
        self.assertEqual(self.client.post("/v3/intelligence/business", headers={"X-ML-Service-Secret": "wrong"}, json=payload).status_code, 403)

    def test_scenario_tenant_and_arbitrary_business_are_denied(self):
        wrong_business = body(period=None)
        wrong_business["context"]["businessId"] = "OTHER-BUSINESS"
        response = self.client.post("/v3/intelligence/business", headers=self.headers, json=wrong_business)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["code"], "TENANT_MISMATCH")
        wrong_scenario = body()
        wrong_scenario["context"]["scenarioId"] = "unknown-scenario"
        response = self.client.post("/v3/intelligence/business", headers=self.headers, json=wrong_scenario)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "SCENARIO_NOT_SUPPORTED")
        arbitrary = body()
        arbitrary["businessId"] = BUSINESS_ID
        self.assertEqual(self.client.post("/v3/intelligence/business", headers=self.headers, json=arbitrary).status_code, 400)
        wrong_version = body()
        wrong_version["context"]["datasetVersion"] = "unapproved"
        response = self.client.post("/v3/intelligence/business", headers=self.headers, json=wrong_version)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "SCENARIO_NOT_SUPPORTED")
        wrong_timezone = body()
        wrong_timezone["context"]["timezone"] = "UTC"
        response = self.client.post("/v3/intelligence/business", headers=self.headers, json=wrong_timezone)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "SCENARIO_NOT_SUPPORTED")

    def test_period_cutoff_and_entity_errors_are_controlled(self):
        future = self.post("/v3/intelligence/business", {"period": {"startDate": "2026-10-12", "endDate": "2026-10-13"}})
        self.assertEqual(future.status_code, 422)
        self.assertEqual(future.json()["detail"]["code"], "INVALID_PERIOD")
        missing = self.post("/v3/intelligence/inventory", {"mode": "detail", "skus": ["NOT-A-SKU"]})
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["detail"]["code"], "PRODUCT_NOT_FOUND")
        foreign_scenario_sku = self.post("/v3/intelligence/inventory", {"mode": "detail", "skus": ["M5-FOODS_3_511"]})
        self.assertEqual(foreign_scenario_sku.status_code, 404)
        self.assertEqual(foreign_scenario_sku.json()["detail"]["code"], "PRODUCT_NOT_FOUND")
        bad_customer = self.post("/v3/intelligence/customers", {"mode": "detail", "customerCode": "CLI-999"})
        self.assertEqual(bad_customer.status_code, 404)
        self.assertEqual(bad_customer.json()["detail"]["code"], "CUSTOMER_NOT_FOUND")
        bad_supplier = self.post("/v3/intelligence/suppliers", {"mode": "detail", "supplierCode": "SUP-99"})
        self.assertEqual(bad_supplier.status_code, 404)
        self.assertEqual(bad_supplier.json()["detail"]["code"], "SUPPLIER_NOT_FOUND")

    def test_early_forecast_cutoff_reports_insufficient_history(self):
        early = body(skus=["BEB-GAS-003"], horizonDays=7)
        early["context"]["asOfDate"] = "2025-10-20"
        response = self.client.post("/v3/intelligence/forecast", headers=self.headers, json=early)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "INSUFFICIENT_HISTORY")

    def test_pagination_limit_is_bounded(self):
        response = self.post("/v3/intelligence/inventory", {"mode": "rank", "limit": 21})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "INVALID_REQUEST")

    def test_loading_failure_does_not_mark_v3_ready(self):
        missing = V3IntelligenceRuntime(Path("ml/.test-tmp/missing-v3-package"))
        with self.assertRaises(Exception):
            missing.load()
        self.assertFalse(missing.ready)
        self.assertEqual(missing.load_error_code, "ARTIFACT_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
