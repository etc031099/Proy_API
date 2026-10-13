import unittest
from datetime import date, timedelta
from pathlib import Path

from ml.src.inventory_intelligence_v3 import (
    InventoryIntelligenceV3,
    _abc_classes,
    _ceil_multiple,
    _forecast_demand_until,
    _estimate_excess_units,
    _purchase_line_as_of,
    _xyz,
    evaluate_sku,
    rank_products,
)
from ml.src import v3_forecast


ROOT = Path(__file__).resolve().parents[2]
CUTOFF = date(2026, 10, 12)


def _evaluate(*, on_hand=10, daily=2.0, incoming=None, lead=3.0, lead_std=0.0,
              min_order=1, multiple=1, perishable=False, shelf_life=None,
              recent_sales=2, available=True):
    product = {
        "sku": "TEST-001", "name": "Test product", "productKey": "v3.TEST-001",
        "categoryCode": "TEST", "currency": "PEN", "minStockInitial": 3,
        "perishable": perishable, "shelfLifeDays": shelf_life,
        "preferredSupplierCode": "SUP-01",
    }
    forecast = {"cutoffDate": CUTOFF.isoformat(), "status": "READY",
                "expectedUnitsNext1d": daily, "expectedUnitsNext7d": daily * 7,
                "expectedUnitsNext14d": daily * 14}
    daily_rows = []
    for offset in range(60, 0, -1):
        day = CUTOFF - timedelta(days=offset)
        is_available = available
        sold = recent_sales if offset <= 30 and day.day % 7 == 0 else 0
        daily_rows.append({"localDate": day.isoformat(), "unitsSold": sold,
                           "availableHours": 24 if is_available else 0,
                           "onHandUsableAtOrigin": 10 if is_available else 0,
                           "effectiveUnitCostAtSale": 100})
    daily_rows.append({"localDate": (CUTOFF + timedelta(days=1)).isoformat(),
                       "unitsSold": 999999, "availableHours": 24,
                       "onHandUsableAtOrigin": 100, "effectiveUnitCostAtSale": 100})
    return evaluate_sku(
        product=product, forecast=forecast, daily_rows=daily_rows, on_hand=on_hand,
        incoming_orders=incoming or [], cutoff=CUTOFF, lead_time_days=lead,
        configured_lead_time_days=4, lead_time_std_days=lead_std,
        lead_time_source="OBSERVED_PRODUCT_SUPPLIER", lead_time_sample_size=8,
        supplier={"displayName": "Supplier 1"}, active_offers=[{"supplierCode": "SUP-01"}],
        pack_multiple=multiple, min_order_qty=min_order,
        consumption_value={"abc": "A", "consumptionValueCents": 100000,
                           "cumulativeValueShare": 0.8},
    )


