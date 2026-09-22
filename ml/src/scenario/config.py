from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from ml.src.common import repository_path


@dataclass(frozen=True)
class ScenarioConfig:
    path: Path
    raw: dict[str, Any]
    scenario_id: str
    seed: int
    source_store: str
    source_start: date
    source_end: date
    operational_offset_days: int
    product_count: int
    supplier_count: int
    customer_count: int
    output: Path
    manifest: Path
    bronze: Path
    raw_manifest: Path

    @property
    def operational_start(self) -> date:
        return self.source_start + timedelta(days=self.operational_offset_days)

    @property
    def operational_end(self) -> date:
        return self.source_end + timedelta(days=self.operational_offset_days)

    @property
    def config_hash(self) -> str:
        canonical = json.dumps(self.raw, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _require(table: dict[str, Any], key: str, expected: type | tuple[type, ...], label: str) -> Any:
    value = table.get(key)
    if not isinstance(value, expected) or isinstance(value, bool):
        expected_name = (
            "/".join(item.__name__ for item in expected)
            if isinstance(expected, tuple) else expected.__name__
        )
        raise ValueError(f"{label}.{key} must be {expected_name}")
    return value


def load_scenario_config(path: str | Path) -> ScenarioConfig:
    import tomllib

    config_path = repository_path(path).resolve()
    with config_path.open("rb") as stream:
        raw = tomllib.load(stream)
    scenario = raw.get("scenario", {})
    selection = raw.get("selection", {})
    paths = raw.get("paths", {})
    suppliers = raw.get("suppliers", {})
    customers = raw.get("customers", {})
    inventory = raw.get("inventory", {})
    pricing = raw.get("pricing", {})
    transactions = raw.get("transactions", {})

    scenario_id = _require(scenario, "scenario_id", str, "scenario")
    if not scenario_id or len(scenario_id) > 100 or not all(
        char.isalnum() or char in "._-" for char in scenario_id
    ):
        raise ValueError("scenario.scenario_id must match [A-Za-z0-9._-]{1,100}")
    seed = _require(scenario, "seed", int, "scenario")
    source_store = _require(scenario, "source_store", str, "scenario")
    source_start = date.fromisoformat(_require(scenario, "source_start", str, "scenario"))
    source_end = date.fromisoformat(_require(scenario, "source_end", str, "scenario"))
    offset = _require(scenario, "operational_date_offset_days", int, "scenario")
    if source_start > source_end:
        raise ValueError("scenario.source_start must not be after source_end")
    if offset % 7:
        raise ValueError("scenario.operational_date_offset_days must be whole weeks")
    if source_end + timedelta(days=offset) > date.today():
        raise ValueError("operational date range cannot extend into the future")

    product_count = _require(selection, "product_count", int, "selection")
    supplier_count = _require(suppliers, "count", int, "suppliers")
    customer_count = _require(customers, "count", int, "customers")
    for label, value in (
        ("selection.product_count", product_count),
        ("suppliers.count", supplier_count),
        ("customers.count", customer_count),
    ):
        if value < 1:
            raise ValueError(f"{label} must be positive")

    fx = _require(pricing, "usd_to_pen", (int, float), "pricing")
    if fx <= 0:
        raise ValueError("pricing.usd_to_pen must be greater than zero")
    for key in ("credit_rate", "cancellation_rate", "anonymous_rate"):
        table = customers if key in customers else transactions
        value = _require(table, key, (int, float), "customers" if key in customers else "transactions")
        if not 0 <= value <= 1:
            raise ValueError(f"{key} must be between 0 and 1")
    for key in ("low", "medium", "high"):
        if key not in raw.get("margins", {}):
            raise ValueError(f"margins.{key} is required")
        value = raw["margins"][key]
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 < value < 1:
            raise ValueError(f"margins.{key} must be between 0 and 1")
    lead_min = _require(inventory, "lead_time_min_days", int, "inventory")
    lead_max = _require(inventory, "lead_time_max_days", int, "inventory")
    if lead_min < 1 or lead_max < lead_min:
        raise ValueError("inventory lead-time range is invalid")
    if _require(transactions, "max_lines_per_ticket", int, "transactions") < 1:
        raise ValueError("transactions.max_lines_per_ticket must be positive")
    if _require(transactions, "max_quantity_per_line", int, "transactions") < 1:
        raise ValueError("transactions.max_quantity_per_line must be positive")
    if _require(suppliers, "max_per_product", int, "suppliers") < 1:
        raise ValueError("suppliers.max_per_product must be positive")
    payment_delay = _require(transactions, "credit_payment_delay_days", int, "transactions")
    if payment_delay < 1:
        raise ValueError("transactions.credit_payment_delay_days must be positive")
    payment_fraction = _require(transactions, "credit_payment_fraction", (int, float), "transactions")
    if not 0 < payment_fraction <= 1:
        raise ValueError("transactions.credit_payment_fraction must be in (0, 1]")
    payment_methods = raw.get("payment_methods", {})
    supported_methods = {"cash", "card", "bank_transfer", "credit"}
    if not payment_methods or set(payment_methods) - supported_methods:
        raise ValueError("payment_methods contains unsupported or no methods")
    if any(
        isinstance(weight, bool) or not isinstance(weight, (int, float)) or weight <= 0
        for weight in payment_methods.values()
    ):
        raise ValueError("payment method weights must be positive numbers")
    for rotation in ("low", "medium", "high"):
        for prefix in ("initial_stock", "min_stock", "reorder_point"):
            key = f"{prefix}_{rotation}"
            if _require(inventory, key, int, "inventory") < 0:
                raise ValueError(f"inventory.{key} cannot be negative")

    return ScenarioConfig(
        path=config_path,
        raw=raw,
        scenario_id=scenario_id,
        seed=seed,
        source_store=source_store,
        source_start=source_start,
        source_end=source_end,
        operational_offset_days=offset,
        product_count=product_count,
        supplier_count=supplier_count,
        customer_count=customer_count,
        output=repository_path(_require(paths, "output", str, "paths")).resolve(),
        manifest=repository_path(_require(paths, "manifest", str, "paths")).resolve(),
        bronze=repository_path(_require(paths, "bronze", str, "paths")).resolve(),
        raw_manifest=repository_path(_require(paths, "raw_manifest", str, "paths")).resolve(),
    )
