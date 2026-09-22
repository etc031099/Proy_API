from __future__ import annotations

import json
import shutil
import unittest
import uuid
from datetime import date
from pathlib import Path

from ml.src.common import repository_path, sha256_file, sql_literal
from ml.src.m5 import connect_duckdb
from ml.src.serving.build_cloud_demo_lineage import (
    EXPECTED_OFFSET_DAYS,
    create_lineage_views,
    operational_to_source,
    source_to_operational,
)
from ml.src.scenario.config import load_scenario_config


class R5BLineageUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = (
            Path(__file__).resolve().parents[1]
            / ".test-tmp"
            / f"r5b-{uuid.uuid4().hex}"
        )
        cls.root.mkdir(parents=True)
        cls.bronze = cls.root / "bronze.parquet"
        connection = connect_duckdb()
        try:
            connection.execute(
                """
                CREATE TABLE fixture AS
                SELECT 'CA_3'::VARCHAR AS store_id,
                       'ITEM_1'::VARCHAR AS item_id,
                       'DEPT_1'::VARCHAR AS dept_id,
                       'CAT_1'::VARCHAR AS cat_id,
                       source_date::DATE AS source_date,
                       0::INTEGER AS units_sold,
                       CASE source_date
                         WHEN DATE '2014-12-30' THEN 2.0
                         WHEN DATE '2015-01-02' THEN 4.0
                       END::FLOAT AS sell_price,
                       CASE WHEN source_date = DATE '2015-01-02'
                         THEN 'Event' END::VARCHAR AS event_name_1,
                       CASE WHEN source_date = DATE '2015-01-02'
                         THEN 'Cultural' END::VARCHAR AS event_type_1,
                       NULL::VARCHAR AS event_name_2,
                       NULL::VARCHAR AS event_type_2,
                       (source_date = DATE '2015-01-02')::TINYINT AS snap_CA
                FROM generate_series(
                  DATE '2014-12-30', DATE '2015-01-03', INTERVAL 1 DAY
                ) dates(source_date)
                """
            )
            connection.execute(
                f"COPY fixture TO {sql_literal(cls.bronze)} (FORMAT PARQUET)"
            )
        finally:
            connection.close()

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self) -> None:
        self.connection = connect_duckdb()
        self.connection.execute(
            "CREATE TEMP TABLE selected_products(item_id VARCHAR PRIMARY KEY)"
        )
        self.connection.execute("INSERT INTO selected_products VALUES ('ITEM_1')")
        create_lineage_views(
            self.connection,
            self.bronze,
            store_id="CA_3",
            source_start=date(2015, 1, 1),
            source_end=date(2015, 1, 3),
            scenario_id="fixture",
        )

    def tearDown(self) -> None:
        self.connection.close()

    def test_date_mapping_is_exact_and_reversible(self) -> None:
        source = date(2015, 6, 30)
        operational = source_to_operational(source, EXPECTED_OFFSET_DAYS)
        self.assertEqual(operational, date(2025, 7, 1))
        self.assertEqual(
            operational_to_source(operational, EXPECTED_OFFSET_DAYS), source
        )

    def test_active_start_uses_first_non_null_price(self) -> None:
        active_start = self.connection.execute(
            "SELECT active_start FROM product_lineage"
        ).fetchone()[0]
        self.assertEqual(active_start, date(2014, 12, 30))

    def test_forward_fill_is_causal_and_missing_flag_precedes_fill(self) -> None:
        rows = self.connection.execute(
            """
            SELECT source_date, raw_sell_price, filled_sell_price,
                   price_missing_active
            FROM price_lineage ORDER BY source_date
            """
        ).fetchall()
        self.assertEqual(rows[0], (date(2015, 1, 1), None, 2.0, True))
        self.assertEqual(rows[1], (date(2015, 1, 2), 4.0, 4.0, False))
        self.assertEqual(rows[2], (date(2015, 1, 3), None, 4.0, True))

    def test_calendar_matches_demand_v1_conventions(self) -> None:
        row = self.connection.execute(
            """
            SELECT day_of_week, month, quarter, is_weekend,
                   event_name_1, event_type_1, event_name_2, snap_CA
            FROM calendar_lineage WHERE source_date = DATE '2015-01-02'
            """
        ).fetchone()
        self.assertEqual(row, (5, 1, 1, False, "Event", "Cultural", "__NONE__", 1))


class R5BGeneratedArtifactTests(unittest.TestCase):
    def test_manifest_hashes_and_grains(self) -> None:
        root = repository_path("ml/data/serving")
        manifest_path = root / "cloud_demo_lineage_manifest.json"
        if not manifest_path.exists():
            self.skipTest("Run the ML-R5B lineage builder first")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["products_count"], 60)
        self.assertEqual(manifest["calendar_rows"], 181)
        self.assertEqual(manifest["price_rows"], 10_860)
        for artifact in manifest["artifacts"].values():
            path = repository_path(artifact["path"])
            self.assertEqual(sha256_file(path), artifact["sha256"])
            self.assertEqual(path.stat().st_size, artifact["size_bytes"])

    def test_generated_lineage_equals_validated_bronze_when_available(self) -> None:
        bronze = repository_path("ml/data/bronze/m5_store_daily.parquet")
        root = repository_path("ml/data/serving")
        manifest_path = root / "cloud_demo_lineage_manifest.json"
        if not bronze.exists() or not manifest_path.exists():
            self.skipTest("Bronze and generated lineage are required")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        scenario = json.loads(
            repository_path("ml/reports/scenario_cloud_demo_manifest.json").read_text(
                encoding="utf-8"
            )
        )
        config = load_scenario_config("ml/config/scenario_cloud_demo.toml")
        connection = connect_duckdb()
        try:
            connection.execute(
                "CREATE TEMP TABLE selected_products(item_id VARCHAR PRIMARY KEY)"
            )
            connection.executemany(
                "INSERT INTO selected_products VALUES (?)",
                [(item,) for item in scenario["selected_products"]],
            )
            create_lineage_views(
                connection,
                bronze,
                store_id=config.source_store,
                source_start=config.source_start,
                source_end=config.source_end,
                scenario_id=config.scenario_id,
            )
            for key, view in {
                "products": "product_lineage",
                "calendar": "calendar_lineage",
                "prices": "price_lineage",
            }.items():
                artifact = repository_path(manifest["artifacts"][key]["path"])
                mismatch = connection.execute(
                    f"""
                    SELECT count(*) FROM (
                      (SELECT * FROM {view} EXCEPT
                       SELECT * FROM read_parquet({sql_literal(artifact)}))
                      UNION ALL
                      (SELECT * FROM read_parquet({sql_literal(artifact)}) EXCEPT
                       SELECT * FROM {view})
                    )
                    """
                ).fetchone()[0]
                self.assertEqual(mismatch, 0, key)
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
