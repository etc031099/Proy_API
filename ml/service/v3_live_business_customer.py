"""Business and customer adapters over the immutable, backend-owned LIVE snapshot."""
from __future__ import annotations

from copy import deepcopy
from collections import OrderedDict
from datetime import date
from math import isfinite
from threading import RLock
from typing import Any

from ml.service.v3_live_context import LiveV3Context
from ml.src import business_customer_supplier_v3 as m68


class LiveDomainError(Exception):
    def __init__(self, code: str, status_code: int, message: str):
        super().__init__(message)
        self.code, self.status_code, self.message = code, status_code, message


class LiveBusinessCustomerAdapter:
    """Build a small, bounded M6.8 view per snapshot revision; never mutate frozen inputs."""

    ENGINE_VERSION = "m6.9f4c-live-business-customer-v1"

    def __init__(self, root, records: dict[str, Any], static: dict[str, Any], historical_business):
        self.root, self.records, self.static = root, records, static
        self.historical_business = historical_business
        self._views: OrderedDict[tuple[str, ...], tuple[Any, Any, dict[str, Any]]] = OrderedDict()
        self._customer_results: OrderedDict[tuple[str, ...], dict[str, Any]] = OrderedDict()
        self._business_results: OrderedDict[tuple[str, ...], dict[str, Any]] = OrderedDict()
        self._lock = RLock()

    @staticmethod
    def _field(value, name: str, default=None):
        if isinstance(value, dict):
            return value.get(name, default)
        return getattr(value, name, default)

    def _view(self, live: LiveV3Context, cutoff: date):
        key = (live.snapshot.metadata.businessId, live.snapshot.metadata.scenarioId,
               self.ENGINE_VERSION, live.data_version, live.context_hash, cutoff.isoformat())
        with self._lock:
            if key in self._views:
                self._views.move_to_end(key)
                return self._views[key]

            cancelled = live.cancelled_transaction_keys
            base_sales, base_lines = self.historical_business._sales(date(2026, 10, 12))
            sales = [row for row in base_sales if row["saleCode"] not in cancelled]
            lines_by_sale = {code: rows for code, rows in base_lines.items() if code not in cancelled}
            for sale in live.snapshot.sales:
                if sale.initialStatus != "completed" or sale.saleKey in cancelled or sale.localDate > cutoff:
                    continue
                code = sale.saleKey
                customer = live.customers_by_key.get(sale.customerKey) if sale.customerKey else None
                customer_code = (self._field(customer, "customerCode")
                                 or self._field(customer, "entityKey")) if customer else None
                sales.append({"saleCode": code, "localDate": sale.localDate.isoformat(),
                              "customerCode": customer_code,
                              "totalCents": int(sale.totalCents), "ticketDiscountCents": 0,
                              "itemDiscountCents": 0, "currency": sale.currency, "status": "completed"})
                normalized_lines = []
                for line in sale.lines:
                    if not line.sku:
                        raise ValueError("LIVE business analytics require a resolved SKU for each sold product.")
                    normalized_lines.append({"saleCode": code, "saleLineKey": line.lineKey, "sku": line.sku,
                                             "productKey": line.productKey, "unitsSold": int(line.quantity),
                                             "lineTotalCents": int(line.lineTotalCents), "transactionStatus": "completed",
                                             "costAtSaleCents": int(line.unitCostAtSaleCents) if line.costKnown else 0,
                                             "costKnown": bool(line.costKnown), "currency": sale.currency,
                                             "promotionCode": "LIVE_PROMO" if line.promo else None})
                lines_by_sale[code] = normalized_lines

            products = [dict(row) for row in self.static["products"]]
            product_by_sku = {row["sku"]: row for row in products}
            for product in live.products_by_key.values():
                sku = product.get("sku") if isinstance(product, dict) else getattr(product, "sku", None)
                if not sku:
                    continue
                get = product.get if isinstance(product, dict) else lambda k, default=None: getattr(product, k, default)
                category_code = get("categoryCode")
                if category_code not in {row["code"] for row in self.static["categories"]["categories"]}:
                    category_code = "__UNCLASSIFIED__"
                subcategory_code = get("subcategoryCode")
                valid_subcategories = {sub["code"] for category in self.static["categories"]["categories"]
                                       for sub in category["subcategories"]}
                if subcategory_code not in valid_subcategories:
                    subcategory_code = "__UNCLASSIFIED__"
                row = {"sku": sku, "name": get("name", sku), "presentation": get("presentation"),
                       "sizeValue": get("sizeValue"), "sizeUnit": get("sizeUnit"),
                       "categoryCode": category_code,
                       "subcategoryCode": subcategory_code,
                       "active": bool(get("active", True))}
                if sku in product_by_sku:
                    product_by_sku[sku].update(row)
                else:
                    products.append(row)
                    product_by_sku[sku] = row
            live_static = {**self.static, "products": products}
            view_records = {"sales": sales, "saleItems": [line for values in lines_by_sale.values() for line in values]}
            business = m68.BusinessIntelligenceV3(self.root, view_records, live_static)
            business.sales_by_asof[cutoff] = (sorted(sales, key=lambda row: (row["localDate"], row["saleCode"])), lines_by_sale)

            customers = [dict(row) for row in self.static["customers"]]
            by_code = {row["customerCode"]: row for row in customers}
            live_customer_codes = set()
            for key, contact in live.customers_by_key.items():
                get = contact.get if isinstance(contact, dict) else lambda k, default=None: getattr(contact, k, default)
                code = get("customerCode") or get("entityKey") or key
                if code not in by_code:
                    row = {"customerCode": code, "displayName": get("name", code), "customerProfileKey": None}
                    customers.append(row)
                    by_code[code] = row
                    live_customer_codes.add(code)
                else:
                    # Names are as-of catalog data; profile fields remain the frozen, post-hoc audit only.
                    by_code[code]["displayName"] = get("name", by_code[code]["displayName"])
            customer_static = {**live_static, "customers": customers}
            customer = m68.CustomerIntelligenceV3(self.root, view_records, customer_static, business,
                                                   customers=customers)
            view = (business, customer, {"sales": sales, "linesBySale": lines_by_sale,
                                         "liveCustomerCodes": frozenset(live_customer_codes)})
            self._views[key] = view
            while len(self._views) > 2:
                self._views.popitem(last=False)
            return view

    @staticmethod
    def _period(request, cutoff: date):
        if request.period is None:
            return "LAST_30_DAYS"
        if request.period.startDate > request.period.endDate or request.period.endDate > cutoff:
            raise ValueError("Period is after the LIVE as-of date or has an invalid order.")
        return {"startDate": request.period.startDate.isoformat(), "endDate": request.period.endDate.isoformat()}

    @staticmethod
    def _public_customer(row: dict[str, Any]) -> dict[str, Any]:
        allowed = ("customerCode", "displayName", "firstPurchaseDate", "lastPurchaseDate", "recencyDays",
                   "ticketCount", "units", "totalSpentCents", "averageTicketCents", "grossMarginContributionCents",
                   "segment", "reasonCodes", "historyStatus", "windows", "trends30d", "preferences", "rfm90d")
        return {key: row[key] for key in allowed if key in row}

    @staticmethod
    def _mask_customer_costs(value):
        cost_fields = {"grossMarginCents", "grossMarginContributionCents", "grossMarginPct",
                       "grossMargin", "grossMarginContribution", "cogsCents", "cogs"}
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if key in cost_fields:
                    if isinstance(item, dict):
                        result[key] = {**item, "value": None, "previousValue": None,
                            "absoluteChange": None, "percentChange": None,
                            "comparisonAvailable": False, "comparisonWarning": "COST_NOT_AVAILABLE"}
                    else:
                        result[key] = None
                else:
                    result[key] = LiveBusinessCustomerAdapter._mask_customer_costs(item)
            return result
        if isinstance(value, list):
            return [LiveBusinessCustomerAdapter._mask_customer_costs(item) for item in value]
        return value

    @staticmethod
    def _coverage(sales, lines_by_sale, period, cutoff: date, *, customer_code=None, product_sku=None,
                  category_code=None, subcategory_code=None, products=None):
        window = m68.resolve_period(period, cutoff, allow_live=True)
        unknown = known = 0
        unsupported_currency = False
        for sale in sales:
            if not m68._period_contains(sale, window):
                continue
            if customer_code is not None and sale.get("customerCode") != customer_code:
                continue
            for line in lines_by_sale.get(sale["saleCode"], ()):
                product = products.get(line["sku"], {}) if products else {}
                if product_sku and line["sku"] != product_sku:
                    continue
                if category_code and product.get("categoryCode") != category_code:
                    continue
                if subcategory_code and product.get("subcategoryCode") != subcategory_code:
                    continue
                known += int(line.get("costKnown", "costAtSaleCents" in line))
                unknown += int(not line.get("costKnown", "costAtSaleCents" in line))
                unsupported_currency |= sale.get("currency", "PEN") != "PEN"
        return {"knownSaleLines": known, "unknownSaleLines": unknown,
                "status": "AVAILABLE" if unknown == 0 else "NOT_AVAILABLE",
                "reasonCode": None if unknown == 0 else "COST_NOT_AVAILABLE",
                "unsupportedCurrency": unsupported_currency}

    @staticmethod
    def _coverage_diagnostic(coverage_by_customer, reason_code):
        affected = [value for value in coverage_by_customer.values() if value["unknownSaleLines"] > 0]
        return {"code": reason_code, "affectedCustomerCount": len(affected),
                "unknownSaleLineCount": sum(value["unknownSaleLines"] for value in affected)}

    @staticmethod
    def _customer_general_complete(row):
        def nonnegative(value):
            return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value) and value >= 0
        return (all(nonnegative(row.get(key)) for key in ("ticketCount", "units", "totalSpentCents"))
                and bool(row.get("segment"))
                and (row.get("ticketCount") == 0 or nonnegative(row.get("recencyDays"))))

    @staticmethod
    def _aggregate_cost_coverage(coverage_by_customer):
        unknown = sum(value["unknownSaleLines"] for value in coverage_by_customer.values())
        return {"status": "PARTIAL" if unknown else "AVAILABLE",
                "knownSaleLines": sum(value["knownSaleLines"] for value in coverage_by_customer.values()),
                "unknownSaleLines": unknown,
                "affectedCustomerCount": sum(value["unknownSaleLines"] > 0 for value in coverage_by_customer.values())}

    def business_data(self, request, live: LiveV3Context):
        cutoff = live.as_of_date
        business, _, views = self._view(live, cutoff)
        period = self._period(request, cutoff)
        if request.productSku and request.productSku not in business.products:
            raise LiveDomainError("PRODUCT_NOT_FOUND", 404, "Product SKU was not found.")
        if request.categoryCode and request.categoryCode not in business.categories:
            raise LiveDomainError("SCENARIO_NOT_SUPPORTED", 422, "Category is not part of the approved scenario.")
        if request.subcategoryCode and request.subcategoryCode not in {row.get("subcategoryCode") for row in business.products.values()}:
            raise LiveDomainError("SCENARIO_NOT_SUPPORTED", 422, "Subcategory is not part of the approved scenario.")
        business_key = (live.snapshot.metadata.businessId, live.snapshot.metadata.scenarioId,
            live.data_version, live.context_hash, cutoff.isoformat(), self.ENGINE_VERSION,
            repr((period, request.mode, request.categoryCode,
            request.subcategoryCode, request.productSku, request.entityType, request.metric)))
        with self._lock:
            result = self._business_results.get(business_key)
            if result is None:
                result = business.summary(period, as_of_date=cutoff, category_code=request.categoryCode,
                    subcategory_code=request.subcategoryCode, product_sku=request.productSku,
                    comparison_mode="EQUIVALENT_PREVIOUS" if request.mode == "compare" else "NONE",
                    allow_live=True)
                self._business_results[business_key] = result
                while len(self._business_results) > 32:
                    self._business_results.popitem(last=False)
            else:
                self._business_results.move_to_end(business_key)
            result = deepcopy(result)
        coverage = self._coverage(views["sales"], views["linesBySale"], period, cutoff,
                                  product_sku=request.productSku, category_code=request.categoryCode,
                                  subcategory_code=request.subcategoryCode, products=business.products)
        if coverage["unsupportedCurrency"]:
            raise LiveDomainError("DATA_NOT_AVAILABLE", 422, "LIVE monetary analytics currently support PEN only.")
        previous_coverage = None
        if request.mode == "compare" and result.get("previousPeriod"):
            prior_range = {"startDate": result["previousPeriod"]["startDate"],
                           "endDate": result["previousPeriod"]["endDate"]}
            previous_coverage = self._coverage(views["sales"], views["linesBySale"], prior_range, cutoff,
                product_sku=request.productSku, category_code=request.categoryCode,
                subcategory_code=request.subcategoryCode, products=business.products)
        partial = coverage["unknownSaleLines"] > 0 or bool(previous_coverage and previous_coverage["unknownSaleLines"])
        if coverage["unsupportedCurrency"] or (previous_coverage and previous_coverage["unsupportedCurrency"]):
            raise LiveDomainError("DATA_NOT_AVAILABLE", 422, "LIVE monetary analytics currently support PEN only.")
        if partial:
            kpis = result["kpis"]
            for key in ("grossMargin", "grossMarginCents", "grossMarginPct", "cogs", "cogsCents"):
                kpis[key] = None
            for key in ("grossMargin", "grossMarginPct"):
                result["trends"][key] = {"value": None, "previousValue": None, "absoluteChange": None,
                                         "percentChange": None, "comparisonAvailable": False,
                                         "comparableDurations": True, "comparisonWarning": "COST_NOT_AVAILABLE"}
            result["marginIntelligence"] = {"available": False, "reasonCode": "COST_NOT_AVAILABLE",
                                             "cogsCents": None, "grossMarginCents": None,
                                             "grossMarginPct": None, "highMarginProducts": [],
                                             "highRevenueLowMargin": [], "lowRevenueHighMargin": []}
            for row in result["categoryIntelligence"]:
                row["grossMarginCents"] = None
                row["trends"]["grossMarginCents"] = {"value": None, "previousValue": None,
                    "absoluteChange": None, "percentChange": None, "comparisonAvailable": False,
                    "comparableDurations": True, "comparisonWarning": "COST_NOT_AVAILABLE"}
            result["rankings"]["grossMargin"] = []
        if request.mode == "rank":
            if request.metric == "gross_margin" and partial:
                data = {"metric": "grossMargin", "available": False, "reasonCode": "COST_NOT_AVAILABLE",
                        "coverage": coverage, "total": 0, "items": []}
            elif request.entityType == "category":
                metric = {"revenue": "revenueCents", "units": "units", "gross_margin": "grossMarginCents",
                          "tickets": "ticketCount"}.get(request.metric or "revenue")
                items = [row for row in result["categoryIntelligence"] if not request.categoryCode or row["categoryCode"] == request.categoryCode]
                items.sort(key=lambda row: (-(row.get(metric) or 0), row["categoryCode"]))
                data = {"entityType": "category", "metric": metric, "total": len(items),
                        "items": items[request.offset:request.offset + request.limit], "period": result["period"]}
            else:
                metric = {"gross_margin": "grossMargin", "tickets": "ticketFrequency"}.get(request.metric, request.metric or "revenue")
                items = result["rankings"].get(metric, [])
                data = {"metric": metric, "total": len(items), "items": items[request.offset:request.offset + request.limit],
                        "period": result["period"], "currency": "PEN"}
        else:
            data = {key: result[key] for key in ("contractVersion", "scenarioId", "datasetVersion", "datasetSha256",
                   "asOfDate", "timezone", "period", "comparisonMode", "previousPeriod", "kpis", "trends",
                   "customerMix", "filters", "marginIntelligence", "ticketIntelligence", "sourceCounts")}
        data["availabilityStatus"] = "PARTIAL" if partial else "AVAILABLE"
        data["costCoverage"] = coverage
        selected_period = m68.resolve_period(period, cutoff, allow_live=True)
        unclassified = [line for sale in views["sales"] if m68._period_contains(sale, selected_period)
                        for line in views["linesBySale"].get(sale["saleCode"], ())
                        if business.products.get(line["sku"], {}).get("categoryCode") == "__UNCLASSIFIED__"]
        data["classificationCoverage"] = {"unclassifiedSaleLines": len(unclassified),
                                           "status": "PARTIAL" if unclassified else "COMPLETE"}
        if previous_coverage is not None:
            data["comparisonCostCoverage"] = previous_coverage
        freshness = dict(live.freshness("business"))
        freshness["engineVersion"] = self.ENGINE_VERSION
        data["freshness"] = freshness
        return data, cutoff

    def provisional_anomaly(self, live: LiveV3Context):
        from ml.service.sales_anomalies import provisional_daily_inference
        from ml.src.sales_isolation_forest_v3 import aggregate_daily_sales
        from ml.service.v3_schemas import BUSINESS_ID, SCENARIO_ID, DATASET_VERSION
        metadata = live.snapshot.metadata
        if metadata.businessId != BUSINESS_ID or metadata.scenarioId != SCENARIO_ID:
            raise LiveDomainError("TENANT_MISMATCH", 403, "Provisional evaluation context is not authorized.")
        day = live.as_of_date.isoformat()
        business, _, views = self._view(live, live.as_of_date)
        period = {"startDate": day, "endDate": day}
        try:
            daily = aggregate_daily_sales(views["sales"], views["linesBySale"], day)
        except (KeyError, ValueError, TypeError):
            daily = {"revenueCents": -1, "tickets": -1, "units": -1, "unsupportedCurrency": False}
        try:
            result = provisional_daily_inference(self.root, local_date=day,
                expected_date=metadata.operationalDate.isoformat(), revenue_cents=daily["revenueCents"],
                tickets=daily["tickets"], units=daily["units"],
                currency="UNSUPPORTED" if daily["unsupportedCurrency"] else "PEN")
        except (FileNotFoundError, KeyError, ValueError):
            raise LiveDomainError("ARTIFACT_UNAVAILABLE", 503, "Frozen anomaly artifact is unavailable.") from None
        coverage = self._coverage(views["sales"], views["linesBySale"], period, live.as_of_date)
        margin = None
        if result["aggregate"] is not None:
            aggregate = m68._sales_aggregates(views["sales"], views["linesBySale"], business.products,
                m68.resolve_period(period, live.as_of_date, allow_live=True))
            available = coverage["unknownSaleLines"] == 0
            margin = {"value": aggregate["grossMarginCents"] / 100 if available else None,
                      "currency": "PEN" if available else None,
                      "percent": aggregate["grossMarginPct"] if available else None,
                      "availability": "AVAILABLE" if available else "PARTIAL"}
        result.update(revision=live.data_version, observedAt=metadata.capturedAtUtc.isoformat(),
            businessContext={"businessId": metadata.businessId, "scenarioId": metadata.scenarioId,
                             "datasetVersion": DATASET_VERSION},
            commercial={"grossMargin": margin, "costCoverage": {key: coverage[key]
                for key in ("knownSaleLines", "unknownSaleLines", "status")}})
        return result, live.as_of_date

    def customer_data(self, request, live: LiveV3Context):
        cutoff = live.as_of_date
        _, customer_engine, views = self._view(live, cutoff)
        period = self._period(request, cutoff) if request.period is not None else None
        snapshot_key = (live.snapshot.metadata.businessId, live.snapshot.metadata.scenarioId,
                        live.data_version, live.context_hash, cutoff.isoformat(), self.ENGINE_VERSION)
        with self._lock:
            result = self._customer_results.get(snapshot_key)
            if result is None:
                result = customer_engine.snapshot(as_of_date=cutoff, allow_live=True)
                self._customer_results[snapshot_key] = result
                while len(self._customer_results) > 2:
                    self._customer_results.popitem(last=False)
            else:
                self._customer_results.move_to_end(snapshot_key)
            result = deepcopy(result)
        live_customer_codes = views["liveCustomerCodes"]
        for row in result["customers"]:
            if row["customerCode"] in live_customer_codes and row["firstPurchaseDate"] is None:
                row["segment"] = "INSUFFICIENT_HISTORY"
                row["reasonCodes"] = ["NO_PURCHASE_HISTORY"]
                row["historyStatus"] = "INSUFFICIENT_HISTORY"
                row["rfm90d"] = {"raw": {"recencyDays": None, "frequency90d": 0,
                                           "monetary90dCents": 0},
                                 "score": {"R": None, "F": None, "M": None},
                                 "scoreMethod": "not assigned until observed purchase history exists"}
        if live_customer_codes:
            segment_counts = {}
            for row in result["customers"]:
                segment_counts[row["segment"]] = segment_counts.get(row["segment"], 0) + 1
            result["segmentDistribution"] = dict(sorted(segment_counts.items()))
            result["rankings"]["atRisk"] = [row for row in result["customers"] if row["segment"] == "AT_RISK"][:20]
            result["rankings"]["inactive"] = [row for row in result["customers"] if row["segment"] == "INACTIVE"][:20]
            result["rankings"]["new"] = [row for row in result["customers"] if row["segment"] == "NEW"][:20]
        rows = result["customers"]
        if request.customerCode:
            rows = [row for row in rows if row["customerCode"] == request.customerCode]
            if not rows:
                raise LiveDomainError("CUSTOMER_NOT_FOUND", 404, "Customer code was not found.")
        if request.segment:
            rows = [row for row in rows if row["segment"] == request.segment]
        incomplete_general = sum(not self._customer_general_complete(row) for row in rows)
        general_status = "PARTIAL" if incomplete_general else "AVAILABLE"
        margin_rank_costs = None
        if request.mode == "rank" and request.metric == "gross_margin":
            margin_rank_costs = {row["customerCode"]: self._coverage(views["sales"], views["linesBySale"], "HISTORY", cutoff,
                customer_code=row["customerCode"], products=customer_engine.products) for row in rows}
        if request.mode == "rank":
            field = {"spend": "totalSpentCents", "tickets": "ticketCount", "recency": "recencyDays",
                     "gross_margin": "grossMarginContributionCents"}[request.metric]
            rows = sorted(rows, key=lambda r: ((r[field] is None), -(r[field] or 0), r["customerCode"]))
        page = rows[request.offset:request.offset + request.limit]
        costs = {row["customerCode"]: self._coverage(views["sales"], views["linesBySale"], "HISTORY", cutoff,
                customer_code=row["customerCode"], products=customer_engine.products)
                 for row in page}
        historical_coverage = margin_rank_costs if margin_rank_costs is not None else costs
        cost_coverage = {"historical": self._aggregate_cost_coverage(historical_coverage), "period": None}
        margin_partial = cost_coverage["historical"]["status"] == "PARTIAL"
        availability_diagnostics = []
        if incomplete_general:
            availability_diagnostics.append({"code": "CUSTOMER_GENERAL_METRICS_INCOMPLETE",
                                             "affectedCustomerCount": incomplete_general})
        history_diagnostic = self._coverage_diagnostic(historical_coverage, "CUSTOMER_HISTORICAL_COST_COVERAGE_INCOMPLETE")
        if history_diagnostic["affectedCustomerCount"]:
            availability_diagnostics.append(history_diagnostic)
        if any(value["unsupportedCurrency"] for value in historical_coverage.values()):
            raise LiveDomainError("DATA_NOT_AVAILABLE", 422, "LIVE monetary analytics currently support PEN only.")
        if margin_rank_costs is not None and margin_partial:
            return {"metric": "grossMarginContributionCents", "available": False,
                    "reasonCode": "COST_NOT_AVAILABLE", "total": len(rows), "items": [],
                    "costCoverage": {"status": "NOT_AVAILABLE", **cost_coverage},
                    "marginAvailabilityStatus": "PARTIAL", "generalAvailabilityStatus": general_status,
                    "availabilityDiagnostics": availability_diagnostics,
                    "availabilityStatus": "PARTIAL",
                    "freshness": {**dict(live.freshness("customer")), "engineVersion": self.ENGINE_VERSION}}, cutoff
        public = []
        for row in page:
            item = self._public_customer(row)
            coverage = costs[row["customerCode"]]
            if coverage["unknownSaleLines"]:
                item = self._mask_customer_costs(item)
            item["costCoverage"] = coverage
            public.append(item)
        data = {"total": len(rows), "items": public,
                "consumerFinalIncludedInIndividualRfm": False,
                "availabilityStatus": general_status, "generalAvailabilityStatus": general_status,
                "marginAvailabilityStatus": "PARTIAL" if margin_partial else "AVAILABLE",
                "costCoverage": cost_coverage,
                "availabilityDiagnostics": availability_diagnostics,
                "freshness": {**dict(live.freshness("customer")), "engineVersion": self.ENGINE_VERSION}}
        if period is not None:
            start, end = period["startDate"], period["endDate"]
            data["period"] = {"startDate": start, "endDate": end, "timezone": "America/Lima"}
            selected_codes = {row["customerCode"] for row in rows}
            metrics = m68._period_customer_metrics(views["sales"], views["linesBySale"],
                customer_engine.products, date.fromisoformat(start), date.fromisoformat(end),
                selected_codes, allow_live=True)
            period_costs = {code: self._coverage(views["sales"], views["linesBySale"], period, cutoff,
                customer_code=code, products=customer_engine.products) for code in selected_codes}
            cost_coverage["period"] = self._aggregate_cost_coverage(period_costs)
            margin_partial = margin_partial or cost_coverage["period"]["status"] == "PARTIAL"
            period_diagnostic = self._coverage_diagnostic(period_costs, "CUSTOMER_PERIOD_COST_COVERAGE_INCOMPLETE")
            if period_diagnostic["affectedCustomerCount"]:
                availability_diagnostics.append(period_diagnostic)
            if any(value["unsupportedCurrency"] for value in period_costs.values()):
                raise LiveDomainError("DATA_NOT_AVAILABLE", 422, "LIVE monetary analytics currently support PEN only.")
            for code, value in metrics.items():
                if period_costs[code]["unknownSaleLines"]:
                    value["grossMarginCents"] = None
                    value["cogsCents"] = None
            data["periodMetrics"] = metrics
            data["periodCostCoverage"] = period_costs
            data["marginAvailabilityStatus"] = "PARTIAL" if margin_partial else "AVAILABLE"
        if request.mode == "summary":
            data["segmentDistribution"] = result["segmentDistribution"]
        return data, cutoff


__all__ = ["LiveBusinessCustomerAdapter"]
