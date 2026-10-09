"""Build/validate an offline minimal replay using existing import primitives.

Product creation already emits an initial inventory movement; contact creation
already accepts currency balances. Both opening states derive from full replay.
CreditPayment is customer/currency based (no transaction foreign key); source
credit transactions are retained in the audit sidecar, not fake Mongo invoices.
"""
import copy
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from decimal import Decimal

from ml.service.model_runtime import ModelRuntime
from ml.src.common import repository_path, atomic_write_json, sha256_file
from ml.src.m5 import connect_duckdb
from ml.src.scenario.cloud_demo_v2 import CONFIG, balances, validate_features
from ml.src.scenario.config import load_scenario_config
from ml.src.scenario.generator import stable_rank
from ml.src.serving.scenarios import SCENARIOS

OUTPUT = "ml/data/operational/scenario_cloud_demo_v2_minimal.ndjson"
REPORT = "ml/reports/scenario_cloud_demo_v2_minimal_validation.json"


def cents(value):
    amount = Decimal(str(value)) * 100
    if not amount.is_finite() or amount < 0 or amount != amount.to_integral_value():
        raise ValueError("Invalid monetary value or fractional cent")
    return int(amount)


def financial_state(events, products):
    state = defaultdict(int)
    for e in events:
        p = e["payload"]
        if e["eventType"] == "transaction.completed" and p.get("paymentMethod") == "credit":
            amount = sum(cents(products[x["productId"]]["price"]) * x["quantity"] for x in p["products"])
            state[(p["customerId"], p["currency"])] += amount
        elif e["eventType"] == "credit-payment.created":
            state[(p["customerId"], p["currency"])] -= cents(p["amount"])
    if any(v < 0 for v in state.values()):
        raise ValueError("Negative opening receivable")
    return dict(state)


def make_package(events, selected, config):
    start = config.operational_start.isoformat()
    products = {e["payload"]["_id"]: e["payload"] for e in events if e["eventType"] == "product.created"}
    prior = [e for e in events if e["occurredAt"][:10] < start]
    opening_stock = balances(prior)
    opening_credit = financial_state(prior, products)
    window = [copy.deepcopy(e) for e in events if start <= e["occurredAt"][:10] <= config.operational_end.isoformat()
              and e["eventType"] not in ("product.created", "contact.created")]
    references = {x["supplierId"] for p in products.values() for x in p["supplierPrices"]}
    references.update(customer for (customer, _), value in opening_credit.items() if value)
    for e in window:
        references.update(e["payload"][k] for k in ("vendorId", "customerId") if e["payload"].get(k))
    bootstrap = []
    for e in events:
        if e["eventType"] == "contact.created" and e["payload"]["_id"] in references:
            new = copy.deepcopy(e)
            p = new["payload"]
            if p["type"] == "customer":
                p["balancesByCurrency"] = {currency: amount / 100 for (customer, currency), amount in opening_credit.items()
                    if customer == p["_id"]}
                p["currentBalance"] = p["balancesByCurrency"].get("PEN", 0)
            new["occurredAt"] = (config.operational_start - timedelta(days=2)).isoformat() + "T06:00:00Z"
            bootstrap.append(new)
        elif e["eventType"] == "product.created":
            new = copy.deepcopy(e)
            new["payload"]["stock"] = opening_stock.get(new["payload"]["_id"], 0)
            new["occurredAt"] = (config.operational_start - timedelta(days=1)).isoformat() + "T07:00:00Z"
            bootstrap.append(new)
    package = bootstrap + window
    for e in package:
        e["businessId"] = SCENARIOS["v2"]["businessId"]
    package.sort(key=lambda e: (e["occurredAt"], e["eventId"]))
    # Recover the origin of each R1 projected payment using its seeded event ID.
    credit_sources = {}
    for e in events:
        p = e["payload"]
        if e["eventType"] == "transaction.completed" and p.get("paymentMethod") == "credit":
            payment_event_id = config.scenario_id + ":projection:" + stable_rank(config.seed, e["sourceEventId"] + ":projected-payment")
            credit_sources[payment_event_id] = {"transactionId": p["_id"], "customerId": p["customerId"],
                "date": e["occurredAt"], "currency": p["currency"],
                "totalCents": sum(cents(products[x["productId"]]["price"]) * x["quantity"] for x in p["products"])}
    return package, {"openingStock": opening_stock,
        "openingCredit": [{"customerId": customer, "currency": currency, "amountCents": value}
            for (customer, currency), value in sorted(opening_credit.items()) if value],
        "creditSources": credit_sources,
        "priorCreditPayments": [{"eventId": e["eventId"], "customerId": e["payload"]["customerId"],
            "currency": e["payload"]["currency"], "amountCents": cents(e["payload"]["amount"])}
            for e in prior if e["eventType"] == "credit-payment.created"]}


