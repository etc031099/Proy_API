from __future__ import annotations

import json
import math
import unittest
from datetime import date, timedelta
from unittest.mock import patch

import numpy as np

from ml.src.common import repository_path
from ml.src.m5 import connect_duckdb
from ml.src.serving.demand_features import (
    INSUFFICIENT_HISTORY,
    INVALID_HISTORY,
    MISSING_CALENDAR,
    MISSING_LINEAGE,
    MISSING_PRICE_HISTORY,
    READY,
    DemandFeatureBuilder,
    FeatureBuildError,
)


ANCHOR = date(2025, 7, 1)


def history(days: int = 57, *, anchor_units: int = 0) -> list[dict[str, object]]:
    start = ANCHOR - timedelta(days=days - 1)
    result = [
        {"date": (start + timedelta(days=index)).isoformat(), "unitsSold": index % 4}
        for index in range(days)
    ]
    result[-1]["unitsSold"] = anchor_units
    return result


class R5CFeatureBuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.builder = DemandFeatureBuilder()
        cls.sku = "M5-FOODS_1_033"

    def assert_code(self, expected: str, callback) -> None:
        with self.assertRaises(FeatureBuildError) as raised:
            callback()
        self.assertEqual(raised.exception.code, expected)

    def test_57_inclusive_days_are_ready_and_56_are_insufficient(self) -> None:
        result = self.builder.build(self.sku, ANCHOR, history(57))
        self.assertEqual(result.status, READY)
        self.assertEqual(result.features.shape, (1, 31))
        self.assertEqual(result.features.iloc[0]["has_prior_sale"], 1)
        self.assertEqual(result.features.iloc[0]["days_since_last_sale"], 1)
        self.assert_code(
            INSUFFICIENT_HISTORY,
            lambda: self.builder.build(self.sku, ANCHOR, history(56)),
        )

    def test_gap_duplicate_negative_nonfinite_and_bad_order_are_rejected(self) -> None:
        gap = history()
        gap.pop(20)
        gap.insert(0, {"date": (ANCHOR - timedelta(days=57)).isoformat(), "unitsSold": 0})
        self.assert_code(INVALID_HISTORY, lambda: self.builder.build(self.sku, ANCHOR, gap))
        duplicate = history()
        duplicate[10]["date"] = duplicate[9]["date"]
        self.assert_code(
            INVALID_HISTORY, lambda: self.builder.build(self.sku, ANCHOR, duplicate)
        )
        for invalid in (-1, np.nan, np.inf, 1.5, "2"):
            bad = history()
            bad[0]["unitsSold"] = invalid
            self.assert_code(
                INVALID_HISTORY, lambda bad=bad: self.builder.build(self.sku, ANCHOR, bad)
            )
        reversed_history = list(reversed(history()))
        self.assert_code(
            INVALID_HISTORY,
            lambda: self.builder.build(self.sku, ANCHOR, reversed_history),
        )

    def test_unknown_sku_and_incorrect_context_are_rejected(self) -> None:
        self.assert_code(
            MISSING_LINEAGE,
            lambda: self.builder.build("M5-UNKNOWN", ANCHOR, history()),
        )
        self.assert_code(
            INVALID_HISTORY,
            lambda: self.builder.build(self.sku, "2025-06-30", history()),
        )
        self.assert_code(
            MISSING_LINEAGE,
            lambda: self.builder.build(
                self.sku, ANCHOR, history(), business_id="OTHER"
            ),
        )

    def test_missing_calendar_and_price_have_specific_codes(self) -> None:
        source_anchor = date(2015, 6, 30)
        calendar = self.builder.calendar.pop(source_anchor)
        try:
            self.assert_code(
                MISSING_CALENDAR,
                lambda: self.builder.build(self.sku, ANCHOR, history()),
            )
        finally:
            self.builder.calendar[source_anchor] = calendar
        item_id = self.sku.removeprefix("M5-")
        price = self.builder.prices.pop((item_id, source_anchor))
        try:
            self.assert_code(
                MISSING_PRICE_HISTORY,
                lambda: self.builder.build(self.sku, ANCHOR, history()),
            )
        finally:
            self.builder.prices[(item_id, source_anchor)] = price

    def test_demand_formulas_order_std_and_anchor_sale(self) -> None:
        values = history(anchor_units=9)
        result = self.builder.build(self.sku, ANCHOR, values)
        row = result.features.iloc[0]
        units = np.asarray([record["unitsSold"] for record in values], dtype=float)
        self.assertEqual(list(result.features.columns), self.builder.contract["feature_order"])
        self.assertEqual(row["current_units"], 9)
        self.assertEqual(row["lag_56"], units[-57])
        self.assertEqual(row["rolling_sum_7"], units[-7:].sum())
        self.assertAlmostEqual(row["rolling_std_28"], units[-28:].std(ddof=1), places=5)
        self.assertEqual(row["days_since_last_sale"], 0)
        self.assertEqual(row["has_prior_sale"], 1)
        numeric = result.features.select_dtypes(include=["number"]).to_numpy()
        self.assertTrue(np.isfinite(numeric).all())

    def test_zero_anchor_uses_most_recent_positive_day(self) -> None:
        values = history(anchor_units=0)
        values[-2]["unitsSold"] = 7
        row = self.builder.build(self.sku, ANCHOR, values).features.iloc[0]
        self.assertEqual(row["days_since_last_sale"], 1)

    def test_zero_window_after_active_start_is_insufficient_before_features(self) -> None:
        for days in (57, 181):
            with self.subTest(days=days):
                values = history(days)
                for record in values:
                    record["unitsSold"] = 0
                with patch("ml.src.serving.demand_features.validate_and_order_features") as validate:
                    with self.assertRaises(FeatureBuildError) as raised:
                        self.builder.build(self.sku, ANCHOR, values)
                    self.assertEqual(raised.exception.code, INSUFFICIENT_HISTORY)
                    self.assertIn("recency", str(raised.exception))
                    validate.assert_not_called()

    def test_no_sale_with_coverage_from_or_before_active_start_matches_gold_semantics(self) -> None:
        product = self.builder.products[self.sku.removeprefix("M5-")]
        active_start = product.active_start.date()
        operational_start = active_start + timedelta(days=self.builder.manifest["date_offset_days"])
        for extra_days in (0, 1):
            with self.subTest(extra_days=extra_days):
                values = history((ANCHOR - operational_start).days + 1 + extra_days)
                for record in values:
                    record["unitsSold"] = 0
                result = self.builder.build(self.sku, ANCHOR, values)
                row = result.features.iloc[0]
                self.assertEqual(result.status, READY)
                self.assertEqual(row["has_prior_sale"], 0)
                self.assertEqual(row["days_since_last_sale"], (result.anchor_source_date - active_start).days + 1)

    def test_sale_180_days_ago_remains_known_only_with_full_received_history(self) -> None:
        values = history(181)
        for record in values:
            record["unitsSold"] = 0
        values[0]["unitsSold"] = 3
        result = self.builder.build(self.sku, ANCHOR, values)
        self.assertEqual(result.status, READY)
        self.assertEqual(result.features.iloc[0]["has_prior_sale"], 1)
        self.assertEqual(result.features.iloc[0]["days_since_last_sale"], 180)
        self.assert_code(
            INSUFFICIENT_HISTORY,
            lambda: self.builder.build(self.sku, ANCHOR, values[-57:]),
        )

    def test_lineage_categories_are_passed_through_without_invention(self) -> None:
        source_anchor = date(2015, 6, 30)
        calendar = self.builder.calendar[source_anchor]
        self.builder.calendar[source_anchor] = calendar._replace(
            event_name_1="UNSEEN_SERVING_EVENT"
        )
        item_id = self.sku.removeprefix("M5-")
        product = self.builder.products[item_id]
        self.builder.products[item_id] = product._replace(cat_id="UNSEEN_CATEGORY")
        try:
            row = self.builder.build(self.sku, ANCHOR, history()).features.iloc[0]
            self.assertEqual(str(row["event_name_1"]), "UNSEEN_SERVING_EVENT")
            self.assertEqual(str(row["cat_id"]), "UNSEEN_CATEGORY")
        finally:
            self.builder.calendar[source_anchor] = calendar
            self.builder.products[item_id] = product


