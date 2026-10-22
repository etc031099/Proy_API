# A.8.2B Ã¢â‚¬â€ Telegram multiagente read-only

Fecha: 22/10/2026. Cambios locales, sin setWebhook, llamadas Telegram reales, cambios Render, conexiones Mongo ni escrituras cloud.

## Pipeline y alcance

```text
Webhook A.8.2A Ã¢â€ â€™ autorizaciÃƒÂ³n existente Ã¢â€ â€™ binding/receipt
 Ã¢â€ â€™ AgentConversationMessage queued (misma transacciÃƒÂ³n de admisiÃƒÂ³n)
 Ã¢â€ â€™ claim corto por binding Ã¢â€ â€™ commit INVOKING
 Ã¢â€ â€™ AgentConversationService.send(requestKey estable)
 Ã¢â€ â€™ withActionAssistant(readOnly=true, capacidad de servidor)
 Ã¢â€ â€™ mismo createAgentOrchestrator / Coordinator / especialistas / NLU / grounded
 Ã¢â€ â€™ historial y contexto durables Ã¢â€ â€™ formatter Ã¢â€ â€™ envÃƒÂ­o Telegram
```

No hay router de intenciÃƒÂ³n, resolver, skill, dataset ni provider Telegram. El adapter solo interpreta protocolo de transporte y comandos de canal explÃƒÂ­citos. Las consultas de negocio se pasan al motor existente. No se utilizan CRUD/login fijo de Node-RED.

La configuraciÃƒÂ³n sigue fail-closed y apagada por defecto. Para habilitar lecturas se exige ademÃƒÂ¡s el master `AGENT_ENABLED=true`; Operations=true continÃƒÂºa siendo configuraciÃƒÂ³n invÃƒÂ¡lida. No se modificÃƒÂ³ ninguna variable real.

## ConversaciÃƒÂ³n y privacidad

- Binding conserva usuario real, negocio, chat/actor privado, generaciÃƒÂ³n y conversaciÃƒÂ³n propia, sin adoptar conversaciÃƒÂ³n web.
- El texto admitido se guarda **una vez** en AgentConversationMessage, estado interno queued. Receipt y binding no contienen otro historial ni payload comercial.
- `enqueueTransportMessage` utiliza el mismo servicio/repositorio de historial y participa de la transacciÃƒÂ³n corta de admisiÃƒÂ³n. Si falla, no hay ACK de ÃƒÂ©xito ni receipt huÃƒÂ©rfano sin mensaje.
- `send` cambia queued Ã¢â€ â€™ pending por CAS, ejecuta el runtime y completa el mismo par user/assistant y contexto. El requestKey no cambia por retries.
- Antes de cada turno Telegram se olvida la cachÃƒÂ© local de esa conversaciÃƒÂ³n y se restaura el contexto durable. Evita adoptar estado antiguo si el turno previo lo procesÃƒÂ³ otra instancia.
- La API de historial sigue proyectando queued como pending; no exige modificar frontend web.
- La cola reserva una respuesta por turno en queuedResponseCount interno. AdmisiÃƒÂ³n/completado respetan el lÃƒÂ­mite existente de 400 mensajes incluso con varios turnos admitidos; no se publica ese contador ni se hace una migraciÃƒÂ³n cloud.
- Usuarios desactivados, tenants incorrectos, chats no autorizados y generaciones revocadas no alcanzan el motor. Se revalida identidad antes del procesamiento y antes de cada envÃƒÂ­o.

## Claims, orden y recuperaciÃƒÂ³n

Se extienden los receipts existentes; no hay segundo transporte/broker. Binding.activeReceiptId serializa un chat. La secuencia de admisiÃƒÂ³n conserva el orden local; no se usa update_id Ã¢â€°Â¤ lastSeen. Se toma una sola cabecera de cola por binding, hasta 20 por tick, para que un chat bloqueado no monopolice el lote y los otros negocios avancen independientemente.

Claim con ownerToken aleatorio y lease de 120 segundos; CAS/transacciones snapshot+majority cortas. No hay provider, skill o HTTP dentro de una transacciÃƒÂ³n. `INVOKING` se compromete **antes** de llamar al servicio conversacional.

PolÃƒÂ­tica de restart/retry:

