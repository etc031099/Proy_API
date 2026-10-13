"""Reproducible, ticket-level Market Basket Analysis for synthetic Pasco V3."""
from __future__ import annotations

import hashlib
import json
import math
import time
import warnings
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
from mlxtend.frequent_patterns import association_rules, fpgrowth

from ml.src import v3_forecast

ANALYSIS_VERSION = "MINIMARKET-PASCO-V3-MBA-v1"
CUTOFF = date(2026, 10, 12)
CANDIDATE_SUPPORTS = (0.0025, 0.005, 0.01, 0.02)
CANDIDATE_CONFIDENCES = (0.15, 0.20, 0.25)
MIN_SUPPORT = 0.0025
MIN_CONFIDENCE = 0.15
MIN_LIFT = 1.0
MAX_ITEMSET_SIZE = 3
MIN_SEGMENT_TICKETS = 500
CODE_VERSION = "m6.7-source-v1"


def _read_ndjson(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _ticket_row_valid(row: dict[str, Any]) -> bool:
    return row.get("status") == "completed" and row.get("cancelledAt") is None and row.get("localDate", "") <= CUTOFF.isoformat()


def build_baskets(sales: list[dict[str, Any]], sale_items: list[dict[str, Any]],
                  products: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate source rows and make binary SKU baskets; quantities remain auxiliary."""
    sku_catalog = {row["sku"]: row for row in products}
    if len(sku_catalog) != 80:
        raise ValueError("V3 catalog must contain exactly 80 unique SKUs")
    sale_by_code: dict[str, dict[str, Any]] = {}
    for row in sales:
        code = row.get("saleCode")
        if not code or code in sale_by_code:
            raise ValueError("Sale ticket identifiers must be present and unique")
        if row.get("scenarioId") != v3_forecast.SCENARIO_ID or row.get("businessKey") != "MINIMARKET-PASCO-V3":
            raise ValueError("Sale row crosses the V3 business/scenario boundary")
        sale_by_code[code] = row

    lines_by_ticket: dict[str, list[dict[str, Any]]] = defaultdict(list)
    line_keys: set[str] = set()
    for line in sale_items:
        code, sku = line.get("saleCode"), line.get("sku")
        if code not in sale_by_code:
            raise ValueError("Sale item has no corresponding ticket")
        if line.get("scenarioId") != v3_forecast.SCENARIO_ID or line.get("businessKey") != "MINIMARKET-PASCO-V3":
            raise ValueError("Sale item crosses the V3 business/scenario boundary")
        if sku not in sku_catalog:
            raise ValueError("Sale item references an unknown V3 SKU")
        key = line.get("saleLineKey")
        if not key or key in line_keys:
            raise ValueError("Sale item identifiers must be present and unique")
        line_keys.add(key)
        if int(line.get("quantity", 0)) < 1:
            raise ValueError("Sale item quantity must be a positive integer")
        lines_by_ticket[code].append(line)

    valid_sales = [row for row in sales if _ticket_row_valid(row)]
    valid_codes = {row["saleCode"] for row in valid_sales}
    baskets: list[dict[str, Any]] = []
    for sale in valid_sales:
        lines = lines_by_ticket.get(sale["saleCode"], [])
        if not lines:
            raise ValueError("Completed ticket has no sale items")
        quantity_by_sku: Counter[str] = Counter()
        promo = int(sale.get("ticketDiscountCents", 0) or 0) > 0 or int(sale.get("itemDiscountCents", 0) or 0) > 0
        for line in lines:
            quantity_by_sku[line["sku"]] += int(line["quantity"])
            promo = promo or bool(line.get("promotionCode")) or int(line.get("lineDiscountCents", 0) or 0) > 0
        baskets.append({
            "saleCode": sale["saleCode"], "localDate": sale["localDate"],
            "skus": tuple(sorted(quantity_by_sku)), "quantityBySku": dict(sorted(quantity_by_sku.items())),
            "promo": bool(promo), "customerSegment": "registered" if sale.get("customerCode") else "consumer_final",
        })

    start = min(row["localDate"] for row in valid_sales) if valid_sales else None
    date_span = (CUTOFF - date.fromisoformat(start)).days + 1 if start else 0
    midpoint = date.fromisoformat(start).fromordinal(date.fromisoformat(start).toordinal() + date_span // 2) if start else CUTOFF
    for basket in baskets:
        basket["half"] = "H1" if date.fromisoformat(basket["localDate"]) < midpoint else "H2"
    if len(valid_codes) != len(valid_sales):
        raise ValueError("Completed ticket identifiers are not unique")
    return {"baskets": baskets, "totalSales": len(sales), "validTickets": len(valid_sales),
            "excludedTickets": len(sales) - len(valid_sales), "saleItems": len(sale_items),
            "orphanSaleItems": 0, "uniqueTicketIds": len(sale_by_code), "knownSkus": len(sku_catalog),
            "midpointDate": midpoint.isoformat()}


def _binary_matrix(baskets: list[dict[str, Any]], item_names: Iterable[str],
                   transform: dict[str, str] | None = None) -> pd.DataFrame:
    names = sorted(set(item_names))
    rows: list[dict[str, bool]] = []
    for basket in baskets:
        items = {transform.get(sku, sku) for sku in basket["skus"]} if transform else set(basket["skus"])
        rows.append({name: name in items for name in names})
    return pd.DataFrame(rows, columns=names, dtype=bool)


def _mine_itemsets(matrix: pd.DataFrame, minimum_support: float) -> pd.DataFrame:
    if matrix.empty or matrix.shape[1] < 2:
        return pd.DataFrame(columns=["support", "itemsets"])
    return fpgrowth(matrix, min_support=minimum_support, use_colnames=True, max_len=MAX_ITEMSET_SIZE)


def _as_rule_rows(itemsets: pd.DataFrame, ticket_count: int, confidence_threshold: float = 0.0) -> list[dict[str, Any]]:
    if itemsets.empty or not any(len(items) > 1 for items in itemsets["itemsets"]):
        return []
    with warnings.catch_warnings():
        # mlxtend calculates an intermediate conviction division before replacing
        # zero-denominator cases with zero; those expected intermediates are not output.
        warnings.filterwarnings("ignore", category=RuntimeWarning, module=r"mlxtend\.frequent_patterns\.association_rules")
        raw = association_rules(itemsets, metric="confidence", min_threshold=confidence_threshold)
    result = []
    for row in raw.to_dict(orient="records"):
        antecedents = tuple(sorted(row["antecedents"]))
        consequents = tuple(sorted(row["consequents"]))
        count = int(round(float(row["support"]) * ticket_count))
        result.append({"antecedentSkus": list(antecedents), "consequentSkus": list(consequents),
                       "support": float(row["support"]), "ticketCount": count,
                       "antecedentSupport": float(row["antecedent support"]),
                       "consequentSupport": float(row["consequent support"]),
                       "confidence": float(row["confidence"]), "lift": float(row["lift"]),
                       "leverage": float(row["leverage"]), "conviction": _finite_or_none(row["conviction"])})
    return sorted(result, key=_rule_sort_key)


def _finite_or_none(value: Any) -> float | None:
    value = float(value)
    return value if math.isfinite(value) else None


def _rule_sort_key(rule: dict[str, Any]) -> tuple[Any, ...]:
    return (-round(rule["support"], 12), -round(rule["confidence"], 12),
            -round(rule["lift"], 12), tuple(rule["antecedentSkus"]), tuple(rule["consequentSkus"]))


def explore_thresholds(matrix: pd.DataFrame) -> list[dict[str, Any]]:
    results = []
    n = len(matrix)
    for support in CANDIDATE_SUPPORTS:
        itemsets = _mine_itemsets(matrix, support)
        rows = _as_rule_rows(itemsets, n)
        for confidence in CANDIDATE_CONFIDENCES:
            quality = [row for row in rows if row["confidence"] >= confidence and row["lift"] > MIN_LIFT]
            results.append({"minSupport": support, "approxTicketCount": math.ceil(support * n),
                            "minConfidence": confidence, "frequentItemsets": len(itemsets),
                            "rulesGenerated": len(rows), "qualityRules": len(quality)})
    return results


def _metrics_for_rule(baskets: list[dict[str, Any]], antecedents: set[str], consequents: set[str]) -> dict[str, Any]:
    n = len(baskets)
    if n == 0:
        return {"ticketCount": 0, "support": 0.0, "confidence": 0.0, "lift": 0.0}
    a = b = both = 0
    for basket in baskets:
        items = set(basket["skus"])
        has_a, has_b = antecedents.issubset(items), consequents.issubset(items)
        a += has_a
        b += has_b
        both += has_a and has_b
    support = both / n
    confidence = both / a if a else 0.0
    consequent_support = b / n
    return {"ticketCount": both, "support": support, "confidence": confidence,
            "lift": confidence / consequent_support if consequent_support else 0.0}


def _temporal_stability(rule: dict[str, Any], baskets: list[dict[str, Any]], minimum_support: float) -> dict[str, Any]:
    halves = {name: [row for row in baskets if row["half"] == name] for name in ("H1", "H2")}
    antecedents, consequents = set(rule["antecedentSkus"]), set(rule["consequentSkus"])
    metrics = {name: _metrics_for_rule(rows, antecedents, consequents) for name, rows in halves.items()}
    qualifies = {name: value["ticketCount"] >= max(10, math.ceil(minimum_support * len(halves[name])))
                 and value["lift"] > MIN_LIFT for name, value in metrics.items()}
    if all(qualifies.values()):
        status = "STABLE" if abs(metrics["H1"]["confidence"] - metrics["H2"]["confidence"]) <= 0.25 else "UNSTABLE"
        if status == "STABLE" and max(metrics["H1"]["lift"], metrics["H2"]["lift"]) / max(1e-12, min(metrics["H1"]["lift"], metrics["H2"]["lift"])) > 2.0:
            status = "UNSTABLE"
    elif qualifies["H2"]:
        status = "RECENT_ONLY"
    elif qualifies["H1"]:
        status = "HISTORICAL_ONLY"
    else:
        status = "UNSTABLE"
    return {"status": status, "windows": metrics}


def _promotion_analysis(rule: dict[str, Any], baskets: list[dict[str, Any]]) -> dict[str, Any]:
    antecedents, consequents = set(rule["antecedentSkus"]), set(rule["consequentSkus"])
    both = [row for row in baskets if antecedents.issubset(set(row["skus"])) and consequents.issubset(set(row["skus"]))]
    promo = [row for row in baskets if row["promo"]]
    nonpromo = [row for row in baskets if not row["promo"]]
    promo_metrics = _metrics_for_rule(promo, antecedents, consequents)
    nonpromo_metrics = _metrics_for_rule(nonpromo, antecedents, consequents)
    promo_share = len([row for row in both if row["promo"]]) / len(both) if both else 0.0
    sensitive = len(both) >= 10 and promo_share >= 0.80 and nonpromo_metrics["ticketCount"] <= max(5, math.ceil(0.10 * len(both)))
    return {"promoTickets": promo_metrics["ticketCount"], "nonPromoTickets": nonpromo_metrics["ticketCount"],
            "promoSupport": promo_metrics["support"], "nonPromoSupport": nonpromo_metrics["support"],
            "promoConfidence": promo_metrics["confidence"], "nonPromoConfidence": nonpromo_metrics["confidence"],
            "promoLift": promo_metrics["lift"], "nonPromoLift": nonpromo_metrics["lift"],
            "promoShareAmongCooccurrences": promo_share, "promotionSensitive": sensitive}


def _classify_rule(rule: dict[str, Any], product_map: dict[str, dict[str, Any]]) -> str:
    source = [product_map[sku] for sku in rule["antecedentSkus"]]
    target = [product_map[sku] for sku in rule["consequentSkus"]]
    if len(source) == len(target) == 1 and source[0].get("brand") and source[0].get("brand") == target[0].get("brand"):
        return "SAME_BRAND_PRESENTATIONS_CO_PURCHASE"
    source_categories = {row["categoryCode"] for row in source}
    target_categories = {row["categoryCode"] for row in target}
    return "CROSS_SELL" if source_categories.isdisjoint(target_categories) else "SAME_CATEGORY_CO_PURCHASE"


def _mark_redundancy(rules: list[dict[str, Any]]) -> None:
    for rule in rules:
        rule["redundant"] = False
        a, c = set(rule["antecedentSkus"]), tuple(rule["consequentSkus"])
        if len(a) < 2:
            continue
        for simpler in rules:
            sa = set(simpler["antecedentSkus"])
            if sa < a and tuple(simpler["consequentSkus"]) == c:
                no_useful_gain = (simpler["confidence"] >= rule["confidence"] - 0.02
                                  and simpler["lift"] >= rule["lift"] - 0.05)
                if no_useful_gain:
                    rule["redundant"] = True
                    rule["redundantBy"] = {"antecedentSkus": sorted(sa), "consequentSkus": list(c)}
                    break


def _enrich_rules(rules: list[dict[str, Any]], baskets: list[dict[str, Any]], product_map: dict[str, dict[str, Any]],
                  min_support: float) -> list[dict[str, Any]]:
    enriched = []
    for raw in rules:
        rule = dict(raw)
        rule["antecedentProducts"] = [product_map[sku]["name"] for sku in rule["antecedentSkus"]]
        rule["consequentProducts"] = [product_map[sku]["name"] for sku in rule["consequentSkus"]]
        rule["classification"] = _classify_rule(rule, product_map)
        rule["popularConsequent"] = rule["consequentSupport"] >= 0.20
        rule["stability"] = _temporal_stability(rule, baskets, min_support)
        rule["promotion"] = _promotion_analysis(rule, baskets)
        rule["promotionSensitive"] = rule["promotion"]["promotionSensitive"]
        enriched.append(rule)
    _mark_redundancy(enriched)
    return enriched


def _category_products(products: list[dict[str, Any]], field: str,
                       taxonomy: dict[str, str] | None = None) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    if field not in {"categoryCode", "subcategoryCode"}:
        raise ValueError("Unsupported taxonomy level")
    mapping = {row["sku"]: row[field] for row in products}
    labels = {row[field]: (taxonomy or {}).get(row[field]) or
              (row.get("categoryName") if field == "categoryCode" else row.get("subcategoryName")) or row[field]
              for row in products}
    return {key: {"name": value, field: key} for key, value in labels.items()}, mapping


def _taxonomy_rules(baskets: list[dict[str, Any]], products: list[dict[str, Any]], field: str,
                    min_support: float, min_confidence: float, limit: int = 10,
                    taxonomy: dict[str, str] | None = None) -> list[dict[str, Any]]:
    labels, mapping = _category_products(products, field, taxonomy)
    matrix = _binary_matrix(baskets, mapping.values(), mapping)
    taxonomy_baskets = [dict(row, skus=tuple(sorted({mapping[sku] for sku in row["skus"]}))) for row in baskets]
    frequent = _mine_itemsets(matrix, min_support)
    rules = _as_rule_rows(frequent, len(baskets), min_confidence)
    rows = [row for row in rules if row["lift"] > MIN_LIFT]
    # Taxonomy is a directional summary over at least two distinct taxonomy items.
    output = []
    for row in rows:
        source, target = row["antecedentSkus"], row["consequentSkus"]
        row["antecedentLabels"] = [labels[key]["name"] for key in source]
        row["consequentLabels"] = [labels[key]["name"] for key in target]
        row["stability"] = _temporal_stability(row, taxonomy_baskets, min_support)
        row["antecedentCodes"] = row.pop("antecedentSkus")
        row["consequentCodes"] = row.pop("consequentSkus")
        output.append(row)
    output.sort(key=lambda r: (r["stability"]["status"] != "STABLE", -r["lift"], -r["confidence"], -r["support"], r["antecedentCodes"], r["consequentCodes"]))
    return output[:limit]


def audit_latent_profiles(rules: list[dict[str, Any]], products: list[dict[str, Any]], profile_doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Read generator association profiles only after mining, for an audit comparison."""
    sku_to_product = {row["sku"]: row for row in products}
    discovered_pairs = set()
    for rule in rules:
        if len(rule["antecedentSkus"]) == len(rule["consequentSkus"]) == 1:
            a, b = rule["antecedentSkus"][0], rule["consequentSkus"][0]
            discovered_pairs.add((sku_to_product[a]["categoryCode"], sku_to_product[a]["subcategoryCode"],
                                  sku_to_product[b]["categoryCode"], sku_to_product[b]["subcategoryCode"]))
    audit = []
    for profile in profile_doc.get("associationProfiles", []):
        for latent in profile.get("rules", []):
            candidates = [pair for pair in discovered_pairs
                          if pair[0] == latent["sourceCategoryCode"]
                          and pair[1] in latent.get("sourceSubcategoryCodes", [pair[1]])
                          and pair[2] in latent.get("targetCategoryCodes", [pair[2]])
                          and pair[3] in latent.get("targetSubcategoryCodes", [pair[3]])]
            status = "DISCOVERED" if len(candidates) >= 3 else "PARTIALLY_DISCOVERED" if candidates else "NOT_DISCOVERED"
            audit.append({"profileKey": profile["key"], "sourceCategoryCode": latent["sourceCategoryCode"],
                          "targetCategoryCodes": latent.get("targetCategoryCodes", []), "status": status,
                          "matchingSkuAssociations": len(candidates)})
    return audit


def _latent_alignment(rule: dict[str, Any], product_map: dict[str, dict[str, Any]], profile_doc: dict[str, Any]) -> str:
    source_rows = [product_map[sku] for sku in rule["antecedentSkus"]]
    target_rows = [product_map[sku] for sku in rule["consequentSkus"]]
    partial = False
    for profile in profile_doc.get("associationProfiles", []):
        for latent in profile.get("rules", []):
            source_category_match = any(row["categoryCode"] == latent["sourceCategoryCode"] for row in source_rows)
            target_category_match = any(row["categoryCode"] in latent.get("targetCategoryCodes", []) for row in target_rows)
            if source_category_match and target_category_match:
                source_sub_match = any(row["subcategoryCode"] in latent.get("sourceSubcategoryCodes", [row["subcategoryCode"]]) for row in source_rows)
                target_sub_match = any(row["subcategoryCode"] in latent.get("targetSubcategoryCodes", [row["subcategoryCode"]]) for row in target_rows)
                if source_sub_match and target_sub_match:
                    return "DISCOVERED_INTENT"
                partial = True
    return "PARTIALLY_ALIGNED_INTENT" if partial else "EMERGENT"


def _recommendations(rules: list[dict[str, Any]], limit_per_sku: int = 5) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    candidates = [row for row in rules if len(row["antecedentSkus"]) == len(row["consequentSkus"]) == 1
                  and row["classification"] == "CROSS_SELL" and row["lift"] > MIN_LIFT
                  and not row["redundant"] and row["stability"]["status"] == "STABLE"]
    candidates.sort(key=lambda r: (-r["support"], -r["confidence"], -min(r["lift"], 10.0), r["antecedentSkus"], r["consequentSkus"]))
    for row in candidates:
        source, target = row["antecedentSkus"][0], row["consequentSkus"][0]
        if len(result[source]) >= limit_per_sku:
            continue
        result[source].append({"sourceSku": source, "sourceProduct": row["antecedentProducts"][0],
                               "recommendedSku": target, "recommendedProduct": row["consequentProducts"][0],
                               "support": row["support"], "ticketCount": row["ticketCount"],
                               "confidence": row["confidence"], "lift": row["lift"],
                               "stability": row["stability"]["status"], "promotionSensitive": row["promotionSensitive"],
                               "reason": f"Co-occurred in {row['ticketCount']} valid tickets (lift {row['lift']:.2f})"})
    return dict(sorted(result.items()))


def _pair_presence_summary(baskets: list[dict[str, Any]], sku_a: str, sku_b: str) -> dict[str, Any]:
    metrics = _metrics_for_rule(baskets, {sku_a}, {sku_b})
    reverse = _metrics_for_rule(baskets, {sku_b}, {sku_a})
    return {"skuA": sku_a, "skuB": sku_b, "cooccurrenceTickets": metrics["ticketCount"],
            "support": metrics["support"], "confidenceAtoB": metrics["confidence"],
            "confidenceBtoA": reverse["confidence"], "lift": metrics["lift"]}


def _segment_summary(baskets: list[dict[str, Any]], matrix: pd.DataFrame) -> dict[str, Any]:
    result = {}
    for segment in ("consumer_final", "registered"):
        rows = [basket for basket in baskets if basket["customerSegment"] == segment]
        result[segment] = {"tickets": len(rows), "analyzed": len(rows) >= MIN_SEGMENT_TICKETS,
                           "reason": None if len(rows) >= MIN_SEGMENT_TICKETS else f"below {MIN_SEGMENT_TICKETS}-ticket minimum"}
    return result


def _segment_rules(baskets: list[dict[str, Any]], product_map: dict[str, dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    output = {}
    for segment in ("consumer_final", "registered"):
        rows = [basket for basket in baskets if basket["customerSegment"] == segment]
        if len(rows) < MIN_SEGMENT_TICKETS:
            output[segment] = []
            continue
        segment_support = max(0.01, 25 / len(rows))
        rules = _as_rule_rows(_mine_itemsets(_binary_matrix(rows, {sku for row in rows for sku in row["skus"]}), segment_support), len(rows), 0.20)
        output[segment] = [dict(rule, classification=_classify_rule(rule, product_map))
                           for rule in rules if rule["lift"] > MIN_LIFT][:5]
    return output


def analyze(sales: list[dict[str, Any]], sale_items: list[dict[str, Any]], products: list[dict[str, Any]],
            profile_doc: dict[str, Any] | None = None,
            category_doc: dict[str, Any] | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    built = build_baskets(sales, sale_items, products)
    baskets = built["baskets"]
    product_map = {row["sku"]: row for row in products}
    matrix = _binary_matrix(baskets, product_map)
    preprocess_ms = round((time.perf_counter() - started) * 1000, 2)

    exploration_started = time.perf_counter()
    exploration = explore_thresholds(matrix)
    exploration_ms = round((time.perf_counter() - exploration_started) * 1000, 2)
    fp_started = time.perf_counter()
    frequent = _mine_itemsets(matrix, MIN_SUPPORT)
    fp_ms = round((time.perf_counter() - fp_started) * 1000, 2)
    rules_started = time.perf_counter()
    rules_before = _as_rule_rows(frequent, len(baskets))
    quality = [row for row in rules_before if row["confidence"] >= MIN_CONFIDENCE and row["lift"] > MIN_LIFT]
    rules = _enrich_rules(quality, baskets, product_map, MIN_SUPPORT)
    rules.sort(key=_rule_sort_key)
    rules_after_count = sum(not row["redundant"] for row in rules)
    rules_ms = round((time.perf_counter() - rules_started) * 1000, 2)

    # Latent generator profiles are deliberately opened only after FP-Growth and rule mining.
    if profile_doc is None:
        profile_doc = json.loads((Path(__file__).resolve().parents[2] / "data/minimarket-pasco-v3/profiles.json").read_text(encoding="utf-8"))
    latent_audit = audit_latent_profiles(rules, products, profile_doc)
    for rule in rules:
        rule["latentAudit"] = _latent_alignment(rule, product_map, profile_doc)

    recommendations = _recommendations(rules)
    sku_top = [row for row in rules if not row["redundant"]][:20]
    frequent_itemset_rows = [
        {"itemSkus": sorted(items), "size": len(items), "support": float(support),
         "ticketCount": int(round(float(support) * len(baskets)))}
        for support, items in frequent[["support", "itemsets"]].itertuples(index=False, name=None)
    ]
    frequent_itemset_rows.sort(key=lambda row: (row["size"], -row["support"], row["itemSkus"]))
    category_doc = category_doc or json.loads((Path(__file__).resolve().parents[2] / "data/minimarket-pasco-v3/categories.json").read_text(encoding="utf-8"))
    category_names = {row["code"]: row["name"] for row in category_doc.get("categories", [])}
    subcategory_names = {sub["code"]: sub["name"] for row in category_doc.get("categories", []) for sub in row.get("subcategories", [])}
    taxonomy_started = time.perf_counter()
    category_rules = _taxonomy_rules(baskets, products, "categoryCode", MIN_SUPPORT, MIN_CONFIDENCE, 10, category_names)
    subcategory_rules = _taxonomy_rules(baskets, products, "subcategoryCode", MIN_SUPPORT, MIN_CONFIDENCE, 10, subcategory_names)
    taxonomy_ms = round((time.perf_counter() - taxonomy_started) * 1000, 2)
    inca_pair = _pair_presence_summary(baskets, "BEB-GAS-003", "BEB-GAS-004")
    coca = recommendations.get("BEB-GAS-001", [])
    cross_sell_rules = [row for row in rules if row["classification"] == "CROSS_SELL" and not row["redundant"]]
    latent_statuses = Counter(row["status"] for row in latent_audit)
    baskets_by_size = Counter(len(row["skus"]) for row in baskets)
    quantity_totals: Counter[str] = Counter()
    for basket in baskets:
        quantity_totals.update(basket["quantityBySku"])
    promos = sum(row["promo"] for row in baskets)
    example_skus = {"popularBeverage": "BEB-GAS-001", "snack": "SNA-CHO-001", "milkBreakfast": "DES-LEC-001",
                    "riceStaple": "ABA-ARR-001", "cleaning": "LIM-DET-001", "lowVolume": "REG-MAC-001",
                    "incaKola500ml": "BEB-GAS-003", "incaKola15L": "BEB-GAS-004"}
    product_examples = {}
    for label, sku in example_skus.items():
        direct_rules = [row for row in rules if sku in row["antecedentSkus"] or sku in row["consequentSkus"]]
        product_examples[label] = {"sku": sku, "productName": product_map[sku]["name"],
                                   "qualityAssociationCount": len(direct_rules),
                                   "qualityAssociations": direct_rules[:5],
                                   "crossSellRecommendations": recommendations.get(sku, [])}
    segment_rules = _segment_rules(baskets, product_map)
    summary = {
        "totalTickets": built["totalSales"], "validTickets": built["validTickets"],
        "excludedTickets": built["excludedTickets"], "saleItems": built["saleItems"],
        "uniqueTicketIds": built["uniqueTicketIds"], "knownSkus": built["knownSkus"], "orphanSaleItems": built["orphanSaleItems"],
        "averageDistinctSkusPerTicket": sum(len(row["skus"]) for row in baskets) / len(baskets),
        "basketSizeDistribution": {str(key): baskets_by_size[key] for key in sorted(baskets_by_size)},
        "singletonTicketsInSupportDenominator": baskets_by_size.get(1, 0),
        "promoTickets": promos, "nonPromoTickets": len(baskets) - promos,
        "frequentItemsets": len(frequent), "frequentPairs": sum(len(items) == 2 for items in frequent["itemsets"]),
        "frequentTriples": sum(len(items) == 3 for items in frequent["itemsets"]),
        "rulesBeforeQualityFilter": len(rules_before), "rulesAfterQualityFilter": len(rules),
        "rulesAfterRedundancyReduction": rules_after_count,
        "redundantRules": len(rules) - rules_after_count, "skuCrossSellRules": len(cross_sell_rules),
        "promotionSensitiveRules": sum(row["promotionSensitive"] for row in rules),
        "perfectConfidenceRules": sum(math.isclose(row["confidence"], 1.0) for row in rules),
        "popularConsequentRules": sum(row["popularConsequent"] for row in rules),
        "latentAudit": latent_statuses,
        "productQuantityUnitsComplementary": sum(quantity_totals.values()),
    }
    analysis = {
        "analysisVersion": ANALYSIS_VERSION, "scenarioId": v3_forecast.SCENARIO_ID,
        "cutoffDate": CUTOFF.isoformat(), "algorithm": "FP-Growth (mlxtend)",
        "minSupport": MIN_SUPPORT, "minConfidence": MIN_CONFIDENCE, "minLiftExclusive": MIN_LIFT,
        "maxItemsetSize": MAX_ITEMSET_SIZE,
        "datasetVersion": v3_forecast.DATASET_VERSION, "datasetSha256": v3_forecast.DATASET_SHA256,
        "transactionCount": built["validTickets"], "codeVersion": CODE_VERSION,
        "candidateThresholds": exploration, "summary": summary,
        "frequentItemsets": frequent_itemset_rows,
        "rules": rules, "topSkuRules": sku_top,
        "recommendationsBySku": recommendations,
        "categoryRules": category_rules, "subcategoryRules": subcategory_rules,
        "productExamples": product_examples, "segmentRules": segment_rules,
        "latentProfileAudit": latent_audit,
        "unexpectedAssociations": [row for row in cross_sell_rules if row["latentAudit"] == "EMERGENT"][:20],
        "examples": {"cocaColaBEBGAS001": coca,
                     "incaKolaPresentations": inca_pair},
        "segments": _segment_summary(baskets, matrix),
        "metadata": {"supportDenominator": "all completed valid tickets, including singleton baskets",
                     "basketUnit": "one saleCode; each SKU appears at most once in binary basket",
                     "quantityUse": "retained as complementary totals; never weights binary support",
                     "promotionSensitiveDefinition": "at least 10 co-occurrence tickets, >=80% promotional, and non-promo co-occurrences <= max(5, 10% of total)",
                     "stabilityDefinition": "H1/H2 each need >=max(10, selected minSupport * window tickets) joint tickets and lift>1; stable if confidence gap<=0.25 and lift ratio<=2",
                     "segmentAnalysis": {"minimumTickets": MIN_SEGMENT_TICKETS, "minSupport": 0.01,
                                         "minConfidence": 0.20, "maxDisplayedRules": 5},
                     "interpretation": "observed association, not causality"},
        "timingsMs": {"preprocessing": preprocess_ms, "thresholdExploration": exploration_ms,
                       "fpGrowthSelectedThreshold": fp_ms, "ruleConstructionAndEnrichment": rules_ms,
                       "taxonomyViews": taxonomy_ms},
        "matrixApproxBytes": int(matrix.memory_usage(index=True, deep=True).sum()),
    }
    analysis["timingsMs"]["total"] = round((time.perf_counter() - started) * 1000, 2)
    analysis["reproducibilitySha256"] = canonical_hash({key: value for key, value in analysis.items() if key not in {"timingsMs", "matrixApproxBytes", "reproducibilitySha256"}})
    return analysis


def load_and_analyze(root: Path) -> dict[str, Any]:
    from ml.src.v3_forecast import sha256_file
    generated = root / "data/minimarket-pasco-v3/generated"
    manifest = json.loads((generated / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("scenarioId") != v3_forecast.SCENARIO_ID or manifest.get("datasetVersion") != v3_forecast.DATASET_VERSION:
        raise ValueError("Canonical V3 source manifest mismatch")
    for filename in ("sales.ndjson", "sale-items.ndjson"):
        expected = manifest.get("hashes", {}).get("files", {}).get(filename)
        path = generated / filename
        if not expected or not path.is_file() or sha256_file(path) != expected:
            raise ValueError(f"Canonical V3 source file integrity mismatch: {filename}")
    v3_forecast.load_validated_dataset(root)
    catalog = json.loads((root / "data/minimarket-pasco-v3/products.json").read_text(encoding="utf-8"))["catalog"]
    categories = json.loads((root / "data/minimarket-pasco-v3/categories.json").read_text(encoding="utf-8"))
    return analyze(_read_ndjson(generated / "sales.ndjson"), _read_ndjson(generated / "sale-items.ndjson"), catalog,
                   category_doc=categories)
