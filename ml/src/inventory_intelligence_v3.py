"""Deterministic, local-only M6.6 inventory intelligence for canonical Pasco V3."""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import mean, pstdev, stdev
from typing import Any, Iterable

from ml.src import v3_baseline_bundle as forecast_bundle
from ml.src import v3_forecast as forecast_v3

SERVICE_Z = 1.28  # M6.1 heuristic ~90%; not a calibrated service guarantee.
REVIEW_DAYS = 7  # one weekly replenishment review cycle, visible policy parameter
XYZ_WEEKS = 13
MIN_XYZ_WEEKS = 8
MIN_WEEK_AVAILABILITY_DAYS = 5
MIN_COVERAGE_RATIO = 0.80
MIN_LEAD_RECEIPTS = 5
EPSILON = 1e-9
RISK_RANK = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
INVENTORY_VERSION = "MINIMARKET-PASCO-V3-INVENTORY-v1"


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_ndjson(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def _as_date(value: str | date | None) -> date | None:
    if value is None:
        return None
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


def _ceil_multiple(quantity: float, multiple: int) -> int:
    if quantity <= 0:
        return 0
    return int(math.ceil(quantity / multiple) * multiple)


def _estimate_excess_units(*, inventory_position: int, expected_daily: float, safety_stock: int,
                           lead_time_days: float, perishable: bool, shelf_life_days: int | None) -> tuple[float | None, int]:
    """Estimate excess against observable demand coverage, never a fixed stock count."""
    if perishable and shelf_life_days:
        threshold = max(0.0, expected_daily) * shelf_life_days
    else:
        threshold_days = max(30.0, 2 * (max(0.0, lead_time_days) + REVIEW_DAYS))
        threshold = max(0.0, expected_daily) * threshold_days + max(0, safety_stock)
    return threshold, max(0, math.ceil(inventory_position - threshold))


def _purchase_line_as_of(purchase: dict[str, Any], line: dict[str, Any], cutoff: date) -> dict[str, Any]:
    """Reconstruct purchase-line receipt/inbound from dates, not its final status."""
    ordered = _as_date(purchase.get("orderedLocalDate"))
    if ordered is None or ordered > cutoff or purchase.get("status") == "cancelled" or line.get("status") == "cancelled":
        return {"remainingUnits": 0, "incomingUnits": 0, "overdueOrUnknownUnits": 0, "receivedByCutoff": False}
    received_date = _as_date(purchase.get("receivedLocalDate"))
    received_by_cutoff = received_date is not None and received_date <= cutoff
    received_units = int(line.get("quantityReceived", 0)) if received_by_cutoff else 0
    remaining = max(0, int(line.get("quantityOrdered", 0)) - received_units)
    if remaining <= 0:
        return {"remainingUnits": 0, "incomingUnits": 0, "overdueOrUnknownUnits": 0,
                "receivedByCutoff": received_by_cutoff}
    promised = _as_date(purchase.get("promisedLocalDate"))
    incoming = remaining if promised is not None and promised > cutoff else 0
    overdue_or_unknown = remaining if incoming == 0 else 0
    return {"remainingUnits": remaining, "incomingUnits": incoming,
            "overdueOrUnknownUnits": overdue_or_unknown, "receivedByCutoff": received_by_cutoff}


def _abc_classes(consumption_value_cents: dict[str, int]) -> dict[str, dict[str, Any]]:
    total = sum(max(0, int(value)) for value in consumption_value_cents.values())
    result: dict[str, dict[str, Any]] = {}
    if total <= 0:
        return {sku: {"abc": "UNCLASSIFIED", "consumptionValueCents": 0, "cumulativeValueShare": None}
                for sku in sorted(consumption_value_cents)}
    running = 0
    for sku, value in sorted(consumption_value_cents.items(), key=lambda item: (-item[1], item[0])):
        running += max(0, int(value))
        share = running / total
        # The SKU that reaches/crosses a cumulative boundary belongs to that class.
        group = "A" if (running - max(0, int(value))) / total < 0.80 else "B" if (running - max(0, int(value))) / total < 0.95 else "C"
        result[sku] = {"abc": group, "consumptionValueCents": int(value), "cumulativeValueShare": share}
    return result


def _xyz(weekly_units: list[float]) -> dict[str, Any]:
    if len(weekly_units) < MIN_XYZ_WEEKS:
        return {"xyz": "Z", "status": "INSUFFICIENT_HISTORY", "cv": None,
                "weeksObserved": len(weekly_units), "zeroSalesWeeks": sum(value == 0 for value in weekly_units)}
    average = mean(weekly_units)
    zeros = sum(value == 0 for value in weekly_units)
    if average <= EPSILON:
        return {"xyz": "Z", "status": "NO_MOVEMENT", "cv": None,
                "weeksObserved": len(weekly_units), "zeroSalesWeeks": zeros}
    cv = pstdev(weekly_units) / average
    group = "X" if cv <= 0.5 else "Y" if cv <= 1.0 else "Z"
    return {"xyz": group, "status": "CLASSIFIED", "cv": cv,
            "weeksObserved": len(weekly_units), "zeroSalesWeeks": zeros}


def _ridge_lead_time_reason(days) -> str | None:
    if days is None:
        return "MISSING_LEAD_TIME"
    if (isinstance(days, bool) or not isinstance(days, (int, float))
            or not math.isfinite(days) or days <= 0):
        return "INVALID_LEAD_TIME"
    return "LEAD_TIME_BEYOND_APPROVED_HORIZON" if days > 14 else None


def _forecast_demand_until(days: float, forecast: dict[str, float], *, ridge_live: bool = False) -> tuple[float | None, bool]:
    """LIVE uses the operational Ridge 7/14 mean rate, only for 0 < L <= 14.

    This is a rate approximation for inventory policy, not an L-day ML forecast
    or an interpolated daily curve. The historical forecast path is unchanged.
    """
    if ridge_live:
        if _ridge_lead_time_reason(days) is not None:
            return None, False
        p7, p14 = forecast.get("expectedUnitsNext7d"), forecast.get("expectedUnitsNext14d")
        if (any(isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or value < 0 for value in (p7, p14)) or p14 < p7):
            return None, False
        mu = (p7 / 7 + p14 / 14) / 2
        return mu * days, False
    if days <= 0:
        return 0.0, False
    p1 = float(forecast["expectedUnitsNext1d"])
    p7 = float(forecast["expectedUnitsNext7d"])
    p14 = float(forecast["expectedUnitsNext14d"])
    if days <= 1:
        return p1 * days, False
    if days <= 7:
        return p1 + (p7 - p1) * ((days - 1) / 6), False
    if days <= 14:
        return p7 + (p14 - p7) * ((days - 7) / 7), False
    return p14, True


def _days_to_depletion(on_hand: float, daily_demand: float, incoming: list[dict[str, Any]], cutoff: date) -> float | None:
    if daily_demand <= EPSILON:
        return None
    balance = max(0.0, float(on_hand))
    elapsed = 0.0
    for order in sorted(incoming, key=lambda item: (item["expectedReceiptDate"], item["supplierCode"])):
        receipt = _as_date(order["expectedReceiptDate"])
        if receipt is None or receipt <= cutoff:
            continue
        arrival = float((receipt - cutoff).days)
        days_left = balance / daily_demand
        if arrival > elapsed + days_left + EPSILON:
            return elapsed + days_left
        balance = max(0.0, balance - daily_demand * (arrival - elapsed))
        elapsed = arrival
        balance += float(order["units"])
    return elapsed + balance / daily_demand


def evaluate_sku(
    *, product: dict[str, Any], forecast: dict[str, Any], daily_rows: list[dict[str, Any]],
    on_hand: int, incoming_orders: list[dict[str, Any]], cutoff: date,
    lead_time_days: float, configured_lead_time_days: float, lead_time_std_days: float,
    lead_time_source: str, lead_time_sample_size: int,
    supplier: dict[str, Any] | None, active_offers: list[dict[str, Any]],
    pack_multiple: int, min_order_qty: int, consumption_value: dict[str, Any], ridge_live: bool = False,
) -> dict[str, Any]:
    """Evaluate one SKU. Inputs are already tenant/scenario scoped and immutable."""
    sku = str(product["sku"])
    history = sorted((row for row in daily_rows if row["localDate"] <= cutoff.isoformat()), key=lambda row: row["localDate"])
    last_28 = history[-28:]
    observable = [float(row["unitsSold"]) for row in last_28
                  if float(row.get("availableHours", 0)) > 0 and int(row.get("onHandUsableAtOrigin", 0)) > 0]
    sigma_demand = pstdev(observable) if len(observable) >= 14 else 0.0
    expected_daily = (float(forecast["expectedUnitsNext7d"]) / 7 + float(forecast["expectedUnitsNext14d"]) / 14) / 2
    low_or_no_demand = expected_daily <= EPSILON
    recent_flags = [float(row.get("availableHours", 0)) > 0 and int(row.get("onHandUsableAtOrigin", 0)) > 0 for row in history]
    last30 = history[-30:]
    last60 = history[-60:]
    last30_available = sum(float(row.get("availableHours", 0)) > 0 and int(row.get("onHandUsableAtOrigin", 0)) > 0 for row in last30)
    last60_available = sum(float(row.get("availableHours", 0)) > 0 and int(row.get("onHandUsableAtOrigin", 0)) > 0 for row in last60)
    last30_sale_days = sum(int(row["unitsSold"]) > 0 for row in last30)
    last60_sold = sum(int(row["unitsSold"]) for row in last60)
    last_sale = next((row["localDate"] for row in reversed(history) if int(row["unitsSold"]) > 0), None)
    days_since_sale = (cutoff - date.fromisoformat(last_sale)).days if last_sale else None
    exposure_days = sum(recent_flags[-28:])
    product_age = len(history)
    slow = (product_age >= 60 and len(last30) == 30 and last30_available / 30 >= MIN_COVERAGE_RATIO
            and 0 < last30_sale_days <= 4)
    dead = (int(on_hand) > 0 and len(last60) == 60 and last60_available / 60 >= MIN_COVERAGE_RATIO
            and last60_sold == 0)

    weekly: dict[str, list[float | None]] = defaultdict(list)
    first_week = cutoff - timedelta(days=cutoff.weekday() + 7 * (XYZ_WEEKS - 1))
    for row in history:
        day = date.fromisoformat(row["localDate"])
        if day < first_week or day >= cutoff:
            continue
        monday = day - timedelta(days=day.weekday())
        weekly[monday.isoformat()].append(float(row["unitsSold"]) if float(row.get("availableHours", 0)) > 0 and int(row.get("onHandUsableAtOrigin", 0)) > 0 else None)
    # The cutoff is a Monday in the scenario. Use the 13 completed Monday-Sunday weeks.
    weeks: list[float] = []
    for offset in range(XYZ_WEEKS):
        week_start = first_week + timedelta(days=7 * offset)
        values = weekly.get(week_start.isoformat(), [])
        available_values = [value for value in values if value is not None]
        if len(available_values) >= MIN_WEEK_AVAILABILITY_DAYS:
            weeks.append(sum(available_values) * 7 / len(available_values))
    xyz = _xyz(weeks)

    daily_forecast = max(0.0, expected_daily)
    incoming_units = sum(int(order["units"]) for order in incoming_orders)
    position = int(on_hand) + incoming_units
    cover = int(on_hand) / daily_forecast if daily_forecast > EPSILON else None
    effective_depletion_days = _days_to_depletion(on_hand, daily_forecast, incoming_orders, cutoff)
    lead_reason = _ridge_lead_time_reason(lead_time_days) if ridge_live else None
    if ridge_live:
        lead = float(lead_time_days) if lead_reason in (None, "LEAD_TIME_BEYOND_APPROVED_HORIZON") else 0.0
    else:
        lead = max(0.0, float(lead_time_days))
    review = float(REVIEW_DAYS)
    horizon_days = lead_time_days if ridge_live else min(lead, 14.0)
    demand_during_lead, truncated_lead_forecast = _forecast_demand_until(horizon_days, forecast, ridge_live=ridge_live)
    lead_demand_available = demand_during_lead is not None
    reasons: list[str] = []
    if low_or_no_demand and lead_demand_available:
        safety_raw = 0.0
        safety_stock = 0
        reorder_raw = 0.0
        reorder_point = 0
        target_raw = 0.0
        target_stock = 0
        should_reorder = False
        recommended_qty = 0
        reasons.append("LOW_DEMAND")
    elif lead_demand_available:
        safety_raw = SERVICE_Z * math.sqrt(lead * sigma_demand**2 + expected_daily**2 * max(0.0, lead_time_std_days)**2)
        safety_stock = max(1, math.ceil(safety_raw))
        reorder_raw = demand_during_lead + safety_stock
        reorder_point = math.ceil(reorder_raw)
        target_raw = demand_during_lead + daily_forecast * review + safety_stock
        target_stock = math.ceil(target_raw)
        should_reorder = position <= reorder_point
        required = max(0.0, target_raw - position)
        rounded = _ceil_multiple(max(required, min_order_qty), pack_multiple) if required > 0 else 0
        cap = None
        if product.get("perishable") and product.get("shelfLifeDays"):
            life_demand = daily_forecast * float(product["shelfLifeDays"])
            cap = _ceil_multiple(max(min_order_qty, life_demand), pack_multiple)
            if rounded > cap:
                rounded = cap
                reasons.append("PERISHABLE_CAP")
        recommended_qty = int(rounded)
        if should_reorder:
            reasons.append("BELOW_REORDER_POINT")
        if incoming_units <= 0:
            reasons.append("NO_INBOUND")
        if incoming_units > 0 and effective_depletion_days is not None and effective_depletion_days < lead:
            reasons.append("INBOUND_INSUFFICIENT")
        if effective_depletion_days is not None and effective_depletion_days < lead:
            reasons.append("COVER_BELOW_LEAD_TIME")
        if truncated_lead_forecast:
            reasons.append("LEAD_TIME_EXCEEDS_FORECAST_HORIZON")
        if len(observable) < 14:
            reasons.append("INSUFFICIENT_DEMAND_VARIABILITY_HISTORY")
    else:
        safety_raw = safety_stock = reorder_raw = reorder_point = target_raw = target_stock = None
        should_reorder = recommended_qty = None
        reasons.append((lead_reason or "INSUFFICIENT_FORECAST_INPUTS") if ridge_live else
                       "UNSUPPORTED_LEAD_TIME" if lead > 0 else "INSUFFICIENT_FORECAST_INPUTS")

    minimum = int(product.get("minStockInitial", 0))
    low_stock = int(on_hand) <= minimum
    if low_stock:
        reasons.append("LOW_STOCK")
    days_for_risk = effective_depletion_days
    if low_or_no_demand and lead_demand_available:
        risk = "LOW"
        risk_reason = "no material expected demand in approved forecast horizons"
        coverage_status = "LOW_OR_NO_RECENT_DEMAND"
    elif lead_demand_available:
        coverage_status = "APPROXIMATE_7_14D_MEAN"
        if int(on_hand) <= 0 or (days_for_risk is not None and days_for_risk <= 1):
            risk = "CRITICAL"
            risk_reason = "on-hand is empty or expected depletion is within one day"
        elif days_for_risk is not None and days_for_risk < lead:
            risk = "HIGH"
            risk_reason = "expected depletion precedes preferred-supplier lead time"
        elif should_reorder or (cover is not None and cover < lead + review):
            risk = "MEDIUM"
            risk_reason = "inventory is at/below reorder point or cover is inside lead time plus review cycle"
        else:
            risk = "LOW"
            risk_reason = "on-hand cover exceeds lead time plus review cycle"
    else:
        risk = None
        risk_reason = None
        coverage_status = "APPROXIMATE_7_14D_MEAN"

    abc = consumption_value["abc"]
    matrix = f"{abc}-{xyz['xyz']}" if abc in {"A", "B", "C"} else "UNCLASSIFIED"
    annual_value = int(consumption_value["consumptionValueCents"])
    lead_demand_raw, lead_clipped = _forecast_demand_until(horizon_days, forecast, ridge_live=ridge_live)
    configured_supplier_name = (supplier or {}).get("displayName")
    expected_arrival = (cutoff + timedelta(days=math.ceil(lead))).isoformat() if lead > 0 else cutoff.isoformat()
    offer_suppliers = sorted({str(offer["supplierCode"]) for offer in active_offers})
    critical = abc == "A" or risk in {"CRITICAL", "HIGH"}
    if critical and len(offer_suppliers) == 1:
        reasons.append("SINGLE_SOURCE")
    if slow:
        reasons.append("SLOW_MOVING")
    if dead:
        reasons.append("DEAD_STOCK")

    return {
        "sku": sku, "productName": product["name"], "productKey": product["productKey"], "categoryCode": product["categoryCode"],
        "asOfDate": cutoff.isoformat(), "currency": product.get("currency", "PEN"),
        "stock": {"onHand": int(on_hand), "incoming": incoming_units, "inventoryPosition": position,
                  "pendingOrders": list(incoming_orders), "overdueOrUnknownExpectedArrivalUnits": 0},
        "forecast": {"source": "RIDGE_CAUSAL27" if ridge_live else "MOVING_AVERAGE_28",
                     "strategyVersion": "RIDGE-CAUSAL27" if ridge_live else forecast_bundle.STRATEGY_VERSION,
                     "modelVersion7": forecast.get("modelVersion7"), "modelVersion14": forecast.get("modelVersion14"),
                     "cutoffDate": forecast["cutoffDate"], "expected1d": forecast.get("expectedUnitsNext1d"),
                     "expected7d": forecast["expectedUnitsNext7d"], "expected14d": forecast["expectedUnitsNext14d"]},
        "demand": {"expectedDaily": daily_forecast,
                   "source": "APPROXIMATE_RATE_FROM_RIDGE_7_14" if ridge_live else "MOVING_AVERAGE_28",
                   "rule": "mean(expectedUnitsNext7d/7, expectedUnitsNext14d/14)",
                   "sigmaDailyLast28Observable": sigma_demand, "observableDaysLast28": len(observable),
                   "exposureDaysLast28": exposure_days, "validLeadTimeDemand": lead_demand_raw,
                   **({"leadTimeDemandRule": "expectedDaily * leadTimeDays; 0 < leadTimeDays <= 14",
                       "leadTimeDemandInterpretation": "aproximación operacional derivada de los pronósticos Ridge 7d/14d"}
                      if ridge_live else {}),
                   "leadTimeDemandClippedTo14d": lead_clipped},
        "supplier": {"preferredSupplierCode": product.get("preferredSupplierCode"), "preferredSupplier": configured_supplier_name,
                     "leadTimeDays": lead, "configuredLeadTimeDays": configured_lead_time_days,
                     "historicalLeadTime": {"meanDays": lead if lead_time_source.startswith("OBSERVED") else None,
                                             "sampleSize": lead_time_sample_size, "stdDays": lead_time_std_days if lead_time_source.startswith("OBSERVED") else None},
                     "leadTimeSource": lead_time_source, "alternatives": [offer for offer in active_offers
                     if offer["supplierCode"] != product.get("preferredSupplierCode")],
                     "activeOfferCount": len(active_offers), "dependencyStatus": "SINGLE_SOURCE" if len(active_offers) == 1 else "MULTI_SOURCE" if active_offers else "NO_ACTIVE_OFFER"},
        "inventoryPolicy": {"serviceLevelHeuristic": 0.90, "z": SERVICE_Z, "reviewDays": REVIEW_DAYS,
                            "safetyStockRaw": safety_raw, "safetyStock": safety_stock,
                            "expectedDemandDuringLeadTime": demand_during_lead, "reorderPointRaw": reorder_raw,
                            "reorderPoint": reorder_point, "targetStockRaw": target_raw, "targetStock": target_stock,
                            "configuredMinimumStock": minimum},
        "risk": {"level": risk, "reason": risk_reason, "reasonCodes": list(dict.fromkeys(reasons)),
                 "status": "AVAILABLE" if risk is not None else "PARTIAL",
                 "approxDaysToDepletionWithKnownInbound": days_for_risk, "isProbability": False,
                 "lowStock": low_stock, "lowStockSeparateFromRisk": True,
                 "projectedStockoutDate": None, "projectedStockoutDateStatus": "UNAVAILABLE_NO_APPROVED_DAILY_CURVE"},
        "coverage": {"daysCover": cover, "status": coverage_status},
        "recommendation": {"shouldReorder": should_reorder, "recommendedQty": recommended_qty,
                            "status": "AVAILABLE" if recommended_qty is not None else "PARTIAL",
                            "targetStock": target_stock, "packMultiple": pack_multiple, "minOrderQty": min_order_qty,
                            "expectedReceiptDate": expected_arrival
                                if recommended_qty is not None and recommended_qty > 0 else None,
                            "quantityIsIntegerAndPackAdjusted": True},
        "classification": {"abc": abc, "abcValueCents": annual_value,
                           "abcCumulativeValueShare": consumption_value["cumulativeValueShare"],
                           "xyz": xyz["xyz"], "xyzStatus": xyz["status"], "xyzCv": xyz["cv"],
                           "xyzWeeksObserved": xyz["weeksObserved"], "xyzZeroSalesWeeks": xyz["zeroSalesWeeks"],
                           "abcXyz": matrix, "productObservableAgeDays": product_age,
                           "daysSinceLastSale": days_since_sale, "availableDays30": last30_available,
                           "availableDays60": last60_available, "saleDays30": last30_sale_days,
                           "unitsSold60": last60_sold, "slowMoving": slow, "deadStock": dead,
                           "lowStock": low_stock, "overstock": False, "excessUnitsEstimated": 0},
        "evidence": {"snapshotSource": "V3 scenario ledger and approved product-day package", "noSyntheticLatentDemand": True,
                     "reservationData": "not present in canonical scenario", "forecastContract": forecast["status"]},
    }


def rank_products(rows: list[dict[str, Any]], ranking: str) -> list[dict[str, Any]]:
    """Named, stable read-only ranking queries for later assistant integration."""
    selectors = {
        "stockout_risk": lambda r: (RISK_RANK[r["risk"]["level"]], r["risk"]["approxDaysToDepletionWithKnownInbound"] if r["risk"]["approxDaysToDepletionWithKnownInbound"] is not None else math.inf, r["sku"]),
        "low_stock": lambda r: (not r["risk"]["lowStock"], r["stock"]["onHand"] - r["inventoryPolicy"]["configuredMinimumStock"], r["sku"]),
        "overstock": lambda r: (-r["classification"]["excessUnitsEstimated"], r["sku"]),
        "slow_moving": lambda r: (not r["classification"]["slowMoving"], -(r["classification"]["daysSinceLastSale"] or 0), r["sku"]),
        "abc_a": lambda r: (r["classification"]["abc"] != "A", -r["classification"]["abcValueCents"], r["sku"]),
        "az": lambda r: (r["classification"]["abcXyz"] != "A-Z", -r["classification"]["abcValueCents"], r["sku"]),
        "single_source_critical": lambda r: ("SINGLE_SOURCE" not in r["risk"]["reasonCodes"], RISK_RANK[r["risk"]["level"]], r["sku"]),
        "reorder": lambda r: (not r["recommendation"]["shouldReorder"], RISK_RANK[r["risk"]["level"]], -r["recommendation"]["recommendedQty"], r["sku"]),
    }
    if ranking not in selectors:
        raise ValueError(f"Unknown inventory ranking: {ranking}")
    return sorted(rows, key=selectors[ranking])


class InventoryIntelligenceV3:
    def __init__(self, repository_root: Path, dataset: forecast_v3.V3Dataset | None = None,
                 operational_records: dict[str, Any] | None = None,
                 static_data: dict[str, Any] | None = None):
        self.root = Path(repository_root)
        self.generated = self.root / "data/minimarket-pasco-v3/generated"
        self.definitions = self.root / "data/minimarket-pasco-v3"
        self.dataset = dataset
        self.operational_records = operational_records
        self.static_data = static_data
        if operational_records is not None:
            self._validate_operational_records(operational_records)

    def snapshot(self, as_of_date: date = forecast_v3.HISTORY_END,
                 operational_records: dict[str, Any] | None = None) -> dict[str, Any]:
        cutoff = _as_date(as_of_date)
        first = forecast_v3.HISTORY_START
        manifest = self.dataset.manifest if self.dataset is not None else _read_json(self.generated / "manifest.json")
        if (manifest.get("scenarioId") != forecast_v3.SCENARIO_ID
                or manifest.get("hashes", {}).get("logicalDatasetSha256") != forecast_v3.DATASET_SHA256):
            raise ValueError("Canonical V3 scenario/dataset contract mismatch")
        if cutoff is None or not first <= cutoff <= forecast_v3.HISTORY_END:
            raise ValueError("asOfDate must be within the canonical V3 history")
        dataset = self.dataset or forecast_v3.load_validated_dataset(self.root)
        records = operational_records if operational_records is not None else self.operational_records
        if records is None:
            products = {row["sku"]: row for row in _read_ndjson(self.generated / "products.ndjson")}
            movement_rows = _read_ndjson(self.generated / "inventory-movements.ndjson")
            purchase_rows = _read_ndjson(self.generated / "purchases.ndjson")
            purchase_lines = _read_ndjson(self.generated / "purchase-items.ndjson")
        else:
            if records is not self.operational_records:
                self._validate_operational_records(records)
            products = {row["sku"]: row for row in records["products"]}
            movement_rows = records["movements"]
            purchase_rows = records["purchases"]
            purchase_lines = records["purchaseLines"]
        if self.static_data is None:
            product_definitions = {row["sku"]: row for row in _read_json(self.definitions / "products.json")["catalog"]}
            suppliers = {row["supplierCode"]: row for row in _read_json(self.definitions / "suppliers.json")["suppliers"]}
            offer_defs = _read_json(self.definitions / "supplier-offers.json")
        else:
            product_definitions = {row["sku"]: row for row in self.static_data["products"]}
            suppliers = {row["supplierCode"]: row for row in self.static_data["suppliers"]}
            offer_defs = self.static_data["offers"]
        offers_by_sku: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for product in product_definitions.values():
            code = product["preferredSupplierCode"]
            offers_by_sku[product["sku"]].append({"supplierCode": code, "supplierName": suppliers[code]["displayName"], "preferred": True, "configuredLeadTimeDays": product["leadTimeDays"]})
        for item in offer_defs.get("secondaryAssignments", []):
            sku, code = item["sku"], item["supplierCode"]
            offers_by_sku[sku].append({"supplierCode": code, "supplierName": suppliers[code]["displayName"], "preferred": False,
                                       "configuredLeadTimeDays": suppliers[code]["leadTimeMeanDays"]})

        daily_by_sku: dict[str, list[dict[str, Any]]] = defaultdict(list)
        if dataset is not None:
            for sku, series in dataset.daily_by_sku.items():
                daily_by_sku[sku].extend(row for row in series if row["localDate"] <= cutoff.isoformat())
        else:
            for row in _read_ndjson(self.generated / "product-daily.ndjson"):
                if row["localDate"] <= cutoff.isoformat():
                    daily_by_sku[row["sku"]].append(row)
        movements: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in movement_rows:
            if row["localDate"] <= cutoff.isoformat():
                movements[row["sku"]].append(row)
        stock_by_sku = {}
        for sku, rows in movements.items():
            latest = max(rows, key=lambda row: (row["localDate"], row["occurredAt"], row.get("eventPriority", 0), row["movementCode"]))
            stock_by_sku[sku] = int(latest["stockAfter"])
        purchase_by_code = {row["purchaseCode"]: row for row in purchase_rows}
        actual_leads: dict[tuple[str, str], list[float]] = defaultdict(list)
        supplier_leads: dict[str, list[float]] = defaultdict(list)
        inbound: dict[str, list[dict[str, Any]]] = defaultdict(list)
        overdue_or_unknown_by_sku: dict[str, int] = defaultdict(int)
        for line in purchase_lines:
            purchase = purchase_by_code.get(line["purchaseCode"])
            if not purchase:
                continue
            received_date = purchase.get("receivedLocalDate")
            as_of_line = _purchase_line_as_of(purchase, line, cutoff)
            if (line.get("status") == "received" and as_of_line["receivedByCutoff"]
                    and received_date and int(line.get("quantityReceived", 0)) > 0):
                actual = (date.fromisoformat(received_date) - date.fromisoformat(purchase["orderedLocalDate"])).days
                if actual >= 0:
                    actual_leads[(line["sku"], line["supplierCode"])].append(float(actual))
                    supplier_leads[line["supplierCode"]].append(float(actual))
            if as_of_line["incomingUnits"] > 0:
                inbound[line["sku"]].append({"purchaseCode": line["purchaseCode"], "units": as_of_line["incomingUnits"],
                                              "expectedReceiptDate": purchase["promisedLocalDate"], "supplierCode": line["supplierCode"],
                                              "isReceived": False})
            overdue_or_unknown_by_sku[line["sku"]] += as_of_line["overdueOrUnknownUnits"]

        cost_value: dict[str, int] = defaultdict(int)
        for sku, rows in daily_by_sku.items():
            for row in rows:
                cost = row.get("effectiveUnitCostAtSale")
                if cost is not None:
                    cost_value[sku] += int(row["unitsSold"]) * int(cost)
        abc_by_sku = _abc_classes({sku: cost_value.get(sku, 0) for sku in product_definitions})

        snapshot_rows: list[dict[str, Any]] = []
        sku_order = sorted(product_definitions)
        forecast_rows = forecast_bundle.predict_many(dataset, skus=sku_order, cutoff=cutoff)
        forecasts_by_sku = {row["sku"]: row for row in forecast_rows}
        for sku, definition in sorted(product_definitions.items()):
            if sku not in stock_by_sku:
                raise ValueError(f"Canonical V3 stock ledger missing SKU {sku}")
            item_forecast = forecasts_by_sku[sku]
            if item_forecast["status"] != "READY" or any(item_forecast.get(f"expectedUnitsNext{h}d") is None for h in (1, 7, 14)):
                raise ValueError(f"Approved V3 forecast unavailable for {sku} at {cutoff}")
            preferred = definition["preferredSupplierCode"]
            pair = actual_leads.get((sku, preferred), [])
            by_supplier = supplier_leads.get(preferred, [])
            if len(pair) >= MIN_LEAD_RECEIPTS:
                lead, lead_std, lead_n, lead_source = mean(pair), stdev(pair), len(pair), "OBSERVED_PRODUCT_SUPPLIER"
            elif len(by_supplier) >= MIN_LEAD_RECEIPTS:
                lead, lead_std, lead_n, lead_source = mean(by_supplier), stdev(by_supplier), len(by_supplier), "OBSERVED_SUPPLIER_AGGREGATE"
            else:
                supplier = suppliers[preferred]
                lead, lead_std = float(definition["leadTimeDays"]), float(supplier.get("leadTimeStdDays", 0))
                lead_n, lead_source = len(pair), "PRODUCT_CONFIG_AND_SUPPLIER_DEMO_VARIABILITY"
            offer_rows = offers_by_sku.get(sku, [])
            configured_multiple = offer_defs.get("packMultipleBySupplier", {})
            multiple = int(configured_multiple.get(f"{preferred}:{sku}", configured_multiple.get(preferred, 1)))
            row = evaluate_sku(product=definition, forecast=item_forecast, daily_rows=daily_by_sku[sku],
                               on_hand=stock_by_sku[sku], incoming_orders=inbound[sku], cutoff=cutoff,
                               lead_time_days=lead, configured_lead_time_days=float(definition["leadTimeDays"]),
                               lead_time_std_days=lead_std, lead_time_source=lead_source, lead_time_sample_size=lead_n,
                               supplier=suppliers[preferred], active_offers=offer_rows, pack_multiple=multiple,
                               min_order_qty=1, consumption_value=abc_by_sku[sku])
            # Confirm current as-of movement stock reconciles to the generated daily/snapshot stock at reference date.
            if cutoff == forecast_v3.HISTORY_END and row["stock"]["onHand"] != int(products[sku]["endingStock"]):
                raise ValueError(f"Inventory ledger does not reconcile to canonical ending stock for {sku}")
            lead_overdue_units = overdue_or_unknown_by_sku[sku]
            row["stock"]["overdueOrUnknownExpectedArrivalUnits"] = lead_overdue_units

            classification = row["classification"]
            active_days_28 = len([d for d in daily_by_sku[sku][-28:] if float(d.get("availableHours", 0)) > 0 and int(d.get("onHandUsableAtOrigin", 0)) > 0])
            row["demand"]["meanLast28Observable"] = mean([int(d["unitsSold"]) for d in daily_by_sku[sku][-28:] if float(d.get("availableHours", 0)) > 0 and int(d.get("onHandUsableAtOrigin", 0)) > 0]) if active_days_28 else None
            if row["classification"]["abc"] in {"A", "B", "C"}:
                xyz_tag = row["classification"]["xyz"]
            else:
                xyz_tag = "Z"
            row["classification"]["abcXyz"] = f"{row['classification']['abc']}-{xyz_tag}" if row["classification"]["abc"] in {"A", "B", "C"} else "UNCLASSIFIED"
            if definition.get("perishable") and definition.get("shelfLifeDays"):
                limit, excess = _estimate_excess_units(inventory_position=row["stock"]["inventoryPosition"],
                    expected_daily=row["demand"]["expectedDaily"], safety_stock=row["inventoryPolicy"]["safetyStock"],
                    lead_time_days=lead, perishable=True, shelf_life_days=int(definition["shelfLifeDays"]))
                row["classification"]["overstockThresholdUnits"] = limit
                row["classification"]["excessUnitsEstimated"] = excess
            else:
                cover_threshold = max(30.0, 2 * (lead + REVIEW_DAYS))
                threshold, excess = _estimate_excess_units(inventory_position=row["stock"]["inventoryPosition"],
                    expected_daily=row["demand"]["expectedDaily"], safety_stock=row["inventoryPolicy"]["safetyStock"],
                    lead_time_days=lead, perishable=False, shelf_life_days=None)
                row["classification"]["overstockThresholdDaysCover"] = cover_threshold
                row["classification"]["excessUnitsEstimated"] = excess
            row["classification"]["overstock"] = row["classification"]["excessUnitsEstimated"] > 0
            if row["classification"]["overstock"]:
                row["risk"]["reasonCodes"].append("OVERSTOCK")
            snapshot_rows.append(row)

        pending_orders = {order["purchaseCode"] for row in snapshot_rows for order in row["stock"]["pendingOrders"]}
        totals = {"products": len(snapshot_rows), "critical": sum(r["risk"]["level"] == "CRITICAL" for r in snapshot_rows),
                  "high": sum(r["risk"]["level"] == "HIGH" for r in snapshot_rows), "medium": sum(r["risk"]["level"] == "MEDIUM" for r in snapshot_rows),
                  "low": sum(r["risk"]["level"] == "LOW" for r in snapshot_rows), "lowStock": sum(r["risk"]["lowStock"] for r in snapshot_rows),
                  "overstock": sum(r["classification"]["overstock"] for r in snapshot_rows), "slowMoving": sum(r["classification"]["slowMoving"] for r in snapshot_rows),
                  "deadStock": sum(r["classification"]["deadStock"] for r in snapshot_rows), "shouldReorder": sum(r["recommendation"]["shouldReorder"] for r in snapshot_rows),
                  "recommendedProducts": sum(r["recommendation"]["recommendedQty"] > 0 for r in snapshot_rows),
                  "singleSource": sum(r["supplier"]["dependencyStatus"] == "SINGLE_SOURCE" for r in snapshot_rows),
                  "inventoryValueCents": sum(int(r["stock"]["onHand"]) * int(products[r["sku"]]["endingAverageCostCents"]) for r in snapshot_rows) if cutoff == forecast_v3.HISTORY_END else None,
                  "incomingUnits": sum(r["stock"]["incoming"] for r in snapshot_rows), "pendingOrderCount": len(pending_orders),
                  "overdueOrUnknownExpectedArrivalUnits": sum(r["stock"]["overdueOrUnknownExpectedArrivalUnits"] for r in snapshot_rows)}
        abc_counts = {key: sum(r["classification"]["abc"] == key for r in snapshot_rows) for key in ("A", "B", "C", "UNCLASSIFIED")}
        xyz_counts = {key: sum(r["classification"]["xyz"] == key for r in snapshot_rows) for key in ("X", "Y", "Z")}
        matrix_counts = {f"{a}-{x}": sum(r["classification"]["abcXyz"] == f"{a}-{x}" for r in snapshot_rows) for a in "ABC" for x in "XYZ"}
        return {"scenarioId": forecast_v3.SCENARIO_ID, "datasetVersion": forecast_v3.DATASET_VERSION,
                "datasetSha256": forecast_v3.DATASET_SHA256, "asOfDate": cutoff.isoformat(), "timezone": "America/Lima",
                "forecastStrategy": "MOVING_AVERAGE_28", "forecastHorizons": [1, 7, 14],
                "summary": totals, "abcCounts": abc_counts, "xyzCounts": xyz_counts, "abcXyzCounts": matrix_counts,
                "policy": {"serviceZ": SERVICE_Z, "serviceLevelHeuristic": 0.90, "reviewDays": REVIEW_DAYS,
                           "abcMethod": "365d consumed value at observed effective unit cost; A through 80%, B through 95%, SKU crossing included",
                           "xyzMethod": "13 completed weeks; CV population; X<=0.5, Y<=1, otherwise Z; require at least 8 weeks with >=5 available days",
                           "configuredMinimumStock": "strict stock<=minimum; separate from reorder-point risk",
                           "noReservationData": True, "historicalLeadSampleMin": MIN_LEAD_RECEIPTS,
                           "slowMoving": "observable scenario tenure>=60d; 1-4 sale days in the last 30d; >=80% availability",
                           "deadStock": "onHand>0; no sales in last 60d; >=80% availability",
                           "overstock": "non-perishable cover>max(30d,2*(lead+7d)); perishable position exceeds expected sales during shelf life",
                           "leadTimeDemand": "interpolate only within approved cumulative h1/h7/h14 and cap at 14d",
                           "perishableOrderCap": "pack-rounded max(1 pack, expected daily sales*shelf life); observed stockout truth excluded"},
                "products": snapshot_rows, "rankings": {key: [row["sku"] for row in rank_products(snapshot_rows, key)]
                                                            for key in ("stockout_risk", "low_stock", "overstock", "slow_moving", "abc_a", "az", "single_source_critical", "reorder")}}

    @staticmethod
    def _validate_operational_records(records: dict[str, Any]) -> None:
        required = {"products", "movements", "purchases", "purchaseLines", "scenario"}
        if not required.issubset(records):
            raise ValueError("Mongo V3 read result is missing required operational domains")
        scenario = records["scenario"]
        if (scenario.get("scenarioId") != forecast_v3.SCENARIO_ID
                or scenario.get("status") != "completed"
                or scenario.get("sourceSha256") != forecast_v3.DATASET_SHA256
                or scenario.get("referenceDate") != forecast_v3.HISTORY_END.isoformat()
                or scenario.get("datasetVersion") != forecast_v3.DATASET_VERSION):
            raise ValueError("Mongo V3 scenario marker does not match the approved package")
        expected_counts = {"products": 80, "purchases": 2155, "purchaseLines": 3408, "movements": 40445}
        if any(len(records[key]) != count for key, count in expected_counts.items()):
            raise ValueError("Mongo V3 operational counts differ from the approved scenario")
        for domain in ("products", "movements", "purchases", "purchaseLines"):
            if any(row.get("scenarioId") != forecast_v3.SCENARIO_ID for row in records[domain]):
                raise ValueError(f"Mongo V3 {domain} contain a different scenario")
        if len({row["sku"] for row in records["products"]}) != 80:
            raise ValueError("Mongo V3 product SKUs are not unique")
