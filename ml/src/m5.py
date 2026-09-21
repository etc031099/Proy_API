from __future__ import annotations

import math
import statistics
from pathlib import Path
from typing import Any

from .common import quote_identifier, sql_literal


SALES_ID_COLUMNS = (
    "id",
    "item_id",
    "dept_id",
    "cat_id",
    "store_id",
    "state_id",
)
CALENDAR_REQUIRED_COLUMNS = (
    "date",
    "wm_yr_wk",
    "d",
    "event_name_1",
    "event_type_1",
    "event_name_2",
    "event_type_2",
    "snap_CA",
    "snap_TX",
    "snap_WI",
)
PRICE_REQUIRED_COLUMNS = ("store_id", "item_id", "wm_yr_wk", "sell_price")


def connect_duckdb():
    try:
        import duckdb
    except ImportError as error:
        raise RuntimeError(
            "duckdb is required; create the ML environment from ml/requirements.txt"
        ) from error
    return duckdb.connect(":memory:")


def create_m5_views(connection, sales: Path, calendar: Path, prices: Path) -> None:
    connection.execute(
        f"CREATE OR REPLACE TEMP VIEW sales_wide AS "
        f"SELECT * FROM read_csv_auto({sql_literal(sales)}, header=true)"
    )
    connection.execute(
        f"CREATE OR REPLACE TEMP VIEW calendar AS "
        f"SELECT * FROM read_csv_auto({sql_literal(calendar)}, header=true)"
    )
    connection.execute(
        f"CREATE OR REPLACE TEMP VIEW prices AS "
        f"SELECT * FROM read_csv_auto({sql_literal(prices)}, header=true)"
    )
    excluded = ", ".join(quote_identifier(column) for column in SALES_ID_COLUMNS)
    connection.execute(
        "CREATE OR REPLACE TEMP VIEW sales_long AS "
        f"UNPIVOT sales_wide ON COLUMNS(* EXCLUDE ({excluded})) "
        "INTO NAME day_id VALUE units_sold"
    )


def column_names(connection, relation: str) -> list[str]:
    return [row[0] for row in connection.execute(f"DESCRIBE {relation}").fetchall()]


def validate_schema(connection) -> dict[str, list[str]]:
    sales_columns = column_names(connection, "sales_wide")
    calendar_columns = column_names(connection, "calendar")
    price_columns = column_names(connection, "prices")

    missing_sales = [column for column in SALES_ID_COLUMNS if column not in sales_columns]
    day_columns = [column for column in sales_columns if column.startswith("d_")]
    missing_calendar = [
        column for column in CALENDAR_REQUIRED_COLUMNS if column not in calendar_columns
    ]
    missing_prices = [
        column for column in PRICE_REQUIRED_COLUMNS if column not in price_columns
    ]
    errors = {
        "sales": missing_sales + ([] if day_columns else ["d_* columns"]),
        "calendar": missing_calendar,
        "prices": missing_prices,
    }
    invalid = {name: values for name, values in errors.items() if values}
    if invalid:
        raise ValueError(f"Unexpected M5 schema; missing columns: {invalid}")
    return {
        "sales": sales_columns,
        "calendar": calendar_columns,
        "prices": price_columns,
        "day_columns": day_columns,
    }


def relation_summary(connection, csv_path: Path) -> dict[str, Any]:
    source = f"read_csv_auto({sql_literal(csv_path)}, header=true)"
    rows = connection.execute(f"SELECT count(*) FROM {source}").fetchone()[0]
    summary_rows = connection.execute(f"SUMMARIZE SELECT * FROM {source}").fetchall()
    summary_columns = [description[0] for description in connection.description]
    columns = []
    for values in summary_rows:
        entry = dict(zip(summary_columns, values))
        columns.append({
            "name": entry.get("column_name"),
            "type": entry.get("column_type"),
            "null_percentage": entry.get("null_percentage"),
            "approx_unique": entry.get("approx_unique"),
            "min": entry.get("min"),
            "max": entry.get("max"),
        })
    return {"rows": rows, "columns_count": len(columns), "columns": columns}


def min_max_scale(values: list[float], value: float) -> float:
    minimum = min(values)
    maximum = max(values)
    if math.isclose(minimum, maximum):
        return 1.0
    return (value - minimum) / (maximum - minimum)


