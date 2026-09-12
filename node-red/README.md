# Node-RED ↔ Sistema de Inventario y Facturación

Integración de **Node-RED** (en la nube, gratis) con el backend de tu sistema.
El flujo incluye: **estado de conexión**, **KPIs en Dashboard**, **alerta de stock bajo**
y un **webhook** para recibir eventos en tiempo real desde el backend.

---

## 1) Puntos de integración con tu sistema

| # | Punto | Endpoint | Auth | Uso en Node-RED |
|---|-------|----------|------|-----------------|
| 1 | Estado / conectividad | `GET /health` | ❌ No | Demostrar que Node-RED está conectado |
| 2 | Login (JWT) | `POST /api/auth/login` | ❌ No | Obtener el token para el resto de llamadas |
| 3 | Resumen del negocio | `GET /api/reports/dashboard` | ✅ Bearer | Gauges/medidores en el Dashboard |
| 4 | Stock bajo | `GET /api/products/low-stock` | ✅ Bearer | Alerta automática cada X minutos |
| 5 | Crear venta | `POST /api/transactions` | ✅ Bearer | Escritura desde Node-RED |
| 6 | Tipo de cambio | `GET /api/external/exchange-rate` | ✅ Bearer | Enriquecer/avisar si cambia la tasa |
| 7 | Webhook (nuevo) | `POST <node-red>/webhook` | opcional | **Eventos** del sistema → Node-RED |

> Los puntos 1–6 solo usan el nodo **HTTP Request** (cero cambios en tu código).
> El punto 7 ya viene implementado en el backend y se **activa con una variable de entorno**.

---

## 2) Desplegar Node-RED GRATIS en la nube (Render) — recomendado

