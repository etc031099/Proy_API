"""One canonical Inventory evaluation feeds both global summary and selected rows."""
from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.src import inventory_intelligence_v3 as engine
from ml.tests import test_m6_10a361_inventory_health_ridge as fixtures


def fixture(**kwargs):
    return fixtures.LiveInventoryRealLeadTimeTests()._fixture(**kwargs)


def request(source, **changes):
    return SimpleNamespace(**{**vars(source), "skus": [], "includeSummary": True, **changes})


class InventoryReuseTests(unittest.TestCase):
    def test_one_live_evaluation_matches_global_summary_and_canonical_ranking_for_80_skus(self):
        adapter, live, original, forecasts, _ = fixture(product_count=80)
        canonical = adapter._inventory_rows(live, forecasts)
        summary_request = request(original, mode="summary", limit=20)
        summary, _ = adapter.inventory_data(summary_request, live, forecasts)
        adapter._cache.clear()
        runtime = object.__new__(V3IntelligenceRuntime)
        runtime.live_inventory_supplier = adapter
        runtime._run = lambda _domain, call: call()
        ranking_request = request(original, mode="rank", metric="stockout_risk", limit=20)
        with patch.object(adapter, "_inventory_rows", wraps=adapter._inventory_rows) as evaluations, \
                patch.object(runtime, "_live_inventory_ridge_forecasts", return_value=forecasts) as forecast_batch:
            combined, _ = runtime.live_inventory_data(ranking_request, live)
        self.assertEqual(evaluations.call_count, 1)
        self.assertEqual(forecast_batch.call_count, 1)
        self.assertEqual(combined["inventorySummary"], summary)
        expected = engine.rank_products(canonical["products"], "stockout_risk")[:20]
        self.assertEqual(combined["items"], [adapter._public_inventory(row) for row in expected])
        legacy, _ = adapter.inventory_data(request(original, mode="rank", metric="stockout_risk", limit=20,
                                                   includeSummary=False), live, forecasts)
        self.assertEqual({key: value for key, value in combined.items() if key != "inventorySummary"}, legacy)
        self.assertEqual(combined["total"], 80)
        self.assertEqual(sum(summary["abcCounts"].values()), 80)
        self.assertEqual(sum(summary["xyzCounts"].values()), 80)
        self.assertEqual(sum(summary["summary"][level] for level in ("critical", "high", "medium", "low")), 80)
        self.assertTrue(all(row["forecast"]["expected1d"] is None for row in combined["items"]))

    def test_filters_keep_the_original_rows_and_the_unfiltered_summary(self):
        adapter, live, original, forecasts, _ = fixture(product_count=3)
        summary, _ = adapter.inventory_data(request(original, mode="summary"), live, forecasts)
        canonical = adapter._inventory_rows(live, forecasts)
        predicates = {"low_stock": lambda row: row["risk"]["lowStock"],
                      "should_reorder": lambda row: row["recommendation"]["shouldReorder"],
                      "overstock": lambda row: row["classification"]["overstock"],
                      "slow_moving": lambda row: row["classification"]["slowMoving"],
                      "dead_stock": lambda row: row["classification"]["deadStock"],
                      "single_source": lambda row: row["supplier"]["dependencyStatus"] == "SINGLE_SOURCE"}
        for flag, predicate in predicates.items():
            with self.subTest(flag=flag):
                result, _ = adapter.inventory_data(request(original, mode="summary", flag=flag), live, forecasts)
                self.assertEqual(result["inventorySummary"], summary)
                expected = [adapter._public_inventory(row) for row in canonical["products"] if predicate(row) is True]
                self.assertEqual(result["items"], expected)
                self.assertEqual(result["total"], len(expected))
                legacy, _ = adapter.inventory_data(request(original, mode="summary", flag=flag, includeSummary=False), live, forecasts)
                self.assertEqual({key: value for key, value in result.items() if key != "inventorySummary"}, legacy)

    def test_missing_forecast_preserves_partial_nulls_and_global_vs_ranking_counts(self):
        adapter, live, original, forecasts, _ = fixture(product_count=3, p14=None)
        summary, _ = adapter.inventory_data(request(original, mode="summary"), live, forecasts)
        ranked, _ = adapter.inventory_data(request(original, mode="rank", metric="stockout_risk"), live, forecasts)
        detail, _ = adapter.inventory_data(original, live, forecasts)
        self.assertEqual(ranked["inventorySummary"], summary)
        self.assertEqual(ranked["availabilityStatus"], "PARTIAL")
        self.assertEqual(ranked["unavailableCount"], 3)
        self.assertEqual(summary["unavailableCount"], 0)
        self.assertEqual(summary["summary"]["riskUnavailableCount"], 3)
        self.assertIsNone(summary["summary"]["low"])
        self.assertEqual(ranked["items"], [])
        for row in detail["items"]:
            self.assertIsNone(row["risk"]["level"])
            self.assertIsNone(row["recommendation"]["recommendedQty"])
            self.assertIsNone(row["recommendation"]["shouldReorder"])

    def test_existing_cache_identity_separates_scope_revision_asof_and_active_lineage(self):
        adapter, live, original, forecasts, _ = fixture()
        canonical = adapter._inventory_rows(live, forecasts)
        rank = request(original, mode="rank", metric="stockout_risk")
        with patch.object(adapter, "_inventory_rows", return_value=canonical) as evaluations:
            adapter.inventory_data(rank, live, forecasts)
            adapter.inventory_data(rank, live, forecasts)
            self.assertEqual(evaluations.call_count, 1)
            for field in ("businessId", "scenarioId"):
                scoped = deepcopy(live)
                setattr(scoped.snapshot.metadata, field, "OTHER")
                adapter.inventory_data(rank, scoped, forecasts)
            revised = deepcopy(live)
            revised.data_version = "84"
            adapter.inventory_data(rank, revised, forecasts)
            snapshot = deepcopy(live)
            snapshot.context_hash = "other-snapshot"
            adapter.inventory_data(rank, snapshot, forecasts)
            dated = deepcopy(live)
            dated.as_of_date = live.as_of_date.replace(day=13)
            adapter.inventory_data(rank, dated, forecasts)
            for horizon in (7, 14):
                promoted = deepcopy(forecasts)
                promoted[0][f"modelVersion{horizon}"] = 2
                adapter.inventory_data(rank, live, promoted)
            self.assertEqual(evaluations.call_count, 8)

    def test_historical_projection_uses_the_same_snapshot_and_engine_ranking(self):
        adapter, live, original, forecasts, _ = fixture(product_count=3)
        canonical = adapter._inventory_rows(live, forecasts)
        canonical["rankings"] = {"stockout_risk": [row["sku"] for row in reversed(canonical["products"])]}
        runtime = object.__new__(V3IntelligenceRuntime)
        runtime.resolve_context = lambda _context: live.as_of_date
        runtime._run = lambda _domain, call: call()
        original.context = None
        runtime.dataset = SimpleNamespace(product_by_sku={row["sku"]: row for row in canonical["products"]})
        with patch.object(runtime, "_inventory_snapshot", return_value=canonical) as evaluations:
            combined, _ = runtime.inventory_data(request(original, mode="rank", metric="stockout_risk"))
            self.assertEqual(evaluations.call_count, 1)
            summary, _ = runtime.inventory_data(request(original, mode="summary"))
        self.assertEqual(combined["inventorySummary"], summary)
        self.assertEqual([row["sku"] for row in combined["items"]], canonical["rankings"]["stockout_risk"])


if __name__ == "__main__":
    unittest.main()
