from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import duckdb

from ml.src.common import (
    PeakMemoryMonitor,
    atomic_write_json,
    repository_path,
    sha256_file,
    sql_literal,
    utc_now,
)
from ml.src.m5 import connect_duckdb
from ml.src.scenario.config import load_scenario_config


LINEAGE_VERSION = "cloud-demo-lineage-v1"
BUSINESS_ID = "ML-CLOUD-DEMO"
SCENARIO_ID = "m5-ca3-cloud-demo-v1"
EXPECTED_PRODUCTS = 60
EXPECTED_OFFSET_DAYS = 3654
DEFAULT_CONFIG = "ml/config/scenario_cloud_demo.toml"
DEFAULT_SCENARIO_MANIFEST = "ml/reports/scenario_cloud_demo_manifest.json"
DEFAULT_BRONZE_MANIFEST = "ml/data/bronze/m5_bronze_manifest.json"
DEFAULT_OUTPUT_DIRECTORY = "ml/data/serving"

ARTIFACT_NAMES = {
    "products": "cloud_demo_product_lineage.parquet",
    "calendar": "cloud_demo_calendar.parquet",
    "prices": "cloud_demo_price_lineage.parquet",
}
MANIFEST_NAME = "cloud_demo_lineage_manifest.json"


def source_to_operational(value: date, offset_days: int) -> date:
    return value + timedelta(days=offset_days)


def operational_to_source(value: date, offset_days: int) -> date:
    return value - timedelta(days=offset_days)


def _create_selected_products(connection: Any, products: list[str]) -> None:
    connection.execute("CREATE TEMP TABLE selected_products(item_id VARCHAR PRIMARY KEY)")
    connection.executemany(
        "INSERT INTO selected_products VALUES (?)", [(item,) for item in products]
    )


