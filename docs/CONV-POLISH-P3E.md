# CONV-POLISH-P3E — ajustes conservadores antes de demo

Estado: **A. P3E CERRADO LOCALMENTE**.
Fecha: 12 de octubre de 2026. Base: `8a05a39ca5208a4c9f7498d2c6d8a59fda19e85a` (P3D).
El commit P3D se conserva; esta fase crea otro commit local, sin push.

## Alcance acordado antes de modificar

Se leyeron `CONV-TRIAGE-P3D.md/json` y los casos P3B/P3C.3.1.
P3D recomienda ocho grupos con subconjuntos S: no exige resolver todas las variantes de G01/G03/G05.
Se fijaron 38 IDs objetivo (37 consultas y S-084), más las observaciones UX-01/UX-02.
Cada ID está cubierto en `conversationalP3E.test.js`; S-084 conserva preview y cancela sin ejecutar.
El JSON nuevo del auditor conserva los 828 IDs y resultados históricos en archivos separados.

| Grupo | IDs objetivo | Casos | Prioridad | Esfuerzo | Fix previsto |
| --- | --- | ---: | --- | --- | --- |
| G01 — Atributos y consultas básicas de inventario | `U-0003`, `U-0007`, `U-0008`, `U-0018`, `U-0021`, `U-0026`, `U-0046`, `U-0058`, `U-0138` | 9 | ALTA | S (subset) | Aliases de intents existentes |
| G02 — Ventas y compras READ: aliases y filtros existentes | `U-0163`, `U-0168`, `U-0188`, `U-0201`, `U-0202`, `U-0203`, `U-0210`, `U-0213`, `U-0218`, `U-0219`, `U-0223`, `U-0236` | 12 | ALTA | S (subset) | Aliases de intents existentes |
| G03 — Consulta comercial producto/proveedor y presupuesto | `U-0314`, `U-0339`, `U-0340`, `U-0367`, `U-0327` | 5 | ALTA | S (subset) | Aliases de intents existentes |
| G05 — Aliases de reglas, eventos, outbox y Telegram READ | `U-0413`, `U-0443`, `U-0458` | 3 | MEDIA | S (subset) | Aliases de intents existentes |
| G06 — Limitaciones de confianza, causalidad y pérdida | `U-0472`, `U-0484`, `U-0485`, `U-0487`, `U-0490`, `U-0498`, `U-0499` | 7 | ALTA | S (subset) | Aliases de intents existentes |
| G07 — Concordancia del forecast y tildes en fechas futuras | `U-0251` | 1 | ALTA | XS | Concordancia/etiquetas |
| G08 — Pregunta de stock resultante durante preview | `S-084` | 1 | MEDIA | XS | Pregunta desde preview |
| G15 — Duplicación en NO_DATA | UX-01 | 2 pruebas UX | MEDIA | XS | Una respuesta final NO_DATA |

Categorías originales: G01/G02/G03/G05/G06 DEMO-BLOCKER; G07/G08/G15 DEMO-POLISH. Los primeros 38 gates pasan 38/38. Los aliases compartidos corrigen colateralmente otras variantes de esos mismos grupos, sin ampliar el objetivo a todos los P2.

## Cambios y before/after

