from __future__ import annotations

import hashlib
import json
import unittest
from collections import Counter
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from io import StringIO
from unittest.mock import patch

from ml.service.model_runtime import EXPECTED_JOBLIB_SHA256, ModelRuntime
from ml.src.common import repository_path, sha256_file
from ml.src.m5 import connect_duckdb
from ml.src.scenario.cloud_demo_v2 import (
    CONFIG, GOLD, balances, choose_products, generate, project_events, read_replay, validate_features,
)
from ml.src.scenario.config import load_scenario_config
from ml.src.scenario.validation import validate_scenario
from ml.src.serving.build_cloud_demo_lineage import build_cloud_demo_lineage
from ml.src.serving.demand_features import DemandFeatureBuilder, FeatureBuildError

QUOTAS = {"FOODS_1": 8, "FOODS_2": 8, "FOODS_3": 12, "HOBBIES_1": 8,
          "HOBBIES_2": 8, "HOUSEHOLD_1": 8, "HOUSEHOLD_2": 8}


class V2ContractTests(unittest.TestCase):
    def test_config_dates_quotas_and_identity(self):
        config = load_scenario_config(CONFIG)
        self.assertEqual(config.scenario_id, "m5-ca3-cloud-demo-v2")
        self.assertEqual(config.raw["v2"]["business_id"], "ML-CLOUD-DEMO-V2")
        self.assertEqual(config.source_store, "CA_3")
        self.assertEqual(config.seed, 2026)
        self.assertEqual(config.product_count, sum(QUOTAS.values()))
        self.assertEqual(config.raw["selection"]["department_quotas"], QUOTAS)
        self.assertEqual(config.operational_start, date(2025, 11, 2))
        self.assertEqual(config.operational_end, date(2026, 5, 17))
        self.assertEqual(config.operational_offset_days % 7, 0)
        self.assertEqual(date(2016, 5, 22) + timedelta(days=3654), date(2026, 5, 24))

    def test_selection_is_order_independent_and_preserves_observed_states(self):
        rows = [{"item_id": f"FOODS_1_{i:03}", "dept_id": "FOODS_1",
                 "inventoryStatus": ["OK", "REPONER", "VIGILAR"][i % 3],
                 "rotation": i % 3, "demandBand": i % 3, "priceBand": i % 2,
                 "stockBand": i % 2, "quantityBand": i % 3, "coverageBand": i % 3,
                 "intermittent": i % 2} for i in range(20)]
        a = choose_products(rows, {"FOODS_1": 8}, 2026)
        b = choose_products(list(reversed(rows)), {"FOODS_1": 8}, 2026)
        self.assertEqual(a, b)
        self.assertEqual(len({r["item_id"] for r in a}), 8)
        self.assertEqual({r["inventoryStatus"] for r in a}, {"OK", "VIGILAR", "REPONER"})
        with self.assertRaises(ValueError):
            choose_products(rows, {"FOODS_1": 21}, 2026)

    def test_source_read_excludes_future_and_unfinished_cancel_exercises(self):
        events = [{"occurredAt": "2026-05-17T10:00:00Z", "eventType": "transaction.completed",
                   "payload": {"_id": "extra", "notes": "Synthetic cancellation exercise"}},
                  {"occurredAt": "2026-05-17T11:00:00Z", "eventType": "transaction.completed",
                   "payload": {"_id": "real", "notes": "M5 demand"}},
                  {"occurredAt": "2026-05-18T22:00:00Z", "eventType": "transaction.cancelled",
                   "payload": {"transactionId": "extra"}}]
        with patch.object(Path, 'open', return_value=StringIO('\n'.join(json.dumps(e) for e in events))):
            self.assertEqual(read_replay(Path('events.ndjson'), date(2026, 5, 17)), [events[1]])

    def test_opening_stock_accounts_for_cancellations(self):
        events = [{"occurredAt": "2025-11-01T08:00:00Z", "eventType": "transaction.completed",
                   "payload": {"_id": "p", "type": "purchase", "products": [{"productId": "a", "quantity": 9}]}},
                  {"occurredAt": "2025-11-01T10:00:00Z", "eventType": "transaction.completed",
                   "payload": {"_id": "s", "type": "sale", "products": [{"productId": "a", "quantity": 2}]}},
                  {"occurredAt": "2025-11-01T22:00:00Z", "eventType": "transaction.cancelled",
                   "payload": {"transactionId": "s"}}]
        self.assertEqual(balances(events, date(2025, 11, 2)), {"a": 9})
        events[1]["payload"]["products"][0]["quantity"] = 10
        with self.assertRaises(ValueError):
            balances(events)

    def test_v2_cannot_write_v1_lineage_directory(self):
        with self.assertRaisesRegex(RuntimeError, "separate lineage directory"):
            build_cloud_demo_lineage(CONFIG, expected_scenario_id="m5-ca3-cloud-demo-v2",
                                     business_id="ML-CLOUD-DEMO-V2")


