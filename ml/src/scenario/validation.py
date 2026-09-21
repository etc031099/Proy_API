from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from ml.src.common import sql_literal
from ml.src.m5 import connect_duckdb
from ml.src.scenario.config import ScenarioConfig, load_scenario_config


OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")


def _object_id(value: Any, label: str, line_number: int) -> str:
    if not isinstance(value, str) or not OBJECT_ID.fullmatch(value):
        raise ValueError(f"Line {line_number}: {label} must be a 24-character hexadecimal ObjectId")
    return value


def _timestamp(value: Any, line_number: int) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"Line {line_number}: occurredAt must be an ISO string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"Line {line_number}: invalid occurredAt") from error
    if parsed.tzinfo is None:
        raise ValueError(f"Line {line_number}: occurredAt must include a timezone")
    return parsed


def _positive_number(value: Any, label: str, line_number: int) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Line {line_number}: {label} must be numeric")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"Line {line_number}: {label} must be finite and positive")
    return number


def validate_scenario(
    config: ScenarioConfig,
    selected_products: list[dict[str, Any]] | None = None,
    *,
    file_path: Path | None = None,
) -> dict[str, Any]:
    path = file_path or config.output
    contacts: dict[str, str] = {}
    products: dict[str, dict[str, Any]] = {}
    stocks: defaultdict[str, int] = defaultdict(int)
    cancellable_transactions: dict[str, dict[str, Any]] = {}
    balances: defaultdict[str, float] = defaultdict(float)
    event_ids: set[str] = set()
    entity_ids: set[str] = set()
    counts = defaultdict(int)
    previous_time: datetime | None = None
    connection = connect_duckdb()
    demand_path = path.with_suffix(path.suffix + ".demand.tmp.csv")
    demand_stream = demand_path.open("w", encoding="utf-8", newline="")
    demand_writer = csv.writer(demand_stream, lineterminator="\n")

    try:
        with path.open("r", encoding="utf-8") as stream:
            for line_number, raw_line in enumerate(stream, 1):
                if not raw_line.strip():
                    continue
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"Line {line_number}: invalid JSON") from error
                if not isinstance(event, dict):
                    raise ValueError(f"Line {line_number}: event must be an object")
                event_id = event.get("eventId")
                if not isinstance(event_id, str) or not event_id:
                    raise ValueError(f"Line {line_number}: eventId is required")
                if event_id in event_ids:
                    raise ValueError(f"Line {line_number}: duplicate eventId {event_id}")
                event_ids.add(event_id)
                occurred_at = _timestamp(event.get("occurredAt"), line_number)
                if previous_time and occurred_at < previous_time:
                    raise ValueError(f"Line {line_number}: events are not in causal order")
                previous_time = occurred_at
                event_type = event.get("eventType")
                payload = event.get("payload")
                if not isinstance(payload, dict):
                    raise ValueError(f"Line {line_number}: payload must be an object")
                counts["events"] += 1

                if event_type == "contact.created":
                    identifier = _object_id(payload.get("_id"), "contact._id", line_number)
                    contact_type = payload.get("type")
                    if contact_type not in {"vendor", "customer"}:
                        raise ValueError(f"Line {line_number}: invalid contact type")
                    if identifier in entity_ids:
                        raise ValueError(f"Line {line_number}: duplicate entity id")
                    entity_ids.add(identifier)
                    contacts[identifier] = contact_type
                    counts[f"{contact_type}s"] += 1
                    continue

                if event_type == "product.created":
                    identifier = _object_id(payload.get("_id"), "product._id", line_number)
                    if identifier in entity_ids:
                        raise ValueError(f"Line {line_number}: duplicate entity id")
                    supplier_prices = payload.get("supplierPrices")
                    if not isinstance(supplier_prices, list) or not supplier_prices:
                        raise ValueError(f"Line {line_number}: product needs supplierPrices")
                    supplier_ids = set()
                    for supplier_price in supplier_prices:
                        supplier_id = _object_id(supplier_price.get("supplierId"), "supplierId", line_number)
                        if contacts.get(supplier_id) != "vendor":
                            raise ValueError(f"Line {line_number}: supplier must exist first")
                        cost = _positive_number(
                            supplier_price.get("purchasePrice"), "purchasePrice", line_number
                        )
                        supplier_ids.add(supplier_id)
                        if cost >= _positive_number(payload.get("price"), "price", line_number):
                            raise ValueError(f"Line {line_number}: purchasePrice must be below sale price")
                    if payload.get("preferredSupplierId") not in supplier_ids:
                        raise ValueError(f"Line {line_number}: preferred supplier is not configured")
                    if payload.get("stock") != 0:
                        raise ValueError(f"Line {line_number}: products must start at stock zero")
                    entity_ids.add(identifier)
                    item_id = str(payload.get("sku", "")).removeprefix("M5-")
                    products[identifier] = {
                        "item_id": item_id, "price": float(payload["price"]),
                        "suppliers": supplier_ids,
                    }
                    counts["products"] += 1
                    continue

                if event_type == "transaction.completed":
                    transaction_id = _object_id(payload.get("_id"), "transaction._id", line_number)
                    if transaction_id in entity_ids:
                        raise ValueError(f"Line {line_number}: duplicate entity id")
                    entity_ids.add(transaction_id)
                    transaction_type = payload.get("type")
                    lines = payload.get("products")
                    if transaction_type not in {"sale", "purchase"} or not isinstance(lines, list) or not lines:
                        raise ValueError(f"Line {line_number}: invalid transaction")
                    vendor_id = payload.get("vendorId")
                    if transaction_type == "purchase" and contacts.get(vendor_id) != "vendor":
                        raise ValueError(f"Line {line_number}: purchase vendor must exist first")
                    normalized_lines = []
                    total = 0.0
                    for item in lines:
                        product_id = _object_id(item.get("productId"), "productId", line_number)
                        if product_id not in products:
                            raise ValueError(f"Line {line_number}: product must exist first")
                        quantity = item.get("quantity")
                        if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 1:
                            raise ValueError(f"Line {line_number}: quantity must be a positive integer")
                        if transaction_type == "purchase":
                            if vendor_id not in products[product_id]["suppliers"]:
                                raise ValueError(f"Line {line_number}: vendor is not configured for product")
                            stocks[product_id] += quantity
                            counts["purchase_transactions"] += 0
                        else:
                            stocks[product_id] -= quantity
                            if stocks[product_id] < 0:
                                raise ValueError(f"Line {line_number}: sale produces negative stock")
                            total += products[product_id]["price"] * quantity
                        normalized_lines.append((product_id, quantity))
                    notes = str(payload.get("notes", ""))
                    if transaction_type == "sale":
                        counts["sale_transactions"] += 1
                        counts["sale_lines"] += len(lines)
                        if notes.startswith("M5 demand; source_date="):
                            counts["m5_sale_transactions"] += 1
                            source_date = notes.split("=", 1)[1]
                            for product_id, quantity in normalized_lines:
                                demand_writer.writerow((products[product_id]["item_id"], source_date, quantity))
                                counts["materialized_m5_units"] += quantity
                        if payload.get("paymentMethod") == "credit":
                            customer_id = payload.get("customerId")
                            if contacts.get(customer_id) != "customer":
                                raise ValueError(f"Line {line_number}: credit requires an existing customer")
                            balances[customer_id] = round(balances[customer_id] + total, 2)
                        if notes.startswith("Synthetic cancellation exercise"):
                            counts["synthetic_cancellation_sales"] += 1
                    else:
                        counts["purchase_transactions"] += 1
                    if notes.startswith("Synthetic cancellation exercise"):
                        cancellable_transactions[transaction_id] = {
                            "type": transaction_type, "lines": normalized_lines,
                            "cancelled": False,
                            "credit": payload.get("paymentMethod") == "credit",
                        }
                    continue

                if event_type == "credit-payment.created":
                    identifier = _object_id(payload.get("_id"), "payment._id", line_number)
                    if identifier in entity_ids:
                        raise ValueError(f"Line {line_number}: duplicate entity id")
                    customer_id = payload.get("customerId")
                    if contacts.get(customer_id) != "customer":
                        raise ValueError(f"Line {line_number}: payment customer must exist first")
                    amount = _positive_number(payload.get("amount"), "payment amount", line_number)
                    if amount > balances[customer_id] + 1e-9:
                        raise ValueError(f"Line {line_number}: payment exceeds customer debt")
                    balances[customer_id] = round(balances[customer_id] - amount, 2)
                    entity_ids.add(identifier)
                    counts["credit_payments"] += 1
                    continue

                if event_type == "transaction.cancelled":
                    transaction_id = _object_id(payload.get("transactionId"), "transactionId", line_number)
                    transaction = cancellable_transactions.get(transaction_id)
                    if not transaction or transaction["cancelled"]:
                        raise ValueError(f"Line {line_number}: cancellation target is invalid")
                    if transaction["credit"]:
                        raise ValueError(f"Line {line_number}: generated credit sales cannot be cancelled")
                    direction = 1 if transaction["type"] == "sale" else -1
                    for product_id, quantity in transaction["lines"]:
                        stocks[product_id] += direction * quantity
                        if stocks[product_id] < 0:
                            raise ValueError(f"Line {line_number}: cancellation produces negative stock")
                    transaction["cancelled"] = True
                    counts["cancellations"] += 1
                    continue

                raise ValueError(f"Line {line_number}: unsupported eventType {event_type!r}")

        demand_stream.close()
        connection.execute(
            "CREATE TEMP VIEW actual_demand AS SELECT * FROM read_csv("
            f"{sql_literal(demand_path)}, header=false, "
            "columns={'item_id':'VARCHAR','source_date':'DATE','units':'BIGINT'})"
        )
        selected_ids = [
            item["item_id"] for item in selected_products
        ] if selected_products is not None else [item["item_id"] for item in products.values()]
        connection.execute("CREATE TEMP TABLE validation_products(item_id VARCHAR PRIMARY KEY)")
        connection.executemany("INSERT INTO validation_products VALUES (?)", [(item,) for item in selected_ids])
        mismatch = connection.execute(
            """
            WITH expected AS (
              SELECT b.item_id, b.source_date, sum(CAST(b.units_sold AS BIGINT)) AS units
              FROM read_parquet(?) b INNER JOIN validation_products p USING (item_id)
              WHERE b.store_id = ? AND b.source_date BETWEEN ? AND ? AND b.units_sold > 0
              GROUP BY b.item_id, b.source_date
            ), actual AS (
              SELECT item_id, source_date, sum(units) AS units
              FROM actual_demand GROUP BY item_id, source_date
            )
            SELECT count(*)
            FROM expected FULL OUTER JOIN actual USING (item_id, source_date)
            WHERE coalesce(expected.units, -1) <> coalesce(actual.units, -1)
            """,
            [str(config.bronze), config.source_store, config.source_start, config.source_end],
        ).fetchone()[0]
        if mismatch:
            raise ValueError(f"M5 demand reconciliation failed for {mismatch} product-days")
        expected_units = connection.execute(
            "SELECT coalesce(sum(units), 0) FROM actual_demand"
        ).fetchone()[0]
        counts["materialized_product_days"] = connection.execute(
            "SELECT count(*) FROM (SELECT item_id, source_date FROM actual_demand GROUP BY ALL)"
        ).fetchone()[0]
        if expected_units != counts["materialized_m5_units"]:
            raise ValueError("Internal materialized-unit count is inconsistent")
        return {
            "status": "passed",
            "checks": [
                "causal_order", "references", "supplier_relationships", "stock_non_negative",
                "positive_prices_and_costs", "credit_payments_not_over_debt",
                "valid_cancellations", "unique_ids", "unique_sourceEventId",
                "timestamp_timezone", "m5_demand_reconciliation",
            ],
            "counts": dict(counts),
            "ending_open_credit_pen": round(sum(balances.values()), 2),
            "minimum_ending_stock": min(stocks.values(), default=0),
        }
    finally:
        if not demand_stream.closed:
            demand_stream.close()
        connection.close()
        if demand_path.exists():
            demand_path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate ML-R2B NDJSON before Mongo import")
    parser.add_argument("--config", required=True)
    parser.add_argument("--file")
    args = parser.parse_args()
    try:
        config = load_scenario_config(args.config)
        result = validate_scenario(config, file_path=Path(args.file).resolve() if args.file else None)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"ML-R2B validation failed: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