- **G01, producto/inventario:** se admiten prefijos simples «dime/muéstrame el stock/precio», «q stock tiene», «a cuánto está», «cuánto cuesta», «dime si … está activo», «dame los detalles». «Qué está bajo de stock» usa low_stock. Antes podían usar Coordinator/provider o buscar la frase como producto; ahora usan rutas existentes. Se excluyen múltiples peticiones, proveedor/compra, reposición/recomendación, pronombres y expresiones temporales del alias de precio. Se mantienen explicit entity > contexto y números/padding del resolver compartido.
- **G02, ventas/compras READ:** «total vendido», «venta total», «unidades vendidas de…», estados de transacciones y «últimas compras» llegan a ventas generales/específicas o get_recent_transactions. Los filtros purchase/sale, estado y periodo llegan juntos al executor. «Movimientos de ventas y compras» no se reduce a un solo tipo. El año explícito de «octubre 2026» se respeta también cuando el año operativo es 2027. No se cambia el año implícito aprobado en P3C.2.
- **G03, comercial:** aliases «costo/oferta de … con proveedor …», «proveedor más económico», «quién provee food …» y «con S/ 50 qué puedo comprar» usan compare_supplier_costs/plan_replenishment_budget. Los argumentos conservan producto/proveedor. Si el matcher comercial existente no resuelve inequívocamente, se mantiene su aclaración y solicitud de SKU; no se amplía fuzzy ni se inventa una oferta. La comparación de dos referencias no se incorpora como feature nueva.
- **G05, alertas:** «lista mis reglas de stock», «estado de entrega para food …» y «por qué se omitió Telegram de food …» usan respectivamente StockAlertRule, outbox y channel delivery SKIPPED. El producto se resuelve/desambigua con el flujo existente; los eventos OPEN siguen siendo InventoryAlert.
- **G06, límites de evidencia:** «proveedores llegaron tarde», confidence/precisión/seguridad/probabilidad de acertar y pérdida/perderé/perdido producen las limitaciones existentes. El guard precede al forecast específico para no devolver predicciones como respuesta a confidence. La guarda temporal sigue teniendo prioridad. No se fabrican causas, porcentajes, intervalos ni pérdidas; una predicción puntual tampoco se convierte en confianza por producto.
- **G07:** «1 unidad disponibles» pasa a «1 unidad disponible»; 0/2 usan plural. Las etiquetas normalizadas de futuro recuperan únicamente próximo/próxima para la respuesta visible. No hay reemplazo global ni modificación del parser/anchor.
- **G08:** «¿cuánto quedaré de stock?» responde desde el preview congelado igual que «quedará». El PendingAction sigue vivo; no ejecuta ni reimprime toda la operación. Preguntas de precio/unidades ya reconocidas siguen funcionando. No se amplía vocabulario de confirmación.
- **G15:** un resultado final get_product_sales_summary NO_DATA suprime la sección auxiliar de resolución search_products cuando había un único producto. Antes mostraba «Encontré 1 producto…» + «no registra ventas…»; ahora solo muestra el resultado final. Activity/evidence conservan ambas skills. «Busca food 96» sigue mostrando su búsqueda explícita. NO_DATA no cambia a error, fallback o petición de producto.

No se cambiaron contratos públicos, frontend, persistencia, ML/modelo, alert evaluator, outbox/dispatcher, Telegram, auth, tenant, ENV ni proveedor LLM.

## Correcciones explícitas del auditor

### U-0675 — ventas del 9 de octubre

Regla aprobada: día y mes sin año usan el año operativo UTC; está documentada en P3C.2. Con reloj del auditor 2026-10-09, el periodo correcto es 2026-10-09 a 2026-10-09.

El oráculo antiguo exigía aclaración, no otro año. Se corrige solo esa expectativa, manteniendo input/ID y verificando también el filtro real del executor: >= 2026-10-09T00:00:00Z y < 2026-10-10T00:00:00Z. Metadata:

`auditor expectation correction based on approved operational-year rule`.

Este caso **no cuenta como P2 corregido funcionalmente**. Su FAIL original permanece en los JSON históricos; el nuevo resultado usa la regla aprobada. No se cambia severidad para hacerlo pasar.

### U-0210 — ventas y compras

Al habilitar la ruta existente, el auditor exigía type=purchase a cualquier texto que contuviese «compras», incluso «ventas y compras». Eso contradice el pedido de ambos tipos. Se corrige la comprobación para exigir ausencia de filtro de tipo cuando ambos están presentes y conservar purchase cuando solo se piden compras; también se inspecciona el pipeline.

La metadata `auditorFilterCorrections` conserva la comprobación anterior y la justificación. U-0210 sí tiene un fix funcional: antes caía al provider; ahora consulta ambas clases, 0 LLM. No es una nueva capacidad multi-intent: una consulta get_recent_transactions puede devolver ambos tipos.

## Validación final

- Nuevas pruebas: **62/62**, registradas en backend/test/run.js.
- Focales: **669/669** (routing/respuestas, forecast/ventas temporales, cantidades, guided actions, contexto y HTTP real local).
- Backend completo: **1192/1192**, baseline 1130.
- P3C.1: 12/12; P3C.2: 9/9; P3C.3: 6/6.
- P3C.3.1: S-121 PASS; suite de nombres visibles completa incluida, con retry y ruta POST /api/agent/messages.
- Quantities, confirm/cancel, números/subgrupos, supplier context y separación de alertas siguen cubiertos.
- Sintaxis: 195 JS verificados, 0 errores; los módulos editados al final se verificaron otra vez.
- Diff normal/staged verificados antes del commit.
- Frontend y Mongo no modificados; no se requieren nuevas suites de esas capas.

