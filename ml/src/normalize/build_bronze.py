from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from ..common import (
    assert_outside_raw,
    atomic_write_json,
    capture_hashes,
    discover_m5_files,
    load_config,
    measured_run,
    repository_path,
    resolve_sales_file,
    sha256_file,
    sql_literal,
    utc_now,
    validate_required_files,
    verify_hashes,
)
from ..m5 import (
    connect_duckdb,
    create_m5_views,
    rank_stores,
    resolve_selected_store,
    validate_schema,
)


def build_bronze(
    config_path: str | Path,
    output_override: str | Path | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    config = load_config(config_path)
    raw_directory = repository_path(config["paths"]["raw_directory"])
    output = repository_path(output_override or config["paths"]["bronze_output"])
    manifest_output = repository_path(config["paths"]["bronze_manifest"])
    assert_outside_raw(output, raw_directory)
    assert_outside_raw(manifest_output, raw_directory)
    if output.exists() and not overwrite:
        raise FileExistsError(
            f"Bronze output already exists: {output}. Use --overwrite explicitly."
        )

    files = discover_m5_files(raw_directory)
    validate_required_files(files)
    initial_hashes = capture_hashes(files)
    sales_file = resolve_sales_file(files)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(output.suffix + ".tmp")
    if temporary_output.exists():
        temporary_output.unlink()

    connection = connect_duckdb()
    try:
        with measured_run() as performance:
            create_m5_views(
                connection,
                sales_file,
                files["calendar.csv"],
                files["sell_prices.csv"],
            )
            validate_schema(connection)
            ranking = rank_stores(connection)
            configured_store = str(config["dataset"]["selected_store"])
            if configured_store == "auto":
                raise ValueError(
                    "Profile M5 first, review the ranking, and pin selected_store in "
                    "ml/config/base.toml before building bronze"
                )
            selected_store = resolve_selected_store(
                configured_store, ranking
            )
            source_quality_row = connection.execute(
                """
                SELECT
                  (SELECT count(*) - count(DISTINCT id) FROM sales_wide)
                    AS duplicate_sales_ids,
                  (SELECT count(*) - count(DISTINCT d) FROM calendar)
                    AS duplicate_calendar_day_ids,
                  (SELECT count(*) - count(DISTINCT date) FROM calendar)
                    AS duplicate_calendar_dates,
                  (SELECT count(*) - count(DISTINCT (store_id, item_id, wm_yr_wk))
                     FROM prices) AS duplicate_price_keys,
                  (SELECT count(*) FROM (
                     SELECT DISTINCT day_id FROM sales_long s
                     LEFT JOIN calendar c ON c.d = s.day_id WHERE c.d IS NULL
                   )) AS unmatched_calendar_days,
                  (SELECT count(*) FROM sales_long
                   WHERE store_id = ? AND CAST(units_sold AS DOUBLE) < 0)
                    AS negative_unit_rows
                """,
                [selected_store],
            ).fetchone()
            source_quality_names = [item[0] for item in connection.description]
            source_quality = dict(zip(source_quality_names, source_quality_row))
            blocking_checks = {
                name: value
                for name, value in source_quality.items()
                if name != "negative_unit_rows" and value
            }
            if blocking_checks:
                raise ValueError(f"M5 quality precheck failed: {blocking_checks}")
            compression = str(config["bronze"]["compression"]).upper()
            row_group_size = int(config["bronze"]["row_group_size"])

            connection.execute(
                """
                CREATE OR REPLACE TEMP VIEW selected_bronze AS
                SELECT s.store_id, s.item_id, s.dept_id, s.cat_id, s.state_id,
                       c.date AS source_date,
                       CAST(s.units_sold AS DOUBLE) AS units_sold,
                       CAST(p.sell_price AS DOUBLE) AS sell_price,
                       c.wm_yr_wk, c.weekday, c.wday, c.month, c.year,
                       c.event_name_1, c.event_type_1,
                       c.event_name_2, c.event_type_2,
                       c.snap_CA, c.snap_TX, c.snap_WI,
                       CASE s.state_id WHEN 'CA' THEN c.snap_CA
                            WHEN 'TX' THEN c.snap_TX
                            WHEN 'WI' THEN c.snap_WI ELSE NULL END AS snap_active,
                       p.sell_price IS NOT NULL AS has_sell_price
                FROM sales_long s
                INNER JOIN calendar c ON c.d = s.day_id
                LEFT JOIN prices p
                  ON p.store_id = s.store_id
                 AND p.item_id = s.item_id
                 AND p.wm_yr_wk = c.wm_yr_wk
                WHERE s.store_id = {selected_store}
                """.format(selected_store=sql_literal(selected_store)),
            )
            connection.execute(
                f"COPY (SELECT * FROM selected_bronze ORDER BY item_id, source_date) "
                f"TO {sql_literal(temporary_output)} "
                f"(FORMAT PARQUET, COMPRESSION {compression}, "
                f"ROW_GROUP_SIZE {row_group_size})"
            )
            os.replace(temporary_output, output)

            statistics_row = connection.execute(
                """
                SELECT count(*) AS rows,
                       count(DISTINCT item_id) AS products,
                       count(DISTINCT source_date) AS days,
                       min(source_date) AS first_date,
                       max(source_date) AS last_date,
                       count_if(units_sold > 0) AS positive_rows,
                       count_if(units_sold = 0) AS zero_rows,
                       count_if(units_sold < 0) AS negative_rows,
                       sum(units_sold) AS total_units,
                       avg(units_sold) AS mean_units,
                       max(units_sold) AS max_units,
                       count_if(has_sell_price) AS priced_rows,
                       count_if(NOT has_sell_price) AS missing_price_rows,
                       count(*) - count(DISTINCT (store_id, item_id, source_date))
                         AS duplicate_keys
                FROM selected_bronze
                """
            ).fetchone()
            names = [item[0] for item in connection.description]
            statistics = dict(zip(names, statistics_row))
            statistics["zero_percentage"] = (
                100.0 * statistics["zero_rows"] / statistics["rows"]
            )
            statistics["price_coverage_percentage"] = (
                100.0 * statistics["priced_rows"] / statistics["rows"]
            )

            csv_equivalent_bytes = None
            if bool(config["bronze"].get("measure_csv_equivalent", True)):
                temporary_csv = output.with_suffix(".equivalent.csv.tmp")
                if temporary_csv.exists():
                    temporary_csv.unlink()
                connection.execute(
                    f"COPY (SELECT * FROM read_parquet({sql_literal(output)}) "
                    f"ORDER BY item_id, source_date) TO {sql_literal(temporary_csv)} "
                    "(FORMAT CSV, HEADER true)"
                )
                csv_equivalent_bytes = temporary_csv.stat().st_size
                temporary_csv.unlink()

            try:
                output_name = str(output.relative_to(repository_path(".")))
            except ValueError:
                output_name = str(output)
            manifest: dict[str, Any] = {
                "dataset": "M5 Forecasting Accuracy",
                "generated_at_utc": utc_now(),
                "selected_store": selected_store,
                "input_file": sales_file.name,
                "input_hashes": initial_hashes,
                "output": output_name,
                "output_sha256": sha256_file(output),
                "output_size_bytes": output.stat().st_size,
                "csv_equivalent_size_bytes": csv_equivalent_bytes,
                "parquet_to_csv_size_ratio": (
                    output.stat().st_size / csv_equivalent_bytes
                    if csv_equivalent_bytes else None
                ),
                "compression": compression.lower(),
                "row_group_size": row_group_size,
                "statistics": statistics,
                "quality": {
                    "checks": source_quality,
                    "warnings": ([{
                        "check": "negative_unit_rows",
                        "value": source_quality["negative_unit_rows"],
                        "policy": "Preserved without silent correction for explicit review."
                    }] if source_quality["negative_unit_rows"] else []),
                },
                "performance": performance,
                "lineage": {
                    "source_date": "calendar.date (unchanged)",
                    "units_sold": "sales_train_*.d_* (real)",
                    "sell_price": "exact weekly join on store_id, item_id, wm_yr_wk",
                    "has_sell_price": "derived only from exact price availability",
                    "snap_active": "state-specific projection of calendar SNAP flags",
                },
                "price_policy": "No forward-fill or backward-fill; unmatched weekly prices remain null.",
            }
        verify_hashes(files, initial_hashes)
        atomic_write_json(manifest_output, manifest)
        return manifest
    except Exception:
        if temporary_output.exists():
            temporary_output.unlink()
        raise
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Build one-store M5 bronze Parquet")
    parser.add_argument("--config", default="ml/config/base.toml")
    parser.add_argument("--output")
    parser.add_argument("--overwrite", action="store_true")
    arguments = parser.parse_args()
    try:
        manifest = build_bronze(
            arguments.config,
            output_override=arguments.output,
            overwrite=arguments.overwrite,
        )
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError) as error:
        print(f"ML-R2A cannot build bronze: {error}", file=sys.stderr)
        return 2
    print(json.dumps(manifest, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
