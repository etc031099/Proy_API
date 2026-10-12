# Auditoría de UTF-8 y mojibake (P2C.2)

## Hallazgos y causa

La búsqueda inicial en archivos fuente, datos, fixtures, seeds, JSON, scripts y documentación excluyendo dependencias/build encontró cinco coincidencias de búsqueda que corresponden a seis etiquetas dañadas, todas en `frontend/src/i18n/dict.ts`: `dashboard.periodMode`, `dashboard.currentPeriod`, `dashboard.latestPeriod`, `dashboard.periodShown`, `reports.periodBreakdown` y `reports.period`. La causa visible era texto ya mojibakeado en el código fuente del diccionario español, no una conversión en runtime ni una respuesta de API mal interpretada. Se corrigió en el origen.

No se encontraron coincidencias de los patrones buscados en los demás archivos de aplicación, seeds, manifests JSON, fixtures o datasets de texto versionados. La búsqueda no analiza contenido binario como si fuera texto.

## Transporte, archivos e importadores

- El layout App Router de Next genera el documento HTML y su charset UTF-8; no se añadió un meta duplicado.
- Express `res.json` serializa Unicode y anuncia `application/json; charset=utf-8`; el test de transporte verifica ambos.
- El importador histórico consume NDJSON con `readline` sobre un `fs.ReadStream`; ahora declara `encoding: 'utf8'` explícitamente. Su hash SHA-256 permanece sobre bytes, como debe ser.
- La exportación CSV ya usa BOM y `text/csv;charset=utf-8`; se conserva. El documento de impresión ahora declara UTF-8 y el test confirma los acentos en sus nodos de texto.
- No se halló conversión manual Latin-1/UTF-8 ni doble decode en frontend/backend. No se usan hacks `decodeURIComponent(escape(...))`.

## MongoDB

No se ejecutó una migración ni se cambió ningún dato. La auditoría read-only sí se ejecutó sobre el Mongo configurado en `backend/.env`: recorrió 18 colecciones y 26,177 documentos; las 18 quedaron completas, sin alcanzar el límite. No encontró campos sospechosos. La salida solo incluyó nombres de colección/campo y conteos; omitió todos los valores. Con esta auditoría no hay evidencia de texto mojibakeado persistido ni se necesita migración.

Se añadió `backend/scripts/audit-text-encoding.js`, una auditoría explícitamente opt-in y de solo lectura. Requiere `MONGODB_URI` en el entorno y `--confirm-read-only`; usa lectura secundaria preferente, recorre hasta 100,000 documentos por colección por defecto (ajustable hasta 1,000,000), excluye colecciones `system.*` y omite campos sensibles por nombre. Solo imprime colección, ruta de campo, marcador sospechoso, número de documentos y un ejemplo redactado; nunca imprime URI ni valores de negocio. `complete: false` indica que el límite truncó esa colección. Uso desde PowerShell, sin imprimir el secreto:

```powershell
cd backend
node scripts/audit-text-encoding.js --confirm-read-only
```

Para elevar el límite de lectura, por ejemplo:

```powershell
node scripts/audit-text-encoding.js --confirm-read-only --max-documents=250000
```

El análisis es heurístico: encontrar una secuencia sospechosa requiere revisar el campo y el origen antes de cualquier reparación. El script no modifica Mongo. Si reporta campos afectados, se debe preparar después una migración tenant-safe, reversible y con respaldo; no ejecutar una migración automáticamente.

## Prevención y smoke

- Guardar fuentes, JSON, seeds y NDJSON en UTF-8; los lectores de archivos de texto declaran el encoding explícitamente.
- Mantener la búsqueda estática de patrones y los tests Unicode/round-trip para evitar que el mojibake vuelva al diccionario.
- Revisar en idioma español las etiquetas de período en Dashboard y Reportes; revisar CSV y PDF con `información`, `período`, `ítem`, `año`, `José`, `¿` y `¡`.
- Verificar la respuesta JSON UTF-8 en las pruebas backend.
- Ejecutar manualmente la auditoría Mongo read-only con `--confirm-read-only` antes de decidir si hace falta migración.

## Validación

- Búsqueda inicial: cinco etiquetas dañadas en el diccionario español; no hubo hallazgos en el resto de archivos de aplicación/datos.
- Búsqueda final de patrones en código y datos de texto: cero coincidencias; las menciones documentales de patrones se conservan solo como ejemplos de auditoría.
- Backend completo: 952/952; incluye prueba de JSON Unicode y `application/json; charset=utf-8`.
- Frontend Vitest: 94/94; helpers: 12/12.
- TypeScript, build de producción, sintaxis de scripts Node, lint focal y `git diff --check`: correctos.
- Se conserva una advertencia existente de Browserslist por datos caniuse-lite antiguos; no afecta el build.

## Smoke manual

1. Cambiar idioma a español y comprobar Dashboard: “Período del panel”, “Último período con datos” y Reportes: “Desglose agregado por período”.
2. Generar CSV y PDF con nombres/productos que incluyan `información`, `período`, `ítem`, `año`, `José`, `¿` y `¡`; comprobar que los acentos y signos se conservan.
3. En la consola local, ejecutar `node scripts/audit-text-encoding.js --confirm-read-only` desde `backend` para repetir la auditoría agregada. Confirmar `readOnly: true`, todas las colecciones con `complete: true`, y que los valores permanecen redactados.
