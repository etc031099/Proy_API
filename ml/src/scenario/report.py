from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from ml.src.common import repository_path, sha256_file
from ml.src.scenario.config import ScenarioConfig, load_scenario_config


def _verify_manifest(config: ScenarioConfig, manifest: dict[str, Any]) -> None:
    expected = {
        "source_bronze_sha256": sha256_file(config.bronze),
        "m5_raw_manifest_sha256": sha256_file(config.raw_manifest),
        "config_sha256": config.config_hash,
        "ndjson_sha256": sha256_file(config.output),
    }
    mismatches = {
        key: {"manifest": manifest.get(key), "actual": value}
        for key, value in expected.items() if manifest.get(key) != value
    }
    if mismatches:
        raise ValueError(f"Manifest hash verification failed: {mismatches}")
    if manifest.get("scenarioId") != config.scenario_id:
        raise ValueError("Manifest scenarioId does not match configuration")
    if manifest.get("validation", {}).get("status") != "passed":
        raise ValueError("Scenario validation has not passed")


def _metric(distribution: dict[str, Any]) -> str:
    return (
        f"mín. {distribution['min']}, media {distribution['mean']}, "
        f"máx. {distribution['max']}"
    )


def build_summary(config_path: str | Path, output_path: str | Path) -> Path:
    config = load_scenario_config(config_path)
    manifest = json.loads(config.manifest.read_text(encoding="utf-8"))
    _verify_manifest(config, manifest)
    validation = manifest["validation"]
    counts = manifest["counts"]
    demand = validation["demand_reconciliation"]
    stock = validation["stock"]
    suppliers = validation["suppliers"]
    customers = validation["customers"]
    credit = validation["credit"]
    cancellations = validation["cancellations"]
    dates = validation["dates"]
    segment_rows = [
        f"| {segment} | {values['transactions']} | {values['amount_pen']:.2f} | {values['average_ticket_pen']:.2f} |"
        for segment, values in customers["ticket_by_segment"].items()
    ]
    output = repository_path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Escenario operacional M5 CA_3 — NORMAL",
        "",
        "> Estado: validación offline aprobada. Este escenario todavía no ha sido importado a MongoDB.",
        "",
        "## Propósito y arquitectura",
        "",
        "NORMAL es el escenario recomendado para la presentación académica: conserva tres años, "
        "600 productos y suficiente volumen transaccional sin el costo operativo de LARGE.",
        "",
        "`M5 Bronze completo → selección estratificada → simulación operacional determinista "
        "→ NDJSON streaming → validación independiente → Historical Importer → MongoDB`",
        "",
        "El dataset ML permanece separado: Bronze contiene 5.918.109 observaciones de CA_3. "
        "Mongo recibirá solamente esta materialización operacional para la demo.",
        "",
        "## Volumen",
        "",
        f"- Scenario ID: `{manifest['scenarioId']}`; semilla: `{manifest['seed']}`.",
        f"- Productos: {counts['products']}; proveedores: {counts['suppliers']}; clientes: {counts['customers']}.",
        f"- Transacciones: {counts['transactions']} ({counts['purchases']} compras y {counts['sales']} ventas).",
        f"- Ventas M5 válidas: {counts['m5_sales']}; ventas sintéticas cancelables: {counts['synthetic_cancellation_sales']}.",
        f"- Líneas de venta: {counts['sale_lines']}; unidades M5: {counts['materialized_m5_units']}.",
        f"- Pagos: {counts['payments']}; cancelaciones: {counts['cancellations']}.",
        f"- Movimientos de inventario esperados: {counts['expected_inventory_movements']}.",
        f"- NDJSON: {manifest['ndjson_size_bytes'] / 1_000_000:.2f} MB; eventos: {counts['events']}.",
        "",
        "## Reconciliación",
        "",
        f"- Bronze esperado: {demand['expected_units']} unidades.",
        f"- Operacional válido: {demand['actual_units']} unidades.",
        f"- Diferencia absoluta: {demand['absolute_difference']}; diferencia porcentual: {demand['percentage_difference']}%.",
        f"- Productos con mismatch: {demand['mismatched_products']}.",
        "",
        "## Inventario y compras",
        "",
        f"- Stock mínimo observado durante el replay: {stock['minimum_observed']}.",
        f"- Stock final total: {stock['ending_total_units']} unidades.",
        f"- Compras iniciales: {stock['initial_purchases']}; reposiciones planificadas: {stock['planned_replenishments']}.",
        f"- Recepciones de emergencia/stockouts evitados: {stock['emergency_receipts']} en {stock['products_with_emergency_receipt']} productos.",
        f"- Proveedores por producto: {_metric(suppliers['suppliers_per_product'])}.",
        f"- Productos por proveedor: {_metric(suppliers['products_per_supplier'])}.",
        f"- Lead time asignado: {_metric(suppliers['assigned_lead_time_days'])} días.",
        "",
        "## Clientes, crédito y cancelaciones",
        "",
        f"- Ventas identificadas: {customers['identified_sales']}; anónimas: {customers['anonymous_sales']}.",
        f"- Clientes habilitados para crédito: {customers['credit_enabled_customers']}.",
        "",
        "| Segmento | Tickets | Importe PEN | Ticket promedio PEN |",
        "| --- | ---: | ---: | ---: |",
        *segment_rows,
        "",
        f"- Ventas a crédito: {credit['sales']} por PEN {credit['sales_amount_pen']:.2f}.",
        f"- Pagos: {credit['payments']} por PEN {credit['payment_amount_pen']:.2f}; parciales: {credit['partial_payments']}; totales: {credit['full_payments']}.",
        f"- Clientes con deuda abierta: {credit['customers_with_open_debt']}; deuda abierta final: PEN {credit['ending_open_credit_pen']:.2f}.",
        f"- Deuda de proveedores: PEN {credit['vendor_debt_pen']:.2f}.",
        f"- Cancelaciones sintéticas: {cancellations['count']} ({cancellations['rate_over_m5_sales_percentage']}% respecto de tickets M5 válidos).",
        "",
        "## Fechas y procedencia",
        "",
        f"- Source range: `{dates['source_range'][0]}` a `{dates['source_range'][1]}`.",
        f"- Operational range: `{dates['operational_range'][0]}` a `{dates['operational_range'][1]}`.",
        f"- Offset: {dates['offset_days']} días; weekday e intervalos conservados.",
        "",
        "| Campo | Procedencia |",
        "| --- | --- |",
        *[f"| `{field}` | {origin} |" for field, origin in manifest["field_provenance"].items()],
        "",
        "## Integridad y hashes",
        "",
        f"- Bronze SHA-256: `{manifest['source_bronze_sha256']}`",
        f"- M5 raw manifest SHA-256: `{manifest['m5_raw_manifest_sha256']}`",
        f"- Config SHA-256: `{manifest['config_sha256']}`",
        f"- NDJSON SHA-256: `{manifest['ndjson_sha256']}`",
        "",
        "## Limitaciones",
        "",
        "- M5 aporta demanda, calendario y precio, pero no inventario real, clientes ni proveedores.",
        "- Precio operacional fijo por producto: el backend todavía no tiene PriceHistory.",
        "- Inventario, crédito, clientes y proveedores son sintéticos y no son features del primer modelo ML.",
        "- Las reposiciones de emergencia preservan demanda observada; no prueban ausencia de stockouts en el mundo real.",
        "- Este informe no contiene entrenamiento, predicciones ni métricas de un modelo ML.",
        "",
        "## Siguiente paso aprobado, todavía no ejecutado",
        "",
        "Desde `backend/`, importar NORMAL al tenant confirmado `Dan-07`:",
        "",
        "```powershell",
        "npm.cmd run import:historical-scenario -- --file=../ml/data/operational/scenario_normal.ndjson --business-id=Dan-07 --scenario-id=m5-ca3-normal-v1 --batch-size=500",
        "```",
        "",
        "Reset explícito del mismo escenario:",
        "",
        "```powershell",
        "npm.cmd run reset:historical-scenario -- --business-id=Dan-07 --scenario-id=m5-ca3-normal-v1 --confirm",
        "```",
        "",
    ]
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text("\n".join(lines), encoding="utf-8")
    os.replace(temporary, output)
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the reviewed ML-R2C scenario summary")
    parser.add_argument("--config", default="ml/config/scenario_normal.toml")
    parser.add_argument("--output", default="ml/reports/scenario_normal_summary.md")
    args = parser.parse_args()
    try:
        output = build_summary(args.config, args.output)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"ML-R2C report failed: {error}", file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
