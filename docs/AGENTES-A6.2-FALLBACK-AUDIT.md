# A.6.2 — Auditoría y endurecimiento del fallback existente

## A–B. Qué existía y qué ya estaba resuelto

Se inspeccionaron las implementaciones, tests y documentación J2A–N, A.4.6 y A.6.
No se creó otro router LLM, servicio NLU, proveedor, schema de intenciones ni capa
de memoria. La selección/configuración de proveedores y sus timeouts no cambió.

| Responsabilidad | Autoridad existente |
| --- | --- |
| NLU DeepSeek, A.4.6 | `backend/src/agents/languageNlu.js`: `semanticPlan`, `validateNlu`, `nluPlan` |
| Contrato NLU | `SCHEMA`: intent, productQuery, metric, period, quantity, horizonDays, needsClarification, clarificationReason; sin campos extra |
| Validación NLU | Query literal contenida en el mensaje, cantidades explícitas, período/horizonte compatible, sin IDs inventados ni selección inferida; máximo dos especialistas relacionados |
| Plan grounded | `groundedRouting.js`: `classifyGrounded`, `buildGroundedPlan` |
| Síntesis y fallback | `grounded.js`: `handleGrounded`; las skills se ejecutan antes del proveedor |
| Evidencia | `groundedContext.js`: proyección allowlist, máximo tres filas por colección proyectada, contexto de 6400 bytes y envelope de 8000 bytes |
| Schema de salida | `groundedOutputSchema.js`: observations con evidenceRefs/interpretation/advisoryRecommendation; limitations con códigos autorizados |
| Cifras y referencias | `groundedNumbers.js`, `validateGroundedOutput`: solo hechos citados, formato/rounding permitido, no cifras libres de la pregunta |
| Limitaciones | `groundedLimitations.js`: estados reales autorizan códigos; no prosa arbitraria |
| Scope y seguridad | `domainGate.js`, guard de tenant de `intentRouting.js`, contratos de skills y contexto autenticado |
| Continuaciones | `v3Routing.js`: selección/paginación, `compactV3State`, binding y TTL; `explanationContext.js`: hechos previos, no inferencia nueva |
| Operations | `automations/assistant.js`, borrador existente, resolver → preview → confirmación; A.5.3.3 intacta |
| Telemetría | `execution.js`: `semanticClassification`, `groundedAnswer`, eventos, participantes, usage y costes cuando el proveedor los reporta |

Ya existían rechazo completo de generación inválida, fallback factual ante proveedor
caído/truncado, separación de DeepSeek y Gemini, cero LLM para lecturas claras y
un máximo de una llamada por tipo (`semanticCalled` / `groundedCalled`). No se
añadieron retries ni fallback entre proveedores.

## C. Gaps demostrados antes de modificar

- Preguntas abiertas sobre una entidad podían producir `null` o convertir toda
  la oración en una búsqueda de catálogo; la síntesis existente no recibía ese caso.
- El plan grounded anterior solo extraía SKU explícito, no utilizaba el flujo de
  candidatos/contexto del producto para estas nuevas interpretaciones.
- Un lookup reconocido podía impedir el NLU aunque no se hubiese entendido la
  intención abierta de la pregunta.
- «Esa predicción la inventaste» podía acabar en el resumen Sales: la coincidencia
  amplia de `venta` también aparece en `inventaste`.
- «Quién me trae más rápido…», «cliente que debería preocuparme» y «quién me la
  provee» no se adaptaban al contrato especializado correcto.
- «Isolation Forest … fraude» entraba por provisional antes de la explicación del
  contrato de fraude.
- Lluvia, mundial, poema y algunas instrucciones de extracción/inyección escapaban
  del gate determinístico. Una inyección compuesta podía llegar al composite.
- La validación no cubría nombres comerciales libres ni códigos en minúsculas en
  todas las formas añadidas; algunas afirmaciones semánticas no estaban bloqueadas.
- La generación aceptada podía omitir una limitación material autorizada en la evidencia.

## D–G. Extensión mínima y arquitectura final

1. Lectura clara → routing/contexto/resolver existentes → especialista(s) → hechos;
   **0 LLM**. No se hace obligatoria una IA dentro de cada especialista.
2. Frase no reconocida → el mismo NLU estructurado y validador → tasks ya existentes.
   **Máximo 1 NLU**. Se conservan schema e intenciones existentes.
3. Interpretación abierta de producto/cliente → tasks READ → misma síntesis grounded.
   Puede utilizar **0/1 NLU + 1 síntesis**, nunca una cadena LLM por especialista.

