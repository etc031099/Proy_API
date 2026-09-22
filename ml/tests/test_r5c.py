from __future__ import annotations

import json
import math
import unittest
from datetime import date, timedelta

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

    def test_no_observed_sale_uses_active_age_fallback(self) -> None:
        values = history()
        for record in values:
            record["unitsSold"] = 0
        result = self.builder.build(self.sku, ANCHOR, values)
        row = result.features.iloc[0]
        product = self.builder.products[result.item_id]
        active_start = product.active_start.date()
        active_age = (result.anchor_source_date - active_start).days
        self.assertEqual(row["has_prior_sale"], 0)
        self.assertEqual(row["days_since_last_sale"], active_age + 1)

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
    def test_final_anchor_features_match_gold(self) -> None:
        bronze = repository_path("ml/data/bronze/m5_store_daily.parquet")
        gold = repository_path("ml/data/gold/demand_features_v1.parquet")
        if not bronze.exists() or not gold.exists():
            self.skipTest("Validated Bronze and Gold artifacts are required")
        builder = DemandFeatureBuilder()
        scenario = json.loads(
            repository_path("ml/reports/scenario_cloud_demo_manifest.json").read_text(
                encoding="utf-8"
            )
        )
        sample = [scenario["selected_products"][index] for index in [0, 10, 20, 30, 40, 59]]
        connection = connect_duckdb()
        try:
            categorical = {
                entry["name"]
                for entry in builder.contract["features"]
                if entry["type"] == "categorical"
            }
            for item_id in sample:
                demand = connection.execute(
                    """
                    SELECT source_date, CAST(units_sold AS BIGINT)
                    FROM read_parquet(?)
                    WHERE store_id = 'CA_3' AND item_id = ?
                      AND source_date BETWEEN DATE '2015-01-01' AND DATE '2015-06-30'
                    ORDER BY source_date
                    """,
                    [str(bronze), item_id],
                ).fetchall()
                daily_sales = [
                    {
                        "date": (source_day + timedelta(days=3654)).isoformat(),
                        "unitsSold": units,
                    }
                    for source_day, units in demand
                ]
                actual = builder.build(
                    f"M5-{item_id}", ANCHOR, daily_sales
                ).features.iloc[0]
                selected = ", ".join(
                    '"' + name.replace('"', '""') + '"'
                    for name in builder.contract["feature_order"]
                )
                expected = connection.execute(
                    f"""
                    SELECT {selected} FROM read_parquet(?)
                    WHERE item_id = ? AND source_date = DATE '2015-06-30'
                    """,
                    [str(gold), item_id],
                ).fetchone()
                self.assertIsNotNone(expected, item_id)
                for index, name in enumerate(builder.contract["feature_order"]):
                    if name in categorical:
                        self.assertEqual(str(actual[name]), expected[index], (item_id, name))
                    else:
                        self.assertTrue(
                            math.isclose(
                                float(actual[name]), float(expected[index]),
                                rel_tol=1e-5, abs_tol=1e-5,
                            ),
                            (item_id, name, actual[name], expected[index]),
                        )
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
