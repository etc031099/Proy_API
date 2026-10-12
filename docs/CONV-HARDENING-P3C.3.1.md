# CONV-HARDENING-P3C.3.1 — continuidad por nombre visible

## Reproducción y causa

La secuencia reportada en cloud fue:

1. `Busca food 96` devuelve `Alimentos M5 · FOODS_2 · Ítem 096` (`M5-FOODS_2_096`).
2. Enviar únicamente `Alimentos M5 · FOODS_2 · Ítem 096` produce error de servicio.
3. Reintentar ese mismo texto vuelve a fallar.
4. `¿Y el stock mínimo?` pide identificar el producto.

Se reprodujo por HTTP local cargando en memoria el código publicado del commit `454c8fe`, con la ruta real `POST /api/agent/messages`, controller y wrapper de acciones, sesión autenticada sintética y modelos/provider de prueba. La búsqueda devolvió HTTP 200, el nombre aislado devolvió HTTP 503 dos veces (`AGENT_PROVIDER_FAILED`), y el seguimiento quedó sin producto seleccionado.

No se dispone de los logs internos de Render en esta fase. La reproducción local encontró una derivación incorrecta hacia el provider, no una excepción de Unicode, regex o Mongo. El provider sintético lanzó `Error: DIAGNOSTIC_UNEXPECTED_LLM` desde `Coordinator generateStructured`; el ejecutor la normalizó como `GEMINI_UNAVAILABLE` y el orquestador la expuso como `AGENT_PROVIDER_FAILED`. Ese error deliberado identifica la llamada indebida; no representa una excepción interna observada en Gemini cloud.

La causa está en dos funciones:

- `backend/src/agents/orchestrator.js`, `productCandidateSelection`: descartaba listas de búsqueda con menos de dos elementos. Además comparaba `item.name`, mientras que `compactProductSelection` conserva el nombre visible bajo `item.label`. El resultado único de la búsqueda nunca se reconocía como selección.
- `backend/src/agents/intentRouting.js`, `routeDeterministically`: la extracción estructurada del nombre visible solo producía una ruta si el mensaje incluía una pregunta de atributo (`stock`, `precio`, etc.). El nombre aislado carece de esa pregunta; la ruta quedaba sin resolver y terminaba en clasificación LLM.

Una búsqueda genera un snapshot de lista; no equivale por sí misma a seleccionar un producto para los siguientes atributos. Al fallar el segundo turno no se actualizaba `selectedProductReference`, lo que explica la aclaración posterior.

## Por qué las pruebas previas pasaban

El caso S-076 y el test P3C.3 enviaban `¿Cuánto stock tiene Alimentos M5 · FOODS_2 · Ítem 096?` y luego `¿Y el stock mínimo?`. Conservaban el texto UTF-8 correcto, pero cubrían una pregunta con atributo. No ejecutaban la búsqueda previa, el nombre aislado, el retry y la ruta HTTP de esa secuencia.

## Corrección

- El selector acepta snapshots con un solo resultado y compara `name || label` usando el normalizador compartido de identidad de producto.
- La coincidencia acepta NFC/NFD, tildes equivalentes, separadores y espacios sin alterar el nombre original guardado.
- Las referencias numéricas cortas se resuelven únicamente cuando hay un candidato compatible inequívoco en el snapshot; las incompatibles piden selección. Se mantienen las invariantes `96 == 096 == 0096` y `96 != 196/960/97`.
- El nombre aislado con formato completo del catálogo y el SKU exacto se resuelven determinísticamente también sin snapshot. Esto permite repetir la consulta después de que la primera selección haya consumido el snapshot.
- La selección conserva el intent y periodo de la continuación y actualiza `lastEntity` y `selectedProductReference`. Cada detalle se verifica mediante la skill existente y el tenant autenticado.

No se agregaron catches ni se ocultaron excepciones. El flujo sigue siendo de lectura/contexto y no invoca el servicio de acciones.

## Pruebas y regresiones

- 12 pruebas nuevas en `backend/test/visibleProductContinuations.test.js`: nombre exacto, NFC/NFD, sin tilde, sin separadores, espacios, padding, SKU, alias, contexto, periodo, identificadores incompatibles y secuencia HTTP con retry.
- El fixture focal usa mínimo 3 y verifica que el último turno responda ese mínimo para el mismo SKU.
- Pruebas focales de entidades, continuaciones, orquestador, acciones seguras y fases previas: 575/575 PASS.
- Backend completo: 1130/1130 PASS.
- Subsets de regresión: P3C.1 12/12, P3C.2 9/9, P3C.3 6/6.
- Frontend y persistencia sin cambios; no se requieren pruebas frontend/Mongo nuevas.
- Auditoría completa: 828 casos, incluyendo los 827 anteriores sin alterar IDs, expectativas ni reglas de severidad y el nuevo S-121.
- Resultado: 655 PASS, 119 FAIL, 12 PARTIAL, 28 NOT_SUPPORTED, 14 NEEDS_MANUAL.
- Severidad: P0=0, P1=0, P2=118, P3=1; 0 regresiones críticas nuevas. Dos P2 anteriores de selección por nombre pasan como consecuencia del mismo fix de `label`.
- Informe completo: `docs/CONV-HARDENING-P3C.3.1.json`; evaluación del árbol de trabajo precommit indicada explícitamente en `evaluationBasis`.

Todas las pruebas de selección y retry corregidas realizan 0 llamadas LLM, consumen 0 tokens y no crean PendingAction ni escrituras de negocio. La suite completa conserva P2A/P2A.1, P2B/P2B.1, P2D y aislamiento tenant/user/conversation.

## Smoke cloud tras publicar

En una conversación nueva con sesión V2:

1. `Busca food 96`
2. Copiar exactamente el nombre mostrado: `Alimentos M5 · FOODS_2 · Ítem 096`
3. Enviar nuevamente el mismo nombre para verificar retry seguro.
4. `¿Y el stock mínimo?`

Esperado: búsqueda y detalles correctos, contexto `M5-FOODS_2_096`, mínimo configurado 3, HTTP 200, 0 LLM/0 tokens, sin acciones propuestas o ejecutadas. La verificación cloud de esta secuencia queda pendiente de la publicación autorizada; esta fase crea únicamente el commit local.
