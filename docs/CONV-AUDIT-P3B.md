# CONV-AUDIT-P3B — auditoría conversacional pre-demo

## 1. Resumen ejecutivo

Estado: **A. AUDITORÍA COMPLETADA** sobre `98178e349e3d289e3f017d4b27f01e05b0e50f58`.

Se evaluaron **50 familias, 700 consultas individuales y 120 secuencias**. Las secuencias tienen 297 pasos, incluidos dos avances de reloj para expiración. Se añadieron siete probes estructurales de seguridad: **827 casos evaluados** en total.

| Clasificación | Casos |
| --- | ---: |
| PASS | 614 |
| FAIL | 159 |
| PARTIAL | 12 |
| NOT_SUPPORTED | 28 |
| NEEDS_MANUAL | 14 |

| Severidad de los casos FAIL | Casos |
| --- | ---: |
| P0 | 0 |
| P1 | 27 |
| P2 | 131 |
| P3 | 1 |

Estos son **casos fallidos, no 159 defectos independientes ni 159 regresiones demostradas**. Varias formulaciones comparten una causa. La mayoría de P2 corresponde a una frase clara que no encuentra la ruta determinística y llega al provider fake. El error temporal del provider mostrado en esos casos pertenece al entorno controlado: no demuestra un error de Gemini en cloud.

No se observaron ejecuciones indebidas, cambio silencioso de cantidades ni exposición de otro tenant en la cobertura ejecutada. Esto no sustituye una auditoría de seguridad completa ni la verificación de transacciones Mongo reales.

Las suites productivas se mantienen en **backend 1052/1052** y **frontend 98/98**. No se modificó código funcional para mejorar el resultado.

## 2. Capacidades actuales

El inventario se obtuvo de los registros actuales, no de la auditoría anterior. `CONV-AUDIT-P3B.json` contiene la lista completa con estado, permisos por agente y timeouts.

**19 READ READY**:

- Catálogo: `search_products`, `get_product_details`, `get_low_stock_products`.
- Transacciones/ventas: `get_recent_transactions`, `get_sales_summary`, `get_product_sales_summary`, `get_top_selling_products`, `get_business_summary`.
- ML/comercial: `get_demand_forecast`, `analyze_demand_forecast`, `get_replenishment_candidates`, `get_replenishment_cost`, `plan_replenishment_budget`, `compare_supplier_costs`.
- Proveedores: `get_supplier_products`.
- Alertas: `list_stock_alert_rules`, `list_inventory_alerts`, `list_inventory_alert_outbox_events`, `list_inventory_alert_channel_deliveries`.

**Cuatro acciones humanas READY**: `create_product`, `create_sale`, `create_purchase`, `create_stock_alert_rule`. Todas requieren confirmación. **Una acción interna READY**: `create_inventory_alert`, automática y separada de la regla conversacional.

**READ NOT READY**: `get_inventory_summary`, `get_purchase_summary`, `get_supplier_details`. Las compras READ disponibles son transacciones filtradas; no se confunden con una skill de resumen de compras implementada.

**Diez acciones NOT READY**: actualizar producto, crear cliente/proveedor, cancelar transacción, registrar pago de crédito, ajustar inventario, crear/aprobar/rechazar propuesta de compra y `send_notification`. La distribución de alertas existente no depende de que esa última action skill sea READY.

El resolver de producto usa identidad numérica, padding y componentes explícitos. Proveedores tienen aliases numéricos, candidatos y continuaciones. Cliente existente en venta a crédito usa `customerRef` y filtro de contacto `type=customer`; se comprobó un preview con cliente sintético. Su manejo se clasifica **PARTIAL** como capacidad global: no existe el mismo catálogo READ/CRUD conversacional ni la misma cobertura de paginación que para proveedores.

Memoria: tenant + usuario + conversación, TTL de 30 minutos. PendingAction: 10 minutos. OperationDraft: 20 minutos. READ y WRITE conservan contextos separados. Los límites de petición siguen siendo tres generaciones, cuatro skills y dos ciclos de selección. Seis skills dependientes de ML tienen 25 s; el timeout estándar sigue siendo 5 s y el HTTP ML 20 s.

## 3. Metodología y reproducción

Ejecutar desde la raíz:

```powershell
node backend/scripts/audit-conversation-p3b.js
```

