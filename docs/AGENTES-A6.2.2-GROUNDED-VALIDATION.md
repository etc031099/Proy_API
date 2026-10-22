# A.6.2.2 — Validación grounded: evidencia y límites

## Cloud: qué está probado

El usuario aportó `UNKNOWN_ENTITY`, `observations[0].advisoryRecommendation`,
`finishReason=stop`, contenido recibido, una llamada DeepSeek y 2024 tokens.
Esto prueba rechazo del campo de recomendación por el validador de entidades,
no indisponibilidad del proveedor. La frase original no se conservó.
**No es posible recuperar la palabra exacta, ni certificar que ese rechazo
particular fue un falso positivo.** No se repitió una llamada real al proveedor.

## Camino real y diagnóstico

`grounded.js` recibe la salida -> `parseGroundedSchema` ->
`validateGroundedOutput` en `groundedContext.js` -> fallo de entidades ->
`safeGroundedDiagnostic` -> historial público y Activity.

Ambos campos, `interpretation` y `advisoryRecommendation`, pasan por los
controles de identificadores, nombres heurísticos y entidades etiquetadas.
Antes todos devolvían la misma categoría `UNKNOWN_ENTITY` sin subcategoría.
Ahora se conserva además un `entityReason` cerrado:

- `UNKNOWN_IDENTIFIER`: identificador/SKU fuera de las referencias citadas.
- `UNKNOWN_NAME_AFTER_ACTION`: patrón de nombre tras acción o antes de un verbo factual.
- `UNKNOWN_LABELLED_ENTITY`: término desconocido tras producto/cliente/proveedor/marca.
- `UNKNOWN_PURCHASE_ENTITY`: nombre no sustentado en una recomendación de compra a una entidad.

No se guarda nombre rechazado, frase, prompt, contexto ni valores de cliente.
El código cerrado llega al mismo endpoint/historial y al disclosure de diagnóstico
existente; no hay nuevas consultas, persistencia de texto bruto ni servicios.

## Reproducciones locales, no atribuidas al cloud

Con inventario PARTIAL, stock 13, cobertura 1.67, HIGH, sugerencia 102 y
Ridge 7d READY 55.36:

- Los ejemplos «Conviene priorizar la reposición», «Deberías prestar atención
  a este producto» y «Conviene evitar una cobertura insuficiente» ya se aceptaban.
- «Prioriza Reposición antes de decidir» fallaba por interpretar Reposición
  como nombre de catálogo. «Consulta Inventario» y «Revisa Cobertura» tenían
  el mismo problema con mayúscula. Se corrigió solo ese patrón genérico,
  en el campo de recomendación, con un único producto de inventario citado y
  un valor correspondiente conocido. No se agregó una whitelist global de nombres.
- «Compra a Distribuidora X mañana» pasaba sin evidencia de proveedor.
  Ahora ese patrón de nombre de contraparte requiere identidad citada.
- «El stock cubre menos de 2 días» rechazaba el umbral como cifra inventada,
  aunque 1.67 < 2; la misma comparación escrita con «dos» pasaba sin comprobarla.
  Se verifica ahora la desigualdad para formas explícitas y acotadas de cobertura,
  con un único producto citado. No se autoriza 2 como stock, forecast o dato medido.
- «Te quedarás sin stock mañana» pasaba sin fundamento temporal.
  Ahora se rechaza la afirmación de quiebre futuro cierto, no una recomendación
  prudente de evitarlo.
- Se comprueban también paráfrasis explícitas de nivel de riesgo contra el nivel citado.

Estos cambios no prueban comprensión semántica general de todo lenguaje natural.
Se mantienen validaciones cerradas, rechazo fail-closed y fallback factual.
No se permite inventar entidades, 150 unidades frente a 102, plazos de proveedor,
Ridge 1d, fraude, causalidad de asociaciones o churn. No se alteraron ML/BI,
gateway, transacciones, timeouts ni providers. La limitación PARTIAL sigue
añadiéndose desde evidencia incluso si el LLM omite su código.

## Validación

- Nueva suite `groundedCloudA622.test.js`: ejemplos A–J, recomendaciones A–F,
  aislamiento por evidencia/SKU, números no autorizados, cobertura ausente,
  nombres falsos, categoría de diagnóstico/historial y fallback real con proveedor mock.
- Regresiones A.6.2/A.6.2.1, routing, NLU, seguridad, acciones e historial:
  594/594 PASS, incluyendo 45 nuevos tests A.6.2.2.
- Frontend assistant/component/actions/history: 111/111 PASS.
- TypeScript, ESLint focal backend/frontend, sintaxis de cinco archivos JS y
  `git diff --check`: PASS.
- Auditoría adicional de J2M/NContracts/O/P/Q/R: 199 tests, 169 PASS, 30 FAIL;
  mismos fallos y nombres al sustituir en memoria `groundedContext.js` por HEAD.
  No se corrigieron fixtures/expectativas históricas fuera del alcance.
- Todas las respuestas de proveedor en tests son mocks. Cero llamadas reales,
  writes cloud, training, replay, checkpoint o restore.

## Próximo smoke tras publicación manual

No se hizo stage/commit/push/deploy. A.6.2 permanece abierta.
Después del próximo deploy, repetir una vez la consulta original y seleccionar
el producto. Comprobar respuesta natural, `generation.status=SUCCEEDED`,
`groundedAnswer.accepted=true`, una llamada y tokens reales > 0.
Si vuelve a rechazarse, leer `validationReason`, `validationField` y
`entityReason` en «Diagnóstico de síntesis» o `[GroundedValidation]`.
No prometer aceptación del mismo texto cloud perdido ni reintentar masivamente.
