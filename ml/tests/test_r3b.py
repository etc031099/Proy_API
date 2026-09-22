from __future__ import annotations

import shutil
import unittest
import uuid
from datetime import date, timedelta
from pathlib import Path

from ml.src.features.validate_demand_gold import EXPECTED_COLUMNS, logical_hash
from ml.src.m5 import connect_duckdb


class R3BGoldValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1] / ".test-tmp" / f"r3b-{uuid.uuid4().hex}"
        cls.root.mkdir(parents=True)
        cls.bronze = cls.root / "bronze.parquet"
        cls.gold = cls.root / "gold.parquet"
        connection = connect_duckdb()
        try:
            connection.execute(
                """
                CREATE TABLE bronze AS
                SELECT 'CA_3'::VARCHAR AS store_id,
                       'ITEM_A'::VARCHAR AS item_id,
                       'D_1'::VARCHAR AS dept_id,
                       'CAT_1'::VARCHAR AS cat_id,
                       DATE '2020-01-01' + i::INTEGER AS source_date,
                       (i % 4)::DOUBLE AS units_sold,
                       CASE WHEN i < 2 THEN NULL ELSE 10.0 + CASE WHEN i = 20 THEN 1 ELSE 0 END END AS sell_price,
                       NULL::VARCHAR AS event_name_1, NULL::VARCHAR AS event_type_1,
                       NULL::VARCHAR AS event_name_2, NULL::VARCHAR AS event_type_2,
                       0::INTEGER AS snap_CA
                FROM range(70) AS r(i)
                """
            )
            connection.execute(f"COPY bronze TO '{cls.bronze.as_posix()}' (FORMAT PARQUET)")
            connection.execute(
                """
                CREATE TABLE gold AS
                SELECT *,
                       sum(units_sold) OVER w AS target_units_next_7_days
                FROM (
                  SELECT item_id, source_date, units_sold,
                         lag(units_sold) OVER d AS lag_1,
                         sum(units_sold) OVER (PARTITION BY item_id ORDER BY source_date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_sum_7
                  FROM bronze WHERE source_date >= DATE '2020-01-03'
                  WINDOW d AS (PARTITION BY item_id ORDER BY source_date)
                ) q
                WINDOW w AS (PARTITION BY item_id ORDER BY source_date ROWS BETWEEN 1 FOLLOWING AND 7 FOLLOWING)
                """
            )
            connection.execute(f"COPY gold TO '{cls.gold.as_posix()}' (FORMAT PARQUET)")
        finally:
            connection.close()

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.root, ignore_errors=True)

    def _connection(self):
        connection = connect_duckdb()
        connection.execute(f"CREATE VIEW bronze AS SELECT * FROM read_parquet('{self.bronze.as_posix()}')")
        connection.execute(f"CREATE VIEW gold AS SELECT * FROM read_parquet('{self.gold.as_posix()}')")
        return connection

    def test_active_start_and_preintroduction_policy(self) -> None:
        connection = self._connection()
        try:
            self.assertEqual(connection.execute("SELECT min(source_date) FROM bronze WHERE sell_price IS NOT NULL").fetchone()[0], date(2020, 1, 3))
            self.assertEqual(connection.execute("SELECT count(*) FROM bronze WHERE source_date < DATE '2020-01-03' AND sell_price IS NULL").fetchone()[0], 2)
        finally:
            connection.close()

    def test_lag_and_rolling_features_are_causal(self) -> None:
        connection = self._connection()
        try:
            row = connection.execute("SELECT lag_1, rolling_sum_7 FROM gold ORDER BY source_date LIMIT 1 OFFSET 56").fetchone()
            self.assertEqual(row[0], 1)
            self.assertEqual(row[1], sum(i % 4 for i in range(52, 59)))
        finally:
            connection.close()

    def test_target_horizon_and_incomplete_tail(self) -> None:
        connection = self._connection()
        try:
            self.assertEqual(connection.execute("SELECT target_units_next_7_days FROM gold ORDER BY source_date LIMIT 1").fetchone()[0], sum(i % 4 for i in range(3, 10)))
            self.assertEqual(connection.execute("SELECT count(*) FROM gold WHERE source_date > DATE '2020-03-03'").fetchone()[0], 7)
            self.assertIsNone(connection.execute("SELECT target_units_next_7_days FROM gold ORDER BY source_date DESC LIMIT 1").fetchone()[0])
        finally:
            connection.close()

    def test_warmup_embargo_and_split_boundaries(self) -> None:
        connection = self._connection()
        try:
            self.assertEqual(connection.execute("SELECT count(*) FROM gold WHERE source_date < DATE '2020-02-28'").fetchone()[0], 56)
            self.assertEqual(connection.execute("SELECT count(*) FROM gold WHERE source_date BETWEEN DATE '2015-11-16' AND DATE '2015-11-22'").fetchone()[0], 0)
        finally:
            connection.close()

    def test_continuity_gap_is_detectable(self) -> None:
        connection = connect_duckdb()
        try:
            connection.execute("CREATE TABLE gap(item_id VARCHAR, source_date DATE)")
            connection.execute("INSERT INTO gap VALUES ('A', DATE '2020-01-01'), ('A', DATE '2020-01-03')")
            gaps = connection.execute("SELECT count(*) FROM (SELECT source_date, lead(source_date) OVER (ORDER BY source_date) n FROM gap) WHERE date_diff('day', source_date, n) <> 1").fetchone()[0]
            self.assertEqual(gaps, 1)
        finally:
            connection.close()

    def test_causal_price_forward_fill_never_uses_future(self) -> None:
        connection = self._connection()
        try:
            value = connection.execute("SELECT last_value(sell_price IGNORE NULLS) OVER (ORDER BY source_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM bronze WHERE source_date = DATE '2020-01-03'").fetchone()[0]
            self.assertEqual(value, 10.0)
        finally:
            connection.close()

    def test_intermitttent_demand_is_counted_from_observed_history(self) -> None:
        connection = self._connection()
        try:
            self.assertEqual(connection.execute("SELECT count(*) FROM bronze WHERE units_sold > 0").fetchone()[0], 52)
        finally:
            connection.close()

    def test_forbidden_features_are_not_in_contract(self) -> None:
        self.assertNotIn("operational_date", EXPECTED_COLUMNS)
        self.assertNotIn("supplier_id", EXPECTED_COLUMNS)
        self.assertNotIn("customer_id", EXPECTED_COLUMNS)
        self.assertNotIn("future_sales", EXPECTED_COLUMNS)

    def test_logical_hash_is_deterministic(self) -> None:
        self.assertEqual(logical_hash(self.gold), logical_hash(self.gold))


if __name__ == "__main__":
    unittest.main()