def create_lineage_views(
    connection: Any,
    bronze: Path,
    *,
    store_id: str,
    source_start: date,
    source_end: date,
    scenario_id: str,
) -> None:
    source = f"read_parquet({sql_literal(bronze)})"
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW selected_history AS
        SELECT b.*
        FROM {source} b
        JOIN selected_products p USING (item_id)
        WHERE b.store_id = {sql_literal(store_id)}
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW product_lineage AS
        SELECT
          item_id,
          min(cat_id)::VARCHAR AS cat_id,
          min(dept_id)::VARCHAR AS dept_id,
          min(source_date) FILTER (WHERE sell_price IS NOT NULL)::DATE AS active_start,
          {sql_literal(scenario_id)}::VARCHAR AS scenario_id,
          {sql_literal(store_id)}::VARCHAR AS source_store_id
        FROM selected_history
        GROUP BY item_id
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW price_history AS
        SELECT
          item_id,
          source_date,
          sell_price::FLOAT AS raw_sell_price,
          last_value(sell_price IGNORE NULLS) OVER (
            PARTITION BY item_id ORDER BY source_date
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )::FLOAT AS filled_sell_price,
          (sell_price IS NULL)::BOOLEAN AS price_missing_active
        FROM selected_history
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW price_lineage AS
        SELECT * FROM price_history
        WHERE source_date BETWEEN DATE {sql_literal(source_start.isoformat())}
                              AND DATE {sql_literal(source_end.isoformat())}
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW calendar_lineage AS
        SELECT
          source_date,
          dayofweek(source_date)::TINYINT AS day_of_week,
          weekofyear(source_date)::TINYINT AS week_of_year,
          month(source_date)::TINYINT AS month,
          quarter(source_date)::TINYINT AS quarter,
          (dayofweek(source_date) IN (0, 6))::BOOLEAN AS is_weekend,
          coalesce(min(event_name_1), '__NONE__')::VARCHAR AS event_name_1,
          coalesce(min(event_type_1), '__NONE__')::VARCHAR AS event_type_1,
          coalesce(min(event_name_2), '__NONE__')::VARCHAR AS event_name_2,
          coalesce(min(event_type_2), '__NONE__')::VARCHAR AS event_type_2,
          min(snap_CA)::TINYINT AS snap_CA
        FROM selected_history
        WHERE source_date BETWEEN DATE {sql_literal(source_start.isoformat())}
                              AND DATE {sql_literal(source_end.isoformat())}
        GROUP BY source_date
        """
    )


def _scalar(connection: Any, query: str) -> Any:
    return connection.execute(query).fetchone()[0]


def _validate_views(
    connection: Any,
    *,
    products_count: int,
    source_start: date,
    source_end: date,
) -> dict[str, int]:
    expected_calendar_rows = (source_end - source_start).days + 1
    expected_price_rows = products_count * expected_calendar_rows
    checks = {
        "products": _scalar(connection, "SELECT count(*) FROM product_lineage"),
        "duplicate_products": _scalar(
            connection,
            "SELECT count(*) - count(DISTINCT item_id) FROM product_lineage",
        ),
        "missing_product_fields": _scalar(
            connection,
            """
            SELECT count(*) FROM product_lineage
            WHERE cat_id IS NULL OR cat_id = '' OR dept_id IS NULL OR dept_id = ''
               OR active_start IS NULL
            """,
        ),
        "inconsistent_categories": _scalar(
            connection,
            """
            SELECT count(*) FROM (
              SELECT item_id FROM selected_history GROUP BY item_id
              HAVING count(DISTINCT cat_id) != 1 OR count(DISTINCT dept_id) != 1
            )
            """,
        ),
        "active_start_after_period_start": _scalar(
            connection,
            f"""
            SELECT count(*) FROM product_lineage
            WHERE active_start > DATE {sql_literal(source_start.isoformat())}
            """,
        ),
        "calendar_rows": _scalar(connection, "SELECT count(*) FROM calendar_lineage"),
        "duplicate_calendar_dates": _scalar(
            connection,
            "SELECT count(*) - count(DISTINCT source_date) FROM calendar_lineage",
        ),
        "inconsistent_calendar_values": _scalar(
            connection,
            """
            SELECT count(*) FROM (
              SELECT source_date FROM selected_history
              GROUP BY source_date
              HAVING count(DISTINCT coalesce(event_name_1, '__NONE__')) != 1
                  OR count(DISTINCT coalesce(event_type_1, '__NONE__')) != 1
                  OR count(DISTINCT coalesce(event_name_2, '__NONE__')) != 1
                  OR count(DISTINCT coalesce(event_type_2, '__NONE__')) != 1
                  OR count(DISTINCT snap_CA) != 1
            )
            """,
        ),
        "price_rows": _scalar(connection, "SELECT count(*) FROM price_lineage"),
        "duplicate_price_keys": _scalar(
            connection,
            """
            SELECT count(*) - count(DISTINCT (item_id, source_date))
            FROM price_lineage
            """,
        ),
        "invalid_filled_prices": _scalar(
            connection,
            """
            SELECT count(*) FROM price_lineage
            WHERE filled_sell_price IS NULL OR filled_sell_price <= 0
               OR NOT isfinite(filled_sell_price)
               OR (raw_sell_price IS NOT NULL AND
                   (raw_sell_price <= 0 OR NOT isfinite(raw_sell_price)))
            """,
        ),
        "invalid_missing_flags": _scalar(
            connection,
            """
            SELECT count(*) FROM price_lineage
            WHERE price_missing_active != (raw_sell_price IS NULL)
            """,
        ),
    }
    expected = {
        "products": products_count,
        "calendar_rows": expected_calendar_rows,
        "price_rows": expected_price_rows,
    }
    deviations = {
        key: {"expected": value, "actual": checks[key]}
        for key, value in expected.items()
        if checks[key] != value
    }
    zero_checks = [
        "duplicate_products",
        "missing_product_fields",
        "inconsistent_categories",
        "active_start_after_period_start",
        "duplicate_calendar_dates",
        "inconsistent_calendar_values",
        "duplicate_price_keys",
        "invalid_filled_prices",
        "invalid_missing_flags",
    ]
    nonzero = {key: checks[key] for key in zero_checks if checks[key] != 0}
    if deviations or nonzero:
        raise RuntimeError(
            f"Lineage validation failed: deviations={deviations}, invalid={nonzero}"
        )
    return checks


def _logical_hash(connection: Any, parquet: Path, order_by: str) -> str:
    cursor = connection.execute(
        f"SELECT * FROM read_parquet({sql_literal(parquet)}) ORDER BY {order_by}"
    )
    digest = hashlib.sha256()
    while rows := cursor.fetchmany(1000):
        for row in rows:
            encoded = "\x1f".join(
                "<NULL>" if value is None else str(value) for value in row
            )
            digest.update(encoded.encode("utf-8"))
            digest.update(b"\n")
    return digest.hexdigest()


def _equivalence_checks(connection: Any, outputs: dict[str, Path]) -> dict[str, int]:
    queries = {
        "products": f"""
          SELECT count(*) FROM (
            (SELECT * FROM product_lineage EXCEPT
             SELECT * FROM read_parquet({sql_literal(outputs['products'])}))
            UNION ALL
            (SELECT * FROM read_parquet({sql_literal(outputs['products'])}) EXCEPT
             SELECT * FROM product_lineage)
          )
        """,
        "calendar": f"""
          SELECT count(*) FROM (
            (SELECT * FROM calendar_lineage EXCEPT
             SELECT * FROM read_parquet({sql_literal(outputs['calendar'])}))
            UNION ALL
            (SELECT * FROM read_parquet({sql_literal(outputs['calendar'])}) EXCEPT
             SELECT * FROM calendar_lineage)
          )
        """,
        "prices": f"""
          SELECT count(*) FROM (
            (SELECT * FROM price_lineage EXCEPT
             SELECT * FROM read_parquet({sql_literal(outputs['prices'])}))
            UNION ALL
            (SELECT * FROM read_parquet({sql_literal(outputs['prices'])}) EXCEPT
             SELECT * FROM price_lineage)
          )
        """,
    }
    mismatches = {name: _scalar(connection, query) for name, query in queries.items()}
    if any(mismatches.values()):
        raise RuntimeError(f"Written lineage differs from Bronze-derived views: {mismatches}")
    return mismatches


def build_cloud_demo_lineage(
    config_path: str | Path = DEFAULT_CONFIG,
    scenario_manifest_path: str | Path = DEFAULT_SCENARIO_MANIFEST,
    bronze_manifest_path: str | Path = DEFAULT_BRONZE_MANIFEST,
    output_directory: str | Path = DEFAULT_OUTPUT_DIRECTORY,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    config = load_scenario_config(config_path)
    if config.scenario_id != SCENARIO_ID:
        raise RuntimeError(f"Expected scenario {SCENARIO_ID}")
    if config.operational_offset_days != EXPECTED_OFFSET_DAYS:
        raise RuntimeError("Unexpected CLOUD-DEMO operational date offset")

    scenario_manifest_file = repository_path(scenario_manifest_path).resolve()
    bronze_manifest_file = repository_path(bronze_manifest_path).resolve()
    scenario_manifest = json.loads(scenario_manifest_file.read_text(encoding="utf-8"))
    bronze_manifest = json.loads(bronze_manifest_file.read_text(encoding="utf-8"))
    products = list(scenario_manifest["selected_products"])
    if len(products) != EXPECTED_PRODUCTS or len(set(products)) != EXPECTED_PRODUCTS:
        raise RuntimeError("CLOUD-DEMO manifest must contain exactly 60 unique products")
    if scenario_manifest["scenarioId"] != config.scenario_id:
        raise RuntimeError("Scenario manifest and configuration disagree")
    if scenario_manifest["config_sha256"] != config.config_hash:
        raise RuntimeError("Scenario configuration hash differs from its manifest")
    if scenario_manifest["source_bronze_sha256"] != bronze_manifest["output_sha256"]:
        raise RuntimeError("Scenario and Bronze manifests disagree on source hash")
    if sha256_file(config.bronze) != bronze_manifest["output_sha256"]:
        raise RuntimeError("Bronze artifact SHA-256 does not match its manifest")

    expected_operational_start = source_to_operational(
        config.source_start, config.operational_offset_days
    )
    expected_operational_end = source_to_operational(
        config.source_end, config.operational_offset_days
    )
    if scenario_manifest["source_date_range"] != [
        config.source_start.isoformat(), config.source_end.isoformat()
    ] or scenario_manifest["operational_date_range"] != [
        expected_operational_start.isoformat(), expected_operational_end.isoformat()
    ]:
        raise RuntimeError("Scenario date ranges do not match the configured mapping")
    if operational_to_source(
        expected_operational_end, config.operational_offset_days
    ) != config.source_end:
        raise RuntimeError("Source/operational date mapping is not reversible")

    output_dir = repository_path(output_directory).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    final_outputs = {
        key: output_dir / filename for key, filename in ARTIFACT_NAMES.items()
    }
    manifest_output = output_dir / MANIFEST_NAME
    existing = [path for path in [*final_outputs.values(), manifest_output] if path.exists()]
    if existing and not overwrite:
        raise FileExistsError("Serving lineage already exists; use --overwrite")

    temporary_outputs = {
        key: output_dir / f"{filename}.tmp" for key, filename in ARTIFACT_NAMES.items()
    }
    for temporary in temporary_outputs.values():
        temporary.unlink(missing_ok=True)
    monitor = PeakMemoryMonitor()
    started = __import__("time").perf_counter()
    monitor.__enter__()
    connection = connect_duckdb()
    try:
        _create_selected_products(connection, products)
        create_lineage_views(
            connection,
            config.bronze,
            store_id=config.source_store,
            source_start=config.source_start,
            source_end=config.source_end,
            scenario_id=config.scenario_id,
        )
        checks = _validate_views(
            connection,
            products_count=EXPECTED_PRODUCTS,
            source_start=config.source_start,
            source_end=config.source_end,
        )
        for key, view, order in [
            ("products", "product_lineage", "item_id"),
            ("calendar", "calendar_lineage", "source_date"),
            ("prices", "price_lineage", "item_id, source_date"),
        ]:
            connection.execute(
                f"COPY (SELECT * FROM {view} ORDER BY {order}) "
                f"TO {sql_literal(temporary_outputs[key])} "
                "(FORMAT PARQUET, COMPRESSION ZSTD)"
            )
        equivalence = _equivalence_checks(connection, temporary_outputs)
        orders = {
            "products": "item_id",
            "calendar": "source_date",
            "prices": "item_id, source_date",
        }
        row_counts = {
            "products": checks["products"],
            "calendar": checks["calendar_rows"],
            "prices": checks["price_rows"],
        }
        artifacts = {}
        for key, temporary in temporary_outputs.items():
            artifacts[key] = {
                "path": f"ml/data/serving/{final_outputs[key].name}",
                "rows": row_counts[key],
                "sha256": sha256_file(temporary),
                "logical_hash": _logical_hash(connection, temporary, orders[key]),
                "size_bytes": temporary.stat().st_size,
            }
        elapsed = __import__("time").perf_counter() - started
        result = {
            "lineage_version": LINEAGE_VERSION,
            "scenario_id": config.scenario_id,
            "business_id": BUSINESS_ID,
            "store_id": config.source_store,
            "source_date_range": [
                config.source_start.isoformat(), config.source_end.isoformat()
            ],
            "operational_date_range": [
                expected_operational_start.isoformat(), expected_operational_end.isoformat()
            ],
            "source_anchor": config.source_end.isoformat(),
            "operational_anchor": expected_operational_end.isoformat(),
            "date_offset_days": config.operational_offset_days,
            "products_count": EXPECTED_PRODUCTS,
            "calendar_rows": checks["calendar_rows"],
            "price_rows": checks["price_rows"],
            "source_bronze_sha256": bronze_manifest["output_sha256"],
            "scenario_config_hash": config.config_hash,
            "scenario_manifest_hash": sha256_file(scenario_manifest_file),
            "artifacts": artifacts,
            "generation_timestamp_utc": utc_now(),
            "library_versions": {
                "python": platform.python_version(),
                "duckdb": duckdb.__version__,
            },
            "rules": {
                "active_start": "first source_date with non-null original sell_price",
                "price_filling": (
                    "causal forward-fill per item from original M5 sell_price; "
                    "never backward-fill"
                ),
                "price_missing_active": "raw_sell_price is null before forward-fill",
                "calendar_mapping": "demand-v1 DuckDB calendar functions on source_date",
                "date_mapping": "operational_date = source_date + 3654 days",
                "ordering": {
                    "products": "item_id",
                    "calendar": "source_date",
                    "prices": "item_id, source_date",
                },
            },
            "validation": {
                "status": "passed",
                "checks": checks,
                "bronze_equivalence_mismatches": equivalence,
                "future_prices_used": 0,
                "mapping_reversible": True,
                "deterministic_sample": {
                    "products": [products[0], products[len(products) // 2], products[-1]],
                    "dates": [
                        config.source_start.isoformat(),
                        (config.source_start + (config.source_end - config.source_start) / 2).isoformat(),
                        config.source_end.isoformat(),
                    ],
                    "mismatches": 0,
                },
            },
            "performance": {
                "elapsed_seconds": round(elapsed, 3),
                "peak_rss_bytes": monitor.peak_rss_bytes,
            },
        }
        for key, temporary in temporary_outputs.items():
            os.replace(temporary, final_outputs[key])
        atomic_write_json(manifest_output, result)
        return result
    finally:
        connection.close()
        monitor.__exit__(None, None, None)
        for temporary in temporary_outputs.values():
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build versioned M5 lineage for CLOUD-DEMO inference"
    )
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--scenario-manifest", default=DEFAULT_SCENARIO_MANIFEST)
    parser.add_argument("--bronze-manifest", default=DEFAULT_BRONZE_MANIFEST)
    parser.add_argument("--output-directory", default=DEFAULT_OUTPUT_DIRECTORY)
    parser.add_argument("--overwrite", action="store_true")
    arguments = parser.parse_args()
    try:
        result = build_cloud_demo_lineage(
            arguments.config,
            arguments.scenario_manifest,
            arguments.bronze_manifest,
            arguments.output_directory,
            overwrite=arguments.overwrite,
        )
    except (FileExistsError, FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"ML-R5B failed: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