class R5CGoldEquivalenceTests(unittest.TestCase):
    def test_all_cloud_demo_products_match_gold_at_final_anchor(self) -> None:
        required = [
            repository_path(path)
            for path in (
                "ml/data/bronze/m5_store_daily.parquet",
                "ml/data/gold/demand_features_v1.parquet",
                "ml/data/serving/cloud_demo_lineage_manifest.json",
                "ml/data/serving/cloud_demo_product_lineage.parquet",
                "ml/data/serving/cloud_demo_calendar.parquet",
                "ml/data/serving/cloud_demo_price_lineage.parquet",
                "ml/models/demand_forecast_v1_contract.json",
            )
        ]
        missing = [str(path.relative_to(repository_path("."))) for path in required if not path.is_file()]
        if missing:
            self.skipTest(f"Gold-serving parity artifacts are unavailable: {', '.join(missing)}")

        builder = DemandFeatureBuilder()
        manifest = builder.manifest
        self.assertEqual(manifest["source_anchor"], "2015-06-30")
        self.assertEqual(manifest["operational_anchor"], "2025-07-01")
        product_ids = sorted(builder.products)
        self.assertEqual(len(product_ids), 60, "Lineage must contain exactly 60 unique products")
        skus = [f"M5-{item_id}" for item_id in product_ids]
        self.assertEqual(len(set(skus)), 60, "Lineage-derived SKUs must be unique")
        feature_order = builder.contract["feature_order"]
        self.assertEqual(len(feature_order), 31, "demand-v1 contract must contain exactly 31 features")
        self.assertEqual(len(set(feature_order)), 31, "demand-v1 feature names must be unique")
        categorical = {
            feature["name"] for feature in builder.contract["features"]
            if feature["type"] == "categorical"
        }
        self.assertEqual(set(feature["name"] for feature in builder.contract["features"]), set(feature_order))

        connection = connect_duckdb()
        try:
            bronze = required[0]
            gold = required[1]
            gold_columns = [row[0] for row in connection.execute(
                "DESCRIBE SELECT * FROM read_parquet(?)", [str(gold)]
            ).fetchall()]
            feature_start = gold_columns.index(feature_order[0])
            self.assertEqual(
                gold_columns[feature_start:feature_start + len(feature_order)],
                feature_order,
                "Gold feature names/order differ from the demand-v1 contract",
            )
            selected = ", ".join('"' + name.replace('"', '""') + '"' for name in feature_order)
            sku_to_item = {f"M5-{item_id}": item_id for item_id in product_ids}
            for sku in skus:
                item_id = sku_to_item[sku]
                demand = connection.execute(
                    """SELECT source_date, CAST(units_sold AS BIGINT)
                       FROM read_parquet(?)
                       WHERE store_id = ? AND item_id = ? AND source_date <= DATE '2015-06-30'
                       ORDER BY source_date""",
                    [str(bronze), manifest["store_id"], item_id],
                ).fetchall()
                self.assertTrue(demand, f"No Bronze history for {sku}")
                daily_sales = [
                    {
                        "date": (source_day + timedelta(days=3654)).isoformat(),
                        "unitsSold": units,
                    }
                    for source_day, units in demand
                ]
                result = builder.build(sku, ANCHOR, daily_sales)
                self.assertEqual(result.status, READY, f"{sku} should be READY")
                self.assertEqual(result.anchor_source_date, date(2015, 6, 30), sku)
                self.assertEqual(list(result.features.columns), feature_order, sku)
                actual = result.features.iloc[0]
                expected = connection.execute(
                    f"""
                    SELECT {selected} FROM read_parquet(?)
                    WHERE item_id = ? AND source_date = DATE '2015-06-30'
                      AND split = 'train'
                    """,
                    [str(gold), item_id],
                ).fetchone()
                self.assertIsNotNone(expected, f"Gold row missing for {sku} at 2015-06-30")
                for index, name in enumerate(feature_order):
                    gold_value = expected[index]
                    serving_value = actual[name]
                    gold_missing = gold_value is None or (
                        isinstance(gold_value, (float, np.floating)) and math.isnan(float(gold_value))
                    )
                    serving_missing = serving_value is None or (
                        isinstance(serving_value, (float, np.floating)) and math.isnan(float(serving_value))
                    )
                    self.assertEqual(gold_missing, serving_missing,
                                     f"Missing semantics differ for sku={sku}, feature={name}, Gold={gold_value!r}, serving={serving_value!r}")
                    if gold_missing:
                        self.assertTrue(builder.contract["features"][index]["nullable"], name)
                        continue
                    if name in categorical:
                        self.assertIsInstance(gold_value, str, (sku, name, type(gold_value)))
                        self.assertIsInstance(serving_value, str, (sku, name, type(serving_value)))
                        self.assertEqual(str(serving_value), str(gold_value), (sku, name, gold_value, serving_value))
                    else:
                        self.assertIsInstance(gold_value, (int, float, np.number), (sku, name, type(gold_value)))
                        self.assertIsInstance(serving_value, (int, float, np.number), (sku, name, type(serving_value)))
                        self.assertTrue(math.isfinite(float(gold_value)), (sku, name, gold_value))
                        self.assertTrue(math.isfinite(float(serving_value)), (sku, name, serving_value))
                        self.assertTrue(
                            math.isclose(
                                float(serving_value), float(gold_value),
                                rel_tol=1e-5, abs_tol=1e-5,
                            ),
                            (sku, name, gold_value, serving_value),
                        )
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
