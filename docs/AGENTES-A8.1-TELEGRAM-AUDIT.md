# A.8.1 — Auditoría y diseño de Telegram multiagente

Fecha: 21/10/2026. Inspección del repositorio en HEAD `2031a07`.

## 1. Dictamen

Telegram existe como **notificador y bot conversacional legacy**. No existe todavía como canal del asistente multiagente web. El bot legacy consulta mediante Node-RED y una cuenta fija; no utiliza Coordinator, contexto conversacional ni Operations.

La extensión es viable reutilizando el motor actual, sin otro provider, parser, resolver ni pipeline de escritura. No es copiar el frontend: faltan identidad autorizada, estado durable del transporte, propagación del canal y callbacks seguros.

**NO LISTO para habilitar el nuevo canal.** Antes de exponer lecturas debe cerrarse el riesgo de autorización del puente legacy descrito en §4. No se inspeccionaron variables ni logs cloud: su exposición efectiva en producción no está confirmada.

Esta fase solo añade este documento. No ejecuta Telegram real, Mongo, entrenamiento, ventas, compras, checkpoint ni restore.

## 2. Inventario y arquitectura actual

### Backend e integraciones

| Archivo | Función real |
| --- | --- |
| `backend/src/services/telegramService.js` | Cliente Bot API con fetch; envío, códigos de conexión, notificación low-stock, procesador de mensajes y polling getUpdates. |
| `backend/src/routes/telegram.js` | Administración autenticada de conexión, preferencias y recuperación; no ingress Telegram. |
| `backend/src/controllers/telegramController.js` | Estado, generación de código, desconexión y preferencias del negocio autenticado. |
| `backend/src/controllers/telegramRecoveryController.js` | Inicio autenticado de transferencia de conexión. |
| `backend/src/services/telegramRecovery.js` | Challenge durable, transferencia transaccional, límites y auditoría. |
| `backend/src/models/TelegramConnection.js` | Un chat por negocio: destino y preferencias de notificación; no identidad conversacional. |
| `backend/src/models/TelegramConnectionTransfer.js` | Challenge, usuario destino, expiración y resultado de transferencia. |
| `backend/src/services/webhookService.js` | Publica eventos hacia Node-RED con secreto compartido. No recibe updates Bot API. |
| `backend/src/services/inventoryAlertChannels.js` | Entrega de alertas configurables, destinos, leases, reintentos y receipts. |
| `backend/src/models/InventoryAlertChannelDelivery.js` | Evidencia durable por canal/destino/evento. |
| `backend/src/routes/inventoryAlertDispatch.js` | Dispatch interno de alertas; no conversación. |
| `backend/src/app.js` | Monta integración y arranca polling dentro del startup protegido existente. |
| `backend/src/config/env.js` | Configuración existente; no autorización Telegram de usuario del asistente. |
| `backend/src/controllers/transactionController.js` | Notificación asociada a transacción después del commit. |
| `backend/src/controllers/productController.js` | Notificación asociada a stock después del commit. |
| `backend/src/automations/executors.js` | Notificador post-commit del action gateway. |
| `backend/src/services/transactionWriteService.js` | Escritura operacional compartida; no debe duplicarse para Telegram. |
| `node-red/flows.json` | Recepción de eventos, comandos legacy, login fijo, consultas, formato y sendMessage; también receipts de alertas. |
| `node-red/lib/webhook-security.js` | Secreto del puente y validación sintáctica de eventos/comandos. |
| `node-red/lib/settings-factory.js`, `node-red/settings.js` | Seguridad y configuración Node-RED. |
| `node-red/package.json`, `node-red/Dockerfile`, `node-red/render.yaml`, `node-red/README.md` | Dependencias, despliegue y documentación del puente. |
| `frontend/src/app/integrations/page.tsx` | UI de conexión/preferencias; no chat Telegram. |
| `frontend/src/components/TelegramConnectionRecovery.tsx` | UI de transferencia de destino. |
| `frontend/src/components/TelegramRulePreferences.tsx` | Preferencias de alertas. |
| `docs/M6.9I1-TELEGRAM-INTEGRATION.md` | Documenta la integración de alertas y su separación del chat legacy. |