El script genera `docs/CONV-AUDIT-P3B.json`. Un exit code 0 significa que el evaluador completó la auditoría, **no que todas las consultas pasaron**. Para usar los hallazgos como gate explícito:

```powershell
node backend/scripts/audit-conversation-p3b.js --strict
```

Con este estado, `--strict` devuelve 1 porque hay FAIL. La suite está separada de `backend/test/run.js` y no modifica sus tiempos ni expectativas.

Las entradas están en `backend/test/audit/p3bCases.js`. `p3bFixtures.js` carga los fixtures revisados de los tests existentes sin registrar ni ejecutar sus callbacks, mediante un wrapper aislado. Así reutiliza el orchestrator y ejecutores READ reales con driver sintético; el gateway de acciones utiliza servicio en memoria. El fixture ML respeta el filtro `productId` del servicio real. Ninguna conexión Mongoose, petición HTTP, Telegram o dispatcher se ejecuta.

La fecha operativa está congelada en **2026-10-09 UTC**. Se usan seis productos A, un producto B y 25 proveedores sintéticos. El forecast de referencia es sintético, anclado en **2026-05-17**: no es inferencia cloud ni reentrenamiento.

Los oráculos verifican intención, atributo, identidad, campos/fechas, filtros del executor, skill en Activity, evidencia, correlación de eventos, cantidades, previews, confirmación y contexto. Los fallos capturan la respuesta observada y no se ocultan corrigiendo producción.

Se revisaron los falsos positivos del evaluador: límites de palabra para «ayer»/«cayeron», «1 unidades»/«11 unidades», rechazo correcto por stock insuficiente y búsqueda explícita como operación válida de búsqueda. Las capacidades ausentes se excluyen de FAIL.

## 4. Cobertura por área

| Área | Casos | PASS | FAIL | PARTIAL | NOT_SUPPORTED | NEEDS_MANUAL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Producto y atributos | 84 | 40 | 44 | 0 | 0 | 0 |
| Resolver producto/proveedor | 42 | 41 | 1 | 0 | 0 | 0 |
| Seguridad, negativos y probes | 35 | 30 | 5 | 0 | 0 | 0 |
| Inventario | 28 | 22 | 6 | 0 | 0 | 0 |
| Ventas | 70 | 57 | 13 | 0 | 0 | 0 |
| Compras/transacciones READ | 28 | 20 | 8 | 0 | 0 | 0 |
| Forecast | 70 | 52 | 18 | 0 | 0 | 0 |
| Costos/presupuestos | 28 | 20 | 8 | 0 | 0 | 0 |
| Proveedores | 42 | 32 | 10 | 0 | 0 | 0 |
| Capacidades ausentes | 28 | 0 | 0 | 0 | 28 | 0 |
| Reglas/eventos/outbox/Telegram READ | 56 | 37 | 19 | 0 | 0 | 0 |
| Limitaciones de claims | 42 | 36 | 6 | 0 | 0 | 0 |
| WRITE hasta preview | 70 | 62 | 8 | 0 | 0 | 0 |
| Vocabulario de control | 42 | 42 | 0 | 0 | 0 | 0 |
| Multi-intent | 14 | 2 | 0 | 12 | 0 | 0 |
| Fechas incompletas | 14 | 11 | 3 | 0 | 0 | 0 |
| Síntesis libre | 14 | 0 | 0 | 0 | 0 | 14 |
| Secuencias | 120 | 110 | 10 | 0 | 0 | 0 |

Las 120 secuencias cubren atributos, selección de producto, ventas, listas, paginación supplier, oferta producto+proveedor, READ/WRITE, preguntas de preview, negaciones, correcciones, aislamiento, prioridad explícita, aprobación repetida, cancelación tras éxito, expiración y un cliente existente a crédito. No se inflaron las consultas con copias de mayúsculas o puntuación; las variantes cambian formulación, referencia, selector, fecha o contexto.

## 5. Top 10 hallazgos y orden recomendado

