"""Controlled policy cases and parity with the frozen A.2.2 decisions; no research fits."""
import copy
import hashlib
import json
import sys
import time
import unittest
from unittest.mock import patch
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from ml.service import v3_ridge_policy as p
from ml.service import v3_ridge_training as trainer


def case_folds(kind="PASS"):
    folds = []
    start = date(2026, 10, 12)
    for split, length in zip(("F2", "F3", "VALIDATION"), p.FOLD_LENGTHS):
        samples = []
        for offset in range(length):
            for sku in range(10):
                error = 1.0
                sign = 1 if (offset + sku) % 2 else -1
                if kind == "WAPE": error = 3.0
                if kind == "BIAS": error, sign = 1.5, 1
                if kind == "CATEGORY" and sku < 2: error = 2.3
                if kind == "PRIORITY" and sku < 3: error = 2.6
                if kind == "CATASTROPHIC" and sku == 0: error, sign = 16.0, 1
                if kind == "LATEST" and split == "VALIDATION": error = 2.1
                if kind == "MEDIAN": error = 2.1 if sku < 6 else 0.0
                actual = 0.0 if kind == 'ZERO_VOLUME' else 10.0
                samples.append({"sku": f"SKU-{sku:02}", "origin": (start + timedelta(days=offset)).isoformat(),
                                "category": f"C{sku // 2}", "segment": f"S{sku // 2}",
                                "actual": actual, "prediction": 0.0 if kind == 'ZERO_VOLUME' else max(0.0, 10 + sign * error),
                                "baseline": 0.0 if kind == 'ZERO_VOLUME' else 12.0,
                                "observedUnits": 0 if kind in ("SUPPORT", "ZERO_VOLUME") else 10})
        folds.append(p.fold_from_samples(split, samples, [f"SKU-{sku:02}" for sku in range(10)]))
        start += timedelta(days=length)
    return folds


def case_results():
    result = {name: p.evaluate_policy(case_folds(name), 7) for name in
              ("PASS", "WAPE", "BIAS", "CATEGORY", "PRIORITY", "CATASTROPHIC", "SUPPORT", "LATEST", "MEDIAN", "ZERO_VOLUME")}
    result['PASS14'] = p.evaluate_policy(case_folds(), 14)
    for name, decision in result.items():
        decision['protocol'] = p.temporal_protocol(date(2027, 2, 28), 14 if name == 'PASS14' else 7)
    return result


