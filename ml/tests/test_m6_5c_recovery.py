import copy
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from ml.scripts import recover_minimarket_v3 as r
from ml.src import v3_baseline_bundle as bundle
from ml.src import v3_forecast as v


class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.freeze = json.loads(r.b.FREEZE_PATH.read_text(encoding="utf-8"))

    def test_exact_original_module_and_import_only_runner_fix(self):
        config = r.frozen_configuration(self.freeze)
        self.assertEqual(config["split"]["test"], ["2026-08-16", "2026-10-12"])
        self.assertEqual(config["selectedBaselines"], {"1": "B3_MEAN_28", "7": "B3_MEAN_28", "14": "B3_MEAN_28"})

    def test_changed_selection_is_rejected(self):
        for key, value in (("baseline", "B2_MEAN_7"), ("candidate", "HGB-S-E2")):
            freeze = copy.deepcopy(self.freeze)
            freeze["horizons"]["7"][key] = value
            with self.assertRaises(ValueError):
                r.frozen_configuration(freeze)

    def test_changed_split_seed_features_and_experimental_params_are_rejected(self):
        changes = (("numpySeed", 2027), ("featureVersion", "changed"), ("split", {}), ("h28", {"model": "HGB-S-E1"}))
        for key, value in changes:
            freeze = copy.deepcopy(self.freeze)
            freeze[key] = value
            with self.assertRaises(ValueError):
                r.frozen_configuration(freeze)

    def test_claim_cannot_be_repeated_or_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "marker.json"
            r.claim_once(path, {"frozenConfigSha256": "frozen"})
            before = path.read_bytes()
            with self.assertRaises(FileExistsError):
                r.claim_once(path, {"frozenConfigSha256": "different"})
            self.assertEqual(path.read_bytes(), before)

    def test_manifest_tampering_is_rejected(self):
        manifest = {"strategyVersion": bundle.STRATEGY_VERSION, "datasetSha256": v.DATASET_SHA256,
                    "config": bundle.configuration(), "configSha256": bundle.config_hash()}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            self.assertEqual(bundle.load_manifest(path), manifest)
            manifest["config"]["historyDays"] = 7
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(ValueError):
                bundle.load_manifest(path)

    def test_prediction_contract_is_statistical_and_deterministic_on_validation(self):
        dataset = v.load_validated_dataset(r.ROOT)
        sku = sorted(dataset.product_by_sku)[0]
        cutoff = date(2026, 8, 15)
        first = bundle.predict(dataset, sku=sku, cutoff=cutoff)
        second = bundle.predict(dataset, sku=sku, cutoff=cutoff)
        self.assertEqual(first, second)
        self.assertEqual(first["forecastSource"], "MOVING_AVERAGE_28")
        self.assertEqual(first["status"], "READY")
        self.assertIsNone(first["confidence"])
        self.assertLessEqual(first["expectedUnitsNext1d"], first["expectedUnitsNext7d"])


if __name__ == "__main__":
    unittest.main()