def rank_stores(connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        WITH dated AS (
          SELECT s.store_id, s.state_id, s.item_id, s.cat_id, c.date,
                 CAST(s.units_sold AS DOUBLE) AS units_sold,
                 p.sell_price
          FROM sales_long s
          LEFT JOIN calendar c ON c.d = s.day_id
          LEFT JOIN prices p
            ON p.store_id = s.store_id
           AND p.item_id = s.item_id
           AND p.wm_yr_wk = c.wm_yr_wk
        ), daily AS (
          SELECT store_id, date, sum(greatest(units_sold, 0)) AS daily_units
          FROM dated
          GROUP BY store_id, date
        ), stability AS (
          SELECT store_id,
                 count_if(daily_units > 0)::DOUBLE / count(*) AS day_continuity,
                 coalesce(stddev_pop(daily_units) / nullif(avg(daily_units), 0), 0) AS daily_cv
          FROM daily
          GROUP BY store_id
        )
        SELECT d.store_id, any_value(d.state_id) AS state_id,
               count(DISTINCT d.item_id) AS products,
               count(DISTINCT d.cat_id) AS categories,
               count(DISTINCT d.date) AS calendar_days,
               sum(d.units_sold) AS total_units,
               count(*) AS product_days,
               count_if(d.units_sold > 0) AS positive_rows,
               count_if(d.units_sold = 0) AS zero_rows,
               count_if(d.units_sold < 0) AS negative_rows,
               count(d.sell_price) AS priced_rows,
               min(d.date) FILTER (WHERE d.units_sold > 0) AS first_positive_date,
               max(d.date) FILTER (WHERE d.units_sold > 0) AS last_positive_date,
               s.day_continuity, s.daily_cv
        FROM dated d
        JOIN stability s USING (store_id)
        GROUP BY d.store_id, s.day_continuity, s.daily_cv
        ORDER BY d.store_id
        """
    ).fetchall()
    names = [description[0] for description in connection.description]
    stores = [dict(zip(names, row)) for row in rows]
    if not stores:
        raise ValueError("M5 sales data contains no stores")

    product_values = [float(store["products"]) for store in stores]
    category_values = [float(store["categories"]) for store in stores]
    continuity_values = [float(store["day_continuity"]) for store in stores]
    stability_values = [1 / (1 + float(store["daily_cv"])) for store in stores]
    price_values = [store["priced_rows"] / store["product_days"] for store in stores]
    nonzero_values = [store["positive_rows"] / store["product_days"] for store in stores]
    temporal_values = []
    for store in stores:
        first_date = store["first_positive_date"]
        last_date = store["last_positive_date"]
        span = (last_date - first_date).days + 1 if first_date and last_date else 0
        temporal_values.append(span / store["calendar_days"])
    log_volumes = [math.log1p(max(0, float(store["total_units"]))) for store in stores]
    median_log_volume = statistics.median(log_volumes)
    max_distance = max(abs(value - median_log_volume) for value in log_volumes) or 1

    for store, log_volume, temporal_coverage in zip(
        stores, log_volumes, temporal_values
    ):
        price_coverage = store["priced_rows"] / store["product_days"]
        nonzero_ratio = store["positive_rows"] / store["product_days"]
        stability = 1 / (1 + float(store["daily_cv"]))
        representativeness = 1 - abs(log_volume - median_log_volume) / max_distance
        components = {
            "product_coverage": min_max_scale(product_values, float(store["products"])),
            "category_diversity": min_max_scale(category_values, float(store["categories"])),
            "day_continuity": min_max_scale(continuity_values, float(store["day_continuity"])),
            "price_coverage": min_max_scale(price_values, price_coverage),
            "nonzero_ratio": min_max_scale(nonzero_values, nonzero_ratio),
            "sales_stability": min_max_scale(stability_values, stability),
            "volume_representativeness": representativeness,
            "temporal_coverage": min_max_scale(temporal_values, temporal_coverage),
        }
        store["zero_percentage"] = round(100 * store["zero_rows"] / store["product_days"], 4)
        store["price_coverage_percentage"] = round(100 * price_coverage, 4)
        store["ranking_components"] = {
            key: round(value, 6) for key, value in components.items()
        }
        store["score"] = round(
            0.20 * components["product_coverage"]
            + 0.15 * components["category_diversity"]
            + 0.10 * components["day_continuity"]
            + 0.20 * components["price_coverage"]
            + 0.10 * components["nonzero_ratio"]
            + 0.10 * components["sales_stability"]
            + 0.05 * components["volume_representativeness"]
            + 0.10 * components["temporal_coverage"],
            6,
        )

    return sorted(stores, key=lambda store: (-store["score"], store["store_id"]))


def resolve_selected_store(configured: str, ranking: list[dict[str, Any]]) -> str:
    store_ids = {str(store["store_id"]) for store in ranking}
    if configured == "auto":
        return str(ranking[0]["store_id"])
    if configured not in store_ids:
        raise ValueError(f"Configured store {configured!r} does not exist in M5")
    return configured