def validate_package(full, package, audit, selected, config):
    expected_package, expected_audit = make_package(full, selected, config)
    if audit != expected_audit or package != expected_package:
        raise ValueError("Package/opening provenance differs from full replay")
    expected_window = [e for e in full if e["occurredAt"][:10] >= config.operational_start.isoformat()
                       and e["eventType"] not in ("product.created", "contact.created")]
    actual_window = [e for e in package if e["eventType"] not in ("product.created", "contact.created")]
    if [{k: v for k, v in e.items() if k != "businessId"} for e in actual_window] != expected_window:
        raise ValueError("Window transactions/payments/cancellations changed")
    contacts, products, transactions = {}, {}, {}
    stock, credit = defaultdict(int), defaultdict(int)
    counts, refs, suppliers_per_product = Counter(), Counter(), Counter()
    movement_count = 0
    totals = Counter()
    purchased, sold, reversed_units = Counter(), Counter(), Counter()
    event_ids = set()
    cancel_ids = set()
    previous = ""
    for e in package:
        if e["eventId"] in event_ids:
            raise ValueError("Duplicate event")
        event_ids.add(e["eventId"])
        parsed = datetime.fromisoformat(e["occurredAt"].replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError("Date requires timezone")
        if e["businessId"] != SCENARIOS["v2"]["businessId"] or e["scenarioId"] != config.scenario_id:
            raise ValueError("Cross-tenant/scenario event")
        if e["occurredAt"] < previous or e["occurredAt"][:10] > config.operational_end.isoformat():
            raise ValueError("Invalid/future event date")
        previous = e["occurredAt"]
        p, kind = e["payload"], e["eventType"]
        if kind == "contact.created":
            if p["_id"] in contacts:
                raise ValueError("Duplicate contact")
            contacts[p["_id"]] = p
            counts["suppliers" if p["type"] == "vendor" else "customers"] += 1
            for currency, amount in p.get("balancesByCurrency", {}).items():
                credit[(p["_id"], currency)] = cents(amount)
        elif kind == "product.created":
            if p["_id"] in products or p["stock"] != audit["openingStock"].get(p["_id"], 0):
                raise ValueError("Invalid/duplicate opening product")
            products[p["_id"]] = p
            if type(p["stock"]) is not int or p["stock"] < 0 or cents(p["price"]) <= 0:
                raise ValueError("Invalid opening stock/product price")
            stock[p["_id"]] = p["stock"]
            movement_count += int(p["stock"] > 0)
            for relation in p["supplierPrices"]:
                if contacts.get(relation["supplierId"], {}).get("type") != "vendor" or cents(relation["purchasePrice"]) <= 0:
                    raise ValueError("Orphan/invalid supplier relation")
                refs["product-supplier relations"] += 1
                refs["products"] += 1
            if p["preferredSupplierId"] not in {x["supplierId"] for x in p["supplierPrices"]}:
                raise ValueError("Orphan preferred supplier")
            suppliers_per_product[len(p["supplierPrices"])] += 1
            counts["products"] += 1
        elif kind == "transaction.completed":
            transactions[p["_id"]] = p
            if p["currency"] != "PEN":
                raise ValueError("Unexpected native currency")
            if p["type"] == "purchase" and contacts.get(p.get("vendorId"), {}).get("type") != "vendor":
                raise ValueError("Purchase requires an existing vendor")
            if p.get("customerId") and contacts.get(p["customerId"], {}).get("type") != "customer":
                raise ValueError("Orphan sale customer")
            total = 0
            for line in p["products"]:
                product = products.get(line["productId"])
                if product is None or type(line["quantity"]) is not int or line["quantity"] <= 0:
                    raise ValueError("Invalid product/quantity")
                price = product["price"] if p["type"] == "sale" else next(
                    (x["purchasePrice"] for x in product["supplierPrices"] if x["supplierId"] == p["vendorId"]), None)
                if price is None or cents(price) <= 0:
                    raise ValueError("Purchase vendor not associated with product")
                total += cents(price) * line["quantity"]
                stock[line["productId"]] += line["quantity"] * (1 if p["type"] == "purchase" else -1)
                (purchased if p["type"] == "purchase" else sold)[line["productId"]] += line["quantity"]
                movement_count += 1
            if p.get("paymentMethod") == "credit":
                credit[(p["customerId"], p["currency"])] += total
                counts["credits"] += 1
            if p["type"] == "sale":
                counts["sales_with_customer" if p.get("customerId") else "anonymous_sales"] += 1
            counts["sales" if p["type"] == "sale" else "purchases"] += 1
            totals[p["type"]] += total
            refs["sales" if p["type"] == "sale" else "purchases"] += len(p["products"]) + int(bool(p.get("customerId"))) + int(bool(p.get("vendorId")))
            refs["credits"] += int(p.get("paymentMethod") == "credit")
        elif kind == "credit-payment.created":
            source = audit["creditSources"].get(e["eventId"])
            if not source or source["customerId"] != p["customerId"] or source["currency"] != p["currency"]:
                raise ValueError("Payment missing source credit evidence")
            key = (p["customerId"], p["currency"])
            amount = cents(p["amount"])
            if amount <= 0 or amount > credit[key] or p["customerId"] not in contacts:
                raise ValueError("Invalid payment/balance")
            credit[key] -= amount
            counts["payments"] += 1
            refs["payments"] += 2
        elif kind == "transaction.cancelled":
            tx = transactions.get(p["transactionId"])
            if not tx or p["transactionId"] in cancel_ids or tx.get("paymentMethod") == "credit":
                raise ValueError("Orphan/duplicate cancellation")
            cancel_ids.add(p["transactionId"])
            for line in tx["products"]:
                stock[line["productId"]] += line["quantity"]
                reversed_units[line["productId"]] += line["quantity"]
                movement_count += 1
            counts["cancellations"] += 1
            refs["cancellations"] += 1
            totals["cancelled_sale"] += sum(cents(products[x["productId"]]["price"]) * x["quantity"] for x in tx["products"])
        else:
            raise ValueError("Unsupported package event")
        if any(value < 0 for value in stock.values()):
            raise ValueError("Negative stock")
    full_products = {e["payload"]["_id"]: e["payload"] for e in full if e["eventType"] == "product.created"}
    if dict(stock) != balances(full) or {k: v for k, v in credit.items() if v} != {k: v for k, v in financial_state(full, full_products).items() if v}:
        raise ValueError("Full/minimal stock or closing credit differs")
    counts["inventory movements"] = movement_count
    refs["inventory movements"] = movement_count
    counts["product-supplier relations"] = refs["product-supplier relations"]
    quality = [{"entity": name, "count": counts[name], "validReferences": refs[name], "orphanReferences": 0,
                "crossTenantReferences": 0, "invalidMonetaryValues": 0, "invalidDates": 0}
               for name in ("products", "suppliers", "product-supplier relations", "customers", "sales", "purchases", "payments", "credits", "cancellations", "inventory movements")]
    runtime = ModelRuntime()
    runtime.load()
    connection = connect_duckdb()
    try:
        parity = validate_features(connection, config, package, selected, runtime.builders["v2"], runtime)
    finally:
        connection.close()
    return {"counts": dict(counts), "quality": quality, "parity": parity, "openingStockTotal": sum(audit["openingStock"].values()),
        "amountsPENCents": dict(totals),
        "inventoryReconciliation": [{"productId": key, "sku": products[key]["sku"],
            "openingStock": audit["openingStock"].get(key, 0), "purchasedUnits": purchased[key],
            "soldUnits": sold[key], "reversedUnits": reversed_units[key], "stockAtAnchor": stock[key]}
            for key in sorted(products)],
        "closingStockEquivalent": True, "closingCreditEquivalent": True,
        "windowEventsIdentical": True, "forecastAndRecommendationEquivalent": True,
        "supplierCoverage": {"zero": suppliers_per_product[0], "one": suppliers_per_product[1],
            "multiple": sum(n for k, n in suppliers_per_product.items() if k > 1)}}


def generate():
    config = load_scenario_config(CONFIG)
    path, report_path = repository_path(OUTPUT), repository_path(REPORT)
    if path.exists() or report_path.exists():
        raise FileExistsError("Minimal package already exists; never overwrite implicitly")
    manifest = json.loads(config.manifest.read_text(encoding="utf-8"))
    if sha256_file(config.output) != manifest["ndjson_sha256"]:
        raise ValueError("Full v2 replay hash mismatch")
    full = [json.loads(line) for line in config.output.read_text(encoding="utf-8").splitlines()]
    package, audit = make_package(full, manifest["products"], config)
    result = validate_package(full, package, audit, manifest["products"], config)
    with path.open('x', encoding="utf-8", newline="\n") as stream:
        for event in package:
            stream.write(json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n')
    result.update(businessId=SCENARIOS["v2"]["businessId"], scenarioId=config.scenario_id,
        sourceFullSha256=manifest["ndjson_sha256"], packageSha256=sha256_file(path),
        sourceManifestSha256=sha256_file(config.manifest), audit=audit,
        note="CreditPayment is customer/currency based; source transactions live in audit, not fake invoice records")
    atomic_write_json(report_path, result)
    return {k: v for k, v in result.items() if k != "audit"}


def revalidate_existing():
    """Refresh validation only; never rewrite the existing operational package."""
    config = load_scenario_config(CONFIG)
    report_path = repository_path(REPORT)
    previous = json.loads(report_path.read_text(encoding="utf-8"))
    manifest = json.loads(config.manifest.read_text(encoding="utf-8"))
    if (sha256_file(config.output) != manifest["ndjson_sha256"]
            or sha256_file(repository_path(OUTPUT)) != previous["packageSha256"]):
        raise ValueError("Existing full/minimal replay hash mismatch")
    full = [json.loads(line) for line in config.output.read_text(encoding="utf-8").splitlines()]
    package = [json.loads(line) for line in repository_path(OUTPUT).read_text(encoding="utf-8").splitlines()]
    result = validate_package(full, package, previous["audit"], manifest["products"], config)
    previous.update(result)
    atomic_write_json(report_path, previous)
    return {k: v for k, v in previous.items() if k != "audit"}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revalidate-existing', action='store_true')
    options = parser.parse_args()
    print(json.dumps(revalidate_existing() if options.revalidate_existing else generate(), indent=2))
