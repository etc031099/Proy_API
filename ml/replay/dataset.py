"""Isolated prefix + additive sales; canonical files/objects are never mutated."""
import copy
from datetime import date, timedelta

import numpy as np
import pandas as pd

from ml.src import v3_forecast
from ml.service.v3_live_ridge import FEATURE_ORDER
from ml.service.v3_ridge_training import digest
from .policy import BASELINE_CLOSED, FINAL_CLOSED, HORIZONS


class ReplayDataset:
    def __init__(self, source, evidence):
        self.dataset = copy.copy(source)
        self.dataset.feature_cache = {}
        self._baseline_revenue = [r for r in source.replay_baseline_revenue if r[1] in source.product_by_sku]
        self.dataset.products = copy.deepcopy(source.products)
        self.dataset.product_by_sku = {p["sku"]: p for p in self.dataset.products}
        self.skus = sorted(self.dataset.product_by_sku)
        self.dataset.inventory = {sku: {day: dict(row) for day, row in source.inventory[sku].items()
                           if day <= BASELINE_CLOSED.isoformat()} for sku in self.skus}
        self._starting_stock = {s: int(self.dataset.inventory[s][BASELINE_CLOSED.isoformat()]["endingStock"])
                                for s in self.skus}
        self.applied_operations, self.complete_days = [], []
        self.closed = BASELINE_CLOSED
        self.apply(evidence)

    def apply(self, evidence):
        closed = date.fromisoformat(evidence["closedThrough"])
        if not self.closed <= closed <= FINAL_CLOSED:
            raise ValueError("REPLAY_DATE_INVALID")
        inventory = self.dataset.inventory
        # Complete observed synthetic days are declared explicitly. Missing days
        # are rejected, not silently turned into zero observations.
        days = evidence["completeDays"]
        expected = []
        day = BASELINE_CLOSED + timedelta(days=1)
        while day <= closed:
            expected.append(day.isoformat())
            day += timedelta(days=1)
        if days != expected:
            raise ValueError("REPLAY_DAY_COVERAGE_INVALID")
        if (days[:len(self.complete_days)] != self.complete_days
                or evidence["operations"][:len(self.applied_operations)] != self.applied_operations):
            raise ValueError("REPLAY_EVIDENCE_NOT_APPEND_ONLY")
        for sku in self.skus:
            for day in days[len(self.complete_days):]:
                inventory[sku][day] = {"sku": sku, "localDate": day, "unitsSold": 0,
                    "endingStock": 0, "availableHours": 15}
        ids, stock = {r["operationId"] for r in self.applied_operations}, dict(self._starting_stock)
        for sale in evidence["operations"][len(self.applied_operations):]:
            sku, day, quantity = sale["sku"], sale["localDate"], sale["quantity"]
            if (sale["operationId"] in ids or sku not in inventory or day not in inventory[sku]
                    or day < BASELINE_CLOSED.isoformat() or day > closed.isoformat()
                    or isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 1):
                raise ValueError("REPLAY_OPERATION_INVALID")
            ids.add(sale["operationId"])
            inventory[sku][day]["unitsSold"] += quantity
            cents = round(float(self.dataset.product_by_sku[sku]["salePriceDemo"]) * 100)
            self._baseline_revenue.append((day, sku, quantity * cents))
        self.replenishments = []
        for sku in self.skus:
            # Initial small record levels amend the final baseline day. Their
            # stock deltas are explicit, just like later generated daily sales.
            added = sum(r["quantity"] for r in evidence["operations"]
                        if r["sku"] == sku and r["localDate"] == BASELINE_CLOSED.isoformat())
            for day in [BASELINE_CLOSED.isoformat(), *days]:
                sold = added if day == BASELINE_CLOSED.isoformat() else inventory[sku][day]["unitsSold"]
                if stock[sku] < sold:
                    qty = sold - stock[sku] + 10
                    stock[sku] += qty
                    self.replenishments.append({"sku": sku, "localDate": day, "quantity": qty})
                stock[sku] -= sold
                inventory[sku][day]["endingStock"] = stock[sku]
        self.dataset.inventory = inventory
        self.dataset.daily_by_sku = {s: list(rows.values()) for s, rows in inventory.items()}
        self.dataset.feature_cache = {}
        self.closed = closed
        self.applied_operations = copy.deepcopy(evidence["operations"])
        self.complete_days = list(days)
        self.row_count = sum(len(rows) for rows in inventory.values())
        self.hash = digest({"closedThrough": self.closed.isoformat(), "daily": inventory,
                            "products": self.dataset.products})

    def units(self, sku, day):
        if day > self.closed:
            raise ValueError("REPLAY_FUTURE_DATA_FORBIDDEN")
        return int(self.dataset.inventory[sku][day.isoformat()]["unitsSold"])

    def features(self, sku, origin, horizon):
        if horizon not in HORIZONS or isinstance(horizon, bool) or origin > self.closed:
            raise ValueError("REPLAY_FEATURE_SCOPE_INVALID")
        row = self.dataset.feature_row(sku, origin, horizon)
        return {name: row[name] for name in FEATURE_ORDER}

    def examples(self, horizon):
        rows, labels, origins = [], [], []
        origin = v3_forecast.FIRST_ORIGIN
        while origin + timedelta(days=horizon) <= self.closed:
            for sku in self.skus:
                rows.append(self.features(sku, origin, horizon))
                labels.append(sum(self.units(sku, origin + timedelta(days=i)) for i in range(1, horizon + 1)))
                origins.append(origin)
            origin += timedelta(days=1)
        return pd.DataFrame(rows, columns=FEATURE_ORDER), np.asarray(labels, dtype=float), origins

    def probe(self, horizon):
        return [self.features(sku, BASELINE_CLOSED, horizon) for sku in self.skus]

    def revenue(self):
        return list(self._baseline_revenue)


def empty_evidence():
    return {"closedThrough": BASELINE_CLOSED.isoformat(), "completeDays": [], "operations": []}


def load_source(root):
    source = v3_forecast.load_validated_dataset(root)
    generated = root / "data/minimarket-pasco-v3/generated"
    sales = {r["saleCode"]: r for r in v3_forecast.read_ndjson(generated / "sales.ndjson")
             if r["status"] == "completed" and r["localDate"] <= BASELINE_CLOSED.isoformat()}
    source.replay_baseline_sale_count = len(sales)
    source.replay_baseline_revenue = [(sales[r["saleCode"]]["localDate"], r["sku"], r["lineTotalCents"])
        for r in v3_forecast.read_ndjson(generated / "sale-items.ndjson") if r["saleCode"] in sales]
    return source
