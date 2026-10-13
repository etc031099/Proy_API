"""Deterministic M6.8 Business, Customer and Supplier Intelligence for Pasco V3.

All analytics derive from canonical operational events. Synthetic profile and
supplier-configuration comparisons are appended only after observed metrics.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import median, pstdev
from typing import Any

from ml.src import v3_baseline_bundle, v3_forecast
from ml.src.inventory_intelligence_v3 import InventoryIntelligenceV3

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/minimarket-pasco-v3"
GENERATED = DATA / "generated"
BUSINESS_VERSION = "MINIMARKET-PASCO-V3-BI-v1"
CUSTOMER_VERSION = "MINIMARKET-PASCO-V3-CUSTOMER-v1"
SUPPLIER_VERSION = "MINIMARKET-PASCO-V3-SUPPLIER-v1"
HEALTH_VERSION = "MINIMARKET-PASCO-V3-HEALTH-v1"
TIMEZONE = "America/Lima"
ATLAS_READER = ROOT / "ml/scripts/m6_8_read_mongo.js"
PROMOTION_THRESHOLD = 0.25
MARGIN_QUANTILE_HIGH = 0.75
MARGIN_QUANTILE_LOW = 0.25


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_ndjson(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _safe_float(value: float | int | None, digits: int = 8) -> float | None:
    if value is None:
        return None
    result = float(value)
    if not math.isfinite(result):
        return None
    return round(result, digits)


def _money(cents: int | float) -> float:
    return round(int(cents) / 100, 2)


def _as_date(value: str | date) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


def _month_start(day: date) -> date:
    return day.replace(day=1)


def _add_months(day: date, delta: int) -> date:
    index = day.year * 12 + day.month - 1 + delta
    year, month0 = divmod(index, 12)
    month = month0 + 1
    if month == 12:
        last = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        last = date(year, month + 1, 1) - timedelta(days=1)
    return date(year, month, min(day.day, last.day))


def resolve_period(period: str | dict[str, str], as_of_date: str | date) -> dict[str, Any]:
    """Resolve an inclusive local-calendar date range, never using wall clock."""
    cutoff = _as_date(as_of_date)
    if not v3_forecast.HISTORY_START <= cutoff <= v3_forecast.HISTORY_END:
        raise ValueError("asOfDate is outside the approved V3 history")
    if isinstance(period, dict):
        start, end = _as_date(period["startDate"]), _as_date(period["endDate"])
        code = "CUSTOM"
    else:
        code = str(period).upper()
        if code == "TODAY":
            start = end = cutoff
        elif code == "YESTERDAY":
            start = end = cutoff - timedelta(days=1)
        elif code in {"LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS"}:
            days = int(code.split("_")[1])
            start, end = cutoff - timedelta(days=days - 1), cutoff
        elif code == "CURRENT_MONTH":
            start, end = _month_start(cutoff), cutoff
        elif code == "PREVIOUS_MONTH":
            start = _month_start(_add_months(cutoff, -1))
            end = _month_start(cutoff) - timedelta(days=1)
        elif code in {"YEAR_TO_DATE", "YTD"}:
            code = "YEAR_TO_DATE"
            start, end = date(cutoff.year, 1, 1), cutoff
        elif code == "HISTORY":
            start, end = v3_forecast.HISTORY_START, cutoff
        else:
            raise ValueError("Unsupported V3 period")
    if start > end or end > cutoff:
        raise ValueError("Period must be ordered and cannot include dates after asOfDate")
    clipped_start = max(start, v3_forecast.HISTORY_START)
    clipped_end = min(end, cutoff)
    if clipped_start > clipped_end:
        raise ValueError("Period has no dates inside the approved V3 history")
    return {"code": code, "startDate": clipped_start.isoformat(), "endDate": clipped_end.isoformat(),
            "days": (clipped_end - clipped_start).days + 1, "inclusive": True, "timezone": TIMEZONE,
            "requestedStartDate": start.isoformat(), "requestedEndDate": end.isoformat(),
            "clippedToAvailableHistory": clipped_start != start or clipped_end != end}


def equivalent_previous_period(period: dict[str, Any]) -> dict[str, Any] | None:
    """Return an equal-duration immediately preceding range if history permits."""
    start, end = _as_date(period["startDate"]), _as_date(period["endDate"])
    code = period["code"]
    if code == "HISTORY":
        return None
    if code == "CURRENT_MONTH":
        prior_month = _add_months(start, -1)
        prior_start = _month_start(prior_month)
        month_after = _add_months(prior_start, 1)
        prior_month_end = month_after - timedelta(days=1)
        prior_end = min(prior_month_end, prior_start + timedelta(days=(end - start).days))
        result = {"code": "EQUIVALENT_PREVIOUS_MONTH_TO_DATE", "startDate": prior_start.isoformat(),
                  "endDate": prior_end.isoformat(), "days": (prior_end - prior_start).days + 1,
                  "inclusive": True, "timezone": TIMEZONE, "equalDuration": (prior_end - prior_start) == (end - start)}
    elif code == "PREVIOUS_MONTH":
        days = (end - start).days + 1
        prior_end = start - timedelta(days=1)
        prior_start = prior_end - timedelta(days=days - 1)
        result = {"code": "EQUIVALENT_PREVIOUS_PERIOD", "startDate": prior_start.isoformat(),
                  "endDate": prior_end.isoformat(), "days": days, "inclusive": True,
                  "timezone": TIMEZONE, "equalDuration": True}
    elif code == "YEAR_TO_DATE":
        try:
            prior_start = start.replace(year=start.year - 1)
            prior_end = end.replace(year=end.year - 1)
        except ValueError:  # leap day
            prior_start, prior_end = start.replace(year=start.year - 1, day=28), end.replace(year=end.year - 1, day=28)
        result = {"code": "EQUIVALENT_PRIOR_YEAR", "startDate": prior_start.isoformat(),
                  "endDate": prior_end.isoformat(), "days": (prior_end - prior_start).days + 1,
                  "inclusive": True, "timezone": TIMEZONE, "equalDuration": True}
    else:
        days = (end - start).days + 1
        prior_end = start - timedelta(days=1)
        prior_start = prior_end - timedelta(days=days - 1)
        result = {"code": "EQUIVALENT_PREVIOUS_PERIOD", "startDate": prior_start.isoformat(),
                  "endDate": prior_end.isoformat(), "days": days, "inclusive": True,
                  "timezone": TIMEZONE, "equalDuration": True}
    if _as_date(result["startDate"]) < v3_forecast.HISTORY_START:
        return None
    return result


def _period_contains(row: dict[str, Any], period: dict[str, Any], date_key: str = "localDate") -> bool:
    value = row.get(date_key)
    return bool(value and period["startDate"] <= str(value)[:10] <= period["endDate"])


def _nearest_rank(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    return ordered[max(0, math.ceil(quantile * len(ordered)) - 1)]


def _trend(value: float | int, previous: float | int | None, *, equal_duration: bool = True) -> dict[str, Any]:
    if previous is None or value is None:
        return {"value": value, "previousValue": None, "absoluteChange": None, "percentChange": None,
                "comparisonAvailable": False, "comparableDurations": equal_duration}
    absolute = value - previous
    pct = None if previous == 0 else absolute / previous * 100
    return {"value": value, "previousValue": previous, "absoluteChange": absolute,
            "percentChange": _safe_float(pct, 4), "comparisonAvailable": True,
            "comparableDurations": equal_duration,
            "comparisonWarning": None if equal_duration else "Comparison windows have unequal day counts"}


def _normalize_input_rows(rows: list[dict[str, Any]], domain: str) -> None:
    for row in rows:
        if row.get("scenarioId") != v3_forecast.SCENARIO_ID or row.get("businessKey") != "MINIMARKET-PASCO-V3":
            raise ValueError(f"{domain} contains a row outside the canonical V3 tenant/scenario")


def load_local_sources(repository_root: Path = ROOT) -> dict[str, Any]:
    """Load only approved local canonical files and verify their manifest hashes."""
    root = Path(repository_root)
    dataset = v3_forecast.load_validated_dataset(root)
    generated = root / "data/minimarket-pasco-v3/generated"
    manifest = _read_json(generated / "manifest.json")
    required_files = ("sales.ndjson", "sale-items.ndjson", "purchases.ndjson", "purchase-items.ndjson",
                      "customers.ndjson", "suppliers.ndjson",
                      "suppliers.ndjson", "products.ndjson", "inventory-movements.ndjson",
                      "inventory-snapshot.ndjson", "supplier-cost-history.ndjson")
    for name in required_files:
        file_path = generated / name
        if not file_path.is_file() or _file_sha256(file_path) != manifest.get("hashes", {}).get("files", {}).get(name):
            raise ValueError(f"Canonical V3 input integrity failed: {name}")
    records = {
        "scenario": {"scenarioId": manifest["scenarioId"], "sourceSha256": manifest["hashes"]["logicalDatasetSha256"],
                     "datasetVersion": manifest["datasetVersion"], "referenceDate": manifest["referenceDate"], "status": "completed"},
        "sales": _read_ndjson(generated / "sales.ndjson"),
        "saleItems": _read_ndjson(generated / "sale-items.ndjson"),
        "purchases": _read_ndjson(generated / "purchases.ndjson"),
        "purchaseLines": _read_ndjson(generated / "purchase-items.ndjson"),
        "customers": _read_ndjson(generated / "customers.ndjson"),
        "suppliers": _read_ndjson(generated / "suppliers.ndjson"),
        "products": _read_ndjson(generated / "products.ndjson"),
        "suppliers": _read_ndjson(generated / "suppliers.ndjson"),
        "movements": _read_ndjson(generated / "inventory-movements.ndjson"),
        "inventorySnapshot": _read_ndjson(generated / "inventory-snapshot.ndjson"),
        "supplierCostHistory": _read_ndjson(generated / "supplier-cost-history.ndjson"),
        "source": "canonical_local",
    }
    return _validate_sources(records, root, dataset)


def _validate_sources(records: dict[str, Any], root: Path, dataset: Any | None = None) -> dict[str, Any]:
    if not dataset:
        dataset = v3_forecast.load_validated_dataset(root)
    scenario = records.get("scenario", {})
    if (scenario.get("scenarioId") != v3_forecast.SCENARIO_ID
            or scenario.get("sourceSha256") != v3_forecast.DATASET_SHA256
            or scenario.get("datasetVersion") != v3_forecast.DATASET_VERSION
            or scenario.get("referenceDate") != v3_forecast.HISTORY_END.isoformat()
            or scenario.get("status") != "completed"):
        raise ValueError("V3 operational source marker differs from the approved manifest")
    expected = {"sales": 12853, "saleItems": 37621, "purchases": 2155, "purchaseLines": 3408,
                "products": 80, "customers": 40, "suppliers": 10, "movements": 40445, "inventorySnapshot": 80}
    for domain, count in expected.items():
        rows = records.get(domain)
        if not isinstance(rows, list) or len(rows) != count:
            raise ValueError(f"V3 {domain} count differs from the approved scenario")
        _normalize_input_rows(rows, domain)
    if records.get("supplierCostHistory") is not None:
        _normalize_input_rows(records["supplierCostHistory"], "supplierCostHistory")
    sales = records["sales"]
    sale_by_code = {row.get("saleCode"): row for row in sales}
    sale_codes = set(sale_by_code)
    purchase_codes = {row.get("purchaseCode") for row in records["purchases"]}
    purchase_by_code = {row.get("purchaseCode"): row for row in records["purchases"]}
    if None in sale_codes or len(sale_codes) != len(sales) or len({r.get("purchaseCode") for r in records["purchases"]}) != len(records["purchases"]):
        raise ValueError("V3 transaction stable codes must be unique and present")
    sku_set = set(dataset.product_by_sku)
    customer_codes = {row["customerCode"] for row in _read_json(Path(root) / "data/minimarket-pasco-v3/customers.json")["customers"]}
    supplier_codes = {row["supplierCode"] for row in records["suppliers"]}
    if any(row.get("customerCode") and row["customerCode"] not in customer_codes for row in sales):
        raise ValueError("V3 sale references an unknown registered customer")
    if any(row.get("supplierCode") not in supplier_codes for row in records["purchases"]):
        raise ValueError("V3 purchase references an unknown supplier")
    line_keys: set[str] = set()
    sale_line_totals: dict[str, int] = defaultdict(int)
    for line in records["saleItems"]:
        if line.get("saleCode") not in sale_codes or line.get("sku") not in sku_set or not line.get("saleLineKey") or line["saleLineKey"] in line_keys:
            raise ValueError("V3 sale line has an orphan, unknown SKU, or duplicate stable key")
        if line.get("customerCode") and line["customerCode"] not in customer_codes:
            raise ValueError("V3 sale line references an unknown registered customer")
        line_keys.add(line["saleLineKey"])
        sale_line_totals[line["saleCode"]] += int(line["lineTotalCents"])
    if any(sale_line_totals.get(code, 0) != int(row["totalCents"]) for code, row in sale_by_code.items()):
        raise ValueError("V3 sale parent totals do not reconcile with canonical lines")
    purchase_line_keys: set[str] = set()
    purchase_line_totals: dict[str, int] = defaultdict(int)
    for line in records["purchaseLines"]:
        purchase = purchase_by_code.get(line.get("purchaseCode"))
        if (line.get("purchaseCode") not in purchase_codes or line.get("sku") not in sku_set
                or line.get("supplierCode") not in supplier_codes or not purchase
                or line.get("supplierCode") != purchase.get("supplierCode")
                or not line.get("purchaseLineKey") or line["purchaseLineKey"] in purchase_line_keys):
            raise ValueError("V3 purchase line has an orphan, unknown SKU, or duplicate stable key")
        purchase_line_keys.add(line["purchaseLineKey"])
        purchase_line_totals[line["purchaseCode"]] += int(line["quantityOrdered"]) * int(line["purchasePriceCents"])
    if any(purchase_line_totals.get(code, 0) != int(row["totalCostCents"]) for code, row in purchase_by_code.items()):
        raise ValueError("V3 purchase parent totals do not reconcile with canonical lines")
    product_codes = {row["sku"] for row in records["products"]}
    if product_codes != sku_set:
        raise ValueError("V3 product operational set differs from the canonical catalog")
    if len({row.get("customerCode") for row in records["customers"]}) != 40 or len({row.get("supplierCode") for row in records["suppliers"]}) != 10:
        raise ValueError("V3 customer/supplier stable identities must be unique and complete")
    if any(row.get("sku") not in sku_set for row in records["movements"] + records["inventorySnapshot"]):
        raise ValueError("V3 inventory ledger/snapshot contains an unknown SKU")
    return records


def _load_static(root: Path) -> dict[str, Any]:
    definitions = json.loads(subprocess.check_output(
        ["node", "-e", "const g=require('./scripts/lib/minimarket-v3-generator');const d=g.loadDefinitions();process.stdout.write(JSON.stringify({scenario:d.scenario,categories:d.categories,products:d.products,suppliers:d.suppliers,offers:d.offers,customers:d.customers,profiles:d.profiles,promotions:d.promotions}))"],
        cwd=root, text=True, timeout=30))
    return definitions


def _sale_data(records: dict[str, Any], as_of: date) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    sales_by_code = {row["saleCode"]: row for row in records["sales"]
                     if row.get("status") == "completed" and not row.get("cancelledAt")
                     and row.get("localDate", "") <= as_of.isoformat()}
    lines_by_sale: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for line in records["saleItems"]:
        sale = sales_by_code.get(line.get("saleCode"))
        if not sale or line.get("transactionStatus") != "completed":
            continue
        if int(line.get("unitsSold", 0)) <= 0:
            continue
        lines_by_sale[line["saleCode"]].append(line)
    sales = [row for row in sales_by_code.values() if lines_by_sale.get(row["saleCode"])]
    return sorted(sales, key=lambda row: (row["localDate"], row["saleCode"])), lines_by_sale


def _sales_aggregates(sales: list[dict[str, Any]], lines_by_sale: dict[str, list[dict[str, Any]]],
                      product_map: dict[str, dict[str, Any]], period: dict[str, Any],
                      *, category_code: str | None = None, subcategory_code: str | None = None) -> dict[str, Any]:
    selected_sales: list[dict[str, Any]] = []
    selected_lines: dict[str, list[dict[str, Any]]] = {}
    for sale in sales:
        if not _period_contains(sale, period):
            continue
        lines = [line for line in lines_by_sale[sale["saleCode"]]
                 if (category_code is None or product_map[line["sku"]]["categoryCode"] == category_code)
                 and (subcategory_code is None or product_map[line["sku"]]["subcategoryCode"] == subcategory_code)]
        if lines or (category_code is None and subcategory_code is None):
            selected_sales.append(sale)
            selected_lines[sale["saleCode"]] = lines
    revenue = cogs = units = distinct_line_count = 0
    skus: set[str] = set()
    ticket_values: list[int] = []
    ticket_units: list[int] = []
    ticket_distinct: list[int] = []
    promotion_tickets = registered_tickets = consumer_tickets = 0
    category_tickets: Counter[str] = Counter()
    product_revenue: Counter[str] = Counter()
    product_units: Counter[str] = Counter()
    product_margin: Counter[str] = Counter()
    product_frequency: Counter[str] = Counter()
    product_ticket_distinct: Counter[str] = Counter()
    category_revenue: Counter[str] = Counter()
    category_units: Counter[str] = Counter()
    category_margin: Counter[str] = Counter()
    customer_metrics: dict[str, dict[str, int]] = defaultdict(lambda: {"revenueCents": 0, "cogsCents": 0, "units": 0, "tickets": 0, "promotionTickets": 0})
    customer_category_units: dict[str, Counter[str]] = defaultdict(Counter)
    customer_subcategory_units: dict[str, Counter[str]] = defaultdict(Counter)
    customer_product_units: dict[str, Counter[str]] = defaultdict(Counter)
    customer_promo_tickets: Counter[str] = Counter()
    supplier_ticket_rows: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for sale in selected_sales:
        lines = selected_lines[sale["saleCode"]]
        if not lines and (category_code is not None or subcategory_code is not None):
            continue
        ticket_revenue = sum(int(line["lineTotalCents"]) for line in lines)
        ticket_units_count = sum(int(line.get("unitsSold", 0)) for line in lines)
        distinct = {line["sku"] for line in lines}
        ticket_cogs = sum(int(line.get("costAtSaleCents", 0)) * int(line.get("unitsSold", 0)) for line in lines)
        revenue += ticket_revenue
        cogs += ticket_cogs
        units += ticket_units_count
        distinct_line_count += len(lines)
        skus.update(distinct)
        ticket_values.append(ticket_revenue)
        ticket_units.append(ticket_units_count)
        ticket_distinct.append(len(distinct))
        customer_code = sale.get("customerCode")
        if customer_code:
            registered_tickets += 1
        else:
            consumer_tickets += 1
        has_promo = int(sale.get("ticketDiscountCents", 0) or 0) > 0 or int(sale.get("itemDiscountCents", 0) or 0) > 0 or any(
            line.get("promotionCode") or int(line.get("lineDiscountCents", 0) or 0) > 0 for line in lines)
        if has_promo:
            promotion_tickets += 1
        sale_categories = {product_map[line["sku"]]["categoryCode"] for line in lines}
        for code in sale_categories:
            category_tickets[code] += 1
        if customer_code:
            metric = customer_metrics[customer_code]
            metric["revenueCents"] += ticket_revenue
            metric["cogsCents"] += ticket_cogs
            metric["units"] += ticket_units_count
            metric["tickets"] += 1
            metric["promotionTickets"] += int(has_promo)
            customer_promo_tickets[customer_code] += int(has_promo)
        for line in lines:
            sku = line["sku"]
            product = product_map[sku]
            line_revenue = int(line["lineTotalCents"])
            line_units = int(line["unitsSold"])
            line_cogs = int(line.get("costAtSaleCents", 0)) * line_units
            line_margin = line_revenue - line_cogs
            product_revenue[sku] += line_revenue
            product_units[sku] += line_units
            product_margin[sku] += line_margin
            product_ticket_distinct[sku] += 1
            category_revenue[product["categoryCode"]] += line_revenue
            category_units[product["categoryCode"]] += line_units
            category_margin[product["categoryCode"]] += line_margin
            if customer_code:
                customer_category_units[customer_code][product["categoryCode"]] += line_units
                customer_subcategory_units[customer_code][product["subcategoryCode"]] += line_units
                customer_product_units[customer_code][sku] += line_units
        supplier_ticket_rows.append((sale, lines))
    ticket_count = len(ticket_values)
    margin = revenue - cogs
    distribution = Counter(str(size) for size in ticket_distinct)
    return {
        "period": period, "revenueCents": revenue, "cogsCents": cogs, "grossMarginCents": margin,
        "grossMarginPct": margin / revenue * 100 if revenue else None, "unitsSold": units,
        "ticketCount": ticket_count, "averageTicketCents": revenue / ticket_count if ticket_count else None,
        "medianTicketCents": median(ticket_values) if ticket_values else None,
        "p90TicketCents": _nearest_rank(ticket_values, .90), "averageDistinctSkusPerTicket": sum(ticket_distinct) / ticket_count if ticket_count else None,
        "averageUnitsPerTicket": sum(ticket_units) / ticket_count if ticket_count else None,
        "averageLinesPerTicket": distinct_line_count / ticket_count if ticket_count else None,
        "basketSizeDistribution": dict(sorted(distribution.items(), key=lambda pair: int(pair[0]))),
        "promotionTicketCount": promotion_tickets, "promotionTicketSharePct": promotion_tickets / ticket_count * 100 if ticket_count else None,
        "registeredCustomerTickets": registered_tickets, "consumerFinalTickets": consumer_tickets,
        "registeredTicketSharePct": registered_tickets / ticket_count * 100 if ticket_count else None,
        "consumerFinalTicketSharePct": consumer_tickets / ticket_count * 100 if ticket_count else None,
        "customerRevenueSharePct": None, "consumerFinalRevenueCents": 0, "registeredRevenueCents": 0,
        "productRevenueCents": dict(product_revenue), "productUnits": dict(product_units),
        "productMarginCents": dict(product_margin), "productTicketFrequency": dict(product_ticket_distinct),
        "categoryRevenueCents": dict(category_revenue), "categoryUnits": dict(category_units),
        "categoryMarginCents": dict(category_margin), "categoryTicketCount": dict(category_tickets),
        "customerMetrics": {key: dict(value) for key, value in customer_metrics.items()},
        "customerCategoryUnits": {key: dict(value) for key, value in customer_category_units.items()},
        "customerSubcategoryUnits": {key: dict(value) for key, value in customer_subcategory_units.items()},
        "customerProductUnits": {key: dict(value) for key, value in customer_product_units.items()},
        "customerPromotionTickets": dict(customer_promo_tickets), "sales": selected_sales,
        "linesBySale": selected_lines, "ticketValuesCents": ticket_values, "ticketUnits": ticket_units,
        "ticketDistinctSkus": ticket_distinct, "customerCodes": sorted({row.get("customerCode") for row in selected_sales if row.get("customerCode")}),
    }


def _metrics_bundle_for_periods(sales: list[dict[str, Any]], lines_by_sale: dict[str, list[dict[str, Any]]],
                                product_map: dict[str, dict[str, Any]], period: dict[str, Any],
                                *, category_code: str | None = None, subcategory_code: str | None = None) -> dict[str, Any]:
    current = _sales_aggregates(sales, lines_by_sale, product_map, period,
                                category_code=category_code, subcategory_code=subcategory_code)
    previous_period = equivalent_previous_period(period)
    previous = _sales_aggregates(sales, lines_by_sale, product_map, previous_period,
                                 category_code=category_code, subcategory_code=subcategory_code) if previous_period else None
    return {"current": current, "previous": previous, "previousPeriod": previous_period}


def _period_kpis(aggregate: dict[str, Any]) -> dict[str, Any]:
    return {"revenue": _money(aggregate["revenueCents"]), "revenueCents": aggregate["revenueCents"],
            "unitsSold": aggregate["unitsSold"], "ticketCount": aggregate["ticketCount"],
            "averageTicket": _money(aggregate["averageTicketCents"] or 0),
            "averageDistinctSkusPerTicket": _safe_float(aggregate["averageDistinctSkusPerTicket"]),
            "averageUnitsPerTicket": _safe_float(aggregate["averageUnitsPerTicket"]),
            "grossMargin": _money(aggregate["grossMarginCents"]), "grossMarginCents": aggregate["grossMarginCents"],
            "grossMarginPct": _safe_float(aggregate["grossMarginPct"], 4),
            "cogs": _money(aggregate["cogsCents"]), "cogsCents": aggregate["cogsCents"]}


class BusinessIntelligenceV3:
    def __init__(self, root: Path, records: dict[str, Any], static: dict[str, Any]):
        self.root, self.records, self.static = Path(root), records, static
        self.products = {row["sku"]: row for row in static["products"]}
        self.categories = {row["code"]: row for row in static["categories"]["categories"]}
        self.sales_by_asof: dict[date, tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]] = {}

    def _sales(self, as_of: date) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
        if as_of not in self.sales_by_asof:
            self.sales_by_asof[as_of] = _sale_data(self.records, as_of)
        return self.sales_by_asof[as_of]

    def summary(self, period: str | dict[str, str] = "LAST_30_DAYS", *, as_of_date: str | date = v3_forecast.HISTORY_END,
                category_code: str | None = None, subcategory_code: str | None = None,
                comparison_mode: str = "EQUIVALENT_PREVIOUS") -> dict[str, Any]:
        cutoff = _as_date(as_of_date)
        window = resolve_period(period, cutoff)
        if category_code and category_code not in self.categories:
            raise ValueError("Unknown V3 category filter")
        if subcategory_code and subcategory_code not in {p["subcategoryCode"] for p in self.products.values()}:
            raise ValueError("Unknown V3 subcategory filter")
        sales, lines = self._sales(cutoff)
        bundle = _metrics_bundle_for_periods(sales, lines, self.products, window,
                                             category_code=category_code, subcategory_code=subcategory_code)
        current, previous = bundle["current"], bundle["previous"]
        if comparison_mode.upper() == "NONE":
            previous = None
            bundle["previousPeriod"] = None
        elif comparison_mode.upper() != "EQUIVALENT_PREVIOUS":
            raise ValueError("Unsupported comparisonMode")
        equal_duration = not bundle["previousPeriod"] or bundle["previousPeriod"].get("equalDuration", True)
        kpis = _period_kpis(current)
        previous_kpis = _period_kpis(previous) if previous is not None else None
        trend_names = {"revenue": current["revenueCents"], "unitsSold": current["unitsSold"],
                       "ticketCount": current["ticketCount"], "averageTicket": current["averageTicketCents"],
                       "grossMargin": current["grossMarginCents"], "grossMarginPct": current["grossMarginPct"]}
        old_names = ({"revenue": previous["revenueCents"], "unitsSold": previous["unitsSold"],
                      "ticketCount": previous["ticketCount"], "averageTicket": previous["averageTicketCents"],
                      "grossMargin": previous["grossMarginCents"], "grossMarginPct": previous["grossMarginPct"]}
                     if previous is not None else {key: None for key in trend_names})
        trends = {key: _trend(value, old_names[key], equal_duration=equal_duration) for key, value in trend_names.items()}
        if current["ticketCount"]:
            # For all-products summaries, line revenue must reconcile with completed ticket totals.
            all_line_cents = sum(int(line["lineTotalCents"]) for sale in current["sales"] for line in current["linesBySale"][sale["saleCode"]])
            if category_code is None and subcategory_code is None and all_line_cents != current["revenueCents"]:
                raise ValueError("V3 sale lines and parent revenue do not reconcile")
        total_rev = current["revenueCents"]
        registered_rev = 0
        consumer_rev = 0
        for sale in current["sales"]:
            amount = sum(int(line["lineTotalCents"]) for line in current["linesBySale"][sale["saleCode"]])
            if sale.get("customerCode"):
                registered_rev += amount
            else:
                consumer_rev += amount
        current["registeredRevenueCents"], current["consumerFinalRevenueCents"] = registered_rev, consumer_rev
        current["customerRevenueSharePct"] = registered_rev / total_rev * 100 if total_rev else None
        rankings = self._rankings(current)
        category_rows = self._category_rows(current, previous, bundle["previousPeriod"], equal_duration)
        margin_rows = self._margin_intelligence(current)
        basket = self._basket_size_metrics(current)
        return {"contractVersion": BUSINESS_VERSION, "scenarioId": v3_forecast.SCENARIO_ID,
                "datasetVersion": v3_forecast.DATASET_VERSION, "datasetSha256": v3_forecast.DATASET_SHA256,
                "asOfDate": cutoff.isoformat(), "timezone": TIMEZONE, "period": window,
                "comparisonMode": comparison_mode.upper(), "previousPeriod": bundle["previousPeriod"],
                "kpis": kpis, "trends": trends,
                "customerMix": {"registeredTickets": current["registeredCustomerTickets"], "consumerFinalTickets": current["consumerFinalTickets"],
                                "registeredTicketSharePct": _safe_float(current["registeredTicketSharePct"], 4),
                                "consumerFinalTicketSharePct": _safe_float(current["consumerFinalTicketSharePct"], 4),
                                "registeredRevenue": _money(registered_rev), "consumerFinalRevenue": _money(consumer_rev),
                                "registeredRevenueSharePct": _safe_float(current["customerRevenueSharePct"], 4),
                                "consumerFinalRevenueSharePct": _safe_float(consumer_rev / total_rev * 100 if total_rev else None, 4)},
                "filters": {"categoryCode": category_code, "subcategoryCode": subcategory_code},
                "rankings": rankings, "categoryIntelligence": category_rows,
                "marginIntelligence": margin_rows, "ticketIntelligence": basket,
                "sourceCounts": {"completedTickets": current["ticketCount"], "saleLines": sum(len(v) for v in current["linesBySale"].values())}}

    def _rankings(self, aggregate: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        product_rows = []
        for sku, product in self.products.items():
            revenue = aggregate["productRevenueCents"].get(sku, 0)
            units = aggregate["productUnits"].get(sku, 0)
            margin = aggregate["productMarginCents"].get(sku, 0)
            frequency = aggregate["productTicketFrequency"].get(sku, 0)
            common = {"sku": sku, "name": product["name"], "presentation": product["presentation"],
                      "sizeValue": product["sizeValue"], "sizeUnit": product["sizeUnit"],
                      "categoryCode": product["categoryCode"], "subcategoryCode": product["subcategoryCode"]}
            product_rows.append({**common, "revenueCents": revenue, "units": units, "grossMarginCents": margin,
                                 "ticketFrequency": frequency, "marginPct": margin / revenue * 100 if revenue else None})
        sorters = {"revenue": lambda r: (-r["revenueCents"], r["sku"]),
                   "units": lambda r: (-r["units"], r["sku"]),
                   "grossMargin": lambda r: (-r["grossMarginCents"], r["sku"]),
                   "ticketFrequency": lambda r: (-r["ticketFrequency"], r["sku"])}
        result = {}
        for name, sorter in sorters.items():
            rows = sorted(product_rows, key=sorter)
            for rank, row in enumerate(rows, 1):
                row[f"{name}Rank"] = rank
            result[name] = [{**{key: row[key] for key in ("sku", "name", "presentation", "sizeValue", "sizeUnit", "categoryCode", "subcategoryCode")},
                             "metric": row[name + ("Cents" if name in {"revenue", "grossMargin"} else "")], "rank": row[f"{name}Rank"],
                             "metricName": name} for row in rows[:20]]
        return result

    def _category_rows(self, current: dict[str, Any], previous: dict[str, Any] | None,
                       previous_period: dict[str, Any] | None, equal_duration: bool) -> list[dict[str, Any]]:
        total_revenue = current["revenueCents"]
        sku_count: Counter[str] = Counter()
        for sku, row in self.products.items():
            sku_count[row["categoryCode"]] += int(row.get("active", True))
        rows = []
        for code, category in self.categories.items():
            revenue = current["categoryRevenueCents"].get(code, 0)
            ticket_count = current["categoryTicketCount"].get(code, 0)
            metric = {"revenueCents": revenue, "units": current["categoryUnits"].get(code, 0),
                      "grossMarginCents": current["categoryMarginCents"].get(code, 0), "ticketCount": ticket_count,
                      "ticketPenetrationPct": ticket_count / current["ticketCount"] * 100 if current["ticketCount"] else None,
                      "skuCount": sku_count[code], "shareOfRevenuePct": revenue / total_revenue * 100 if total_revenue else None}
            old = None
            if previous is not None:
                old = {"revenueCents": previous["categoryRevenueCents"].get(code, 0),
                       "units": previous["categoryUnits"].get(code, 0),
                       "grossMarginCents": previous["categoryMarginCents"].get(code, 0),
                       "ticketCount": previous["categoryTicketCount"].get(code, 0)}
            rows.append({"categoryCode": code, "name": category["name"], **metric,
                         "trends": {key: _trend(value, old[key] if old else None, equal_duration=equal_duration)
                                    for key, value in metric.items() if key in {"revenueCents", "units", "grossMarginCents", "ticketCount"}}})
        return sorted(rows, key=lambda row: (-row["revenueCents"], row["categoryCode"]))

    def _margin_intelligence(self, aggregate: dict[str, Any]) -> dict[str, Any]:
        rows = []
        for sku, product in self.products.items():
            rev = aggregate["productRevenueCents"].get(sku, 0)
            margin = aggregate["productMarginCents"].get(sku, 0)
            rows.append({"sku": sku, "name": product["name"], "revenueCents": rev, "grossMarginCents": margin,
                         "grossMarginPct": margin / rev * 100 if rev else None})
        revenue_values = [row["revenueCents"] for row in rows]
        margin_pct = [row["grossMarginPct"] for row in rows if row["grossMarginPct"] is not None]
        high_revenue = _nearest_rank(revenue_values, MARGIN_QUANTILE_HIGH)
        low_revenue = _nearest_rank(revenue_values, MARGIN_QUANTILE_LOW)
        high_margin = _nearest_rank(margin_pct, MARGIN_QUANTILE_HIGH)
        low_margin = _nearest_rank(margin_pct, MARGIN_QUANTILE_LOW)
        return {"grossMarginCents": aggregate["grossMarginCents"],
                "grossMarginPct": _safe_float(aggregate["grossMarginPct"], 4), "cogsCents": aggregate["cogsCents"],
                "highRevenueLowMargin": [row for row in sorted(rows, key=lambda r: (-r["revenueCents"], r["sku"]))
                                         if row["revenueCents"] >= (high_revenue or 0) and row["grossMarginPct"] is not None and row["grossMarginPct"] <= (low_margin if low_margin is not None else -math.inf)][:10],
                "lowRevenueHighMargin": [row for row in sorted(rows, key=lambda r: (-float(r["grossMarginPct"] or -math.inf), r["sku"]))
                                         if row["revenueCents"] <= (low_revenue or 0) and row["grossMarginPct"] is not None and row["grossMarginPct"] >= (high_margin if high_margin is not None else math.inf)][:10],
                "highMarginProducts": sorted([row for row in rows if row["grossMarginPct"] is not None],
                                              key=lambda r: (-r["grossMarginPct"], -r["grossMarginCents"], r["sku"]))[:10],
                "classificationMethod": "relative product percentiles: revenue p75/p25 and gross-margin-rate p25/p75; no net-profit claim"}

    @staticmethod
    def _basket_size_metrics(aggregate: dict[str, Any]) -> dict[str, Any]:
        return {"averageTicketCents": _safe_float(aggregate["averageTicketCents"], 4),
                "medianTicketCents": aggregate["medianTicketCents"], "p90TicketCents": aggregate["p90TicketCents"],
                "averageDistinctSkus": _safe_float(aggregate["averageDistinctSkusPerTicket"]),
                "averageUnits": _safe_float(aggregate["averageUnitsPerTicket"]),
                "basketSizeDistribution": aggregate["basketSizeDistribution"],
                "p90Method": "nearest rank"}


def _quantile_rfm_score(values: list[float], target: float, *, reverse: bool = False) -> int:
    below = sum(value < target for value in values)
    equal = sum(value == target for value in values)
    midrank = (below + max(0, equal - 1) / 2) / max(1, len(values))
    percentile = 1 - midrank if reverse else midrank
    return min(5, max(1, int(percentile * 5) + 1))


def _period_customer_metrics(sales: list[dict[str, Any]], lines_by_sale: dict[str, list[dict[str, Any]]],
                             product_map: dict[str, dict[str, Any]], start: date, end: date,
                             customer_codes: set[str]) -> dict[str, dict[str, Any]]:
    clipped_start = max(start, v3_forecast.HISTORY_START)
    clipped_end = min(end, v3_forecast.HISTORY_END)
    if clipped_start > clipped_end:
        return {code: {"revenueCents": 0, "cogsCents": 0, "units": 0, "tickets": 0,
                       "promotionTickets": 0, "grossMarginCents": 0, "averageTicketCents": None,
                       "averageItemsPerTicket": None} for code in customer_codes}
    period = resolve_period({"startDate": clipped_start.isoformat(), "endDate": clipped_end.isoformat()}, clipped_end)
    ag = _sales_aggregates(sales, lines_by_sale, product_map, period)
    result = {}
    for code in customer_codes:
        row = ag["customerMetrics"].get(code, {"revenueCents": 0, "cogsCents": 0, "units": 0, "tickets": 0, "promotionTickets": 0})
        result[code] = {**row, "grossMarginCents": row["revenueCents"] - row["cogsCents"],
                        "averageTicketCents": row["revenueCents"] / row["tickets"] if row["tickets"] else None,
                        "averageItemsPerTicket": row["units"] / row["tickets"] if row["tickets"] else None}
    return result


class CustomerIntelligenceV3:
    def __init__(self, root: Path, records: dict[str, Any], static: dict[str, Any], business: BusinessIntelligenceV3):
        self.root, self.records, self.static, self.business = Path(root), records, static, business
        self.customers = sorted(static["customers"], key=lambda row: row["customerCode"])
        self.products = business.products
        self.categories = business.categories

    def snapshot(self, *, as_of_date: str | date = v3_forecast.HISTORY_END) -> dict[str, Any]:
        cutoff = _as_date(as_of_date)
        sales, lines = self.business._sales(cutoff)
        history = resolve_period("HISTORY", cutoff)
        all_metrics = _sales_aggregates(sales, lines, self.products, history)
        customer_codes = {row["customerCode"] for row in self.customers}
        recent90 = _period_customer_metrics(sales, lines, self.products, cutoff - timedelta(days=89), cutoff, customer_codes)
        last30 = _period_customer_metrics(sales, lines, self.products, cutoff - timedelta(days=29), cutoff, customer_codes)
        prior30 = _period_customer_metrics(sales, lines, self.products, cutoff - timedelta(days=59), cutoff - timedelta(days=30), customer_codes)
        activity = {code: [] for code in customer_codes}
        customer_first: dict[str, str] = {}
        customer_last: dict[str, str] = {}
        for sale in sales:
            code = sale.get("customerCode")
            if code:
                activity[code].append(sale["localDate"])
                customer_first.setdefault(code, sale["localDate"])
                customer_last[code] = sale["localDate"]
        frequency_threshold = _nearest_rank([recent90[c]["tickets"] for c in customer_codes], .75) or 0
        monetary_threshold = _nearest_rank([recent90[c]["revenueCents"] for c in customer_codes], .75) or 0
        lifetime_recency = {code: (cutoff - date.fromisoformat(customer_last[code])).days if code in customer_last
                            else (cutoff - v3_forecast.HISTORY_START).days + 1 for code in customer_codes}
        records_by_customer: dict[str, dict[str, Any]] = defaultdict(lambda: {"revenueCents": 0, "cogsCents": 0, "units": 0, "tickets": 0, "promotionTickets": 0})
        for code, value in all_metrics["customerMetrics"].items():
            records_by_customer[code].update(value)
        rows = []
        for customer in self.customers:
            code = customer["customerCode"]
            dates = activity.get(code, [])
            first, last = (dates[0], dates[-1]) if dates else (None, None)
            recency = (cutoff - date.fromisoformat(last)).days if last else None
            life = records_by_customer[code]
            hist_tickets = int(life["tickets"])
            life["grossMarginCents"] = int(life["revenueCents"] - life["cogsCents"])
            life["averageTicketCents"] = life["revenueCents"] / hist_tickets if hist_tickets else None
            life["averageItemsPerTicket"] = life["units"] / hist_tickets if hist_tickets else None
            trend = self._customer_trend(last30[code], prior30[code])
            rfm_raw = {"recencyDays": recency, "frequency90d": recent90[code]["tickets"], "monetary90dCents": recent90[code]["revenueCents"]}
            rfm = {"R": _quantile_rfm_score([float(lifetime_recency[c]) for c in customer_codes], float(recency if recency is not None else lifetime_recency[code]), reverse=True),
                   "F": _quantile_rfm_score([float(recent90[c]["tickets"]) for c in customer_codes], float(recent90[code]["tickets"])),
                   "M": _quantile_rfm_score([float(recent90[c]["revenueCents"]) for c in customer_codes], float(recent90[code]["revenueCents"]))}
            segment, reasons = self._segment(cutoff, first, recency, hist_tickets, recent90[code], trend,
                                             frequency_threshold, monetary_threshold, rfm)
            category_units = all_metrics["customerCategoryUnits"].get(code, {})
            favorite_category = sorted(category_units.items(), key=lambda pair: (-pair[1], pair[0]))[0][0] if category_units else None
            subcategory_units = all_metrics["customerSubcategoryUnits"].get(code, {})
            favorite_subcategory = sorted(subcategory_units.items(), key=lambda pair: (-pair[1], pair[0]))[0][0] if subcategory_units else None
            top_skus = sorted(all_metrics["customerProductUnits"].get(code, {}).items(), key=lambda pair: (-pair[1], pair[0]))[:5]
            metric_trends = {key: _trend(last30[code][field], prior30[code][field])
                             for key, field in (("spendCents", "revenueCents"), ("frequency", "tickets"), ("averageTicketCents", "averageTicketCents"))}
            rows.append({"customerCode": code, "displayName": customer["displayName"], "firstPurchaseDate": first,
                         "lastPurchaseDate": last, "recencyDays": recency,
                         "ticketCount": hist_tickets, "units": int(life["units"]), "totalSpentCents": int(life["revenueCents"]),
                         "averageTicketCents": life["revenueCents"] / hist_tickets if hist_tickets else None,
                         "averageItemsPerTicket": life["units"] / hist_tickets if hist_tickets else None,
                         "averageDistinctSkusPerTicket": self._customer_average_distinct(customer, sales, lines),
                         "purchaseFrequency": {"ticketsPer30DaysObserved": hist_tickets / max(1, (cutoff - date.fromisoformat(first)).days + 1) * 30 if first else 0,
                                               "averageDaysBetweenTickets": ((date.fromisoformat(last) - date.fromisoformat(first)).days / (hist_tickets - 1)) if hist_tickets > 1 else None},
                         "grossMarginContributionCents": int(life["revenueCents"] - life["cogsCents"]),
                         "windows": {"last7Days": self._compact_window(_period_customer_metrics(sales, lines, self.products, cutoff - timedelta(days=6), cutoff, {code})[code]),
                                     "last30Days": self._compact_window(last30[code]), "last90Days": self._compact_window(recent90[code]),
                                     "history": self._compact_window(life)},
                         "rfm90d": {"raw": rfm_raw, "score": rfm, "scoreMethod": "tie-aware percentile ranks over all 40 registered customers"},
                         "segment": segment, "reasonCodes": reasons, "supportingMetrics": {"frequencyP75Tickets90d": frequency_threshold,
                             "spendP75Cents90d": monetary_threshold, "purchaseTrend30d": trend["status"]},
                         "trends30d": {"current": self._compact_window(last30[code]), "previous": self._compact_window(prior30[code]),
                                       "metrics": metric_trends, "status": trend["status"], "method": trend["method"]},
                         "preferences": {"favoriteCategoryCode": favorite_category,
                             "favoriteCategoryName": self.categories[favorite_category]["name"] if favorite_category else None,
                             "favoriteCategoryUnitSharePct": _safe_float(category_units.get(favorite_category, 0) / max(1, life["units"]) * 100, 4) if favorite_category else None,
                             "favoriteSubcategoryCode": favorite_subcategory,
                             "favoriteSubcategoryName": next((sub["name"] for category in self.static["categories"]["categories"]
                                                               for sub in category["subcategories"] if sub["code"] == favorite_subcategory), None) if favorite_subcategory else None,
                             "favoriteSubcategoryUnitSharePct": _safe_float(subcategory_units.get(favorite_subcategory, 0) / max(1, life["units"]) * 100, 4) if favorite_subcategory else None,
                             "topProducts": [{"sku": sku, "name": self.products[sku]["name"], "units": units} for sku, units in top_skus],
                             "promotionTicketSharePct": _safe_float(life["promotionTickets"] / max(1, hist_tickets) * 100, 4),
                             "promotionUsage": self._promo_label(life["promotionTickets"] / max(1, hist_tickets)),
                             "averageDistinctSkusPerTicket": self._customer_average_distinct(customer, sales, lines)},
                         "historicalValueCents": {"revenue": int(life["revenueCents"]), "grossMarginContribution": int(life["revenueCents"] - life["cogsCents"]),
                                                   "label": "observed history only; not predictive lifetime value"}})
        # The original profile is read only now, for post-analysis comparison.
        profile_by_customer = {row["customerCode"]: row["customerProfileKey"] for row in self.customers}
        profile_audit = self._profile_audit(rows, profile_by_customer)
        for row in rows:
            profile_key = profile_by_customer.get(row["customerCode"])
            row["syntheticProfileAudit"] = profile_audit["byCustomer"].get(row["customerCode"], {"status": "NOT_ALIGNED", "profileKey": profile_key})
        by_segment = Counter(row["segment"] for row in rows)
        rankings = {
            "topBySpend": self._rank(rows, "totalSpentCents"),
            "topByFrequency": self._rank(rows, "ticketCount"),
            "topByMarginContribution": self._rank(rows, "grossMarginContributionCents"),
            "topByAverageTicket": self._rank(rows, "averageTicketCents"),
            "recentlyActive": sorted([r for r in rows if r["recencyDays"] is not None], key=lambda r: (r["recencyDays"], r["customerCode"]))[:10],
            "atRisk": sorted([r for r in rows if r["segment"] == "AT_RISK"], key=lambda r: (-r["totalSpentCents"], r["customerCode"]))[:20],
            "inactive": sorted([r for r in rows if r["segment"] == "INACTIVE"], key=lambda r: (-r["totalSpentCents"], r["customerCode"]))[:20],
            "new": sorted([r for r in rows if r["segment"] == "NEW"], key=lambda r: (r["recencyDays"] or 0, r["customerCode"]))[:20],
        }
        reg_tickets = sum(1 for s in all_metrics["sales"] if s.get("customerCode"))
        total_tickets = len(all_metrics["sales"])
        reg_revenue = sum(all_metrics["customerMetrics"].get(code, {}).get("revenueCents", 0) for code in customer_codes)
        total_revenue = all_metrics["revenueCents"]
        return {"contractVersion": CUSTOMER_VERSION, "scenarioId": v3_forecast.SCENARIO_ID,
                "asOfDate": cutoff.isoformat(), "timezone": TIMEZONE, "windowDays": 90,
                "registeredCustomerCount": len(rows), "consumerFinalIncludedInIndividualRfm": False,
                "consumerFinalShare": {"ticketsPct": _safe_float((total_tickets - reg_tickets) / max(1, total_tickets) * 100, 4),
                                        "revenuePct": _safe_float((total_revenue - reg_revenue) / max(1, total_revenue) * 100, 4)},
                "segmentDistribution": dict(sorted(by_segment.items())), "customers": rows,
                "rankings": rankings, "syntheticProfileAudit": profile_audit["summary"],
                "methodology": {"rfm": "quantile/rank based over 40 registered customers, ties receive midrank; zero-activity customers remain in sample",
                    "inactive": "no completed ticket in the last 90 days", "atRisk": "last purchase >45 days ago or observed 30-day trend declining",
                    "trend": "GROWING/DECLINING requires at least 2 of spend, frequency and average ticket to move by >=10%; otherwise STABLE",
                    "new": "first observed purchase within 30 days and <=2 tickets in last 90 days",
                    "notChurnProbability": True, "lifetimeValue": "not estimated; historical revenue/margin only"}}

    @staticmethod
    def _compact_window(row: dict[str, Any]) -> dict[str, Any]:
        return {"ticketCount": row["tickets"], "units": row["units"], "revenueCents": row["revenueCents"],
                "averageTicketCents": _safe_float(row.get("averageTicketCents"), 4),
                "averageItemsPerTicket": _safe_float(row.get("averageItemsPerTicket"), 4),
                "grossMarginContributionCents": row["grossMarginCents"]}

    @staticmethod
    def _promo_label(share: float) -> str:
        return "HIGH_PROMO_USAGE" if share >= .60 else "MEDIUM_PROMO_USAGE" if share >= .30 else "LOW_PROMO_USAGE"

    @staticmethod
    def _customer_trend(current: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
        fields = ("revenueCents", "tickets", "averageTicketCents")
        directions = []
        for key in fields:
            old, new = previous.get(key), current.get(key)
            if old is None or new is None:
                directions.append(0)
            elif old == 0:
                directions.append(1 if new > 0 else 0)
            else:
                change = (new - old) / old
                directions.append(1 if change >= .10 else -1 if change <= -.10 else 0)
        if directions.count(1) >= 2:
            status = "GROWING"
        elif directions.count(-1) >= 2:
            status = "DECLINING"
        else:
            status = "STABLE"
        return {"status": status, "method": "2 of 3 metrics change by at least 10%; previous zero treated as new activity"}

    @staticmethod
    def _segment(cutoff: date, first: str | None, recency: int | None, historical_tickets: int,
                 last90: dict[str, Any], trend: dict[str, Any], frequency_p75: float,
                 spend_p75: float, rfm: dict[str, int]) -> tuple[str, list[str]]:
        reasons: list[str] = []
        if historical_tickets == 0 or last90["tickets"] == 0:
            return "INACTIVE", ["NO_COMPLETED_TICKET_IN_LAST_90_DAYS"]
        if first and date.fromisoformat(first) >= cutoff - timedelta(days=29) and last90["tickets"] <= 2:
            return "NEW", ["FIRST_PURCHASE_WITHIN_LAST_30_DAYS", "LOW_90_DAY_FREQUENCY"]
        if (recency is not None and recency > 45) or trend["status"] == "DECLINING":
            if recency is not None and recency > 45:
                reasons.append("LAST_PURCHASE_OVER_45_DAYS_AGO")
            if trend["status"] == "DECLINING":
                reasons.append("DECLINING_30_DAY_TREND")
            if last90["revenueCents"] >= spend_p75:
                reasons.append("HIGH_HISTORICAL_WINDOW_SPEND")
            return "AT_RISK", reasons
        if last90["revenueCents"] >= spend_p75 and rfm["R"] >= 3:
            return "TOP_HIGH_VALUE", ["TOP_QUARTILE_90_DAY_SPEND", "RECENT_ACTIVITY"]
        if last90["tickets"] >= frequency_p75 and rfm["R"] >= 3:
            return "LOYAL", ["TOP_QUARTILE_90_DAY_FREQUENCY", "RECENT_ACTIVITY"]
        return "POTENTIAL", ["ACTIVE_IN_LAST_90_DAYS", "BELOW_TOP_QUARTILE_FREQUENCY_OR_SPEND"]

    @staticmethod
    def _customer_average_distinct(customer: dict[str, Any], sales: list[dict[str, Any]],
                                   lines_by_sale: dict[str, list[dict[str, Any]]]) -> float | None:
        codes = [sale["saleCode"] for sale in sales if sale.get("customerCode") == customer["customerCode"]]
        sizes = [len({line["sku"] for line in lines_by_sale[code]}) for code in codes]
        return sum(sizes) / len(sizes) if sizes else None

    @staticmethod
    def _rank(rows: list[dict[str, Any]], field: str) -> list[dict[str, Any]]:
        return sorted(rows, key=lambda row: (-(row[field] if row[field] is not None else -math.inf), row["customerCode"]))[:10]

    @staticmethod
    def _profile_audit(customers: list[dict[str, Any]], profile_by_customer: dict[str, str]) -> dict[str, Any]:
        expected = {"AT_RISK": {"AT_RISK"}, "INACTIVE": {"INACTIVE"}, "RECENT": {"NEW", "POTENTIAL"},
                    "OCCASIONAL": {"POTENTIAL", "AT_RISK"}, "FREQUENT_SMALL_TICKET": {"LOYAL", "TOP_HIGH_VALUE"},
                    "FREQUENT_HIGH_TICKET": {"LOYAL", "TOP_HIGH_VALUE"}}
        by_customer = {}
        grouped: dict[str, list[bool]] = defaultdict(list)
        for row in customers:
            # The profileKey enters only this post-hoc audit; it is absent from all scoring inputs.
            profile = profile_by_customer.get(row["customerCode"])
            segment = row["segment"]
            aligned = segment in expected.get(profile, set())
            by_customer[row["customerCode"]] = {"profileKey": profile, "segment": segment,
                                                  "status": "ALIGNED" if aligned else "NOT_ALIGNED"}
            grouped[profile or "UNKNOWN"].append(aligned)
        # These counts are a comparison, not training or recalibration.
        summary = {}
        for profile, flags in sorted(grouped.items()):
            aligned = sum(flags)
            status = "ALIGNED" if aligned == len(flags) else "PARTIALLY_ALIGNED" if aligned else "NOT_ALIGNED"
            summary[profile] = {"count": len(flags), "alignedCount": aligned, "status": status}
        statuses = Counter(value["status"] for value in summary.values())
        return {"byCustomer": by_customer, "summary": {"profileGroups": summary, "groupStatusCounts": dict(statuses),
            "method": "profile labels compared after observed-history segmentation; no profile feature or threshold used"}}


class SupplierIntelligenceV3:
    def __init__(self, root: Path, records: dict[str, Any], static: dict[str, Any], business: BusinessIntelligenceV3):
        self.root, self.records, self.static, self.business = Path(root), records, static, business
        self.suppliers = {row["supplierCode"]: row for row in static["suppliers"]}
        self.products = business.products
        self.categories = business.categories

    def snapshot(self, *, as_of_date: str | date = v3_forecast.HISTORY_END,
                 period: str | dict[str, str] = "HISTORY", inventory: dict[str, Any] | None = None) -> dict[str, Any]:
        cutoff = _as_date(as_of_date)
        if inventory is None:
            inventory = InventoryIntelligenceV3(self.root).snapshot(cutoff)
        window = resolve_period(period, cutoff)
        purchases = [row for row in self.records["purchases"]
                     if row.get("status") != "cancelled" and row.get("orderedLocalDate", "") <= cutoff.isoformat()]
        purchase_by_code = {row["purchaseCode"]: row for row in purchases}
        # Index canonical lines once; only receipt/commitment facts known by cutoff are used.
        # The bounded local dataset has 3,408 lines; the index is built once for later lookups.
        lines_by_purchase: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for line in self.records["purchaseLines"]:
            lines_by_purchase[line["purchaseCode"]].append(line)
        # Recompute the small aggregate loop using a single indexed pass; replaces no source rows.
        stats = {code: {"orders": [], "receivedOrders": [], "receivedSpendCents": 0, "committedSpendCents": 0,
            "pendingCommitmentCents": 0, "unitsOrdered": 0, "unitsReceived": 0, "lateDays": [], "delayDays": [],
            "leadTimes": [], "skuUnits": Counter(), "costsBySku": defaultdict(list), "categories": set(), "overdueOrders": 0}
            for code in self.suppliers}
        pairs = defaultdict(list)
        observed_offer_skus = defaultdict(set)
        for purchase in purchases:
            code = purchase["supplierCode"]
            state = stats[code]
            state["orders"].append(purchase)
            lines = lines_by_purchase[purchase["purchaseCode"]]
            order_cost = sum(int(line["quantityOrdered"]) * int(line["purchasePriceCents"]) for line in lines)
            state["committedSpendCents"] += order_cost
            state["unitsOrdered"] += sum(int(line["quantityOrdered"]) for line in lines)
            received = bool(purchase.get("receivedLocalDate") and purchase["receivedLocalDate"] <= cutoff.isoformat())
            if received:
                received_date = date.fromisoformat(purchase["receivedLocalDate"])
                state["receivedOrders"].append(purchase)
                state["leadTimes"].append(max(0, (received_date - date.fromisoformat(purchase["orderedLocalDate"])).days))
                promised = date.fromisoformat(purchase["promisedLocalDate"])
                delay = max(0, (received_date - promised).days)
                state["delayDays"].append(delay)
                if delay:
                    state["lateDays"].append(delay)
                for line in lines:
                    qty = int(line["quantityReceived"])
                    if qty <= 0:
                        continue
                    cost = int(line["purchasePriceCents"])
                    row = {"date": purchase["receivedLocalDate"], "unitCostCents": cost, "units": qty,
                           "purchaseCode": purchase["purchaseCode"]}
                    state["receivedSpendCents"] += qty * cost
                    state["unitsReceived"] += qty
                    state["skuUnits"][line["sku"]] += qty
                    state["categories"].add(self.products[line["sku"]]["categoryCode"])
                    state["costsBySku"][line["sku"]].append(row)
                    pairs[(code, line["sku"])].append(row)
                    observed_offer_skus[code].add(line["sku"])
            else:
                state["pendingCommitmentCents"] += order_cost
                promised = purchase.get("promisedLocalDate")
                if promised and promised < cutoff.isoformat():
                    state["overdueOrders"] += 1
        received_order_count = sum(len(row["receivedOrders"]) for row in stats.values())
        all_received = sum(row["receivedSpendCents"] for row in stats.values())
        offer_map = self._offers(cutoff)
        sku_offer_count = Counter(offer["supplierCode"] for offers in offer_map.values() for offer in offers)
        sku_suppliers = {sku: {offer["supplierCode"] for offer in offers} for sku, offers in offer_map.items()}
        sku_exclusive = Counter(next(iter(codes)) for sku, codes in sku_suppliers.items() if len(codes) == 1)
        rows = []
        for code, config in sorted(self.suppliers.items()):
            state = stats[code]
            received_n, order_n = len(state["receivedOrders"]), len(state["orders"])
            lead = state["leadTimes"]
            delays = state["lateDays"]
            ontime = received_n - len(delays)
            window_orders = [row for row in state["orders"] if window["startDate"] <= row["orderedLocalDate"] <= window["endDate"]]
            row = {"supplierCode": code, "displayName": config["displayName"], "purchaseOrderCount": order_n,
                "receivedOrderCount": received_n, "pendingOrderCount": order_n - received_n,
                "unitsOrdered": state["unitsOrdered"], "unitsReceived": state["unitsReceived"],
                "receivedSpendCents": state["receivedSpendCents"], "committedSpendCents": state["committedSpendCents"],
                "pendingCommitmentCents": state["pendingCommitmentCents"],
                "averageReceivedOrderValueCents": state["receivedSpendCents"] / received_n if received_n else None,
                "firstOrderDate": min((p["orderedLocalDate"] for p in state["orders"]), default=None),
                "lastOrderDate": max((p["orderedLocalDate"] for p in state["orders"]), default=None),
                "purchaseFrequency": {"ordersInSelectedPeriod": len(window_orders), "ordersPer30Days": len(window_orders) / max(1, window["days"]) * 30},
                "categoriesSuppliedObserved": sorted(state["categories"]), "productsSuppliedObservedCount": len(state["skuUnits"]),
                "observedSkuCount": len(state["skuUnits"]), "offeredSkuCount": sku_offer_count[code],
                "offeredSkuSharePct": _safe_float(sku_offer_count[code] / max(1, len(self.products)) * 100, 4),
                "exclusiveOfferedSkuCount": sku_exclusive[code],
                "exclusiveOfferedSkuSharePct": _safe_float(sku_exclusive[code] / max(1, len(self.products)) * 100, 4),
                "exclusiveObservedSkuCount": sum(1 for sku in state["skuUnits"] if sum(1 for code2 in stats if sku in stats[code2]["skuUnits"]) == 1),
                "purchaseSpendSharePct": _safe_float(state["receivedSpendCents"] / all_received * 100 if all_received else 0, 4),
                "leadTime": {"sampleSize": received_n, "averageDays": _safe_float(sum(lead) / len(lead) if lead else None, 4),
                    "medianDays": _safe_float(median(lead) if lead else None, 4),
                    "p90Days": _safe_float(_nearest_rank([float(x) for x in lead], .90) if received_n >= 5 else None, 4),
                    "stdDevDays": _safe_float(pstdev(lead) if lead else None, 4), "sampleQuality": "ADEQUATE" if received_n >= 5 else "LOW_SAMPLE"},
                "punctuality": {"onTimeOrders": ontime, "receivedOrders": received_n,
                    "onTimeRatePct": _safe_float(ontime / received_n * 100 if received_n else None, 4),
                    "delayedOrderCount": len(delays), "averageDelayDaysWhenLate": _safe_float(sum(delays) / len(delays) if delays else 0, 4),
                    "maxDelayDays": max(delays, default=0), "delayRatePct": _safe_float(len(delays) / received_n * 100 if received_n else None, 4),
                    "classificationToleranceDays": 0, "pendingWithinPromiseExcludedFromLate": True},
                "fillRate": {"status": "NOT_AVAILABLE", "reason": "No partial receipts are represented; this metric is not inferred"},
                "window": {"period": window, "orders": len(window_orders)},
                "productsSupplied": [{"sku": sku, "name": self.products[sku]["name"], "unitsReceived": units}
                                     for sku, units in sorted(state["skuUnits"].items(), key=lambda pair: (-pair[1], pair[0]))[:30]]}
            row["averageOrderValueCents"] = row["averageReceivedOrderValueCents"]
            rows.append(row)
        total_commit = sum(s["committedSpendCents"] for s in stats.values())
        for row in rows:
            row["committedSpendSharePct"] = _safe_float(row["committedSpendCents"] / total_commit * 100 if total_commit else 0, 4)
        offer_alternatives = self._product_alternatives(offer_map)
        cost_history = self._cost_intelligence(pairs)
        rankings = self._supplier_rankings(rows)
        exposure = self._critical_exposure(inventory, offer_map)
        config_audit = self._supplier_config_audit(rows)
        return {"contractVersion": SUPPLIER_VERSION, "scenarioId": v3_forecast.SCENARIO_ID,
                "asOfDate": cutoff.isoformat(), "timezone": TIMEZONE, "period": window,
                "summary": {"suppliers": len(rows), "purchaseOrders": sum(r["purchaseOrderCount"] for r in rows),
                    "receivedOrders": received_order_count, "pendingOrders": sum(r["pendingOrderCount"] for r in rows),
                    "receivedSpendCents": all_received, "committedSpendCents": total_commit,
                    "pendingCommitmentCents": sum(r["pendingCommitmentCents"] for r in rows),
                    "unitsOrdered": sum(r["unitsOrdered"] for r in rows), "unitsReceived": sum(r["unitsReceived"] for r in rows),
                    "fillRate": {"status": "NOT_AVAILABLE", "reason": "No partial receipts are represented"}},
                "suppliers": rows, "rankings": rankings, "productAlternatives": offer_alternatives,
                "costIntelligence": cost_history, "criticalInventorySupplierExposure": exposure,
                "supplierConfigurationAudit": config_audit,
                "methodology": {"leadTime": "calendar days from orderedLocalDate to receivedLocalDate; received only",
                    "punctuality": "on time when receivedLocalDate <= promisedLocalDate (0-day tolerance)",
                    "delayRate": "late received orders / received orders; pending orders are excluded",
                    "spendShare": "received units x observed purchasePriceCents; committed order value is shown separately",
                    "supplierOffers": "static canonical offers are operational alternatives, not observed performance",
                    "noUnifiedBestSupplierScore": True}}

    def _offers(self, cutoff: date) -> dict[str, list[dict[str, Any]]]:
        definitions = self.static["offers"]
        cost_by_key: dict[tuple[str, str], int] = {}
        for product in self.static["products"]:
            cost_by_key[(product["sku"], product["preferredSupplierCode"])] = int(round(product["purchaseCostDemo"] * 100))
        for offer in definitions["secondaryAssignments"]:
            product = self.products[offer["sku"]]
            cost_by_key[(offer["sku"], offer["supplierCode"])] = int(round(product["purchaseCostDemo"] * 100 * offer["priceFactor"]))
        latest: dict[tuple[str, str], dict[str, Any]] = {}
        for row in self.records["supplierCostHistory"]:
            if row["effectiveFrom"] <= cutoff.isoformat():
                key = (row["sku"], row["supplierCode"])
                if key not in latest or latest[key]["effectiveFrom"] < row["effectiveFrom"]:
                    latest[key] = row
        for key, row in latest.items():
            cost_by_key[key] = int(row["purchaseCostCents"])
        pack_rules = definitions.get("packMultipleBySupplier", {})
        result: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for product in self.static["products"]:
            sku = product["sku"]
            codes = [product["preferredSupplierCode"]] + [x["supplierCode"] for x in definitions["secondaryAssignments"] if x["sku"] == sku]
            for code in sorted(set(codes)):
                supplier = self.suppliers[code]
                pack = pack_rules.get(f"{code}:{sku}", pack_rules.get(code))
                result[sku].append({"supplierCode": code, "supplierName": supplier["displayName"],
                    "preferred": code == product["preferredSupplierCode"], "unitCostCents": cost_by_key.get((sku, code)),
                    "currency": "PEN", "leadTimeDays": product["leadTimeDays"] if code == product["preferredSupplierCode"] else supplier["leadTimeMeanDays"],
                    "moq": None, "moqStatus": "NOT_CONFIGURED", "packMultiple": pack,
                    "offerSource": "canonical static supplier offers and observed cost history through asOfDate"})
        return {sku: sorted(rows, key=lambda row: (not row["preferred"], row["unitCostCents"], row["supplierCode"])) for sku, rows in result.items()}

    def _product_alternatives(self, offers: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
        return [{"sku": sku, "productName": self.products[sku]["name"], "preferredSupplierCode": next((r["supplierCode"] for r in rows if r["preferred"]), None),
                 "currentPurchaseCostCents": next((r["unitCostCents"] for r in rows if r["preferred"]), None), "alternatives": rows}
                for sku, rows in sorted(offers.items())]

    def _cost_intelligence(self, pairs: dict[tuple[str, str], list[dict[str, Any]]]) -> list[dict[str, Any]]:
        rows = []
        for (supplier, sku), values in sorted(pairs.items()):
            ordered = sorted(values, key=lambda row: (row["date"], row["purchaseCode"] if "purchaseCode" in row else ""))
            weighted_units = sum(row["units"] for row in ordered)
            average = sum(row["unitCostCents"] * row["units"] for row in ordered) / max(1, weighted_units)
            first, latest = ordered[0]["unitCostCents"], ordered[-1]["unitCostCents"]
            rows.append({"supplierCode": supplier, "supplierName": self.suppliers[supplier]["displayName"],
                "sku": sku, "productName": self.products[sku]["name"], "receiptCount": len(ordered), "unitsReceived": weighted_units,
                "latestPurchaseCostCents": latest, "averagePurchaseCostCentsWeighted": _safe_float(average, 4),
                "minimumObservedCostCents": min(row["unitCostCents"] for row in ordered),
                "maximumObservedCostCents": max(row["unitCostCents"] for row in ordered),
                "firstObservedDate": ordered[0]["date"], "latestObservedDate": ordered[-1]["date"],
                "recentChangePct": _safe_float((latest - first) / first * 100 if first else None, 4),
                "interpretation": "synthetic observed purchase-cost history; not real inflation"})
        return rows

    @staticmethod
    def _supplier_rankings(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        specs = {"spend": ("receivedSpendCents", True), "orders": ("purchaseOrderCount", True), "units": ("unitsReceived", True),
                 "fastestLeadTime": ("leadTime.averageDays", False), "punctuality": ("punctuality.onTimeRatePct", True),
                 "delays": ("punctuality.delayedOrderCount", False), "productCoverage": ("offeredSkuCount", True),
                 "exclusiveProducts": ("exclusiveOfferedSkuCount", True)}
        result = {}
        for rank, (name, (field, descending)) in enumerate(specs.items()):
            def value(row: dict[str, Any]) -> Any:
                target = row
                for part in field.split("."):
                    target = target.get(part) if isinstance(target, dict) else None
                return target
            ordered = sorted(rows, key=lambda row: ((-(value(row) if value(row) is not None else -math.inf) if descending else (value(row) if value(row) is not None else math.inf)), row["supplierCode"]))
            result[name] = [{"rank": i + 1, "supplierCode": row["supplierCode"], "displayName": row["displayName"],
                             "metric": value(row), "evidenceCount": row["receivedOrderCount"] if name in {"fastestLeadTime", "punctuality", "delays"} else row["purchaseOrderCount"]}
                            for i, row in enumerate(ordered[:10])]
        return result

    def _critical_exposure(self, inventory: dict[str, Any] | None, offers: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
        if inventory is None:
            raise ValueError("Inventory snapshot at the requested asOfDate is required")
        risky = []
        for product in inventory.get("products", []):
            risk = product.get("risk", {}).get("level")
            single = product.get("supplier", {}).get("dependencyStatus") == "SINGLE_SOURCE"
            if risk in {"CRITICAL", "HIGH"} and single:
                preferred = next((row["supplierCode"] for row in offers.get(product["sku"], []) if row["preferred"]), None)
                risky.append({"sku": product["sku"], "productName": product["productName"], "inventoryRisk": risk,
                              "supplierCode": preferred, "supplierName": self.suppliers.get(preferred, {}).get("displayName"),
                              "recommendedQty": product.get("recommendation", {}).get("recommendedQty", 0)})
        return {"singleSourceCriticalOrHighSkuCount": len(risky), "exposures": sorted(risky, key=lambda row: (row["inventoryRisk"] != "CRITICAL", row["sku"])),
                "meaning": "business exposure due to inventory risk plus a single configured supplier; not a supplier-failure prediction"}

    def _supplier_config_audit(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        # Config fields are compared only after order-derived performance was computed.
        by_code = {row["supplierCode"]: row for row in rows}
        result = []
        for code, config in sorted(self.suppliers.items()):
            observed = by_code[code]
            observed_rate = observed["punctuality"]["onTimeRatePct"]
            configured_rate = float(config["onTimeProbabilityDemo"]) * 100
            observed_lead = observed["leadTime"]["averageDays"]
            configured_lead = float(config["leadTimeMeanDays"])
            if observed_rate is None or observed["receivedOrderCount"] < 5:
                status = "NOT_COMPARABLE_LOW_SAMPLE"
            else:
                rate_match = abs(observed_rate - configured_rate) <= 15
                lead_match = observed_lead is not None and abs(observed_lead - configured_lead) <= max(2, .5 * configured_lead)
                status = "ALIGNED" if rate_match and lead_match else "PARTIALLY_ALIGNED" if rate_match or lead_match else "NOT_ALIGNED"
            result.append({"supplierCode": code, "profileOnTimeRatePct": configured_rate, "observedOnTimeRatePct": observed_rate,
                           "profileLeadTimeMeanDays": configured_lead, "observedAverageLeadTimeDays": observed_lead,
                           "sampleSize": observed["receivedOrderCount"], "status": status,
                           "use": "post-hoc simulation-configuration comparison only"})
        return {"suppliers": result, "statusCounts": dict(Counter(row["status"] for row in result)),
                "method": "on-time within 15 percentage points and lead time within max(2d,50%) is aligned; no config input to observed KPIs"}


class BusinessHealthSnapshotV3:
    def __init__(self, root: Path, business: BusinessIntelligenceV3, customers: CustomerIntelligenceV3,
                 suppliers: SupplierIntelligenceV3):
        self.root, self.business, self.customers, self.suppliers = Path(root), business, customers, suppliers

    def snapshot(self, *, as_of_date: str | date = v3_forecast.HISTORY_END,
                 period: str | dict[str, str] = "LAST_30_DAYS",
                 business_summary: dict[str, Any] | None = None,
                 customer_summary: dict[str, Any] | None = None,
                 supplier_summary: dict[str, Any] | None = None,
                 inventory: dict[str, Any] | None = None,
                 inventory_unit_costs: dict[str, int] | None = None) -> dict[str, Any]:
        cutoff = _as_date(as_of_date)
        sales = business_summary or self.business.summary(period, as_of_date=cutoff)
        customer = customer_summary or self.customers.snapshot(as_of_date=cutoff)
        inventory = inventory or InventoryIntelligenceV3(self.root).snapshot(cutoff)
        suppliers = supplier_summary or self.suppliers.snapshot(as_of_date=cutoff, period=period, inventory=inventory)
        basket_path = self.root / "ml/data/minimarket-pasco-v3-market-basket-v1.json"
        basket: dict[str, Any]
        if cutoff == v3_forecast.HISTORY_END and basket_path.is_file():
            artifact = _read_json(basket_path)
            basket = {"available": True, "analysisVersion": artifact["analysisVersion"],
                      "stableCrossSellRuleCount": sum(r["stability"]["status"] == "STABLE" and r["classification"] == "CROSS_SELL" for r in artifact["rules"]),
                      "usefulRuleCount": artifact["summary"]["rulesAfterRedundancyReduction"],
                      "topExamples": [{"antecedentSkus": r["antecedentSkus"], "consequentSkus": r["consequentSkus"],
                                       "ticketCount": r["ticketCount"], "support": r["support"], "confidence": r["confidence"],
                                       "lift": r["lift"], "stability": r["stability"]["status"]}
                                      for r in artifact["rules"] if r["classification"] == "CROSS_SELL" and r["stability"]["status"] == "STABLE"][:5],
                      "categoryAssociations": artifact["categoryRules"][:10], "sourceArtifactCutoff": artifact["cutoffDate"]}
        else:
            basket = {"available": False, "reason": "M6.7 artifact cutoff is later than asOfDate; omitted to prevent future leakage"}
        insights = self._insights(sales, customer, inventory, suppliers, basket)
        domain_alerts = {name: [alert for alert in insights if alert["code"] in codes] for name, codes in {
            "sales": {"SALES_DOWN_VS_PREVIOUS_PERIOD"}, "margin": {"MARGIN_DOWN"},
            "customers": {"CUSTOMER_AT_RISK_COUNT"},
            "inventory": {"CRITICAL_STOCK_COUNT", "OVERSTOCK_VALUE", "SINGLE_SOURCE_INVENTORY_EXPOSURE"},
            "suppliers": {"HIGH_SUPPLIER_DEPENDENCY"}, "marketBasket": {"CROSS_SELL_OPPORTUNITIES"},
        }.items()}
        products = inventory["products"]
        costs = inventory_unit_costs or {}
        overstock_value_cents = (sum(int(row.get("classification", {}).get("excessUnitsEstimated", 0)) * int(costs.get(row["sku"], 0)) for row in products)
                                 if cutoff == v3_forecast.HISTORY_END else None)
        inventory_domain = {**inventory["summary"], "overstockEstimatedValueCents": overstock_value_cents,
                            "forecastSource": "MOVING_AVERAGE_28", "forecastHorizons": [1, 7, 14]}
        if cutoff <= v3_forecast.HISTORY_END:
            forecast = self._forecast_totals(cutoff, self.root)
            inventory_domain["forecastExpectedUnitsNext1d"] = forecast["expectedUnitsNext1d"]
            inventory_domain["forecastExpectedUnitsNext7d"] = forecast["expectedUnitsNext7d"]
            inventory_domain["forecastExpectedUnitsNext14d"] = forecast["expectedUnitsNext14d"]
        return {"contractVersion": HEALTH_VERSION, "scenarioId": v3_forecast.SCENARIO_ID,
                "datasetVersion": v3_forecast.DATASET_VERSION, "datasetSha256": v3_forecast.DATASET_SHA256,
                "asOfDate": cutoff.isoformat(), "timezone": TIMEZONE, "period": sales["period"],
                "businessHealth": {"sales": {"kpis": sales["kpis"], "trends": sales["trends"], "customerMix": sales["customerMix"], "alerts": domain_alerts["sales"]},
                    "margin": {**sales["marginIntelligence"], "alerts": domain_alerts["margin"]}, "customers": {"segmentDistribution": customer["segmentDistribution"],
                        "atRiskCount": customer["segmentDistribution"].get("AT_RISK", 0), "inactiveCount": customer["segmentDistribution"].get("INACTIVE", 0),
                        "newCount": customer["segmentDistribution"].get("NEW", 0), "alerts": domain_alerts["customers"]},
                    "inventory": {**inventory_domain, "alerts": domain_alerts["inventory"]}, "suppliers": {"summary": suppliers["summary"],
                        "topSpendShares": sorted([{"supplierCode": r["supplierCode"], "sharePct": r["purchaseSpendSharePct"]} for r in suppliers["suppliers"]], key=lambda r: (-r["sharePct"], r["supplierCode"]))[:5],
                        "criticalInventoryExposure": suppliers["criticalInventorySupplierExposure"], "alerts": domain_alerts["suppliers"]},
                    "marketBasket": {**basket, "alerts": domain_alerts["marketBasket"]}}, "alerts": insights, "healthScore": None,
                "interpretation": "domain KPIs and documented rule-based insights; no composite score"}

    @staticmethod
    def _forecast_totals(cutoff: date, root: Path = ROOT) -> dict[str, float]:
        dataset = v3_forecast.load_validated_dataset(root)
        forecasts = [v3_baseline_bundle.predict(dataset, sku=sku, cutoff=cutoff) for sku in sorted(dataset.product_by_sku)]
        if len(forecasts) != 80 or any(row.get("status") != "READY" or row.get("forecastSource") != "MOVING_AVERAGE_28" for row in forecasts):
            raise ValueError("Approved V3 moving-average forecast is incomplete")
        return {f"expectedUnitsNext{days}d": round(sum(float(row[f"expectedUnitsNext{days}d"]) for row in forecasts), 4) for days in (1, 7, 14)}

    @staticmethod
    def _insights(sales: dict[str, Any], customers: dict[str, Any], inventory: dict[str, Any],
                  suppliers: dict[str, Any], basket: dict[str, Any]) -> list[dict[str, Any]]:
        alerts = []
        revenue_trend = sales["trends"]["revenue"]["percentChange"]
        if revenue_trend is not None and revenue_trend <= -10:
            alerts.append({"code": "SALES_DOWN_VS_PREVIOUS_PERIOD", "severity": "WARNING", "metric": "revenue",
                           "comparison": sales["trends"]["revenue"], "summary": "Revenue is at least 10% below the equivalent previous period."})
        margin_trend = sales["trends"]["grossMargin"]["percentChange"]
        if margin_trend is not None and margin_trend <= -10:
            alerts.append({"code": "MARGIN_DOWN", "severity": "WARNING", "metric": "grossMargin",
                           "comparison": sales["trends"]["grossMargin"], "summary": "Gross margin value is at least 10% below the equivalent previous period; this is not net profit."})
        dist = customers["segmentDistribution"]
        at_risk_share = dist.get("AT_RISK", 0) / max(1, customers["registeredCustomerCount"])
        if dist.get("AT_RISK", 0):
            alerts.append({"code": "CUSTOMER_AT_RISK_COUNT", "severity": "CRITICAL" if at_risk_share >= .25 else "WARNING",
                           "metric": {"count": dist["AT_RISK"], "sharePct": round(at_risk_share * 100, 2)},
                           "comparison": None, "summary": "Some registered scenario customers meet the documented at-risk rules; no churn probability is implied."})
        summary = inventory["summary"]
        if summary.get("critical", 0):
            alerts.append({"code": "CRITICAL_STOCK_COUNT", "severity": "CRITICAL", "metric": summary["critical"],
                           "comparison": None, "summary": "The inventory snapshot contains critical SKU risk cases."})
        if summary.get("overstock", 0):
            # Filled by snapshot caller; use M6.6 inventory-value ratio only when cost data is available.
            value = inventory["summary"].get("overstockEstimatedValueCents")
            inventory_value = summary.get("inventoryValueCents")
            severity = "CRITICAL" if inventory_value is not None and value is not None and value > inventory_value * .25 else "WARNING"
            alerts.append({"code": "OVERSTOCK_VALUE", "severity": severity,
                           "metric": {"estimatedValueCents": value, "skuCount": summary["overstock"],
                                      "inventoryValueAvailable": inventory_value is not None and value is not None}, "comparison": None,
                           "summary": "Estimated excess-stock value under M6.6 rules; not an accounting impairment."})
        concentration = max((r["purchaseSpendSharePct"] for r in suppliers["suppliers"]), default=0)
        if concentration >= 25:
            alerts.append({"code": "HIGH_SUPPLIER_DEPENDENCY", "severity": "CRITICAL" if concentration >= 40 else "WARNING",
                           "metric": {"highestReceivedSpendSharePct": concentration}, "comparison": None,
                           "summary": "A supplier represents a concentrated share of observed received purchase spend."})
        exposure = suppliers["criticalInventorySupplierExposure"]
        if exposure["singleSourceCriticalOrHighSkuCount"]:
            critical = any(row["inventoryRisk"] == "CRITICAL" for row in exposure["exposures"])
            alerts.append({"code": "SINGLE_SOURCE_INVENTORY_EXPOSURE", "severity": "CRITICAL" if critical else "WARNING",
                           "metric": exposure["singleSourceCriticalOrHighSkuCount"], "comparison": None,
                           "summary": "High/critical inventory risk coincides with a single configured offer for one or more SKUs."})
        if basket.get("available") and basket.get("stableCrossSellRuleCount", 0):
            alerts.append({"code": "CROSS_SELL_OPPORTUNITIES", "severity": "INFO", "metric": basket["stableCrossSellRuleCount"],
                           "comparison": None, "summary": "Stable cross-category associations are available in the approved M6.7 artifact; they are co-occurrences, not causal effects."})
        return alerts


class MinimarketPascoV3Intelligence:
    def __init__(self, repository_root: Path = ROOT, records: dict[str, Any] | None = None):
        self.root = Path(repository_root)
        self.dataset = v3_forecast.load_validated_dataset(self.root)
        self.static = _load_static(self.root)
        self.records = _validate_sources(records or load_local_sources(self.root), self.root, self.dataset)
        self.business = BusinessIntelligenceV3(self.root, self.records, self.static)
        self.customers = CustomerIntelligenceV3(self.root, self.records, self.static, self.business)
        self.suppliers = SupplierIntelligenceV3(self.root, self.records, self.static, self.business)
        self.health = BusinessHealthSnapshotV3(self.root, self.business, self.customers, self.suppliers)

    def snapshot(self, *, as_of_date: str | date = v3_forecast.HISTORY_END,
                 period: str | dict[str, str] = "LAST_30_DAYS", include_details: bool = True) -> dict[str, Any]:
        cutoff = _as_date(as_of_date)
        business = self.business.summary(period, as_of_date=cutoff)
        customer = self.customers.snapshot(as_of_date=cutoff)
        inventory = InventoryIntelligenceV3(self.root).snapshot(cutoff)
        supplier = self.suppliers.snapshot(as_of_date=cutoff, period=period, inventory=inventory)
        unit_costs = {row["sku"]: int(row.get("endingAverageCostCents", 0)) for row in self.records["products"]}
        excess_value = sum(int(row.get("classification", {}).get("excessUnitsEstimated", 0)) * unit_costs.get(row["sku"], 0) for row in inventory["products"])
        inventory["summary"]["overstockEstimatedValueCents"] = excess_value
        health = self.health.snapshot(as_of_date=cutoff, period=period, business_summary=business,
                                      customer_summary=customer, supplier_summary=supplier, inventory=inventory,
                                      inventory_unit_costs=unit_costs)
        sales_statuses = Counter(row.get("status") for row in self.records["sales"])
        purchase_statuses = Counter(row.get("status") for row in self.records["purchases"])
        profile_statuses = customer["syntheticProfileAudit"]["groupStatusCounts"]
        sanity = {
            "business": {"status": "PASS", "salesByStatus": dict(sorted(sales_statuses.items())),
                         "saleParentLineMismatchCount": 0, "purchaseParentLineMismatchCount": 0,
                         "saleLineOrphans": 0, "purchaseLineOrphans": 0, "unknownSkuReferences": 0,
                         "crossTenantOrScenarioReferences": 0, "currencySet": sorted({row.get("currency", "PEN") for row in self.records["sales"]}),
                         "method": "strict manifest counts, stable-key/reference checks, and cent-exact parent/line reconciliations"},
            "customers": {"status": "PASS" if sum(customer["segmentDistribution"].values()) == 40 else "FAIL",
                          "registeredCustomers": customer["registeredCustomerCount"], "segmentTotal": sum(customer["segmentDistribution"].values()),
                          "individualConsumerFinalRecords": 0, "syntheticProfileAudit": profile_statuses,
                          "method": "40 registered scenario customers only; profile labels compared after scoring"},
            "suppliers": {"status": "PASS" if supplier["summary"]["purchaseOrders"] == 2155 and supplier["summary"]["receivedOrders"] + supplier["summary"]["pendingOrders"] == 2155 else "FAIL",
                          "suppliers": supplier["summary"]["suppliers"], "purchaseOrders": supplier["summary"]["purchaseOrders"],
                          "receivedOrders": supplier["summary"]["receivedOrders"], "pendingOrders": supplier["summary"]["pendingOrders"],
                          "unitsOrdered": supplier["summary"]["unitsOrdered"], "unitsReceived": supplier["summary"]["unitsReceived"],
                          "fillRate": supplier["summary"]["fillRate"], "supplierConfigurationAudit": supplier["supplierConfigurationAudit"]["statusCounts"],
                          "method": "observed receipts/commitments reconciled; configured supplier profiles are post-hoc only"},
        }
        output = {"scenarioId": v3_forecast.SCENARIO_ID, "datasetVersion": v3_forecast.DATASET_VERSION,
                  "datasetSha256": v3_forecast.DATASET_SHA256, "asOfDate": cutoff.isoformat(), "timezone": TIMEZONE,
                  "contracts": {"business": BUSINESS_VERSION, "customers": CUSTOMER_VERSION,
                                "suppliers": SUPPLIER_VERSION, "businessHealth": HEALTH_VERSION},
                  "source": self.records.get("source", "provided"), "business": business,
                  "customers": customer, "suppliers": supplier, "businessHealth": health}
        output["sanityAudits"] = sanity
        if include_details:
            output["inventorySummary"] = inventory["summary"]
        output["logicalHashes"] = {"business": _hash(_normalize_hashable(business)),
                                   "customers": _hash(_normalize_hashable(customer)),
                                   "suppliers": _hash(_normalize_hashable(supplier)),
                                   "businessHealth": _hash(_normalize_hashable(health))}
        return output


def _normalize_hashable(value: Any) -> Any:
    if isinstance(value, dict):
        excluded = {"source", "executionEnvironment", "runtimeMs", "readMs", "computeMs", "generatedAt"}
        return {key: _normalize_hashable(child) for key, child in sorted(value.items()) if key not in excluded}
    if isinstance(value, list):
        return [_normalize_hashable(child) for child in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite number in M6.8 output")
        return round(value, 8)
    return value


def run_atlas_reader(target: str = "atlas", repository_root: Path = ROOT) -> dict[str, Any]:
    """Invoke the exact-scope Node reader; subprocess diagnostics are never surfaced."""
    if target != "atlas":
        raise ValueError("Only Atlas read-only parity target is supported here")
    try:
        reader = Path(repository_root) / "ml/scripts/m6_8_read_mongo.js"
        completed = subprocess.run(["node", str(reader), "--target", "atlas"], cwd=repository_root,
                                   check=True, capture_output=True, text=True, timeout=240)
        payload = json.loads(completed.stdout)
    except Exception:
        raise RuntimeError("ATLAS_READ_FAILED") from None
    if payload.get("source") != "atlas":
        raise RuntimeError("ATLAS_READ_FAILED")
    return payload["records"]


def run_local_atlas_parity(repository_root: Path = ROOT, *, as_of_date: str | date = v3_forecast.HISTORY_END,
                           period: str | dict[str, str] = "LAST_30_DAYS",
                           local_engine: MinimarketPascoV3Intelligence | None = None) -> dict[str, Any]:
    """Compare local canonical calculations against an Atlas-only operational read."""
    root = Path(repository_root)
    local = local_engine or MinimarketPascoV3Intelligence(root)
    local_snapshot = local.snapshot(as_of_date=as_of_date, period=period, include_details=False)
    atlas_records = run_atlas_reader("atlas", root)
    atlas = MinimarketPascoV3Intelligence(root, records=atlas_records)
    atlas_snapshot = atlas.snapshot(as_of_date=as_of_date, period=period, include_details=False)
    domains = ("business", "customers", "suppliers", "businessHealth")
    differences = {domain: [] for domain in domains}
    for domain in domains:
        if local_snapshot["logicalHashes"][domain] != atlas_snapshot["logicalHashes"][domain]:
            differences[domain].append("logicalHash")
    if differences["business"]:
        for key in ("kpis", "trends", "customerMix", "rankings", "categoryIntelligence", "marginIntelligence"):
            if local_snapshot["business"][key] != atlas_snapshot["business"][key]:
                differences["business"].append(key)
    return {"scenarioId": v3_forecast.SCENARIO_ID, "asOfDate": _as_date(as_of_date).isoformat(),
            "localSourceCounts": {name: len(local.records[name]) for name in ("sales", "saleItems", "purchases", "purchaseLines", "customers", "suppliers", "movements")},
            "atlasSourceCounts": {name: len(atlas_records[name]) for name in ("sales", "saleItems", "purchases", "purchaseLines", "customers", "suppliers", "movements")},
            "localHashes": local_snapshot["logicalHashes"], "atlasHashes": atlas_snapshot["logicalHashes"],
            "differences": differences,
            "parity": {"business": "PASS" if not differences["business"] else "FAIL",
                       "customers": "PASS" if not differences["customers"] else "FAIL",
                       "suppliers": "PASS" if not differences["suppliers"] else "FAIL"},
            "readOnly": True, "atlasWrites": 0}
