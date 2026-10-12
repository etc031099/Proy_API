# CONV-HARDENING-P3C.2 — Ventas, producto y período

Validación local del árbol derivado de `1fab42816963ed29e2bebaa062e6d3d5a30ffd85`.
El `evaluatedCommit` del reporte identifica el commit base antes de registrar los
cambios de esta fase; no identifica un deployment cloud.

## P1 originales cerrados

| IDs P3B | Causa y corrección |
| --- | --- |
| U-0158, U-0159, U-0164, U-0177 | Mes/semana quedaban como referencia de producto. Las expresiones temporales completas se extraen antes de resolver la entidad; las consultas generales usan get_sales_summary. |
| U-0194 | «Qué ventas tuvo food 96» no reconocía producto. La extracción reconoce «tuvo», conserva el período y usa get_product_sales_summary. |
| U-0229, U-0234 | «Top productos vendidos/por ventas» caía a búsqueda de producto. Usa ranking existente, con límite explícito y todo el historial cuando no hay período. |
| U-0509 | «Menores ventas» no entraba en la comparación de causalidad. Usa la comparación existente y mantiene sus límites de evidencia. |
| U-0523 | «Vende» consumía el prefijo de «vender». El verbo se consume completo antes de separar cantidad y producto. |

«Con proveedor» y «con el proveedor» separan correctamente productRef y
supplierRef. El límite del verbo también preserva «compré» con tilde.
Resolver o preparar una acción sigue sin confirmarla.

## Comportamiento

- Producto + ayer/hoy/anteayer/semana/rango/mes llegan juntos al executor de
  ventas completadas, con businessId autenticado y filtro de productId.
- Food 96 mantiene la identidad del item 096. Food 210 ofrece las dos opciones;
  selección por SKU/ordinal conserva ayer y retoma ventas del seleccionado.
- «¿Y anteayer?», «¿Y hoy?», «¿Y esta semana?» y «¿Y en los últimos 7 días?»
  conservan el producto cuando el contexto anterior es ventas por producto.
- «¿Y food 210 ayer?» introduce la nueva entidad explícita.
- «¿Cuánto vendí ayer?» consulta ventas generales, aunque haya un producto previo.
- Meses y días escritos usan el calendario UTC existente. Cuando se indica
  día/mes o solo mes sin año, se usa el año operativo. Rangos completos naturales
  conservan ambos extremos; fechas inválidas, rangos incompletos y períodos
  contradictorios siguen pidiendo aclaración antes de consultar.
- Se actualizó la prueba antigua que rechazaba dos fechas naturales completas:
  ahora se comprueban los límites reales del filtro en una prueba de rango válido.
- Negativos, decimales y cero siguen rechazados en WRITE antes de preview.
- Estas rutas se verificaron con 0 LLM / 0 tokens.

## Validación

- 34 pruebas nuevas; una expectativa antigua de rango reemplazada, incremento
  neto de 33 pruebas sobre baseline 1078.
- Focalizadas de ventas, temporales, resolver/skills, acciones guiadas,
  orchestrator y regresión forecast: 590/590.
- Backend completo: 1111/1111.
- Subset P3B de esta fase: 9/9 PASS.
- P3B completo: 827 casos; PASS 646, FAIL 127, PARTIAL 12,
  NOT_SUPPORTED 28, NEEDS_MANUAL 14.
- Severidades restantes: P0=0, P1=6, P2=120, P3=1.
- Cero nuevos P0/P1, incluyendo regresión de los 12 P1 cerrados en P3C.1.
- Reporte completo independiente: CONV-HARDENING-P3C.2.json.
  El baseline P3B y las reglas del evaluador permanecen intactos; el flag
  `--sales-p3c2` solamente selecciona el subset y genera el reporte comparativo.
- Sintaxis y diff normal/staged verificados.

Frontend y persistencia sin cambios; no se requieren suites frontend/Mongo.
Sin llamadas reales a Gemini, escrituras cloud, cambios ML, Telegram o RAG.
Commit local solicitado; sin push.
