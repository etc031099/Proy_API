"""M6.8 deterministic business/customer/supplier intelligence regressions."""
from __future__ import annotations

import copy
import unittest
from datetime import date

from ml.src import business_customer_supplier_v3 as m68


class M68IntelligenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.engine = m68.MinimarketPascoV3Intelligence()
        cls.snapshot = cls.engine.snapshot()

    def test_periods_are_inclusive_and_capped_at_as_of_date(self) -> None:
        period = m68.resolve_period("LAST_7_DAYS", "2026-10-12")
        self.assertEqual((period["startDate"], period["endDate"], period["days"]), ("2026-10-06", "2026-10-12", 7))
        self.assertEqual(m68.resolve_period("PREVIOUS_MONTH", "2026-10-12")["endDate"], "2026-09-30")
        with self.assertRaises(ValueError):
            m68.resolve_period({"startDate": "2026-10-12", "endDate": "2026-10-13"}, "2026-10-12")

    def test_business_kpis_reconcile_and_margin_is_not_net_profit(self) -> None:
        history = self.engine.business.summary("HISTORY")
        self.assertEqual(history["kpis"]["revenueCents"], 23621514)
        self.assertEqual(history["kpis"]["unitsSold"], 54379)
        self.assertEqual(history["kpis"]["grossMarginCents"], 5619116)
        self.assertIn("no net-profit claim", history["marginIntelligence"]["classificationMethod"])
        self.assertEqual(history["sourceCounts"]["completedTickets"], 12647)
        self.assertIn("highMarginProducts", history["marginIntelligence"])
        self.assertEqual(history["trends"]["revenue"]["percentChange"], None)

    def test_customer_rfm_excludes_consumer_final_and_keeps_profiles_post_hoc(self) -> None:
        customer = self.snapshot["customers"]
        self.assertEqual(customer["registeredCustomerCount"], 40)
        self.assertFalse(customer["consumerFinalIncludedInIndividualRfm"])
        self.assertEqual(sum(customer["segmentDistribution"].values()), 40)
        self.assertTrue(all(row["preferences"]["favoriteSubcategoryCode"] for row in customer["customers"] if row["ticketCount"]))
        self.assertTrue(all("supportingMetrics" in row and row["reasonCodes"] for row in customer["customers"]))
        original_segments = {row["customerCode"]: row["segment"] for row in customer["customers"]}
        static = copy.deepcopy(self.engine.static)
        for row in static["customers"]:
            row["customerProfileKey"] = "INACTIVE"
        changed_engine = m68.CustomerIntelligenceV3(self.engine.root, self.engine.records, static, self.engine.business)
        changed = changed_engine.snapshot()
        self.assertEqual(original_segments, {row["customerCode"]: row["segment"] for row in changed["customers"]})

    def test_supplier_performance_is_observed_and_fill_rate_not_invented(self) -> None:
        supplier = self.snapshot["suppliers"]
        self.assertEqual(supplier["summary"]["receivedOrders"], 2126)
        self.assertEqual(supplier["summary"]["pendingOrders"], 29)
        self.assertEqual(supplier["summary"]["receivedSpendCents"], 17721086)
        self.assertEqual(supplier["summary"]["unitsOrdered"] - supplier["summary"]["unitsReceived"], 858)
        self.assertEqual(supplier["summary"]["fillRate"]["status"], "NOT_AVAILABLE")
        self.assertTrue(all(row["punctuality"]["classificationToleranceDays"] == 0 for row in supplier["suppliers"]))
        self.assertTrue(all(row["moqStatus"] == "NOT_CONFIGURED" for row in supplier["productAlternatives"][0]["alternatives"]))

    def test_health_integrates_approved_m66_m67_without_composite_score(self) -> None:
        health = self.snapshot["businessHealth"]
        self.assertIsNone(health["healthScore"])
        domains = health["businessHealth"]
        self.assertEqual(domains["inventory"]["products"], 80)
        self.assertEqual(domains["inventory"]["forecastSource"], "MOVING_AVERAGE_28")
        self.assertTrue(all("alerts" in domains[name] for name in ("sales", "margin", "customers", "inventory", "suppliers", "marketBasket")))
        self.assertTrue(domains["marketBasket"]["available"])
        earlier = self.engine.health.snapshot(as_of_date=date(2026, 10, 11), period="LAST_30_DAYS")
        self.assertFalse(earlier["businessHealth"]["marketBasket"]["available"])
        self.assertIsNone(earlier["businessHealth"]["inventory"]["overstockEstimatedValueCents"])

    def test_sanity_audits_are_explicit_and_reconciled(self) -> None:
        self.assertEqual({key: value["status"] for key, value in self.snapshot["sanityAudits"].items()},
                         {"business": "PASS", "customers": "PASS", "suppliers": "PASS"})
        self.assertEqual(self.snapshot["sanityAudits"]["business"]["saleParentLineMismatchCount"], 0)
        self.assertEqual(self.snapshot["sanityAudits"]["business"]["purchaseLineOrphans"], 0)

    def test_snapshot_hashes_are_repeatable_and_domains_have_stable_contracts(self) -> None:
        self.assertEqual(set(self.snapshot["logicalHashes"]), {"business", "customers", "suppliers", "businessHealth"})
        self.assertEqual(self.snapshot["logicalHashes"]["business"], m68._hash(m68._normalize_hashable(self.snapshot["business"])))
        self.assertEqual(self.snapshot["source"], "canonical_local")

    def test_prior_period_is_equal_duration_and_never_future(self) -> None:
        current = m68.resolve_period("LAST_30_DAYS", "2026-10-12")
        previous = m68.equivalent_previous_period(current)
        self.assertEqual(previous["days"], current["days"])
        self.assertLess(previous["endDate"], current["startDate"])
        self.assertEqual(m68.equivalent_previous_period(m68.resolve_period("HISTORY", "2026-10-12")), None)


if __name__ == "__main__":
    unittest.main()
