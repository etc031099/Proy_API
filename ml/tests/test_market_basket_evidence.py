from __future__ import annotations

import copy
import hashlib
import json
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ml.service.market_basket_evidence import rule_evidence
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime


class FrozenBasketEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = Path(__file__).resolve().parents[1] / 'data/minimarket-pasco-v3-market-basket-v1.json'
        cls.artifact = json.loads(cls.path.read_text(encoding='utf-8'))

    def test_all_18_served_rules_have_integer_counts_from_existing_itemsets(self):
        artifact = self.artifact
        rules = [r for r in artifact['rules'] if r['classification'] == 'CROSS_SELL' and r['stability']['status'] == 'STABLE']
        self.assertEqual(len(rules), 18)
        for rule in rules:
            result = rule_evidence(artifact, rule)
            n, a, b, j = [result[key] for key in ('totalTickets', 'antecedentCount', 'consequentCount', 'jointCount')]
            self.assertEqual(n, 12647)
            self.assertEqual(len(rule['antecedentSkus']), 1)
            self.assertEqual(len(rule['consequentSkus']), 1)
            self.assertEqual(j, rule['ticketCount'])
            self.assertAlmostEqual(rule['support'], j / n)
            self.assertAlmostEqual(rule['confidence'], j / a)
            self.assertAlmostEqual(rule['lift'], j * n / (a * b))
            if j == 113:
                self.assertEqual((a, b), (596, 2030))

    def test_counts_do_not_come_from_rounded_supports_and_invalid_counts_fail_closed(self):
        rule = copy.deepcopy(self.artifact['rules'][0])
        expected = rule_evidence(self.artifact, rule)
        rule['antecedentSupport'] = 0.16
        rule['consequentSupport'] = 0.16
        self.assertEqual(rule_evidence(self.artifact, rule)['antecedentCount'], expected['antecedentCount'])
        rule['ticketCount'] += 1
        with self.assertRaises(ValueError):
            rule_evidence(self.artifact, rule)

    def test_serving_preserves_order_metrics_identity_and_artifact_without_mining(self):
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        runtime = V3IntelligenceRuntime()
        runtime.basket = self.artifact
        expected = [r for r in self.artifact['rules'] if r['classification'] == 'CROSS_SELL' and r['stability']['status'] == 'STABLE']
        with patch.object(runtime, 'resolve_context', return_value=date(2026, 10, 12)):
            request = SimpleNamespace(context=None, mode='rules', sku=None, categoryCode=None, offset=0, limit=20)
            data, _ = runtime.cross_sell_data(request)
            self.assertEqual(data['total'], 18)
            for row, original in zip(data['items'], expected):
                self.assertEqual({key: row[key] for key in original}, original)
            request.mode = 'summary'
            summary, _ = runtime.cross_sell_data(request)
            self.assertEqual(summary['summary']['artifactIdentity'], self.artifact['reproducibilitySha256'])
            self.assertEqual(summary['summary']['analysisVersion'], self.artifact['analysisVersion'])
        self.assertEqual(before, hashlib.sha256(self.path.read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
