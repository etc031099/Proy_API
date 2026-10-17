"""Inventory policy rate approximation from approved Ridge 7d/14d forecasts."""
from __future__ import annotations

import unittest
import math
from datetime import date, timedelta
from statistics import pstdev
from types import SimpleNamespace
from unittest.mock import patch

from ml.src.inventory_intelligence_v3 import _forecast_demand_until, _ridge_lead_time_reason, evaluate_sku
from ml.service.v3_live_inventory_supplier import LiveInventorySupplierAdapter


class RidgeInventoryContractTests(unittest.TestCase):
    def test_live_lead_time_uses_operational_mean_rate_within_approved_horizon(self):
        forecast = {"expectedUnitsNext1d": None, "expectedUnitsNext7d": 17.5,
                    "expectedUnitsNext14d": 42.25}
        mu = (17.5 / 7 + 42.25 / 14) / 2
        for days in (7, 14, 6.28, 10, 13.9):
            with self.subTest(days=days):
                demand, clipped = _forecast_demand_until(days, forecast, ridge_live=True)
                self.assertAlmostEqual(demand, mu * days)
                self.assertFalse(clipped)
        for days in (None, 0, -1, True, '7', float('nan'), float('inf'), 14.01, 21):
            with self.subTest(invalid=days):
                self.assertEqual(_forecast_demand_until(days, forecast, ridge_live=True), (None, False))

    def test_missing_ridge_anchor_stays_unavailable_and_legacy_path_is_unchanged(self):
        self.assertEqual(_forecast_demand_until(7, {"expectedUnitsNext14d": 28}, ridge_live=True), (None, False))
        self.assertEqual(_forecast_demand_until(5, {"expectedUnitsNext14d": 28}, ridge_live=True), (None, False))
        self.assertEqual(_forecast_demand_until(14, {"expectedUnitsNext7d": 14}, ridge_live=True), (None, False))
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

    def test_live_evaluation_keeps_one_day_null_and_uses_rate_times_lead(self):
        for lead in (7, 14, 6.28, 10, 13.9):
            with self.subTest(lead=lead):
                result = self._evaluate(lead)
                self.assertIsNone(result["forecast"]["expected1d"])
                self.assertEqual(result["forecast"]["source"], "RIDGE_CAUSAL27")
                self.assertAlmostEqual(result["demand"]["validLeadTimeDemand"], 2.0 * lead)
                self.assertIsNotNone(result["inventoryPolicy"]["reorderPoint"])

    def test_unsupported_lead_time_does_not_truncate_or_create_risk_or_reorder(self):
        for lead in (None, 0, -1, float('nan'), float('inf'), 14.01, 21):
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
                self.assertIn(_ridge_lead_time_reason(lead), result["risk"]["reasonCodes"])


