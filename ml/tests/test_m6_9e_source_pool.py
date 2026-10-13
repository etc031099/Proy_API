import json
import unittest

from ml.service.v3_source_pool import CanonicalRowPool


class SourcePoolTests(unittest.TestCase):
    def test_pooled_rows_preserve_values_and_do_not_share_mutable_objects(self):
        source = {"sku": "PAN-FRE-001", "scenarioId": "minimarket-pasco-v3", "units": 3,
                  "nested": {"amount": 4.25}, "tags": ["one"]}
        serialized = json.dumps(source)
        first = json.loads(serialized, object_hook=CanonicalRowPool.object)
        second = json.loads(serialized, object_hook=CanonicalRowPool.object)
        self.assertEqual(first, source)
        self.assertIs(first["sku"], second["sku"])
        first["nested"]["amount"] = 9
        first["tags"].append("two")
        self.assertEqual(second, source)


if __name__ == "__main__":
    unittest.main()
