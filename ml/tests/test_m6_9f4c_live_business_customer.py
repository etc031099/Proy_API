"""Focused fixture tests for F.4C live Business/Customer adapters."""
from __future__ import annotations

import unittest
from datetime import date
from types import SimpleNamespace

from ml.service.v3_live_business_customer import LiveBusinessCustomerAdapter


def _line(*, key="LIVE-1:L1", cost_known=True):
    return SimpleNamespace(lineKey=key, sku="SKU-1", productKey="P-1", quantity=2,
        lineTotalCents=500, unitCostAtSaleCents=100 if cost_known else None,
        costKnown=cost_known, promo=False)


def _live_context(*, version="1", sale=True, cancelled=(), new_customer=False, sale_customer="C1",
                  sale_date=date(2026, 10, 14), business_id="B1"):
    sales = []
    if sale:
        sales.append(SimpleNamespace(saleKey="LIVE-1", initialStatus="completed",
            localDate=sale_date, customerKey=sale_customer, totalCents=500,
            currency="PEN", lines=(_line(cost_known=False),)))
    customers = {"C1": {"customerCode": "C1", "displayName": "Cliente uno"}}
    if new_customer:
        customers["C2"] = {"entityKey": "C2", "name": "Cliente nuevo"}
    return SimpleNamespace(
        snapshot=SimpleNamespace(metadata=SimpleNamespace(businessId=business_id, scenarioId="SCENARIO-1"), sales=sales),
        context_hash=f"hash-{version}", as_of_date=date(2026, 10, 14),
        cancelled_transaction_keys=frozenset(cancelled), products_by_key={"P-1": {
            "productKey": "P-1", "sku": "SKU-1", "name": "Producto uno", "active": True,
            "categoryCode": "PAN", "subcategoryCode": "PAN-FRE", "presentation": "Unidad",
            "sizeValue": 1, "sizeUnit": "unit"}}, customers_by_key=customers,
        data_version=version, freshness=lambda domain: {"mode": "LIVE", "asOfDate": "2026-10-14",
                                                        "dataVersion": version, "engineVersion": "fixture"})


class _HistoricalBusiness:
    def __init__(self):
        self.sales = [{"saleCode": "HIST-1", "localDate": "2026-10-12", "customerCode": "C1",
                       "currency": "PEN", "status": "completed", "totalCents": 300,
                       "ticketDiscountCents": 0, "itemDiscountCents": 0}]
        self.lines = {"HIST-1": [{"saleCode": "HIST-1", "saleLineKey": "HIST-1:L1", "sku": "SKU-1",
            "unitsSold": 1, "lineTotalCents": 300, "costAtSaleCents": 100,
            "transactionStatus": "completed"}]}

    def _sales(self, _as_of):
        return self.sales, self.lines


def _adapter():
    static = {
        "products": [{"sku": "SKU-1", "name": "Producto uno", "presentation": "Unidad",
            "sizeValue": 1, "sizeUnit": "unit", "categoryCode": "PAN", "subcategoryCode": "PAN-FRE",
            "active": True}],
        "categories": {"categories": [{"code": "PAN", "name": "Panadería", "subcategories": [
            {"code": "PAN-FRE", "name": "Pan francés"}]}]},
        "customers": [{"customerCode": "C1", "displayName": "Cliente uno", "customerProfileKey": "RECENT"}],
    }
    return LiveBusinessCustomerAdapter(".", {}, static, _HistoricalBusiness())