class PromotionPolicyTests(unittest.TestCase):
    def test_exact_policy_hash(self):
        self.assertEqual(hashlib.sha256(p.POLICY_PATH.read_bytes()).hexdigest(), p.POLICY_HASH)
        self.assertEqual(p.load_policy()["id"], p.POLICY_VERSION)

    def test_107_origin_protocol_and_strict_label_maturity(self):
        for horizon in (7, 14):
            closed = p.CUTOFF + timedelta(days=106 + horizon)
            protocol = p.temporal_protocol(closed, horizon)
            self.assertEqual(protocol["status"], "READY")
            self.assertEqual([f["origins"] for f in protocol["folds"]], [31, 30, 46])
            self.assertEqual(protocol["folds"][0]["startOrigin"], p.CUTOFF.isoformat())
            for cut in protocol["folds"]:
                train_origin = date.fromisoformat(cut["trainLatestOrigin"])
                self.assertLess(train_origin + timedelta(days=horizon), date.fromisoformat(cut["startOrigin"]))
            self.assertEqual(p.temporal_protocol(closed - timedelta(days=1), horizon)["status"],
                             "INSUFFICIENT_EVALUATION_HISTORY")

    def test_insufficient_history_never_loads_data_or_fits_candidate(self):
        with patch.object(trainer.v3_forecast, 'load_validated_dataset', side_effect=AssertionError('no fit')):
            result = trainer.train({'businessId': trainer.BUSINESS_ID, 'scenarioId': trainer.v3_forecast.SCENARIO_ID,
                                    'horizonDays': 7, 'inputDataVersion': '0', 'observationsClosedThrough': '2026-10-15',
                                    'journal': [], 'mode': 'automatic'})
        self.assertEqual(result['evaluationStatus'], 'INSUFFICIENT_EVALUATION_HISTORY')
        self.assertIsNone(result['artifact'])

    def test_frozen_a22_reference_checks_match_exactly_without_fit(self):
        reference = json.loads(Path(__file__).with_name("fixtures").joinpath("ridge_policy_v1_reference.json").read_text())
        for horizon, item in reference.items():
            actual = p.evaluate_policy(item["folds"], int(horizon))
            self.assertEqual(actual["checks"], item["expected"]["checks"])
            for key in ("mae", "wape", "normalized_bias"):
                self.assertAlmostEqual(actual["model"][key], item["expected"]["model"][key], places=13)
            self.assertAlmostEqual(actual["macroMae"], item["expected"]["macroMae"], places=13)

    def test_clear_pass_and_determinism(self):
        folds = case_folds()
        begin = time.perf_counter()
        first = p.evaluate_policy(folds, 7)
        print(json.dumps({"policyEvaluationMs": round((time.perf_counter() - begin) * 1000, 3)}))
        self.assertEqual(first["status"], "PASS")
        self.assertEqual(first, p.evaluate_policy(list(reversed(case_folds())), 7))

    def test_global_wape_bias_and_macro(self):
        answer = p.evaluate_policy(case_folds(), 7)
        self.assertAlmostEqual(answer["model"]["wape"], .1)
        self.assertAlmostEqual(answer["macroMae"], 1.0)
        self.assertFalse(p.evaluate_policy(case_folds("WAPE"), 7)["globalChecks"]["G1_POOLED_WAPE_5PCT"])
        self.assertFalse(p.evaluate_policy(case_folds("BIAS"), 7)["globalChecks"]["G2_POOLED_BIAS_10PCT"])

    def test_multi_fold_two_wins_do_not_override_latest_veto(self):
        result = p.evaluate_policy(case_folds("LATEST"), 7)
        self.assertTrue(result["foldChecks"]["G4_AT_LEAST_2_POSITIVE_FOLDS"])
        self.assertFalse(result["foldChecks"]["G8_LATEST_NONINFERIOR"])

    def test_category_and_segment_group_and_volume_denominators(self):
        result = p.evaluate_policy(case_folds("CATEGORY"), 7)
        self.assertEqual(result["categoryChecks"]["countCoverage"], .8)
        self.assertEqual(result["categoryChecks"]["targetVolumeCoverage"], .8)
        self.assertTrue(result["checks"]["S_GROUP_COVERAGE:category"])
        self.assertFalse(result["checks"]["S_VOLUME_COVERAGE:category"])
        self.assertFalse(result["checks"]["S_VOLUME_COVERAGE:segment"])

    def test_priority_80_percent_and_nonpositive_median(self):
        self.assertFalse(p.evaluate_policy(case_folds("PRIORITY"), 7)["checks"]["P_80PCT_COVERAGE"])
        self.assertFalse(p.evaluate_policy(case_folds("MEDIAN"), 7)["checks"]["P_MEDIAN_NO_DEGRADATION"])

    def test_catastrophic_veto_and_no_free_low_support_pass(self):
        self.assertTrue(p.evaluate_policy(case_folds("CATASTROPHIC"), 7)["catastrophicVeto"])
        result = p.evaluate_policy(case_folds("SUPPORT"), 7)
        self.assertEqual(result["status"], "REJECTED")
        self.assertEqual(result["categoryChecks"]["countCoverage"], 0)
        self.assertTrue(all(not x["support"]["sufficient"] for x in result["prioritySkuChecks"]["items"]))

    def test_exact_support_floor_and_zero_volume(self):
        folds = case_folds()
        for kind in ('category', 'segment', 'sku'):
            for key in folds[0]['support'][kind]:
                for i, fold in enumerate(folds):
                    fold['support'][kind][key] = {'origins': (9, 9, 10)[i], 'uniqueDayUnits': (6, 6, 8)[i]}
        result = p.evaluate_policy(folds, 7)
        self.assertTrue(all(x['support']['sufficient'] for x in result['prioritySkuChecks']['items']))
        folds[0]['support']['sku']['SKU-00']['uniqueDayUnits'] -= 1
        self.assertFalse(p.evaluate_policy(folds, 7)['prioritySkuChecks']['items'][0]['support']['sufficient'])
        zero = p.evaluate_policy(case_folds('ZERO_VOLUME'), 7)
        self.assertEqual(zero['status'], 'REJECTED')
        self.assertIsNone(zero['model']['wape'])
        self.assertIsNone(zero['model']['normalized_bias'])

    def test_pooled_errors_not_average_fold_ratios(self):
        pooled = p.pool([p.metric_bundle([10], [12]), p.metric_bundle([100], [110])])
        self.assertAlmostEqual(pooled["wape"], 12 / 110)
        self.assertAlmostEqual(pooled["normalized_bias"], 12 / 110)

    def test_missing_row_never_changes_baseline_universe_silently(self):
        samples = [{"sku": "A", "origin": "2026-10-12", "actual": 1, "prediction": 1,
                    "baseline": 1, "category": "A", "segment": "S", "observedUnits": 1},
                   {"sku": "B", "origin": "2026-10-13", "actual": 1, "prediction": 1,
                    "baseline": 1, "category": "A", "segment": "S", "observedUnits": 1}]
        with self.assertRaises(p.PolicyError): p.fold_from_samples("F2", samples, ["A"])

    def test_causal_temporal_fits_and_train_only_priority(self):
        protocol = p.temporal_protocol(p.CUTOFF + timedelta(days=113), 7)
        first = p.CUTOFF - timedelta(days=40)
        last = date.fromisoformat(protocol["latestMatureOrigin"])
        origins, rows, labels = [], [], []
        for offset in range((last - first).days + 1):
            origin = first + timedelta(days=offset)
            for sku in ("A", "B"):
                origins.append(origin)
                rows.append({"sku": sku, "categoryCode": "CAT", "rollingMean_28": 10 / 7,
                             "originOrdinal": origin.toordinal()})
                labels.append(10.0)
        frame = pd.DataFrame(rows)
        fitted = []
        class Predictor:
            def fit(self, x, y):
                fitted.append(max(x.originOrdinal))
                return self
            def predict(self, x): return np.full(len(x), 10.0)
        future = (last + timedelta(days=100)).isoformat()
        revenue = [(first.isoformat(), "A", 100), (first.isoformat(), "B", 1), (future, "B", 1000000)]
        answer = trainer.evaluate_temporal(frame, labels, origins, 7, protocol, lambda sku, day: 2,
                                           revenue, estimator_factory=Predictor)
        self.assertEqual(len(fitted), 3)
        for maximum, fold in zip(fitted, answer["folds"]):
            self.assertLess(date.fromordinal(maximum) + timedelta(days=7),
                            date.fromisoformat(fold["temporalBoundary"]["startOrigin"]))
            self.assertEqual(fold["top10"][0], "A")
            self.assertEqual(fold["baseline"]["overall"]["mae"], 0)


if __name__ == "__main__":
    if "--emit-cases" in sys.argv:
        print(json.dumps(case_results(), allow_nan=False, separators=(",", ":")))
    else:
        unittest.main()