| Orden | Hallazgo | Severidad / ejemplo reproducible |
| ---: | --- | --- |
| 1 | Guarda ML incompleta para futuro | P1, U-0262: «predicción del próximo mes de food 96» ejecuta forecast histórico batch. No lo presenta literalmente como vigente, pero no responde la limitación temporal solicitada. |
| 2 | Mínimo de producto interpretado como listado global | P1, U-0034/U-0037: «cuánto es el stock mínimo de food 2 96» y «food 96 stock mínimo» ejecutan `get_low_stock_products`; aparecen productos distintos al pedido. |
| 3 | Período interpretado como nombre de producto | P1, U-0158/U-0159/U-0164: «ventas del mes anterior», «dame las ventas de octubre de 2026», «importe de ventas del mes pasado» crean `lookupQuery` temporal en `product_sales_summary`. |
| 4 | Ventas pierden filtro de producto | P1, U-0194: «qué ventas tuvo food 96 el mes pasado» usa ventas generales, no ventas del producto. |
| 5 | Forecast informal pierde producto | P1, U-0242/U-0243/U-0250/U-0252: se devuelve batch en vez de food 096. El SKU explícito sí se filtra correctamente en el fixture ajustado. |
| 6 | Entrega/reintento confundido con evento | P1, U-0439/U-0440: «alertas pendientes de reintento» y «outbox de alertas» van a eventos, no entregas. La frase canónica de estado de entrega pasa. |
| 7 | Selección por nombre humano completo | P2, S-047/S-107: el nombre de la tarjeta no retoma la selección; ordinal y SKU pasan. `memory.compactEntity` conserva `label`, mientras la comparación de nombre en `productCandidateSelection` busca `name`. |
| 8 | Extracción de WRITE incompleta | U-0523, P1: «vender 3 unidades de food 096» deja `ref="r 3 unidades de food 096"`. U-0547/S-023, P2: «con proveedor» deja `ref="food 96 con"`; «con el proveedor» pasa. No hubo ejecución ni cantidad cambiada. |
| 9 | Formulaciones determinísticas y follow-up corto | P2: variantes de precio/estado/detalles necesitan fallback; S-033/S-093 pierden ventas con «¿Y en los últimos 7 días?». Son gaps de entrada, no prueba de fallo del Gemini real. |
| 10 | Pregunta de preview con «quedaré» | P2, S-084: «¿cuánto quedaré de stock?» sale del preview hacia READ; «¿cuánto quedará de stock?» sí responde desde el preview. El mock READ no mide consumo real, por lo que no se afirma que esta variante consuma Gemini en cloud. |

Las causas 7 y 8 se corroboraron en código: `backend/src/agents/memory.js`, `orchestrator.js` y `backend/src/automations/actionInput.js:74–76`. La alternativa corta `vende` precede a `vender` en la extracción de contenido; el separador contempla «con el», no «con» solo. Esta fase únicamente documenta esas causas.

Las guardas futuras están en `forecastRouting.js`; los patrones cubren hoy/mañana/próxima semana, pero no todas las formas de próximo mes/vigente. La extracción genérica de ventas/producto y el orden de detección de low stock deben revisarse antes de añadir aliases indiscriminadamente.

## 6. P0

Cero casos P0 fallidos. Cantidades negativas, cero, decimales y tokens numéricos inválidos no produjeron previews ejecutables. Preguntas/negaciones no confirmaron. Repetir aprobación en mocks dejó exactamente una ejecución y cancelar tras éxito no la revirtió.

Los probes G-1–G-4 confirmaron rechazo de un PendingAction de otro tenant, usuario, canal o conversación por el repositorio real sobre storage simulado, con cero escrituras de negocio mock. G-5 rechazó `businessId` adicional antes de reads. G-6/G-7 no devolvieron el producto de B ni modificaron el tenant de las consultas ante SKU/ObjectId externo.

La suite no ejecuta transacciones Mongo ni ataques contra tenants cloud. Las garantías de índices/concurrencia durable siguen dependiendo de sus pruebas de integración existentes.

## 7. P1

27 casos: producto/atributo o tipo de datos incorrectos, pérdida de filtro de ventas/forecast, confusión de período y eventos vs entregas. Los datos observados son sintéticos: el fallo demostrable es el selector/skill/conjunto elegido, no una cifra financiera de Atlas.

La prioridad es corregir selectores y guardas antes de ampliar lenguaje: un listado o total de otro conjunto puede parecer una respuesta válida aunque esté fuera de lo pedido.

## 8. P2

131 casos: tolerancia de entrada, fallback innecesario para expresiones claras, selección por nombre, continuidad de compra, fechas incompletas y preguntas de preview. Incluyen cinco formulaciones cross-tenant que no obtienen la denegación determinística esperada. En ellas no se accedió a otro negocio: hubo fallback fake o búsqueda dentro de A. Debe mejorarse la denegación explícita sin confundirla con una vulnerabilidad de datos ya probada.

