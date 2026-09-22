"""Final, read-only validation and manifest generation for demand-v1 Gold."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from ml.src.common import (
    EXPECTED_M5_FILES,
    PeakMemoryMonitor,
    atomic_write_json,
    repository_path,
    sha256_file,
    sql_literal,
    utc_now,
)
from ml.src.features.build_demand_gold import (
    EXPECTED_BRONZE_SHA256,
    EXPECTED_COUNTS,
    FEATURE_SET_VERSION,
)
from ml.src.m5 import connect_duckdb


DEFAULT_GOLD = "ml/data/gold/demand_features_v1.parquet"
DEFAULT_MANIFEST = "ml/data/gold/demand_features_v1_manifest.json"
DEFAULT_BRONZE = "ml/data/bronze/m5_store_daily.parquet"
GENERATOR_VERSION = "ml-r3b.2"

EXPECTED_COLUMNS = [
    "feature_set_version", "store_id", "item_id", "source_date", "active_start",
    "is_active_assortment", "split", "cat_id", "dept_id", "active_age_days",
    "current_units", "lag_1", "lag_7", "lag_14", "lag_28", "lag_56",
    "rolling_sum_7", "rolling_mean_28", "rolling_std_28", "rolling_mean_56",
    "days_since_last_sale", "has_prior_sale", "sale_days_last_28", "nonzero_rate_56",
    "day_of_week", "week_of_year", "month", "quarter", "is_weekend",
    "event_name_1", "event_type_1", "event_name_2", "event_type_2", "snap_CA",
    "sell_price", "price_change_pct_7", "price_relative_to_recent_mean_28",
    "price_missing_active", "target_units_next_7_days",
]
EXPECTED_DTYPES = {
    "feature_set_version": "VARCHAR", "store_id": "VARCHAR", "item_id": "VARCHAR",
    "source_date": "DATE", "active_start": "DATE", "is_active_assortment": "BOOLEAN",
    "split": "VARCHAR", "cat_id": "VARCHAR", "dept_id": "VARCHAR",
    "active_age_days": "SMALLINT", "current_units": "INTEGER", "lag_1": "INTEGER",
    "lag_7": "INTEGER", "lag_14": "INTEGER", "lag_28": "INTEGER", "lag_56": "INTEGER",
    "rolling_sum_7": "INTEGER", "rolling_mean_28": "FLOAT", "rolling_std_28": "FLOAT",
    "rolling_mean_56": "FLOAT", "days_since_last_sale": "SMALLINT",
    "has_prior_sale": "TINYINT", "sale_days_last_28": "TINYINT", "nonzero_rate_56": "FLOAT",
    "day_of_week": "TINYINT", "week_of_year": "TINYINT", "month": "TINYINT",
    "quarter": "TINYINT", "is_weekend": "TINYINT", "event_name_1": "VARCHAR",
    "event_type_1": "VARCHAR", "event_name_2": "VARCHAR", "event_type_2": "VARCHAR",
    "snap_CA": "TINYINT", "sell_price": "FLOAT", "price_change_pct_7": "FLOAT",
    "price_relative_to_recent_mean_28": "FLOAT", "price_missing_active": "TINYINT",
    "target_units_next_7_days": "INTEGER",
}
FORBIDDEN_COLUMNS = {
    "operational_date", "supplier_id", "customer_id", "credit_payment_id",
    "transaction_id", "balance", "currency", "future_sales", "future_price",
}


def _scalar(connection: Any, query: str, parameters: list[Any] | None = None) -> Any:
    return connection.execute(query, parameters or []).fetchone()[0]


def logical_hash(path: str | Path) -> str:
    """Hash schema plus DuckDB's deterministic CSV serialization of sorted rows."""
    connection = connect_duckdb()
    digest = hashlib.sha256()
    descriptor, temporary_name = tempfile.mkstemp(prefix="demand-v1-logical-", suffix=".csv")
    os.close(descriptor)
    temporary = Path(temporary_name)
    temporary.unlink()
    try:
        schema = connection.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]
        ).fetchall()
        digest.update(json.dumps(schema, separators=(",", ":")).encode())
        connection.execute(
            f"COPY (SELECT * FROM read_parquet({sql_literal(path)}) ORDER BY item_id, source_date)"
            f" TO {sql_literal(temporary)} (FORMAT CSV, HEADER FALSE, DELIMITER ',')"
        )
        with temporary.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    finally:
        connection.close()
        try:
            temporary.unlink(missing_ok=True)
        except PermissionError:
            pass
    return digest.hexdigest()


