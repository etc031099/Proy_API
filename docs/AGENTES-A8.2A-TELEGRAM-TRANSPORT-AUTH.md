# A.8.2A — Autorización y transporte durable Telegram

Fecha de cierre: 22/10/2026. Implementación local/mocks. No se configuró Telegram/Render ni se escribió en Mongo local/cloud.

## Alcance y frontera

Esta fase cierra la conversación legacy no autorizada y construye autorización, ingress, binding, receipts y recuperación. No activa consultas del asistente, callbacks, Operations ni grounded por Telegram.

El webhook devuelve ACK JSON, no un mensaje comercial al chat. El procesamiento termina en `COMPLETED / CHANNEL_NOT_READY` después de asegurar una conversación vacía. No guarda el texto entrante para ejecutarlo posteriormente: los mensajes recibidos durante esta fase **no se reproducirán como consultas/operaciones al habilitar A.8.2B**. No se llama a handle(), LLM, skills, proveedores ni APIs Telegram.

El wrapper compartido conserva su comportamiento web. El adaptador Telegram posterior usa una capacidad de servidor `readOnly`; el canal nunca se selecciona desde el body de una solicitud. Las escrituras quedan bloqueadas antes de resolver entidades o preparar PendingAction.

## 1. Cierre de S1 y convivencia con notificaciones

- `telegramService.js` deja de emitir `telegram.command` para cualquier chat. No hay fallback al login fijo.
- `node-red/lib/webhook-security.js` elimina ese evento del allowlist, incluso con el secreto del puente correcto. Los nodos legacy `tg_parse`, `tg_login_req`, `tg_route` permanecen como código no accesible mediante ese evento admitido; no se crea otro parser.
- `tg_menu_prep` devuelve null antes de leer token/construir setMyCommands. No se registra menú nuevo.
- `transaction.created`, `product.low_stock`, `inventory.alert.opened/resolved`, sus receipts y entregas permanecen.
- TelegramConnection, preferencias, low-stock y callbacks post-commit conservan su contrato. No se reutilizan BILLING_EMAIL/BILLING_PASSWORD para autenticar al usuario Telegram.

**Cambio operacional deliberado:** polling apagado por defecto. Para el consumidor antiguo de códigos de conexión/transferencia se exige `TELEGRAM_UPDATES_MODE=legacy_polling` y asistente apagado. Ese modo ya no responde consultas comerciales legacy, solo conserva start/pairing/recovery existentes. El modo webhook nunca arranca getUpdates. No hay cambio de transporte automático.

El nuevo webhook A.8.2A rechaza comandos, incluidos start/transfer, y no reemplaza todavía el transporte de pairing/recovery. Por eso esta base **no es autorización para hacer el cutover cloud completo**. Antes del cutover, A.8.2B debe decidir y certificar cómo conservar esos flujos en el consumidor único; no mantener polling y webhook simultáneamente. Los envíos de notificaciones a destinos ya conectados son independientes y se conservan.

## 2. Configuración fail-closed

Configuración central: `backend/src/config/telegramAssistant.js`, validada también por `validateEnvironment` al arrancar. Valores de flags estrictos, sin coerción de strings arbitrarios.

| Variable | Contrato |
| --- | --- |
| `TELEGRAM_ASSISTANT_ENABLED` | Ausente/false: canal nuevo apagado. true exige modo webhook y configuración completa. |
| `TELEGRAM_UPDATES_MODE` | `disabled` por defecto; `webhook` solo con asistente habilitado; `legacy_polling` solo con asistente apagado. |
| `TELEGRAM_ASSISTANT_OPERATIONS_ENABLED` | Ausente/false. true se rechaza en A.8.2A; no existe posibilidad de habilitar writes por configuración accidental. |
| `TELEGRAM_WEBHOOK_SECRET` | Dedicado, 32–256 caracteres del alfabeto Bot API permitido; distinto del token del bot y del secreto Node-RED. |
| `TELEGRAM_ASSISTANT_BINDINGS` | JSON de 1–20 vínculos explícitos. Chat y negocio no se repiten. |
| `TELEGRAM_BOT_TOKEN` | Configuración existente exigida para activar webhook; no se usa para efectuar llamadas en esta fase. |

Forma de cada vínculo, con valores reales proporcionados administrativamente, nunca desde Telegram:

```json
{
  "telegramUserId": "<ID privado decimal>",
  "chatId": "<mismo ID privado decimal>",
  "systemUserId": "<ObjectId de usuario existente>",
  "businessId": "<negocio de ese usuario>",
  "bindingGeneration": 1
}
```