La primera corrida focal encontró un overmatch de «reponerlo» y se corrigió antes de validar el árbol final. También se añadió un contraste de «cantidad recomendada» para que el alias de precio no secuestre reposición. Ningún FAIL nuevo queda en la auditoría final.

## Auditoría final: 828 casos

| Estado | Antes P3D | Después P3E |
| --- | ---: | ---: |
| PASS | 655 | 704 |
| FAIL | 119 | 70 |
| PARTIAL | 12 | 12 |
| NOT_SUPPORTED | 28 | 28 |
| NEEDS_MANUAL | 14 | 14 |
| P0 | 0 | 0 |
| P1 | 0 | 0 |
| P2 | 118 | 70 |
| P3 | 1 | 0 |

**47 P2 corregidos funcionalmente**, 1 P2 retirado por corrección de expectativa U-0675, 1 P3 de concordancia corregido. Por eso el conteo P2 baja 48, pero no se presentan 48 fixes funcionales.
No se observan regresiones nuevas: ningún PASS previo pasa a FAIL y ningún grupo excluido cambia de clasificación, salvo la corrección del auditor U-0675 solicitada expresamente.

IDs funcionales P2 resueltos por grupo:
- G01: 19 casos — `U-0003`, `U-0007`, `U-0008`, `U-0017`, `U-0018`, `U-0019`, `U-0020`, `U-0021`, `U-0026`, `U-0032`, `U-0033`, `U-0035`, `U-0046`, `U-0049`, `U-0050`, `U-0057`, `U-0058`, `U-0069`, `U-0138`.
- G02: 12 casos — `U-0163`, `U-0168`, `U-0188`, `U-0201`, `U-0202`, `U-0203`, `U-0210`, `U-0213`, `U-0218`, `U-0219`, `U-0223`, `U-0236`.
- G03: 5 casos — `U-0314`, `U-0327`, `U-0339`, `U-0340`, `U-0367`.
- G05: 3 casos — `U-0413`, `U-0443`, `U-0458`.
- G06: 7 casos — `U-0472`, `U-0484`, `U-0485`, `U-0487`, `U-0490`, `U-0498`, `U-0499`.
- G08: 1 casos — `S-084`.

P3 resuelto: U-0251. El informe machine-readable es `CONV-POLISH-P3E.json`, generado con `node backend/scripts/audit-conversation-p3b.js --polish-p3e`. Tiene targets, before/after, correcciones del auditor y subsets de regresión. No sobrescribe P3B/P3C/P3D ni altera sus resultados.

## 18 smokes P3D locales

Ejecutados con `node backend/scripts/smoke-conversation-p3e.js`.
**14 PASS / 4 NEEDS_MANUAL**. Son modelos/servicios en memoria y provider fake; no se leyó dotenv, no hubo red/Atlas ni llamadas pagadas. El preview/cancelación de #17 existe solo en memoria; no se confirmó ninguna acción.

