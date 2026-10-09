# CLOUD-DEMO V2: paquete mínimo y plan de importación futura

R2 es local: **no se ha importado en Atlas ni desplegado**. V1 permanece disponible.
Registro compartido: `backend/src/config/mlScenarios.json`. Node selecciona la
configuración por business autenticado; FastAPI exige la pareja business/scenario
y el ancla registrados. No existen manifests elegibles desde el cliente.

| Escenario | Business | Ancla operacional | Ancla fuente |
| --- | --- | --- | --- |
| v1 | ML-CLOUD-DEMO | 2025-07-01 | 2015-06-30 |
| v2 | ML-CLOUD-DEMO-V2 | 2026-05-17 | 2016-05-15 |

Ambos usan CA_3, offset 3654 días, 60 productos, demand-v1, 31 features y el
mismo modelo de siete días. Cada builder verifica sus artifacts de lineage;
el runtime verifica tamaño/hash del único joblib antes de cargarlo.

## Qué se importa y qué se conserva fuera de Mongo

- **Features:** 197 días completos, 2025-11-02 → 2026-05-17, incluyendo ceros.
  Las ventas completed excluyen canceladas. Precios/calendario/categorías y
  active age vienen del lineage v2, no del bootstrap transaccional eliminado.
- **Apertura:** stock por producto derivado exactamente del replay anterior a
  la ventana: 1,073 unidades. `product.created` usa el primitivo existente de
  inventario inicial; no se fabrica una compra. Stock final: 815 unidades.
- **UI:** 6,703 transacciones originales de la ventana (5,940 ventas y 763
  compras), sus 12 cancelaciones y 208 pagos. No se eliminan ventas anónimas:
  el sistema real las admite. Los display names M5 honestos y SKUs se conservan.
- **Crédito:** saldo inicial por cliente/moneda derivado de ventas a crédito
  menos pagos previos. `contact.created` admite esos saldos. CreditPayment en
  este repositorio referencia cliente/moneda, **no una factura individual**.
  El sidecar conserva la transacción fuente de cada pago y su procedencia;
  las fuentes anteriores a la ventana no se importan como facturas ficticias.
  El saldo final coincide con el replay completo. Consultas de facturas previas
  a la ventana requerirían el archivo completo; no están en este paquete.
- **Futuro:** ningún evento supera el ancla. El horizonte 2026-05-18 → 2026-05-24
  es predicción agregada, no ventas observadas a importar.

Por producto se valida apertura + compras − ventas + cancelaciones = stock al
ancla, sin stock negativo durante el replay. Se conservan exactamente los
eventos recientes; se comparan el batch Node y su recomendación con el replay
completo. La paridad Gold/serving tiene 1,860 comparaciones, cero diferencias
a tolerancia 1e-5 y 60 READY. Resultado: 24 OK, 3 VIGILAR, 33 REPONER.

## Calidad relacional

Conteos de **referencias comprobadas**, no de entidades con referencia. Cero
en proveedores/clientes significa que son entidades raíz. Movimientos cuentan
los que emiten los servicios existentes; no se duplican como eventos NDJSON.

| Entidad | Cantidad | Referencias válidas | Huérfanas | Cross-tenant | Importes inválidos | Fechas inválidas |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Productos | 60 | 122 | 0 | 0 | 0 | 0 |
| Proveedores | 61 | 0 | 0 | 0 | 0 | 0 |
| Relaciones producto-proveedor | 122 | 122 | 0 | 0 | 0 | 0 |
| Clientes | 1043 | 0 | 0 | 0 | 0 | 0 |
| Ventas | 5940 | 9237 | 0 | 0 | 0 | 0 |
| Compras | 763 | 1526 | 0 | 0 | 0 | 0 |
| Pagos | 208 | 416 | 0 | 0 | 0 | 0 |
| Créditos | 208 | 208 | 0 | 0 | 0 | 0 |
| Cancelaciones | 12 | 12 | 0 | 0 | 0 | 0 |
| Movimientos de inventario | 7623 | 7623 | 0 | 0 | 0 | 0 |

Todos los productos tienen proveedor: 17 con uno y 43 con más de uno.
Hay 2,449 ventas con cliente y 3,491 anónimas. Los importes se reconcilian en
céntimos PEN: ventas 25,207,511; compras 16,877,916; ventas canceladas 14,332.
No son utilidad ni importes convertidos entre monedas.

## Artifacts y reproducción local

- Completo: `ml/data/operational/scenario_cloud_demo_v2.ndjson` (50,442
  transacciones; hash en manifest R1).
- Mínimo: `ml/data/operational/scenario_cloud_demo_v2_minimal.ndjson` (6,703
  transacciones; 4,651,594 bytes; no versionado).
- Reporte/procedencia: `ml/reports/scenario_cloud_demo_v2_minimal_validation.json`.
- Lineage: `ml/data/serving/cloud_demo_v2/` (versionado desde R1).

Desde la raíz, con dependencias Python instaladas:

```sh
python -m ml.src.scenario.cloud_demo_v2_minimal
python -m ml.src.scenario.cloud_demo_v2_minimal --revalidate-existing
python -m unittest ml.tests.test_dual_cloud_demo
```

El primer comando requiere replay completo, manifest R1, Gold y modelo locales;
rechaza sobrescrituras. El segundo verifica hashes y actualiza solo el reporte,
no el NDJSON. Las pruebas pesadas hacen SKIP si faltan datasets locales.
La suite Node compara historias/recomendaciones con predicciones validadas por
Python; su cliente ML es fake, no una llamada cloud. La integración Mongo local
comprueba con fixtures el importador real, apertura, crédito y cancelaciones;
**no se ha importado todo el paquete mínimo en Mongo durante R2**.

SHA-256 mínimo:
`9fdad755b4fc596600802846a7d50b3fa37af15b924f98b430451b3bc2bcce07`.
Joblib inalterado:
`82f133a3390420556e69f090a5bdbeb4091bbe5f90f2260e790adf2b24741902`.

## Plan futuro, requiere autorización separada

1. Verificar hashes del replay, reporte, lineage y joblib; repetir validaciones.
2. Confirmar business autenticable **ML-CLOUD-DEMO-V2**, separado de v1, y
   replica-set PRIMARY. El importador usa el business/scenario del comando:
   no confiar en que el NDJSON imponga el tenant. Revisar ambos antes de usarlo.
3. Preparar backup y comprobar que no existe importación parcial del escenario.
   No resetear ni borrar v1. Revisar `MONGODB_URI` de forma privada: el script
   existente carga `.env`, así que no ejecutarlo accidentalmente contra Atlas.
4. Solo tras autorización, desde `backend/`, el comando existente sería:

   ```sh
   npm run import:historical-scenario -- --file=../ml/data/operational/scenario_cloud_demo_v2_minimal.ndjson --business-id=ML-CLOUD-DEMO-V2 --scenario-id=m5-ca3-cloud-demo-v2 --batch-size=500
   ```

5. Comprobar cantidades, fechas, relaciones, saldos y stock por producto tras
   importar; validar un batch autenticado 60 READY y sus resultados esperados.
   No declarar éxito solo porque el importador finalice.
6. Desplegar soporte dual únicamente en fase autorizada; verificar v1 y v2.
   No ampliar aún consultas del asistente ni alterar frontend/Telegram/RAG.

**Decisión R2:** paquete mínimo apto para la importación futura de esta ventana
de demo, con apertura derivada y trazable. No representa un archivo completo
de facturas históricas ni sustituye el respaldo full local.
