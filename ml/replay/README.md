# Replay histórico ML (local)

Este runner no usa Mongo, Registry, outbox, historial operativo ni GitHub.
Comparte la receta CAUSAL27, el serializer/scorer Ridge y la evaluación numérica
con el código existente. No llama a `v3_ridge_training.train()` ni sustituye el
protocolo de autorización LIVE. Solo admite 7d y 14d.

Desde la raíz del repositorio, con un Python que ya tenga las dependencias ML:

```powershell
& $env:FORECAST_TRAINING_PYTHON -m ml.replay.runner prepare --run-id mi-replay --seed 2026 --profile STABLE
& $env:FORECAST_TRAINING_PYTHON -m ml.replay.runner advance --run-id mi-replay
& $env:FORECAST_TRAINING_PYTHON -m ml.replay.runner report --run-id mi-replay
& $env:FORECAST_TRAINING_PYTHON -m ml.replay.runner run --run-id mi-replay
& $env:FORECAST_TRAINING_PYTHON -m ml.replay.runner reset --run-id mi-replay
```

`run` prepara una corrida nueva o continúa sus checkpoints hasta el nivel 7.
`advance` ejecuta únicamente el siguiente nivel. Una corrida ya completa no se
vuelve a entrenar. Para otra seed/perfil se requiere otro identificador.
`SHIFT` es el segundo perfil disponible; no se buscan seeds automáticamente.

Los archivos quedan exclusivamente en `ml/.test-tmp/replay-runs/<run-id>/`:

- `baseline/`: modelos, contexto de comparación y manifest inmutables.
- `evidence/`: checkpoints acumulativos de operaciones y días completos.
- `candidates/`: candidatos por nivel y selecciones v2 únicamente si aprueban.
- `manifest.json`, `report.json`, `formal-evaluation.json`: resultados verificables.

## Semántica experimental

El baseline usa el prefijo canónico hasta el 16/04/2026. Los niveles de 1, 7 y
14 operaciones adicionales son altas históricas sobre ese mismo día cerrado.
Esto permite aislar el efecto de una operación, sin mezclarlo con un cambio de
fecha. Una operación contiene una venta de un SKU y cantidad entera. El primer
nivel vende exactamente una unidad. Las siguientes etapas agregan 7, 14 y 30
días adicionales, y finalmente los días restantes hasta el 15/08/2026. Cada día
generado tiene cobertura completa explícita; un día ausente no se imputa como 0.
Los movimientos de reposición sintéticos se derivan para mantener stock no
negativo y se contabilizan por separado de las operaciones de venta.

La misma vista en memoria se amplía entre niveles; al reanudar un proceso se
reconstruye únicamente su checkpoint durable. El dataset canónico nunca cambia.
El generador usa solo estadísticas del prefijo baseline y PRNG por clave/seed.

La tabla muestra **promedios por SKU sobre un contexto fijo del 16/04**, iguales
para todos los modelos y etapas. Es sensibilidad atribuible al modelo; no es un
backtest de rendimiento. El JSON conserva también los resultados por SKU, deltas
porcentuales, norma de diferencias de coeficientes y hashes de features/targets.
Las métricas intermedias MAE/WAPE/bias son **in-sample**, sobre el entrenamiento
de cada candidato; no deben interpretarse como mejoras fuera de muestra.

Una operación al final del prefijo puede cambiar las features de inferencia y
las etiquetas maduras sin cambiar las features de entrenamiento: los últimos
origins de entrenamiento están separados por el horizonte. “Sin cambio medible”
es un resultado válido (tolerancia de comparación de predicción: 1e-10).

Solo el nivel 7 ejecuta la decisión formal: folds de 31/30/46 origins históricos
17/04–17/05, 18/05–16/06 y 17/06–01/08. Cada fit cumple
`trainOrigin + horizon < firstEvaluationOrigin`. Las últimas etiquetas de 14d
cierran el 15/08. No se consumen etiquetas del TEST canónico posterior.
Se invoca `evaluate_temporal`, que usa `fold_from_samples` y `evaluate_policy`
con el archivo/hash numérico productivo intacto. El comparador de calidad es MA28,
no replay-v1. Los 107 origins solapados no son 107 muestras independientes.

`PASS` selecciona replay-v2 por horizonte. `REJECTED` conserva replay-v1. Una
decisión puede diferir entre 7d y 14d. No se promete una promoción o impacto.

## Reset y límites

El reset usa un owner y lock exclusivos. Solo elimina candidates/evidence/reportes
de esa corrida, preserva el baseline y restaura su manifest. Es idempotente; no
acepta rutas arbitrarias. Si un proceso muere, un lock residual bloquea la corrida
de forma segura y requiere inspección local; no se rompe automáticamente.

Primera versión: ejecución local, sin UI, sin certificación de seeds y sin
comparación Inventory (esa adaptación histórica corresponde a otra fase).
Los datos se manejan directamente como archivos/objetos; no atraviesan el
snapshot cloud de 1,5 MiB.

Pruebas focales:

```powershell
& $env:FORECAST_TRAINING_PYTHON -m unittest ml.tests.test_m6_10a3783_replay -v
```
