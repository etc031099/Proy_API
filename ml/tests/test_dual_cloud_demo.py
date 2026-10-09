import copy
import json
import unittest
from collections import Counter
from datetime import timedelta
from ml.service.model_runtime import ModelRuntime, InvalidContextError
from ml.service.schemas import PredictionRequest
from ml.src.common import repository_path, sha256_file
from ml.src.scenario.cloud_demo_v2 import CONFIG
from ml.src.scenario.cloud_demo_v2_minimal import OUTPUT, REPORT, make_package, validate_package
from ml.src.scenario.config import load_scenario_config
from ml.src.serving.scenarios import SCENARIOS, validate_lineage


class DualServingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = ModelRuntime()
        cls.runtime.load()

    def test_registry_is_closed_and_model_shared(self):
        self.assertEqual(set(SCENARIOS), {'v1', 'v2'})
        self.assertEqual(SCENARIOS['v1']['modelSha256'], SCENARIOS['v2']['modelSha256'])
        self.assertIs(self.runtime.builder, self.runtime.builders['v1'])

    def test_context_pairs_and_anchors_are_not_interchangeable(self):
        def request(business, scenario, anchor):
            return PredictionRequest.model_validate({'requestId': 'dual-test', 'context': {
                'businessId': business, 'scenarioId': scenario, 'anchorStrategy': 'latest_eligible_historical_anchor',
                'anchorOperationalDate': anchor, 'timezone': 'UTC'}, 'items': [{'productId': 'one',
                    'sku': 'M5-FOODS_1_033', 'historyCoverage': {'start': anchor, 'end': anchor, 'complete': True},
                    'dailySales': [{'date': anchor, 'unitsSold': 1}]}]})
        for entry in SCENARIOS.values():
            valid = request(entry['businessId'], entry['scenarioId'], entry['anchorOperationalDate'])
            self.assertEqual(self.runtime.validate_context(valid).manifest['scenario_id'], entry['scenarioId'])
        for business, scenario, anchor in [
            ('OTHER', SCENARIOS['v1']['scenarioId'], '2025-07-01'),
            ('ML-CLOUD-DEMO', 'unknown', '2025-07-01'),
            ('ML-CLOUD-DEMO', SCENARIOS['v2']['scenarioId'], '2026-05-17'),
            ('ML-CLOUD-DEMO-V2', SCENARIOS['v1']['scenarioId'], '2025-07-01'),
            ('ML-CLOUD-DEMO-V2', SCENARIOS['v2']['scenarioId'], '2025-07-01')]:
            with self.assertRaises(InvalidContextError):
                self.runtime.validate_context(request(business, scenario, anchor))

    def test_wrong_lineage_fields_rejected(self):
        builder = copy.copy(self.runtime.builders['v2'])
        for key in ['business_id', 'scenario_id', 'source_anchor', 'operational_anchor',
                    'date_offset_days', 'products_count', 'store_id', 'lineage_version']:
            builder.manifest = {**self.runtime.builders['v2'].manifest, key: 'wrong'}
            with self.assertRaises(ValueError):
                validate_lineage(builder, SCENARIOS['v2'])


class MinimalPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = load_scenario_config(CONFIG)
        if any(not path.is_file() for path in (cls.config.output, repository_path(OUTPUT),
                repository_path('ml/data/gold/demand_features_v1.parquet'))):
            raise unittest.SkipTest('Full/minimal v2 or Gold local datasets unavailable; no automatic generation')
        cls.full = [json.loads(line) for line in cls.config.output.read_text(encoding='utf-8').splitlines()]
        cls.package = [json.loads(line) for line in repository_path(OUTPUT).read_text(encoding='utf-8').splitlines()]
        cls.manifest = json.loads(cls.config.manifest.read_text(encoding='utf-8'))
        cls.report = json.loads(repository_path(REPORT).read_text(encoding='utf-8'))

    def test_minimal_package_stock_credit_features_and_forecast_equivalence(self):
        result = validate_package(self.full, self.package, self.report['audit'], self.manifest['products'], self.config)
        self.assertEqual(result['parity']['ready'], 60)
        self.assertEqual(result['parity']['comparisons'], 1860)
        self.assertEqual(result['parity']['differences'], 0)
        self.assertTrue(result['closingCreditEquivalent'])
        self.assertTrue(result['closingStockEquivalent'])
        self.assertEqual(result['openingStockTotal'], 1073)
        self.assertEqual(result['counts']['sales'] + result['counts']['purchases'], 6703)
        self.assertEqual(result['supplierCoverage'], {'zero': 0, 'one': 17, 'multiple': 43})
        self.assertTrue(all(r['orphanReferences'] == r['crossTenantReferences'] == 0 for r in result['quality']))
        self.assertEqual(sha256_file(repository_path(OUTPUT)), self.report['packageSha256'])
        for row in result['inventoryReconciliation']:
            self.assertEqual(row['openingStock'] + row['purchasedUnits'] - row['soldUnits'] + row['reversedUnits'], row['stockAtAnchor'], row['sku'])

    def test_reproducible_projection_and_reject_tampered_tenant_stock_supplier_payment(self):
        package, audit = make_package(self.full, self.manifest['products'], self.config)
        self.assertEqual(package, self.package)
        self.assertEqual(audit, self.report['audit'])
        cases = [('businessId', 'OTHER'), ('scenarioId', 'unknown'), ('occurredAt', '2026-05-18T00:00:00Z')]
        for field, value in cases:
            bad = copy.deepcopy(package)
            bad[0][field] = value
            with self.assertRaises(ValueError):
                validate_package(self.full, bad, audit, self.manifest['products'], self.config)
        for kind, field, value in [('product.created', 'stock', 999), ('product.created', 'preferredSupplierId', 'orphan'),
                                   ('credit-payment.created', 'amount', 999999)]:
            bad = copy.deepcopy(package)
            next(e for e in bad if e['eventType'] == kind)['payload'][field] = value
            with self.assertRaises(ValueError):
                validate_package(self.full, bad, audit, self.manifest['products'], self.config)

    def test_dual_runtime_v2_batch_is_sixty_ready_without_switching_v1(self):
        runtime = ModelRuntime()
        runtime.load()
        selected = self.manifest['products']
        totals = {row['productId']: Counter() for row in selected}
        cancelled = {e['payload']['transactionId'] for e in self.package if e['eventType'] == 'transaction.cancelled'}
        for event in self.package:
            p = event['payload']
            if event['eventType'] == 'transaction.completed' and p['type'] == 'sale' and p['_id'] not in cancelled:
                for line in p['products']:
                    totals[line['productId']][event['occurredAt'][:10]] += line['quantity']
        items = []
        for row in selected:
            days = (self.config.operational_end - self.config.operational_start).days + 1
            history = [{'date': (self.config.operational_start + timedelta(days=i)).isoformat(),
                        'unitsSold': totals[row['productId']][(self.config.operational_start + timedelta(days=i)).isoformat()]} for i in range(days)]
            items.append({'productId': row['productId'], 'sku': 'M5-' + row['item_id'],
                'dailySales': history, 'historyCoverage': {'start': '2025-11-02', 'end': '2026-05-17', 'complete': True}})
        request = PredictionRequest.model_validate({'requestId': 'v2-minimal', 'context': {
            'businessId': 'ML-CLOUD-DEMO-V2', 'scenarioId': self.config.scenario_id,
            'anchorOperationalDate': '2026-05-17', 'anchorStrategy': 'latest_eligible_historical_anchor', 'timezone': 'UTC'}, 'items': items})
        result = runtime.predict_batch(request)
        self.assertEqual(result.ready_count, 60)
        self.assertEqual(runtime.builder.manifest['scenario_id'], SCENARIOS['v1']['scenarioId'])
        for row, prediction in zip(selected, result.results):
            self.assertAlmostEqual(row['predictedDemand7d'], prediction.predictedDemand7d, places=5)


if __name__ == '__main__':
    unittest.main()
