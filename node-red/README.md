# Node-RED - integración de inventario y facturación

Este servicio recibe eventos autenticados del backend, consulta sus APIs para el
dashboard y responde comandos de Telegram. Los flujos y la configuración se
incluyen en la imagen; no se editan desde producción.

## Endpoints y política de acceso

| Superficie | Ruta | Política |
|---|---|---|
| Webhook | `POST /webhook` | Requiere `X-Webhook-Secret` igual a `NODE_RED_WEBHOOK_SECRET`. Responde `401` si falta o es incorrecto. |
| Dashboard | `GET /ui` | Requiere HTTP Basic con `NODE_RED_HTTP_USERNAME` y `NODE_RED_HTTP_PASSWORD` en producción. |
| Otros HTTP nodes futuros | cualquier ruta | Quedan protegidos por el mismo HTTP Basic en producción. |
| Editor/admin | `/red` y rutas administrativas | `adminAuth` de Node-RED con usuario y hash bcrypt en producción. |

La autenticación del webhook se ejecuta antes de cualquier login al backend,
consulta empresarial o envío a Telegram. Solo se aceptan los eventos
`transaction.created`, `product.low_stock` y `telegram.command`. Este último
valida además el formato de `chatId` y el comando permitido.

## Variables de entorno

Producción requiere:

- `NODE_ENV=production`
- `NODE_RED_CREDENTIAL_SECRET`: secreto aleatorio de al menos 32 caracteres.
- `NODE_RED_WEBHOOK_SECRET`: secreto aleatorio de al menos 32 caracteres; debe
  coincidir con el valor configurado en el backend.
- `NODE_RED_HTTP_USERNAME` y `NODE_RED_HTTP_PASSWORD`: protegen dashboard y
  otros HTTP nodes. La contraseña debe tener al menos 12 caracteres.
- `NODE_RED_ENABLE_EDITOR=true`, `NODE_RED_ADMIN_USER` y
  `NODE_RED_ADMIN_PASSWORD_HASH`: habilitan el editor autenticado en `/red`.
  El hash debe ser bcrypt; nunca configures ni guardes la contraseña en texto
  plano. Para la demo el usuario tiene permisos `*` para visualizar y desplegar
  flows. Si solo se requiere lectura, se puede limitar a `read`.
- `API_BASE`, `BILLING_EMAIL` y `BILLING_PASSWORD`: acceso del flujo a la API.
- `TELEGRAM_BOT_TOKEN`: necesario solo para responder por Telegram.

No hay secretos predeterminados. Una configuración incompleta hace que
Node-RED falle al arrancar.

### Dashboard y editor

El dashboard conserva su ruta `/ui`. El editor visual está en `/red` y requiere
login propio de Node-RED. En Render, configura `NODE_RED_ENABLE_EDITOR=true`,
`NODE_RED_ADMIN_USER` y `NODE_RED_ADMIN_PASSWORD_HASH`; el servicio falla al
arrancar si se habilita el editor sin ambas credenciales o con un hash que no
sea bcrypt válido. El editor queda deshabilitado por defecto en otros entornos.

Genera el hash bcrypt en un entorno confiable con `node-red-admin hash-pw` y
configura el resultado como `NODE_RED_ADMIN_PASSWORD_HASH` en Render. El
comando solicita la contraseña de forma interactiva; no incluyas la contraseña
ni el hash en Git, tickets o logs.

## Configuración del backend

Configura en el backend:

```text
NODE_RED_WEBHOOK_URL=https://TU-NODERED.example/webhook
NODE_RED_WEBHOOK_SECRET=<el mismo secreto aleatorio de Node-RED>
```

Si `NODE_RED_WEBHOOK_URL` está vacío, el backend deshabilita la integración. Si
está configurado, el secreto es obligatorio. El backend considera error toda
respuesta no 2xx y no registra secretos, payloads completos ni URLs con tokens.

## Despliegue

El `Dockerfile` usa una versión fija de Node-RED y `npm ci` con el lockfile. El
archivo `render.yaml` habilita el editor protegido y declara sus credenciales
como valores externos; ninguna credencial real debe versionarse.

Para Render, crea un Web Service Docker con `node-red/` como directorio raíz o
usa el Blueprint. Configura todos los valores marcados `sync: false` en el panel
de secretos. Para Railway u otro proveedor aplica la misma política. No uses la
imagen `latest` ni habilites instalación de módulos desde el editor.

Los cambios hechos dentro de un contenedor no son la fuente de verdad. Modifica
`flows.json` en desarrollo, valida las pruebas y vuelve a desplegar la imagen.

## Pruebas

```bash
cd node-red
npm ci
npm test
```

La suite comprueba autenticación del webhook, aislamiento de solicitudes
rechazadas, validación de eventos/Telegram, configuración fail-closed,
protección de superficies HTTP, bcrypt, módulos externos y reproducibilidad de
la imagen.

## Límites de esta iteración

El secreto compartido protege el origen, pero aún no incorpora timestamp,
nonce ni almacenamiento anti-replay. Tampoco sustituye una futura identidad de
servicio para las consultas de Node-RED al backend.
