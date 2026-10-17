"""Offline attributable comparison through the real Inventory adapter/formulas."""
import copy
import unittest
from unittest.mock import patch

from ml.service import v3_inventory_model_impact as driver
from ml.service.v3_live_inventory_supplier import m66
from ml.tests import test_m6_10a361_inventory_health_ridge as inventory_fixture


class InventoryImpactTests(unittest.TestCase):
    def fixture(self, old=(17.5, 42.25), new=(28, 56), stock=10, **kwargs):
        adapter, live, request, _, _ = inventory_fixture.LiveInventoryRealLeadTimeTests()._fixture(**kwargs)
        live.stock_for = lambda **_kw: stock
        prediction = {'idempotencyKey': 'a' * 64, 'snapshot': {'products': [
            {'sku': sku, 'productName': 'Fixture'} for sku in request.skus],
            'snapshotHash': 'b' * 64, 'dataVersion': 'fixture', 'asOf': '2026-10-12',
            'observationsClosedThrough': '2026-10-11'},
            'versions': [{'horizonDays': h, 'beforeVersion': 1, 'afterVersion': 2} for h in (7, 14)],
            'detail': [{'sku': sku, 'p7': {'old': old[0], 'new': new[0]},
                'p14': {'old': old[1], 'new': new[1]}} for sku in request.skus]}
        return adapter, live, prediction

    def test_identical_context_and_non_forecast_inputs_both_sides(self):
        adapter, live, prediction = self.fixture(product_count=2)
        from types import SimpleNamespace
        from datetime import datetime, timezone
        live.snapshot.purchases = [SimpleNamespace(purchaseKey='PENDING', status='pending', receiptEvidence='NONE',
            supplierKey='S1', promisedAtUtc=datetime(2026, 10, 15, tzinfo=timezone.utc),
            lines=[SimpleNamespace(lineKey='PENDING-1', quantityOrdered=3, sku='SKU-1', productKey='P1')])]
        original = copy.deepcopy(prediction)
        calls = []
        actual = m66.evaluate_sku
        def evaluate(*args, **kwargs):
            calls.append(copy.deepcopy(kwargs))
            return actual(*args, **kwargs)
        with patch.object(m66, 'evaluate_sku', side_effect=evaluate), \
                patch.object(adapter, 'inventory_data', wraps=adapter.inventory_data) as inventory:
            output = driver.compare_inventory(adapter, live, prediction)
        self.assertEqual(prediction, original)
        self.assertEqual(len(calls), 4)  # two SKU, before/after; rank reuses canonical cache
        for i in (0, 1):
            before, after = calls[i], calls[i + 2]
            differing = {k for k in before if before[k] != after[k]}
            self.assertTrue(differing)
            self.assertEqual(differing, {'forecast'})
            forecast_differences = {k for k in before['forecast'] if before['forecast'][k] != after['forecast'][k]}
            self.assertTrue(forecast_differences <= {'expectedUnitsNext7d', 'expectedUnitsNext14d',
                'modelVersion7', 'modelVersion14'}, forecast_differences)
        self.assertEqual(calls[0]['on_hand'], 10)
        self.assertEqual(calls[0]['incoming_orders'][0]['units'], 3)
        self.assertEqual(calls[0]['lead_time_days'], 6.28)
        self.assertEqual(calls[0]['lead_time_std_days'], 1.0)
        self.assertEqual(len(calls[0]['daily_rows']), 28)
        for call in inventory.call_args_list:
            self.assertIs(call.args[1], live)
            self.assertEqual(call.args[0].skus, ['SKU-1', 'SKU-2'])
            self.assertEqual(call.args[1].data_version, 'fixture')
            for forecast in call.args[2]:
                self.assertIsNone(forecast['expectedUnitsNext1d'])
                self.assertNotIn('MA28', str(forecast))
        self.assertEqual(output['skuUniverse'], ['SKU-1', 'SKU-2'])
        self.assertEqual(output['ranking']['before'], output['ranking']['after'])

    def test_exact_canonical_values_not_reimplemented(self):
        adapter, live, prediction = self.fixture()
        output = driver.compare_inventory(adapter, live, prediction)
        for side, field in [('before', 'old'), ('after', 'new')]:
            p = prediction['detail'][0]
            forecasts = [{'sku': 'SKU-1', 'horizon7Status': 'READY', 'horizon14Status': 'READY',
                'expectedUnitsNext1d': None, 'expectedUnitsNext7d': p['p7'][field],
                'expectedUnitsNext14d': p['p14'][field], 'modelVersion7': 1, 'modelVersion14': 1,
                'cutoffDate': '2026-10-11', 'status': 'READY'}]
            from types import SimpleNamespace
            request = SimpleNamespace(mode='detail', skus=['SKU-1'], limit=1, offset=0,
                risk=None, abc=None, xyz=None, flag=None, metric='stockout_risk')
            canonical, _ = adapter.inventory_data(request, live, forecasts)
            c, actual = canonical['items'][0], output[side][0]
            self.assertEqual(actual['risk'], c['risk']['level'])
            self.assertEqual(actual['shouldReorder'], c['recommendation']['shouldReorder'])
            self.assertEqual(actual['recommendedQty'], c['recommendation']['recommendedQty'])
            self.assertEqual(actual['reorderPoint'], c['inventoryPolicy']['reorderPoint'])
            self.assertEqual(actual['daysCover'], c['coverage']['daysCover'])
            self.assertAlmostEqual(c['demand']['expectedDaily'], (p['p7'][field] / 7 + p['p14'][field] / 14) / 2)

    def test_reorder_both_directions_and_positive_target_gap_without_immediate_reorder(self):
        adapter, live, prediction = self.fixture(old=(7, 14), new=(70, 140), stock=15)
        output = driver.compare_inventory(adapter, live, prediction)
        self.assertFalse(output['before'][0]['shouldReorder'])
        self.assertTrue(output['after'][0]['shouldReorder'])
        self.assertGreater(output['before'][0]['recommendedQty'], 0)
        self.assertNotEqual(output['before'][0]['risk'], output['after'][0]['risk'])
        adapter, live, prediction = self.fixture(old=(70, 140), new=(7, 14), stock=15)
        output = driver.compare_inventory(adapter, live, prediction)
        self.assertTrue(output['before'][0]['shouldReorder'])
        self.assertFalse(output['after'][0]['shouldReorder'])

    def test_unchanged_forecasts_have_identical_inventory_and_ranking(self):
        adapter, live, prediction = self.fixture(new=(17.5, 42.25), product_count=3)
        output = driver.compare_inventory(adapter, live, prediction)
        self.assertEqual(output['before'], output['after'])
        self.assertEqual(output['ranking']['before'], output['ranking']['after'])

    def test_missing_forecast_preserves_null_not_low_and_canonical_rank_exclusion(self):
        for old in [(None, 42.25), (17.5, None), (None, None)]:
            with self.subTest(old=old):
                adapter, live, prediction = self.fixture(old=old)
                output = driver.compare_inventory(adapter, live, prediction)
                before = output['before'][0]
                self.assertIsNone(before['risk']); self.assertIsNone(before['recommendedQty'])
                self.assertIsNone(before['shouldReorder']); self.assertIsNone(before['reorderPoint'])
                self.assertEqual(before['availability'], 'PARTIAL')
                self.assertIn('FORECAST_HORIZON_UNAVAILABLE', before['reasonCodes'])
                self.assertEqual(output['ranking']['before'], [])
                self.assertEqual(output['ranking']['after'], ['SKU-1'])

    def test_lead_time_variability_and_history_contracts_unchanged(self):
        for config, reason in [({'lead': 15}, 'LEAD_TIME_BEYOND_APPROVED_HORIZON'),
            ({'lead': None}, 'MISSING_LEAD_TIME'), ({'sigma_lead': None}, 'INSUFFICIENT_FORECAST_INPUTS'),
            ({'history_days': 13}, 'INSUFFICIENT_FORECAST_INPUTS')]:
            with self.subTest(config=config):
                adapter, live, prediction = self.fixture(**config)
                output = driver.compare_inventory(adapter, live, prediction)
                for side in ('before', 'after'):
                    row = output[side][0]
                    self.assertIsNone(row['risk']); self.assertIsNone(row['recommendedQty'])
                    self.assertIn(reason, row['reasonCodes'])
                    self.assertEqual(row['availability'], 'PARTIAL')
        for lead in (7, 14, 6.28):
            adapter, live, prediction = self.fixture(lead=lead)
            output = driver.compare_inventory(adapter, live, prediction)
            self.assertEqual(output['before'][0]['availability'], 'AVAILABLE')
            self.assertEqual(output['after'][0]['availability'], 'AVAILABLE')

    def test_duplicate_or_changed_universe_rejected(self):
        adapter, live, prediction = self.fixture(product_count=2)
        prediction['detail'][1]['sku'] = 'SKU-1'
        with self.assertRaises(ValueError):
            driver.compare_inventory(adapter, live, prediction)

    def test_ranking_changes_use_canonical_order_not_an_invented_position(self):
        adapter, live, prediction = self.fixture(old=(7, 14), new=(70, 140), stock=15, product_count=2)
        prediction['detail'][1]['p7'] = {'old': 70, 'new': 7}
        prediction['detail'][1]['p14'] = {'old': 140, 'new': 14}
        output = driver.compare_inventory(adapter, live, prediction)
        self.assertEqual(output['ranking']['before'], ['SKU-2', 'SKU-1'])
        self.assertEqual(output['ranking']['after'], ['SKU-1', 'SKU-2'])

    def test_full_driver_on_local_validated_sources_without_models_or_cloud(self):
        from pathlib import Path
        from ml.service.v3_ridge_prediction_impact import load_validated_dataset, load_local_sources
        from ml.tests.test_m6_9f3_live_context import empty_snapshot, signed_snapshot
        root = Path(__file__).resolve().parents[2]
        dataset = load_validated_dataset(root)
        records = load_local_sources(root, dataset=dataset)
        raw = empty_snapshot()
        for key in ('catalogChanges', 'sales', 'purchases', 'transactionChanges', 'closedSalesDays'):
            raw[key] = []
        raw['stockStates'] = [{'productKey': p['productKey'], 'sku': p['sku'], 'onHand': 15,
            'stockBasis': 'MONGO_LEDGER'} for p in records['products']]
        raw['closedSalesDays'] = [{'productKey': p['productKey'], 'localDate': '2026-10-13', 'unitsSold': 0,
            'completeness': 'COMPLETE', 'availability': 'UNKNOWN', 'availableHours': None,
            'onHandUsableAtOrigin': None} for p in records['products']]
        raw['metadata']['counts'] = {key: len(raw[key]) for key in raw['metadata']['counts']}
        raw['metadata']['costCoverage'] = {'knownSaleLines': 0, 'unknownSaleLines': 0}
        raw['metadata']['dataThroughUtc'] = None
        snapshot = signed_snapshot(raw).model_dump(mode='json', by_alias=True)
        m = snapshot['metadata']
        products = [{'sku': p['sku'], 'productName': None} for p in records['products']]
        prediction = {'idempotencyKey': 'a' * 64, 'snapshot': {**{key: m[key] for key in
            ('businessId','scenarioId','dataVersion','capturedAtUtc','observationsClosedThrough','snapshotHash')},
            'asOf': m['asOfDate'], 'products': products},
            'versions': [{'horizonDays': h, 'beforeVersion': 1, 'afterVersion': 2} for h in (7, 14)],
            'detail': [{'sku': p['sku'], 'p7': {'old': 7, 'new': 14},
                'p14': {'old': 14, 'new': 28}} for p in products]}
        output = driver.evaluate({'snapshot': snapshot, 'prediction': prediction})
        self.assertEqual(len(output['before']), len(products))
        self.assertEqual(len(output['after']), len(products))
        self.assertEqual(output['snapshotHash'], m['snapshotHash'])
        self.assertEqual(output['dataVersion'], m['dataVersion'])


if __name__ == '__main__':
    unittest.main()
