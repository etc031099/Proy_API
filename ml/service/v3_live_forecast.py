"""Approved MA28 forecasting over certified closed-day LIVE observations."""
from __future__ import annotations

from collections import OrderedDict
from datetime import date, timedelta
from threading import RLock
from typing import Any

from ml.service.v3_live_business_customer import LiveDomainError
from ml.service.v3_live_context import LiveV3Context
from ml.src import v3_baseline_bundle, v3_forecast


class LiveForecastAdapter:
    ENGINE_VERSION = "m6.9f4e-live-ma28-v1"
    HISTORY_CUTOFF = v3_forecast.HISTORY_END

    def __init__(self, dataset, records):
        self.dataset, self.records = dataset, records
        self._cache: OrderedDict[tuple[str, ...], dict[str, Any]] = OrderedDict()
        self._lock = RLock()

    def _key(self, live: LiveV3Context, request) -> tuple[str, ...]:
        meta = live.snapshot.metadata
        return (meta.businessId, meta.scenarioId, live.data_version, live.context_hash,
                live.as_of_date.isoformat(), str(getattr(request, "horizonDays", 7)),
                str(getattr(request, "categoryCode", None)), str(getattr(request, "subcategoryCode", None)),
                repr(tuple(getattr(request, "skus", ()) or ())), self.ENGINE_VERSION)

    def forecast_data(self, request, live: LiveV3Context):
        horizon = request.horizonDays
        if horizon not in v3_forecast.PRIMARY_HORIZONS:
            raise LiveDomainError("UNSUPPORTED_HORIZON", 422,
                                  "Only approved 1, 7, and 14 day horizons are supported.")
        if request.mode in {"detail", "compare"} and not request.skus:
            raise LiveDomainError("AMBIGUOUS_ENTITY", 409, "A resolved product SKU is required for forecast detail.")
        key = self._key(live, request)
        with self._lock:
            cached = self._cache.get(key)
            if cached is None:
                cached = self._calculate(live, request)
                self._cache[key] = cached
                while len(self._cache) > 8:
                    self._cache.popitem(last=False)
            else:
                self._cache.move_to_end(key)
            # Values are not mutated below; response filtering creates a fresh list.
            rows = cached["items"]

        skus = set(request.skus or ())
        if skus:
            unknown = skus - set(self.dataset.product_by_sku) - set(live.products_by_sku)
            if unknown:
                raise LiveDomainError("PRODUCT_NOT_FOUND", 404, "One or more product SKUs were not found.")
            rows = [row for row in rows if row["sku"] in skus]
        if (request.mode in {"detail", "compare"} and any(row["status"] != "READY" for row in rows)
                and not request.includeObservedSeries):
            raise LiveDomainError("INSUFFICIENT_HISTORY", 422,
                                  "The selected product does not have 28 consecutive certified closed-day observations.")
        key_field = f"expectedUnitsNext{horizon}d"
        ready_rows = [row for row in rows if row["status"] == "READY"]
        missing_count = len(rows) - len(ready_rows)
        if request.mode == "rank":
            ready_rows.sort(key=lambda row: (-(row.get(key_field) or 0), row["sku"]))
            unavailable_rows = sorted((row for row in rows if row["status"] != "READY"), key=lambda row: row["sku"])
            ranked = ready_rows + unavailable_rows
            total = len(ranked)
            items = ranked[request.offset:request.offset + request.limit]
            data = {"mode": "rank", "horizonDays": horizon, "metric": key_field,
                    "total": total, "items": items}
        elif request.mode == "summary":
            data = {"mode": "summary", "horizonDays": horizon, "products": len(ready_rows),
                    "missingCount": missing_count,
                    "totalExpectedUnits": round(sum(float(row[key_field]) for row in ready_rows), 4)}
        else:
            data = {"mode": request.mode, "horizonDays": horizon, "total": len(rows),
                    "items": rows[request.offset:request.offset + request.limit]}
        data.update({"availabilityStatus": "PARTIAL" if missing_count else "AVAILABLE",
                     "coverage": {"knownCount": len(ready_rows), "missingCount": missing_count,
                                  "windowRule": "28 consecutive calendar days certified CLOSED through asOfDate-1"},
                     "freshness": self._freshness(live, [row["observationsThrough"] for row in rows])})
        return data, live.as_of_date

    def all_forecasts(self, live: LiveV3Context) -> list[dict[str, Any]]:
        """One same-context 1/7/14 result set for inventory and health composition."""
        from types import SimpleNamespace
        request = SimpleNamespace(horizonDays=7, categoryCode=None, subcategoryCode=None,
                                  skus=[], mode="summary", offset=0, limit=100)
        key = self._key(live, request)
        with self._lock:
            cached = self._cache.get(key)
            if cached is None:
                cached = self._calculate(live, request)
                self._cache[key] = cached
            return [dict(row) for row in cached["items"]]

    def _calculate(self, live: LiveV3Context, request) -> dict[str, Any]:
        cutoff = live.as_of_date
        through = min(cutoff - timedelta(days=1), live.snapshot.metadata.observationsClosedThrough)
        # Historical rows are exact calendar days and remain frozen. A post-cutoff
        # cancellation is projected back to its original stable saleCode/line date.
        cancelled_units: dict[tuple[str, str], int] = {}
        if live.cancelled_transaction_keys:
            cancelled_sales = live.cancelled_transaction_keys
            sale_dates = {row.get("saleCode"): row.get("localDate") for row in self.records.get("sales", ())
                          if row.get("saleCode") in cancelled_sales}
            for line in self.records.get("saleItems", ()):
                code = line.get("saleCode")
                if code in sale_dates and line.get("transactionStatus") == "completed":
                    sku = line.get("sku")
                    if sku:
                        identity = (sku, sale_dates[code])
                        cancelled_units[identity] = cancelled_units.get(identity, 0) + int(line.get("unitsSold", 0))

        closed_by_sku_day = {}
        for (product_key, day), item in live.closed_sales_by_product_day.items():
            sku = getattr(live.products_by_key.get(product_key), "sku", None)
            if sku is None and isinstance(live.products_by_key.get(product_key), dict):
                sku = live.products_by_key[product_key].get("sku")
            if sku:
                closed_by_sku_day[(sku, day)] = item

        product_skus = set(self.dataset.product_by_sku) | set(live.products_by_sku)
        selected = set(request.skus or ())
        category_code = getattr(request, "categoryCode", None)
        subcategory_code = getattr(request, "subcategoryCode", None)
        if category_code or subcategory_code:
            selected = {sku for sku in product_skus
                        if ((not category_code or self._product(live, sku).get("categoryCode") == category_code)
                            and (not subcategory_code or self._product(live, sku).get("subcategoryCode") == subcategory_code))}
        if not selected:
            selected = product_skus
        items = []
        observations = []
        for sku in sorted(selected):
            product = self._product(live, sku)
            created = self._effective_creation_date(live, product)
            days = [through - timedelta(days=offset) for offset in range(27, -1, -1)]
            history_map = self.dataset.inventory.get(sku, {})
            values = []
            observed_series = []
            missing = False
            for day in days:
                if created and day < created:
                    missing = True
                    observed_series.append({"date": day.isoformat(), "units": None, "status": "MISSING"})
                    continue
                if day <= self.HISTORY_CUTOFF:
                    row = history_map.get(day.isoformat())
                    if row is None:
                        missing = True
                        observed_series.append({"date": day.isoformat(), "units": None, "status": "MISSING"})
                        continue
                    units = int(row["unitsSold"]) - cancelled_units.get((sku, day.isoformat()), 0)
                    units = max(0, units)
                    values.append(units)
                    status = "PARTIAL" if row.get("completeness") == "PARTIAL" else ("ZERO" if units == 0 else "CLOSED")
                    observed_series.append({"date": day.isoformat(), "units": units, "status": status})
                else:
                    row = closed_by_sku_day.get((sku, day))
                    if row is None:
                        # Never infer a zero from a missing certification row.
                        missing = True
                        observed_series.append({"date": day.isoformat(), "units": None, "status": "MISSING"})
                        continue
                    units = int(row.unitsSold if hasattr(row, "unitsSold") else row["unitsSold"])
                    values.append(units)
                    completeness = row.completeness if hasattr(row, "completeness") else row.get("completeness")
                    status = "PARTIAL" if completeness != "COMPLETE" else ("ZERO" if units == 0 else "CLOSED")
                    observed_series.append({"date": day.isoformat(), "units": units, "status": status})
            status = "READY" if not missing and len(values) == 28 else ("COLD_START" if sku not in self.dataset.product_by_sku else "INSUFFICIENT_HISTORY")
            record = {"scenarioId": v3_forecast.SCENARIO_ID, "sku": sku, "status": status,
                      "cutoffDate": cutoff.isoformat(), "timezone": "America/Lima",
                      "modelVersion": v3_forecast.MODEL_VERSION,
                      "targetDefinition": "effective_units_sold_cumulative_t_plus_1_through_t_plus_h",
                      "forecastSource": "MOVING_AVERAGE_28", "strategyVersion": v3_baseline_bundle.STRATEGY_VERSION,
                      "observationsThrough": through.isoformat(), "forecastStartDate": cutoff.isoformat(),
                      "confidence": None, "predictionInterval": None}
            if request.includeObservedSeries:
                record["observedSeries"] = observed_series
            for h in v3_forecast.PRIMARY_HORIZONS:
                record[f"expectedUnitsNext{h}d"] = h * (sum(values) / 28) if status == "READY" else None
            if status == "READY":
                record["expectedUnitsNext7d"] = max(record["expectedUnitsNext7d"], record["expectedUnitsNext1d"])
                record["expectedUnitsNext14d"] = max(record["expectedUnitsNext14d"], record["expectedUnitsNext7d"])
            record["horizonMetadata"] = [{"horizonDays": h, "forecastStart": cutoff.isoformat(),
                "forecastEnd": (cutoff + timedelta(days=h - 1)).isoformat(),
                "qualityStatus": "APPROVED" if status == "READY" else status,
                "forecastSource": "MOVING_AVERAGE_28", "modelVersion": v3_forecast.MODEL_VERSION,
                "coherenceAdjustment": "applied across cumulative horizons"}
                for h in v3_forecast.PRIMARY_HORIZONS]
            record["forecast"] = {f"expectedUnitsNext{h}d": record[f"expectedUnitsNext{h}d"]
                                   for h in v3_forecast.PRIMARY_HORIZONS}
            record["coverage"] = {"requiredCalendarDays": 28, "observedDays": len(values), "status": status}
            items.append(record)
            if status == "READY":
                observations.append(through.isoformat())
        return {"items": items, "observations": observations}

    @staticmethod
    def _product(live: LiveV3Context, sku: str) -> dict[str, Any]:
        product = live.products_by_sku.get(sku)
        if product is None:
            return {}
        return product if isinstance(product, dict) else {name: getattr(product, name, None)
            for name in ("sku", "categoryCode", "subcategoryCode", "productKey", "name", "active")}

    @staticmethod
    def _effective_creation_date(live: LiveV3Context, product: dict[str, Any]):
        product_key = product.get("productKey")
        changes = [row for row in live.snapshot.catalogChanges
                   if row.entityType == "product" and row.projection.after.productKey == product_key]
        if not changes:
            return None
        first = min(changes, key=lambda row: (row.effectiveAtUtc, int(row.revision)))
        return first.effectiveAtUtc.astimezone(__import__("zoneinfo").ZoneInfo("America/Lima")).date()

    def _freshness(self, live, observations):
        return {**dict(live.freshness("forecast")), "engineVersion": self.ENGINE_VERSION,
                "forecastSource": "MOVING_AVERAGE_28", "strategyVersion": v3_baseline_bundle.STRATEGY_VERSION,
                "forecastStartDate": live.as_of_date.isoformat(),
                "observationsThrough": max(observations) if observations else None,
                "horizons": [1, 7, 14]}


__all__ = ["LiveForecastAdapter"]