| SituaciÃƒÂ³n durable | PolÃƒÂ­tica |
| --- | --- |
| RECEIVED / mensaje queued | Puede reclamar y ejecutar una vez. |
| Claim vencido sin INVOKING | Otro owner puede reclamar; el anterior ya no puede iniciar. |
| INVOKING con historia pendiente o ausente/incierta | UNCERTAIN; no vuelve a generar ni libera el chat para cruzar contexto. |
| INVOKING con respuesta y contexto completados en historial | Recupera esa respuesta, sin repetir LLM/skills. |
| Error conocido con historia failed | FAILED; no retry automÃƒÂ¡tico de generaciÃƒÂ³n. |
| OUTPUT_READY antes de un envÃƒÂ­o | Recupera salida guardada en el historial y botones durables. |
| EnvÃƒÂ­o en curso sin confirmaciÃƒÂ³n durable | DELIVERY_UNKNOWN; no reenvÃƒÂ­o automÃƒÂ¡tico. |
| COMPLETED | Retry Telegram solo devuelve admisiÃƒÂ³n duplicada, sin otro mensaje o ejecuciÃƒÂ³n. |

El vencimiento del lease **no** autoriza repetir una inferencia iniciada. Si el worker original sigue vivo, puede terminar; nadie adopta esa inferencia. Un resultado incierto necesita reconciliaciÃƒÂ³n desde historial o intervenciÃƒÂ³n administrativa posterior. Se sacrifica disponibilidad antes que repetir una llamada posiblemente consumida.

Telegram no proporciona una idempotency key de sendMessage en este cliente. No se promete entrega exactamente una vez: si la red cae tras aceptar el mensaje, DELIVERY_UNKNOWN puede significar entregado o no entregado. No se duplica por retry automÃƒÂ¡tico. Una operaciÃƒÂ³n futura debe diseÃƒÂ±ar explÃƒÂ­citamente cÃƒÂ³mo se presenta/revisa esa incertidumbre, no eliminar este fence.

## Formatter

`telegramFormatter.js`: texto plano, sin parse_mode HTML/Markdown, tablas JSX ni copia del frontend. Conserva answer, notas pÃƒÂºblicas de v3Views y advertencias textuales sin duplicarlas, estados unavailable/PARTIAL/NOT_EVALUABLE y cifras de la respuesta existente. No calcula mÃƒÂ©tricas ni convierte missing a cero.

Divide por saltos de lÃƒÂ­nea/espacios a 3500 unidades UTF-16 como mÃƒÂ¡ximo, sin separar pares surrogate ni descartar caracteres. MÃƒÂ¡ximo 20 partes; si se supera, falla cerrado antes de enviar, no trunca advertencias. Solo la ÃƒÂºltima parte lleva teclado. Los tokens generados para el teclado se guardan antes del envÃƒÂ­o y se vinculan al message_id devuelto.

No se imprime contenido del usuario, respuesta, secretos ni callback_data. El cliente Bot API existente conserva timeout, redirecciones bloqueadas, errores sanitizados y fencing de efectos externos ML Test. Se aÃƒÂ±adiÃƒÂ³ ÃƒÂºnicamente el wrapper fijo answerCallbackQuery.

## Callback store y validaciÃƒÂ³n

Nuevo modelo pequeÃƒÂ±o `TelegramCallbackToken`, no un historial:

- token aleatorio `t1:` + 128 bits base64url; 25 bytes, sin SKU/IDs/negocio/precios en callback_data;
- binding, actor/chat, usuario/negocio, conversaciÃƒÂ³n, sourceChannel=telegram, generaciÃƒÂ³n;
- keyboardRequestKey, purpose, posiciÃƒÂ³n/label, selecciÃƒÂ³n ya proporcionada por el servidor;
- expiresAt contractual, messageId y consumedRequestKey.

ÃƒÂndices explÃƒÂ­citos: token ÃƒÂºnico, bÃƒÂºsqueda por keyboardRequestKey+bindingId y TTL expiresAt. El TTL solo limpia teclados expirados, nunca receipts/historia. No se provisionÃƒÂ³ ningÃƒÂºn ÃƒÂ­ndice real; se extiende el helper aditivo existente. La admisiÃƒÂ³n verifica tambiÃƒÂ©n los ÃƒÂ­ndices del historial de mensajes y callback store; faltantes Ã¢â€ â€™ fail-closed.

ValidaciÃƒÂ³n del callback: secreto/shape Ã¢â€ â€™ chat privado y from correspondiente Ã¢â€ â€™ allowlist/usuario activo Ã¢â€ â€™ binding/generaciÃƒÂ³n Ã¢â€ â€™ token y propÃƒÂ³sito cerrado Ã¢â€ â€™ misma conversaciÃƒÂ³n y mensaje Ã¢â€ â€™ expiraciÃƒÂ³n Ã¢â€ â€™ teclado vigente/no consumido. callback_data no autoriza nada por sÃƒÂ­ solo.

