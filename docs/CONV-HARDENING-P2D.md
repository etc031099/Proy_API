# Confirmación y cancelación conversacional (P2D)

## Auditoría y política

Antes, `automations/assistant.js` detectaba únicamente si/confirmar/confirmo/hazlo/no/cancelar/cancelo/no lo hagas/mejor cancela eso. La decisión no distinguía una aprobación corta de una selección pendiente. Las consultas READ suspendían el draft y enviaban también futuras confirmaciones textuales al runtime READ.

Ahora `actionDecision.js` clasifica frases completas y acotadas; no hace fuzzy general. Las preguntas, negaciones y mezclas de instrucciones nunca ejecutan. `confirmationReady` en el draft indica que se acaba de mostrar un preview; las aprobaciones cortas necesitan esa marca, exactamente un PendingAction vigente, mismo ID activo y ausencia de selección/missing fields. La marca se conserva en el snapshot cerrado de OperationDraft.

| Tipo | Vocabulario |
|---|---|
| Confirmación explícita | confirmar, confirma, confirmalo/confírmalo, confirmo, sí confirmar/confirma/hazlo/procede, hazlo, procede, adelante, acepto, de acuerdo, ok confirma, correcto confirma |
| Aprobación corta, solo tras preview inequívoco | sí, ok, vale, correcto, dale |
| Cancelación | cancelar, cancela, cancelalo/cancélalo, cancelo, no lo hagas, mejor no, dejalo/déjalo, olvidalo/olvídalo, descarta, descártalo, anula, no quiero hacerlo, mejor cancela eso |
| Mantener pendiente | no, no todavía, no confirmes, no espera, todavía no, no quiero, no procede; preguntas sobre confirmar/precio/cliente y frases mixtas |
| Lenguaje mixto acotado | confirm, ok confirm, yes confirm, cancel, no cancel |
| Typos exactos | confimra, cansela |

La puntuación y los acentos se normalizan; un signo de pregunta impide tratar la expresión de aprobación como una confirmación. No se ejecuta cuando hay desambiguación de producto/proveedor/cliente ni cuando faltan datos. Las consultas READ normales siguen llegando al runtime de lectura.

## PendingAction, draft y botones

- PendingAction expira a los 10 minutos; OperationDraft a los 20. No se amplió ningún TTL. Un pending vencido o un draft vencido requiere preparar una operación nueva.
- Hay un draft activo por clave tenant + usuario + conversación. Mongo permite que coexistan varias acciones; `resolvePending` consulta hasta dos acciones del mismo tenant/usuario/canal/conversación. Una confirmación textual genérica exige una sola; no elige entre varias.
- Después de una nueva READ, la aprobación textual primero vuelve a mostrar el preview. Una selección READ activa conserva su prioridad. La tarjeta identifica explícitamente la acción por ID.
- Las correcciones cancelan el preview congelado anterior, revalidan y crean uno nuevo. Se preservan producto/cantidad/proveedor según el slot; las opciones de producto visibles se guardan de forma acotada para corregir una selección después del preview. Seleccionar nunca equivale a confirmar.
- Los botones Confirmar/Cancelar siguen usando `POST /api/agent/actions/:id/confirm|cancel`, con cuerpo cerrado y contexto autenticado. No se modificaron componentes frontend.
- El botón ya tiene un lock inmediato y estado busy. El wrapper serializa los turnos por conversación. El servicio/repositorio mantienen argumentos congelados/hash, transacción Mongo e idempotencia: repetir una confirmación de una acción ejecutada devuelve su resultado; no vuelve a ejecutar. No se añadieron retries de escritura.
- Tras éxito/cancelación, la confirmación textual informa que no hay operación pendiente. Cancelar después del éxito no revierte ventas/compras ni simula rollback.
- Cancelar limpia solo el draft WRITE asociado; no borra la memoria útil de lectura. Los límites de tenant, usuario, conversación y canal permanecen en el servicio/repositorio.

## Validación

Pruebas focales PendingAction/guidedActions/actionInput/orchestrator: 532/532. Backend completo: 1026/1026 (baseline 952; 74 casos nuevos). Incluyen venta, compra, creación de producto, regla de stock, preguntas, negaciones, cancelación, expiración, doble confirmación, nueva READ, desambiguación y cambios antes de confirmar. Las decisiones determinísticas reportan 0 LLM/0 tokens. Sintaxis de los cinco archivos JS y diff checks correctos. Frontend sin modificaciones; no fue necesario repetir sus suites ni usar Mongo/cloud para esta fase.

## Smoke cloud posterior

1. En tenant de pruebas, preparar una venta de 3 unidades de un SKU real sin confirmarla. Preguntar «¿está bien el precio?» y «no todavía»: debe seguir pendiente. «sí» después de la pregunta pide confirmación explícita.
2. Corregir «mejor vende 2»: debe cancelar el preview anterior y mostrar uno nuevo de 2. Cancelar con «no lo hagas»; luego «confirmar» no ejecuta.
3. Preparar una compra con proveedor ambiguo; «sí» debe pedir selección. Elegir proveedor, corregirlo y comprobar que producto/cantidad se conservan. Cancelar.
4. Preparar una regla; cambiar «mejor umbral 2» y revisar el preview nuevo. Cancelar.
5. Preparar otra operación, hacer una READ y escribir «confirmar»: debe volver a mostrar la tarjeta, sin ejecución en ese turno. Cancelar.
6. Para validar una ejecución real, usar datos de prueba y confirmar deliberadamente el último preview. Repetir «confirmar» y luego «cancelar»: no debe producir otra escritura ni rollback. Esta prueba debe hacerla el usuario conscientemente en su tenant de prueba.
