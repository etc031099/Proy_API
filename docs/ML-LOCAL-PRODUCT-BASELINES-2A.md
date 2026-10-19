# Fase 2A: baseline analítico por SKU en pruebas locales

La primera venta completada o cancelación de venta que afecta un SKU en el
epoch local captura su estado justo antes de esa operación. No es una
reconstrucción del estado analítico de todos los SKU al crear el checkpoint.
`baselineRevision` identifica la revisión del checkpoint; `capturedRevision`
identifica la revisión real del primer contacto con ese SKU y puede ser posterior.

## Activación y autoridades

Se requiere `ML_TEST_LOCAL_ENABLED=true`, `NODE_ENV` distinto de `production`,
la conexión local `rs0`/PRIMARY y la database esperada, validadas por
`mlTestTargetAuthorization`. Además se exige `TEST_ACTIVE`, epoch positivo y
checkpoint `READY` del tenant/scenario V3 fijo. Fuera de ese entorno, el hook
no ejecuta scoring ni provisiona índices/documentos.
Se reutilizan `MONGODB_URI`, `MONGODB_REPLICA_SET` y
`ML_TEST_LOCAL_EXPECTED_DATABASE`; no se añade otra variable de activación.

`mlTestProductBaselineService` reutiliza directamente los métodos `forecast`
(7d y 14d) y `productInventory` del dashboard V3, que son las autoridades de
las rutas operativas. No hace HTTP contra el propio backend ni replica
fórmulas. Conserva estados/nulls reales de respuestas LIVE; rechaza respuestas
históricas, MA28/HGB, errores de servicio o linaje no verificable. Un fallo de
captura local cancela esa operación: no se fabrica un BEFORE.

## Coordinación y concurrencia

1. Antes de las mutaciones se identifica el ciclo/epoch y se consultan solo
   SKU que todavía no tienen baseline en ese epoch.
2. Se preparan en memoria stock, coverage, risk, recommendation y Ridge 7/14.
   Se verifican las revisiones de las respuestas y la estabilidad de la
   revisión operacional y de los punteros ACTIVE durante estas lecturas.
3. En la misma sesión/transacción de negocio, antes de modificar stock, se
   escribe el control mediante el fence existente. Los writers protegidos
   compiten por ese mismo documento. Se revalidan epoch/ciclo/checkpoint READY,
   revisión, punteros ACTIVE y stock real en la sesión.
4. Se inserta con `$setOnInsert` dentro de esa transacción. El commit publica
   conjuntamente venta y baseline; cualquier abort los revierte juntos.

El índice único es
`businessId/scenarioId/checkpointId/testCycleId/resetEpoch/sku`.
Dos preparaciones simultáneas pueden leer el mismo BEFORE. Las transacciones
se serializan o reciben un write conflict en el control. La primera que
efectivamente confirma conserva el baseline; una posterior no lo reemplaza.
Si cambió la fuente y aún hay un SKU nuevo sin baseline, se devuelve
`ML_TEST_BASELINE_SOURCE_CHANGED` y debe reintentarse normalmente. No se
añaden reintentos que omitan validaciones ni se fuerza ninguna política ML.

Para ventas con sesión propia, el scoring ocurre antes de abrir la transacción.
El asistente conserva su sesión ya abierta: se respeta su commit/abort y se
valida el estado dentro de ella. Esto puede añadir latencia y consumir parte
de su presupuesto transaccional. Su skill de venta conserva el límite vigente
de 10 segundos: si el primer scoring local excede ese presupuesto, el flujo
del asistente aborta la operación y también el baseline. No se amplía ese
límite en esta fase; requiere validación con el runtime local real.
Una sesión que ya haya modificado otras
fuentes operacionales puede ser rechazada por discrepancia de revisión;
nunca se adopta una lectura posterior como si fuera la inicial.

## Colección auxiliar y restore

`mltestproductbaselines` no pertenece al manifiesto ni al payload del
checkpoint. El modelo tiene `autoCreate=false` y `autoIndex=false`; la
colección y el índice único se provisionan aditivamente al crear un checkpoint
mediante el executor LOCAL, antes de las futuras transacciones del asistente.
La captura local también comprueba/provisiona el índice antes de escribir.
No se agrega ninguna provisión al startup de producción.

Un TEST_ACTIVE antiguo, creado antes de esta fase y sin la colección auxiliar,
debe finalizarse y empezar un checkpoint nuevo antes de probar el asistente:
crear una colección después del snapshot de una sesión ya abierta puede
provocar un error Mongo seguro. La vía de venta con sesión propia sí realiza
su provisión antes de empezar la transacción.

Restore continue y finish eliminan los baselines del checkpoint/ciclo en la
misma transacción que adquiere el fence RESTORING e incrementa el epoch.
Un abort de esa transición revierte también la limpieza. Si falla una fase
posterior, la prueba permanece bloqueada por el contrato existente.
Al continuar, el siguiente contacto crea un baseline nuevo en el epoch nuevo.
La clave impide reutilizar cualquier epoch/ciclo anterior, aun si quedaron
metadatos antiguos. Los snapshots existentes no se alteran.

## Eventos

- CREATE sale: baseline previo al primer cambio de stock de esa operación.
- CANCEL sale: también captura si es el primer contacto, incluso al cancelar
  una venta anterior al checkpoint. Es el estado actual previo a cancelar,
  nunca el estado inferido de aquella venta histórica. Si ya hay baseline,
  no lo reemplaza. Si el catálogo/serving no puede verificarse, falla seguro.
- Purchase, cancelación de purchase, preview e importación histórica: no capturan.

## Verificación y siguiente fase

Los tests de servicio usan un store/sesiones simuladas; los tests de writers
invocan el código real de escritura/cancelación y mockean Mongo/ML. Los tests
de restore verifican el hook en la misma sesión de transición. No ejecutan
Atlas, scoring, entrenamiento, checkpoint ni restore reales.

Fase 2B deberá leer esta colección con scope estricto por checkpoint/ciclo/epoch,
exponer únicamente un contrato autenticado LOCAL y agregar las comparaciones
before/after. Esta fase no incorpora endpoint ni frontend para el baseline SKU.