Flujo de notificación:

```text
Operación confirmada → callback post-commit → notificador Telegram
Regla de inventario → outbox/delivery → Node-RED/receipt → Telegram
```

Una alerta fallida no revierte una operación ya confirmada. Low-stock utiliza el cruce del umbral mínimo, no equivale a una recomendación Ridge. Las alertas configurables tienen preferencias OPEN/RESOLVED, entrega durable y reintentos. El fencing local ML existente suprime efectos externos: debe preservarse.

Flujo conversacional legacy:

```text
Telegram → getUpdates backend → telegram.command → POST Node-RED /webhook
→ login con cuenta fija → consultas CRUD legacy → formatter → Telegram
```

Los comandos consultan stock/productos, ventas y deudas; no pasan por `/api/agent/messages`. El flujo de ventas usa una lista limitada, fecha UTC y formato propio: no debe convertirse en contrato BI/V3 por reutilización accidental. No hay registro conversacional de ventas/compras desde este recorrido.

### Rutas existentes

Todas las siguientes están bajo `authenticate` y `checkBusinessAccess`:

| Método | Ruta | Efecto |
| --- | --- | --- |
| GET | `/api/telegram/status` | Estado y preferencias, sin revelar secreto/chat. |
| POST | `/api/telegram/connect/code` | Genera código de vinculación de notificaciones. |
| DELETE | `/api/telegram/connection` | Desvincula destino. |
| PATCH | `/api/telegram/preferences` | Cambia preferencias booleanas permitidas. |
| POST | `/api/telegram/recovery/code` | Genera challenge de transferencia autenticado. |

Node-RED recibe `POST /webhook` con secreto compartido. **No es un webhook Bot API.** No existe en el backend un ingress HTTP Telegram, handler de `callback_query` ni InlineKeyboard conversacional.

### Transporte actual

`telegramService.js` mantiene `offset` en memoria, consulta getUpdates con `timeout:25` y `allowed_updates:['message']`, y usa timeout HTTP de 35 segundos para esa consulta. Avanza offset antes de terminar `processUpdate`; reprograma polling al segundo. No hay receipt durable de updates ni coordinación entre réplicas. El procesador exige mensaje de texto y no procesa callbacks.

Node-RED registra el menú legacy con setMyCommands al arrancar. Ese propietario del menú también debe retirarse/coordinase en la migración, no solo el parser.

## 3. Piezas reutilizables y límites

Reutilizar sin cambiar semántica:

- Coordinator/orchestrator, especialistas, routing determinístico, NLU fallback, resolvers y catálogo de skills.
- Grounded synthesis, DeepSeek, validator y telemetría actuales.
- Operations, preview, PendingAction, action repository, ejecución transaccional, idempotencia y post-commit.
- `AgentConversation`, `AgentConversationMessage`, contexto/pending selection y servicio de historial existentes.
- Cliente fetch Bot API, timeouts y protección de efectos externos; no hace falta SDK nuevo.
- Notificadores y receipt/outbox de alertas; no desmontarlos al retirar comandos legacy.

Archivos relevantes del núcleo: `backend/src/automations/{contracts,assistant,repository,execution,executors}.js`, `backend/src/services/{agentConversationService,agentHistoryRepository}.js`, modelos `PendingAction`, `AgentConversation` y `AgentConversationMessage`.

Adaptación mínima necesaria: constructor de contexto de canal, autorización Telegram, binding durable chat/conversación/update, formatter y callbacks. No reutilizar el login fijo, parser ni proyecciones comerciales legacy de Node-RED como asistente nuevo.

## 4. Seguridad: hallazgos y evidencia

