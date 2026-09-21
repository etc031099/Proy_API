from __future__ import annotations

import csv
import json
import shutil
import unittest
import uuid
from pathlib import Path

from ml.src.common import (
    assert_outside_raw,
    capture_hashes,
    discover_m5_files,
    sha256_file,
)
from ml.src.ingest.profile_m5 import (
    manifest_for,
    profile_dataset,
    verify_existing_manifest,
)
from ml.src.m5 import (
    connect_duckdb,
    create_m5_views,
    resolve_selected_store,
    validate_schema,
)
from ml.src.normalize.build_bronze import build_bronze


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


class R2APipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        test_temp_root = Path(__file__).resolve().parents[1] / ".test-tmp"
        test_temp_root.mkdir(parents=True, exist_ok=True)
        self.root = test_temp_root / f"case-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.raw = self.root / "raw" / "m5"
        self.raw.mkdir(parents=True)
        write_csv(
            self.raw / "calendar.csv",
            [
                "date", "wm_yr_wk", "weekday", "wday", "month", "year", "d",
                "event_name_1", "event_type_1", "event_name_2", "event_type_2",
                "snap_CA", "snap_TX", "snap_WI",
            ],
            [
                {"date": "2011-01-29", "wm_yr_wk": 1, "weekday": "Saturday", "wday": 1, "month": 1, "year": 2011, "d": "d_1", "event_name_1": "", "event_type_1": "", "event_name_2": "", "event_type_2": "", "snap_CA": 0, "snap_TX": 0, "snap_WI": 0},
                {"date": "2011-01-30", "wm_yr_wk": 1, "weekday": "Sunday", "wday": 2, "month": 1, "year": 2011, "d": "d_2", "event_name_1": "Event", "event_type_1": "Cultural", "event_name_2": "", "event_type_2": "", "snap_CA": 1, "snap_TX": 0, "snap_WI": 0},
                {"date": "2011-01-31", "wm_yr_wk": 1, "weekday": "Monday", "wday": 3, "month": 1, "year": 2011, "d": "d_3", "event_name_1": "", "event_type_1": "", "event_name_2": "", "event_type_2": "", "snap_CA": 0, "snap_TX": 0, "snap_WI": 0},
            ],
        )
        write_csv(
            self.raw / "sell_prices.csv",
            ["store_id", "item_id", "wm_yr_wk", "sell_price"],
            [
                {"store_id": "CA_1", "item_id": "ITEM_1", "wm_yr_wk": 1, "sell_price": 2.5},
                {"store_id": "TX_1", "item_id": "ITEM_1", "wm_yr_wk": 1, "sell_price": 2.7},
            ],
        )
        write_csv(
            self.raw / "sales_train_evaluation.csv",
            ["id", "item_id", "dept_id", "cat_id", "store_id", "state_id", "d_1", "d_2", "d_3"],
            [
                {"id": "ITEM_1_CA_1", "item_id": "ITEM_1", "dept_id": "FOODS_1", "cat_id": "FOODS", "store_id": "CA_1", "state_id": "CA", "d_1": 0, "d_2": 2, "d_3": 1},
                {"id": "ITEM_2_CA_1", "item_id": "ITEM_2", "dept_id": "HOUSE_1", "cat_id": "HOUSEHOLD", "store_id": "CA_1", "state_id": "CA", "d_1": 0, "d_2": 0, "d_3": 4},
                {"id": "ITEM_1_TX_1", "item_id": "ITEM_1", "dept_id": "FOODS_1", "cat_id": "FOODS", "store_id": "TX_1", "state_id": "TX", "d_1": 1, "d_2": 1, "d_3": 1},
            ],
        )
        write_csv(
            self.raw / "sample_submission.csv",
            ["id", "F1"],
            [{"id": "ITEM_1_CA_1", "F1": 0}],
        )
        self.config = self.root / "config.toml"
        self._write_config("CA_1")

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def _write_config(self, selected_store: str) -> None:
        paths = {
            "raw_directory": self.raw,
            "manifest": self.root / "m5_manifest.json",
            "profile_report": self.root / "profile.json",
            "bronze_output": self.root / "bronze.parquet",
            "bronze_manifest": self.root / "bronze_manifest.json",
        }
        path_lines = "\n".join(
            f'{name} = "{str(path).replace(chr(92), "/")}"'
            for name, path in paths.items()
        )
        self.config.write_text(
            "[dataset]\n"
            'source_dataset = "m5"\nsource_currency = "USD"\n'
            'operational_currency = "PEN"\n'
            f'selected_store = "{selected_store}"\n'
            "forecast_horizon_days = 7\nseed = 2026\n\n"
            "[paths]\n" + path_lines + "\n\n"
            "[bronze]\ncompression = \"zstd\"\nrow_group_size = 122880\n"
            "measure_csv_equivalent = false\n",
            encoding="utf-8",
        )

    def test_expected_schema_is_enforced(self) -> None:
        connection = connect_duckdb()
        try:
            create_m5_views(
                connection,
                self.raw / "sales_train_evaluation.csv",
                self.raw / "calendar.csv",
                self.raw / "sell_prices.csv",
            )
            schema = validate_schema(connection)
            self.assertEqual(schema["day_columns"], ["d_1", "d_2", "d_3"])
        finally:
            connection.close()

    def test_manifest_contains_actual_hashes_and_sizes(self) -> None:
        files = discover_m5_files(self.raw)
        profiles = {
            "calendar.csv": {
                "rows": 3,
                "columns_count": 1,
                "columns": [{"name": "date", "type": "DATE"}],
            }
        }
        manifest = manifest_for(
            files, "2026-01-01T00:00:00+00:00", profiles
        )
        record = next(item for item in manifest["files"] if item["name"] == "calendar.csv")
        self.assertEqual(record["sha256"], sha256_file(self.raw / "calendar.csv"))
        self.assertEqual(record["size_bytes"], (self.raw / "calendar.csv").stat().st_size)
        self.assertEqual(record["rows"], 3)
        self.assertEqual(record["schema"][0]["name"], "date")

    def test_versioned_manifest_detects_changed_raw_file(self) -> None:
        files = discover_m5_files(self.raw)
        manifest_path = self.root / "recorded_manifest.json"
        manifest_path.write_text(
            json.dumps(manifest_for(files, "2026-01-01T00:00:00+00:00")),
            encoding="utf-8",
        )
        verify_existing_manifest(manifest_path, files)
        with (self.raw / "calendar.csv").open("a", encoding="utf-8") as stream:
            stream.write("\n")
        with self.assertRaisesRegex(RuntimeError, "immutable"):
            verify_existing_manifest(manifest_path, files)

    def test_profile_reports_store_ranking_and_quality(self) -> None:
        report = profile_dataset(self.config)
        self.assertEqual(report["selected_store"], "CA_1")
        self.assertEqual(len(report["store_ranking"]), 2)
        self.assertEqual(report["quality"]["checks"]["duplicate_sales_ids"], 0)
        self.assertEqual(report["general"]["calendar"]["missing_dates"], 0)
        self.assertEqual(report["general"]["prices"]["median_price"], 2.6)
        self.assertIn("daily_stddev", report["selected_store_product_profile"][0])
        activity = report["selected_store_activity_profile"]
        classified = sum(activity[name] for name in (
            "pre_launch_rows", "active_evidence_rows",
            "post_inactive_rows", "ambiguous_rows",
        ))
        self.assertEqual(classified, 6)

    def test_selected_store_must_exist(self) -> None:
        ranking = [{"store_id": "CA_1", "score": 1.0}]
        self.assertEqual(resolve_selected_store("CA_1", ranking), "CA_1")
        with self.assertRaisesRegex(ValueError, "does not exist"):
            resolve_selected_store("WI_9", ranking)

    def test_bronze_requires_a_reviewed_pinned_store(self) -> None:
        self._write_config("auto")
        with self.assertRaisesRegex(ValueError, "pin selected_store"):
            build_bronze(self.config, output_override=self.root / "auto.parquet")

    def test_bronze_has_unique_keys_and_exact_calendar_and_price_joins(self) -> None:
        output = self.root / "result.parquet"
        manifest = build_bronze(self.config, output_override=output)
        self.assertEqual(manifest["statistics"]["rows"], 6)
        self.assertEqual(manifest["statistics"]["duplicate_keys"], 0)
        self.assertEqual(manifest["statistics"]["total_units"], 7)
        self.assertAlmostEqual(manifest["statistics"]["zero_percentage"], 50.0)
        connection = connect_duckdb()
        try:
            rows = connection.execute(
                "SELECT item_id, source_date, units_sold, sell_price, snap_active "
                "FROM read_parquet(?) ORDER BY item_id, source_date",
                [str(output)],
            ).fetchall()
            self.assertEqual(str(rows[0][1]), "2011-01-29")
            self.assertEqual(rows[1][2], 2)
            self.assertEqual(rows[1][3], 2.5)
            self.assertEqual(rows[1][4], 1)
            self.assertIsNone(rows[3][3])
        finally:
            connection.close()

    def test_pipeline_does_not_modify_raw_and_is_reproducible(self) -> None:
        files = discover_m5_files(self.raw)
        before = capture_hashes(files)
        first = self.root / "first.parquet"
        second = self.root / "second.parquet"
        first_manifest = build_bronze(self.config, output_override=first)
        second_manifest = build_bronze(self.config, output_override=second)
        self.assertEqual(before, capture_hashes(files))
        self.assertEqual(first_manifest["output_sha256"], second_manifest["output_sha256"])

    def test_output_inside_raw_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "immutable raw"):
            assert_outside_raw(self.raw / "result.parquet", self.raw)
        with self.assertRaises(ValueError):
            build_bronze(self.config, output_override=self.raw / "result.parquet")

    def test_existing_bronze_is_not_overwritten_without_explicit_flag(self) -> None:
        output = self.root / "existing.parquet"
        output.write_bytes(b"do-not-replace")
        with self.assertRaisesRegex(FileExistsError, "already exists"):
            build_bronze(self.config, output_override=output)
        self.assertEqual(output.read_bytes(), b"do-not-replace")


if __name__ == "__main__":
    unittest.main()