Los placeholders son ilustrativos y no constituyen configuración válida. No hay valores secretos en este documento. No se modificó ningún .env.

## 3. Autorización y binding

Orden: secreto HTTP → shape/tipo de update → coincidencia con allowlist → cargar User real → validar isActive, rol admin/user, ObjectId y businessId → verificar índices → admisión durable.

Solo texto de chat privado humano, `from.id === chat.id`, IDs positivos seguros, message_id válido y texto de hasta 2000 caracteres. Grupos, canales, callbacks, media, mensajes reenviados/via bot y comandos no se procesan. Username/displayName no autorizan. Identidad/rol/canal/negocio agregados al payload no alteran el scope interno.

Un chat no autorizado se rechaza antes de leer User, binding, historia comercial o provider. Un usuario desactivado o negocio incorrecto se rechaza antes de admitir el receipt. El usuario se vuelve a validar durante recuperación dentro de la sesión de Mongo. Errores DB no se convierten en autorización.

Se crea `TelegramAssistantBinding` separado de TelegramConnection porque destino transferible de alertas y actor conversacional revocable tienen distintos ciclos de vida. No se cambia la cardinalidad de notificaciones ni se crea otro historial.

Campos: chatId, telegramUserId, systemUserId, businessId, conversationId UUIDv4, bindingGeneration, active, nextSequence, processingVersion, createdAt/updatedAt.

Un chat por negocio y una conversación por binding. Configuración distinta de la identidad/generación ya guardada o active=false se rechaza; no se adopta silenciosamente otro usuario ni se reactiva un vínculo. Revocación lógica: quitar la tupla detiene admisión/procesamiento autorizado; marcar active=false mantiene el bloqueo aunque reaparezca la misma configuración. No se proporciona un endpoint de reactivación/relink en esta fase. Un futuro procedimiento administrativo deberá preservar metadata, incrementar generación y asignar una conversación nueva.

La conversación usa AgentConversation mediante `ensureTransportConversation`, sin mensajes, título derivado del usuario ni segundo historial. No adopta una conversación web. Se exige el scope real del usuario/negocio y UUID guardado en binding.

## 4. Ingress

`POST /api/telegram/webhook`, separado del router `/api/telegram` que sigue usando JWT y checkBusinessAccess.

- Montado antes del parser general de 10 MB; no elude la seguridad de rutas de integración.
- Header `X-Telegram-Bot-Api-Secret-Token`; comparación timing-safe de digests de longitud fija.
- Content-Type application/json, sin query; Content-Encoding comprimido rechazado.
- Parser de 16 KiB estricto y sin inflate. Secret/config se validan antes de parsear body.
- Rate limit local al ingress: 120 requests/minuto/IP, además del global existente; no se alteró trust proxy.
- Sin JWT web, secreto Node-RED ni identidad fabricada.

Respuestas: 200 solo después de persistir o encontrar un receipt equivalente; devuelve success/status/duplicate, sin IDs internos. 401 secreto inválido; 403 actor/binding no autorizado; 400 update no soportado/JSON inválido; 413 exceso de tamaño; 415 tipo/encoding incorrecto; 409 ID repetido con contenido distinto; 503 configuración/DB/índices no disponibles. Errores crudos no se devuelven.

Updates no soportados no generan receipts ni se envían al runtime. Telegram puede reintentar respuestas no exitosas: A.8.2B debe certificar la política de ACK para tipos ignorados al fijar allowed_updates del webhook. Aquí no se llamó setWebhook.

## 5. Receipts, concurrencia y restart

`TelegramUpdateReceipt` guarda updateId, requestKey UUIDv4 estable, bindingId, generación, sequence, fingerprint de colisión, estado y timestamps/resultCode. No almacena texto, update bruto, clientes, argumentos de acciones, tokens ni respuestas comerciales.

El fingerprint compara chat/actor/message_id/text solo para detectar reutilización incompatible de updateId; no se imprime ni autoriza. Un update duplicado devuelve el mismo requestKey/estado y no agrega otro receipt. No se descartan IDs menores que un último ID visto.

Admisión: transacción snapshot + majority. Creación de binding con índices únicos; incremento de secuencia y creación de receipt atómicos. Carrera inicial duplicate-key: un reintento de la transacción completa, nunca actualización arbitraria de identidad.

