from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from ml.src.common import (
    REPOSITORY_ROOT, atomic_write_json, measured_run, sha256_file, utc_now,
)
from ml.src.m5 import connect_duckdb
from ml.src.scenario.config import ScenarioConfig, load_scenario_config


GENERATOR_VERSION = "ml-r2b-v1"
PROVENANCE = {
    "REAL": [
        "item_id", "source_date", "units_sold", "sell_price", "cat_id",
        "dept_id", "calendar events", "SNAP", "temporal pattern",
    ],
    "DERIVED": [
        "operational_date", "price_pen", "rotation_class", "minStockLevel",
        "reorderPoint", "stock simulation", "aggregations",
    ],
    "SYNTHETIC": [
        "vendors", "customers", "purchases", "lead time", "supplierPrices",
        "payment methods", "credit", "payments", "cancellations", "names",
    ],
    "CONFIGURED": [
        "seed", "rates", "period", "currency", "margins",
        "replenishment policy", "credit rate", "cancellation rate",
    ],
}
FIELD_PROVENANCE = {
    "units_sold": "REAL",
    "sell_price": "REAL",
    "source_date": "REAL",
    "operational_date": "DERIVED",
    "supplierId": "SYNTHETIC",
    "customerId": "SYNTHETIC",
    "purchasePrice": "SYNTHETIC",
    "stock": "DERIVED",
    "minStockLevel": "DERIVED",
    "leadTime": "SYNTHETIC",
    "credit": "SYNTHETIC",
    "payments": "SYNTHETIC",
    "cancelledAt": "SYNTHETIC",
}


def deterministic_id(scenario_id: str, kind: str, key: str) -> str:
    return hashlib.sha256(f"{scenario_id}|{kind}|{key}".encode()).hexdigest()[:24]


def stable_rank(seed: int, value: str) -> str:
    return hashlib.sha256(f"{seed}|{value}".encode()).hexdigest()


def portable_path(path: Path) -> str:
    try:
        return path.relative_to(REPOSITORY_ROOT).as_posix()
    except ValueError:
        return str(path)


def iso_at(day: date, hour: int, minute: int = 0, second: int = 0) -> str:
    return datetime.combine(
        day, time(hour, minute, second, tzinfo=timezone.utc)
    ).isoformat().replace("+00:00", "Z")


def iso_slot(day: date, start_hour: int, index: int) -> str:
    moment = datetime.combine(
        day, time(start_hour, tzinfo=timezone.utc)
    ) + timedelta(seconds=index)
    return moment.isoformat().replace("+00:00", "Z")


def weighted_choice(rng: random.Random, values: list[tuple[str, float]]) -> str:
    threshold = rng.random() * sum(weight for _, weight in values)
    cumulative = 0.0
    for value, weight in values:
        cumulative += weight
        if threshold <= cumulative:
            return value
    return values[-1][0]


class EventWriter:
    def __init__(self, path: Path, scenario_id: str | None = None) -> None:
        self.path = path
        self.scenario_id = scenario_id
        self.stream = path.open("w", encoding="utf-8", newline="\n")
        self.counts: defaultdict[str, int] = defaultdict(int)
        self.records = 0
        self.sale_lines = 0
        self.units = 0

    def write(self, event: dict[str, Any]) -> None:
        if self.scenario_id is not None:
            event = {"scenarioId": self.scenario_id, **event}
        self.stream.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")
        self.records += 1
        self.counts[event["eventType"]] += 1
        if event["eventType"] == "transaction.completed" and event["payload"]["type"] == "sale":
            self.sale_lines += len(event["payload"]["products"])
            if event["payload"].get("notes", "").startswith("M5 demand"):
                self.units += sum(item["quantity"] for item in event["payload"]["products"])

    def close(self) -> None:
        self.stream.close()


