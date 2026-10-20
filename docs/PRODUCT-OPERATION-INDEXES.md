# Índices para historial de operaciones por producto

Este manifiesto prepara consultas futuras de historial por SKU. No añade endpoint ni modifica la escritura de operaciones. Los índices son no únicos y aditivos; el servicio no elimina ni sincroniza índices existentes.

## Índices

| Nombre | Colección | Uso |
| --- | --- | --- |
| `product_ops_tx_created_v1` | `transactions` | Ventas y compras por producto, ordenadas por fecha de creación |
| `product_ops_tx_cancelled_v1` | `transactions` | Cancelaciones con fecha válida, ordenadas por `cancelledAt` |
| `product_ops_mov_events_v1` | `inventorymovements` | Recepciones explícitas y ajustes manuales por producto |
| `product_ops_change_entity_v1` | `v3operationalchanges` | Enriquecimiento del diario por `entityKey` |

Las definiciones completas y los filtros parciales están en `backend/src/services/productOperationIndexes.js`. Los dos índices de transacciones tienen una sola ruta de arreglo (`products.productId`); no combinan arreglos.

## Verificar y aprovisionar

Desde `backend`, configurar `MONGODB_URI` y `PRODUCT_OP_INDEX_EXPECTED_DATABASE`. La URI debe contener exactamente la base esperada; ambos valores se mantienen fuera de argumentos y salida.

```powershell
node scripts/product-operation-indexes.js --check
node scripts/product-operation-indexes.js --apply
node scripts/product-operation-indexes.js --check
```

`--check` es el modo por defecto y solo lista `PRESENT`, `MISSING` o `CONFLICT`. `--apply` es explícito, crea únicamente los faltantes y requiere que las colecciones ya existan. En host remoto queda bloqueado a menos que, después de certificar el entorno local, se configure también `PRODUCT_OP_INDEX_ALLOW_REMOTE_APPLY=CREATE_PRODUCT_OPERATION_INDEXES`. Si detecta cualquier conflicto, se detiene antes de crear índices. Una definición equivalente con otro nombre se reporta como presente y no se duplica.

## Certificar planes localmente

Configurar además `PRODUCT_OP_INDEX_BUSINESS_ID` y `PRODUCT_OP_INDEX_SCENARIO_ID`, y elegir un SKU de prueba ya existente:

```powershell
node scripts/certify-product-operation-query-plans.js --sku SNA-PAP-002
```

El informe `executionStats` cubre SALE, PURCHASE_CREATED, SALE_CANCELLED, PURCHASE_RECEIVED, INVENTORY_ADJUSTMENT y enriquecimiento del diario. La certificación no escribe datos y acepta únicamente host local (`localhost`, `127.0.0.1`, `::1` o `host.docker.internal`). En compras recibidas acepta el índice observado `businessId_1_productId_1_occurredAt_1_createdAt_1` y también reconoce I3 si el optimizador lo elige; nunca aplica `.hint()`.

La primera medición local reportó para PURCHASE_RECEIVED: 218 claves/documentos examinados, 20 filas, SORT bloqueante y ~4 ms con el índice existente. Al forzar I3 solo para medirlo, se observaron 3379 claves/documentos y ~17 ms; por eso no se debe forzar I3 para esa consulta. El SORT conocido queda visible como `PASS_WITH_REVIEW`, con nota para volver a medirlo en Atlas antes de producción. Esos tiempos son observaciones del dataset local, no una garantía de producción. Para el resto de consultas, un índice no aceptado produce `INDEX_NOT_USED`; un SORT bloqueante inesperado queda `REVIEW_BLOCKING_SORT`.

El JSON muestra, por consulta, el índice obligatorio o los índices aceptados, el plan usado, métricas y estado. Si falla una operación inesperadamente, el CLI informa etapa y tipo de excepción seguros, sin mensaje, stack ni URI.

La secuencia prevista es verificar, aprovisionar y certificar primero en el Mongo local autorizado. Atlas no se aprovisiona hasta que esa certificación local sea revisada y autorizada expresamente; no se ejecuta ningún comando cloud desde esta fase.

Los documentos legacy no se migran: I1 admite líneas sin SKU porque indexa `productId`; I2 excluye operaciones que no sean ventas canceladas con fecha BSON Date; I3 limita las entradas al conjunto de recepciones/ajustes aprobado; I4 cubre cambios V3 con identidad de entidad.
