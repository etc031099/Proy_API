"""LIVE inventory and supplier views over the immutable backend snapshot.

This is deliberately a wrapper, not a second forecasting/replenishment engine:
M6.6 evaluates inventory policies using approved LIVE Ridge 7/14 inputs.
"""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict, defaultdict
from datetime import date, datetime, timedelta
import math
from statistics import median, pstdev
from threading import RLock
from typing import Any
from zoneinfo import ZoneInfo

from ml.service.v3_live_business_customer import LiveDomainError
from ml.service.v3_live_context import LiveV3Context
from ml.src import business_customer_supplier_v3 as m68
from ml.src import inventory_intelligence_v3 as m66

LIMA = ZoneInfo("America/Lima")
_RISK_LEVELS = ("CRITICAL", "HIGH", "MEDIUM", "LOW")


def _risk_counts(rows: list[dict[str, Any]]) -> dict[str, int | None]:
    """Count the same canonical risk levels exposed by inventory ranking rows."""
    normalized = [str((row.get("risk") or {}).get("level") or "").strip().upper() for row in rows]
    unavailable = sum(level not in _RISK_LEVELS for level in normalized)
    counts = {level.lower(): sum(value == level for value in normalized) for level in _RISK_LEVELS}
    if unavailable:
        counts = {key: None for key in counts}
    counts["riskUnavailableCount"] = unavailable
    return counts


def _get(row: Any, key: str, default=None):
    return row.get(key, default) if isinstance(row, dict) else getattr(row, key, default)


def _local_date(value: datetime) -> date:
    return value.astimezone(LIMA).date()


