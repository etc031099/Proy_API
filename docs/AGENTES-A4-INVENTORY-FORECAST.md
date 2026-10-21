# A.4 — Inventory y Forecast funcionales

El `coordinator` existente actúa como Agente Orquestador. Resuelve intención y ambigüedad, conserva contexto y delega por dominio. No existe otra identidad `orchestrator` ni ejecuta lógica ML directamente.

## Especialistas activos

| Agente | Skill efectiva | Respuesta especializada | Escrituras |
| --- | --- | --- | --- |
| `inventory` | `get_inventory_intelligence` | Stock, mínimo, incoming, posición, cobertura, riesgo y conclusión de reposición Sí/No/No disponible a partir del servicio | Ninguna |
| `forecast` | `get_product_forecast` | Ridge LIVE 7d/14d, modelo/versión/disponibilidad y límites metodológicos | Ninguna |

Ambos son `ACTIVE`, con permisos propios, ejecución real por el dispatcher, evidencia y trazas. La síntesis de estas consultas es determinística: no requiere llamadas LLM. Sus módulos de respuesta presentan una conclusión directa seguida por las tarjetas/evidencia existentes. No recalculan demanda, reposición ni métricas ML.

`sales`, `customers`, `procurement` y `associations` permanecen `PLANNED`, sin skills ni acciones. Solo `operations` conserva las cinco acciones del gateway existente y sus previews, confirmaciones e idempotencia.

## Continuidad después de seleccionar una entidad

La selección exacta de un código/nombre de la lista pendiente se aplica antes de aceptar una nueva lectura genérica. Una nueva pregunta explícita conserva prioridad para reemplazar la intención anterior.

La estructura pendiente existente mantiene tasks con skill, argumentos validados, tipo de entidad, paginación y `requestedIntent` de una enumeración cerrada. Es una representación semántica: no almacena la pregunta completa. La selección sustituye únicamente el parámetro de entidad, preservando horizonte, modo y periodo. `compactV3State` conserva esa intención al guardar/restaurar historial y revalida todos los argumentos. Las conversaciones anteriores siguen siendo válidas; cuando falta `requestedIntent`, se puede recuperar reposición desde el flag previo y forecast desde la familia de skill.

Ejemplos certificados mediante pruebas con servicios reales y dependencias externas simuladas:

- “¿Debo reponer Coca-Cola?” → dos candidatos → “BEB-GAS-001” → `inventory` → “Sí, debes reponer Coca-Cola Sabor Original 500 ml.”, posición 14 frente al punto 59, cobertura 1.78, riesgo alto y cantidad 102 del fixture.
- “¿Cuánto venderemos de Coca-Cola en 14 días?” → selección → `forecast` → “Se esperan 108.27 unidades … en los próximos 14 días según Ridge LIVE ACTIVE”, con modelo y featureVersion del fixture.

Estos números son datos de test, no mediciones de producción ni valores fijados en el código funcional.

Una consulta de detalle de reposición no envía el filtro de lista `should_reorder`: ese filtro eliminaría el producto si la recomendación fuera falsa o desconocida. La intención se conserva por separado y la respuesta usa el valor real `shouldReorder` sin inferir `false` desde null.

## Routing, composición y legado

Los tasks V3 de inventario se asignan a `inventory`; el forecast LIVE y método operativo a `forecast`. La evaluación histórica y consultas con `asOfDate` explícito continúan en `analyst`. El clasificador genérico legado no se amplía a las identidades pendientes. Las consultas conceptuales/históricas y síntesis generales siguen con su ruta previa.

El orquestador reutiliza la composición explícita existente cuando se piden inventario y forecast de forma inequívoca. En el caso probado se ejecuta una skill por especialista con el mismo SKU y snapshot/revisión de la petición. “¿Por qué debería reponer …?” usa solo Inventory cuando su evidencia es suficiente: no genera un segundo forecast por defecto.

`analyst` conserva permisos de compatibilidad para flujos históricos, síntesis y otros dominios. Se migró la selección determinística V3 de los casos cubiertos, sin retirar herramientas necesarias a conversaciones anteriores. Los tenants sin binding V3 mantienen su ruta previa.

## Seguridad y límites

Forecast no puede solicitar evaluación histórica, `asOfDate` ni horizonte 1d por su skill. Las evaluaciones históricas explícitas corresponden al agente legado. No hay fallback, entrenamiento, promoción ni replay en los especialistas. Ambos fallan antes de ejecutar ante una skill ajena; sus acciones están prohibidas por el gateway existente. Los filtros de tenant, autenticación, propiedad de conversación, TTL y schemas cerrados se conservan.

El historial operacional por producto no se incorpora como herramienta nueva en A.4. La composición implícita o ambigua sigue requiriendo aclaración. No se agregan endpoints ni contratos BI/ML.

## Validación

`backend/test/inventoryForecastAgents.test.js` prueba selección 7d/14d, restauración de contexto, reposición true/false/null, stock/cobertura/riesgo, modelo, mañana sin ML, cambios explícitos de intención, composición coherente, permisos y cero dispatch ante intento de otra familia. El runner oficial incluye esta suite. Las pruebas A.2 continúan cubriendo los modelos ACTIVE y la ausencia de fallback.

No se ejecutó smoke cloud ni deploy. El smoke futuro debe validar esos mismos flujos de lectura y una preview de escritura sin confirmarla.