## 9. P3

Un caso P3: **U-0251**, «¿Cuál es la predicción de M5-FOODS_2_210?», muestra **«1 unidad disponibles»** en el forecast. El stock de producto normal dice «1 unidad disponible» correctamente. Es una concordancia residual del builder de forecast, no un error de ML.

No se observaron mojibake ni IDs técnicos en los textos determinísticos ejercitados. El renderer frontend real se cubrió mediante sus 98 tests actuales; no se hicieron capturas visuales de cloud.

## 10. Regresiones respecto al hardening previo

- Las 1052 pruebas backend y 98 frontend pasan, incluida la cobertura P0/P1/P2/P3A existente.
- Identidad 96/096/0096, exclusión de 196/960/211/1210 y subgrupos explícitos se mantienen en los casos estructurados del resolver.
- Supplier aliases 1/01/001 y paginación de 25 candidatos pasan; selección ligada a la página visible y costo producto+proveedor también.
- El genérico «productos más vendidos» conserva all-history, sin heredar current_month.
- Las frases canónicas de reglas, eventos, entregas y Telegram siguen separadas.
- Confirmación inmediata, aclaración tras preguntas, cancelación, expiración y aislamiento probado se conservan.
- Se encontraron **gaps residuales en nuevas formulaciones**. No se comparó todo el corpus con commits antiguos y, por tanto, no se atribuye su introducción a P3A ni a otra fase.

## 11. Producto y atributos

Los SKU y las referencias estructuradas usuales funcionan. Stock/precio/mínimo/activo tienen respuestas específicas para los patrones soportados. Hay formulaciones naturales sin ruta económica: «dime el stock de food 096», «a cuánto está food 96», «está activo food 96» y detalles completos. `Alimentos 096` queda sin candidato bajo el matching conservador; no elige un número distinto.

El nombre humano completo con separadores y tildes también deja gaps de búsqueda/continuación. Debe reutilizarse una identidad normalizada coherente, conservando números, subgrupo y la prioridad de entidad explícita.

## 12. Proveedor

Aliases numéricos pasan 14/14. Hay gaps en frases de productos/ofertas y detalles se mantiene intencionalmente NOT READY. No se inventaron RUC/teléfono/dirección. READ con oferta ambigua conserva producto, intención y paginación. WRITE con «con proveedor» pierde el separador; se observó la diferencia con «con el proveedor» sin escribir datos.

## 13. Temporales

Se verifican UTC, ayer/hoy/anteayer, rangos y límites inclusivos que llegan al executor. Once de catorce fechas incompletas piden aclaración; otras tres alcanzan fallback fake en lugar de una aclaración determinística. La comparación no confunde «últimos 7 días» con semana natural en los casos soportados.

No se aplicó el anchor ML a ventas. Los problemas se concentran en extracción período vs entidad y follow-ups sin palabra «ventas».

## 14. Ventas y compras

Ventas con producto y período exactos funcionan; U-0194 demuestra una variante que pierde producto. «Ventas del mes anterior» no debe buscar un producto con ese nombre. READ de compras/transacciones conserva type y período en los patrones soportados, y los filtros de fechas se inspeccionan en el pipeline, no solo en la respuesta.

Las ventas WRITE seguras llegan a preview. Stock insuficiente informa cantidad pedida y alternativa, sin reducción silenciosa. Se detectaron infinitivos/separadores de compra que impiden preparar, no operaciones incorrectamente ejecutadas.

## 15. Alerts, Telegram y distribución

Se auditan cuatro conceptos por separado: reglas, eventos, outbox y entregas Telegram. Los registros sintéticos de alertas están vacíos; se verifican skill, query, status y procedencia, no una entrega externa. Hay gaps de vocabulario: reglas activas, reintento, outbox abreviado y Telegram SKIPPED sin el sustantivo previsto.

No se enviaron eventos, no se invocó dispatcher ni se alteraron preferencias/conexión.

## 16. Confirmación, cancelación y correcciones

Los 42 casos de vocabulario/control pasan. Ocho secuencias de aprobación verifican una ejecución mock, repetición idempotente y cancelación sin reversión. Ocho prueban ausencia de preview, desambiguación, cancelación o expiración. Las correcciones conservan cantidad válida y no convierten selección en confirmación.

La pregunta «quedaré» requiere ampliación localizada del texto reconocido; no debe añadirse una aprobación implícita para resolverla.