1. Sube este repositorio a GitHub (con la carpeta `node-red/`).
2. En [Render](https://render.com) → **New → Web Service** → conecta el repo.
3. Configura:
   - **Runtime**: `Docker`
   - **Root Directory**: la carpeta que contiene `node-red/` (p. ej. `Inventory-Billing-Management-System/node-red`)
   - **Dockerfile Path**: `./Dockerfile`
   - **Instance Type**: `Free`
4. En **Environment**, agrega:
   | Variable | Valor |
   |----------|-------|
   | `API_BASE` | `https://TU-BACKEND.onrender.com/api` |
   | `BILLING_EMAIL` | correo de un usuario ya registrado en tu sistema |
   | `BILLING_PASSWORD` | contraseña de ese usuario |
   | `NODE_RED_USERNAME` | (opcional) usuario para proteger el editor |
   | `NODE_RED_PASSWORD` | (opcional) contraseña del editor |
   | `NODE_RED_CREDENTIAL_SECRET` | Render la genera sola (o pon una random) |

   > Alternativa: usa `render.yaml` con **New → Blueprint**. Si el archivo no está en la raíz del repo,
   > crea el servicio manualmente como arriba.
5. **Create Web Service**. Cuando termine, tendrás:
   - Editor: `https://TU-NODERED.onrender.com/`
   - Dashboard: `https://TU-NODERED.onrender.com/ui`
   - Webhook: `https://TU-NODERED.onrender.com/webhook`

### Evitar que se duerma (plan free)
Crea un monitor gratis en **UptimeRobot** o **cron-job.org** que haga `GET` a
`https://TU-NODERED.onrender.com/` cada **10 minutos**.

### ¿Se borran los flujos al reiniciar/despertar? (IMPORTANTE)
**No.** En este proyecto los flujos van **dentro de la imagen Docker**: el `Dockerfile` copia
`flows.json` y `settings.js` a `/data` durante el build. Por eso, aunque Render duerma, despierte
o haga un redeploy, Node-RED **siempre arranca con tus flujos cargados** (no queda en blanco).

Única consideración: los cambios que hagas **desde el editor en Render**. Como el disco de Render
free es efímero, esos cambios en caliente se pierden al reiniciar (vuelve a la versión horneada).
Para conservarlos: expórtalos (Export → JSON) y actualiza `flows.json` en el repo, o edítalos en
local y haz redeploy.

### ¿Pesa mucho tener Node-RED y el backend en Render?
Son **servicios separados** (Node-RED no se “agrega” dentro del backend; es otra Web Service),
así que **no se afectan entre sí**. Ojo con el límite del plan free: son **~750 horas de instancia
al mes** en total por cuenta. Si mantienes DOS servicios despiertos 24/7 (ping cada 10 min) te pasarás
del límite → recomendable mantener despierto solo el que usas en la demo, o aceptar que duerman.

---

## 3) Alternativas de hosting gratuito
- **Oracle Cloud Always Free (VM)**: la opción más estable y *always-on* (Docker + Node-RED). Más pasos.
- **Node-RED local + Cloudflare Tunnel / ngrok**: gratis y rapidísimo para una demo en vivo;
  expone tu PC con una URL pública (requiere tener la PC encendida).
- **Render** (la de arriba): la más simple y consistente con tu stack actual.

---

## 4) Activar la integración en TIEMPO REAL (webhook)

En el **backend** (Render), agrega la variable:

| Variable | Valor |
|----------|-------|
| `NODE_RED_WEBHOOK_URL` | `https://TU-NODERED.onrender.com/webhook` |
| `NODE_RED_WEBHOOK_SECRET` | (opcional) cadena secreta |

Desde ese momento, el backend enviará eventos:
- `transaction.created` → al registrar una venta/compra
- `product.low_stock` → cuando un producto llega a su stock mínimo

Si **no** defines `NODE_RED_WEBHOOK_URL`, no cambia nada (queda desactivado).

---

## 5) Guion de demostración al docente
1. Abre el **Dashboard** (`/ui`) y muestra el medidor *"🟢 API conectada"* → Node-RED ↔ sistema funcionando.
2. Muestra los **KPIs** (productos, clientes, stock bajo, ventas del mes) actualizándose solos.
3. Baja el stock de un producto en tu sistema → aparece la **alerta de stock bajo** en Node-RED.
4. Realiza una venta en tu sistema → el **Debug** de Node-RED muestra el evento `transaction.created` en vivo.
5. (Opcional) Desde Node-RED, con un **Inject + HTTP Request POST /api/transactions**, crea una venta
   y muéstrala luego en la interfaz de tu sistema (integración bidireccional).

---

## 6) Alternativa recomendada: Node-RED en **Railway** (con disco persistente)

Railway es más cómodo que Render para Node-RED porque permite **volumen persistente** (los flujos
se guardan de verdad) y soporta WebSockets del editor. Contra: no es gratis permanente (da ~$5 de
crédito de prueba; luego es pago). Pasos:

1. Crea cuenta en <https://railway.app> (entra con GitHub).
2. **New Project → Deploy from GitHub repo** y elige tu repositorio.
3. En el servicio → **Settings → Source → Root Directory**: apunta a la carpeta `node-red/`
   (así Railway usa el `Dockerfile` de aquí).
4. **Variables** del servicio:
   `API_BASE`, `BILLING_EMAIL`, `BILLING_PASSWORD`, `NODE_RED_CREDENTIAL_SECRET`
   (y opcional `NODE_RED_USERNAME` / `NODE_RED_PASSWORD`).
5. **Data / Volumes → New Volume**, punto de montaje: `/data` (aquí viven flujos y nodos instalados).
6. **Settings → Networking → Generate Domain** → obtienes la URL pública.
7. Abre la URL, entra al editor. Si los flujos no aparecieran, impórtalos:
   **Menú → Import → Clipboard** y pega el contenido de `flows.json`.
8. En el backend (Render), define `NODE_RED_WEBHOOK_URL = https://TU-DOMINIO/webhook`.

> Si prefieres lo mínimo: **New → Docker Image → `nodered/node-red`**, agrega el volumen `/data`,
> genera el dominio, instala `node-red-dashboard` por *Manage Palette* e importa `flows.json`.

## 7) Diferencia clave vs. la clase (ngrok)

En la práctica de clase usaron **ngrok** porque Node-RED estaba en tu PC (`localhost:1880`) y
Google Apps Script vive en la nube. Cuando Node-RED está **desplegado en la nube**, ya **no necesitas
ngrok**: la URL pública de Railway/Render reemplaza al túnel. En Apps Script solo cambias la
constante de la URL de ngrok por la de tu Node-RED en la nube.

**Ejemplo Apps Script (Google):**
```javascript
function enviarANodeRed() {
  const url = 'https://TU-NODERED-en-la-nube/webhook'; // antes era la URL de ngrok
  const payload = { origen: 'Google Apps Script', total: 150, moneda: 'PEN' };
  const respuesta = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log(respuesta.getContentText());
}
```