### S1 — Alta: comando de chat sin vínculo autorizado llega a lectura con cuenta fija

Evidencia: `backend/src/services/telegramService.js`, procesador desde línea 113 y emisión de comandos alrededor de 161; `node-red/lib/webhook-security.js`, validación de comandos alrededor de 106; `node-red/flows.json`, nodos `tg_parse`, `tg_login_req`, `tg_route`.

El mensaje ordinario no consulta TelegramConnection antes de reenviar. El puente valida secreto, comando y forma del chat, no propiedad de negocio/usuario. Node-RED obtiene un token con BILLING_EMAIL/BILLING_PASSWORD y devuelve la lectura al chat recibido.

Reproducción offline con dependencias inyectadas y datos sintéticos:

```json
{"status":"REPRODUCED","connectionLookups":0,"unlinkedChatForwarded":true,"nodeRedAcceptsCommand":true,"fixedAccountReadPrepared":true,"requestsExecuted":0,"mongoWrites":0,"messagesSent":0}
```

Impacto condicionado a polling, puente, credenciales y conectividad habilitados: un usuario que contacte el bot podría solicitar lecturas de la cuenta fija. No se demostró explotación ni configuración cloud vigente. El secreto entre servidores no autoriza al usuario final.

Acción previa a activación: cerrar el recorrido legacy no autorizado y hacer que todo mensaje conversacional pase por vínculo de identidad. Conservar las ramas de notificaciones/receipts. No aplicado en A.8.1.

### S2 — Alta para el nuevo canal: vinculación de destino no equivale a identidad

TelegramConnection tiene businessId y chatId únicos, preferencias y código hash/expiración; no userId autorizado, Telegram actor ni conversationId. El código BILLING de seis dígitos y diez minutos sirve para destino, no para autorizar clientes, proveedores o writes. Su rama legacy tampoco exige las comprobaciones de chat privado/actor de la transferencia.

La recuperación sí verifica usuario activo, negocio, challenge durable, expiración, rate limits, chat privado humano y `from.id === chat.id`; utiliza transacción y auditoría. Es reutilizable como patrón, no como prueba de que cada comando esté autorizado. Un antiguo transfer USED no debe convertirse implícitamente en identidad actual.

### S3 — Media/alta antes de Operations: canal y entrega no están conectados

`contracts.js` admite `sourceChannel='telegram'`; PendingAction y repository lo incluyen en el scope. Sin embargo `automations/assistant.js:136` y `agentConversationService.js:100` construyen contexto sin canal explícito: cae en `assistant`.

No hay mapping durable de update Telegram a requestKey UUIDv4 ni recibos de callback. Offset en memoria y procesamiento fire-and-forget del puente no garantizan recuperación de entrega. Idempotencia de PendingAction protege la ejecución, pero no sustituye deduplicación de mensajes, selecciones o llamadas LLM.

## 5. Arquitectura elegida para diseñar A.8.2

```text
Telegram HTTPS update
 → ingress autenticado con secreto Bot API + límites de tamaño/tasa
 → identidad privada autorizada → usuario real activo + tenant/rol
 → binding durable de chat/conversación/update
 → mismo servicio conversacional + Coordinator
 → mismos especialistas / Operations / grounded
 → formatter Telegram + botones
```

### Autorización mínima recomendada

Para demo inicial: allowlist/configuración confiable del servidor con tuplas `(telegramUserId, chatId, systemUserId, businessId)`. Admitir solo chat privado humano y actor correspondiente. Cargar el usuario real en cada mensaje/callback; verificar isActive, rol, negocio y vigencia del vínculo. No confiar en username, nombre visible, IDs enviados en texto ni asignar admin artificialmente. No transportar contraseñas/JWT web por Telegram.

El request context se construye internamente desde el usuario cargado usando las primitivas actuales. La configuración no sustituye comprobar revocación del usuario. Desconexión/relink debe invalidar generaciones de botones y sesión. Rechazar grupos y usuarios desconocidos antes de leer negocio, usar LLM o preparar acciones.

