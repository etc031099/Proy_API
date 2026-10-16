"""A.3.6.1 contract tests for exact Ridge inventory lead-time anchors."""
from __future__ import annotations

import unittest
from datetime import date, timedelta

from ml.src.inventory_intelligence_v3 import _forecast_demand_until, evaluate_sku


class RidgeInventoryContractTests(unittest.TestCase):
    def test_live_lead_time_uses_only_exact_seven_and_fourteen_day_anchors(self):
        forecast = {"expectedUnitsNext1d": None, "expectedUnitsNext7d": 17.5,
                    "expectedUnitsNext14d": 42.25}
        self.assertEqual(_forecast_demand_until(7, forecast, ridge_live=True), (17.5, False))
        self.assertEqual(_forecast_demand_until(14, forecast, ridge_live=True), (42.25, False))
        for days in (1, 5, 10, 15, 7.5):
            with self.subTest(days=days):
                self.assertEqual(_forecast_demand_until(days, forecast, ridge_live=True), (None, False))
        self.assertEqual(_forecast_demand_until(0, forecast, ridge_live=True), (0.0, False))

    def test_missing_ridge_anchor_stays_unavailable_and_legacy_path_is_unchanged(self):
        self.assertEqual(_forecast_demand_until(7, {"expectedUnitsNext14d": 28}, ridge_live=True), (None, False))
        self.assertEqual(_forecast_demand_until(5, {"expectedUnitsNext14d": 28}, ridge_live=True), (None, False))
        legacy = {"expectedUnitsNext1d": 2.0, "expectedUnitsNext7d": 14.0, "expectedUnitsNext14d": 28.0}
        self.assertEqual(_forecast_demand_until(5, legacy), (10.0, False))
        self.assertEqual(_forecast_demand_until(21, legacy), (28.0, True))

    def _evaluate(self, lead_days: float):
        cutoff = date(2026, 10, 12)
        history = [{"localDate": (cutoff - timedelta(days=offset)).isoformat(), "unitsSold": 1,
                    "availableHours": 24, "onHandUsableAtOrigin": 10} for offset in range(28)]
        return evaluate_sku(product={"sku": "SKU-1", "productKey": "P1", "name": "Fixture",
                "categoryCode": "CAT", "minStockInitial": 2, "preferredSupplierCode": "S1"},
            forecast={"expectedUnitsNext1d": None, "expectedUnitsNext7d": 14.0,
                "expectedUnitsNext14d": 28.0, "cutoffDate": cutoff.isoformat(),
                "status": "READY", "modelVersion7": 3, "modelVersion14": 5}, daily_rows=history, on_hand=10,
            incoming_orders=[], cutoff=cutoff, lead_time_days=lead_days,
            configured_lead_time_days=lead_days, lead_time_std_days=1,
            lead_time_source="OBSERVED_PRODUCT_SUPPLIER", lead_time_sample_size=5,
            supplier={"displayName": "Proveedor"}, active_offers=[{"supplierCode": "S1"}],
            pack_multiple=1, min_order_qty=1,
            consumption_value={"abc": "A", "consumptionValueCents": 100, "cumulativeValueShare": 1.0},
            ridge_live=True)

    def test_live_evaluation_keeps_one_day_null_and_exact_lead_demand(self):
        for lead, expected in ((7, 14.0), (14, 28.0)):
            with self.subTest(lead=lead):
                result = self._evaluate(lead)
                self.assertIsNone(result["forecast"]["expected1d"])
                self.assertEqual(result["forecast"]["source"], "RIDGE_CAUSAL27")
                self.assertEqual(result["demand"]["validLeadTimeDemand"], expected)
                self.assertIsNotNone(result["inventoryPolicy"]["reorderPoint"])

    def test_unsupported_lead_time_does_not_truncate_or_create_risk_or_reorder(self):
        for lead in (1, 5, 10, 15, 21):
            with self.subTest(lead=lead):
                result = self._evaluate(lead)
                self.assertIsNone(result["demand"]["validLeadTimeDemand"])
                self.assertIsNone(result["inventoryPolicy"]["expectedDemandDuringLeadTime"])
                self.assertIsNone(result["inventoryPolicy"]["reorderPoint"])
                self.assertIsNone(result["recommendation"]["recommendedQty"])
                self.assertIsNone(result["recommendation"]["shouldReorder"])
                self.assertIsNone(result["risk"]["level"])
                self.assertTrue(result["risk"]["lowStock"] is False)
                self.assertIsNone(result["forecast"]["expected1d"])


if __name__ == "__main__":
    unittest.main()