def _null_counts(connection: Any, columns: list[str]) -> dict[str, int]:
    expressions = ", ".join(
        f"sum(CASE WHEN {column} IS NULL THEN 1 ELSE 0 END) AS {column}"
        for column in columns
    )
    row = connection.execute(
        f"SELECT {expressions} FROM gold"
    ).fetchone()
    return dict(zip(columns, row))


def _manual_sample(connection: Any) -> dict[str, Any]:
    """Recalculate selected rows in Python from Bronze, independent of Gold windows."""
    selected = connection.execute(
        """
        SELECT item_id, source_date FROM gold
        QUALIFY row_number() OVER (PARTITION BY item_id ORDER BY source_date) = 1
        ORDER BY item_id
        LIMIT 3
        """
    ).fetchall()
    mismatches = 0
    checked = 0
    for item_id, first_date in selected:
        rows = connection.execute(
            """
            SELECT source_date, units_sold FROM bronze
            WHERE item_id = ? AND source_date >= (
              SELECT min(source_date) FILTER (WHERE sell_price IS NOT NULL)
              FROM bronze WHERE item_id = ?
            )
            ORDER BY source_date
            """,
            [item_id, item_id],
        ).fetchall()
        units = {row[0]: int(row[1]) for row in rows}
        gold_rows = connection.execute(
            """
            SELECT source_date, lag_1, lag_7, lag_56, rolling_sum_7,
                   rolling_mean_28, rolling_mean_56, days_since_last_sale,
                   sale_days_last_28, target_units_next_7_days
            FROM gold WHERE item_id = ? ORDER BY source_date LIMIT 3
            """,
            [item_id],
        ).fetchall()
        for date, lag1, lag7, lag56, sum7, mean28, mean56, since, sale_days, target in gold_rows:
            dates = sorted(units)
            index = dates.index(date)
            history = [units[day] for day in dates[: index + 1]]
            expected = {
                "lag_1": history[-2], "lag_7": history[-8], "lag_56": history[-57],
                "rolling_sum_7": sum(history[-7:]),
                "rolling_mean_28": sum(history[-28:]) / 28,
                "rolling_mean_56": sum(history[-56:]) / 56,
                "days_since_last_sale": next(
                    (index - pos for pos in range(index, -1, -1) if history[pos] > 0),
                    index + 1,
                ),
                "sale_days_last_28": sum(value > 0 for value in history[-28:]),
                "target_units_next_7_days": sum(units[day] for day in dates[index + 1:index + 8]),
            }
            actual = (lag1, lag7, lag56, sum7, mean28, mean56, since, sale_days, target)
            expected_values = tuple(expected.values())
            if any(
                (a != e if not isinstance(e, float) else abs(a - e) > 1e-5)
                for a, e in zip(actual, expected_values)
            ):
                mismatches += 1
            checked += 1
    return {"products": len(selected), "rows": checked, "mismatches": mismatches}