La primera versión puede limitarse a un chat autorizado por negocio, coherente con los índices actuales de TelegramConnection. Varios chats por negocio requieren una decisión explícita de cardinalidad; hoy no están soportados por ese modelo.

### Contexto y persistencia

Reutilizar AgentConversation/contextSnapshot para contexto y selección pendiente; una conversación distinta de la web por binding Telegram. No compartir automáticamente la conversación web actual. Scope efectivo: usuario + negocio + conversación, unido al chat/actor/canal por el adapter.

Propuesta inicial: extensión acotada de TelegramConnection con metadata de sesión del transporte (conversationId, generación del binding y referencias/receipts de updates y teclados). No almacenar allí otro historial, prompts ni respuestas comerciales completas. Reutilizar AgentConversationMessage para el contenido.

El diseño de receipts debe admitir CAS/lease, requestKey UUIDv4 estable por update, reinicio y procesamiento serializado por chat. No descartar updates solo por ser inferiores al máximo visto ni expulsar receipts de writes inciertos. Si una estructura acotada en Connection no permite estas garantías, justificar una colección de transporte mínima, no un segundo modelo de asistente. Ese detalle es gate de A.8.2, no una garantía ya implementada.

Acusar entrega HTTP solo después de admisión durable o procesamiento seguro. No responder 200 y dejar una promesa en memoria como única garantía en Render. Recuperar trabajo admitido tras reinicio, con lease y deduplicación; no hace falta introducir otro broker.

Propagar sourceChannel mediante opción confiable de constructor, default `assistant`, al wrapper conversacional y a todos sus createActionContext, incluido historial/lectura de acción. El adapter Telegram fija `telegram`; el body del usuario nunca decide canal/actor/tenant. No alterar las comprobaciones actuales de repository.

## 6. Botones, selección y paginación