## 17. Contexto y continuaciones

Se comprobaron aislamiento por conversación, usuario y tenant, prioridad de SKU/nuevo producto y selección visible. Los ocho list follow-ups, ocho páginas supplier y ocho continuaciones de oferta pasan. Fallan nombres humanos completos, la variante de compra mencionada y el follow-up de ventas de últimos siete días.

La restauración visual F5, reconexión y permanencia de cards se mantienen cubiertas por la suite frontend existente; esta auditoría no simula un navegador cloud ni una sesión real.

## 18. ML/forecast

No se calcula demanda ni recommendedQty en el evaluator: el servicio fake devuelve valores fijos y filtra por productId. El código real consulta y compone esos DTO. SKU explícito y varias guardas de mañana/hoy/ayer pasan. «Próximo mes» ejecuta el replay; «vigente» se interpreta como parte de la entidad. Formulaciones de demanda prevista sin SKU pueden perder el filtro y devolver batch.

Los 14 casos de síntesis interpretativa/libre se marcan NEEDS_MANUAL: no se evalúan naturalidad, causalidad o groundedness del proveedor real con un mock ni se hacen llamadas pagadas.

## 19. Seguridad y clientes

`businessId` sigue server-side y las queries del driver fake conservan A. Los requests cross-tenant canónicos se deniegan sin LLM/skills. Las variantes que el guard no reconoce no mostraron datos de B. Un ID interno no cambió el tenant.

Cliente existente a crédito pasa el probe de preview sintético, pero el mock no prueba toda la autorización del contacto en Atlas. CRUD/READ de clientes ausente se clasifica NOT_SUPPORTED, no FAIL. No se implementó un nuevo customer resolver.

## 20. Multi-intent y LLM

Dos de catorce consultas multi-intent pasan como combinaciones de lista ya previstas. Doce son PARTIAL: no existe planner general y una skill puede responder solo una parte. No se registran como defectos de una feature nunca implementada, aunque conviene comunicar la cobertura parcial al usuario.

Para rutas determinísticas se verifica cero LLM/tokens reportados y ausencia de intentos del provider fake. Algunas frases libres sí están diseñadas para síntesis; no se penaliza su uso intencional. Tokens reales de Gemini no están disponibles en esta auditoría.

## 21. Calidad y observabilidad

Se contrastan intención, skills de Activity, evidencia, cantidades y filtros. Se captura lifecycle request_started→request_finished, correlation por request/conversación, y agentRunId/skillCallId en eventos de skill. No se guarda pensamiento privado ni prompts del proveedor en el informe.

La divergencia más importante no es estética: un atributo de un producto puede producir una lista global, o una consulta de entrega una consulta de eventos. Importes PEN mantienen S/ y dos decimales en los casos ejercitados; las monedas distintas no se suman.

## 22. Validación y archivos

- Auditoría completa: 827 casos; evaluador terminó sin errores de fixture pendientes. Los 159 FAIL se conservaron como hallazgos.
- Backend productivo: 1052/1052; frontend: 98/98. Ningún test productivo se editó ni se registró el corpus en la suite normal.
- Sintaxis de los tres nuevos JS y git diff/check revisados.
- Archivos: `backend/scripts/audit-conversation-p3b.js`, `backend/test/audit/p3bCases.js`, `backend/test/audit/p3bFixtures.js`, este informe y `docs/CONV-AUDIT-P3B.json`.

El JSON incluye id, family, area, input, turns cuando corresponde, expected, actual, classification, severity y notes. Los IDs de negocio allí son sintéticos. Conserva la respuesta observada y las consultas reales enviadas al driver fake para cada reproducción.

## 23. Priorización y límites

Primero resolver los P1 de producto/período/forecast y la separación eventos/entregas. Después extracción `vender`/«con proveedor», selección por nombre y follow-ups. Luego ampliar aliases conservadoramente y atender la concordancia P3. Mantener cantidades, negaciones, tenant, TTL e idempotencia como gates de regresión.

Antes de la demo quedan la validación real de las 14 consultas LLM y un smoke visual manual de los flujos corregidos en futuras fases. No se necesita habilitar una feature NOT READY para cerrar este informe.

Esta fase contiene solo auditoría/scripts/documentación, sin correcciones, push, writes cloud, importación, ML training, RAG, Telegram ni cambios de configuración.