Consumir token, reclamar generaciÃƒÂ³n de teclado, crear receipt y encolar selecciÃƒÂ³n ocurren atÃƒÂ³micamente. Un segundo click del mismo token devuelve el requestKey anterior; otro botÃƒÂ³n del teclado ya reclamado se rechaza. Tokens hermanos, antiguos, ajenos, manipulados o de otro message_id no llegan al motor. Si una pregunta encolada cambia el teclado antes de ejecutar el callback, este tambiÃƒÂ©n falla cerrado al reclamarlo.

answerCallbackQuery se ejecuta despuÃƒÂ©s de validar y admitir durablemente, sin llamada LLM. Reintentar ese ACK no repite la resoluciÃƒÂ³n. No hay callbacks de Operations/confirmaciÃƒÂ³n.

## SelecciÃƒÂ³n, paginaciÃƒÂ³n y continuidad

- Cada candidato usa la `suggestion.message` guardada del motor, no una intenciÃƒÂ³n inventada desde el label.
- Siguiente/anterior usan suggestionsPagination y los comandos de paginaciÃƒÂ³n que ya reconoce el motor. No se reconstruye bÃƒÂºsqueda ni se cambia horizonte/requestedIntent.
- Refinar indica que se escriba nombre/cÃƒÂ³digo mÃƒÂ¡s especÃƒÂ­fico y conserva el contexto pendiente. No crea un parser de refinamiento diferente al existente.
- Cancelar usa una primitiva interna acotada `clearReadSelection`: limpia selecciÃƒÂ³n de producto/proveedor y pending/ranking V3, sin borrar conversaciÃƒÂ³n, entidad seleccionada, otro draft ni PendingAction.
- Se prueba selecciÃƒÂ³n Coca-Cola Ã¢â€ â€™ Inventory Ã¢â€ â€™ Ã‚Â«esta en dos semanasÃ‚Â» Forecast Ã¢â€ â€™ reposiciÃƒÂ³n Inventory Ã¢â€ â€™ proveedor Procurement.
- La composiciÃƒÂ³n Inventory+Forecast conserva sus dos tareas despuÃƒÂ©s de una sola selecciÃƒÂ³n de producto.

## Grounded y seguridad conversacional

Se usa exactamente el grounded/provider/validator del Coordinator. Se conserva la telemetrÃƒÂ­a normal en el historial. No hay retry provider adicional por ser Telegram ni cambios al validator. Ver actividad se deja para A.8.4.

Out-of-scope, prompt injection y peticiÃƒÂ³n de API key se envÃƒÂ­an al guard existente. La capacidad read-only reutiliza actionIntent, saleNarrative, ambiguousMovement, actionDecision y writeClause existentes; no crea regex/intents de negocio Telegram. Una semanticAction propuesta por NLU tambiÃƒÂ©n se bloquea antes del gateway.

Venta, compra, registro o confirmaciÃƒÂ³n reciben Ã‚Â«Las operaciones desde Telegram todavÃƒÂ­a no estÃƒÂ¡n habilitadasÃ‚Â». No hay preview, actionId, PendingAction ni escritura operacional. Web conserva el comportamiento anterior.

## /start, /transfer y cutover

- `/start`, solo para usuario autorizado: informa autorizaciÃƒÂ³n y capacidad read-only. No crea privilegios.
- `/transfer`: respuesta informativa hacia Integraciones web; no consume challenges ni ejecuta recovery/transfer. El challenge escrito no se guarda en historial, solo el comando normalizado.
- La identidad administrativa/binding ya autorizada no depende de polling legacy. No se reactiva menÃƒÂº ni se llama setMyCommands.
- El servicio y rutas web de recuperaciÃƒÂ³n de notificaciones no se eliminan. Consumir un cÃƒÂ³digo TRF de notificaciones por chat todavÃƒÂ­a pertenece al procesador legacy, no al webhook nuevo; no se simula que una instrucciÃƒÂ³n web haya realizado la transferencia. Debe acordarse esa UX administrativa antes de una demo que necesite cambiar destinos de alertas.
- Mantener un solo consumidor: webhook futuro, polling apagado. Node-RED sigue cerrado para conversaciÃƒÂ³n y conserva alertas/receipts.

## ValidaciÃƒÂ³n y riesgos pendientes para A.8.3

Tests nuevos de transporte usan el repository productivo con modelos/transacciones in-memory y el AgentConversationService real. Tests de lectura usan el Coordinator real con servicios/provider simulados, no un bot alternativo. No certifican una elecciÃƒÂ³n de PRIMARY o WriteConflict real en Atlas.

