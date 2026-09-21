from __future__ import annotations

import json
import shutil
import unittest
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from ml.src.common import sha256_file
from ml.src.common import sql_literal
from ml.src.m5 import connect_duckdb
from ml.src.scenario.config import load_scenario_config
from ml.src.scenario.generator import EventWriter, deterministic_id, generate_scenario
from ml.src.scenario.validation import validate_scenario


class R2BScenarioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = Path(__file__).resolve().parents[1] / ".test-tmp"
        root.mkdir(parents=True, exist_ok=True)
        cls.root = root / f"r2b-{uuid.uuid4().hex}"
        cls.root.mkdir()
        cls.bronze = cls.root / "bronze.parquet"
        connection = connect_duckdb()
        try:
            connection.execute(
                """
                CREATE TABLE bronze(
                  store_id VARCHAR, item_id VARCHAR, dept_id VARCHAR, cat_id VARCHAR,
                  source_date DATE, units_sold DOUBLE, sell_price DOUBLE
                )
                """
            )
            rows = []
            demand = {
                "ITEM_A": [2, 0, 3, 1, 2], "ITEM_B": [0, 1, 0, 2, 0],
                "ITEM_C": [5, 4, 3, 2, 1], "ITEM_D": [0, 0, 1, 0, 0],
                "ITEM_E": [1, 2, 1, 2, 1],
            }
            for item_index, (item_id, units) in enumerate(demand.items()):
                category = "FOODS" if item_index < 3 else "HOUSEHOLD"
                for day_index, quantity in enumerate(units, 1):
                    rows.append((
                        "CA_3", item_id, f"{category}_1", category,
                        f"2020-01-0{day_index}", quantity, 1.5 + item_index,
                    ))
            connection.executemany("INSERT INTO bronze VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            connection.execute(f"COPY bronze TO {sql_literal(cls.bronze)} (FORMAT PARQUET)")
        finally:
            connection.close()
        cls.config = cls.root / "scenario.toml"
        cls.output = cls.root / "scenario.ndjson"
        cls.manifest_path = cls.root / "manifest.json"
        cls._write_config(cls.config, seed=2026, output=cls.output, manifest=cls.manifest_path)
        cls.manifest = generate_scenario(cls.config)
        cls.events = [json.loads(line) for line in cls.output.read_text(encoding="utf-8").splitlines()]

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.root, ignore_errors=True)

    @classmethod
    def _write_config(
        cls, path: Path, *, seed: int, output: Path, manifest: Path,
        cancellation_rate: float = 1.0,
    ) -> None:
        normalized = lambda value: str(value).replace("\\", "/")
        path.write_text(
            f"""
[scenario]
scenario_id = "fixture"
seed = {seed}
source_store = "CA_3"
source_start = "2020-01-01"
source_end = "2020-01-05"
operational_date_offset_days = 1001
[paths]
bronze = "{normalized(cls.bronze)}"
output = "{normalized(output)}"
manifest = "{normalized(manifest)}"
[selection]
product_count = 5
[suppliers]
count = 2
max_per_product = 2
[customers]
count = 5
anonymous_rate = 0.0
[inventory]
lead_time_min_days = 1
lead_time_max_days = 2
product_setup_lead_days = 3
initial_stock_low = 2
initial_stock_medium = 4
initial_stock_high = 6
min_stock_low = 1
min_stock_medium = 2
min_stock_high = 3
reorder_point_low = 1
reorder_point_medium = 3
reorder_point_high = 5
[pricing]
usd_to_pen = 3.7
[margins]
low = 0.2
medium = 0.3
high = 0.4
[transactions]
max_lines_per_ticket = 3
max_quantity_per_line = 3
credit_rate = 1.0
cancellation_rate = {cancellation_rate}
credit_payment_delay_days = 1
credit_payment_fraction = 0.5
[payment_methods]
cash = 0.6
card = 0.2
bank_transfer = 0.1
credit = 0.1
""".strip() + "\n",
            encoding="utf-8",
        )

    def test_same_seed_produces_same_ndjson_hash(self) -> None:
        first = sha256_file(self.output)
        generate_scenario(self.config, overwrite=True)
        self.assertEqual(sha256_file(self.output), first)

    def test_different_seed_produces_different_scenario(self) -> None:
        other_config = self.root / "other.toml"
        other_output = self.root / "other.ndjson"
        self._write_config(other_config, seed=99, output=other_output, manifest=self.root / "other.json")
        generate_scenario(other_config)
        self.assertNotEqual(sha256_file(other_output), sha256_file(self.output))

    def test_events_are_causally_ordered(self) -> None:
        timestamps = [datetime.fromisoformat(event["occurredAt"].replace("Z", "+00:00")) for event in self.events]
        self.assertEqual(timestamps, sorted(timestamps))

    def test_stock_never_becomes_negative(self) -> None:
        result = validate_scenario(load_scenario_config(self.config))
        self.assertEqual(result["status"], "passed")
        self.assertGreaterEqual(result["minimum_ending_stock"], 0)

    def test_validator_rejects_a_sale_that_would_make_stock_negative(self) -> None:
        tampered = self.root / "tampered.ndjson"
        changed = False
        with tampered.open("w", encoding="utf-8", newline="\n") as stream:
            for event in self.events:
                copy = json.loads(json.dumps(event))
                if (
                    not changed
                    and copy["eventType"] == "transaction.completed"
                    and copy["payload"]["type"] == "sale"
                ):
                    copy["payload"]["products"][0]["quantity"] = 10**9
                    changed = True
                stream.write(json.dumps(copy) + "\n")
        with self.assertRaisesRegex(ValueError, "negative stock"):
            validate_scenario(load_scenario_config(self.config), file_path=tampered)

    def test_every_product_has_valid_supplier_relationship(self) -> None:
        vendors = {event["payload"]["_id"] for event in self.events if event["eventType"] == "contact.created" and event["payload"]["type"] == "vendor"}
        for event in self.events:
            if event["eventType"] == "product.created":
                configured = {item["supplierId"] for item in event["payload"]["supplierPrices"]}
                self.assertTrue(configured <= vendors)
                self.assertIn(event["payload"]["preferredSupplierId"], configured)

    def test_purchase_prices_are_positive_and_below_sale_price(self) -> None:
        for event in self.events:
            if event["eventType"] == "product.created":
                sale_price = event["payload"]["price"]
                for item in event["payload"]["supplierPrices"]:
                    self.assertGreater(item["purchasePrice"], 0)
                    self.assertLess(item["purchasePrice"], sale_price)

    def test_ticket_totals_match_materialized_units(self) -> None:
        units = sum(
            item["quantity"]
            for event in self.events
            if event["eventType"] == "transaction.completed"
            and event["payload"]["type"] == "sale"
            and event["payload"]["notes"].startswith("M5 demand")
            for item in event["payload"]["products"]
        )
        self.assertEqual(units, 34)
        self.assertEqual(units, self.manifest["counts"]["materialized_m5_units"])

    def test_m5_demand_reconciles_by_product_and_day(self) -> None:
        result = validate_scenario(load_scenario_config(self.config))
        self.assertIn("m5_demand_reconciliation", result["checks"])

    def test_credit_sales_require_registered_customers(self) -> None:
        customer_ids = {event["payload"]["_id"] for event in self.events if event["eventType"] == "contact.created" and event["payload"]["type"] == "customer"}
        credit_sales = [event for event in self.events if event["eventType"] == "transaction.completed" and event["payload"].get("paymentMethod") == "credit"]
        self.assertTrue(credit_sales)
        self.assertTrue(all(event["payload"]["customerId"] in customer_ids for event in credit_sales))

    def test_payments_are_after_credit_sales_and_leave_valid_debt(self) -> None:
        payments = [event for event in self.events if event["eventType"] == "credit-payment.created"]
        self.assertTrue(payments)
        result = validate_scenario(load_scenario_config(self.config))
        self.assertGreaterEqual(result["ending_open_credit_pen"], 0)

    def test_cancellations_target_extra_non_credit_sales(self) -> None:
        sales = {event["payload"]["_id"]: event for event in self.events if event["eventType"] == "transaction.completed" and event["payload"]["type"] == "sale"}
        cancellations = [event for event in self.events if event["eventType"] == "transaction.cancelled"]
        self.assertTrue(cancellations)
        for event in cancellations:
            sale = sales[event["payload"]["transactionId"]]
            self.assertEqual(sale["payload"]["paymentMethod"], "cash")
            self.assertTrue(sale["payload"]["notes"].startswith("Synthetic cancellation"))

    def test_ids_are_deterministic_object_id_strings(self) -> None:
        first = deterministic_id("scenario", "product", "ITEM_A")
        self.assertEqual(first, deterministic_id("scenario", "product", "ITEM_A"))
        self.assertEqual(len(first), 24)
        int(first, 16)

    def test_manifest_contains_hashes_lineage_and_counts(self) -> None:
        stored = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["ndjson_sha256"], sha256_file(self.output))
        self.assertEqual(set(stored["provenance"]), {"REAL", "DERIVED", "SYNTHETIC", "CONFIGURED"})
        self.assertEqual(stored["validation"]["status"], "passed")

    def test_writer_streams_without_retaining_event_collection(self) -> None:
        path = self.root / "writer.ndjson"
        writer = EventWriter(path)
        writer.write({"eventType": "x", "eventId": "1", "occurredAt": "2020-01-01T00:00:00Z", "payload": {}})
        self.assertFalse(hasattr(writer, "events"))
        self.assertEqual(writer.records, 1)
        writer.close()
        self.assertEqual(len(path.read_text(encoding="utf-8").splitlines()), 1)

    def test_invalid_config_is_rejected_before_output(self) -> None:
        invalid = self.root / "invalid.toml"
        invalid_output = self.root / "invalid.ndjson"
        self._write_config(invalid, seed=7, output=invalid_output, manifest=self.root / "invalid.json")
        invalid.write_text(invalid.read_text(encoding="utf-8").replace("credit_rate = 1.0", "credit_rate = 1.5"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "between 0 and 1"):
            generate_scenario(invalid)
        self.assertFalse(invalid_output.exists())


if __name__ == "__main__":
    unittest.main()
