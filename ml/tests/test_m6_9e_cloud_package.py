from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ml.service import v3_package
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime

ROOT = Path(__file__).resolve().parents[2]


class CloudPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.descriptor = v3_package.verify_package(ROOT)

    def test_all_source_files_counts_and_artifacts_are_verified(self):
        self.assertEqual(self.descriptor["sourceLogicalHash"], v3_package.SOURCE_HASH)
        self.assertEqual(self.descriptor["counts"]["products"], 80)
        self.assertEqual(len(self.descriptor["hashes"]), 20)
        self.assertEqual(set(self.descriptor["artifacts"]), set(v3_package.ARTIFACTS))

    def test_changed_manifest_counts_fail_before_loading_data(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            generated = root / "data/minimarket-pasco-v3/generated"
            generated.mkdir(parents=True)
            manifest = json.loads((ROOT / "data/minimarket-pasco-v3/generated/manifest.json").read_text(encoding="utf-8"))
            manifest["counts"]["products"] = 79
            (generated / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "lineage/counts"):
                v3_package.describe_package(root)

    def test_corrupt_source_hash_is_rejected(self):
        with patch.object(v3_package, "file_hash", return_value="tampered"):
            with self.assertRaisesRegex(ValueError, "file integrity"):
                v3_package.describe_package(ROOT)

    def test_stale_or_tampered_descriptor_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            generated = root / "data/minimarket-pasco-v3/generated"
            generated.mkdir(parents=True)
            descriptor = copy.deepcopy(self.descriptor)
            descriptor["bundleVersion"] = "unapproved-version"
            (generated / "runtime-package.json").write_text(json.dumps(descriptor), encoding="utf-8")
            with patch.object(v3_package, "describe_package", return_value=self.descriptor):
                with self.assertRaisesRegex(ValueError, "descriptor"):
                    v3_package.verify_package(root)

    def test_missing_descriptor_leaves_v3_not_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime = V3IntelligenceRuntime(Path(folder))
            with self.assertRaises(FileNotFoundError):
                runtime.load()
            self.assertFalse(runtime.ready)
            self.assertEqual(runtime.load_error_code, "ARTIFACT_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