Los nuevos modos internos `grounded-product` / `grounded-customer` conservan solo
la intención de presentación en el pending existente, no la pregunta cruda. La
selección sigue usando binding, TTL, catálogo autorizado y candidatos V3. Después
de elegir se usa una pregunta acotada equivalente a la intención conservada.
Una referencia ambigua no hereda silenciosamente el producto anterior. Un contexto
con binding ajeno no se reutiliza.

`handleGrounded` acepta internamente el plan/binding ya resueltos para no resolver
otra vez ni introducir una segunda capa de memoria. El orchestrator conserva el
patch V3 más reciente al cerrar el pending; no sobrescribe la entidad recién elegida
con la copia de estado previa al turno. Más de dos dominios explícitos pide priorización.

- Inventory aporta stock/cobertura/reposición.
- Forecast aporta el contrato Ridge LIVE aprobado y su evidencia por horizonte.
- Sales, Customers, Procurement y Associations conservan sus skills descriptivas.
- Analyst participa cuando realmente se solicita síntesis; no reemplaza a especialistas.
- Coordinator orquesta, contextualiza y registra el NLU cuando hace falta.
- Operations sigue siendo el único agente write-capable.

Se reutilizan las explicaciones anteriores para cuestionar una predicción sin
reconsultarla. La explicación de Ridge distingue el contrato aprobado de una
comparación nueva que no está disponible. Isolation Forest no se interpreta como
fraude; K-Means no predice churn; FP-Growth no demuestra causalidad.

## H–J. Banco de pruebas y reutilización

`backend/test/fixtures/a62FallbackCases.js` identifica una muestra de **150 frases
únicas normalizadas**, sin generar variantes para inflar el conteo:

| Categoría | Frases |
| --- | ---: |
| NLU estructurado: muestra estratificada del corpus J4 existente | 100 |
| Determinísticas | 12 |
| Síntesis grounded | 10 |
| Clarificación | 6 |
| Fuera de alcance | 6 |
| Escritura ambigua/narrativa | 4 |
| Escritura explícita | 4 |
| Seguridad | 8 |
| Total | 150 |

Las 100 anteriores se prueban mediante su suite original, no con otros cien tests
redundantes. Son oráculos offline del límite proveedor/validador/planner, no una
medición de precisión de un modelo real. El corpus original completo se conserva.

`assistantFallbackA62.test.js` añade 74 tests: las 50 frases focales y controles de
schema, hechos, contexto ajeno, límites de dominios, fallos/truncado, continuidad,
limitaciones y consumo. Tres tests adicionales en `inventoryForecastAgents.test.js`
recorren el servicio V3 real con snapshot/Registry/ML simulados: candidato ambiguo,
restauración de contexto, elección única, Inventory + Ridge y síntesis aceptada.

Se reutilizan A.4.6 en `inventoryForecastAgents`, `architectureClosure`, Operations
multi-producto, Sales/Customers, Procurement/Associations, actions/auth/history y
las suites de grounding/DeepSeek J2A–M y contratos N.

El único ajuste de un test antiguo (`groundedJ2K`) añade el nombre realmente citado
al fixture numérico que decía «Revisar Cocinero» sin aportar ese nombre en evidencia.
No se elimina ningún test ni se relajan las validaciones para obtener verde.

## K. Ejemplos antes → después

- «Con todo lo que sabes de coca cola, qué harías»: búsqueda/clarificación genérica
  → candidatos → selección única → Inventory/Forecast → una síntesis factual nueva.
- «Viendo lo q tengo y lo q probablemente venda q hago con coca»: mismo resolver,
  sin inventar producto, cantidades ni un forecast diario.
- «Esa predicción la inventaste»: resumen de ventas → explicación de hechos previos
  y contrato Ridge, etiquetados como lectura anterior; cero inferencias nuevas.
- «Quién me trae más rápido»: desconocido → Procurement, lead time observado,
  no una promesa de entrega futura.
- «Qué conclusión sacas de este cliente»: ranking genérico → cliente seleccionado
  → evidencia RFM → síntesis, con advertencia de que no hay probabilidad de churn.
- «Me alcanza la coca pal finde»: sin interpretación segura → clarificación;
  no se transforma el fin de semana en un nuevo horizonte ni se inventa stock.
- «Ayer salieron 4 lays» / «comprame coca»: Operations pide aclaración, sin preview
  ni writes. «Acabo de vender 2 leches» conserva la aclaración narrativa de A.6.1.

## L–N. Guardrails, Operations y telemetría