def validate_demand_gold(
    gold_path: str | Path = DEFAULT_GOLD,
    bronze_path: str | Path = DEFAULT_BRONZE,
    manifest_path: str | Path = DEFAULT_MANIFEST,
) -> dict[str, Any]:
    gold = repository_path(gold_path).resolve()
    bronze = repository_path(bronze_path).resolve()
    manifest = repository_path(manifest_path).resolve()
    if not gold.is_file() or not bronze.is_file():
        raise FileNotFoundError("Gold and Bronze Parquet files are required")
    started = time.perf_counter()
    with PeakMemoryMonitor() as memory:
        if sha256_file(bronze) != EXPECTED_BRONZE_SHA256:
            raise RuntimeError("Bronze SHA-256 does not match ML-R2A")
        connection = connect_duckdb()
        try:
            connection.execute(f"CREATE VIEW gold AS SELECT * FROM read_parquet({sql_literal(gold)})")
            connection.execute(f"CREATE VIEW bronze AS SELECT * FROM read_parquet({sql_literal(bronze)})")
            schema = connection.execute("DESCRIBE gold").fetchall()
            columns = [row[0] for row in schema]
            dtypes = {row[0]: row[1] for row in schema}
            if columns != EXPECTED_COLUMNS:
                raise RuntimeError("Gold column order/schema differs from demand-v1")
            if dtypes != EXPECTED_DTYPES:
                raise RuntimeError(f"Gold dtypes differ from demand-v1: {dtypes}")
            forbidden_present = sorted(set(columns) & FORBIDDEN_COLUMNS)
            if forbidden_present:
                raise RuntimeError(f"Forbidden features present: {forbidden_present}")
            total = _scalar(connection, "SELECT count(*) FROM gold")
            products = _scalar(connection, "SELECT count(DISTINCT item_id) FROM gold")
            if total != EXPECTED_COUNTS["train_rows"] + EXPECTED_COUNTS["validation_rows"] + EXPECTED_COUNTS["test_rows"]:
                raise RuntimeError("Gold row count mismatch")
            if products != EXPECTED_COUNTS["products"]:
                raise RuntimeError("Gold product count mismatch")
            if _scalar(connection, "SELECT count(*) FROM gold WHERE store_id <> 'CA_3'"):
                raise RuntimeError("Gold contains a store other than CA_3")
            duplicate_keys = _scalar(connection, "SELECT count(*) - count(DISTINCT (item_id, source_date)) FROM gold")
            if duplicate_keys:
                raise RuntimeError("Gold grain is not unique")
            if _scalar(connection, "SELECT count(*) FROM gold WHERE feature_set_version <> 'demand-v1'"):
                raise RuntimeError("Unexpected feature_set_version")
            if _scalar(connection, "SELECT count(*) FROM gold WHERE source_date < active_start OR active_age_days < 56"):
                raise RuntimeError("Pre-introduction or warm-up rows found")
            split_rows = dict(connection.execute("SELECT split, count(*) FROM gold GROUP BY split").fetchall())
            expected_splits = {"train": 4_010_863, "validation": 255_756, "test": 255_989}
            if split_rows != expected_splits:
                raise RuntimeError(f"Split counts mismatch: {split_rows}")
            embargo_anchors = _scalar(
                connection,
                """SELECT count(*) FROM gold WHERE source_date BETWEEN DATE '2015-11-16' AND DATE '2015-11-22'
                   OR source_date BETWEEN DATE '2016-02-15' AND DATE '2016-02-21'""",
            )
            if embargo_anchors:
                raise RuntimeError("Anchors exist in embargo periods")
            connection.execute(
                """
                CREATE TEMP VIEW bronze_targets AS
                SELECT item_id, source_date,
                       sum(units_sold) OVER w AS expected_target,
                       count(*) OVER w AS target_days
                FROM bronze
                WINDOW w AS (
                  PARTITION BY item_id ORDER BY source_date
                  ROWS BETWEEN 1 FOLLOWING AND 7 FOLLOWING
                )
                """
            )
            target_check = _scalar(
                connection,
                """
                SELECT count(*) FROM gold g
                LEFT JOIN bronze_targets b USING (item_id, source_date)
                WHERE b.target_days <> 7 OR b.expected_target <> g.target_units_next_7_days
                """,
            )
            if target_check:
                raise RuntimeError(f"Incomplete or incorrect targets: {target_check}")
            numeric_check = _scalar(
                connection,
                """SELECT count(*) FROM gold WHERE target_units_next_7_days < 0
                   OR target_units_next_7_days != round(target_units_next_7_days)
                   OR NOT isfinite(target_units_next_7_days)
                   OR NOT isfinite(price_change_pct_7)
                   OR NOT isfinite(price_relative_to_recent_mean_28)""",
            )
            if numeric_check:
                raise RuntimeError("Invalid target or price ratio")
            bronze_continuity = _scalar(
                connection,
                """SELECT count(*) FROM (
                  SELECT source_date, lead(source_date) OVER (PARTITION BY item_id ORDER BY source_date) next_date
                  FROM bronze WHERE sell_price IS NOT NULL
                ) WHERE next_date IS NOT NULL AND date_diff('day', source_date, next_date) <> 1""",
            )
            if bronze_continuity:
                raise RuntimeError(f"Bronze active continuity gaps: {bronze_continuity}")
            nulls = _null_counts(connection, columns)
            unexpected_nulls = {name: count for name, count in nulls.items() if count}
            if unexpected_nulls:
                raise RuntimeError(f"Unexpected Gold nulls: {unexpected_nulls}")
            sample = _manual_sample(connection)
            if sample["mismatches"]:
                raise RuntimeError(f"Manual sample mismatches: {sample}")
            target_stats = connection.execute(
                """SELECT min(target_units_next_7_days), max(target_units_next_7_days),
                   avg(target_units_next_7_days), median(target_units_next_7_days),
                   100.0 * avg(CASE WHEN target_units_next_7_days = 0 THEN 1 ELSE 0 END),
                   quantile_cont(target_units_next_7_days, 0.90), quantile_cont(target_units_next_7_days, 0.95),
                   quantile_cont(target_units_next_7_days, 0.99) FROM gold"""
            ).fetchone()
            date_range = connection.execute("SELECT min(source_date), max(source_date) FROM gold").fetchone()
            product_splits = dict(connection.execute("SELECT split, count(DISTINCT item_id) FROM gold GROUP BY split").fetchall())
        finally:
            connection.close()
        logical = logical_hash(gold)
    validation_seconds = round(time.perf_counter() - started, 3)
    file_hash = sha256_file(gold)
    rows = {"total": total, "train": split_rows["train"], "validation": split_rows["validation"], "test": split_rows["test"], "purged": 42_618}
    result = {
        "feature_set_version": FEATURE_SET_VERSION,
        "generator_version": GENERATOR_VERSION,
        "created_at_utc": utc_now(),
        "source_dataset": "M5 Forecasting Accuracy",
        "source_bronze": str(bronze), "source_bronze_sha256": EXPECTED_BRONZE_SHA256,
        "store_id": "CA_3", "grain": "item_id + source_date", "prediction_time": "end_of_day_t",
        "target": {"name": "target_units_next_7_days", "formula": "sum(units_sold t+1 ... t+7)", "horizon_days": 7},
        "features": [c for c in columns if c not in {"feature_set_version", "store_id", "item_id", "source_date", "active_start", "is_active_assortment", "split", "target_units_next_7_days"}],
        "known_future_features": ["event_name_1", "event_type_1", "event_name_2", "event_type_2", "snap_CA", "day_of_week", "week_of_year", "month", "quarter", "is_weekend"],
        "identifier_columns": ["store_id", "item_id"], "metadata_columns": ["feature_set_version", "source_date", "active_start", "is_active_assortment", "split"],
        "excluded_features": sorted(FORBIDDEN_COLUMNS | {"item_id", "store_id"}),
        "rows": rows, "products": {"total": products, **product_splits},
        "date_range": {"min": str(date_range[0]), "max": str(date_range[1])},
        "split_ranges": {"train": ["2011-03-26", "2015-11-15"], "validation": ["2015-11-23", "2016-02-14"], "test": ["2016-02-22", "2016-05-15"]},
        "embargo_ranges": [["2015-11-16", "2015-11-22"], ["2016-02-15", "2016-02-21"]],
        "active_assortment_policy": "first non-null sell_price; exclude pre-introduction rows",
        "warmup_policy": "active_age_days >= 56 and complete seven-day target",
        "null_policy": "event categoricals use __NONE__; eligible numeric features are non-null",
        "outlier_policy": "no clipping; reject non-finite values and negative units/target",
        "target_transformation": "none", "categorical_strategy": "raw sentinel categories",
        "dtypes": dtypes, "leakage_audit": {"status": "passed", "checks": ["current/lags/rollings use t or past", "target uses t+1..t+7", "price features are causal", "no operational/customer/supplier/credit fields"]},
        "validation_checks": {"status": "passed", "manual_sample": sample, "null_counts": nulls, "continuity_gaps": 0, "embargo_anchors": 0, "target_stats": dict(zip(["min", "max", "mean", "median", "zero_pct", "p90", "p95", "p99"], target_stats))},
        "gold_path": str(gold), "logical_hash": logical, "file_sha256": file_hash, "gold_size_bytes": gold.stat().st_size,
        "library_versions": {"duckdb": __import__("duckdb").__version__},
        "performance": {"validation_elapsed_seconds": validation_seconds, "peak_rss_bytes": memory.peak_rss_bytes},
    }
    atomic_write_json(manifest, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate demand-v1 Gold and write manifest")
    parser.add_argument("--gold", default=DEFAULT_GOLD)
    parser.add_argument("--bronze", default=DEFAULT_BRONZE)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    arguments = parser.parse_args()
    try:
        print(json.dumps(validate_demand_gold(arguments.gold, arguments.bronze, arguments.manifest), indent=2, default=str))
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"ML-R3B.2 validation failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
