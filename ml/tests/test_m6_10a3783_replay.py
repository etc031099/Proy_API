"""Offline contract tests. Fits use four SKUs; no database/cloud/worker runs."""
import copy
import socket
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import numpy as np

from ml.replay import artifacts, policy, runner
from ml.replay.dataset import ReplayDataset, empty_evidence, load_source
from ml.replay.generator import Generator
from ml.replay.run_store import RunStore
from ml.service import v3_ridge_training as trainer, v3_ridge_policy as numerical
from ml.service.v3_live_ridge import FEATURE_ORDER, load_verified_ridge_artifact, LiveRidgeError


class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = load_source(Path(__file__).resolve().parents[2])
        cls.source = copy.copy(source)
        skus = sorted(source.product_by_sku)[:4]
        cls.source.products = [p for p in source.products if p["sku"] in skus]
        cls.source.product_by_sku = {p["sku"]: p for p in cls.source.products}
        cls.source.inventory = {s: source.inventory[s] for s in skus}
        cls.temp_root = Path(__file__).resolve().parents[1] / ".test-tmp"
        cls.temp_root.mkdir(exist_ok=True)

    def test_feature_contract_and_scope(self):
        view = ReplayDataset(self.source, empty_evidence())
        row = view.features(view.skus[0], policy.BASELINE_CLOSED, 7)
        self.assertEqual(tuple(row), FEATURE_ORDER)
        self.assertEqual(len(row), 27)
        self.assertFalse(set(row) & {"priceAtOriginCents", "knownPromoDays", "stockoutFlag", "unitsDemandedSynthetic"})
        with self.assertRaises(ValueError):
            view.features(view.skus[0], policy.BASELINE_CLOSED, 1)
        with self.assertRaises(ValueError):
            view.units(view.skus[0], policy.BASELINE_CLOSED + timedelta(days=1))

    def test_seed_profiles_reproducible_and_evidence_append_only(self):
        source_hash = trainer.digest(self.source.inventory)
        a, b, shifted = empty_evidence(), empty_evidence(), empty_evidence()
        ga, gb, gs = (Generator(self.source, 2026, p) for p in ("STABLE", "STABLE", "SHIFT"))
        view = ReplayDataset(self.source, a)
        identity = id(view.dataset.inventory)
        for i, level in enumerate(policy.LEVELS):
            prior = copy.deepcopy(a["operations"])
            ga.append(a, level)
            gb.append(b, level)
            gs.append(shifted, level)
            view.apply(a)
            self.assertEqual(id(view.dataset.inventory), identity)
            self.assertEqual(a, b)
            self.assertEqual(a["operations"][:len(prior)], prior)
            if i < 3:
                self.assertEqual(len(a["operations"]), (1, 8, 22)[i])
            if i >= 3:
                self.assertEqual(len(a["completeDays"]), (7, 21, 51, 121)[i - 3])
        self.assertNotEqual(a, shifted)
        self.assertEqual(trainer.digest(self.source.inventory), source_hash)
        self.assertTrue(all(row["endingStock"] >= 0 for rows in view.dataset.inventory.values() for row in rows.values()))
        bad = copy.deepcopy(a)
        bad["operations"][0]["quantity"] += 1
        with self.assertRaisesRegex(ValueError, "APPEND_ONLY"):
            view.apply(bad)

    def test_plus_one_changes_inference_one_sku_and_only_one_mature_label_per_horizon(self):
        evidence = empty_evidence()
        view = ReplayDataset(self.source, evidence)
        prior = {h: view.examples(h) for h in (7, 14)}
        probe = {h: view.probe(h) for h in (7, 14)}
        Generator(self.source, 2026, "STABLE").append(evidence, policy.LEVELS[0])
        self.assertEqual(len(evidence["operations"]), 1)
        self.assertEqual(evidence["operations"][0]["quantity"], 1)
        view.apply(evidence)
        for h in (7, 14):
            frame, labels, _ = view.examples(h)
            self.assertEqual(frame.to_dict("records"), prior[h][0].to_dict("records"))
            self.assertEqual(int(np.count_nonzero(labels - prior[h][1])), 1)
            self.assertEqual(sum(a != b for a, b in zip(probe[h], view.probe(h))), 1)

    def test_future_source_rows_cannot_enter_prefix_or_generator(self):
        other = copy.copy(self.source)
        other.inventory = copy.deepcopy(self.source.inventory)
        for rows in other.inventory.values():
            for day, row in rows.items():
                if day > policy.BASELINE_CLOSED.isoformat():
                    row["unitsSold"] = 999999
        a, b = ReplayDataset(self.source, empty_evidence()), ReplayDataset(other, empty_evidence())
        self.assertEqual(a.hash, b.hash)
        self.assertEqual(a.probe(7), b.probe(7))
        ea, eb = empty_evidence(), empty_evidence()
        for level in policy.LEVELS:
            Generator(self.source, 2026, "STABLE").append(ea, level)
            Generator(other, 2026, "STABLE").append(eb, level)
        self.assertEqual(ea, eb)

    def test_historical_protocol_107_and_unchanged_numeric_policy(self):
        contract = policy.contract()
        self.assertEqual(contract["policyHash"], numerical.POLICY_HASH)
        self.assertEqual(numerical.load_policy()["id"], contract["numericPolicy"])
        for h in (7, 14):
            p = policy.protocol(h, policy.FINAL_CLOSED)
            self.assertEqual(p["availableOrigins"], 107)
            self.assertEqual([f["origins"] for f in p["folds"]], [31, 30, 46])
            for f in p["folds"]:
                self.assertLess(f["trainLatestOrigin"], f["startOrigin"])
            self.assertEqual(policy.protocol(h, policy.BASELINE_CLOSED)["availableOrigins"], 0)

    def test_artifact_hash_foreign_run_live_rejection_and_parity(self):
        view = ReplayDataset(self.source, empty_evidence())
        packed, info, _ = runner.fit(view, 7, "test-run", "replay:test-run:7d:v1", "REPLAY_REFERENCE")
        self.assertLessEqual(info["parityMaxAbsoluteError"], 1e-10)
        with self.assertRaises(ValueError):
            artifacts.verify(packed, "another-run", 7)
        broken = copy.deepcopy(packed)
        broken["model"]["intercept"] += 1
        with self.assertRaises(ValueError):
            artifacts.verify(broken, "test-run", 7)
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact(packed, business_id="MINIMARKET-PASCO-V3",
                                        scenario_id="minimarket-pasco-v3", horizon_days=7)
        chosen = artifacts.transition(packed, "test-run", 7, "replay:test-run:7d:v2", "REPLAY_SELECTED")
        rejected = artifacts.transition(packed, "test-run", 7, "candidate:test-run:7d:LEVEL_1_ONE_RECORD", "REPLAY_REJECTED")
        self.assertEqual(artifacts.predictions(packed, "test-run", 7, view.probe(7)),
                         artifacts.predictions(chosen, "test-run", 7, view.probe(7)))
        self.assertEqual(artifacts.verify(rejected, "test-run", 7), packed["model"])

    def test_integrated_ladder_formal_only_last_level_and_reset(self):
        with tempfile.TemporaryDirectory(prefix="replay-contract-", dir=self.temp_root) as directory:
            store = RunStore("fixture-run", Path(directory) / "replays")
            session = {}
            with patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")), \
                 patch.object(trainer, "train", side_effect=AssertionError("LIVE entrypoint forbidden")), \
                 patch.object(numerical, "temporal_protocol", side_effect=AssertionError("LIVE gate forbidden")), \
                 patch.object(trainer, "evaluate_temporal", wraps=trainer.evaluate_temporal) as evaluate, \
                 patch.object(numerical, "fold_from_samples", wraps=numerical.fold_from_samples) as folds:
                baseline = runner.prepare(store, self.source, 2026, "STABLE", session)
                baseline_bytes = (store.path / "baseline/7.json").read_bytes()
                view_identity = id(session["view"])
                for i, level in enumerate(policy.LEVELS):
                    manifest = runner.advance(store, self.source, session)
                    self.assertEqual(id(session["view"]), view_identity)
                    self.assertEqual(manifest["currentLevel"], level)
                    self.assertEqual(evaluate.call_count, 2 if i == 6 else 0)
                    self.assertEqual(folds.call_count, 6 if i == 6 else 0)
                    if i < 6:
                        self.assertIsNone(manifest["formalEvaluation"])
                        self.assertEqual(manifest["selectedVersions"], baseline["selectedVersions"])
                for h, result in manifest["formalEvaluation"].items():
                    self.assertIn(result["status"], ("PASS", "REJECTED"))
                    self.assertEqual(result["protocol"]["availableOrigins"], 107)
                    self.assertEqual(sum(f["temporalBoundary"]["evalRows"] for f in result["folds"]), 107 * 4)
                    for f in result["folds"]:
                        self.assertLess(f["temporalBoundary"]["actualMaxTrainLabelDate"], f["temporalBoundary"]["startOrigin"])
                    selected = manifest["selectedVersions"][h]
                    self.assertEqual(selected.endswith(":v2"), result["status"] == "PASS")
                self.assertEqual((store.path / "baseline/7.json").read_bytes(), baseline_bytes)
                self.assertEqual(len(manifest["candidateResults"]), 7)
                self.assertIn("NOT_EVALUATED", runner.table(manifest))
                # Reset must also restore the reference after a selected v2.
                manifest["selectedVersions"]["7"] = "replay:fixture-run:7d:v2"
                store.save("manifest.json", manifest)
            self.assertEqual(store.reset(), baseline)
            self.assertEqual(store.reset(), baseline)
            self.assertFalse((store.path / "candidates").exists())
            self.assertEqual((store.path / "baseline/7.json").read_bytes(), baseline_bytes)

    def test_paths_owner_and_lock(self):
        with tempfile.TemporaryDirectory(prefix="replay-path-", dir=self.temp_root) as directory:
            with self.assertRaises(ValueError):
                RunStore("../foreign", directory)
            store = RunStore("owned", directory)
            store.create()
            with self.assertRaises(ValueError):
                store.save("../outside.json", {})
            with store.lock():
                with self.assertRaisesRegex(ValueError, "BUSY"):
                    with store.lock():
                        pass


if __name__ == "__main__":
    unittest.main()