def _product_statistics(connection, config: ScenarioConfig) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT item_id, any_value(dept_id) AS dept_id, any_value(cat_id) AS cat_id,
               sum(CAST(units_sold AS BIGINT)) AS total_units,
               avg(CAST(units_sold AS DOUBLE)) AS mean_daily_units,
               count_if(units_sold > 0)::DOUBLE / count(*) AS positive_ratio,
               median(sell_price) FILTER (WHERE sell_price > 0) AS median_price,
               min(source_date) FILTER (WHERE sell_price > 0 OR units_sold > 0) AS first_evidence,
               min(source_date) FILTER (WHERE units_sold > 0) AS first_sale
        FROM read_parquet(?)
        WHERE store_id = ? AND source_date BETWEEN ? AND ?
        GROUP BY item_id
        HAVING sum(units_sold) > 0 AND median(sell_price) FILTER (WHERE sell_price > 0) > 0
        ORDER BY item_id
        """,
        [str(config.bronze), config.source_store, config.source_start, config.source_end],
    ).fetchall()
    names = [item[0] for item in connection.description]
    products = [dict(zip(names, row)) for row in rows]
    if len(products) < config.product_count:
        raise ValueError(
            f"Only {len(products)} active priced products are available; "
            f"configuration requests {config.product_count}"
        )
    ranked_units = sorted(products, key=lambda item: (item["mean_daily_units"], item["item_id"]))
    ranked_prices = sorted(products, key=lambda item: (item["median_price"], item["item_id"]))
    unit_bucket = {item["item_id"]: min(2, index * 3 // len(products)) for index, item in enumerate(ranked_units)}
    price_bucket = {item["item_id"]: min(2, index * 3 // len(products)) for index, item in enumerate(ranked_prices)}
    labels = ("low", "medium", "high")
    strata: defaultdict[tuple[str, str, bool, str], list[dict[str, Any]]] = defaultdict(list)
    for product in products:
        product["rotation_class"] = labels[unit_bucket[product["item_id"]]]
        product["price_class"] = labels[price_bucket[product["item_id"]]]
        product["intermittent"] = product["positive_ratio"] < 0.20
        key = (
            product["cat_id"], product["rotation_class"], product["intermittent"],
            product["price_class"],
        )
        strata[key].append(product)
    for key in strata:
        strata[key].sort(key=lambda item: stable_rank(config.seed, item["item_id"]))
    selected: list[dict[str, Any]] = []
    keys = sorted(strata)
    while len(selected) < config.product_count:
        progressed = False
        for key in keys:
            if strata[key] and len(selected) < config.product_count:
                selected.append(strata[key].pop(0))
                progressed = True
        if not progressed:
            break
    return sorted(selected, key=lambda item: item["item_id"])


def _iter_daily_demand(connection, config: ScenarioConfig) -> Iterator[tuple[date, list[tuple[str, str, int]]]]:
    cursor = connection.execute(
        """
        SELECT source_date, item_id, cat_id, CAST(units_sold AS BIGINT) AS units
        FROM read_parquet(?) b
        INNER JOIN selected_products s USING (item_id)
        WHERE store_id = ? AND source_date BETWEEN ? AND ? AND units_sold > 0
        ORDER BY source_date, cat_id, item_id
        """,
        [str(config.bronze), config.source_store, config.source_start, config.source_end],
    )
    current: date | None = None
    rows: list[tuple[str, str, int]] = []
    while True:
        row = cursor.fetchone()
        if row is None:
            break
        source_day, item_id, category, units = row
        if current is not None and source_day != current:
            yield current, rows
            rows = []
        current = source_day
        rows.append((item_id, category, int(units)))
    if current is not None:
        yield current, rows


def _ticketize(
    rows: list[tuple[str, str, int]], rng: random.Random,
    max_lines: int, max_quantity: int,
) -> list[list[dict[str, Any]]]:
    by_category: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for item_id, category, units in rows:
        remaining = units
        while remaining:
            quantity = min(remaining, rng.randint(1, max_quantity))
            by_category[category].append({"item_id": item_id, "quantity": quantity})
            remaining -= quantity
    tickets: list[list[dict[str, Any]]] = []
    for category in sorted(by_category):
        lines = by_category[category]
        rng.shuffle(lines)
        while lines:
            size = min(len(lines), rng.randint(1, max_lines))
            raw = lines[:size]
            del lines[:size]
            combined: dict[str, int] = defaultdict(int)
            for line in raw:
                combined[line["item_id"]] += line["quantity"]
            tickets.append([
                {"item_id": item_id, "quantity": quantity}
                for item_id, quantity in sorted(combined.items())
            ])
    rng.shuffle(tickets)
    return tickets


def generate_scenario(config_path: str | Path, *, overwrite: bool = False) -> dict[str, Any]:
    config = load_scenario_config(config_path)
    if not config.bronze.exists():
        raise FileNotFoundError(f"Bronze input does not exist: {config.bronze}")
    if not config.raw_manifest.exists():
        raise FileNotFoundError(f"M5 raw manifest does not exist: {config.raw_manifest}")
    if config.output.exists() and not overwrite:
        raise FileExistsError(f"Scenario already exists: {config.output}; use --overwrite")
    config.output.parent.mkdir(parents=True, exist_ok=True)
    config.manifest.parent.mkdir(parents=True, exist_ok=True)
    temporary = config.output.with_suffix(config.output.suffix + ".tmp")
    if temporary.exists():
        temporary.unlink()

    rng = random.Random(config.seed)
    connection = connect_duckdb()
    writer: EventWriter | None = None
    try:
        with measured_run() as performance:
            products = _product_statistics(connection, config)
            ml_observations = connection.execute(
                "SELECT count(*) FROM read_parquet(?)", [str(config.bronze)]
            ).fetchone()[0]
            connection.execute("CREATE TEMP TABLE selected_products(item_id VARCHAR PRIMARY KEY)")
            connection.executemany(
                "INSERT INTO selected_products VALUES (?)",
                [(product["item_id"],) for product in products],
            )
            product_by_item = {product["item_id"]: product for product in products}
            raw = config.raw
            fx = float(raw["pricing"]["usd_to_pen"])
            margins = raw["margins"]
            inventory = raw["inventory"]
            max_suppliers = int(raw["suppliers"]["max_per_product"])
            lead_min = int(inventory["lead_time_min_days"])
            lead_max = int(inventory["lead_time_max_days"])
            setup_lead = int(inventory["product_setup_lead_days"])

            supplier_ids = [
                deterministic_id(config.scenario_id, "vendor", str(index))
                for index in range(config.supplier_count)
            ]
            categories = sorted({product["cat_id"] for product in products})
            suppliers_by_category = {
                category: [
                    supplier_ids[index]
                    for index in range(config.supplier_count)
                    if index % len(categories) == categories.index(category)
                ] or supplier_ids
                for category in categories
            }
            customer_profiles = (
                ["occasional"] * 55 + ["frequent"] * 25 +
                ["high-ticket"] * 10 + ["small-wholesale"] * 5 +
                ["credit-enabled"] * 5
            )
            customers = []
            for index in range(config.customer_count):
                profile = customer_profiles[index % len(customer_profiles)]
                customers.append({
                    "id": deterministic_id(config.scenario_id, "customer", str(index)),
                    "profile": profile,
                })
            credit_customers = [item for item in customers if item["profile"] == "credit-enabled"]
            if not credit_customers:
                customers[-1]["profile"] = "credit-enabled"
                credit_customers = [customers[-1]]

            product_events: defaultdict[date, list[dict[str, Any]]] = defaultdict(list)
            initial_receipts: defaultdict[date, list[tuple[str, int]]] = defaultdict(list)
            product_state: dict[str, dict[str, Any]] = {}
            for index, product in enumerate(products):
                item_id = product["item_id"]
                first_evidence = max(config.source_start, product["first_evidence"])
                first_sale = max(config.source_start, product["first_sale"])
                operational_first = first_sale + timedelta(days=config.operational_offset_days)
                created_day = (
                    first_evidence + timedelta(days=config.operational_offset_days - setup_lead)
                )
                receipt_day = max(created_day + timedelta(days=1), operational_first - timedelta(days=1))
                supplier_pool = suppliers_by_category[product["cat_id"]]
                count = 1 + int(stable_rank(config.seed, item_id), 16) % min(max_suppliers, len(supplier_pool))
                assigned = [supplier_pool[(index + step) % len(supplier_pool)] for step in range(count)]
                price = round(max(0.02, float(product["median_price"]) * fx), 2)
                margin = float(margins[product["rotation_class"]])
                base_cost = round(max(0.01, price * (1 - margin)), 2)
                supplier_prices = []
                for supplier_index, supplier_id in enumerate(assigned):
                    factor = 1 + (supplier_index - (len(assigned) - 1) / 2) * 0.02
                    supplier_prices.append({
                        "supplierId": supplier_id,
                        "purchasePrice": round(min(price - 0.01, max(0.01, base_cost * factor)), 2),
                    })
                preferred = min(supplier_prices, key=lambda item: item["purchasePrice"])
                initial_quantity = int(inventory[f"initial_stock_{product['rotation_class']}"])
                reorder_point = int(inventory[f"reorder_point_{product['rotation_class']}"])
                min_stock = int(inventory[f"min_stock_{product['rotation_class']}"])
                lead_time = lead_min + int(stable_rank(config.seed, f"lead|{item_id}"), 16) % (lead_max - lead_min + 1)
                product_id = deterministic_id(config.scenario_id, "product", item_id)
                state = {
                    "id": product_id, "item_id": item_id, "category": product["cat_id"],
                    "price": price, "cost": preferred["purchasePrice"],
                    "vendor_id": preferred["supplierId"], "stock": 0,
                    "reorder_point": reorder_point, "min_stock": min_stock,
                    "lead_time": lead_time, "scheduled": 0,
                    "order_up_to": initial_quantity + reorder_point,
                }
                product_state[item_id] = state
                product_events[created_day].append({
                    "eventType": "product.created",
                    "eventId": f"{config.scenario_id}:product:{item_id}",
                    "occurredAt": iso_at(created_day, 7, 0, index % 60),
                    "payload": {
                        "_id": product_id,
                        "sku": f"M5-{item_id}",
                        "name": f"Producto sintético M5 {item_id}",
                        "description": (
                            f"Origen M5 {item_id}; source_price_median_usd="
                            f"{float(product['median_price']):.4f}; fx_usd_pen={fx:.4f}; "
                            f"lead_time_days={lead_time}"
                        ),
                        "category": product["cat_id"], "price": price,
                        "costPrice": preferred["purchasePrice"], "currency": "PEN",
                        "stock": 0, "minStockLevel": min_stock,
                        "supplierPrices": supplier_prices,
                        "preferredSupplierId": preferred["supplierId"],
                    },
                })
                initial_receipts[receipt_day].append((item_id, initial_quantity))

            earliest_product_day = min(product_events)
            contact_day = earliest_product_day - timedelta(days=2)
            writer = EventWriter(temporary, config.scenario_id)
            for index, supplier_id in enumerate(supplier_ids):
                specialty = categories[index % len(categories)]
                writer.write({
                    "eventType": "contact.created",
                    "eventId": f"{config.scenario_id}:vendor:{index}",
                    "occurredAt": iso_slot(contact_day, 6, index),
                    "payload": {
                        "_id": supplier_id, "name": f"Proveedor sintético {index + 1:03d} {specialty}",
                        "phone": f"SYN-V-{index + 1:06d}", "type": "vendor",
                        "notes": f"Datos sintéticos; especialidad={specialty}",
                    },
                })
            customer_day = contact_day + timedelta(days=1)
            for index, customer in enumerate(customers):
                writer.write({
                    "eventType": "contact.created",
                    "eventId": f"{config.scenario_id}:customer:{index}",
                    "occurredAt": iso_slot(customer_day, 6, index),
                    "payload": {
                        "_id": customer["id"], "name": f"Cliente sintético {index + 1:05d}",
                        "phone": f"SYN-C-{index + 1:07d}", "type": "customer",
                        "creditLimit": 1_000_000 if customer["profile"] == "credit-enabled" else 0,
                        "notes": f"Perfil ficticio {customer['profile']}; no contiene PII real",
                    },
                })

            scheduled_receipts: defaultdict[date, list[tuple[str, int, str, date]]] = defaultdict(list)
            scheduled_payments: defaultdict[date, list[dict[str, Any]]] = defaultdict(list)
            scheduled_cancellations: defaultdict[date, list[dict[str, Any]]] = defaultdict(list)
            credit_balance: defaultdict[str, float] = defaultdict(float)
            payment_weights = [
                (key, float(value)) for key, value in raw["payment_methods"].items()
            ]
            cancellation_rate = float(raw["transactions"]["cancellation_rate"])
            anonymous_rate = float(raw["customers"]["anonymous_rate"])
            credit_rate = float(raw["transactions"]["credit_rate"])
            payment_delay = int(raw["transactions"]["credit_payment_delay_days"])
            payment_fraction = float(raw["transactions"]["credit_payment_fraction"])
            max_lines = int(raw["transactions"]["max_lines_per_ticket"])
            max_quantity = int(raw["transactions"]["max_quantity_per_line"])
            purchase_counter = sale_counter = payment_counter = cancellation_counter = 0

            demand_iterator = iter(_iter_daily_demand(connection, config))
            next_demand = next(demand_iterator, None)
            day = min(contact_day, earliest_product_day)
            tail_end = config.operational_end + timedelta(days=payment_delay + 1)
            while day <= tail_end:
                for event in sorted(product_events.get(day, []), key=lambda item: item["occurredAt"]):
                    writer.write(event)

                receipts = [
                    (item, quantity, "initial", day - timedelta(days=1))
                    for item, quantity in initial_receipts.get(day, [])
                ]
                receipts.extend(scheduled_receipts.pop(day, []))
                for sequence, (item_id, quantity, reason, order_day) in enumerate(sorted(receipts)):
                    state = product_state[item_id]
                    purchase_counter += 1
                    writer.write({
                        "eventType": "transaction.completed",
                        "eventId": f"{config.scenario_id}:purchase:{purchase_counter}",
                        "occurredAt": iso_slot(day, 8, sequence),
                        "payload": {
                            "_id": deterministic_id(config.scenario_id, "purchase", str(purchase_counter)),
                            "type": "purchase", "vendorId": state["vendor_id"],
                            "currency": "PEN", "paymentMethod": "bank_transfer",
                            "exchangeRates": {"USD/PEN": fx},
                            "products": [{"productId": state["id"], "quantity": quantity}],
                            "notes": (
                                f"Reposición {reason}; order_date={order_day.isoformat()}; "
                                f"expected_receipt_date={day.isoformat()}"
                            ),
                        },
                    })
                    state["stock"] += quantity
                    state["scheduled"] = max(0, state["scheduled"] - quantity)

                source_day = day - timedelta(days=config.operational_offset_days)
                rows: list[tuple[str, str, int]] = []
                if next_demand and next_demand[0] == source_day:
                    rows = next_demand[1]
                    next_demand = next(demand_iterator, None)
                if rows:
                    tickets = _ticketize(rows, rng, max_lines, max_quantity)
                    cancellation_extras: list[list[dict[str, Any]]] = []
                    for ticket in tickets:
                        if rng.random() < cancellation_rate:
                            cancellation_extras.append([{"item_id": ticket[0]["item_id"], "quantity": 1}])
                    required: defaultdict[str, int] = defaultdict(int)
                    for ticket in tickets + cancellation_extras:
                        for line in ticket:
                            required[line["item_id"]] += line["quantity"]
                    for sequence, (item_id, quantity) in enumerate(sorted(required.items())):
                        state = product_state[item_id]
                        shortfall = quantity - state["stock"]
                        if shortfall > 0:
                            emergency_quantity = shortfall + max(state["reorder_point"], state["min_stock"])
                            purchase_counter += 1
                            writer.write({
                                "eventType": "transaction.completed",
                                "eventId": f"{config.scenario_id}:purchase:{purchase_counter}",
                                "occurredAt": iso_slot(day, 9, sequence),
                                "payload": {
                                    "_id": deterministic_id(config.scenario_id, "purchase", str(purchase_counter)),
                                    "type": "purchase", "vendorId": state["vendor_id"],
                                    "currency": "PEN", "paymentMethod": "bank_transfer",
                                    "exchangeRates": {"USD/PEN": fx},
                                    "products": [{"productId": state["id"], "quantity": emergency_quantity}],
                                    "notes": (
                                        "Emergency receipt preserves exact M5 demand and non-negative stock; "
                                        f"order_date={day.isoformat()}; expected_receipt_date={day.isoformat()}"
                                    ),
                                },
                            })
                            state["stock"] += emergency_quantity

                    for ticket_index, (ticket, is_extra) in enumerate(
                        [(item, False) for item in tickets] + [(item, True) for item in cancellation_extras]
                    ):
                        sale_counter += 1
                        customer = None if rng.random() < anonymous_rate else customers[rng.randrange(len(customers))]
                        non_credit_weights = [entry for entry in payment_weights if entry[0] != "credit"]
                        method = (
                            "credit" if customer is not None and rng.random() < credit_rate
                            else weighted_choice(rng, non_credit_weights)
                        )
                        if method == "credit":
                            customer = credit_customers[rng.randrange(len(credit_customers))]
                        if is_extra:
                            method = "cash"
                        products_payload = []
                        total = 0.0
                        for line in ticket:
                            state = product_state[line["item_id"]]
                            state["stock"] -= line["quantity"]
                            products_payload.append({
                                "productId": state["id"], "quantity": line["quantity"]
                            })
                            total += state["price"] * line["quantity"]
                        transaction_id = deterministic_id(config.scenario_id, "sale", str(sale_counter))
                        writer.write({
                            "eventType": "transaction.completed",
                            "eventId": f"{config.scenario_id}:sale:{sale_counter}",
                            "occurredAt": iso_slot(day, 10, ticket_index),
                            "payload": {
                                "_id": transaction_id, "type": "sale",
                                **({"customerId": customer["id"]} if customer else {"customerName": "Consumidor final"}),
                                "currency": "PEN", "paymentMethod": method,
                                "exchangeRates": {"USD/PEN": fx}, "products": products_payload,
                                "notes": (
                                    "Synthetic cancellation exercise; excluded from M5 demand"
                                    if is_extra else f"M5 demand; source_date={source_day.isoformat()}"
                                ),
                            },
                        })
                        if method == "credit" and customer:
                            total = round(total, 2)
                            credit_balance[customer["id"]] += total
                            amount = round(total * payment_fraction, 2)
                            if amount > 0:
                                scheduled_payments[day + timedelta(days=payment_delay)].append({
                                    "customer_id": customer["id"], "amount": amount,
                                })
                        if is_extra:
                            scheduled_cancellations[day + timedelta(days=1)].append({
                                "transaction_id": transaction_id, "lines": ticket,
                            })

                    for item_id in required:
                        state = product_state[item_id]
                        inventory_position = state["stock"] + state["scheduled"]
                        if inventory_position <= state["reorder_point"] and day < config.operational_end:
                            quantity = max(
                                state["order_up_to"] - inventory_position,
                                state["min_stock"], 1,
                            )
                            receipt_day = min(
                                config.operational_end,
                                day + timedelta(days=state["lead_time"]),
                            )
                            scheduled_receipts[receipt_day].append((item_id, quantity, "planned", day))
                            state["scheduled"] += quantity

                for sequence, payment in enumerate(scheduled_payments.pop(day, [])):
                    available = round(credit_balance[payment["customer_id"]], 2)
                    amount = min(round(payment["amount"], 2), available)
                    if amount <= 0:
                        continue
                    payment_counter += 1
                    writer.write({
                        "eventType": "credit-payment.created",
                        "eventId": f"{config.scenario_id}:payment:{payment_counter}",
                        "occurredAt": iso_slot(day, 21, sequence),
                        "payload": {
                            "_id": deterministic_id(config.scenario_id, "payment", str(payment_counter)),
                            "customerId": payment["customer_id"], "amount": amount,
                            "currency": "PEN", "paymentMethod": "bank_transfer",
                            "notes": "Synthetic deterministic partial credit payment",
                        },
                    })
                    credit_balance[payment["customer_id"]] = round(available - amount, 2)

                for sequence, cancellation in enumerate(scheduled_cancellations.pop(day, [])):
                    cancellation_counter += 1
                    writer.write({
                        "eventType": "transaction.cancelled",
                        "eventId": f"{config.scenario_id}:cancellation:{cancellation_counter}",
                        "occurredAt": iso_slot(day, 22, sequence),
                        "payload": {"transactionId": cancellation["transaction_id"]},
                    })
                    for line in cancellation["lines"]:
                        product_state[line["item_id"]]["stock"] += line["quantity"]
                day += timedelta(days=1)

            writer.close()
            writer = None

            from ml.src.scenario.validation import validate_scenario

            validation = validate_scenario(config, products, file_path=temporary)
            os.replace(temporary, config.output)
            ndjson_hash = sha256_file(config.output)
            scenario_rules = {
                "price": "Fixed per-product median M5 USD price converted with configured FX; weekly source prices remain in Bronze.",
                "stock": "Future-aware rotation stratification is used only for simulation sizing and is forbidden as an ML feature.",
                "cancellations": "Additional synthetic cash sales are cancelled; non-cancelled M5 sales remain exactly reconciled.",
                "orders": "Order dates and lead times are simulated internally; Mongo records purchases on receipt.",
            }
            manifest = {
                "scenario_version": config.scenario_id,
                "generator_version": GENERATOR_VERSION,
                "scenarioId": config.scenario_id,
                "seed": config.seed,
                "created_at_utc": utc_now(),
                "source_dataset": "M5 Forecasting Accuracy",
                "source_bronze": portable_path(config.bronze),
                "source_bronze_sha256": sha256_file(config.bronze),
                "m5_raw_manifest": portable_path(config.raw_manifest),
                "m5_raw_manifest_sha256": sha256_file(config.raw_manifest),
                "selected_store": config.source_store,
                "source_date_range": [config.source_start.isoformat(), config.source_end.isoformat()],
                "operational_date_range": [config.operational_start.isoformat(), config.operational_end.isoformat()],
                "selected_products": [product["item_id"] for product in products],
                "counts": {
                    "products": len(products), "suppliers": config.supplier_count,
                    "customers": config.customer_count,
                    "purchases": validation["counts"].get("purchase_transactions", 0),
                    "sales": validation["counts"].get("sale_transactions", 0),
                    "transactions": (
                        validation["counts"].get("purchase_transactions", 0)
                        + validation["counts"].get("sale_transactions", 0)
                    ),
                    "m5_sales": validation["counts"].get("m5_sale_transactions", 0),
                    "synthetic_cancellation_sales": validation["counts"].get("synthetic_cancellation_sales", 0),
                    "payments": validation["counts"].get("credit_payments", 0),
                    "cancellations": validation["counts"].get("cancellations", 0),
                    "sale_lines": validation["counts"].get("sale_lines", 0),
                    "materialized_m5_units": validation["counts"].get("materialized_m5_units", 0),
                    "events": validation["counts"].get("events", 0),
                    "expected_inventory_movements": validation["counts"].get(
                        "expected_inventory_movements", 0
                    ),
                },
                "volume_comparison": {
                    "full_ml_product_day_observations": ml_observations,
                    "mongo_operational_events": validation["counts"].get("events", 0),
                    "materialized_positive_product_days": validation["counts"].get("materialized_product_days", 0),
                },
                "ndjson": portable_path(config.output),
                "ndjson_sha256": ndjson_hash,
                "ndjson_size_bytes": config.output.stat().st_size,
                "config": portable_path(config.path),
                "config_sha256": config.config_hash,
                "provenance": PROVENANCE,
                "field_provenance": FIELD_PROVENANCE,
                "rules": scenario_rules,
                "policies": scenario_rules,
                "validation": validation,
                "performance": performance,
            }
        atomic_write_json(config.manifest, manifest)
        return manifest
    except Exception:
        if writer is not None:
            writer.close()
        if temporary.exists():
            temporary.unlink()
        raise
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate deterministic M5 operational NDJSON")
    parser.add_argument("--config", required=True)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    try:
        manifest = generate_scenario(args.config, overwrite=args.overwrite)
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError) as error:
        print(f"ML-R2B generation failed: {error}", file=sys.stderr)
        return 2
    print(json.dumps(manifest, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
