# Certificado histórico STABLE/2020

`cert-stable-2020.json` conserva el resumen existente. El detalle fijo
`cert-stable-2020-detail.json` contiene 107 fechas únicas **por horizonte**,
sus métricas agregadas y el veto focal de 14d. No contiene ventas, datos de
clientes, rutas locales, coeficientes ni todos los samples por SKU.

## Auditoría y procedencia

Se conservaron localmente manifest, report, formal-evaluation y la evidencia
acumulada del nivel 7 de `cert-stable-2020`. Ninguno conservaba samples por
fecha: `evaluate_temporal` crea `sku`, `origin`, `category`, `segment`, `actual`,
`prediction`, `baseline` y `observedUnits`; `fold_from_samples` conserva métricas
por fold/grupo/SKU y soporte, pero pierde las predicciones individuales y su
asociación con cada fecha. Los límites temporales sí estaban preservados.

El exportador de desarrollo `ml.replay.export_certificate_detail` reconstruye
el dataset desde la evidencia guardada, verifica su hash y el de la fuente,
y repite únicamente los seis fits temporales de la evaluación (3 por horizonte).
Intercepta la frontera de agregación sin modificar las funciones productivas.
No vuelve a generar ventas, etapas intermedias, modelos LIVE ni artefactos ML.
No modifica la corrida original. Compara todos los campos con formal-evaluation,
el manifest y el resumen: cadenas/checks exactos; números con tolerancia absoluta
y relativa de 1e-10. Ante discrepancia no publica el detalle.

Comando de generación, desde la raíz y con dependencias ML ya disponibles:

```powershell
& .\.venv\Scripts\python.exe -m ml.replay.export_certificate_detail
```

Esta operación es de desarrollo, no se importa ni ejecuta desde HTTP. La
certificación de esta fase ejecutó una sola evaluación offline. Cambiar el
artefacto exige revisar/actualizar explícitamente su hash fijado en el lector.

## Folds: posición y clave son conceptos distintos

| Posición | Clave real | Orígenes | Inicio | Fin |
|---|---|---:|---|---|
| 1 | F2 | 31 | 2026-04-17 | 2026-05-17 |
| 2 | F3 | 30 | 2026-05-18 | 2026-06-16 |
| 3 | VALIDATION | 46 | 2026-06-17 | 2026-08-01 |

La política congelada utiliza estas claves, **no F1/F2/F3**. El reason
`P_FOLD_CATA_MAE:F3:BEB-GAS-003` corresponde al segundo bloque. La UI presenta
posición y clave por separado y no renombra la evidencia para ajustarla a una
numeración hipotética. En ambos horizontes se utilizan las mismas 107 fechas.

## Métricas y límites semánticos

Cada fecha contiene 80 pares SKU/origen. `actualUnits`, `candidateUnits` y
`baselineUnits` son sumas de etiquetas/predicciones para ese origen/horizonte.
MAE es la media de errores absolutos **por par**, no el error absoluto entre
las sumas. WAPE es suma de errores absolutos / suma de etiquetas reales; el
sesgo normalizado usa errores con signo / ese volumen. WAPE y sesgo normalizado
son null cuando el volumen es cero. Se reutiliza `metric_bundle`.

Los horizontes se solapan: ni los 107 orígenes son independientes ni sumar sus
etiquetas representa ventas únicas. No se publica un PASS/REJECTED por origen,
pues la política evalúa el horizonte completo. No se publica una curva diaria,
una predicción 1d ni detalle inventado por SKU.

La referencia formal es **MA28**, no replay-v1 ni el modelo LIVE v1. El candidato
de cada fold se ajusta con etiquetas anteriores a su primer origen. 7d supera
todas las comprobaciones y queda seleccionado únicamente dentro del replay;
14d conserva el veto aunque mejora WAPE global.

Veto 14d, clave F3, SKU BEB-GAS-003:

- Soporte: 30 orígenes, 221 unidades observadas únicas; suficiente.
- MAE candidato: 6.328063633773374; MAE MA28: 2.3666666666666667.
- Ratio: 2.673829704411285; condición requerida: ratio <= 1.50; resultado false.
- El máximo 1.50 procede de `priority.supportedFoldMaeRatioCatastrophicMax`
  del archivo numérico congelado, no de un valor decidido en frontend.

## Integridad y volumen

- Artefacto canónico UTF-8: **101504 bytes**, sin timestamps variables.
- SHA256 de sus bytes:
  `5f8fa93cdf2ce067dafa4c4dd648e4a9400d598b22e17e68e259fb8c38b62a9a`.
- Política numérica SHA256:
  `522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3`.
- El JSON registra hashes reales de dataset fuente, dataset reconstruido,
  evaluación formal y archivo resumen utilizado durante la exportación.
- `.gitattributes` preserva los bytes del detalle para verificar el mismo hash
  en Windows y Linux. La firma fijada en el lector detecta modificaciones;
  no es una firma criptográfica emitida por un tercero.

## API autenticada, fija y read-only

Prefijo `/api/intelligence/forecast/replay/certified-stable-2020`:

- GET raíz: resumen original, sin selección.
- GET `/origins?horizonDays=7&page=1`: 10 filas, folds y metadata.
- GET `/origins?horizonDays=14&fold=F3&page=1`: filtro cerrado y veto focal.
- GET `/origins/2026-05-18?horizonDays=14`: detalle agregado de una fecha.

Solo se permiten horizontes 7/14, claves reales de fold, páginas válidas y fechas
que pertenezcan al certificado. Los parámetros desconocidos se rechazan. No se
aceptan paths/runIds/seeds, ni se accede a Mongo/Python/worker/servicio ML. Las
rutas reutilizan auth/access/rate limit y `Cache-Control: no-store` existentes.
El archivo se verifica una vez y se conserva en memoria; cada respuesta está
desvinculada del caché. La UI consulta el índice al expandir y el detalle bajo
demanda. No recibe las 214 filas ni los 17120 samples juntos.

## Validación focal

```powershell
node --test backend/test/forecastReplayCertificate.test.js backend/test/forecastReplayDetail.test.js
& .\.venv\Scripts\python.exe -m unittest ml.tests.test_replay_certificate_detail -v
```

Frontend: Vitest con `frontend/vitest.config.ts`, archivos
`forecastReplayOrigins.test.tsx`, `businessIntelligenceDashboard.test.tsx` y
`forecastDiagnostics.api.test.ts`; TypeScript y ESLint focal. Sin build.
