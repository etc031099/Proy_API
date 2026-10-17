"""Customer general readiness and cost-dependent margin availability."""
from copy import deepcopy
from datetime import date
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from ml.tests.test_m6_9f4c_live_business_customer import _adapter, _live_context, _request
from ml.tests.test_m6_10a36113_health_completeness import health_fixture


def health_with_customer(adapter, live, period):
    fixture = health_fixture()
    fixture.runtime.live_adapter.customer_data = adapter.customer_data
    return fixture.runtime.live_health_data(SimpleNamespace(period=period, limit=5), live)[0]


class CustomerMarginAvailabilityTests(TestCase):
    def test_six_customers_27_historical_cost_gaps_do_not_block_health(self):
        adapter, live = _adapter(), _live_context(sale=False)
        sale_template = adapter.historical_business.sales[0]
        line_template = adapter.historical_business.lines["HIST-1"][0]
        adapter.static["customers"] = []
        adapter.historical_business.sales = []
        adapter.historical_business.lines = {}
        for index, count in enumerate((5, 5, 5, 4, 4, 4), 1):
            code, sale_code = f"C{index}", f"HIST-{index}"
            adapter.static["customers"].append({"customerCode": code, "displayName": "Fixture",
                                                "customerProfileKey": "RECENT"})
            adapter.historical_business.sales.append({**sale_template, "saleCode": sale_code,
                "customerCode": code, "totalCents": count * 300})
            adapter.historical_business.lines[sale_code] = [{**line_template, "saleCode": sale_code,
                "saleLineKey": f"{sale_code}:L{line}", "costKnown": False, "costAtSaleCents": 0}
                for line in range(count)]
        period = SimpleNamespace(startDate=date(2026, 10, 14), endDate=date(2026, 10, 14))
        data, _ = adapter.customer_data(_request(period=period, limit=100), live)
        self.assertEqual(data["availabilityStatus"], "AVAILABLE")
        self.assertEqual(data["marginAvailabilityStatus"], "PARTIAL")
        self.assertEqual(data["costCoverage"]["historical"]["status"], "PARTIAL")
        self.assertEqual(data["costCoverage"]["period"]["status"], "AVAILABLE")
        self.assertEqual(data["availabilityDiagnostics"], [{
            "code": "CUSTOMER_HISTORICAL_COST_COVERAGE_INCOMPLETE",
            "affectedCustomerCount": 6, "unknownSaleLineCount": 27}])
        self.assertTrue(all(row["grossMarginContributionCents"] is None for row in data["items"]))
        health = health_with_customer(adapter, live, period)
        self.assertEqual(health["availabilityStatus"], "AVAILABLE")
        self.assertEqual(health["blockingReasons"], [])
        self.assertEqual(health["customerDiagnostics"], data["availabilityDiagnostics"])
        self.assertEqual(health["businessHealth"]["customers"]["marginAvailabilityStatus"], "PARTIAL")

    def test_period_cost_gap_masks_only_cost_metrics_and_preserves_rfm(self):
        live = _live_context(sale=True)
        data, _ = _adapter().customer_data(_request(), live)
        known_live = deepcopy(live)
        known_live.snapshot.sales[0].lines[0].costKnown = True
        known_live.snapshot.sales[0].lines[0].unitCostAtSaleCents = 100
        known, _ = _adapter().customer_data(_request(), known_live)
        self.assertEqual(data["availabilityStatus"], "AVAILABLE")
        self.assertEqual(data["costCoverage"]["period"]["status"], "PARTIAL")
        self.assertEqual(data["marginAvailabilityStatus"], "PARTIAL")
        for key in ("totalSpentCents", "ticketCount", "recencyDays", "units", "rfm90d", "segment", "preferences"):
            self.assertEqual(data["items"][0][key], known["items"][0][key], key)
        self.assertIsNone(data["items"][0]["grossMarginContributionCents"])
        self.assertIsNone(data["periodMetrics"]["C1"]["grossMarginCents"])
        self.assertIsNone(data["periodMetrics"]["C1"]["cogsCents"])
        self.assertIsNotNone(known["periodMetrics"]["C1"]["grossMarginCents"])
        self.assertIsNone(live.snapshot.sales[0].lines[0].unitCostAtSaleCents)

    def test_missing_general_recency_still_blocks_customer_and_health(self):
        adapter, live = _adapter(), _live_context(sale=False)
        view = adapter._view(live, live.as_of_date)
        _, engine, _ = view
        snapshot = engine.snapshot(as_of_date=live.as_of_date, allow_live=True)
        snapshot["customers"][0]["recencyDays"] = None
        with patch.object(adapter, "_view", return_value=view), patch.object(engine, "snapshot", return_value=snapshot):
            data, _ = adapter.customer_data(_request(), live)
            self.assertEqual(data["availabilityStatus"], "PARTIAL")
            self.assertEqual(data["marginAvailabilityStatus"], "AVAILABLE")
            self.assertIn("CUSTOMER_GENERAL_METRICS_INCOMPLETE", [d["code"] for d in data["availabilityDiagnostics"]])
            health = health_with_customer(adapter, live, _request().period)
            self.assertEqual(health["availabilityStatus"], "PARTIAL")
            self.assertIn("CUSTOMER_ANALYTICS_PARTIAL", health["blockingReasons"])

    def test_complete_cost_coverage_keeps_general_and_margin_available(self):
        data, _ = _adapter().customer_data(_request(), _live_context(sale=False))
        self.assertEqual(data["availabilityStatus"], "AVAILABLE")
        self.assertEqual(data["marginAvailabilityStatus"], "AVAILABLE")
        self.assertEqual(data["costCoverage"]["historical"]["status"], "AVAILABLE")
        self.assertEqual(data["availabilityDiagnostics"], [])
        self.assertEqual(data["items"][0]["grossMarginContributionCents"], 200)

    def test_explicit_margin_ranking_stays_unavailable_without_costs(self):
        data, _ = _adapter().customer_data(_request(mode="rank", metric="gross_margin"), _live_context(sale=True))
        self.assertEqual(data["availabilityStatus"], "PARTIAL")
        self.assertEqual(data["generalAvailabilityStatus"], "AVAILABLE")
        self.assertEqual(data["marginAvailabilityStatus"], "PARTIAL")
        self.assertFalse(data["available"])
        self.assertEqual(data["items"], [])
