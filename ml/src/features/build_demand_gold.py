from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from ml.src.common import measured_run, repository_path, sha256_file, sql_literal
from ml.src.m5 import connect_duckdb


FEATURE_SET_VERSION = "demand-v1"
EXPECTED_BRONZE_SHA256 = "3029c1b390d96a2da02c589df9b7e750be458bea5bc04855dc5942e2cc96c8a6"
DEFAULT_BRONZE = "ml/data/bronze/m5_store_daily.parquet"
DEFAULT_OUTPUT = "ml/data/gold/demand_features_v1.parquet"
EXPECTED_COUNTS = {
    "bronze_rows": 5_918_109,
    "active_rows": 4_757_313,
    "eligible_rows": 4_565_226,
    "train_rows": 4_010_863,
    "validation_rows": 255_756,
    "test_rows": 255_989,
    "purged_rows": 42_618,
    "products": 3_049,
}


def _configure_duckdb(connection: Any, temporary_directory: Path) -> None:
    connection.execute("SET memory_limit = '6GB'")
    connection.execute("SET threads = 4")
    connection.execute("SET preserve_insertion_order = false")
    connection.execute(f"SET temp_directory = {sql_literal(temporary_directory)}")


def _create_views(connection: Any, bronze: Path) -> None:
    source = f"read_parquet({sql_literal(bronze)})"
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW source_with_active_start AS
        SELECT
          store_id, item_id, dept_id, cat_id, source_date,
          units_sold, sell_price,
          event_name_1, event_type_1, event_name_2, event_type_2, snap_CA,
          min(source_date) FILTER (WHERE sell_price IS NOT NULL)
            OVER (PARTITION BY item_id) AS active_start
        FROM {source}
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW active_base AS
        SELECT
          *,
          sell_price IS NULL AS price_missing_active,
          last_value(sell_price IGNORE NULLS) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS filled_sell_price
        FROM source_with_active_start
        WHERE active_start IS NOT NULL AND source_date >= active_start
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW window_features AS
        SELECT
          *,
          lag(units_sold, 1) OVER item_days AS lag_1,
          lag(units_sold, 7) OVER item_days AS lag_7,
          lag(units_sold, 14) OVER item_days AS lag_14,
          lag(units_sold, 28) OVER item_days AS lag_28,
          lag(units_sold, 56) OVER item_days AS lag_56,
          sum(units_sold) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
          ) AS rolling_sum_7,
          avg(units_sold) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
          ) AS rolling_mean_28,
          stddev_samp(units_sold) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
          ) AS rolling_std_28,
          avg(units_sold) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 55 PRECEDING AND CURRENT ROW
          ) AS rolling_mean_56,
          max(CASE WHEN units_sold > 0 THEN source_date END) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS last_sale_date,
          sum(CASE WHEN units_sold > 0 THEN 1 ELSE 0 END) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
          ) AS sale_days_last_28,
          avg(CASE WHEN units_sold > 0 THEN 1.0 ELSE 0.0 END) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 55 PRECEDING AND CURRENT ROW
          ) AS nonzero_rate_56,
          lag(filled_sell_price, 7) OVER item_days AS sell_price_lag_7,
          avg(filled_sell_price) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
          ) AS sell_price_mean_28,
          sum(units_sold) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 1 FOLLOWING AND 7 FOLLOWING
          ) AS target_units_next_7_days,
          count(*) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN 1 FOLLOWING AND 7 FOLLOWING
          ) AS target_day_count
        FROM active_base
        WINDOW item_days AS (PARTITION BY item_id ORDER BY source_date)
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW eligible_gold AS
        SELECT
          'demand-v1'::VARCHAR AS feature_set_version,
          store_id,
          item_id,
          source_date,
          active_start,
          true AS is_active_assortment,
          CASE
            WHEN source_date <= DATE '2015-11-15' THEN 'train'
            WHEN source_date BETWEEN DATE '2015-11-23' AND DATE '2016-02-14'
              THEN 'validation'
            WHEN source_date BETWEEN DATE '2016-02-22' AND DATE '2016-05-15'
              THEN 'test'
          END AS split,
          cat_id,
          dept_id,
          CAST(date_diff('day', active_start, source_date) AS SMALLINT)
            AS active_age_days,
          CAST(round(units_sold) AS INTEGER) AS current_units,
          CAST(round(lag_1) AS INTEGER) AS lag_1,
          CAST(round(lag_7) AS INTEGER) AS lag_7,
          CAST(round(lag_14) AS INTEGER) AS lag_14,
          CAST(round(lag_28) AS INTEGER) AS lag_28,
          CAST(round(lag_56) AS INTEGER) AS lag_56,
          CAST(round(rolling_sum_7) AS INTEGER) AS rolling_sum_7,
          CAST(rolling_mean_28 AS FLOAT) AS rolling_mean_28,
          CAST(rolling_std_28 AS FLOAT) AS rolling_std_28,
          CAST(rolling_mean_56 AS FLOAT) AS rolling_mean_56,
          CAST(
            CASE
              WHEN last_sale_date IS NULL
                THEN date_diff('day', active_start, source_date) + 1
              ELSE date_diff('day', last_sale_date, source_date)
            END AS SMALLINT
          ) AS days_since_last_sale,
          CAST(last_sale_date IS NOT NULL AS TINYINT) AS has_prior_sale,
          CAST(sale_days_last_28 AS TINYINT) AS sale_days_last_28,
          CAST(nonzero_rate_56 AS FLOAT) AS nonzero_rate_56,
          CAST(dayofweek(source_date) AS TINYINT) AS day_of_week,
          CAST(weekofyear(source_date) AS TINYINT) AS week_of_year,
          CAST(month(source_date) AS TINYINT) AS month,
          CAST(quarter(source_date) AS TINYINT) AS quarter,
          CAST(dayofweek(source_date) IN (0, 6) AS TINYINT) AS is_weekend,
          coalesce(event_name_1, '__NONE__')::VARCHAR AS event_name_1,
          coalesce(event_type_1, '__NONE__')::VARCHAR AS event_type_1,
          coalesce(event_name_2, '__NONE__')::VARCHAR AS event_name_2,
          coalesce(event_type_2, '__NONE__')::VARCHAR AS event_type_2,
          CAST(snap_CA AS TINYINT) AS snap_CA,
          CAST(filled_sell_price AS FLOAT) AS sell_price,
          CAST(
            CASE WHEN sell_price_lag_7 > 0
              THEN filled_sell_price / sell_price_lag_7 - 1
            END AS FLOAT
          ) AS price_change_pct_7,
          CAST(
            CASE WHEN sell_price_mean_28 > 0
              THEN filled_sell_price / sell_price_mean_28
            END AS FLOAT
          ) AS price_relative_to_recent_mean_28,
          CAST(price_missing_active AS TINYINT) AS price_missing_active,
          CAST(round(target_units_next_7_days) AS INTEGER)
            AS target_units_next_7_days
        FROM window_features
        WHERE date_diff('day', active_start, source_date) >= 56
          AND target_day_count = 7
        """
    )


def _scalar(connection: Any, query: str) -> Any:
    return connection.execute(query).fetchone()[0]


def build_demand_gold(
    bronze_path: str | Path = DEFAULT_BRONZE,
    output_path: str | Path = DEFAULT_OUTPUT,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    bronze = repository_path(bronze_path).resolve()
    output = repository_path(output_path).resolve()
    if not bronze.is_file():
        raise FileNotFoundError(f"Bronze input does not exist: {bronze}")
    if sha256_file(bronze) != EXPECTED_BRONZE_SHA256:
        raise RuntimeError("Bronze SHA-256 does not match the validated ML-R2A artifact")
    if output.exists() and not overwrite:
        raise FileExistsError(f"Gold output already exists: {output}; use --overwrite")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(output.suffix + ".tmp")
    if temporary_output.exists():
        temporary_output.unlink()

    temporary_directory = Path(tempfile.mkdtemp(prefix="demand-v1-duckdb-", dir=output.parent))
    connection = connect_duckdb()
    try:
        _configure_duckdb(connection, temporary_directory)
        with measured_run() as performance:
            _create_views(connection, bronze)

            bronze_rows = _scalar(connection, "SELECT count(*) FROM source_with_active_start")
            active_rows = _scalar(connection, "SELECT count(*) FROM active_base")
            source_products = _scalar(
                connection, "SELECT count(DISTINCT item_id) FROM active_base"
            )
            invalid_units = _scalar(
                connection,
                """
                SELECT count(*) FROM active_base
                WHERE units_sold IS NULL OR NOT isfinite(units_sold)
                  OR units_sold < 0 OR units_sold != round(units_sold)
                """,
            )
            if invalid_units:
                raise ValueError(f"Bronze has {invalid_units} invalid unit rows")

            continuity_errors = _scalar(
                connection,
                """
                SELECT count(*) FROM (
                  SELECT source_date,
                         lead(source_date) OVER (
                           PARTITION BY item_id ORDER BY source_date
                         ) AS next_date
                  FROM active_base
                )
                WHERE next_date IS NOT NULL
                  AND date_diff('day', source_date, next_date) != 1
                """,
            )
            if continuity_errors:
                raise ValueError(
                    f"Active product histories contain {continuity_errors} date gaps"
                )

            eligible_rows = _scalar(connection, "SELECT count(*) FROM eligible_gold")
            split_rows = dict(
                connection.execute(
                    """
                    SELECT split, count(*)
                    FROM eligible_gold
                    WHERE split IS NOT NULL
                    GROUP BY split
                    """
                ).fetchall()
            )
            purged_rows = eligible_rows - sum(split_rows.values())

            invalid_features = _scalar(
                connection,
                """
                SELECT count(*) FROM eligible_gold
                WHERE current_units < 0 OR target_units_next_7_days < 0
                  OR sell_price IS NULL OR sell_price <= 0
                  OR NOT isfinite(sell_price)
                  OR price_change_pct_7 IS NULL
                  OR NOT isfinite(price_change_pct_7)
                  OR price_relative_to_recent_mean_28 IS NULL
                  OR NOT isfinite(price_relative_to_recent_mean_28)
                """,
            )
            if invalid_features:
                raise ValueError(
                    f"Gold candidate contains {invalid_features} invalid numeric rows"
                )

            connection.execute(
                f"""
                    COPY (
                      SELECT * FROM eligible_gold
                      WHERE split IS NOT NULL
                      ORDER BY item_id, source_date
                    ) TO {sql_literal(temporary_output)}
                    (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)
                """
            )

            written_rows = _scalar(
                connection,
                f"SELECT count(*) FROM read_parquet({sql_literal(temporary_output)})",
            )
            duplicate_keys = _scalar(
                connection,
                f"""
                SELECT count(*) - count(DISTINCT (store_id, item_id, source_date))
                FROM read_parquet({sql_literal(temporary_output)})
                """,
            )
            ordering_errors = _scalar(
                connection,
                f"""
                SELECT count(*) FROM (
                  SELECT item_id, source_date,
                         lag(item_id) OVER () AS previous_item,
                         lag(source_date) OVER () AS previous_date
                  FROM read_parquet({sql_literal(temporary_output)})
                )
                WHERE previous_item > item_id
                   OR (previous_item = item_id AND previous_date >= source_date)
                """,
            )
            if written_rows != sum(split_rows.values()):
                raise RuntimeError("Written Gold row count differs from selected rows")
            if duplicate_keys or ordering_errors:
                raise RuntimeError(
                    "Gold key uniqueness or stable ordering validation failed"
                )

            actual_counts = {
                "bronze_rows": bronze_rows,
                "active_rows": active_rows,
                "eligible_rows": eligible_rows,
                "train_rows": split_rows.get("train", 0),
                "validation_rows": split_rows.get("validation", 0),
                "test_rows": split_rows.get("test", 0),
                "purged_rows": purged_rows,
                "products": source_products,
            }
            deviations = {
                key: {"expected": expected, "actual": actual_counts[key]}
                for key, expected in EXPECTED_COUNTS.items()
                if actual_counts[key] != expected
            }
            if deviations:
                raise RuntimeError(f"Gold counts differ from ML-R3A: {deviations}")

        if sha256_file(bronze) != EXPECTED_BRONZE_SHA256:
            raise RuntimeError("Bronze changed during Gold construction")
        os.replace(temporary_output, output)
        return {
            "feature_set_version": FEATURE_SET_VERSION,
            "output": str(output),
            **actual_counts,
            "continuity_errors": continuity_errors,
            "written_rows": written_rows,
            "parquet_size_bytes": output.stat().st_size,
            "performance": performance,
            "deviations": deviations,
        }
    except Exception:
        if temporary_output.exists():
            temporary_output.unlink()
        raise
    finally:
        connection.close()
        shutil.rmtree(temporary_directory, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build causal demand-v1 Gold Parquet")
    parser.add_argument("--bronze", default=DEFAULT_BRONZE)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--overwrite", action="store_true")
    arguments = parser.parse_args()
    try:
        result = build_demand_gold(
            arguments.bronze,
            arguments.output,
            overwrite=arguments.overwrite,
        )
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError) as error:
        print(f"ML-R3B.1 Gold construction failed: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
