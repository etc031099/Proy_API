"""Health completeness treats unclassified ABC as optional information."""
from __future__ import annotations

import unittest
from collections import Counter
from datetime import date
from types import SimpleNamespace

from ml.service.v3_intelligence_runtime import V3FunctionalError, V3IntelligenceRuntime


def health_fixture(*, classified_abc=False):
    as_of = date(2026, 10, 16)
    business = {"availabilityStatus": "AVAILABLE", "kpis": {}, "trends": {},
                "marginIntelligence": {}, "customerMix": {}, "period": None}
    customer = {"availabilityStatus": "AVAILABLE", "segmentDistribution": {}, "items": []}
    supplier = {"availabilityStatus": "AVAILABLE", "items": [], "summary": {"suppliers": 1}}
    xyz = ["X"] * 55 + ["Y"] * 22 + ["Z"] * 3
    abc = ["A"] * 40 + ["B"] * 24 + ["C"] * 16 if classified_abc else [None] * 80
    inventory = {"products": [{"sku": f"SKU-{index:03}", "risk": {"level": "LOW"},
        "supplier": {"dependencyStatus": "MULTI_SOURCE"},
        "recommendation": {"recommendedQty": 0}, "classification": {"abc": a, "xyz": x}}
        for index, (a, x) in enumerate(zip(abc, xyz))], "summary": {
            "products": 80, "analyzedCount": 80, "unavailableCount": 0,
            "forecastAvailability": "AVAILABLE", "riskUnavailableCount": 0,
            "recommendationUnavailableCount": 0, "abcAvailable": classified_abc,
            "abcUnavailableCount": 0 if classified_abc else 80,
            "xyzAvailable": True, "xyzUnavailableCount": 0,
            "slowMovingUnavailableCount": 0, "deadStockUnavailableCount": 0}}
    forecasts = [{"sku": row["sku"], "horizon7Status": "READY", "horizon14Status": "READY",
                  "expectedUnitsNext7d": 7.0, "expectedUnitsNext14d": 14.0}
                 for row in inventory["products"]]
    runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
    runtime.live_adapter = SimpleNamespace(
        business_data=lambda *_: (business, as_of), customer_data=lambda *_: (customer, as_of))
    runtime._live_inventory_ridge_forecasts = lambda *_: forecasts
    runtime.live_inventory_supplier = SimpleNamespace(
        _inventory_rows=lambda *_: inventory, supplier_data=lambda *_: (supplier, as_of))
    runtime.suppliers = SimpleNamespace(_offers=lambda *_: {},
        _critical_exposure=lambda *_: {"singleSourceCriticalOrHighSkuCount": 0, "exposures": []})
    runtime.health = SimpleNamespace(_insights=lambda *_: [])
    runtime.basket = {"analysisVersion": "fixture", "summary": {}, "rules": [], "categoryRules": []}
    live = SimpleNamespace(as_of_date=as_of,
        freshness=lambda domain: {"mode": "FROZEN" if domain == "marketBasket" else "LIVE"})
    return SimpleNamespace(runtime=runtime, live=live, business=business, customer=customer,
                           supplier=supplier, inventory=inventory, forecasts=forecasts)


def assemble(fixture):
    data, _ = fixture.runtime.live_health_data(SimpleNamespace(period=None, limit=5), fixture.live)
    return data