class M66InventoryIntelligenceTests(unittest.TestCase):
    def test_forecast_interpolates_and_caps_at_approved_14d(self):
        forecast = {"expectedUnitsNext1d": 2, "expectedUnitsNext7d": 14,
                    "expectedUnitsNext14d": 35}
        self.assertEqual(_forecast_demand_until(1, forecast), (2, False))
        self.assertEqual(_forecast_demand_until(7, forecast), (14, False))
        self.assertEqual(_forecast_demand_until(14, forecast), (35, False))
        self.assertEqual(_forecast_demand_until(30, forecast), (35, True))

    def test_abc_uses_stable_value_order_and_classifies_all_skus(self):
        groups = _abc_classes({"A": 800, "B": 150, "C": 50, "D": 0})
        self.assertEqual(set(groups), {"A", "B", "C", "D"})
        self.assertEqual([groups[sku]["abc"] for sku in "ABCD"], ["A", "B", "C", "C"])
        self.assertEqual(_abc_classes({"x": 0})["x"]["abc"], "UNCLASSIFIED")

    def test_xyz_thresholds_insufficient_history_and_no_movement(self):
        self.assertEqual(_xyz([1] * 8)["xyz"], "X")
        self.assertEqual(_xyz([0, 0, 0, 0, 0, 0, 0, 10])["xyz"], "Z")
        self.assertEqual(_xyz([0] * 13)["status"], "NO_MOVEMENT")
        self.assertEqual(_xyz([1] * 7)["status"], "INSUFFICIENT_HISTORY")

    def test_zero_stock_is_critical_and_low_stock_is_separate(self):
        row = _evaluate(on_hand=0)
        self.assertEqual(row["risk"]["level"], "CRITICAL")
        self.assertTrue(row["risk"]["lowStock"])
        self.assertTrue(row["risk"]["lowStockSeparateFromRisk"])

    def test_zero_demand_is_finite_and_explained(self):
        row = _evaluate(daily=0)
        self.assertIsNone(row["coverage"]["daysCover"])
        self.assertEqual(row["coverage"]["status"], "LOW_OR_NO_RECENT_DEMAND")
        self.assertEqual(row["recommendation"]["recommendedQty"], 0)
        self.assertEqual(row["risk"]["level"], "LOW")

    def test_low_demand_still_has_finite_cover_and_deterministic_reorder(self):
        row = _evaluate(daily=0.1, on_hand=1)
        self.assertEqual(row["coverage"]["daysCover"], 10)
        self.assertIsInstance(row["recommendation"]["recommendedQty"], int)

    def test_incoming_tomorrow_changes_depletion_but_late_incoming_does_not_hide_risk(self):
        timely = _evaluate(on_hand=2, daily=1, lead=3, incoming=[
            {"purchaseCode": "P1", "units": 10, "supplierCode": "SUP-01",
             "expectedReceiptDate": (CUTOFF + timedelta(days=1)).isoformat()}])
        late = _evaluate(on_hand=2, daily=1, lead=3, incoming=[
            {"purchaseCode": "P2", "units": 10, "supplierCode": "SUP-01",
             "expectedReceiptDate": (CUTOFF + timedelta(days=4)).isoformat()}])
        self.assertGreater(timely["risk"]["approxDaysToDepletionWithKnownInbound"],
                           late["risk"]["approxDaysToDepletionWithKnownInbound"])
        self.assertEqual(timely["risk"]["level"], "MEDIUM")
        self.assertEqual(late["risk"]["level"], "HIGH")
        self.assertEqual(timely["stock"]["onHand"], 2)
        self.assertEqual(timely["stock"]["incoming"], 10)

    def test_purchase_order_does_not_count_as_on_hand_or_double_recommend(self):
        row = _evaluate(on_hand=20, daily=1, lead=2, incoming=[
            {"purchaseCode": "P1", "units": 20, "supplierCode": "SUP-01",
             "expectedReceiptDate": (CUTOFF + timedelta(days=2)).isoformat()}])
        self.assertEqual(row["stock"]["onHand"], 20)
        self.assertEqual(row["stock"]["inventoryPosition"], 40)
        self.assertFalse(row["recommendation"]["shouldReorder"])

    def test_historical_purchase_uses_receipt_date_not_final_status(self):
        order = {"orderedLocalDate": "2026-08-20", "promisedLocalDate": "2026-08-25",
                 "receivedLocalDate": "2026-08-28", "status": "completed"}
        line = {"quantityOrdered": 12, "quantityReceived": 12, "status": "received"}
        before_receipt = _purchase_line_as_of(order, line, date(2026, 8, 24))
        on_promise_but_not_received = _purchase_line_as_of(order, line, date(2026, 8, 26))
        after_receipt = _purchase_line_as_of(order, line, date(2026, 8, 29))
        self.assertEqual(before_receipt["incomingUnits"], 12)
        self.assertEqual(before_receipt["remainingUnits"], 12)
        self.assertEqual(on_promise_but_not_received["overdueOrUnknownUnits"], 12)
        self.assertEqual(after_receipt["remainingUnits"], 0)
        self.assertTrue(after_receipt["receivedByCutoff"])

    def test_safety_stock_increases_with_lead_time_variability(self):
        stable = _evaluate(on_hand=0, daily=2, lead=5, lead_std=0)
        variable = _evaluate(on_hand=0, daily=2, lead=5, lead_std=3)
        self.assertGreater(variable["inventoryPolicy"]["safetyStock"],
                           stable["inventoryPolicy"]["safetyStock"])

    def test_pack_multiple_moq_and_perishable_shelf_life_cap(self):
        ordinary = _evaluate(on_hand=0, daily=3, lead=4, min_order=5, multiple=4)
        self.assertEqual(ordinary["recommendation"]["recommendedQty"] % 4, 0)
        bread = _evaluate(on_hand=0, daily=3, lead=4, min_order=1, multiple=4,
                          perishable=True, shelf_life=1)
        self.assertLessEqual(bread["recommendation"]["recommendedQty"], 4)
        self.assertIn("PERISHABLE_CAP", bread["risk"]["reasonCodes"])
        self.assertIsNone(bread["risk"]["projectedStockoutDate"])

    def test_slow_and_dead_stock_require_observable_availability(self):
        slow = _evaluate(daily=0.1, on_hand=20, recent_sales=1)
        dead = _evaluate(daily=0.1, on_hand=20, recent_sales=0)
        unavailable = _evaluate(daily=0.1, on_hand=20, recent_sales=0, available=False)
        self.assertTrue(slow["classification"]["slowMoving"])
        self.assertTrue(dead["classification"]["deadStock"])
        self.assertFalse(unavailable["classification"]["slowMoving"])
        self.assertFalse(unavailable["classification"]["deadStock"])

    def test_overstock_uses_demand_coverage_not_fixed_stock_threshold(self):
        threshold, excess = _estimate_excess_units(inventory_position=500, expected_daily=1,
            safety_stock=5, lead_time_days=4, perishable=False, shelf_life_days=None)
        self.assertEqual(threshold, 35)
        self.assertEqual(excess, 465)
        _, perishable_excess = _estimate_excess_units(inventory_position=20, expected_daily=2,
            safety_stock=5, lead_time_days=4, perishable=True, shelf_life_days=3)
        self.assertEqual(perishable_excess, 14)

    def test_future_daily_rows_cannot_change_historical_snapshot_evaluation(self):
        before = _evaluate(on_hand=10, daily=1)
        self.assertEqual(before["demand"]["exposureDaysLast28"], 28)
        self.assertEqual(before["classification"]["productObservableAgeDays"], 60)

    def test_single_and_multi_source_and_rankings_are_stable(self):
        row = _evaluate(on_hand=0)
        row["supplier"]["activeOfferCount"] = 1
        row["supplier"]["dependencyStatus"] = "SINGLE_SOURCE"
        row2 = dict(row, sku="TEST-002")
        row2["supplier"] = {"activeOfferCount": 2, "dependencyStatus": "MULTI_SOURCE"}
        self.assertEqual(rank_products([row2, row], "stockout_risk")[0]["sku"], "TEST-001")
        self.assertEqual(rank_products([row2, row], "single_source_critical")[0]["sku"], "TEST-001")
        self.assertEqual(_ceil_multiple(5, 4), 8)

    @classmethod
    def setUpClass(cls):
        cls.snapshot = InventoryIntelligenceV3(ROOT).snapshot(as_of_date=v3_forecast.HISTORY_END)

    def test_canonical_snapshot_is_80_skus_approved_forecast_and_has_classifications(self):
        snap = self.snapshot
        self.assertEqual(snap["scenarioId"], "minimarket-pasco-v3")
        self.assertEqual(snap["datasetSha256"], "a90b913b6ee83174165b39eaab1526525b3aacc53cae1abe6c3f5a54a469cac8")
        self.assertEqual(snap["summary"]["products"], 80)
        self.assertEqual(sum(snap["abcCounts"].values()), 80)
        self.assertEqual(sum(snap["xyzCounts"].values()), 80)
        self.assertTrue(all(row["forecast"]["source"] == "MOVING_AVERAGE_28" for row in snap["products"]))
        self.assertTrue(all(row["forecast"].keys() >= {"expected1d", "expected7d", "expected14d"} for row in snap["products"]))
        self.assertEqual(sum(snap["summary"][key] for key in ("critical", "high", "medium", "low")), 80)
        self.assertNotEqual(snap["summary"]["critical"], 80)
        self.assertNotEqual(snap["summary"]["low"], 80)
        self.assertEqual(snap["summary"]["pendingOrderCount"], 29)
        self.assertGreater(snap["summary"]["incomingUnits"], 0)
        self.assertIsInstance(snap["summary"]["inventoryValueCents"], int)

    def test_canonical_pan_fre_policy_is_pack_bounded_and_has_inbound_evidence(self):
        pan = next(row for row in self.snapshot["products"] if row["sku"] == "PAN-FRE-001")
        self.assertEqual(pan["recommendation"]["recommendedQty"] % 4, 0)
        self.assertLessEqual(pan["recommendation"]["recommendedQty"], 4)
        self.assertLessEqual(pan["recommendation"]["recommendedQty"],
                             pan["inventoryPolicy"]["targetStock"] + 4)
        self.assertGreaterEqual(pan["stock"]["incoming"], 0)
        self.assertIn("projectedStockoutDateStatus", pan["risk"])

    def test_historical_cutoff_excludes_future_orders_and_stock_changes(self):
        historical = InventoryIntelligenceV3(ROOT).snapshot(as_of_date=date(2026, 9, 1))
        self.assertEqual(historical["asOfDate"], "2026-09-01")
        self.assertTrue(all(row["asOfDate"] == "2026-09-01" for row in historical["products"]))
        self.assertTrue(all(order["expectedReceiptDate"] > "2026-09-01"
                            for row in historical["products"] for order in row["stock"]["pendingOrders"]))


if __name__ == "__main__":
    unittest.main()