Se cubren especialistas Inventory/Forecast/Sales/Customers/Procurement/Associations, botones, double-click, scope/actor/expiry/generaciÃƒÂ³n, paginaciÃƒÂ³n real y comandos, continuaciÃƒÂ³n/restart/composiciÃƒÂ³n, grounded mock con una llamada, guardrails, gates de writes, /start/transfer, chats de negocios distintos, inferencia incierta y envÃƒÂ­o ambiguo.

Antes de A.8.3: certificar estos estados bajo replica set desechable, polÃƒÂ­tica administrativa para UNCERTAIN/DELIVERY_UNKNOWN/revocar vÃƒÂ­nculos, retenciÃƒÂ³n/presupuesto de receipts e historial y lÃƒÂ­mites de coste por usuario del canal. No dar a Operations acceso a los callbacks de lectura ni permitir confirmar por label. El gate actual permanece OFF aunque se intente configurar true.

La comparaciÃƒÂ³n ampliada J4/J41/groundedJ2N/groundedJ2O ejecutÃƒÂ³ 652 tests: 620 PASS y 32 FAIL. Se repitiÃƒÂ³ la misma matriz cargando en memoria las versiones HEAD de orchestrator y action wrapper: mismos 620/32 y mismos tests fallidos, sin checkout ni modificar archivos. Esos tests no usan los cambios de transporte/historial. DistribuciÃƒÂ³n: J4=6, J41=2, groundedJ2N=23, groundedJ2O=1. Ejemplos de expectativas antiguas: tres dominios grounded y texto Ã‚Â«1, 7 o 14Ã‚Â» frente al contrato vigente de Ridge LIVE solo 7/14. No se modificaron esas suites ni el contrato para obtener verde. No se declara la suite ampliada completamente PASS.

Resultados de cierre: selecciÃƒÂ³n backend moderna **435/435 PASS**, incluyendo auth/transporte/lecturas Telegram, gateway, historial, routing/architecture closure, Inventory+Forecast, Procurement+Associations, configuraciÃƒÂ³n, startup y notificaciones/recovery. Frontend assistant (API/actions/history/component): **127/127 PASS**. Node-RED seguridad/alertas: **39/39 PASS**. Sintaxis de **20 archivos JS PASS**; git diff --check y revisiÃƒÂ³n de whitespace de archivos nuevos PASS. No build ni cambios frontend.

ReproducciÃƒÂ³n focal desde backend:

```powershell
node --test --test-reporter=spec test/telegramReads.test.js test/telegramAssistantTransport.test.js
```

RegresiÃƒÂ³n frontend desde frontend:

```powershell
npx.cmd vitest run --config vitest.config.ts test/assistant.actions.test.tsx test/assistant.api.test.ts test/assistant.history.test.tsx test/assistant.component.test.tsx
```

Node-RED: `node test/run.js`. Los tests HTTP requieren permiso para loopback local; no acceso a APIs externas. El runner oficial backend incluye telegramReads; no se ejecutÃƒÂ³ toda su lista ni se corrigieron los fallos histÃƒÂ³ricos ajenos.

Sin cambios a Operations, transactionWriteService, modelos ML, polÃƒÂ­ticas, provider/validator ni frontend web. Sin stage, commit, push o deploy; entrega-tutoria-bullying/ preservado.

## Port T2.1 en `telegram/a83-integration`

El portado conserva el contrato web actual: el asistente Telegram se construye con `readOnly: true` y el historial del transporte con `durableTransport: true`; ninguna capacidad se selecciona desde el body. El webhook usa parser JSON propio de 16 KB antes del parser general. `clearReadSelection` limpia ÃƒÂºnicamente selecciones de lectura.

VerificaciÃƒÂ³n local de este portado: transporte 16/16, lecturas 35/35, regresiÃƒÂ³n Telegram/historial/automations y operaciones 121/121; `node --check` en 21 archivos JS y `git diff --check` PASS. Sin Mongo local, credenciales, Telegram API, proveedor externo ni operaciÃƒÂ³n cloud. La suite integrada completa no se declara validada en esta tarea.

La provisiÃƒÂ³n explÃƒÂ­cita incluye ÃƒÂ­ndices de binding, receipts, callbacks y del historial AgentConversation. Se ejecuta solo por decisiÃƒÂ³n operativa con `node backend/scripts/provision-telegram-transport-indexes.js`; el portado no la ejecutÃƒÂ³ ni se conectÃƒÂ³ a una base de datos.

El cierre del transporte antiguo también retira `telegram.command` de la allowlist Node-RED y desactiva la publicación del menú conversacional; la vinculación de alertas y sus flujos de entrega permanecen. Suite Node-RED focal: 39/39 PASS.