def _request(**kwargs):
    defaults = {"period": SimpleNamespace(startDate=date(2026, 10, 12), endDate=date(2026, 10, 14)),
                "mode": "summary", "categoryCode": None, "subcategoryCode": None, "productSku": None,
                "entityType": None, "metric": None, "customerCode": None, "segment": None,
                "offset": 0, "limit": 5}
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class M69F4CLiveBusinessCustomerTests(unittest.TestCase):
    def test_write_read_revision_and_unknown_cost_are_grounded(self):
        adapter = _adapter()
        initial, _ = adapter.business_data(_request(), _live_context(sale=False, version="1"))
        updated, _ = adapter.business_data(_request(), _live_context(sale=True, version="2"))
        self.assertEqual(initial["kpis"]["revenueCents"], 300)
        self.assertEqual(updated["kpis"]["revenueCents"], 800)
        self.assertEqual(updated["kpis"]["ticketCount"], 2)
        self.assertEqual(updated["kpis"]["unitsSold"], 3)
        self.assertIsNone(updated["kpis"]["cogsCents"])
        self.assertEqual(updated["costCoverage"]["reasonCode"], "COST_NOT_AVAILABLE")
        self.assertEqual(updated["availabilityStatus"], "PARTIAL")
        self.assertEqual(updated["marginIntelligence"]["grossMarginCents"], None)

    def test_live_comparison_and_product_ranking_include_delta_sales(self):
        adapter = _adapter()
        context = _live_context(sale=True, version="9")
        compared, _ = adapter.business_data(_request(mode="compare"), context)
        ranked, _ = adapter.business_data(_request(mode="rank", metric="revenue", entityType="product"), context)
        self.assertEqual(compared["previousPeriod"]["endDate"], "2026-10-11")
        self.assertEqual(compared["kpis"]["revenueCents"], 800)
        self.assertEqual(ranked["items"][0]["sku"], "SKU-1")

    def test_live_and_historical_cancellations_exclude_original_ticket(self):
        adapter = _adapter()
        live_cancelled, _ = adapter.business_data(_request(), _live_context(cancelled=("LIVE-1",)))
        historical_cancelled, _ = adapter.business_data(_request(), _live_context(version="2", sale=False,
                                                                                   cancelled=("HIST-1",)))
        self.assertEqual(live_cancelled["kpis"]["revenueCents"], 300)
        self.assertEqual(live_cancelled["kpis"]["ticketCount"], 1)
        self.assertEqual(historical_cancelled["kpis"]["revenueCents"], 0)
        self.assertEqual(historical_cancelled["kpis"]["ticketCount"], 0)
        self.assertEqual(adapter.historical_business.sales[0]["saleCode"], "HIST-1")

    def test_customer_spend_and_frequency_exclude_both_cancellation_origins(self):
        adapter = _adapter()
        request = _request(mode="detail", customerCode="C1")
        base, _ = adapter.customer_data(request, _live_context(sale=False, version="1"))
        cancelled_historical, _ = adapter.customer_data(request,
            _live_context(sale=False, version="2", cancelled=("HIST-1",)))
        cancelled_live, _ = adapter.customer_data(request,
            _live_context(sale=True, version="3", cancelled=("LIVE-1",)))
        self.assertEqual(base["items"][0]["ticketCount"], 1)
        self.assertEqual(cancelled_historical["items"][0]["ticketCount"], 0)
        self.assertEqual(cancelled_historical["items"][0]["totalSpentCents"], 0)
        self.assertEqual(cancelled_live["items"][0]["ticketCount"], 1)
        self.assertEqual(cancelled_live["items"][0]["totalSpentCents"], 300)

    def test_partial_today_and_yesterday_use_snapshot_effective_sales(self):
        adapter = _adapter()
        today, _ = adapter.business_data(_request(period=SimpleNamespace(
            startDate=date(2026, 10, 14), endDate=date(2026, 10, 14))),
            _live_context(sale=True, version="today"))
        yesterday, _ = adapter.business_data(_request(period=SimpleNamespace(
            startDate=date(2026, 10, 13), endDate=date(2026, 10, 13))),
            _live_context(sale=True, version="yesterday", sale_date=date(2026, 10, 13)))
        self.assertEqual(today["kpis"]["revenueCents"], 500)
        self.assertEqual(today["kpis"]["ticketCount"], 1)
        self.assertEqual(yesterday["kpis"]["revenueCents"], 500)

    def test_live_cache_isolated_by_business_even_for_same_revision_markers(self):
        adapter = _adapter()
        first, _ = adapter.business_data(_request(), _live_context(sale=False, version="same"))
        other_business, _ = adapter.business_data(_request(), _live_context(
            sale=True, version="same", business_id="B2"))
        self.assertEqual(first["kpis"]["revenueCents"], 300)
        self.assertEqual(other_business["kpis"]["revenueCents"], 800)

    def test_missing_live_cost_is_masked_through_nested_customer_windows_and_trends(self):
        adapter = _adapter()
        data, _ = adapter.customer_data(_request(mode="detail", customerCode="C1"),
                                        _live_context(sale=True))
        item = data["items"][0]
        self.assertIsNone(item["grossMarginContributionCents"])
        self.assertIsNone(item["windows"]["history"]["grossMarginContributionCents"])
        self.assertIsNone(item["windows"]["last7Days"]["grossMarginContributionCents"])
        self.assertIsNone(item["trends30d"]["current"]["grossMarginContributionCents"])
        self.assertIsNone(item["trends30d"]["previous"]["grossMarginContributionCents"])
        self.assertEqual(item["costCoverage"]["reasonCode"], "COST_NOT_AVAILABLE")

    def test_customer_partial_diagnostic_reports_aggregate_cost_gaps_without_identity(self):
        data, _ = _adapter().customer_data(_request(mode="summary", limit=100), _live_context(sale=True))
        diagnostics = data["availabilityDiagnostics"]
        self.assertEqual(data["availabilityStatus"], "AVAILABLE")
        self.assertEqual(data["marginAvailabilityStatus"], "PARTIAL")
        self.assertEqual(diagnostics, [
            {"code": "CUSTOMER_HISTORICAL_COST_COVERAGE_INCOMPLETE", "affectedCustomerCount": 1,
             "unknownSaleLineCount": 1},
            {"code": "CUSTOMER_PERIOD_COST_COVERAGE_INCOMPLETE", "affectedCustomerCount": 1,
             "unknownSaleLineCount": 1},
        ])
        self.assertNotIn("C1", repr(diagnostics))
        self.assertNotIn("Cliente", repr(diagnostics))

    def test_customer_live_sale_updates_rfm_and_new_customer_cohort(self):
        adapter = _adapter()
        data, _ = adapter.customer_data(_request(mode="summary"),
                                         _live_context(new_customer=True))
        by_code = {row["customerCode"]: row for row in data["items"]}
        self.assertEqual(data["total"], 2)
        self.assertEqual(by_code["C1"]["lastPurchaseDate"], "2026-10-14")
        self.assertEqual(by_code["C1"]["recencyDays"], 0)
        self.assertEqual(by_code["C1"]["ticketCount"], 2)
        self.assertEqual(by_code["C2"]["segment"], "INSUFFICIENT_HISTORY")

    def test_new_customer_first_sale_is_new_and_consumer_final_stays_unprofiled(self):
        adapter = _adapter()
        new_customer, _ = adapter.customer_data(_request(mode="summary"),
            _live_context(new_customer=True, sale_customer="C2"))
        by_code = {row["customerCode"]: row for row in new_customer["items"]}
        self.assertEqual(by_code["C2"]["segment"], "NEW")
        consumer, _ = adapter.customer_data(_request(mode="summary"),
            _live_context(new_customer=True, sale_customer=None))
        self.assertNotIn(None, {row["customerCode"] for row in consumer["items"]})
        self.assertFalse(consumer["consumerFinalIncludedInIndividualRfm"])

    def test_new_customer_without_purchase_has_no_invented_rfm_profile(self):
        adapter = _adapter()
        data, _ = adapter.customer_data(_request(mode="summary"),
            _live_context(new_customer=True, sale=False))
        new_customer = next(row for row in data["items"] if row["customerCode"] == "C2")
        self.assertEqual(new_customer["historyStatus"], "INSUFFICIENT_HISTORY")
        self.assertEqual(new_customer["segment"], "INSUFFICIENT_HISTORY")
        self.assertEqual(new_customer["rfm90d"]["score"], {"R": None, "F": None, "M": None})
        self.assertEqual(data["availabilityStatus"], "AVAILABLE")
        self.assertEqual(data["availabilityDiagnostics"], [])
        filtered, _ = adapter.customer_data(_request(mode="summary", segment="INSUFFICIENT_HISTORY"),
            _live_context(new_customer=True, sale=False, version="next"))
        self.assertEqual([row["customerCode"] for row in filtered["items"]], ["C2"])

    def test_live_catalog_projection_does_not_mutate_frozen_product_rows(self):
        adapter = _adapter()
        original_name = adapter.static["products"][0]["name"]
        changed = _live_context(sale=False)
        changed.products_by_key = {"P-1": {**changed.products_by_key["P-1"], "name": "Nombre operativo"}}
        adapter._view(changed, changed.as_of_date)
        self.assertEqual(adapter.static["products"][0]["name"], original_name)

    def test_runtime_live_wrappers_map_business_customer_and_partial_readiness(self):
        from ml.service.v3_intelligence_runtime import V3FunctionalError, V3IntelligenceRuntime
        adapter = _adapter()
        live = _live_context(sale=True)
        runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        runtime.live_adapter = adapter
        runtime._run = lambda _domain, callback: callback()
        business, cutoff = runtime.live_business_data(_request(), live)
        customer, customer_cutoff = runtime.live_customer_data(_request(mode="summary"), live)
        self.assertEqual(cutoff, date(2026, 10, 14))
        self.assertEqual(customer_cutoff, cutoff)
        self.assertEqual(business["availabilityStatus"], "PARTIAL")
        self.assertIn("items", customer)
        runtime.live_adapter = None
        with self.assertRaises(V3FunctionalError) as raised:
            runtime.live_business_data(_request(), live)
        self.assertEqual(raised.exception.code, "LIVE_ANALYTICS_NOT_READY")

    def test_live_readiness_is_domain_specific(self):
        from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
        runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        runtime.ready = True
        runtime.live_adapter = object()
        runtime.domains = {name: True for name in ("business", "customer", "supplier", "inventory", "forecast", "crossSell", "health")}
        runtime.loading_metrics = {}
        runtime.domain_errors = {}
        runtime.load_error_code = None
        status = runtime.public_status()
        self.assertTrue(status["liveDomains"]["business"] and status["liveDomains"]["customer"])
        self.assertFalse(status["liveDomains"]["supplier"] or status["liveDomains"]["inventory"]
                         or status["liveDomains"]["forecast"] or status["liveDomains"]["health"])

    def test_live_period_ranges_cross_cutoff_and_are_inclusive(self):
        from ml.src.business_customer_supplier_v3 import resolve_period
        for code, start, end, days in (
            ("TODAY", "2026-10-14", "2026-10-14", 1),
            ("YESTERDAY", "2026-10-13", "2026-10-13", 1),
            ("LAST_7_DAYS", "2026-10-08", "2026-10-14", 7),
            ("LAST_30_DAYS", "2026-09-15", "2026-10-14", 30),
        ):
            period = resolve_period(code, "2026-10-14", allow_live=True)
            self.assertEqual((period["startDate"], period["endDate"], period["days"]),
                             (start, end, days))
        with self.assertRaises(ValueError):
            resolve_period("TODAY", "2026-10-14")


if __name__ == "__main__":
    unittest.main()
