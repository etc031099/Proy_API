"""Offline certification only: canonical evidence and dataset preflight without fit."""
import hashlib
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ml.service import v3_bootstrap_evidence as evidence
from ml.service import v3_ridge_training as worker


class BootstrapEvidenceTests(unittest.TestCase):
    def test_exact_hash_and_policy_feature_contract(self):
        raw = evidence.EVIDENCE_PATH.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), evidence.EVIDENCE_HASH)
        data = json.loads(raw)
        self.assertEqual(raw, worker.canonical(data) + b"\n")
        self.assertEqual(data["promotionPolicyHash"], worker.live_ridge.PROMOTION_POLICY_HASH)
        self.assertEqual(data["featureHash"], worker.live_ridge.FEATURE_HASH)
        self.assertEqual(data["historicalDatasetSha256"], worker.v3_forecast.DATASET_SHA256)
        self.assertEqual(hashlib.sha256(worker.POLICY.read_bytes()).hexdigest(), evidence.POLICY_HASH)

    def test_original_experiment_projection_matches_without_retraining(self):
        original = worker.ROOT / "ml/.test-tmp/m610a22/final-results.json"
        if not original.is_file():
            self.skipTest("Local provenance audit source absent; not a runtime dependency")
        raw = original.read_bytes()
        source, pinned = json.loads(raw), json.loads(evidence.EVIDENCE_PATH.read_bytes())
        self.assertEqual(hashlib.sha256(raw).hexdigest(), pinned["sourceEvidenceHash"])
        self.assertTrue(source["complete"])
        self.assertIsNone(source["bestEligible"]["1"])
        for horizon in (7, 14):
            best = source["bestEligible"][str(horizon)]
            matches = [r for r in source["decisions"] if r["horizon"] == horizon
                       and r["candidate"] == best["candidate"] and r["phase"] == best["phase"]]
            self.assertEqual(len(matches), 1)
            selected = pinned["horizons"][str(horizon)]
            self.assertEqual({k: matches[0][k] for k in selected}, selected)

    def test_both_horizons_authorized_independently(self):
        for horizon in (7, 14):
            with self.subTest(horizon=horizon):
                row = worker._approved_evidence(horizon)
                self.assertEqual(row["candidate"], "RIDGE-CAUSAL27")
                self.assertEqual(row["horizon"], horizon)
                self.assertTrue(row["eligible"])
                self.assertTrue(all(row["checks"].values()))

    def test_one_day_excluded(self):
        with self.assertRaisesRegex(ValueError, "MODEL_NOT_APPROVED"):
            evidence.load_evidence(1)

    def test_modified_evidence_aborts(self):
        with patch.object(evidence, "EVIDENCE_PATH", SimpleNamespace(read_bytes=lambda: b"{}\n")):
            with self.assertRaisesRegex(ValueError, "BOOTSTRAP_EVIDENCE_HASH_MISMATCH"):
                evidence.load_evidence(7)

    def test_caller_cannot_choose_another_hash(self):
        with self.assertRaisesRegex(ValueError, "BOOTSTRAP_EVIDENCE_HASH_MISMATCH"):
            evidence.load_evidence(14, "b" * 64)

    def test_runtime_evidence_has_no_temporary_dependency(self):
        self.assertEqual(worker.EVIDENCE, evidence.EVIDENCE_PATH)
        self.assertEqual(worker.EVIDENCE.parent, Path(worker.__file__).parent)
        self.assertNotIn(".test-tmp", str(worker.EVIDENCE))

    def test_preflight_builds_real_canonical_rows_for_7_and_14_without_fit(self):
        # Canonical historical package plus an explicitly empty local test journal.
        # No Mongo, cloud, model fitting or prediction is performed.
        with patch.object(worker, "recipe", side_effect=AssertionError("dry-run must not fit")) as recipe:
            for horizon in (7, 14):
                with self.subTest(horizon=horizon):
                    result = worker.train({"businessId": worker.BUSINESS_ID,
                        "scenarioId": worker.v3_forecast.SCENARIO_ID, "horizonDays": horizon,
                        "inputDataVersion": "0", "observationsClosedThrough": "2026-10-12",
                        "journal": [], "mode": "bootstrap", "dryRun": True,
                        "expectedEvidenceHash": evidence.EVIDENCE_HASH})
                    self.assertEqual(result["status"], "FEASIBLE")
                    self.assertGreater(result["trainRows"], 0)
                    self.assertEqual(result["horizonDays"], horizon)
                    self.assertEqual(result["evidenceHash"], evidence.EVIDENCE_HASH)
                    latest = worker._day(result["latestMatureOrigin"])
                    self.assertEqual((worker._day(result["observationsClosedThrough"]) - latest).days, horizon)
                    self.assertNotIn("artifact", result)
            recipe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