La API limita callback_data a 1–64 bytes. Webhook/getUpdates son excluyentes; los webhooks requieren HTTPS y admiten secret_token en un header específico. Telegram reintenta entregas no exitosas y conserva updates como máximo 24 horas. Debe contestarse answerCallbackQuery para cerrar el indicador del botón. Los mensajes de texto admiten hasta 4096 caracteres. Fuente: [Telegram Bot API](https://core.telegram.org/bots/api).

Usar callback opaco corto, por ejemplo `t1:<nonce aleatorio>`, no payload, argumentos, hashes ni credenciales. Resolver en servidor una referencia a:

- propósito, chat/actor, usuario real, negocio, conversationId y sourceChannel;
- generación del vínculo/teclado, mensaje, requestKey, expiración;
- candidato/página o pendingActionId correspondiente.

Un callback no es autorización. Revalidar identidad, mensaje accesible, estado y expiración. Tokens manipulados, de otro chat o teclado anterior no deben producir lectura sensible ni efecto. Responder al callback sin filtrar IDs internos.

Selección: convertir las sugerencias ya emitidas por el motor en botones y reenviar únicamente la selección guardada en servidor al mismo flujo. Conservar la tarea original y selección por línea. No reconstruir intents desde labels.

Paginación: reutilizar suggestionsPagination y mensajes/cursores existentes del motor; botones anterior/siguiente guardan contexto. No introducir un catálogo/parser paralelo ni inferir otros resultados.

Cancelar selección, borrador y PendingAction son propósitos distintos: validar el objetivo exacto, no enviar un cancelar genérico que afecte otra acción. Deshabilitar teclados consumidos como UX; la seguridad debe seguir estando en servidor.

## 7. Operations

Venta/compra multi-producto debe recorrer el mismo draft, selección por línea, proveedor común, cantidades, preview único, PendingAction y confirmación única. Nunca escribir desde el callback directamente ni bajar a single-item.

Mostrar todas las líneas/materiales del preview existente antes de habilitar Confirmar. Si se divide en varios mensajes, activar confirmación solo cuando se entregó el preview completo ligado a la misma acción. No ocultar cantidades/precios relevantes por truncamiento.

Confirmar/cancelar deben llamar al mismo action gateway con usuario, negocio, conversación y canal Telegram. Mantener CAS, expiry, idempotencia y transacciones. Una segunda confirmación de EXECUTED puede devolver el resultado guardado según contrato actual, **nunca volver a ejecutar**. Estados terminales, actions ajenas y expiradas no se reabren.

A.8.2 será lectura: gate de capacidad de canal antes de preparar writes, no un nuevo parser de intención. A.8.3 habilitará Operations solo después de certificar binding/callbacks. Ningún cambio en semántica de compra, stock, exchange rate ni deadline de A.5.3.

## 8. Grounded, actividad y formato

Las consultas abiertas usan el mismo Coordinator → especialistas → Analyst → DeepSeek → validator. No otra clave/provider ni retry LLM extra por adaptación del canal. Out-of-scope, prompt injection y solicitud de secretos conservan el comportamiento web.

Respuesta principal breve y fiel al requestedIntent: una consulta técnica de modelo no puede convertirse en tarjeta numérica sin respuesta directa. Preservar estados NOT_EVALUABLE/NO_TICKETS, unavailable, incertidumbre y límites de Ridge 7d/14d; no inventar 1d.

Botón opcional **Ver actividad**: proyectar telemetría ya guardada de esa respuesta, sin volver a ejecutar consulta/ML/LLM. Mostrar recorrido real, skills, estado de acción, duración y llamadas IA; provider/tokens/costo solo si ya disponibles y autorizados. Dato ausente no se presenta como cero. No prompts, payloads, headers, hashes ni IDs innecesarios.

Formatter: texto/listas, sin tablas complejas; texto plano inicialmente o HTML básico escapado. No interpretar Markdown/HTML del usuario o del LLM sin escape. Dividir por bloques lógicos conservando advertencias y preview íntegro; no copiar el frontend.

## 9. Webhook frente a polling

Elegido para producción futura: **webhook**, reutilizando fetch y el procesador común seguro. No implementar dos transports nuevos. El polling actual queda legacy y no puede seguir consumiendo updates cuando se active webhook.

Render Free puede suspender un web service tras 15 minutos sin tráfico entrante y su reactivación tarda aproximadamente un minuto; ver [documentación de Render](https://render.com/docs/free#spinning-down-on-idle). Por ello, como inferencia arquitectónica, polling saliente no es una solución fiable para despertar el servicio: webhook encaja mejor. No demuestra que haya ocurrido cold start en este entorno ni elimina latencias/reintentos.

Propuesta de ingress: `/api/telegram/webhook` **todavía inexistente**, montado separadamente de las rutas de integración con JWT. Autenticación de transporte Bot API y vínculo de usuario son controles distintos. Secreto dedicado, comparación segura, límites y rechazo fail-closed antes de efectos.

Cutover futuro: cerrar comandos legacy no autorizados; certificar adapter local; configurar webhook administrativamente; detener getUpdates; retirar `telegram.command` y registro de menú legacy de Node-RED; conservar notificaciones/outbox/receipts y verificar que no haya dos consumidores. No se ejecutó ninguna de estas acciones ahora.

## 10. Variables y dependencias

Nombres existentes; no se leyeron ni publicaron valores:

| Ámbito | Variables |
| --- | --- |
| Backend Telegram | `TELEGRAM_BOT_TOKEN` |
| Puente backend/Node-RED | `NODE_RED_WEBHOOK_URL`, `NODE_RED_WEBHOOK_SECRET` |
| Cuenta y API legacy Node-RED | `API_BASE`, `BILLING_EMAIL`, `BILLING_PASSWORD`, `TELEGRAM_BOT_TOKEN` |
| Seguridad/config Node-RED | `NODE_ENV`, `NODE_RED_ENVIRONMENT`, `NODE_RED_CREDENTIAL_SECRET`, `NODE_RED_HTTP_USERNAME`, `NODE_RED_HTTP_PASSWORD`, `NODE_RED_ENABLE_EDITOR`, `NODE_RED_ADMIN_USER`, `NODE_RED_ADMIN_PASSWORD_HASH` |
| Asistente existente, no duplicar | `AGENT_ENABLED`, `LLM_PROVIDER`, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` |

Propuestas **no existentes/no creadas**: `TELEGRAM_ASSISTANT_ENABLED` (default false), `TELEGRAM_WEBHOOK_SECRET` dedicado, `TELEGRAM_ASSISTANT_BINDINGS` (tuplas autorizadas), selector explícito de transporte como `TELEGRAM_UPDATES_MODE`, y gate por etapas `TELEGRAM_ASSISTANT_OPERATIONS_ENABLED` (default false). Validar nombres/shape en A.8.2 antes de implementación. No reutilizar el secreto Node-RED como autenticación Bot API.

No hay SDK Telegram que necesite migrarse. fetch del backend y nodos HTTP existentes son suficientes; solo faltan wrappers acotados para métodos como answerCallbackQuery/edición de teclado. No exponer un proxy de método o URL arbitraria. No se añadió dependencia.

## 11. Tests existentes y ejecución de auditoría

| Tests | Clasificación y alcance |
| --- | --- |
| `backend/test/telegramAssistantSale.test.js` | Venta por assistant + notificación post-commit. **No prueba venta solicitada desde Telegram.** |
| `backend/test/telegramLowStock.test.js` | Notificador, umbral, preferencias y fallos de entrega. |
| `backend/test/telegramLowStockCallers.test.js` | Callers y separación post-commit. |
| `backend/test/telegramPreferences.test.js` | Rutas/preferencias de notificaciones. |
| `backend/test/telegramRecovery.test.js` | Auth de transferencia, challenge, límites, scope, errores. |
| `backend/test/webhookService.test.js` | Puente emisor Node-RED; no webhook Bot API entrante. |
| `backend/test/inventoryAlertChannels.test.js` | Delivery/receipts/reintentos de alertas. |
| `backend/test/automations.test.js` | Gateway compartido: scope/canal, expiración, confirmación/cancelación/idempotencia. No callback Telegram. |
| `backend/test/integration/telegramRecovery.test.js`, `.run.js` | Transferencia transaccional en replica set desechable. No ejecutados: el runner prepara/elimina su DB aislada. |
| `node-red/test/flow-security.test.js`, `settings.test.js`, `webhook-security.test.js` | Seguridad de flujo/configuración/secreto y sintaxis. No vínculo real chat/usuario. |
| `node-red/test/inventory-alert-receipt.test.js`, `inventory-alert-channels.test.js` | Receipts y alertas. |
| `frontend/test/telegramRecovery.test.tsx`, `telegramPreferences.test.tsx` | UI web de integración, no bot conversacional. |

Resultados ejecutados con mocks/fixtures y HTTP local, sin Telegram/Mongo real:

- Siete suites backend Telegram/alertas/puente: **46/46 PASS**.
- `backend/test/automations.test.js`: **52/52 PASS**.
- `node-red/test/run.js`: **39/39 PASS**.
- Vitest focal de las dos UIs de integración: **9/9 PASS**.
- Reproducción S1: recorrido sin vínculo confirmado offline; cero requests ejecutadas, mensajes enviados o escrituras Mongo.

Comandos reproducibles (desde backend, node-red y frontend respectivamente):

```powershell
node --test --test-reporter=spec test/telegramAssistantSale.test.js test/telegramLowStock.test.js test/telegramLowStockCallers.test.js test/telegramPreferences.test.js test/telegramRecovery.test.js test/webhookService.test.js test/inventoryAlertChannels.test.js
node --test --test-reporter=spec test/automations.test.js
# Desde node-red
node test/run.js
# Desde frontend
npx.cmd vitest run --config vitest.config.ts test/telegramRecovery.test.tsx test/telegramPreferences.test.tsx
```

El runner backend usa lista explícita: incluye webhookService, inventoryAlertChannels, telegramPreferences y telegramRecovery; no incorpora explícitamente telegramAssistantSale, telegramLowStock ni telegramLowStockCallers. Se ejecutaron focalmente aquí; no se modificó el runner en esta auditoría.

Falta cobertura del canal nuevo: webhook Bot API, vínculo autorizado antes de lectura, callback manipulado/ajeno/viejo, reinicio/receipts, doble update, conversación cruzada, paginación, multi-producto desde bot, confirmación y grounded por Telegram. Que gateway y notifier pasen no certifica ese canal inexistente.

## 12. Fases recomendadas y gates

| Fase | Alcance mínimo | Complejidad | Criterio de salida |
| --- | --- | --- | --- |
| A.8.2A | Cerrar S1; identidad allowlist/usuario real, sourceChannel, ingress webhook y binding/receipts durables. | Alta | Usuario no autorizado no llega a datos ni provider; reinicio/doble update no duplican trabajo; web sigue intacta. |
| A.8.2B | Lecturas del mismo motor, contexto, selección/paginación y formatter con botones. | Media-alta | Mismas consultas y follow-ups que web, chats aislados, callbacks viejos/ajenos rechazados, writes aún bloqueados. |
| A.8.3 | Operations multi-producto, preview íntegro, confirm/cancel y post-commit. | Alta | Mismo actionId/gateway; solo una ejecución; compra/venta/proveedor por línea; expiry/scope/rollback preservados. |
| A.8.4 | Presentación/certificación grounded y actividad opcional. | Media | Mismo provider/validator; actividad no repite inference; sin exposición de secretos. No nuevo motor grounded. |
| A.8.5 | Smoke cloud controlado y guion docente. | Media | Usuario real autorizado, cutover único, consultas/selección/actividad certificadas; writes solo con autorización expresa de prueba. |

Archivos candidatos futuros: telegramService/routes/controller para transporte; contratos/assistant/agentConversationService para canal confiable; TelegramConnection o metadata de transporte justificada para binding; nuevo formatter/adaptador pequeño y tests. Node-RED solo para retirar conversación/menu legacy, preservando alertas. No hay motivo demostrado para tocar especialistas, ML/BI, provider, transactionWriteService ni frontend web.

En todas las fases: tests de usuario desactivado/tenant distinto; callback manipulado y de otro chat; doble confirmación; expiración; botones de draft reemplazado; injection/API key; intento de escribir sin confirmar; y regresiones del gateway y alertas. Pruebas de fallos/rollback con mocks o entorno local aislado, no sobre producción.

## 13. Riesgos residuales y cierre

- S1 sigue sin corregirse porque A.8.1 autoriza auditoría, no implementación funcional. No activar el canal sobre el puente legacy.
- La configuración cloud efectiva no fue verificada; no afirmar que está apagado ni que fue explotado.
- Receipts, leases, revocación y una sola identidad autorizada por binding son requisitos, no garantías presentes hoy.
- Webhook mejora encaje con Render Free, no promete respuesta instantánea ni entrega exactamente una vez.
- El vínculo de notificaciones no debe dar permisos implícitos sobre clientes/proveedores/Operations.
- Contexto compartido significa reutilizar el mismo sistema, no mezclar sin permiso conversaciones de chats/web.

Estado A.8.1: **AUDITORÍA COMPLETA / IMPLEMENTACIÓN DEL CANAL PENDIENTE**. Solo este archivo de documentación fue creado; `entrega-tutoria-bullying/` se preserva. Sin cambios de variables, dependencias o código funcional; sin stage, commit, push ni deploy.