Se rechaza la respuesta entera ante esquema/JSON inválido, referencia no existente,
SKU/código no citado (también en minúsculas), cifra no soportada, nombre introducido
en las formas de entidad comprobadas, instrucción de ejecutar/registrar, fraude,
causalidad confirmada y afirmaciones de stock/riesgo incompatibles cubiertas por
los controles. No se corrige parcialmente una respuesta inventada. El fallback
solo usa hechos de las skills y notas fijas de limitación.

Las limitaciones materiales de la evidencia se renderizan desde la allowlist
server-side aunque el proveedor devuelva `limitations: []`.

**Límite explícito:** validar schema, referencias, números, nombres y predicados
acotados no demuestra lógicamente toda frase posible en lenguaje natural. Los
controles semánticos son conservadores y pueden rechazar una paráfrasis legítima;
el resultado en ese caso es fallback factual. No se afirma cero alucinaciones
para cualquier español ni certificación de calidad de DeepSeek real. No se hizo
smoke pagado ni consulta a producción durante esta fase.

La salida de síntesis nunca entra al action gateway ni autoriza una operación.
Preview, confirmación, idempotencia, locks, fencing, transacciones, deadlines y
telemetría de A.5.3.2/A.5.3.3 permanecen sin cambios.

Una llamada NLU se atribuye al Coordinator; síntesis, al Analyst. Los contadores y
usage provienen de las respuestas del proveedor; faltante sigue siendo desconocido,
no cero inventado. El test combinado comprueba dos llamadas y 960 tokens reportados
simulados, con diagnósticos separados. El provider conserva su cap configurado:
en el fixture envía 300 tokens para NLU y 500 para síntesis. No se modificaron límites,
timeouts, proveedores, thinking ni retry policy.

## O. Archivos de esta fase

Producción, solo asistente:

- `backend/src/agents/commercialSpecialistRouting.js`
- `backend/src/agents/domainGate.js`
- `backend/src/agents/explanationContext.js`
- `backend/src/agents/grounded.js`
- `backend/src/agents/groundedContext.js`
- `backend/src/agents/groundedRouting.js`
- `backend/src/agents/languageNlu.js`
- `backend/src/agents/orchestrator.js`
- `backend/src/agents/v3Routing.js`
- `backend/src/automations/actionInput.js`
- `backend/src/automations/assistant.js`

Tests/documentación:

- `backend/test/assistantFallbackA62.test.js` (nuevo)
- `backend/test/fixtures/a62FallbackCases.js` (nuevo)
- `backend/test/groundedJ2K.test.js`
- `backend/test/helpers/j2sProductFixture.js`
- `backend/test/inventoryForecastAgents.test.js`
- este informe (nuevo).

Sin frontend, servicios BI, ML, artifacts, políticas, esquemas Mongo, Telegram,
variables, datos, entrenamiento, replay, checkpoints, restores ni accesos Atlas.

## Validación y pendientes históricos

- Nueva suite A.6.2: 74/74 PASS; tres integraciones Ridge grounded adicionales PASS.
- Regresiones focales finales (13 suites de asistente/actions/auth/history/security):
  **480/480 PASS**.
- Grounding/DeepSeek, 359 tests: **319 PASS / 40 FAIL**, igual en HEAD y en esta fase;
  comparación automática de nombres: **cero fallos introducidos**, cero reparados.
  Persisten expectativas de tres/cuatro dominios, referencias E3 de proveedores
  fuera del plan actual y contratos históricos 1/7/14; no se restauran por tests.
- Corpus J4/J41: **558 tests, 550 PASS / 8 FAIL en HEAD**. Los ocho fallos son:
  `pronostico cocinero`, `pronostico del cocinero`, `cuanto se vendera del cocinero?`,
  adversarial intent precedes entity lookup, context A inventory→forecast→cross-sell,
  semantic forecast explicit 28-day rejection, J41 implicit Cocinero forecast y
  J41 current explicit product wins. Las fixtures antiguas de forecast no suministran
  el Registry LIVE actual en varios de ellos. No se cambió ML ni la política para
  hacerlos pasar. Resultado final de esta fase: **550 PASS / 8 FAIL**, los mismos
  nombres que HEAD, sin fallos nuevos. Duración aproximada de la repetición: 161 s.
- Nueva batería y controles numéricos J2K después del último ajuste: **120/120 PASS**.
- Sintaxis Node, ESLint focal y `git diff --check`: comprobados sobre los archivos
  modificados; no se requiere TypeScript/frontend porque no cambió su contrato.

## P–Q. Git

El diff/stat y `git status --short` exactos se adjuntan en la entrega. El stat de
Git no cuenta archivos nuevos sin seguimiento; los tres se enumeran arriba.
`entrega-tutoria-bullying/` se preserva. Sin stage, commit, push ni deploy.
