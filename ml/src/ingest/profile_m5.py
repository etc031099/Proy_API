from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from ..common import (
    EXPECTED_M5_FILES,
    atomic_write_json,
    capture_hashes,
    discover_m5_files,
    file_record,
    load_config,
    measured_run,
    repository_path,
    resolve_sales_file,
    utc_now,
    validate_required_files,
    verify_hashes,
)
from ..m5 import (
    connect_duckdb,
    create_m5_views,
    rank_stores,
    relation_summary,
    resolve_selected_store,
    validate_schema,
)


def manifest_for(
    files: dict[str, Path],
    acquired_at: str | None = None,
    file_profiles: dict[str, Any] | None = None,
) -> dict[str, Any]:
    records = []
    for name, path in sorted(files.items()):
        record = file_record(path)
        if file_profiles and name in file_profiles:
            profile = file_profiles[name]
            record.update({
                "rows": profile["rows"],
                "columns_count": profile["columns_count"],
                "schema": profile["columns"],
            })
        records.append(record)
    return {
        "dataset": "M5 Forecasting Accuracy",
        "source_url": "https://www.kaggle.com/competitions/m5-forecasting-accuracy/data",
        "status": "available",
        "acquired_at_utc": acquired_at or utc_now(),
        "files": records,
        "expected_files": list(EXPECTED_M5_FILES),
        "license": "Subject to Kaggle competition rules",
    }


def verify_existing_manifest(manifest_path: Path, files: dict[str, Path]) -> None:
    if not manifest_path.exists():
        return
    import json

    existing = json.loads(manifest_path.read_text(encoding="utf-8"))
    if existing.get("status") != "available":
        return
    recorded = {
        entry["name"]: entry["sha256"] for entry in existing.get("files", [])
    }
    current = capture_hashes(files)
    if recorded != current:
        raise RuntimeError(
            "Raw M5 files differ from the versioned manifest. Restore the immutable "
            "source or review the dataset change explicitly; the manifest was not updated."
        )