Procesamiento: una transacción corta toca `processingVersion` del binding, toma el receipt pendiente de menor secuencia, valida usuario/binding/generación, asegura la conversación y completa. La escritura compartida serializa el chat mediante conflictos de escritura y reintentos del driver. No hay lock en memoria usado como garantía durable ni lease que pueda vencer durante trabajo externo.

`PROCESSING` es transición dentro de esa misma transacción; no queda comprometido separadamente. Si el proceso muere antes del commit, se conserva RECEIVED y se revierten las escrituras de metadata; si el commit terminó, se ve COMPLETED. Esto es adecuado exclusivamente porque el trabajo de A.8.2A es corto e idempotente y no tiene llamadas externas. Errores de autorización terminales quedan FAILED con código sanitizado; fallo transitorio DB deja RECEIVED para reintentar.

Recuperación: al arrancar, y cada 5 segundos, examina como máximo 20 RECEIVED ordenados por secuencia. Es recuperación de DB, **no otro consumidor getUpdates**. Hay un guard local para evitar ticks superpuestos; la seguridad entre procesos proviene de Mongo. El timer solo arranca si el canal está habilitado, después del startup DB sano; los fallos de quota de startup no lo arrancan. Commit con maxCommitTimeMS=5000. Logs de error solo event/channel, sin payloads.

No se reclama exactamente-una-vez para futuros efectos externos. A.8.2B debe diseñar admisión del mensaje real a AgentConversationMessage, estado de generación incierta, claim/fencing y entrega antes de permitir LLM/skills. No meter provider/Telegram HTTP dentro de estas transacciones ni añadir un simple Promise tras ACK.

## 6. Schemas e índices

Ambos modelos nuevos usan autoCreate=false, autoIndex=false y strict=throw. No hay migración automática de históricos ni creación automática de índices desde HTTP/startup.

| Colección/modelo | Índice | Campos | Unique |
| --- | --- | --- | --- |
| TelegramAssistantBinding | telegram_assistant_chat_unique | chatId | Sí |
| TelegramAssistantBinding | telegram_assistant_business_unique | businessId | Sí |
| TelegramAssistantBinding | telegram_assistant_conversation_unique | conversationId | Sí |
| TelegramUpdateReceipt | telegram_update_unique | updateId | Sí |
| TelegramUpdateReceipt | telegram_request_unique | requestKey | Sí |
| TelegramUpdateReceipt | telegram_binding_sequence_unique | bindingId, sequence | Sí |
| TelegramUpdateReceipt | telegram_receipt_recovery | status, sequence, _id | No |

Sin partialFilterExpression ni TTL. Eliminar receipts automáticamente permitiría readmitir updates antiguos; retención/presupuesto de volumen queda para una política explícita posterior. Versión inicial presupone un bot por database; cambiar bot requiere procedimiento que no mezcle namespaces de update_id.

La admisión verifica además los índices declarados de AgentConversation existente. Si falta colección/índice, 503 fail-closed. No se llama syncIndexes/dropIndexes.

`provisionTelegramTransportIndexes()` y `verifyTelegramTransportIndexes()` son funciones administrativas explícitas, no conectadas al startup ni a HTTP. `node backend/scripts/provision-telegram-transport-indexes.js` añade los índices declarados y los verifica; equivalentes no se duplican y conflictos se rechazan sin borrar índices. El operador debe seleccionar y verificar manualmente la base antes de ejecutar el script. No se ejecutó contra ninguna DB. La provisión necesita permiso de escritura administrativa; no es una verificación read-only.

## 7. Asistente web y canal Telegram

La ruta web conserva el contexto `assistant` por defecto. El asistente de Telegram se crea con `readOnly: true` en una factoría del servidor; el historial durable del transporte se activa con `durableTransport: true`. Ninguna opción se lee del body. Telegram no dispone de actionService ni de endpoints de confirmación.

No se amplió la confianza de createActionContext ni se cambió repository/gateway de acciones. Telegram permanece bloqueado antes de resolver/preparar/confirmar acciones, incluso si se intenta configurar Operations=true. No se alteraron especialistas, ML/BI, provider, frontend ni ejecución transaccional comercial.

## 8. Validación

Se ejecutan tests del repository productivo con modelos/sesiones in-memory, no una suite contra replica set real. La simulación verifica rollback/orden/duplicados, pero no certifica latencias, elecciones de PRIMARY ni WriteConflict reales de Atlas. No se realizaron conexiones Mongo.

