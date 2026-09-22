# Escenario operacional M5 CA_3 — NORMAL

> Estado: validación offline aprobada. Este escenario todavía no ha sido importado a MongoDB.

## Propósito y arquitectura

NORMAL es el escenario recomendado para la presentación académica: conserva tres años, 600 productos y suficiente volumen transaccional sin el costo operativo de LARGE.

`M5 Bronze completo → selección estratificada → simulación operacional determinista → NDJSON streaming → validación independiente → Historical Importer → MongoDB`

El dataset ML permanece separado: Bronze contiene 5.918.109 observaciones de CA_3. Mongo recibirá solamente esta materialización operacional para la demo.

## Volumen

- Scenario ID: `m5-ca3-normal-v1`; semilla: `2026`.
- Productos: 600; proveedores: 50; clientes: 500.
- Transacciones: 119371 (33600 compras y 85771 ventas).
- Ventas M5 válidas: 85091; ventas sintéticas cancelables: 680.
- Líneas de venta: 365452; unidades M5: 925655.
- Pagos: 2830; cancelaciones: 680.
- Movimientos de inventario esperados: 399732.
- NDJSON: 70.13 MB; eventos: 124031.

## Reconciliación

- Bronze esperado: 925655 unidades.
- Operacional válido: 925655 unidades.
- Diferencia absoluta: 0; diferencia porcentual: 0.0%.
- Productos con mismatch: 0.

## Inventario y compras

- Stock mínimo observado durante el replay: 0.
- Stock final total: 13940 unidades.
- Compras iniciales: 600; reposiciones planificadas: 26137.
- Recepciones de emergencia/stockouts evitados: 6863 en 366 productos.
- Proveedores por producto: mín. 1, media 1.977, máx. 3.
- Productos por proveedor: mín. 18, media 23.72, máx. 28.
- Lead time asignado: mín. 2, media 5.465, máx. 9 días.

## Clientes, crédito y cancelaciones

- Ventas identificadas: 35584; anónimas: 49507.
- Clientes habilitados para crédito: 25.

| Segmento | Tickets | Importe PEN | Ticket promedio PEN |
| --- | ---: | ---: | ---: |
| anonymous | 49507 | 7218767.89 | 145.81 |
| credit-enabled | 4481 | 642710.08 | 143.43 |
| frequent | 8175 | 1215782.73 | 148.72 |
| high-ticket | 3290 | 480915.50 | 146.17 |
| occasional | 17970 | 2621559.44 | 145.89 |
| small-wholesale | 1668 | 243188.73 | 145.80 |

- Ventas a crédito: 2830 por PEN 409426.65.
- Pagos: 2830 por PEN 286597.58; parciales: 2830; totales: 0.
- Clientes con deuda abierta: 25; deuda abierta final: PEN 122829.07.
- Deuda de proveedores: PEN 0.00.
- Cancelaciones sintéticas: 680 (0.7991% respecto de tickets M5 válidos).

## Fechas y procedencia

- Source range: `2013-01-01` a `2015-12-31`.
- Operational range: `2023-01-03` a `2026-01-01`.
- Offset: 3654 días; weekday e intervalos conservados.

| Campo | Procedencia |
| --- | --- |
| `units_sold` | REAL |
| `sell_price` | REAL |
| `source_date` | REAL |
| `operational_date` | DERIVED |
| `supplierId` | SYNTHETIC |
| `customerId` | SYNTHETIC |
| `purchasePrice` | SYNTHETIC |
| `stock` | DERIVED |
| `minStockLevel` | DERIVED |
| `leadTime` | SYNTHETIC |
| `credit` | SYNTHETIC |
| `payments` | SYNTHETIC |
| `cancelledAt` | SYNTHETIC |

## Integridad y hashes

- Bronze SHA-256: `3029c1b390d96a2da02c589df9b7e750be458bea5bc04855dc5942e2cc96c8a6`
- M5 raw manifest SHA-256: `8ed19849c600da535328756a9cdd1886479abfe118c458319b14709fd6d0edfc`
- Config SHA-256: `33921143bd5a66512fc70178a36a564cdc246b9ce5c74294309b9bbfba93da47`
- NDJSON SHA-256: `e04c3b96d107bafb611bcc39d52bcca220152329a51c2afb5b005477f0ff900f`

## Limitaciones

- M5 aporta demanda, calendario y precio, pero no inventario real, clientes ni proveedores.
- Precio operacional fijo por producto: el backend todavía no tiene PriceHistory.
- Inventario, crédito, clientes y proveedores son sintéticos y no son features del primer modelo ML.
- Las reposiciones de emergencia preservan demanda observada; no prueban ausencia de stockouts en el mundo real.
- Este informe no contiene entrenamiento, predicciones ni métricas de un modelo ML.

## Siguiente paso aprobado, todavía no ejecutado

Desde `backend/`, importar NORMAL al tenant confirmado `Dan-07`:

```powershell
npm.cmd run import:historical-scenario -- --file=../ml/data/operational/scenario_normal.ndjson --business-id=Dan-07 --scenario-id=m5-ca3-normal-v1 --batch-size=500
```

Reset explícito del mismo escenario:

```powershell
npm.cmd run reset:historical-scenario -- --business-id=Dan-07 --scenario-id=m5-ca3-normal-v1 --confirm
```