class V2LocalArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = load_scenario_config(CONFIG)
        cls.lineage_dir = repository_path(cls.config.raw["v2"]["lineage_directory"])
        required = [cls.config.output, cls.config.manifest, repository_path(GOLD), cls.config.bronze,
                    repository_path("ml/data/operational/scenario_large.ndjson"),
                    cls.lineage_dir / "cloud_demo_lineage_manifest.json"]
        missing = [str(p) for p in required if not p.is_file()]
        if missing:
            raise unittest.SkipTest("Local v2 validation artifacts unavailable: " + ', '.join(missing))
        cls.manifest = json.loads(cls.config.manifest.read_text(encoding="utf-8"))
        cls.selected = cls.manifest["products"]
        cls.events = [json.loads(line) for line in cls.config.output.read_text(encoding="utf-8").splitlines()]
        cls.runtime = ModelRuntime()
        cls.runtime.load()
        cls.builder = DemandFeatureBuilder(cls.lineage_dir / "cloud_demo_lineage_manifest.json",
            expected_business_id="ML-CLOUD-DEMO-V2", expected_scenario_id=cls.config.scenario_id)

    def test_exact_unique_products_and_metadata(self):
        self.assertEqual(len(self.selected), 60)
        self.assertEqual(len({r["productId"] for r in self.selected}), 60)
        self.assertEqual(len({r["item_id"] for r in self.selected}), 60)
        self.assertEqual(dict(Counter(r["dept_id"] for r in self.selected)), QUOTAS)
        for row in self.selected:
            self.assertIn(row["dept_id"], row["displayName"])
            self.assertIn("M5", row["displayName"])
        self.assertEqual(self.runtime.joblib_sha256, EXPECTED_JOBLIB_SHA256)

    def test_existing_artifacts_are_not_overwritten(self):
        digest = sha256_file(self.config.output)
        with self.assertRaises(FileExistsError):
            generate()
        self.assertEqual(sha256_file(self.config.output), digest)

    def test_lineage_hashes_and_isolation(self):
        for record in self.builder.manifest["artifacts"].values():
            self.assertEqual(sha256_file(repository_path(record["path"])), record["sha256"])
            self.assertIn("cloud_demo_v2/", record["path"])
        self.assertEqual(self.builder.manifest["lineage_version"], "cloud-demo-lineage-v2")
        with self.assertRaises(FeatureBuildError):
            DemandFeatureBuilder(self.lineage_dir / "cloud_demo_lineage_manifest.json")
        v1 = json.loads(repository_path("ml/reports/scenario_cloud_demo_manifest.json").read_text())
        v1_ids = {json.loads(line)["payload"]["_id"] for line in repository_path(v1["ndjson"]).read_text().splitlines()
                  if json.loads(line)["eventType"] == "product.created"}
        self.assertTrue(v1_ids.isdisjoint(r["productId"] for r in self.selected))

    def test_replay_reconciliation_credit_totals_and_nonnegative_inventory(self):
        replay = replace(self.config, source_start=date.fromisoformat(self.manifest["replay_source_start"]))
        result = validate_scenario(replay, self.selected)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["demand_reconciliation"], self.manifest["validation"]["demand_reconciliation"])
        self.assertEqual(result["stock"], self.manifest["validation"]["stock"])

    def test_opening_and_final_stock_preserved_from_original_movements(self):
        source = read_replay(repository_path("ml/data/operational/scenario_large.ndjson"), self.config.operational_end)
        initial, final = balances(source, self.config.operational_start), balances(source)
        projected_initial, projected_final = balances(self.events, self.config.operational_start), balances(self.events)
        for row in self.selected:
            self.assertEqual(initial.get(row["originalId"], 0), row["openingStock"])
            self.assertEqual(projected_initial.get(row["productId"], 0), row["openingStock"])
            self.assertEqual(final[row["originalId"]], projected_final[row["productId"]])

    def test_projection_is_reproducible_and_rekeys_all_entities(self):
        source = read_replay(repository_path("ml/data/operational/scenario_large.ndjson"), self.config.operational_end)
        projected, _ = project_events(source, self.selected, self.config)
        digest = hashlib.sha256()
        for event in projected:
            digest.update((json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + '\n').encode())
        self.assertEqual(digest.hexdigest(), self.manifest["ndjson_sha256"])
        self.assertEqual(len({e["eventId"] for e in projected}), len(projected))
        self.assertTrue(all(e["scenarioId"] == self.config.scenario_id for e in projected))

    def test_no_future_events_and_window_demand_matches_bronze(self):
        self.assertTrue(all(e["occurredAt"][:10] <= "2026-05-17" for e in self.events))
        units = Counter()
        item_by_id = {r["productId"]: r["item_id"] for r in self.selected}
        for event in self.events:
            p = event["payload"]
            if event["eventType"] == "transaction.completed" and p["type"] == "sale" and p.get("notes", "").startswith("M5 demand") and event["occurredAt"][:10] >= "2025-11-02":
                for line in p["products"]:
                    units[item_by_id[line["productId"]]] += line["quantity"]
        self.assertEqual(units, {r["item_id"]: r["units"] for r in self.selected})

    def test_sixty_ready_parity_and_inference(self):
        connection = connect_duckdb()
        try:
            result = validate_features(connection, self.config, self.events, self.selected, self.builder, self.runtime)
            self.assertEqual(result, {"ready": 60, "features": 31, "comparisons": 1860, "differences": 0, "tolerance": 1e-5})
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
