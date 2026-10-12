# CONV-POLISH-P3A: textos determinísticos y tarjetas

Esta fase modifica presentación y respuestas desde el preview congelado. No modifica cálculos, contratos públicos, filtros, skills, confirmación, TTL ni permisos.

## Antes y después

| Antes | Después |
| --- | --- |
| Registrar venta de 1 producto(s). | Registrar venta de 1 producto. |
| 1 unidades de SKU; Operación: ObjectId | 1 unidad de Agua; stock resultante: 2 unidades. |
| Total: 58.9 PEN | Total: S/ 58.90 |
| Búsqueda única seguida de detalles repetidos | Solo la respuesta final; ambas skills permanecen en actividad/evidencia. |
| Pregunta de precio devuelve stock, mínimo y estado | Precio del producto, con dos decimales. |
| Solo hay 1 unidades disponibles | Solicitaste 3 unidades, pero solo hay 1 unidad disponible. |
| Todavía no envía avisos automáticos | Evaluación al cambiar stock, distribución automática; Telegram sujeto a conexión y preferencia. |

## Reglas de presentación

- Cantidades: `0 unidades`, `1 unidad`, `2 unidades`; productos, coincidencias y registros usan singular solo para 1.
- Dinero PEN: `S/ 29.45`, `S/ 58.90`, `S/ 9.00`. Otras monedas conservan su código; no se mezclan ni convierten.
- Nombre humano primero en detalles de producto; SKU secundario útil para identificarlo.
- Precio, mínimo, estado y stock responden al atributo solicitado usando la misma skill. Solicitar detalles conserva la respuesta completa.
- IDs internos permanecen en contratos internos, historial y correlación; se omiten de la respuesta principal y tarjeta de resultado.
- Las tarjetas de resultado no repiten todo el preview anterior. La actividad académica sigue visible.
- El backend conserva listas textuales como fallback. La UI omite solo líneas que ya representa con suggestions clicables. No cambia mensajes de selección, ordinales, paginación ni restauración.
- Los precios de proveedores siguen siendo precios configurados, no cotizaciones confirmadas.

## Preguntas sobre PendingAction

Desde un preview vigente, «¿cuál es el precio?», «¿está bien el precio?», «¿cuánto quedará?», «¿cuánto pagaré?», «¿cuántas unidades son?» y «¿qué proveedor elegí?» pueden responder desde los campos/items congelados.

Ejemplo: «Precio configurado de S/ 29.45 por unidad; 2 unidades por S/ 58.90. La operación sigue pendiente y no se ha ejecutado». No se afirma que el precio sea apropiado ni se ejecuta/recalcula la operación.

Si falta el dato, se indica la limitación. Si el preview venció, no se presenta como vigente. La respuesta no habilita un «sí» corto como confirmación inmediata: se preservan las reglas P2D. Una nueva lectura mantiene su prioridad y no queda capturada por preguntas sobre el preview anterior.

La alternativa ante stock insuficiente se rotula «Preparar venta de 1 unidad». Solo una selección explícita cambia la cantidad y prepara otro preview; nunca confirma.

## Validación y smoke manual

Las suites cubren atributos/follow-ups, respuesta única, unidades/dinero, IDs ocultos, preguntas sin ejecución, prioridad READ, alternativa de stock, cards y fallback textual. Se ejecutan backend completo, frontend, tipos, build, sintaxis y lint focal.

Después de publicar en una fase cloud independiente:

1. Preguntar precio, stock, mínimo y estado de `food 96`; revisar brevedad y 0 LLM/0 tokens. Pedir detalles y comprobar respuesta completa.
2. Preparar una venta pequeña sin confirmar. Preguntar precio, total, cantidad y stock resultante; comprobar que sigue pendiente y no hay ejecución. Cancelar manualmente.
3. Revisar una venta/compra ya registrada: nombre humano, singular/plural, importes y ausencia de IDs internos.
4. Consultar un producto ambiguo y usar su opción clicable; comprobar lista visible una sola vez, selección y follow-up.
5. Revisar preview de regla sin confirmar: evaluación automática futura y Telegram condicionado a conexión/preferencia.
6. Ante stock insuficiente, comprobar cantidad solicitada explícita y CTA alternativa que solo prepara preview.

No se ejecutan escrituras cloud en esta fase local ni se consume Gemini real.

## Resultado local

- Focales: 588/588; backend completo: 1052/1052 (26 pruebas nuevas).
- Frontend Vitest: 98/98 (4 pruebas nuevas); seguridad: 12/12; helpers ML: 8/8.
- TypeScript, build, lint focal y sintaxis de 13 archivos JS: OK.
- Diff normal y staged revisados antes del commit. Sin push.

## Archivos de la fase

- Backend: `src/utils/assistantFormatting.js`; `src/agents/responses.js`, `orchestrator.js`, `forecastResponses.js`, `productListFollowups.js`; `src/automations/assistant.js`, `actionInput.js`, `executors.js`.
- Tests backend: `test/agentResponses.test.js`, `agentOrchestrator.test.js`, `guidedActions.test.js`, `replenishmentPlanning.test.js`, `stockAlertRules.test.js`.
- Frontend: `src/lib/assistantPresentation.ts`; `src/components/assistant/PendingActionCard.tsx`; `src/app/assistant/page.tsx`; `test/assistant.actions.test.tsx`, `assistant.component.test.tsx`.
- Documentación: `docs/CONV-POLISH-P3A.md`.