| # | Consulta/secuencia | Local | Evidencia o límite |
| --- | --- | --- | --- |
| 1 | `dime el stock de food 096` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 2 | `cuánto cuesta food 96` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 3 | `Busca food 210` → `M5-FOODS_3_210` → `¿Y el precio?` | NEEDS_MANUAL | Search list and SKU continuation pass locally; the explicit search response has no suggestions cards. The proposed real-click step needs UI verification; no frontend change is in scope. |
| 4 | `¿Cuánto vendí de food 96 ayer?` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 5 | `dime el total vendido este mes` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 6 | `últimas compras` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 7 | `¿Cuál es la predicción de food 96?` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 8 | `¿Cuál es la predicción del próximo mes?` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 9 | `¿Cuál es la precisión exacta de la predicción?` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 10 | `quién provee food 96` | NEEDS_MANUAL | The existing commercial matcher requires an exact SKU in this synthetic fixture; supplier values need real-tenant verification. Routing/0LLM checked. |
| 11 | `¿Cuánto cuesta reponer M5-FOODS_3_511 usando el proveedor 55 foods?` | NEEDS_MANUAL | The local audit fixture has 25 suppliers and does not contain supplier 055. Cloud offer and exact cost require the existing V2 dataset. |
| 12 | `Tengo S/ 500, ¿qué productos debería comprar primero?` → `¿Cuánto dinero sobra?` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 13 | `lista mis reglas de stock` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 14 | `¿Qué alertas abiertas tengo?` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 15 | `¿Cuál es el estado de entrega de mis alertas de inventario?` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 16 | `¿Qué Telegram fueron omitidas para food 210?` → `M5-FOODS_3_210` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 17 | `vende 1 del food 96` → `¿cuánto quedaré de stock?` → `cancela` | PASS | Runtime/skills y aserciones locales correctos; datos sintéticos |
| 18 | `Explícame los principales problemas que observas en el inventario y la predicción` → `¿Por qué ocurre esto?` | NEEDS_MANUAL | Real Gemini groundedness and interpretation cannot be verified by a fake provider; local bounded fallback/context checked, no paid calls. |

En #3 pasan la lista y la continuación por SKU; el clic real necesita revisión de UI y la búsqueda explícita no entrega suggestions cards en ese fixture. No se modifica frontend en P3E.
En #10 el matcher comercial conservador pide SKU en el fixture; no se declara éxito de resolución de proveedor real.
En #11 el fixture solo contiene 25 proveedores, no 055; el costo V2 1378.96 PEN requiere verificación con el tenant real.
En #18 se comprueba límite de una generación lógica y follow-up con 0 LLM/skills, pero el provider sintético no valida naturalidad/groundedness de Gemini.

## Fuera de alcance deliberadamente

G04 presupuestos inválidos, G09 alias Alimentos 096, G10 READY/VIGILAR sin dominio, G11 variantes cross-tenant, G12 temporales truncados, G14 aliases WRITE raros, G16 currency polish, G17 planner multi-intent, G18 capacidades NOT READY/clientes y G19 nueva síntesis se conservan. G13 solo cambia el auditor.

No hay supplier details, customer CRUD, RAG, Telegram conversacional, nuevo LLM/gateway ni entrenamiento. Las aclaraciones y capacidades parciales no se convierten en éxito inventado para bajar métricas.

## Smoke cloud recomendado tras una publicación autorizada

En una conversación nueva:
1. `dime el stock de food 096`.
2. `cuánto cuesta food 96`.
3. `¿Cuánto vendí de food 96 ayer?`: una sola respuesta, incluso sin ventas; ambas skills visibles.
4. `últimas compras`: tipo purchase, lectura.
5. `lista mis reglas de stock`.
6. `estado de entrega para food 210`: seleccionar un SKU si hace falta; outbox.
7. `por qué se omitió Telegram de food 96`: channel delivery SKIPPED, no envío.
8. `¿Cuál es la precisión exacta de la predicción?`: limitación, 0 skills.
9. `¿Cuál es la predicción del próximo mes?`: tildes/limitación, 0 skills.
10. `vende 1 del food 96` → `¿cuánto quedaré de stock?` → `cancela`: solo preview; NO confirmar.

Revisar además los cuatro NEEDS_MANUAL con sesión V2. Si la búsqueda explícita no ofrece card, registrar el comportamiento y probar el SKU; no declarar un clic real simulado.
Todas las rutas determinísticas corregidas conservan 0 LLM/0 tokens. La síntesis real continúa con su uso intencional existente.

## Archivos y Git

Modificados: intentRouting.js, responses.js, forecastRouting.js, orchestrator.js, automations/assistant.js, backend/test/run.js y audit-conversation-p3b.js.
Nuevos: conversationalP3E.test.js, smoke-conversation-p3e.js, este MD, CONV-POLISH-P3E.json y CONV-POLISH-P3E-smokes.json.

Dos commits locales pendientes tras cerrar: P3D `8a05a39` y P3E `fix: polish pre-demo conversational flows`.
Sin push. Git sin cambios tracked pendientes; .tmp/, Caso_5_Gobierno_Digital_Resuelto.docx, case-preview-1.png y case-preview-2.png permanecen intactos.