class LiveInventorySupplierAdapter:
    """Bounded cache of immutable per-snapshot projections; no historical mutation."""

    ENGINE_VERSION = "m6.10a361-live-ridge-inventory-v1"

    def __init__(self, records: dict[str, Any], static: dict[str, Any], inventory_engine,
                 supplier_engine):
        self.records, self.static = records, static
        self.inventory_engine, self.supplier_engine = inventory_engine, supplier_engine
        self._cache: OrderedDict[tuple[str, ...], dict[str, Any]] = OrderedDict()
        self._lock = RLock()

    def _key(self, live: LiveV3Context, domain: str, request) -> tuple[str, ...]:
        meta = live.snapshot.metadata
        test_epoch = meta.testEpoch
        filters = {key: getattr(request, key, None) for key in
                   ("mode", "skus", "supplierCode", "productSkus", "risk", "abc", "xyz", "flag", "metric", "limit", "offset", "period")}
        return (meta.businessId, meta.scenarioId, live.data_version, live.context_hash,
                test_epoch.testCycleId if test_epoch else "", test_epoch.resetEpoch if test_epoch else "",
                live.as_of_date.isoformat(), domain, self.ENGINE_VERSION,
                json.dumps(filters, sort_keys=True, separators=(",", ":"), default=str))

    def inventory_data(self, request, live: LiveV3Context, forecast_rows=None):
        meta = live.snapshot.metadata
        test_epoch = meta.testEpoch
        forecast_identity = hashlib.sha256(json.dumps(forecast_rows or [], sort_keys=True,
            separators=(",", ":"), default=str, allow_nan=False).encode("utf-8")).hexdigest()
        key = (meta.businessId, meta.scenarioId, live.data_version, live.context_hash,
               test_epoch.testCycleId if test_epoch else "", test_epoch.resetEpoch if test_epoch else "",
               live.as_of_date.isoformat(), "inventory", self.ENGINE_VERSION,
               forecast_identity)
        with self._lock:
            rows = self._cache.get(key)
            if rows is None:
                rows = self._inventory_rows(live, forecast_rows)
                self._cache[key] = rows
                while len(self._cache) > 8:
                    self._cache.popitem(last=False)
            else:
                self._cache.move_to_end(key)
        values = list(rows["products"])
        unavailable = 0
        if request.skus:
            missing = set(request.skus) - {row["sku"] for row in values}
            if missing:
                raise LiveDomainError("PRODUCT_NOT_FOUND", 404, "One or more product SKUs were not found.")
            wanted = set(request.skus)
            values = [row for row in values if row["sku"] in wanted]
        # Missing forecast evidence must not look like an empty successful filter.
        if request.risk:
            unavailable += sum(row["risk"].get("level") is None for row in values)
            values = [row for row in values if row["risk"]["level"] == request.risk]
        if request.abc:
            unavailable = max(unavailable, sum(row["classification"]["abc"] is None for row in values))
            values = [row for row in values if row["classification"]["abc"] == request.abc]
        if request.xyz:
            unavailable = max(unavailable, sum(row["classification"]["xyz"] is None for row in values))
            values = [row for row in values if row["classification"]["xyz"] == request.xyz]
        if request.flag:
            if request.flag == "low_stock":
                unavailable += sum(row["risk"].get("lowStock") is None for row in values)
            if request.flag in {"should_reorder", "overstock"}:
                dependent = "recommendedQty" if request.flag == "should_reorder" else "overstock"
                unavailable += sum((row["recommendation"].get(dependent) if dependent == "recommendedQty"
                                    else row["classification"].get(dependent)) is None for row in values)
            if request.flag in {"slow_moving", "dead_stock"}:
                field = "slowMoving" if request.flag == "slow_moving" else "deadStock"
                unavailable = max(unavailable, sum(row["classification"][field] is None for row in values))
            tests = {"low_stock": lambda r: r["risk"]["lowStock"],
                     "overstock": lambda r: r["classification"]["overstock"],
                     "should_reorder": lambda r: r["recommendation"]["shouldReorder"],
                     "single_source": lambda r: r["supplier"]["dependencyStatus"] == "SINGLE_SOURCE",
                     "slow_moving": lambda r: r["classification"]["slowMoving"],
                     "dead_stock": lambda r: r["classification"]["deadStock"]}
            values = [row for row in values if tests[request.flag](row) is True]
        if request.mode == "detail" and not request.skus:
            raise LiveDomainError("AMBIGUOUS_ENTITY", 409, "A resolved product SKU is required for inventory detail.")
        if request.mode == "rank":
            ranking = {"overstock": "overstock", "reorder": "reorder",
                "stockout_risk": "stockout_risk", "low_stock": "low_stock", "slow_moving": "slow_moving",
                "abc_a": "abc_a", "az": "az",
                "single_source_critical": "single_source_critical"}.get(request.metric)
            if ranking is None:
                return {"availabilityStatus": "PARTIAL", "reasonCode": "INSUFFICIENT_FORECAST_EVIDENCE",
                        "metric": request.metric, "total": 0, "analyzedCount": 0,
                        "unavailableCount": len(values), "items": []}, live.as_of_date
            rank_requirements = {
                "stockout_risk": lambda row: row["risk"].get("level") in _RISK_LEVELS,
                "reorder": lambda row: row["recommendation"].get("shouldReorder") is not None
                    and row["recommendation"].get("recommendedQty") is not None
                    and row["risk"].get("level") in _RISK_LEVELS,
                "overstock": lambda row: row["classification"].get("overstock") is not None,
                "single_source_critical": lambda row: row["risk"].get("level") in {"CRITICAL", "HIGH"},
                "low_stock": lambda row: row["risk"].get("lowStock") is not None,
                "abc_a": lambda row: row["classification"].get("abc") is not None,
                "az": lambda row: row["classification"].get("abcXyz") is not None,
                "slow_moving": lambda row: row["classification"].get("slowMoving") is not None,
            }
            eligible = [row for row in values if rank_requirements[ranking](row)]
            unavailable += len(values) - len(eligible)
            values = m66.rank_products(eligible, ranking)
        page = values[request.offset:request.offset + request.limit]
        if request.mode in {"detail", "rank", "recommendations"} or request.skus or request.flag or request.risk or request.abc or request.xyz:
            data = {"total": len(values), "analyzedCount": len(values), "unavailableCount": unavailable,
                    "items": [self._public_inventory(row) for row in page]}
        else:
            data = self._inventory_summary(rows)
        data = self._inventory_availability(data, rows, unavailable, live)
        if getattr(request, "includeSummary", False) and (request.mode == "rank" or (request.mode == "summary" and
                (request.skus or request.flag or request.risk or request.abc or request.xyz))):
            # Both views use the exact same evaluated rows and model/snapshot lineage.
            # Global unavailable counts must not inherit exclusions from the ranking/filter.
            data["inventorySummary"] = self._inventory_availability(
                self._inventory_summary(rows), rows, 0, live)
        return data, live.as_of_date

    @staticmethod
    def _inventory_summary(rows):
        return {"summary": rows["summary"], "abcCounts": rows["abcCounts"],
                "xyzCounts": rows["xyzCounts"], "abcXyzCounts": rows["abcXyzCounts"],
                "analyzedCount": rows["summary"]["analyzedCount"],
                "unavailableCount": rows["summary"]["unavailableCount"]}

    def _inventory_availability(self, data, rows, unavailable, live):
        # A partial status reflects evidence unavailable for at least one SKU,
        # not a missing adapter. Forecast-dependent policies remain explicit nulls.
        dependent_partial = any(rows["summary"].get(key, 0) for key in (
            "coverageUnavailableCount", "riskUnavailableCount", "recommendationUnavailableCount",
            "overstockUnavailableCount"))
        data["availabilityStatus"] = "PARTIAL" if (unavailable or rows["summary"]["unavailableCount"]
            or rows["summary"]["forecastAvailability"] != "AVAILABLE" or dependent_partial) else "AVAILABLE"
        if unavailable or rows["summary"]["forecastAvailability"] != "AVAILABLE" or dependent_partial:
            data["reasonCode"] = "FORECAST_HORIZON_UNAVAILABLE"
            data["unavailableCount"] = max(unavailable, data.get("unavailableCount", 0))
        data["fieldAvailability"] = {"stock": "PARTIAL" if rows["summary"]["unavailableCount"] else "AVAILABLE",
            "incoming": "PARTIAL" if rows["summary"].get("incomingUnavailableCount", 0) else "AVAILABLE",
            "minimumStock": "PARTIAL" if rows["summary"].get("minimumStockUnavailableCount", 0) else "AVAILABLE",
            "lowStock": "PARTIAL" if rows["summary"].get("lowStockUnavailableCount", 0) else "AVAILABLE",
            "forecast": "AVAILABLE" if rows["summary"]["forecastAvailability"] == "AVAILABLE" else "PARTIAL",
            "coverage": "AVAILABLE" if rows["summary"].get("coverageUnavailableCount", 0) == 0 else "PARTIAL",
            "risk": "AVAILABLE" if rows["summary"].get("riskUnavailableCount", 0) == 0 else "PARTIAL",
            "reorder": "AVAILABLE" if rows["summary"].get("recommendationUnavailableCount", 0) == 0 else "PARTIAL", "abc": "AVAILABLE" if rows["summary"]["abcAvailable"] and not rows["summary"]["abcUnavailableCount"] else "PARTIAL",
            "xyz": "AVAILABLE" if rows["summary"]["xyzAvailable"] else "PARTIAL",
            "slowMoving": "PARTIAL" if rows["summary"]["slowMovingUnavailableCount"] else "AVAILABLE",
            "deadStock": "PARTIAL" if rows["summary"]["deadStockUnavailableCount"] else "AVAILABLE"}
        data["freshness"] = {**dict(live.freshness("inventory")), "engineVersion": self.ENGINE_VERSION}
        return data

    def _inventory_rows(self, live: LiveV3Context, forecast_rows=None):
        cutoff = live.as_of_date
        products = {str(_get(row, "sku")): row for row in self.static.get("products", ()) if _get(row, "sku")}
        product_definitions = {str(row.get("sku")): row for row in self.static.get("products", ()) if row.get("sku")}
        for product in live.products_by_key.values():
            sku = _get(product, "sku")
            if sku:
                products[sku] = product
        pending: dict[str, list[dict[str, Any]]] = defaultdict(list)
        overdue: dict[str, int] = defaultdict(int)
        # Frozen purchase promises remain authoritative only for the frozen base.
        base_purchase = {row["purchaseCode"]: row for row in self.records.get("purchases", ())}
        for line in self.records.get("purchaseLines", ()):
            purchase = base_purchase.get(line.get("purchaseCode"))
            if not purchase or purchase.get("purchaseCode") in live.cancelled_transaction_keys:
                continue
            state = m66._purchase_line_as_of(purchase, line, date(2026, 10, 12))
            sku = line.get("sku")
            if not sku:
                continue
            remaining = int(state["remainingUnits"])
            if remaining:
                promised = date.fromisoformat(purchase["promisedLocalDate"]) if purchase.get("promisedLocalDate") else None
                if promised is not None and promised > cutoff:
                    pending[sku].append({"units": remaining, "expectedReceiptDate": promised.isoformat(),
                                         "supplierCode": line.get("supplierCode"), "source": "HISTORICAL_PENDING"})
                else:
                    overdue[sku] += remaining
        # Delta purchase state is reconstructed from immutable CREATE + RECEIVE/CANCEL journal.
        cancelled = live.cancelled_transaction_keys
        for purchase in live.snapshot.purchases:
            if purchase.purchaseKey in cancelled or purchase.status == "cancelled" or purchase.receiptEvidence == "IMMEDIATE_PURCHASE":
                continue
            for line in purchase.lines:
                received = int(live.received_by_purchase_line.get(line.lineKey, 0))
                remaining = max(0, int(line.quantityOrdered) - received)
                if not remaining:
                    continue
                promise = _local_date(purchase.promisedAtUtc) if purchase.promisedAtUtc else None
                sku = line.sku or _get(live.products_by_key.get(line.productKey), "sku")
                if not sku:
                    continue
                if promise is not None and promise > cutoff:
                    pending[sku].append({"units": remaining, "expectedReceiptDate": promise.isoformat(),
                                         "supplierCode": purchase.supplierKey, "source": "LIVE_PENDING"})
                else:
                    overdue[sku] += remaining
        # Reuse the approved M6.6 daily observations for frozen history and
        # overlay only explicit backend-closed LIVE days for XYZ.
        dataset = getattr(self.inventory_engine, "dataset", None)
        daily: dict[str, dict[date, dict[str, Any]]] = defaultdict(dict)
        if dataset is not None:
            for sku, series in dataset.daily_by_sku.items():
                for item in series:
                    day = date.fromisoformat(item["localDate"])
                    if day <= date(2026, 10, 12):
                        daily[sku][day] = item
        if live.cancelled_transaction_keys:
            cancelled_codes = live.cancelled_transaction_keys
            sale_dates = {row.get("saleCode"): row.get("localDate") for row in self.records.get("sales", ())
                          if row.get("saleCode") in cancelled_codes}
            for line in self.records.get("saleItems", ()):
                code = line.get("saleCode")
                if code not in sale_dates or line.get("transactionStatus") != "completed":
                    continue
                sku = line.get("sku")
                day = date.fromisoformat(sale_dates[code])
                row = daily.get(sku, {}).get(day)
                if row is not None:
                    corrected = dict(row)
                    corrected["unitsSold"] = max(0, int(corrected["unitsSold"]) - int(line.get("unitsSold", 0)))
                    daily[sku][day] = corrected
        for item in live.snapshot.closedSalesDays:
            sku = _get(live.products_by_key.get(item.productKey), "sku")
            if sku and item.localDate > date(2026, 10, 12) and item.localDate <= cutoff:
                daily[sku][item.localDate] = {"localDate": item.localDate.isoformat(),
                    "unitsSold": int(item.unitsSold),
                    "availableHours": item.availableHours if item.availability == "OBSERVED" else 0,
                    "onHandUsableAtOrigin": item.onHandUsableAtOrigin if item.availability == "OBSERVED" else 0,
                    "effectiveUnitCostAtSale": None}
        # Current-day completed sales affect LIVE inventory classifications, but
        # the forecast adapter exclusively reads certified closedSalesDays.
        current_units: dict[str, int] = defaultdict(int)
        for sale in live.snapshot.sales:
            if sale.localDate != cutoff or sale.initialStatus != "completed" or sale.saleKey in live.cancelled_transaction_keys:
                continue
            for line in sale.lines:
                sku = line.sku or _get(live.products_by_key.get(line.productKey), "sku")
                if sku:
                    current_units[sku] += int(line.quantity)
        for sku, units in current_units.items():
            daily[sku][cutoff] = {"localDate": cutoff.isoformat(), "unitsSold": units,
                "availableHours": 0, "onHandUsableAtOrigin": 0, "effectiveUnitCostAtSale": None}
        abc_values: dict[str, int] = defaultdict(int)
        costs_complete = True
        abc_start = cutoff - timedelta(days=364)
        for sku, series in daily.items():
            for day, item in series.items():
                units = int(item.get("unitsSold", 0))
                if abc_start <= day <= cutoff and day <= date(2026, 10, 12) and units:
                    unit_cost = item.get("effectiveUnitCostAtSale")
                    if unit_cost is None:
                        costs_complete = False
                    else:
                        abc_values[sku] += units * int(unit_cost)
        for sale in live.snapshot.sales:
            if sale.saleKey in live.cancelled_transaction_keys or sale.initialStatus != "completed":
                continue
            if sale.localDate < abc_start or sale.localDate > cutoff:
                continue
            for line in sale.lines:
                sku = line.sku or _get(live.products_by_key.get(line.productKey), "sku")
                if line.costKnown and line.unitCostAtSaleCents is not None:
                    abc_values[sku] += int(line.quantity) * int(line.unitCostAtSaleCents)
                else:
                    costs_complete = False
        abc = m66._abc_classes({**{sku: 0 for sku in products}, **abc_values}) if costs_complete else {}
        base_skus = {str(row.get("sku")) for row in self.records.get("products", ())}
        # LIVE XYZ excludes the current (possibly incomplete) Monday-Sunday
        # week, then evaluates the immediately preceding 13 complete weeks.
        current_week_start = cutoff - timedelta(days=cutoff.weekday())
        first_week = current_week_start - timedelta(days=7 * m66.XYZ_WEEKS)
        xyz_by_sku = {}
        for sku in products:
            weekly = []
            series = daily.get(sku, {})
            for offset in range(m66.XYZ_WEEKS):
                week_start = first_week + timedelta(days=7 * offset)
                observed = [row for day, row in series.items()
                            if week_start <= day < week_start + timedelta(days=7)
                            and float(row.get("availableHours") or 0) > 0
                            and (row.get("onHandUsableAtOrigin") or 0) > 0]
                if len(observed) >= m66.MIN_WEEK_AVAILABILITY_DAYS:
                    weekly.append(sum(float(row["unitsSold"]) for row in observed) * 7 / len(observed))
            xyz_by_sku[sku] = m66._xyz(weekly)
        offers_by_sku = self.supplier_engine._offers(date(2026, 10, 12)) if hasattr(self.supplier_engine, "_offers") else {}
        forecast_by_sku = {row["sku"]: row for row in (forecast_rows or ())}
        supplier_configs = {str(_get(row, "supplierCode")): row for row in self.static.get("suppliers", ())}
        offer_defs = self.static.get("offers", {})
        pack_multiples = offer_defs.get("packMultipleBySupplier", {}) if isinstance(offer_defs, dict) else {}
        lead_pair, lead_supplier = self._lead_samples(live)
        abc_complete = {sku: {"abc": (abc.get(sku) or {}).get("abc", "UNCLASSIFIED"),
                             "consumptionValueCents": (abc.get(sku) or {}).get("consumptionValueCents", 0),
                             "cumulativeValueShare": (abc.get(sku) or {}).get("cumulativeValueShare")}
                        for sku in products}
        rows = []
        for sku, product in sorted(products.items()):
            product_key = str(_get(product, "productKey", sku))
            stock = live.stock_for(product_key=product_key, sku=sku)
            incoming_orders = pending.get(sku, [])
            incoming = sum(int(item["units"]) for item in incoming_orders)
            minimum = _get(product, "minStock", _get(product, "minStockInitial"))
            known_stock = stock is not None
            low = (stock <= int(minimum)) if known_stock and minimum is not None else None
            new_sku = sku not in base_skus
            abc_row = abc.get(sku)
            xyz_row = xyz_by_sku.get(sku, {})
            abc_value = abc_row.get("consumptionValueCents") if abc_row else None
            abc_class = abc_row.get("abc") if abc_row and not new_sku else None
            xyz_class = xyz_row.get("xyz") if xyz_row.get("status") != "INSUFFICIENT_HISTORY" and not new_sku else None
            history = sorted((row for row in daily.get(sku, {}).values() if row["localDate"] <= cutoff.isoformat()),
                             key=lambda row: row["localDate"])
            last30, last60 = history[-30:], history[-60:]
            available30 = sum(float(row.get("availableHours") or 0) > 0 and (row.get("onHandUsableAtOrigin") or 0) > 0 for row in last30)
            available60 = sum(float(row.get("availableHours") or 0) > 0 and (row.get("onHandUsableAtOrigin") or 0) > 0 for row in last60)
            sale_days30 = sum(int(row["unitsSold"]) > 0 for row in last30)
            sold60 = sum(int(row["unitsSold"]) for row in last60)
            age = len(history)
            slow_evidence = age >= 60 and len(last30) == 30 and available30 / 30 >= m66.MIN_COVERAGE_RATIO
            dead_evidence = (known_stock and stock > 0 and age >= 60 and len(last60) == 60
                             and available60 / 60 >= m66.MIN_COVERAGE_RATIO)
            slow = (0 < sale_days30 <= 4) if slow_evidence else None
            dead = (sold60 == 0) if dead_evidence else None
            class_status = ("PROVISIONAL" if new_sku else "COST_NOT_AVAILABLE" if not costs_complete else
                            "INSUFFICIENT_HISTORY" if xyz_class is None else "AVAILABLE")
            classification = {"abc": abc_class, "abcValueCents": abc_value, "xyz": xyz_class,
                "xyzStatus": xyz_row.get("status", "INSUFFICIENT_HISTORY"),
                "xyzWeeksObserved": xyz_row.get("weeksObserved", 0),
                "abcXyz": f"{abc_class}-{xyz_class}" if abc_class and xyz_class else None,
                "status": class_status, "overstock": None,
                "slowMoving": slow, "deadStock": dead,
                "slowMovingStatus": "AVAILABLE" if slow_evidence else "INSUFFICIENT_HISTORY",
                "deadStockStatus": "AVAILABLE" if dead_evidence else "INSUFFICIENT_HISTORY",
                "availableDays30": available30, "availableDays60": available60,
                "saleDays30": sale_days30, "unitsSold60": sold60, "productObservableAgeDays": age}
            row = {"sku": sku, "productKey": product_key, "productName": _get(product, "name", sku),
                "categoryCode": _get(product, "categoryCode"), "asOfDate": cutoff.isoformat(),
                "stock": {"onHand": stock, "incoming": incoming,
                          "inventoryPosition": stock + incoming if known_stock else None,
                          "availabilityStatus": "AVAILABLE" if known_stock else "PARTIAL",
                          "reasonCode": None if known_stock else "STOCK_UNAVAILABLE",
                          "pendingOrders": incoming_orders, "overdueOrUnknownExpectedArrivalUnits": overdue.get(sku, 0)},
                "coverage": {"daysCover": None, "status": "PARTIAL", "reasonCode": "FORECAST_HORIZON_UNAVAILABLE",
                    "availabilityStatus": "PARTIAL"},
                "demand": {"expectedDaily": None, "source": "APPROXIMATE_RATE_FROM_RIDGE_7_14",
                    "status": "PARTIAL", "reasonCode": "FORECAST_HORIZON_UNAVAILABLE", "availabilityStatus": "PARTIAL"},
                "inventoryPolicy": {"configuredMinimumStock": minimum,
                    "safetyStock": None, "reorderPoint": None,
                    "configuredSafetyStock": _get(product, "safetyStock"),
                    "configuredReorderPoint": _get(product, "reorderPoint"),
                    "status": "PARTIAL", "reasonCode": "FORECAST_HORIZON_UNAVAILABLE",
                    "safetyStockStatus": "PARTIAL", "reorderStatus": "PARTIAL"},
                "risk": {"level": None, "reasonCodes": ["FORECAST_HORIZON_UNAVAILABLE"], "lowStock": low if minimum is not None and known_stock else None,
                    "status": "PARTIAL" if known_stock else "STOCK_UNAVAILABLE",
                    "reasonCode": "FORECAST_HORIZON_UNAVAILABLE", "availabilityStatus": "PARTIAL",
                    "projectedStockoutDate": None, "projectedStockoutDateStatus": "UNAVAILABLE_NO_APPROVED_DAILY_CURVE"},
                "classification": classification,
                "recommendation": {"shouldReorder": None, "recommendedQty": None,
                    "status": "PARTIAL", "reasonCode": "FORECAST_HORIZON_UNAVAILABLE", "availabilityStatus": "PARTIAL"},
                "supplier": {"preferredSupplierCode": _get(product, "preferredSupplierCode"),
                    "dependencyStatus": ("SINGLE_SOURCE" if len(_get(product, "supplierOffers", ()) or offers_by_sku.get(sku, ())) == 1
                        else "MULTI_SOURCE" if (_get(product, "supplierOffers", ()) or offers_by_sku.get(sku, ()))
                        else "NO_ACTIVE_OFFER"),
                    "activeOfferCount": len(_get(product, "supplierOffers", ()) or offers_by_sku.get(sku, ()))}}
            forecast_row = forecast_by_sku.get(sku, {})
            row["forecast"] = {"source": "RIDGE_CAUSAL27", "status": "PARTIAL",
                "reasonCode": "FORECAST_HORIZON_UNAVAILABLE", "expected1d": None,
                "expected7d": None, "expected14d": None,
                "modelVersion7": forecast_row.get("modelVersion7"),
                "modelVersion14": forecast_row.get("modelVersion14"),
                "horizon7Status": forecast_row.get("horizon7Status", "MODEL_UNAVAILABLE"),
                "horizon14Status": forecast_row.get("horizon14Status", "MODEL_UNAVAILABLE")}
            row["coverage"].update({"status": "PARTIAL", "reasonCode": "INSUFFICIENT_FORECAST_INPUTS"})
            row["demand"].update({"source": "APPROXIMATE_RATE_FROM_RIDGE_7_14", "status": "PARTIAL",
                "reasonCode": "INSUFFICIENT_FORECAST_INPUTS"})
            row["inventoryPolicy"].update({"status": "PARTIAL", "reasonCode": "INSUFFICIENT_FORECAST_INPUTS"})
            row["recommendation"].update({"status": "PARTIAL", "reasonCode": "INSUFFICIENT_FORECAST_INPUTS"})
            row["risk"].update({"status": "PARTIAL", "reasonCode": "INSUFFICIENT_FORECAST_INPUTS",
                "projectedStockoutDate": None, "projectedStockoutDateStatus": "UNAVAILABLE_NO_APPROVED_DAILY_CURVE"})
            ridge7 = forecast_row.get("expectedUnitsNext7d")
            ridge14 = forecast_row.get("expectedUnitsNext14d")
            valid_pair = (forecast_row.get("horizon7Status", forecast_row.get("status")) == "READY"
                and forecast_row.get("horizon14Status", forecast_row.get("status")) == "READY"
                and all(isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(float(value)) and value >= 0 for value in (ridge7, ridge14))
                and float(ridge14) >= float(ridge7))
            if valid_pair and known_stock:
                projection = product if isinstance(product, dict) else {
                    name: getattr(product, name, None) for name in ("sku", "productKey", "name", "active", "minStock",
                        "safetyStock", "reorderPoint", "categoryCode", "subcategoryCode", "perishable", "shelfLifeDays",
                        "supplierOffers")}
                definition = {**product_definitions.get(sku, {}), **{k: v for k, v in projection.items() if v is not None}}
                if "minStockInitial" not in definition and definition.get("minStock") is not None:
                    definition["minStockInitial"] = definition["minStock"]
                if "productKey" not in definition:
                    definition["productKey"] = product_key
                if "name" not in definition:
                    definition["name"] = row["productName"]
                pair = lead_pair.get((sku, str(_get(definition, "preferredSupplierCode", ""))), [])
                preferred = str(_get(definition, "preferredSupplierCode", ""))
                supplier_samples = lead_supplier.get(preferred, [])
                supplier_config = supplier_configs.get(preferred, {})
                lead_n, lead_source = 0, "UNAVAILABLE"
                if len(pair) >= m66.MIN_LEAD_RECEIPTS:
                    lead, lead_std, lead_n, lead_source = sum(pair) / len(pair), pstdev(pair), len(pair), "OBSERVED_PRODUCT_SUPPLIER"
                elif len(supplier_samples) >= m66.MIN_LEAD_RECEIPTS:
                    lead, lead_std, lead_n, lead_source = sum(supplier_samples) / len(supplier_samples), pstdev(supplier_samples), len(supplier_samples), "OBSERVED_SUPPLIER_AGGREGATE"
                else:
                    configured = _get(definition, "leadTimeDays")
                    if configured is None:
                        configured = supplier_config.get("leadTimeMeanDays")
                    if configured is None:
                        configured = (_get(supplier_config, "leadTime", {}) or {}).get("configuredMeanDays") if isinstance(supplier_config, dict) else None
                    if configured is not None:
                        configured_std = _get(supplier_config, "leadTimeStdDays")
                        lead = configured
                        lead_std = configured_std
                        lead_n = len(pair)
                        lead_source = ("PRODUCT_CONFIG_AND_SUPPLIER_DEMO_VARIABILITY"
                                       if lead_std is not None else "PRODUCT_CONFIG_LEAD_ONLY")
                    else:
                        lead = lead_std = None
                observable_days = sum(float(item.get("availableHours") or 0) > 0 and int(item.get("onHandUsableAtOrigin") or 0) > 0
                                      for item in history[-28:])
                lead_reason = m66._ridge_lead_time_reason(lead)
                lead_supported = lead_reason is None
                valid_lead_number = lead_reason in (None, "LEAD_TIME_BEYOND_APPROVED_HORIZON")
                sigma_lead_available = (isinstance(lead_std, (int, float)) and not isinstance(lead_std, bool)
                    and math.isfinite(lead_std) and lead_std >= 0)
                configured_lead = _get(definition, "leadTimeDays")
                if m66._ridge_lead_time_reason(configured_lead) not in (None, "LEAD_TIME_BEYOND_APPROVED_HORIZON"):
                    configured_lead = lead if valid_lead_number else 0.0
                if True:
                    offer_rows = offers_by_sku.get(sku, [])
                    preferred_offers = _get(product, "supplierOffers", ()) or offer_rows
                    active_offers = []
                    for offer in preferred_offers:
                        supplier_key = str(_get(offer, "supplierKey", _get(offer, "supplierCode", "")))
                        active_offers.append({"supplierCode": supplier_key,
                            "supplierName": supplier_configs.get(supplier_key, {}).get("displayName", supplier_key),
                            "preferred": bool(_get(offer, "preferred", supplier_key == preferred)),
                            "unitCostCents": _get(offer, "costCents"), "currency": _get(offer, "currency")})
                    supplier_info = supplier_configs.get(preferred, {})
                    approved_forecast = {**forecast_row,
                        "expectedUnitsNext1d": None,
                        "expectedUnitsNext7d": float(ridge7), "expectedUnitsNext14d": float(ridge14),
                        "cutoffDate": forecast_row.get("cutoffDate", cutoff.isoformat()), "status": "READY"}
                    evaluated = m66.evaluate_sku(product=definition, forecast=approved_forecast,
                        daily_rows=history, on_hand=stock, incoming_orders=incoming_orders, cutoff=cutoff,
                        lead_time_days=lead,
                        configured_lead_time_days=float(configured_lead),
                        lead_time_std_days=lead_std if sigma_lead_available else 0.0,
                        lead_time_source=lead_source if lead is not None else "UNAVAILABLE", lead_time_sample_size=lead_n,
                        supplier=supplier_info, active_offers=active_offers,
                        pack_multiple=int(pack_multiples.get(f"{preferred}:{sku}", pack_multiples.get(preferred, 1))),
                        min_order_qty=1, consumption_value=abc_complete[sku], ridge_live=True)
                    row = self._from_m66(row, evaluated)
                    if minimum is None:
                        row["risk"]["lowStock"] = None
                        row["classification"]["lowStock"] = None
                    safety_available = lead_supported and sigma_lead_available and observable_days >= 14
                    row["forecast"].update({"status": "AVAILABLE", "reasonCode": None,
                        "expected7d": float(ridge7), "expected14d": float(ridge14)})
                    row["coverage"].update({"status": "AVAILABLE", "reasonCode": None})
                    row["demand"].update({"status": "AVAILABLE", "reasonCode": None,
                        "expectedDaily": (float(ridge7) / 7 + float(ridge14) / 14) / 2,
                        "source": "APPROXIMATE_RATE_FROM_RIDGE_7_14"})
                    row["inventoryPolicy"].update({"status": "AVAILABLE", "reasonCode": None})
                    row["coverage"]["availabilityStatus"] = "AVAILABLE"
                    row["demand"]["availabilityStatus"] = "AVAILABLE"
                    row["inventoryPolicy"]["safetyStockStatus"] = "AVAILABLE" if safety_available else "PARTIAL"
                    row["inventoryPolicy"]["reorderStatus"] = "AVAILABLE" if lead_supported and safety_available else "PARTIAL"
                    row["forecast"]["modelVersion7"] = forecast_row.get("modelVersion7")
                    row["forecast"]["modelVersion14"] = forecast_row.get("modelVersion14")
                    if not safety_available:
                        row["inventoryPolicy"].update({"safetyStockRaw": None, "safetyStock": None,
                            "status": "PARTIAL", "reasonCode": "INSUFFICIENT_FORECAST_INPUTS"})
                    if not lead_supported or not safety_available:
                        reason = lead_reason or "INSUFFICIENT_FORECAST_INPUTS"
                        row["recommendation"].update({"shouldReorder": None, "recommendedQty": None,
                            "targetStock": None, "status": "PARTIAL", "reasonCode": reason})
                        lead_demand_value = evaluated["demand"]["validLeadTimeDemand"] if lead is not None else None
                        row["demand"]["validLeadTimeDemand"] = lead_demand_value
                        row["inventoryPolicy"].update({"expectedDemandDuringLeadTime": lead_demand_value,
                            "reorderPointRaw": None, "reorderPoint": None, "targetStockRaw": None,
                            "targetStock": None, "status": "PARTIAL", "reasonCode": reason})
                        row["risk"].update({"level": None, "reason": None, "status": "PARTIAL", "reasonCode": reason})
                    row["recommendation"]["availabilityStatus"] = "AVAILABLE" if lead_supported and safety_available else "PARTIAL"
                    row["risk"]["availabilityStatus"] = "AVAILABLE" if lead_supported and safety_available else "PARTIAL"
                    if not valid_lead_number:
                        row["supplier"].update({"leadTimeDays": None, "leadTimeSource": "UNAVAILABLE"})
                    if row["demand"].get("expectedDaily") is not None and row["inventoryPolicy"].get("safetyStock") is not None:
                        threshold, excess = m66._estimate_excess_units(
                            inventory_position=row["stock"]["inventoryPosition"],
                            expected_daily=row["demand"]["expectedDaily"],
                            safety_stock=row["inventoryPolicy"]["safetyStock"], lead_time_days=float(lead or 0),
                            perishable=bool(definition.get("perishable")), shelf_life_days=definition.get("shelfLifeDays"))
                        row["classification"]["excessUnitsEstimated"] = excess
                        row["classification"]["overstock"] = excess > 0
                        row["classification"]["overstockStatus"] = "AVAILABLE"
                        if definition.get("perishable"):
                            row["classification"]["overstockThresholdUnits"] = threshold
                        else:
                            row["classification"]["overstockThresholdDaysCover"] = max(30.0, 2 * (float(lead or 0) + m66.REVIEW_DAYS))
                    else:
                        row["classification"]["overstock"] = None
                        row["classification"]["excessUnitsEstimated"] = None
                        row["classification"]["overstockStatus"] = "PARTIAL"
            elif valid_pair:
                row["forecast"].update({"status": "AVAILABLE", "reasonCode": None,
                    "expected7d": float(ridge7), "expected14d": float(ridge14)})
                row["demand"].update({"expectedDaily": (float(ridge7) / 7 + float(ridge14) / 14) / 2,
                    "source": "APPROXIMATE_RATE_FROM_RIDGE_7_14", "status": "AVAILABLE", "reasonCode": None})
                row["coverage"].update({"status": "PARTIAL", "reasonCode": "STOCK_UNAVAILABLE"})
                row["inventoryPolicy"].update({"status": "PARTIAL", "reasonCode": "STOCK_UNAVAILABLE"})
                row["recommendation"].update({"status": "PARTIAL", "reasonCode": "STOCK_UNAVAILABLE"})
                row["risk"].update({"status": "PARTIAL", "reasonCode": "STOCK_UNAVAILABLE"})
                row["coverage"]["availabilityStatus"] = "PARTIAL"
                row["demand"]["availabilityStatus"] = "AVAILABLE"
                row["inventoryPolicy"].update({"safetyStockStatus": "PARTIAL", "reorderStatus": "PARTIAL"})
                row["recommendation"]["availabilityStatus"] = "PARTIAL"
                row["risk"]["availabilityStatus"] = "PARTIAL"
            else:
                row["forecast"]["reasonCode"] = "FORECAST_HORIZON_UNAVAILABLE"
                row["demand"].update({"reasonCode": "FORECAST_HORIZON_UNAVAILABLE"})
                row["coverage"].update({"reasonCode": "FORECAST_HORIZON_UNAVAILABLE"})
                row["inventoryPolicy"].update({"reasonCode": "FORECAST_HORIZON_UNAVAILABLE"})
                row["recommendation"].update({"reasonCode": "FORECAST_HORIZON_UNAVAILABLE"})
                row["risk"].update({"reasonCode": "FORECAST_HORIZON_UNAVAILABLE"})
            if valid_pair:
                # Keep the direct approved Ridge horizons alongside the derived daily rate.
                # _from_m66 replaces the demand mapping, so these must be restored explicitly.
                row["demand"].update({"expectedUnitsNext7d": float(ridge7),
                    "expectedUnitsNext14d": float(ridge14)})
            rows.append(row)
        known = sum(row["stock"]["onHand"] is not None for row in rows)
        abc_counts = {key: sum(row["classification"]["abc"] == key for row in rows) for key in ("A", "B", "C")}
        abc_counts["UNCLASSIFIED"] = sum(row["classification"]["abc"] not in {"A", "B", "C"} for row in rows)
        xyz_counts = {key: sum(row["classification"]["xyz"] == key for row in rows) for key in ("X", "Y", "Z")}
        xyz_counts["UNCLASSIFIED"] = sum(row["classification"]["xyz"] is None for row in rows)
        matrix = {f"{a}-{x}": 0 for a in "ABC" for x in "XYZ"}
        for row in rows:
            pair = row["classification"]["abcXyz"]
            if pair in matrix:
                matrix[pair] += 1
        all_horizons_ready = (forecast_rows is not None and len(forecast_by_sku) >= len(rows)
            and all(forecast_by_sku.get(row["sku"], {}).get("horizon7Status",
                forecast_by_sku.get(row["sku"], {}).get("status")) == "READY"
                and forecast_by_sku.get(row["sku"], {}).get("horizon14Status",
                forecast_by_sku.get(row["sku"], {}).get("status")) == "READY" for row in rows))
        incoming_unknown = sum(row["stock"]["incoming"] is None for row in rows)
        summary = {"products": len(rows), "analyzedCount": known, "unavailableCount": len(rows) - known,
            "minimumStockUnavailableCount": sum(row["inventoryPolicy"].get("configuredMinimumStock") is None for row in rows),
            "incomingUnits": (None if incoming_unknown else sum(row["stock"]["incoming"] for row in rows)),
            "incomingUnavailableCount": incoming_unknown,
            "lowStock": sum(row["risk"]["lowStock"] is True for row in rows),
            "lowStockUnavailableCount": sum(row["risk"]["lowStock"] is None for row in rows),
            "inventoryValueCents": None, "critical": None, "high": None, "medium": None, "shouldReorder": None,
            "forecastAvailability": "AVAILABLE" if all_horizons_ready else "PARTIAL", "abcAvailable": costs_complete,
            "modelVersion7": next((forecast_by_sku.get(row["sku"], {}).get("modelVersion7") for row in rows
                if forecast_by_sku.get(row["sku"], {}).get("modelVersion7") is not None), None),
            "modelVersion14": next((forecast_by_sku.get(row["sku"], {}).get("modelVersion14") for row in rows
                if forecast_by_sku.get(row["sku"], {}).get("modelVersion14") is not None), None),
            "abcUnavailableCount": sum(row["classification"]["abc"] is None for row in rows),
            "xyzAvailable": all(row["classification"]["xyzStatus"] != "INSUFFICIENT_HISTORY" for row in rows),
            "xyzUnavailableCount": sum(row["classification"]["xyz"] is None for row in rows),
            "slowMovingUnavailableCount": sum(row["classification"]["slowMoving"] is None for row in rows),
            "deadStockUnavailableCount": sum(row["classification"]["deadStock"] is None for row in rows)}
        if forecast_rows is not None:
            for row in rows:
                if row["demand"].get("expectedDaily") is None:
                    summary["forecastAvailability"] = "PARTIAL"
            summary.update(_risk_counts(rows))
            recommendation_unavailable = sum(row["recommendation"].get("recommendedQty") is None for row in rows)
            summary["shouldReorder"] = (None if recommendation_unavailable else
                sum(row["recommendation"].get("shouldReorder") is True for row in rows))
            summary["recommendedProducts"] = (None if recommendation_unavailable else
                sum(row["recommendation"].get("recommendedQty", 0) > 0 for row in rows))
            overstock_unavailable = sum(row["classification"].get("overstock") is None for row in rows)
            summary["overstock"] = (None if overstock_unavailable else
                sum(row["classification"].get("overstock") is True for row in rows))
            summary["overstockUnavailableCount"] = overstock_unavailable
            summary["coverageUnavailableCount"] = sum(row["coverage"].get("daysCover") is None for row in rows)
            summary["riskUnavailableCount"] = sum(row["risk"].get("level") is None for row in rows)
            summary["riskCountsStatus"] = "PARTIAL" if summary["riskUnavailableCount"] else "AVAILABLE"
            summary["lowStockStatus"] = "PARTIAL" if summary["lowStockUnavailableCount"] else "AVAILABLE"
            if summary["lowStockUnavailableCount"]:
                summary["lowStock"] = None
            summary["recommendationUnavailableCount"] = recommendation_unavailable
            value_complete = (all(_get(products[sku], "costPriceCents") is not None for sku in products if _get(products[sku], "active", True))
                and all(row["stock"]["onHand"] is not None for row in rows))
            summary["inventoryValueCents"] = (sum(int(row["stock"]["onHand"] or 0) * int(_get(products[row["sku"]], "costPriceCents", 0)) for row in rows
                if row["stock"]["onHand"] is not None) if value_complete else None)
        return {"products": rows, "summary": summary, "abcCounts": abc_counts,
                "xyzCounts": xyz_counts, "abcXyzCounts": matrix}

    def _lead_samples(self, live):
        pair, supplier = defaultdict(list), defaultdict(list)
        purchases = {row.get("purchaseCode"): row for row in self.records.get("purchases", ())}
        for line in self.records.get("purchaseLines", ()):
            order = purchases.get(line.get("purchaseCode"))
            if not order or order.get("status") == "cancelled" or order.get("purchaseCode") in live.cancelled_transaction_keys:
                continue
            received = order.get("receivedLocalDate")
            if line.get("status") != "received" or not received or int(line.get("quantityReceived", 0)) <= 0:
                continue
            days = (date.fromisoformat(received) - date.fromisoformat(order["orderedLocalDate"])).days
            if days >= 0:
                code = str(line.get("supplierCode"))
                pair[(line.get("sku"), code)].append(float(days))
                supplier[code].append(float(days))
        for purchase in live.snapshot.purchases:
            if purchase.purchaseKey in live.cancelled_transaction_keys:
                continue
            received_day = [_local_date(effective) for event in live.snapshot.transactionChanges
                            if event.kind == "RECEIVE" and event.transactionKey == purchase.purchaseKey
                            for effective in (event.effectiveAtUtc,)]
            if not received_day:
                continue
            order_day = _local_date(purchase.orderedAtUtc)
            if purchase.receiptEvidence == "DATED_RECEIPT":
                days = float(max(0, (max(received_day) - order_day).days))
                for line in purchase.lines:
                    sku = line.sku or _get(live.products_by_key.get(line.productKey), "sku")
                    code = str(_get(live.suppliers_by_key.get(purchase.supplierKey), "supplierCode", purchase.supplierKey))
                    if sku:
                        pair[(sku, code)].append(days)
                        supplier[code].append(days)
        return pair, supplier

    @staticmethod
    def _from_m66(row, evaluated):
        row["coverage"] = {"daysCover": evaluated["coverage"]["daysCover"], "status": evaluated["coverage"]["status"]}
        row["demand"] = evaluated["demand"]
        row["forecast"] = evaluated["forecast"]
        row["inventoryPolicy"] = {**row["inventoryPolicy"], **evaluated["inventoryPolicy"], "status": "AVAILABLE"}
        row["risk"] = {**evaluated["risk"], "status": "AVAILABLE"}
        row["recommendation"] = {**evaluated["recommendation"], "status": "AVAILABLE"}
        row["classification"] = {**row["classification"], **evaluated["classification"]}
        row["supplier"] = {**row["supplier"], **evaluated["supplier"]}
        return row

    @staticmethod
    def _public_inventory(row):
        return {key: row[key] for key in ("sku", "productName", "stock", "forecast", "coverage", "demand",
            "inventoryPolicy", "risk", "classification", "recommendation", "supplier") if key in row}

    def supplier_data(self, request, live: LiveV3Context):
        key = self._key(live, "supplier", request)
        with self._lock:
            data = self._cache.get(key)
            if data is None:
                data = self._supplier_rows(live)
                self._cache[key] = data
                while len(self._cache) > 8:
                    self._cache.popitem(last=False)
        # Work on new row dictionaries so request-specific period fields never
        # mutate the cached snapshot projection.
        rows = [dict(row) for row in data["suppliers"]]
        if request.supplierCode:
            rows = [row for row in rows if row["supplierCode"] == request.supplierCode]
            if not rows:
                raise LiveDomainError("SUPPLIER_NOT_FOUND", 404, "Supplier code was not found.")
        if request.productSkus:
            known_skus = {str(row.get("sku")) for row in self.records.get("products", ())}
            known_skus.update(_get(product, "sku") for product in live.products_by_key.values() if _get(product, "sku"))
            if set(request.productSkus) - known_skus:
                raise LiveDomainError("PRODUCT_NOT_FOUND", 404, "One or more product SKUs were not found.")
            skus = set(request.productSkus)
            rows = [row for row in rows if skus.intersection(row["productsSuppliedObserved"])]
        if request.mode == "rank":
            field = {"orders": "purchaseOrderCount", "spend": "receivedSpendCents",
                     "lead_time": "leadTime.averageDays", "fastestLeadTime": "leadTime.averageDays",
                     "late_share": "punctuality.delayRatePct", "punctuality": "punctuality.onTimeRatePct",
                     "delays": "punctuality.delayedOrderCount", "productCoverage": "offeredSkuCount",
                     "exclusiveProducts": "exclusiveOfferedSkuCount"}.get(request.metric)
            if not field:
                raise LiveDomainError("DATA_NOT_AVAILABLE", 422, "This LIVE supplier ranking needs additional evidence.")
            def metric_value(row):
                value = row
                for part in field.split("."):
                    value = value.get(part) if isinstance(value, dict) else None
                return value
            ascending = request.metric in {"lead_time", "fastestLeadTime"}
            rows = sorted(rows, key=lambda row: (metric_value(row) is None,
                metric_value(row) if ascending else -(metric_value(row) or 0), row["supplierCode"]))
        page = rows[request.offset:request.offset + request.limit]
        if request.period is not None:
            start = request.period.startDate
            end = request.period.endDate
        else:
            start = date(2026, 10, 13)
            end = live.as_of_date
        if isinstance(start, date):
            start = start.isoformat()
        if isinstance(end, date):
            end = end.isoformat()
        historical_orders_in_period = defaultdict(int)
        for purchase in self.records.get("purchases", ()):
            if (purchase.get("status") != "cancelled"
                    and purchase.get("purchaseCode") not in live.cancelled_transaction_keys
                    and start <= purchase.get("orderedLocalDate", "") <= end):
                historical_orders_in_period[purchase.get("supplierCode")] += 1
        live_orders_in_period = defaultdict(int)
        for purchase in live.snapshot.purchases:
            if (purchase.purchaseKey not in live.cancelled_transaction_keys and purchase.status != "cancelled"
                    and start <= _local_date(purchase.orderedAtUtc).isoformat() <= end):
                code = str(_get(live.suppliers_by_key.get(purchase.supplierKey), "supplierCode", purchase.supplierKey))
                live_orders_in_period[code] += 1
        for row in page:
            count = historical_orders_in_period[row["supplierCode"]] + live_orders_in_period[row["supplierCode"]]
            days = (date.fromisoformat(end) - date.fromisoformat(start)).days + 1
            row["purchaseFrequency"] = {"ordersInSelectedPeriod": count,
                "ordersPer30Days": count / max(1, days) * 30}
        data_out = {"total": len(rows), "items": page,
                    "summary": {"suppliers": len(data["suppliers"]),
                        "purchaseOrders": sum(row["purchaseOrderCount"] for row in data["suppliers"]),
                        "pendingOrders": sum(row["pendingOrderCount"] for row in data["suppliers"]),
                        "receivedOrders": sum(row["receivedOrderCount"] for row in data["suppliers"]),
                        "receivedSpendCents": sum(row["receivedSpendCents"] for row in data["suppliers"]),
                        "committedSpendCents": sum(row["committedSpendCents"] for row in data["suppliers"]),
                        "pendingCommitmentCents": sum(row["pendingCommitmentCents"] for row in data["suppliers"])}}
        data_out["period"] = (request.period.model_dump(mode="json") if request.period is not None else
                               {"startDate": start, "endDate": end,
                                "timezone": "America/Lima", "metricWindow": "LIVE_OPERATIONAL_DELTA"})
        selected_codes = {row["supplierCode"] for row in rows}
        data_out["costIntelligence"] = [item for item in data.get("costIntelligence", [])
                                         if item["supplierCode"] in selected_codes]
        data_out["metricsWindow"] = {"scope": "LIFETIME_AS_OF", "asOfDate": live.as_of_date.isoformat(),
                                      "periodFiltersOrderFrequencyOnly": True}
        data_out["availabilityStatus"] = "PARTIAL" if data["insufficientEvidence"] else "AVAILABLE"
        data_out["freshness"] = {**dict(live.freshness("supplier")), "engineVersion": self.ENGINE_VERSION}
        if request.mode == "alternatives":
            data_out = {"total": len(request.productSkus), "items": self._alternatives(live, request.productSkus),
                        "availabilityStatus": "AVAILABLE",
                        "freshness": {**dict(live.freshness("supplier")), "engineVersion": self.ENGINE_VERSION}}
        elif request.mode == "dependency":
            data_out["singleSourceCriticalOrHigh"] = {"available": False,
                "reasonCode": "LIVE_FORECAST_REQUIRED", "exposures": []}
            data_out["availabilityStatus"] = "PARTIAL"
        return data_out, live.as_of_date

    def _alternatives(self, live: LiveV3Context, skus: list[str]):
        products = {str(_get(row, "sku")): row for row in self.static.get("products", ()) if _get(row, "sku")}
        for product in live.products_by_key.values():
            sku = _get(product, "sku")
            if sku:
                products[sku] = product
        missing = set(skus) - set(products)
        if missing:
            raise LiveDomainError("PRODUCT_NOT_FOUND", 404, "One or more product SKUs were not found.")
        output = []
        historical_offers = {}
        if hasattr(self.supplier_engine, "_offers"):
            historical_offers = self.supplier_engine._offers(date(2026, 10, 12))
        supplier_names = {str(_get(row, "supplierCode")): _get(row, "displayName", _get(row, "name"))
                          for row in self.static.get("suppliers", ())}
        for sku in skus:
            product = products[sku]
            projections = _get(product, "supplierOffers", None)
            if projections:
                offers = []
                for offer in projections:
                    code = str(_get(offer, "supplierKey"))
                    offers.append({"supplierCode": code, "supplierName": supplier_names.get(code, code),
                        "preferred": bool(_get(offer, "preferred", False)), "unitCostCents": _get(offer, "costCents"),
                        "currency": _get(offer, "currency"), "offerSource": "LIVE_CATALOG_PROJECTION",
                        "performanceStatus": "NOT_INFERRED"})
            else:
                offers = [{**row, "performanceStatus": "NOT_INFERRED"}
                          for row in historical_offers.get(sku, [])]
            output.append({"sku": sku, "alternatives": offers})
        return output

    def _supplier_rows(self, live: LiveV3Context):
        # Preserve historical M6.8 observations at the frozen cutoff and add only
        # explicitly dated LIVE purchase/receipt evidence.
        historical_engine = self.supplier_engine
        base_purchases = self.records.get("purchases", ())
        if any(row.get("purchaseCode") in live.cancelled_transaction_keys for row in base_purchases):
            cancelled = live.cancelled_transaction_keys
            filtered_records = {**self.supplier_engine.records,
                "purchases": [row for row in self.supplier_engine.records["purchases"] if row.get("purchaseCode") not in cancelled],
                "purchaseLines": [row for row in self.supplier_engine.records["purchaseLines"] if row.get("purchaseCode") not in cancelled]}
            historical_engine = m68.SupplierIntelligenceV3(self.supplier_engine.root, filtered_records,
                self.supplier_engine.static, self.supplier_engine.business)
        base_inventory = self.inventory_engine.snapshot(date(2026, 10, 12))
        historical = historical_engine.snapshot(as_of_date=date(2026, 10, 12),
            period="HISTORY", inventory=base_inventory)
        rows = {row["supplierCode"]: dict(row) for row in historical["suppliers"]}
        line_supplier: dict[str, str] = {}
        cost_events: list[dict[str, Any]] = []
        live_orders: dict[str, list[Any]] = defaultdict(list)
        for purchase in live.snapshot.purchases:
            if purchase.purchaseKey in live.cancelled_transaction_keys or purchase.status == "cancelled":
                continue
            supplier = str(_get(live.suppliers_by_key.get(purchase.supplierKey), "supplierCode", purchase.supplierKey))
            live_orders[supplier].append(purchase)
            for line in purchase.lines:
                line_supplier[line.lineKey] = supplier
                received_qty = int(live.received_by_purchase_line.get(line.lineKey, 0))
                sku = line.sku or _get(live.products_by_key.get(line.productKey), "sku")
                if purchase.receiptEvidence == "IMMEDIATE_PURCHASE" and sku:
                    cost_events.append({"supplierCode": supplier, "sku": sku,
                        "productName": _get(live.products_by_key.get(line.productKey), "name", sku),
                        "date": _local_date(purchase.orderedAtUtc), "units": int(line.quantityOrdered),
                        "unitCostCents": int(line.purchaseUnitCostCents), "costProvenance": "ORDER_COST",
                        "eventKey": purchase.purchaseKey})
                if received_qty and purchase.receiptEvidence != "IMMEDIATE_PURCHASE":
                    # Event time is the only valid receivedAt evidence in this snapshot contract.
                    events = [event for event in live.snapshot.transactionChanges
                              if event.kind == "RECEIVE" and event.transactionKey == purchase.purchaseKey
                              and any(change.lineKey == line.lineKey and (change.receivedQty or 0) > 0 for change in event.lineChanges)]
                    unit_cost = int(line.purchaseUnitCostCents)
                    for event in events:
                        qty = sum(int(change.receivedQty or 0) for change in event.lineChanges if change.lineKey == line.lineKey)
                        if qty:
                            cost_events.append({"supplierCode": supplier, "sku": sku,
                                "productName": _get(live.products_by_key.get(line.productKey), "name", sku),
                                "date": _local_date(event.effectiveAtUtc), "units": qty,
                                "unitCostCents": unit_cost, "costProvenance": "ORDER_COST",
                                "eventKey": event.eventKey})
        suppliers = {row["supplierCode"]: row for row in self.static.get("suppliers", ())}
        for key, contact in live.suppliers_by_key.items():
            code = str(_get(contact, "supplierCode", _get(contact, "entityKey", key)))
            suppliers.setdefault(code, {"supplierCode": code, "displayName": _get(contact, "name", code)})
            suppliers[code]["displayName"] = _get(contact, "name", suppliers[code].get("displayName", code))
        insufficient = False
        output = []
        for code, config in sorted(suppliers.items()):
            row = rows.get(code)
            if row is None:
                row = {"supplierCode": code, "displayName": config.get("displayName", code),
                       "purchaseOrderCount": 0, "receivedOrderCount": 0, "pendingOrderCount": 0,
                       "unitsOrdered": 0, "unitsReceived": 0, "receivedSpendCents": 0,
                       "committedSpendCents": 0, "pendingCommitmentCents": 0,
                       "productsSupplied": [], "productsSuppliedObserved": [],
                       "leadTimeDays": None, "delayRatePct": None,
                       "leadTime": {"sampleSize": 0, "averageDays": None, "medianDays": None,
                                    "p90Days": None, "stdDevDays": None, "sampleQuality": "INSUFFICIENT_HISTORY", "status": "INSUFFICIENT_HISTORY"},
                       "punctuality": {"onTimeOrders": None, "receivedOrders": 0, "onTimeRatePct": None,
                                       "delayedOrderCount": None, "delayRatePct": None, "sampleSize": 0,
                                       "status": "INSUFFICIENT_HISTORY"}}
            row = dict(row)
            row["displayName"] = config.get("displayName", row.get("displayName", code))
            historical_received_spend = int(row.get("receivedSpendCents", 0))
            ordered_count = received_order_count = pending_count = units_ordered = units_received = 0
            committed = pending_commitment = received_spend = 0
            product_codes = set(row.get("productsSuppliedObserved", []))
            product_codes.update(item.get("sku") for item in row.get("productsSupplied", []) if item.get("sku"))
            live_leads, live_punctual = [], []
            for purchase in live_orders.get(code, ()):
                ordered_count += 1
                ordered_day = _local_date(purchase.orderedAtUtc)
                total_cost = 0
                order_total = 0
                complete = True
                is_immediate = purchase.receiptEvidence == "IMMEDIATE_PURCHASE"
                for line in purchase.lines:
                    qty = int(line.quantityOrdered)
                    received = qty if is_immediate else int(live.received_by_purchase_line.get(line.lineKey, 0))
                    order_total += qty * int(line.purchaseUnitCostCents)
                    total_cost += received * int(line.purchaseUnitCostCents)
                    units_ordered += qty
                    units_received += received
                    if line.sku:
                        product_codes.add(line.sku)
                    complete &= received >= qty
                committed += order_total
                pending_commitment += 0 if is_immediate else max(0, order_total - total_cost)
                received_spend += total_cost
                if is_immediate:
                    received_order_count += 1
                elif complete:
                    receipt_events = [event for event in live.snapshot.transactionChanges
                                      if event.kind == "RECEIVE" and event.transactionKey == purchase.purchaseKey]
                    if receipt_events:
                        received_order_count += 1
                        if purchase.receiptEvidence == "DATED_RECEIPT":
                            received_day = max(_local_date(event.effectiveAtUtc) for event in receipt_events)
                            live_leads.append(max(0, (received_day - ordered_day).days))
                            if purchase.promisedAtUtc is not None:
                                live_punctual.append(received_day <= _local_date(purchase.promisedAtUtc))
                else:
                    pending_count += 1
            row["purchaseOrderCount"] += ordered_count
            row["receivedOrderCount"] += received_order_count
            row["pendingOrderCount"] += pending_count
            row["unitsOrdered"] += units_ordered
            row["unitsReceived"] += units_received
            row["receivedSpendCents"] += received_spend
            row["committedSpendCents"] += committed
            row["pendingCommitmentCents"] += pending_commitment
            row["productsSuppliedObserved"] = sorted(product_codes)
            row["ordersAvailability"] = "AVAILABLE"
            row["costProvenance"] = sorted(
                ({"HISTORICAL_COST"} if historical_received_spend else set())
                | ({"ORDER_COST"} if received_spend else set())) or ["UNAVAILABLE"]
            row["metricsWindow"] = "LIFETIME_AS_OF"
            # LIVE dated samples are included only when completion and actual dates exist.
            historical_n = int(row.get("leadTime", {}).get("sampleSize", 0))
            combined_leads = []
            if row.get("leadTime", {}).get("averageDays") is not None:
                combined_leads.extend([float(row["leadTime"]["averageDays"])] * historical_n)
            combined_leads.extend(live_leads)
            if combined_leads:
                row["leadTime"] = {**row["leadTime"], "sampleSize": len(combined_leads),
                    "averageDays": sum(combined_leads) / len(combined_leads),
                    "status": "AVAILABLE" if len(combined_leads) >= 5 else "INSUFFICIENT_HISTORY"}
                if live_leads and historical_n:
                    # M6.8 exposes historic distribution aggregates, not raw
                    # samples. Do not retain stale quantiles after adding LIVE
                    # observations that cannot be merged exactly.
                    row["leadTime"].update({"medianDays": None, "p90Days": None,
                        "stdDevDays": None, "sampleQuality": "PARTIAL_DISTRIBUTION_UNAVAILABLE"})
                elif live_leads:
                    row["leadTime"].update({"medianDays": median(live_leads),
                        "p90Days": (sorted(live_leads)[math.ceil(.9 * len(live_leads)) - 1]
                                    if len(live_leads) >= 5 else None),
                        "stdDevDays": pstdev(live_leads),
                        "sampleQuality": "ADEQUATE" if len(live_leads) >= 5 else "LOW_SAMPLE"})
                row["leadTimeDays"] = row["leadTime"]["averageDays"] if len(combined_leads) >= 5 else None
            elif not historical_n:
                row["leadTime"]["status"] = "INSUFFICIENT_HISTORY"
                row["leadTimeDays"] = None
            # No completion/promise evidence means punctuality stays unavailable.
            historical_punctuality = row.get("punctuality", {})
            old_samples = int(historical_punctuality.get("sampleSize", historical_punctuality.get("receivedOrders", 0)) or 0)
            old_on_time = int(historical_punctuality.get("onTimeOrders", 0) or 0)
            sample_count = old_samples + len(live_punctual)
            if sample_count:
                on_time_count = old_on_time + sum(live_punctual)
                delay_count = sample_count - on_time_count
                historical_punctuality.update({"sampleSize": sample_count, "receivedOrders": sample_count,
                    "onTimeOrders": on_time_count, "onTimeRatePct": on_time_count / sample_count * 100,
                    "delayedOrderCount": delay_count, "delayRatePct": delay_count / sample_count * 100,
                    "status": "AVAILABLE" if sample_count >= 5 else "INSUFFICIENT_HISTORY"})
            elif live_orders.get(code):
                historical_punctuality["status"] = "INSUFFICIENT_HISTORY"
                historical_punctuality["onTimeRatePct"] = None
            insufficient |= row.get("leadTime", {}).get("status") == "INSUFFICIENT_HISTORY"
            output.append(row)
        total_received_spend = sum(int(row.get("receivedSpendCents", 0)) for row in output)
        total_committed_spend = sum(int(row.get("committedSpendCents", 0)) for row in output)
        for row in output:
            row["purchaseSpendSharePct"] = (round(row["receivedSpendCents"] / total_received_spend * 100, 4)
                                            if total_received_spend else None)
            row["committedSpendSharePct"] = (round(row["committedSpendCents"] / total_committed_spend * 100, 4)
                                             if total_committed_spend else None)
        cost_intelligence = self._combine_cost_intelligence(historical.get("costIntelligence", []), cost_events)
        for item in cost_intelligence:
            item["supplierName"] = suppliers.get(item["supplierCode"], {}).get("displayName", item["supplierCode"])
        return {"suppliers": output, "costIntelligence": cost_intelligence,
                "insufficientEvidence": insufficient}

    @staticmethod
    def _combine_cost_intelligence(historical_rows, events):
        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        for row in historical_rows:
            key = (row["supplierCode"], row["sku"])
            grouped[key] = {"supplierCode": row["supplierCode"], "supplierName": row.get("supplierName"),
                "sku": row["sku"], "productName": row.get("productName"),
                "receiptCount": int(row.get("receiptCount", 0)), "units": int(row.get("unitsReceived", 0)),
                "weightedCost": float(row.get("averagePurchaseCostCentsWeighted") or 0) * int(row.get("unitsReceived", 0)),
                "minimum": row.get("minimumObservedCostCents"), "maximum": row.get("maximumObservedCostCents"),
                "firstDate": row.get("firstObservedDate"), "firstCost": row.get("latestPurchaseCostCents"),
                "latestDate": row.get("latestObservedDate"), "latestCost": row.get("latestPurchaseCostCents"),
                "baselineRecentChangePct": row.get("recentChangePct"), "baselineLatestCost": row.get("latestPurchaseCostCents"),
                "liveFirstCost": None, "liveLatestCost": None, "liveEventCount": 0,
                "costProvenance": {"HISTORICAL_COST"}}
        for event in sorted(events, key=lambda row: (row["supplierCode"], row["sku"],
                                                       row["date"], row["eventKey"])):
            key = (event["supplierCode"], event["sku"])
            bucket = grouped.setdefault(key, {"supplierCode": event["supplierCode"], "supplierName": None,
                "sku": event["sku"], "productName": event["productName"], "receiptCount": 0,
                "units": 0, "weightedCost": 0.0, "minimum": None, "maximum": None,
                "firstDate": None, "firstCost": None, "latestDate": None, "latestCost": None,
                "baselineRecentChangePct": None, "baselineLatestCost": None,
                "liveFirstCost": None, "liveLatestCost": None, "liveEventCount": 0,
                "costProvenance": set()})
            amount = int(event["unitCostCents"])
            qty = int(event["units"])
            bucket["receiptCount"] += 1
            bucket["liveEventCount"] += 1
            if bucket["liveFirstCost"] is None:
                bucket["liveFirstCost"] = amount
            bucket["liveLatestCost"] = amount
            bucket["units"] += qty
            bucket["weightedCost"] += amount * qty
            bucket["minimum"] = amount if bucket["minimum"] is None else min(bucket["minimum"], amount)
            bucket["maximum"] = amount if bucket["maximum"] is None else max(bucket["maximum"], amount)
            if bucket["firstDate"] is None or event["date"].isoformat() < bucket["firstDate"]:
                bucket["firstDate"], bucket["firstCost"] = event["date"].isoformat(), amount
            if bucket["latestDate"] is None or event["date"].isoformat() >= bucket["latestDate"]:
                bucket["latestDate"], bucket["latestCost"] = event["date"].isoformat(), amount
            bucket["costProvenance"].add(event["costProvenance"])
        result = []
        for (_, _), bucket in sorted(grouped.items()):
            first, latest = bucket["firstCost"], bucket["latestCost"]
            result.append({"supplierCode": bucket["supplierCode"], "supplierName": bucket["supplierName"],
                "sku": bucket["sku"], "productName": bucket["productName"],
                "receiptCount": bucket["receiptCount"], "unitsReceived": bucket["units"],
                "latestPurchaseCostCents": latest,
                "averagePurchaseCostCentsWeighted": round(bucket["weightedCost"] / bucket["units"], 4) if bucket["units"] else None,
                "minimumObservedCostCents": bucket["minimum"], "maximumObservedCostCents": bucket["maximum"],
                "firstObservedDate": bucket["firstDate"], "latestObservedDate": bucket["latestDate"],
                "recentChangePct": (round((bucket["liveLatestCost"] - bucket["baselineLatestCost"]) /
                    bucket["baselineLatestCost"] * 100, 4) if bucket["liveEventCount"] and bucket["baselineLatestCost"]
                    else round((bucket["liveLatestCost"] - bucket["liveFirstCost"]) /
                    bucket["liveFirstCost"] * 100, 4) if bucket["liveEventCount"] > 1 and bucket["liveFirstCost"]
                    else bucket["baselineRecentChangePct"] if not bucket["liveEventCount"] else None),
                "costProvenance": sorted(bucket["costProvenance"]),
                "interpretation": "Observed acquisition costs only; pending order prices are excluded from cost trends."})
        return result


__all__ = ["LiveInventorySupplierAdapter"]