Cobertura nueva: flags/config, secreto/content-type/tamaño, ACK posterior a admisión, actores privados/allowlist, usuario desactivado/tenant/rol, payload sin autoridad, binding revocado/generación, dedupe/fingerprint, secuencia concurrente/IDs fuera de orden, restart/rollback, índices/ausencia de TTL, historial durable, gate sin PendingAction y cierre legacy.

Regresiones: Telegram existentes/notifier/recovery, gateway automations, agentHistory, agentMessages, env/databaseStartup, Operations multi-producto y Node-RED seguridad/alertas. Los tests HTTP usan únicamente loopback y mocks. No hubo API Telegram, providers o Mongo reales.

Resultado final: **230/230 backend PASS** (incluye 16 tests nuevos del canal), **39/39 Node-RED PASS** y syntax de **19 archivos JS PASS**. La primera ejecución sandbox bloqueó seis pruebas HTTP por EACCES en 127.0.0.1; se repitieron fuera del sandbox con permiso de loopback y pasaron. No eran fallos funcionales. git diff --check PASS; también se revisan los archivos nuevos no rastreados. No se ejecutó build ni se cambió frontend.

Comandos de validación desde backend:

```powershell
node --test --test-reporter=spec test/telegramAssistantTransport.test.js test/telegramRecovery.test.js test/telegramPreferences.test.js test/telegramLowStock.test.js test/telegramLowStockCallers.test.js test/telegramAssistantSale.test.js test/webhookService.test.js test/inventoryAlertChannels.test.js test/automations.test.js test/agentHistory.test.js
node --test --test-reporter=spec test/env.test.js test/databaseStartup.test.js test/operationsMultiProduct.test.js test/agentMessages.test.js
```

Desde node-red: `node test/run.js`. Syntax de todos los JS tocados y git diff --check. El runner backend oficial incorpora la nueva suite; no se ejecutó toda su lista ni se corrigieron fallos históricos fuera de alcance.

## 9. Procedimiento futuro cloud — NO EJECUTADO / NO AUTORIZADO AHORA

1. Revisar/publicar cambios solo con autorización posterior. Mantener asistente y Operations apagados; no activar webhook al desplegar esta base.
2. Provisionar los índices nuevos administrativamente, con URI/DB verificadas fuera del payload HTTP; revisar equivalencia antes de añadir. Verificar índices de AgentConversation. No modificar TelegramConnection ni datos comerciales.
3. Configurar tuplas de usuarios reales y generaciones; comprobar cada User activo/tenant/rol sin publicar sus datos. Guardar un secreto Bot API dedicado. Mantener Operations=false.
4. Certificar en A.8.2B el mensaje real, historia, callbacks y continuidad de pairing/recovery. Esa fase también debe añadir pruebas replica-set desechables si se quiere certificar el comportamiento real del driver bajo concurrencia.
5. Coordinar Node-RED/backend: retirar conversación y dueño de menú legacy, conservar alert delivery/receipts. No registrar menú nuevo en paralelo.
6. Detener getUpdates antes de configurar un único webhook HTTPS; nunca activar ambos. Configurar allowed_updates solo para los tipos certificados, usando herramientas administrativas seguras. Esta fase no incluye comando que contenga bot token ni ejecuta setWebhook/deleteWebhook.
7. Solo después de autorización de smoke: activar flag y modo webhook, verificar rechazo de usuario ajeno y admisión/dedupe del usuario autorizado. Lecturas/Operations se habilitan únicamente según gates de fases siguientes.

Si se necesita hoy conectar/recuperar notificaciones con el código existente, usar exclusivamente legacy_polling con asistente apagado, no simular que el webhook A.8.2A ya ofrece esa funcionalidad. No hay fallback al puente comercial inseguro.

## 10. Archivos y cierre

Nuevos: config/telegramAssistant; modelos TelegramAssistantBinding/TelegramUpdateReceipt; routes/telegramWebhook; servicios telegramAssistantTransport/telegramTransportRepository/telegramTransportIndexes; test/telegramAssistantTransport; este documento.

Modificados: app, config/env, automations/assistant, agentConversationService, agentHistoryRepository, telegramService, test/run, test/telegramRecovery; Node-RED flows, webhook-security y sus tests de seguridad.

Se preserva entrega-tutoria-bullying/. Sin stage, commit, push, deploy, variables cloud ni escrituras Mongo. Estado: base A.8.2A implementada para validación local; canal comercial y cutover cloud pendientes de A.8.2B.