def profile_dataset(config_path: str | Path) -> dict[str, Any]:
    config = load_config(config_path)
    raw_directory = repository_path(config["paths"]["raw_directory"])
    files = discover_m5_files(raw_directory)
    validate_required_files(files)
    initial_hashes = capture_hashes(files)
    sales_file = resolve_sales_file(files)

    connection = connect_duckdb()
    try:
        with measured_run() as performance:
            create_m5_views(
                connection,
                sales_file,
                files["calendar.csv"],
                files["sell_prices.csv"],
            )
            schema = validate_schema(connection)
            file_profiles = {
                name: relation_summary(connection, path)
                for name, path in sorted(files.items())
            }
            ranking = rank_stores(connection)
            selected_store = resolve_selected_store(
                str(config["dataset"]["selected_store"]), ranking
            )

            calendar = connection.execute(
                """
                SELECT min(date) AS first_date, max(date) AS last_date,
                       count(*) AS rows, count(DISTINCT date) AS distinct_dates,
                       date_diff('day', min(date), max(date)) + 1 - count(DISTINCT date)
                         AS missing_dates,
                       count_if(event_name_1 IS NOT NULL) AS primary_event_rows,
                       count_if(event_name_2 IS NOT NULL) AS secondary_event_rows,
                       count_if(snap_CA = 1) AS snap_ca_days,
                       count_if(snap_TX = 1) AS snap_tx_days,
                       count_if(snap_WI = 1) AS snap_wi_days
                FROM calendar
                """
            ).fetchone()
            calendar_names = [item[0] for item in connection.description]

            sales = connection.execute(
                """
                SELECT count(*) AS product_days,
                       sum(CAST(units_sold AS DOUBLE)) AS total_units,
                       avg(CAST(units_sold AS DOUBLE)) AS mean_units,
                       max(CAST(units_sold AS DOUBLE)) AS max_units,
                       count_if(CAST(units_sold AS DOUBLE) = 0) AS zero_rows,
                       count_if(CAST(units_sold AS DOUBLE) > 0) AS positive_rows,
                       count_if(CAST(units_sold AS DOUBLE) < 0) AS negative_rows,
                       quantile_cont(CAST(units_sold AS DOUBLE), 0.5) AS p50,
                       quantile_cont(CAST(units_sold AS DOUBLE), 0.9) AS p90,
                       quantile_cont(CAST(units_sold AS DOUBLE), 0.95) AS p95,
                       quantile_cont(CAST(units_sold AS DOUBLE), 0.99) AS p99
                FROM sales_long
                """
            ).fetchone()
            sales_names = [item[0] for item in connection.description]

            prices = connection.execute(
                """
                WITH ordered AS (
                  SELECT *, lag(sell_price) OVER (
                    PARTITION BY store_id, item_id ORDER BY wm_yr_wk
                  ) AS previous_price
                  FROM prices
                )
                SELECT count(*) AS rows, min(sell_price) AS min_price,
                       max(sell_price) AS max_price,
                       quantile_cont(sell_price, 0.5) AS median_price,
                       count_if(sell_price IS NULL) AS null_prices,
                       count_if(sell_price <= 0) AS invalid_prices,
                       count(DISTINCT store_id) AS stores,
                       count(DISTINCT item_id) AS products,
                       count_if(previous_price IS NOT NULL) AS comparable_price_rows,
                       count_if(previous_price IS NOT NULL AND sell_price != previous_price)
                         AS price_changes
                FROM ordered
                """
            ).fetchone()
            price_names = [item[0] for item in connection.description]

            price_period = connection.execute(
                """
                SELECT min(c.date) AS first_price_date, max(c.date) AS last_price_date,
                       count(DISTINCT p.wm_yr_wk) AS priced_weeks
                FROM prices p
                JOIN calendar c USING (wm_yr_wk)
                """
            ).fetchone()
            price_period_names = [item[0] for item in connection.description]

            products = connection.execute(
                """
                SELECT count(DISTINCT item_id) AS products,
                       count(DISTINCT dept_id) AS departments,
                       count(DISTINCT cat_id) AS categories
                FROM sales_wide
                """
            ).fetchone()
            product_names = [item[0] for item in connection.description]

            category_rows = connection.execute(
                """
                SELECT cat_id, count(DISTINCT item_id) AS products
                FROM sales_wide GROUP BY cat_id ORDER BY cat_id
                """
            ).fetchall()

            department_rows = connection.execute(
                """
                SELECT dept_id, cat_id, count(DISTINCT item_id) AS products
                FROM sales_wide GROUP BY dept_id, cat_id ORDER BY dept_id
                """
            ).fetchall()

            event_rows = connection.execute(
                """
                SELECT event_type, event_name, count(*) AS days
                FROM (
                  SELECT event_type_1 AS event_type, event_name_1 AS event_name
                  FROM calendar WHERE event_name_1 IS NOT NULL
                  UNION ALL
                  SELECT event_type_2, event_name_2
                  FROM calendar WHERE event_name_2 IS NOT NULL
                ) events
                GROUP BY event_type, event_name ORDER BY event_type, event_name
                """
            ).fetchall()

            quality_row = connection.execute(
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
                     SELECT item_id FROM sales_wide
                     GROUP BY item_id HAVING count(DISTINCT dept_id) > 1
                        OR count(DISTINCT cat_id) > 1
                   )) AS inconsistent_item_hierarchies,
                  (SELECT count(*) FROM (
                     SELECT store_id FROM sales_wide
                     GROUP BY store_id HAVING count(DISTINCT state_id) > 1
                   )) AS inconsistent_store_states,
                  (SELECT count(*) FROM (
                     SELECT DISTINCT day_id FROM sales_long s
                     LEFT JOIN calendar c ON c.d = s.day_id
                     WHERE c.d IS NULL
                   )) AS unmatched_calendar_days,
                  (SELECT count(*) FROM sales_wide
                   WHERE id IS NULL OR item_id IS NULL OR store_id IS NULL
                      OR state_id IS NULL OR dept_id IS NULL OR cat_id IS NULL)
                    AS sales_rows_missing_keys,
                  (SELECT count(*) FROM prices
                   WHERE store_id IS NULL OR item_id IS NULL OR wm_yr_wk IS NULL)
                    AS price_rows_missing_keys
                """
            ).fetchone()
            quality_names = [item[0] for item in connection.description]
            quality = dict(zip(quality_names, quality_row))
            quality_findings = []
            for name, value in quality.items():
                quality_findings.append({
                    "severity": "ERROR" if value else "INFO",
                    "check": name,
                    "value": value,
                })
            if sales[sales_names.index("negative_rows")] > 0:
                quality_findings.append({
                    "severity": "WARNING",
                    "check": "negative_unit_rows",
                    "value": sales[sales_names.index("negative_rows")],
                })

            selected_products = connection.execute(
                """
                WITH dated AS (
                  SELECT s.item_id, s.dept_id, s.cat_id, c.date,
                         CAST(s.units_sold AS DOUBLE) AS units_sold,
                         p.sell_price
                  FROM sales_long s
                  JOIN calendar c ON c.d = s.day_id
                  LEFT JOIN prices p
                    ON p.store_id = s.store_id
                   AND p.item_id = s.item_id
                   AND p.wm_yr_wk = c.wm_yr_wk
                  WHERE s.store_id = ?
                ), bounds AS (
                  SELECT item_id,
                         min(date) FILTER (WHERE units_sold > 0) AS first_positive_date,
                         max(date) FILTER (WHERE units_sold > 0) AS last_positive_date,
                         min(date) FILTER (WHERE sell_price IS NOT NULL) AS first_price_date,
                         max(date) FILTER (WHERE sell_price IS NOT NULL) AS last_price_date
                  FROM dated GROUP BY item_id
                ), stats AS (
                  SELECT d.item_id, any_value(d.dept_id) AS dept_id,
                         any_value(d.cat_id) AS cat_id,
                         sum(d.units_sold) AS total_units,
                         avg(d.units_sold) AS daily_mean,
                         stddev_pop(d.units_sold) AS daily_stddev,
                         count_if(d.units_sold > 0) AS selling_days,
                         count(*) AS observed_days,
                         count(d.sell_price) AS priced_days,
                         any_value(b.first_positive_date) AS first_positive_date,
                         any_value(b.last_positive_date) AS last_positive_date,
                         any_value(b.first_price_date) AS first_price_date,
                         any_value(b.last_price_date) AS last_price_date,
                         count_if(b.first_price_date IS NOT NULL
                           AND d.date BETWEEN b.first_price_date AND b.last_price_date
                           AND d.sell_price IS NULL) AS internal_missing_price_days
                  FROM dated d JOIN bounds b USING (item_id)
                  GROUP BY d.item_id
                ), positive_ranked AS (
                  SELECT item_id, ntile(3) OVER (ORDER BY total_units) AS rotation_tile
                  FROM stats WHERE total_units > 0
                )
                SELECT s.*, CASE coalesce(p.rotation_tile, 0) WHEN 0 THEN 'no_sales'
                         WHEN 1 THEN 'low' WHEN 2 THEN 'medium' ELSE 'high' END
                         AS rotation_class,
                       1 - s.selling_days::DOUBLE / s.observed_days AS intermittency
                FROM stats s LEFT JOIN positive_ranked p USING (item_id)
                ORDER BY s.item_id
                """,
                [selected_store],
            ).fetchall()
            selected_names = [item[0] for item in connection.description]
            product_profile = [dict(zip(selected_names, row)) for row in selected_products]

            activity = {
                "pre_launch_rows": 0,
                "active_evidence_rows": 0,
                "post_inactive_rows": 0,
                "ambiguous_rows": 0,
            }
            for product in product_profile:
                product["zero_percentage"] = (
                    100.0 * (product["observed_days"] - product["selling_days"])
                    / product["observed_days"]
                )

            activity_row = connection.execute(
                """
                WITH dated AS (
                  SELECT s.item_id, c.date,
                         CAST(s.units_sold AS DOUBLE) AS units_sold,
                         p.sell_price
                  FROM sales_long s
                  JOIN calendar c ON c.d = s.day_id
                  LEFT JOIN prices p
                    ON p.store_id = s.store_id
                   AND p.item_id = s.item_id
                   AND p.wm_yr_wk = c.wm_yr_wk
                  WHERE s.store_id = ?
                ), bounds AS (
                  SELECT item_id,
                         least(
                           min(date) FILTER (WHERE units_sold > 0),
                           min(date) FILTER (WHERE sell_price IS NOT NULL)
                         ) AS first_evidence_date,
                         greatest(
                           max(date) FILTER (WHERE units_sold > 0),
                           max(date) FILTER (WHERE sell_price IS NOT NULL)
                         ) AS last_evidence_date
                  FROM dated GROUP BY item_id
                )
                SELECT
                  count_if(d.units_sold = 0 AND d.sell_price IS NULL
                    AND d.date < b.first_evidence_date) AS pre_launch_rows,
                  count_if(d.units_sold > 0 OR d.sell_price IS NOT NULL)
                    AS active_evidence_rows,
                  count_if(d.units_sold = 0 AND d.sell_price IS NULL
                    AND d.date > b.last_evidence_date) AS post_inactive_rows,
                  count_if(d.units_sold = 0 AND d.sell_price IS NULL
                    AND (b.first_evidence_date IS NULL
                      OR (d.date >= b.first_evidence_date
                        AND d.date <= b.last_evidence_date))) AS ambiguous_rows
                FROM dated d JOIN bounds b USING (item_id)
                """,
                [selected_store],
            ).fetchone()
            activity_names = [item[0] for item in connection.description]
            activity = dict(zip(activity_names, activity_row))

            selected_price_quality = {
                "products_without_price": sum(
                    product["priced_days"] == 0 for product in product_profile
                ),
                "internal_missing_price_days": sum(
                    product["internal_missing_price_days"] for product in product_profile
                ),
                "no_sales_series": sum(
                    product["selling_days"] == 0 for product in product_profile
                ),
                "rare_series_selling_days_lte_7": sum(
                    product["selling_days"] <= 7 for product in product_profile
                ),
            }

            selected_summary = next(
                store for store in ranking if str(store["store_id"]) == selected_store
            )
            report = {
                "generated_at_utc": utc_now(),
                "input_hashes": initial_hashes,
                "sales_source": sales_file.name,
                "schema": schema,
                "files": file_profiles,
                "general": {
                    "calendar": dict(zip(calendar_names, calendar)),
                    "sales": dict(zip(sales_names, sales)),
                    "prices": dict(zip(price_names, prices)),
                    "price_period": dict(zip(price_period_names, price_period)),
                    "products": dict(zip(product_names, products)),
                    "products_by_category": [
                        {"cat_id": row[0], "products": row[1]} for row in category_rows
                    ],
                    "products_by_department": [
                        {"dept_id": row[0], "cat_id": row[1], "products": row[2]}
                        for row in department_rows
                    ],
                    "events": [
                        {"event_type": row[0], "event_name": row[1], "days": row[2]}
                        for row in event_rows
                    ],
                },
                "quality": {
                    "checks": quality,
                    "findings": quality_findings,
                    "policy": "No issue is corrected silently; ERROR blocks bronze, WARNING requires review.",
                },
                "store_ranking": ranking,
                "selected_store": selected_store,
                "selected_store_summary": selected_summary,
                "selected_store_product_profile": product_profile,
                "selected_store_price_quality": selected_price_quality,
                "selected_store_activity_profile": {
                    **activity,
                    "definition": {
                        "active_evidence": "units_sold > 0 or exact weekly sell_price exists",
                        "pre_launch": "zero units and no price before first sale/price evidence",
                        "post_inactive": "zero units and no price after last sale/price evidence",
                        "ambiguous": "zero units and no price between evidence bounds, or no evidence",
                    },
                },
                "ranking_policy": {
                    "product_coverage": 0.20,
                    "category_diversity": 0.15,
                    "day_continuity": 0.10,
                    "price_coverage": 0.20,
                    "nonzero_ratio": 0.10,
                    "sales_stability": 0.10,
                    "volume_representativeness": 0.05,
                    "temporal_coverage": 0.10,
                },
                "performance": performance,
            }
        verify_hashes(files, initial_hashes)
        return report
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile the immutable M5 raw files")
    parser.add_argument("--config", default="ml/config/base.toml")
    parser.add_argument("--write-manifest", action="store_true")
    arguments = parser.parse_args()
    config = load_config(arguments.config)
    raw_directory = repository_path(config["paths"]["raw_directory"])
    files = discover_m5_files(raw_directory)

    try:
        validate_required_files(files)
        manifest_path = repository_path(config["paths"]["manifest"])
        verify_existing_manifest(manifest_path, files)
        report = profile_dataset(arguments.config)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"ML-R2A cannot profile M5: {error}", file=sys.stderr)
        print(
            f"Place the official Kaggle CSV files in: {raw_directory}",
            file=sys.stderr,
        )
        return 2

    if arguments.write_manifest:
        previous_acquired_at = None
        if manifest_path.exists():
            import json

            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
            previous_acquired_at = previous.get("acquired_at_utc")
        atomic_write_json(
            manifest_path,
            manifest_for(files, previous_acquired_at, report["files"]),
        )

    output = repository_path(config["paths"]["profile_report"])
    atomic_write_json(output, report)
    print(f"Profile written to {output}")
    print(f"Selected store: {report['selected_store']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
