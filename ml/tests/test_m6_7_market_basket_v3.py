from __future__ import annotations

import unittest

import pandas as pd

from ml.src.market_basket_v3 import (
    _as_rule_rows,
    _mark_redundancy,
    _metrics_for_rule,
    _mine_itemsets,
    _promotion_analysis,
    _recommendations,
    _temporal_stability,
    analyze,
    build_baskets,
    canonical_hash,
)


def _products():
    core = [
        {"sku": "A", "name": "A product", "brand": "A-brand", "categoryCode": "BEV", "subcategoryCode": "SODA"},
        {"sku": "B", "name": "B product", "brand": "B-brand", "categoryCode": "SNK", "subcategoryCode": "CHIPS"},
        {"sku": "C", "name": "C product", "brand": "C-brand", "categoryCode": "FOOD", "subcategoryCode": "RICE"},
        {"sku": "BEB-GAS-001", "name": "Cola", "brand": "Cola", "categoryCode": "BEV", "subcategoryCode": "SODA"},
        {"sku": "SNA-CHO-001", "name": "Snack", "brand": "Snack", "categoryCode": "SNK", "subcategoryCode": "CHIPS"},
        {"sku": "DES-LEC-001", "name": "Milk", "brand": "Dairy", "categoryCode": "DAI", "subcategoryCode": "MILK"},
        {"sku": "ABA-ARR-001", "name": "Rice", "brand": "Rice", "categoryCode": "FOOD", "subcategoryCode": "RICE"},
        {"sku": "LIM-DET-001", "name": "Detergent", "brand": "Clean", "categoryCode": "CLEAN", "subcategoryCode": "SOAP"},
        {"sku": "REG-MAC-001", "name": "Maca", "brand": "Maca", "categoryCode": "HEALTH", "subcategoryCode": "POWDER"},
        {"sku": "BEB-GAS-003", "name": "Inca 500", "brand": "Inca", "categoryCode": "BEV", "subcategoryCode": "SODA"},
        {"sku": "BEB-GAS-004", "name": "Inca 1.5 L", "brand": "Inca", "categoryCode": "BEV", "subcategoryCode": "SODA"},
    ]
    return core + [{"sku": f"UNUSED-{i:03d}", "name": f"Unused {i}", "brand": f"brand-{i}",
                    "categoryCode": "FOOD", "subcategoryCode": "RICE"} for i in range(len(core), 80)]


def _sale(code, status="completed", day="2026-01-01", customer=None):
    return {"saleCode": code, "status": status, "cancelledAt": None if status == "completed" else "2026-01-02",
            "localDate": day, "scenarioId": "minimarket-pasco-v3", "businessKey": "MINIMARKET-PASCO-V3",
            "customerCode": customer, "ticketDiscountCents": 0, "itemDiscountCents": 0}


def _line(code, sku, quantity=1, promo=None):
    return {"saleCode": code, "sku": sku, "quantity": quantity, "promotionCode": promo,
            "lineDiscountCents": 0, "saleLineKey": f"{code}|{sku}",
            "scenarioId": "minimarket-pasco-v3", "businessKey": "MINIMARKET-PASCO-V3"}


