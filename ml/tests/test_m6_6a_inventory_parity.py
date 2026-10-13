from __future__ import annotations

import math
import unittest

from ml.scripts.m6_6a_inventory_parity import (
    FLOAT_TOLERANCE,
    compare_values,
    intelligence_sha256,
    normalize_for_hash,
)


class InventoryParityHelpersTests(unittest.TestCase):
    def test_float_comparison_uses_documented_absolute_tolerance(self):
        self.assertEqual(compare_values(1.0, 1.0 + FLOAT_TOLERANCE / 2), [])
        self.assertEqual(compare_values(1.0, 1.0 + FLOAT_TOLERANCE * 2), ["$"])

    def test_difference_paths_identify_nested_and_missing_values(self):
        left = {"products": [{"sku": "A", "stock": 3}, {"sku": "B"}]}
        right = {"products": [{"sku": "A", "stock": 4}, {"sku": "C"}]}
        self.assertEqual(compare_values(left, right), ["$.products[0].stock", "$.products[1].sku"])

    def test_hash_is_stable_for_mapping_order_and_float_noise(self):
        left = {"z": 0.123456781, "a": {"y": 2, "x": 1}}
        right = {"a": {"x": 1, "y": 2}, "z": 0.123456784}
        self.assertEqual(intelligence_sha256(left), intelligence_sha256(right))

    def test_hash_excludes_runtime_environment_metadata(self):
        base = {"scenarioId": "minimarket-pasco-v3", "summary": {"products": 80}}
        local = {**base, "environment": "local", "runtimeMs": 5200}
        atlas = {**base, "environment": "atlas", "runtimeMs": 11100}
        self.assertEqual(intelligence_sha256(local), intelligence_sha256(atlas))
        self.assertEqual(normalize_for_hash(local), base)

    def test_non_finite_float_cannot_enter_a_logical_hash(self):
        with self.assertRaises(ValueError):
            intelligence_sha256({"metric": math.nan})


if __name__ == "__main__":
    unittest.main()