class HealthCompletenessTests(unittest.TestCase):
    def test_80_unclassified_abc_do_not_block_otherwise_available_health(self):
        fixture = health_fixture()
        data = assemble(fixture)
        self.assertEqual(data["availabilityStatus"], "AVAILABLE")
        self.assertEqual(data["businessHealth"]["forecast"]["status"], "AVAILABLE")
        self.assertEqual(data["businessHealth"]["inventory"]["status"], "AVAILABLE")
        self.assertEqual(fixture.supplier["availabilityStatus"], "AVAILABLE")
        inventory = data["businessHealth"]["inventory"]
        self.assertFalse(inventory["abcAvailable"])
        self.assertEqual(inventory["abcUnavailableCount"], 80)
        self.assertTrue(all(row["classification"]["abc"] is None for row in fixture.inventory["products"]))
        self.assertEqual(data["blockingReasons"], [])
        self.assertEqual(data["healthCompletenessPolicyVersion"], "m6.10a36113-abc-informational-v1")

    def test_classified_abc_remains_available(self):
        fixture = health_fixture(classified_abc=True)
        data = assemble(fixture)
        self.assertEqual(data["availabilityStatus"], "AVAILABLE")
        self.assertTrue(data["businessHealth"]["inventory"]["abcAvailable"])
        self.assertEqual(data["businessHealth"]["inventory"]["abcUnavailableCount"], 0)
        self.assertEqual(Counter(row["classification"]["abc"] for row in fixture.inventory["products"]),
                         {"A": 40, "B": 24, "C": 16})

    def test_missing_forecast_horizon_stays_partial(self):
        for horizon in (7, 14):
            with self.subTest(horizon=horizon):
                fixture = health_fixture()
                fixture.forecasts[0][f"horizon{horizon}Status"] = "MODEL_UNAVAILABLE"
                fixture.forecasts[0][f"expectedUnitsNext{horizon}d"] = None
                data = assemble(fixture)
                self.assertEqual(data["availabilityStatus"], "PARTIAL")
                self.assertIn(f"FORECAST_{horizon}D_INCOMPLETE", data["blockingReasons"])
        fixture = health_fixture()
        fixture.inventory["summary"]["forecastAvailability"] = "PARTIAL"
        data = assemble(fixture)
        self.assertEqual(data["availabilityStatus"], "PARTIAL")
        self.assertIn("INVENTORY_FORECAST_AVAILABILITY_PARTIAL", data["blockingReasons"])

    def test_missing_required_inventory_evidence_stays_partial(self):
        for key in ("unavailableCount", "riskUnavailableCount", "recommendationUnavailableCount",
                    "slowMovingUnavailableCount", "deadStockUnavailableCount"):
            with self.subTest(key=key):
                fixture = health_fixture()
                fixture.inventory["summary"][key] = 1
                data = assemble(fixture)
                self.assertEqual(data["availabilityStatus"], "PARTIAL")
                reason = {
                    "unavailableCount": "INVENTORY_UNAVAILABLE_COUNT",
                    "riskUnavailableCount": "INVENTORY_RISK_UNAVAILABLE",
                    "recommendationUnavailableCount": "INVENTORY_RECOMMENDATION_UNAVAILABLE",
                    "slowMovingUnavailableCount": "INVENTORY_SLOW_MOVING_UNAVAILABLE",
                    "deadStockUnavailableCount": "INVENTORY_DEAD_STOCK_UNAVAILABLE",
                }[key]
                self.assertIn(reason, data["blockingReasons"])

    def test_partial_suppliers_stay_blocking(self):
        fixture = health_fixture()
        fixture.supplier["availabilityStatus"] = "PARTIAL"
        data = assemble(fixture)
        self.assertEqual(data["availabilityStatus"], "PARTIAL")
        self.assertIn("SUPPLIER_ANALYTICS_PARTIAL", data["blockingReasons"])

    def test_xyz_distribution_and_completeness_policy_are_unchanged(self):
        fixture = health_fixture()
        data = assemble(fixture)
        self.assertEqual(Counter(row["classification"]["xyz"] for row in fixture.inventory["products"]),
                         {"X": 55, "Y": 22, "Z": 3})
        self.assertTrue(data["businessHealth"]["inventory"]["xyzAvailable"])
        self.assertEqual(data["businessHealth"]["inventory"]["xyzUnavailableCount"], 0)
        fixture.inventory["summary"]["xyzUnavailableCount"] = 1
        data = assemble(fixture)
        self.assertEqual(data["availabilityStatus"], "PARTIAL")
        self.assertIn("INVENTORY_XYZ_UNAVAILABLE", data["blockingReasons"])

    def test_other_existing_required_domains_remain_blocking(self):
        for domain in ("business", "customer", "marketBasket"):
            with self.subTest(domain=domain):
                fixture = health_fixture()
                if domain == "marketBasket":
                    fixture.runtime.basket = None
                else:
                    getattr(fixture, domain)["availabilityStatus"] = "PARTIAL"
                data = assemble(fixture)
                self.assertEqual(data["availabilityStatus"], "PARTIAL")
                expected = {"business": "BUSINESS_ANALYTICS_PARTIAL", "customer": "CUSTOMER_ANALYTICS_PARTIAL",
                            "marketBasket": "MARKET_BASKET_UNAVAILABLE"}[domain]
                self.assertIn(expected, data["blockingReasons"])

    def test_technical_evaluation_error_is_not_treated_as_unclassified_abc(self):
        fixture = health_fixture()

        def failed_inventory(*_):
            raise TypeError("offline technical failure")

        fixture.runtime.live_inventory_supplier._inventory_rows = failed_inventory
        with self.assertRaises(V3FunctionalError) as raised:
            assemble(fixture)
        self.assertEqual(raised.exception.code, "DATA_NOT_AVAILABLE")

    def test_customer_aggregate_diagnostics_are_forwarded_without_customer_rows(self):
        fixture = health_fixture()
        fixture.customer["availabilityStatus"] = "PARTIAL"
        fixture.customer["availabilityDiagnostics"] = [{
            "code": "CUSTOMER_PERIOD_COST_COVERAGE_INCOMPLETE",
            "affectedCustomerCount": 3,
            "unknownSaleLineCount": 7,
        }]
        data = assemble(fixture)
        self.assertEqual(data["availabilityStatus"], "PARTIAL")
        self.assertEqual(data["customerDiagnostics"], fixture.customer["availabilityDiagnostics"])
        self.assertIn("CUSTOMER_ANALYTICS_PARTIAL", data["blockingReasons"])


if __name__ == "__main__":
    unittest.main()