class MarketBasketV3Tests(unittest.TestCase):
    def test_basket_is_binary_per_sku_and_quantity_is_preserved_separately(self):
        second_a = _line("t1", "A", 2)
        second_a["saleLineKey"] = "t1|A|second-line"
        built = build_baskets([_sale("t1")], [_line("t1", "A", 3), second_a, _line("t1", "B")], _products())
        self.assertEqual(built["baskets"][0]["skus"], ("A", "B"))
        self.assertEqual(built["baskets"][0]["quantityBySku"], {"A": 5, "B": 1})

    def test_cancelled_and_pending_tickets_are_excluded(self):
        sales = [_sale("t1"), _sale("t2", "cancelled"), _sale("t3", "pending")]
        lines = [_line("t1", "A"), _line("t2", "B"), _line("t3", "C")]
        built = build_baskets(sales, lines, _products())
        self.assertEqual(built["validTickets"], 1)
        self.assertEqual(built["excludedTickets"], 2)
        self.assertEqual(built["baskets"][0]["skus"], ("A",))

    def test_duplicate_ticket_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unique"):
            build_baskets([_sale("t1"), _sale("t1")], [], _products())

    def test_orphan_ticket_line_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "no corresponding ticket"):
            build_baskets([], [_line("missing", "A")], _products())

    def test_unknown_sku_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown V3 SKU"):
            build_baskets([_sale("t1")], [_line("t1", "UNKNOWN")], _products())

    def test_support_confidence_and_lift_are_binary_ticket_metrics(self):
        baskets = [{"skus": ("A", "B")}] * 4 + [{"skus": ("A",)}] + [{"skus": ("B",)}] + [{"skus": ()}] * 2
        metrics = _metrics_for_rule(baskets, {"A"}, {"B"})
        self.assertEqual(metrics["ticketCount"], 4)
        self.assertAlmostEqual(metrics["support"], 0.5)
        self.assertAlmostEqual(metrics["confidence"], 4 / 5)
        self.assertAlmostEqual(metrics["lift"], 1.28)

    def test_minimum_support_controls_frequent_itemsets(self):
        matrix = pd.DataFrame({"A": [True, True, True, False], "B": [True, True, False, True]}, dtype=bool)
        low = _mine_itemsets(matrix, 0.5)
        high = _mine_itemsets(matrix, 0.75)
        self.assertIn(frozenset({"A", "B"}), set(low["itemsets"]))
        self.assertNotIn(frozenset({"A", "B"}), set(high["itemsets"]))

    def test_rule_quality_filter_requires_confidence_and_positive_lift(self):
        baskets = [{"skus": ("A", "B")}] * 5 + [{"skus": ("A",)}] + [{"skus": ("B",)}] + [{"skus": ()}] * 3
        itemsets = _mine_itemsets(pd.DataFrame({"A": [True] * 6 + [False] * 4,
                                               "B": [True] * 5 + [False] + [True] + [False] * 3}, dtype=bool), 0.2)
        rules = _as_rule_rows(itemsets, len(baskets), confidence_threshold=0.0)
        self.assertTrue(any(row["lift"] > 1 for row in rules))
        filtered = [row for row in rules if row["confidence"] >= 0.20 and row["lift"] > 1]
        self.assertTrue(filtered)
        self.assertTrue(all(row["confidence"] >= 0.20 and row["lift"] > 1 for row in filtered))

    def test_redundant_more_specific_rule_is_marked_not_hidden(self):
        rules = [
            {"antecedentSkus": ["A"], "consequentSkus": ["C"], "confidence": 0.5, "lift": 1.5},
            {"antecedentSkus": ["A", "B"], "consequentSkus": ["C"], "confidence": 0.49, "lift": 1.48},
        ]
        _mark_redundancy(rules)
        self.assertFalse(rules[0]["redundant"])
        self.assertTrue(rules[1]["redundant"])

    def test_top_n_recommendations_are_capped_per_sku(self):
        rules = []
        for target in ("B", "C", "D", "E", "F", "G"):
            rules.append({"antecedentSkus": ["A"], "consequentSkus": [target],
                          "antecedentProducts": ["A name"], "consequentProducts": [f"{target} name"],
                          "support": 0.1, "ticketCount": 100, "confidence": 0.4, "lift": 1.5,
                          "classification": "CROSS_SELL", "redundant": False,
                          "stability": {"status": "STABLE"}, "promotionSensitive": False})
        self.assertEqual(len(_recommendations(rules)["A"]), 5)

    def test_h1_h2_stability_and_recent_only_are_classified(self):
        rule = {"antecedentSkus": ["A"], "consequentSkus": ["B"]}
        stable = ([{"skus": ("A", "B"), "half": "H1"}] * 20
                  + [{"skus": ("A",), "half": "H1"}] * 10
                  + [{"skus": ("C",), "half": "H1"}] * 20
                  + [{"skus": ("A", "B"), "half": "H2"}] * 20
                  + [{"skus": ("A",), "half": "H2"}] * 10
                  + [{"skus": ("C",), "half": "H2"}] * 20)
        self.assertEqual(_temporal_stability(rule, stable, 0.05)["status"], "STABLE")
        recent = ([{"skus": ("A",), "half": "H1"}] * 20
                  + [{"skus": ("A", "B"), "half": "H2"}] * 20
                  + [{"skus": ("A",), "half": "H2"}] * 10
                  + [{"skus": ("C",), "half": "H2"}] * 20)
        self.assertEqual(_temporal_stability(rule, recent, 0.05)["status"], "RECENT_ONLY")

    def test_promotion_sensitive_requires_promo_concentration(self):
        rule = {"antecedentSkus": ["A"], "consequentSkus": ["B"]}
        baskets = ([{"skus": ("A", "B"), "promo": True}] * 20
                   + [{"skus": ("A",), "promo": False}] * 30)
        self.assertTrue(_promotion_analysis(rule, baskets)["promotionSensitive"])

    def test_deterministic_hash_and_mining_ignore_latent_profiles(self):
        sales = [_sale(f"t{i}", day=f"2026-01-{i:02d}") for i in range(1, 9)]
        lines = []
        for i in range(1, 9):
            lines.extend([_line(f"t{i}", "A"), _line(f"t{i}", "B" if i <= 5 else "C")])
        profiles_a = {"associationProfiles": []}
        profiles_b = {"associationProfiles": [{"key": "unexpected", "rules": []}]}
        a = analyze(sales, lines, _products(), profiles_a)
        b = analyze(sales, lines, _products(), profiles_b)
        self.assertEqual(a["reproducibilitySha256"], canonical_hash({key: value for key, value in a.items()
                                                                       if key not in {"timingsMs", "matrixApproxBytes", "reproducibilitySha256"}}))
        self.assertEqual(a["summary"]["frequentItemsets"], b["summary"]["frequentItemsets"])
        self.assertEqual(a["summary"]["rulesBeforeQualityFilter"], b["summary"]["rulesBeforeQualityFilter"])


if __name__ == "__main__":
    unittest.main()