class LiveInventoryRealLeadTimeTests(unittest.TestCase):
    def _fixture(self, *, lead=6.28, sigma_lead=1.0, history_days=28, p7=17.5, p14=42.25):
        cutoff = date(2026, 10, 12)
        history = [{"localDate": (cutoff - timedelta(days=i)).isoformat(), "unitsSold": 1 + i % 3,
                    "availableHours": 15, "onHandUsableAtOrigin": 10,
                    "effectiveUnitCostAtSale": 50} for i in range(history_days)]
        product = {"sku": "SKU-1", "productKey": "P1", "name": "Fixture", "categoryCode": "CAT",
                   "minStockInitial": 2, "preferredSupplierCode": "S1", "supplierOffers": []}
        if lead is not None:
            product['leadTimeDays'] = lead
        supplier = {"supplierCode": "S1", "displayName": "Fixture supplier"}
        if sigma_lead is not None:
            supplier['leadTimeStdDays'] = sigma_lead
        adapter = LiveInventorySupplierAdapter(
            {"products": [{"sku": "SKU-1", "productKey": "P1"}], "purchases": [],
             "purchaseLines": [], "sales": [], "saleItems": []},
            {"products": [product], "suppliers": [supplier], "offers": {}},
            SimpleNamespace(dataset=SimpleNamespace(daily_by_sku={"SKU-1": history})),
            SimpleNamespace(_offers=lambda _cutoff: {}))
        live = SimpleNamespace(as_of_date=cutoff, data_version='fixture', context_hash='fixture',
            snapshot=SimpleNamespace(metadata=SimpleNamespace(businessId='B', scenarioId='V3'),
                purchases=[], transactionChanges=[], closedSalesDays=[], sales=[]),
            products_by_key={'P1': product}, products_by_sku={'SKU-1': product},
            stock_for=lambda **_kwargs: 4, cancelled_transaction_keys=frozenset(), received_by_purchase_line={},
            freshness=lambda domain: {'mode': 'LIVE'})
        request = SimpleNamespace(mode='detail', skus=['SKU-1'], limit=5, offset=0,
            risk=None, abc=None, xyz=None, flag=None, metric='reorder')
        forecasts = [{'sku': 'SKU-1', 'horizon7Status': 'READY', 'horizon14Status': 'READY',
            'expectedUnitsNext1d': None, 'expectedUnitsNext7d': p7, 'expectedUnitsNext14d': p14,
            'modelVersion7': 1, 'modelVersion14': 1, 'cutoffDate': cutoff.isoformat(), 'status': 'READY'}]
        return adapter, live, request, forecasts, history

    def _read(self, **kwargs):
        adapter, live, request, forecasts, history = self._fixture(**kwargs)
        data, _ = adapter.inventory_data(request, live, forecasts)
        return data, data['items'][0], history

    def test_real_leads_calculate_risk_reorder_and_preserve_existing_formulas(self):
        mu = (17.5 / 7 + 42.25 / 14) / 2
        for lead in (7, 14, 6.28, 10, 13.9):
            with self.subTest(lead=lead):
                data, row, history = self._read(lead=lead)
                sigma = pstdev([item['unitsSold'] for item in history])
                ss = 1.28 * math.sqrt(lead * sigma**2 + mu**2 * 1.0**2)
                self.assertAlmostEqual(row['demand']['expectedDaily'], mu)
                self.assertAlmostEqual(row['coverage']['daysCover'], 4 / mu)
                self.assertAlmostEqual(row['inventoryPolicy']['expectedDemandDuringLeadTime'], mu * lead)
                self.assertAlmostEqual(row['inventoryPolicy']['safetyStockRaw'], ss)
                self.assertEqual(row['inventoryPolicy']['reorderPoint'], math.ceil(mu * lead + max(1, math.ceil(ss))))
                self.assertIsNotNone(row['risk']['level'])
                self.assertIsNotNone(row['recommendation']['recommendedQty'])
                self.assertEqual(row['recommendation']['availabilityStatus'], 'AVAILABLE')
                self.assertIsNone(row['forecast']['expected1d'])
                self.assertIsNone(row['risk']['projectedStockoutDate'])
                self.assertEqual(row['forecast']['source'], 'RIDGE_CAUSAL27')
                self.assertIn('aproximación operacional', row['demand']['leadTimeDemandInterpretation'])
                self.assertNotIn('UNSUPPORTED_LEAD_TIME', row['risk']['reasonCodes'])

    def test_observed_fractional_lead_uses_real_sample_mean_and_variability(self):
        adapter, live, request, forecasts, _ = self._fixture()
        samples = [5.5, 6.5, 6.4, 6.3, 6.7]
        with patch.object(adapter, '_lead_samples', return_value=({('SKU-1', 'S1'): samples}, {})):
            data, _ = adapter.inventory_data(request, live, forecasts)
        row = data['items'][0]
        self.assertAlmostEqual(row['supplier']['leadTimeDays'], 6.28)
        self.assertEqual(row['supplier']['leadTimeSource'], 'OBSERVED_PRODUCT_SUPPLIER')
        self.assertAlmostEqual(row['supplier']['historicalLeadTime']['stdDays'], pstdev(samples))
        self.assertIsNotNone(row['risk']['level'])
        self.assertIsNotNone(row['recommendation']['recommendedQty'])

    def test_missing_invalid_and_beyond_horizon_leads_remain_partial(self):
        cases = [(None, 'MISSING_LEAD_TIME'), (0, 'INVALID_LEAD_TIME'), (-1, 'INVALID_LEAD_TIME'),
                 ('invalid', 'INVALID_LEAD_TIME'), (True, 'INVALID_LEAD_TIME'),
                 (float('nan'), 'INVALID_LEAD_TIME'), (float('inf'), 'INVALID_LEAD_TIME'),
                 (14.01, 'LEAD_TIME_BEYOND_APPROVED_HORIZON'), (21, 'LEAD_TIME_BEYOND_APPROVED_HORIZON')]
        for lead, reason in cases:
            with self.subTest(lead=lead):
                data, row, _ = self._read(lead=lead)
                self.assertEqual(data['availabilityStatus'], 'PARTIAL')
                self.assertEqual(row['risk']['reasonCode'], reason)
                self.assertIsNone(row['risk']['level'])
                self.assertIsNone(row['recommendation']['recommendedQty'])
                self.assertIsNone(row['recommendation']['shouldReorder'])
                self.assertIsNone(row['inventoryPolicy']['expectedDemandDuringLeadTime'])
                self.assertIsNone(row['inventoryPolicy']['reorderPoint'])
                self.assertEqual(row['inventoryPolicy']['safetyStockStatus'], 'PARTIAL')
                self.assertEqual(row['coverage']['availabilityStatus'], 'AVAILABLE')

    def test_one_day_remains_unapproved_before_registry_or_scoring(self):
        from ml.service.v3_live_ridge import ridge_live_forecast
        from ml.service.v3_schemas import BUSINESS_ID, SCENARIO_ID
        live = SimpleNamespace(data_version='83', context_hash='fixture',
            snapshot=SimpleNamespace(metadata=SimpleNamespace(businessId=BUSINESS_ID,
                scenarioId=SCENARIO_ID, observationsClosedThrough=date(2026, 10, 15))))
        result = ridge_live_forecast(dataset=None, live=live, business_id=BUSINESS_ID,
            scenario_id=SCENARIO_ID, sku='SKU-1', horizon_days=1,
            registry_loader=lambda **_kwargs: self.fail('1d must not load a model or fallback'))
        self.assertEqual(result['status'], 'MODEL_NOT_APPROVED')
        self.assertEqual(result['reasonCode'], 'PROMOTION_POLICY_FAILED')
        self.assertIsNone(result['predictionUnits'])

    def test_each_missing_ridge_anchor_is_partial_without_a_baseline(self):
        for missing in ('p7', 'p14'):
            with self.subTest(missing=missing):
                data, row, _ = self._read(**{missing: None})
                self.assertEqual(data['availabilityStatus'], 'PARTIAL')
                self.assertEqual(row['risk']['reasonCode'], 'FORECAST_HORIZON_UNAVAILABLE')
                self.assertIsNone(row['risk']['level'])
                self.assertIsNone(row['recommendation']['recommendedQty'])
                self.assertIsNone(row['forecast']['expected1d'])
                self.assertEqual(row['forecast']['source'], 'RIDGE_CAUSAL27')
                self.assertEqual(row['stock']['onHand'], 4)
                self.assertEqual(row['stock']['incoming'], 0)
                self.assertEqual(row['inventoryPolicy']['configuredMinimumStock'], 2)

    def test_unavailable_demand_variability_blocks_safety_stock_and_reorder(self):
        _, row, _ = self._read(history_days=13)
        self.assertEqual(row['demand']['observableDaysLast28'], 13)
        self.assertIsNone(row['risk']['level'])
        self.assertIsNone(row['inventoryPolicy']['safetyStock'])
        self.assertIsNone(row['inventoryPolicy']['reorderPoint'])
        self.assertIsNone(row['recommendation']['recommendedQty'])
        self.assertEqual(row['risk']['reasonCode'], 'INSUFFICIENT_FORECAST_INPUTS')
        self.assertEqual(row['coverage']['availabilityStatus'], 'AVAILABLE')

    def test_unavailable_lead_variability_blocks_safety_stock_and_reorder(self):
        for sigma in (None, -1, float('nan'), float('inf')):
            with self.subTest(sigma=sigma):
                _, row, _ = self._read(sigma_lead=sigma)
                self.assertIsNone(row['risk']['level'])
                self.assertIsNone(row['inventoryPolicy']['safetyStock'])
                self.assertIsNone(row['inventoryPolicy']['reorderPoint'])
                self.assertIsNone(row['recommendation']['recommendedQty'])
                self.assertEqual(row['risk']['reasonCode'], 'INSUFFICIENT_FORECAST_INPUTS')
                self.assertEqual(row['coverage']['availabilityStatus'], 'AVAILABLE')


if __name__ == "__main__":
    unittest.main()
