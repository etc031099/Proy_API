# Inventory & Billing Management Backend

## AUTH-V2: provisioning temporal de la cuenta demo

`businessId` es un identificador lógico string; no existe una colección Business.
V2 usa `ML-CLOUD-DEMO-V2`, asignado por el servidor desde el registry de escenarios.
El registro público normal sigue disponible, pero reserva ese identificador.

Después de desplegar esta fase (no se publica automáticamente):

1. Configurar temporalmente en el backend `DEMO_V2_REGISTRATION_ENABLED=true`
   y `DEMO_V2_REGISTRATION_EMAIL` con el correo autorizado de la nueva cuenta.
   Usar el correo normalizado por el registro existente (minúsculas y, para Gmail,
   sin puntos ni alias `+`). No compartir contraseñas ni tokens.
2. Iniciar sesión normalmente con la cuenta V1 y abrir en el frontend
   `/register-demo-v2`. Introducir únicamente nombre, correo y contraseña.
3. El formulario llama a `POST /api/auth/register-demo-v2`: exige JWT, acceso
   al negocio V1 y coincidencia del correo configurado. Rechaza campos extra;
   reutiliza validación, hashing bcrypt y los índices únicos existentes.
   Contraseña: reglas normales y máximo 72 bytes para evitar truncamiento bcrypt.
4. Un registro exitoso cambia solo la sesión de este navegador a V2. La cuenta
   V1 queda intacta y puede iniciar sesión de nuevo. Duplicados devuelven 409.
5. Desactivar `DEMO_V2_REGISTRATION_ENABLED=false` después del provisioning.
   El endpoint devuelve 404 cuando está desactivado; el login V2 sigue funcionando.

No se importan productos ni transacciones en este flujo. La allowlist por sí sola
no acredita propiedad de un correo: la autorización depende también de la sesión
V1. Se reutiliza el límite de autenticación de 50 intentos/15 minutos por IP.
Pruebas: `node --test test/demoV2Registration.test.js`, `npm test` y
`npm run test:integration:demo-v2`. Esta última solo permite Mongo local y crea
fixtures en una base de pruebas aislada; nunca conecta a Atlas.

## AUTO-R1: base de automatización y acciones

`src/automations/` separa contratos de canales/triggers, reglas determinísticas,
registry de acciones, preparación/confirmación, ejecutores, auditoría y engine.
Los canales previstos son assistant, Telegram, Node-RED y automatización; solo
assistant se conecta en esta fase. No se activan schedulers ni listeners.

Riesgos: READ_ONLY, SAFE_AUTOMATIC, REQUIRES_CONFIRMATION y RESTRICTED.
No se registra ninguna herramienta restringida. Solo Operations puede escribir;
Coordinator y Analyst mantienen sus skills de lectura. Las declaraciones de
escritura no se inyectan automáticamente en Gemini.

READY: `create_product` (confirmación humana) y `create_inventory_alert` (interna,
automática). Las otras 12 acciones permanecen PENDING_IMPLEMENTATION, incluyendo
ventas/compras: su controller combina precios canónicos, crédito, moneda,
inventario y notificaciones; extraerlo de forma segura requiere otra fase.
No se simulan controllers ni se duplican fórmulas financieras.

En /assistant, enviar `Crear producto` seguido de JSON con name, sku, price,
currency, stock, minStockLevel y category (obligatoria en el modelo real). Se muestra un preview; Confirmar/Cancelar usan
`POST /api/agent/actions/:id/confirm|cancel`, auth JWT, tenant y feature flag
existentes, rate limit de 20 solicitudes/minuto por usuario. El body de decisión
solo admite conversationId. Ventas y compras responden que no están habilitadas.
"Sí"/"no" solo actúan si hay una única acción pendiente en esa conversación.
No se aceptan identidades, prompts, modelos ni argumentos nuevos al confirmar.

PendingAction dura 10 minutos y liga usuario, negocio, canal y conversación.
Los argumentos validados se congelan y verifican con SHA-256. La clave externa
UUID más canal/usuario/negocio impide preparar duplicados; pendingActionId permite
repetir una confirmación y recuperar el resultado original. Producto, movimiento
de apertura, estado EXECUTED y ActionAudit se confirman en la misma transacción
Mongo. Un error aborta la escritura; fallos seguros se auditan por separado.
No hay retries automáticos de escrituras. Un commit incierto devuelve conflicto;
repetir la misma confirmación consulta su estado, no crea otra acción.
Se necesita replica set y los índices únicos habituales de Mongoose.

El engine usa definiciones de servidor (la definición de alertas está desactivada),
una lectura batch y hasta tres alertas internas por ejecución. AutomationRun
deduplica eventId por negocio/definición, conserva resultados parciales y uso real
determinístico: 0 LLM/0 tokens. No crea compras a partir de forecast. Un proceso
interrumpido con RUNNING necesita reconciliación futura; no se reejecuta a ciegas.

Pruebas: `node --test test/automations.test.js`, `npm test` y tests frontend de
tarjetas. Usan fixtures/modelos simulados: no prueban Atlas ni crean datos cloud.
Queda pendiente la validación transaccional con Mongo real en una fase controlada.
No se registra contenido sensible, credenciales, prompts ni chain-of-thought.

A comprehensive backend system for small businesses to manage products, customers, vendors, transactions, and generate reports with JWT-based authentication.

## 🚀 Features

- **Authentication System**: JWT-based authentication with user registration, login, and profile management
- **Product Management**: Full CRUD operations with stock tracking, categories, and low-stock alerts
- **Contact Management**: Manage customers and vendors with detailed information and balance tracking
- **Transaction System**: Record sales and purchases with automatic stock updates and financial tracking
- **Reporting System**: Comprehensive reports for inventory, transactions, customers, and business dashboard
- **Security**: Rate limiting, input validation, password hashing, and business-level data isolation

## 🛠️ Tech Stack

- **Backend**: Node.js + Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT + bcrypt
- **Security**: Helmet, CORS, Rate Limiting
- **Validation**: express-validator
- **Logging**: Morgan

## 📋 Prerequisites

- Node.js (v14 or higher)
- MongoDB (local or MongoDB Atlas)
- npm or yarn

## ⚡ Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd inventory-billing-backend
npm install
```

### 2. Environment Setup

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# Docker MongoDB replica set (`rs0`); required by Docker Compose
MONGO_ROOT_USERNAME=
MONGO_ROOT_PASSWORD=
MONGODB_REPLICA_SET=rs0
MONGODB_URI=
MONGODB_URI_DOCKER=
MONGODB_TEST_URI=
# For MongoDB Atlas, replace the URI and leave MONGODB_REPLICA_SET unset unless
# it matches the replica-set name reported by Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/inventory_billing

# JWT Configuration; required, random, and at least 32 characters
JWT_SECRET=
JWT_EXPIRE=7d

# Business Configuration
DEFAULT_BUSINESS_ID=default_business_123
```

Generate a new JWT secret locally and copy only its output into your untracked
`.env` or deployment secret manager:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

The former Docker JWT secret is considered compromised. Recreating the API
with a new value invalidates all existing JWTs, which is expected. Never commit
the generated value.

MongoDB is exposed to the host only on `127.0.0.1:27017` for local integration
tests. A production deployment should normally omit the host port entirely.

### 3. Start MongoDB and the Application

MongoDB transactions require the replica set configured by Docker Compose:

```bash
docker compose config
docker compose up -d mongodb mongo-init

# Verify that rs0 has a PRIMARY
docker compose exec mongodb sh -lc 'mongosh --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --quiet --eval "rs.status().members.map(({name,stateStr}) => ({name,stateStr}))"'
```

Then start the backend on the host:

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

The server will start at `http://localhost:5000`

The health endpoints return HTTP 200 only after Mongoose is connected to a
writable replica-set PRIMARY. During startup or loss of PRIMARY they return 503.

### MongoDB Integration Tests

Integration tests use the real `rs0` instance and require the dedicated
`inventory_billing_test` database from `MONGODB_TEST_URI`:

```bash
npm run test:integration
```

The suite verifies explicit COMMIT and ROLLBACK plus sale, purchase, credit
payment, and cancellation invariants. Unit tests remain available with
`npm test`.

Restart or stop the environment without deleting data:

```bash
docker compose restart mongodb
docker compose down
```

To intentionally remove all local MongoDB data and the generated replica-set
keyfile, use `docker compose down -v`.

## 📚 API Documentation

### Base URL
```
http://localhost:5000/api
```

### Authentication
All endpoints except registration and login require a Bearer token in the Authorization header:
```
Authorization: Bearer <your_jwt_token>
```

## 🔐 Authentication Endpoints

### Register User
```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com", 
  "password": "Password123",
  "businessId": "business_001"
}
```

### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "Password123"
}
```

### Get Profile
```http
GET /api/auth/profile
Authorization: Bearer <token>
```

### Update Profile
```http
PUT /api/auth/profile
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "John Smith"
}
```

### Change Password
```http
PUT /api/auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "currentPassword": "oldPassword123",
  "newPassword": "newPassword123"
}
```

### Logout
```http
GET /api/auth/logout
Authorization: Bearer <token>
```

## 📦 Product Management Endpoints

### Get All Products
```http
GET /api/products?search=laptop&category=electronics&page=1&limit=10
Authorization: Bearer <token>
```

### Create Product
```http
POST /api/products
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Laptop",
  "description": "High-performance laptop",
  "price": 999.99,
  "stock": 50,
  "category": "Electronics",
  "sku": "LAP001",
  "minStockLevel": 5
}
```

### Get Single Product
```http
GET /api/products/:id
Authorization: Bearer <token>
```

### Update Product
```http
PUT /api/products/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Updated Laptop",
  "price": 1099.99,
  "stock": 45
}
```

### Delete Product
```http
DELETE /api/products/:id
Authorization: Bearer <token>
```

### Update Product Stock
```http
PATCH /api/products/:id/stock
Authorization: Bearer <token>
Content-Type: application/json

{
  "quantity": 10,
  "operation": "add"  // "add", "subtract", or "set"
}
```

### Get Low Stock Products
```http
GET /api/products/low-stock
Authorization: Bearer <token>
```

### Get Product Categories
```http
GET /api/products/categories
Authorization: Bearer <token>
```

### Get Products by Category
```http
GET /api/products/category/electronics
Authorization: Bearer <token>
```

## 👥 Contact Management Endpoints

### Get All Contacts
```http
GET /api/contacts?type=customer&search=john&page=1&limit=10
Authorization: Bearer <token>
```

### Create Contact
```http
POST /api/contacts
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "John Customer",
  "phone": "+1234567890",
  "email": "john@customer.com",
  "type": "customer",
  "address": {
    "street": "123 Main St",
    "city": "New York",
    "state": "NY",
    "zipCode": "10001",
    "country": "USA"
  },
  "creditLimit": 5000,
  "notes": "Premium customer"
}
```

### Get Single Contact
```http
GET /api/contacts/:id
Authorization: Bearer <token>
```

### Update Contact
```http
PUT /api/contacts/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "John Updated",
  "creditLimit": 7500
}
```

### Delete Contact
```http
DELETE /api/contacts/:id
Authorization: Bearer <token>
```

### Get Customers Only
```http
GET /api/contacts/customers
Authorization: Bearer <token>
```

### Get Vendors Only
```http
GET /api/contacts/vendors
Authorization: Bearer <token>
```

### Search Contacts
```http
GET /api/contacts/search/john?type=customer&limit=5
Authorization: Bearer <token>
```

### Update Contact Balance
```http
PATCH /api/contacts/:id/balance
Authorization: Bearer <token>
Content-Type: application/json

{
  "amount": 100,
  "operation": "add"  // "add", "subtract", or "set"
}
```

## 🌐 External API Integrations

### Exchange Rate
```http
GET /api/external/exchange-rate?base=USD&target=PEN
Authorization: ******
```

### Validate Document
```http
GET /api/external/document/validate?type=dni&number=12345678
Authorization: ******
```

### Validate Payment Method
```http
GET /api/external/payment-method/validate?method=card&amount=1500
Authorization: ******
```

These endpoints use external public APIs when available and automatically fall back to safe local demo values when the upstream service is unavailable.

## 💰 Transaction Management Endpoints

### Get All Transactions
```http
GET /api/transactions?type=sale&startDate=2024-01-01&endDate=2024-01-31&page=1&limit=10
Authorization: Bearer <token>
```

### Create Transaction (Sale)
```http
POST /api/transactions
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "sale",
  "customerId": "customer_id_here",
  "products": [
    {
      "productId": "product_id_here",
      "quantity": 2,
      "price": 999.99
    }
  ],
  "paymentMethod": "cash",
  "notes": "Customer pickup"
}
```

### Create Transaction (Purchase)
```http
POST /api/transactions
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "purchase",
  "vendorId": "vendor_id_here",
  "products": [
    {
      "productId": "product_id_here",
      "quantity": 50,
      "price": 800.00
    }
  ],
  "paymentMethod": "bank_transfer",
  "notes": "Bulk purchase"
}
```

### Get Single Transaction
```http
GET /api/transactions/:id
Authorization: Bearer <token>
```

### Get Sales Only
```http
GET /api/transactions/sales?customerId=customer_id&startDate=2024-01-01
Authorization: Bearer <token>
```

### Get Purchases Only
```http
GET /api/transactions/purchases?vendorId=vendor_id&startDate=2024-01-01
Authorization: Bearer <token>
```

### Get Transaction Summary
```http
GET /api/transactions/summary?startDate=2024-01-01&endDate=2024-01-31
Authorization: Bearer <token>
```

### Update Transaction Status
```http
PATCH /api/transactions/:id/status
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "completed"  // "pending", "completed", "cancelled"
}
```

## 📊 Reporting Endpoints

### Dashboard Summary
```http
GET /api/reports/dashboard
Authorization: Bearer <token>
```

The default `period=current` reports the current calendar month/year. Use
`?period=latest` to report the month/year containing the tenant's latest
completed transaction. The response always includes the exact period bounds;
no transaction dates are shifted or fabricated.

### Inventory Report
```http
GET /api/reports/inventory?category=electronics&lowStock=true&sortBy=stock&sortOrder=asc
Authorization: Bearer <token>
```

### Transaction Report
```http
GET /api/reports/transactions?startDate=2024-01-01&endDate=2024-01-31&type=sale&groupBy=day
Authorization: Bearer <token>
```

This endpoint returns an aggregate summary, compact period groups, and at most
10 recent matching transactions. It never returns the complete transaction
history or embeds transactions inside period groups. `from`/`to` are supported
as aliases for `startDate`/`endDate`; `groupBy` accepts `hour`, `day`, `week`,
`month`, or `year`. Use the paginated `/api/transactions` endpoint for browsing
individual transactions.

### Customer Report
```http
GET /api/reports/customer/:customerId?startDate=2024-01-01&endDate=2024-01-31
Authorization: Bearer <token>
```

### Vendor Report
```http
GET /api/reports/vendor/:vendorId?startDate=2024-01-01&endDate=2024-01-31
Authorization: Bearer <token>
```

## 🏥 Health & Status Endpoints

### Health Check
```http
GET /health
```

### API Documentation
```http
GET /api/docs
```

## 🔒 Security Features

- **Rate Limiting**: 100 requests per 15 minutes per IP
- **Authentication Rate Limiting**: 10 auth requests per 15 minutes per IP
- **Password Hashing**: bcrypt with salt rounds
- **JWT Security**: Secure token generation and validation
- **Input Validation**: Comprehensive validation for all inputs
- **Business Isolation**: Users can only access their business data
- **CORS Protection**: Configurable CORS policies
- **Helmet Security**: Various security headers

## 📝 Data Models

### User Model
```javascript
{
  name: String,
  email: String (unique),
  password: String (hashed),
  businessId: String,
  role: String (admin|user),
  isActive: Boolean
}
```

### Product Model
```javascript
{
  name: String,
  description: String,
  price: Number,
  stock: Number,
  category: String,
  businessId: String,
  sku: String,
  minStockLevel: Number,
  isActive: Boolean
}
```

### Contact Model
```javascript
{
  name: String,
  phone: String,
  email: String,
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String
  },
  type: String (customer|vendor),
  businessId: String,
  creditLimit: Number,
  currentBalance: Number,
  isActive: Boolean,
  notes: String
}
```

### Transaction Model
```javascript
{
  type: String (sale|purchase),
  customerId: ObjectId (for sales),
  vendorId: ObjectId (for purchases),
  products: [{
    productId: ObjectId,
    productName: String,
    quantity: Number,
    price: Number,
    total: Number
  }],
  totalAmount: Number,
  date: Date,
  businessId: String,
  status: String (pending|completed|cancelled),
  paymentMethod: String,
  notes: String,
  invoiceNumber: String
}
```

## 🚀 Deployment

### Environment Variables for Production
```env
NODE_ENV=production
PORT=5000
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/inventory_billing
JWT_SECRET=
JWT_EXPIRE=7d
```

### Deploy to Render

1. Push code to GitHub
2. Connect Render to your GitHub repository
3. Set environment variables in Render dashboard
4. Deploy automatically on commits

### MongoDB Atlas Setup

1. Create MongoDB Atlas account
2. Create cluster and database
3. Get connection string
4. Add to MONGODB_URI environment variable

## 🧪 Testing

### Manual Testing with curl

```bash
# Register user
curl -X POST http://localhost:5000/api/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Test User","email":"test@example.com","password":"Password123","businessId":"test_business"}'

# Login
curl -X POST http://localhost:5000/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"test@example.com","password":"Password123"}'

# Create product (use token from login)
curl -X POST http://localhost:5000/api/products \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \\
  -d '{"name":"Test Product","price":99.99,"stock":10,"category":"Test"}'
```

## 🐛 Common Issues & Solutions

### Database Connection Issues
- Ensure MongoDB is running
- Check MONGODB_URI format
- Verify network access for Atlas

### Authentication Issues
- Check JWT_SECRET is set
- Verify token format (Bearer token)
- Ensure token hasn't expired

### Validation Errors
- Check request body format
- Verify required fields
- Review field length limits

## Disponibilidad del asistente Gemini

El modo AUTO se configura solo en el servidor:

```dotenv
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODELS=gemini-3.7-flash,gemini-3.6-flash
GEMINI_TIMEOUT_MS=15000
```

Sin `GEMINI_FALLBACK_MODELS` no se habilitan respaldos. La lista admite hasta dos
identificadores únicos, sin espacios ni entradas vacías. Todos usan la misma
`GEMINI_API_KEY` y proyecto; nunca se rotan cuentas ni se eluden cuotas.

Solo 500/502/503/504, timeout o error de red transitorio permiten el retry del
principal y, si vuelve a fallar transitoriamente, un intento por respaldo.
401/403/404/429, JSON/schema inválido, truncamiento y errores de presupuesto
detienen la generación, también si ocurren en un respaldo.

Máximo: cuatro intentos físicos, una llamada LLM lógica. Cada intento conserva
el límite configurado (15 s por defecto); el deadline total es 40 s incluyendo
backoff de 1 s. Un intento final puede tener menos tiempo y no se inicia si
quedan menos de 2 s útiles. Se conservan thinking low y tech ceilings 512/768/1024.

`usage.providerGenerations` distingue `logicalGenerationUsage` (resultado final)
de `providerAttemptUsage` (cada intento). `totalKnownUsage` es un subtotal de
métricas reportadas, no una estimación del consumo desconocido; valores ausentes
son `null`. La UI muestra modelo final, respaldo, intentos y consumo parcial.
Los logs contienen IDs, modelos, estados, tiempos y métricas, nunca prompts,
respuestas crudas ni secretos. No se admite elegir modelo desde el mensaje.

Capacidades verificadas en la documentación oficial:
[Gemini 3.7 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash),
[Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash) y
[thinking](https://ai.google.dev/gemini-api/docs/thinking).
La disponibilidad efectiva para el proyecto depende del proveedor; no se
provocan fallos ni se consumen llamadas reales para probar el failover.

## Historial persistente del asistente (AG-R8-HISTORY)

Con `AGENT_ENABLED=true`, el chat empieza a guardarse desde esta versión; no se
migran conversaciones antiguas. `AgentConversation` y `AgentConversationMessage`
se consultan exclusivamente por usuario autenticado **y** negocio. Mongo Atlas
(replica set) permite transacciones cortas para guardar pares de cambios y para
borrar conversación + mensajes; ninguna transacción permanece abierta durante
skills o Gemini.

- `POST /api/agent/messages`: conserva el contrato `message, conversationId?`.
  La primera consulta crea el chat; visitar la página o pulsar Nueva conversación
  no crea documentos. El frontend reutiliza un UUID en `Idempotency-Key` para un
  reintento de la misma consulta. CORS permite ese header sin ampliar orígenes.
- `GET /api/agent/conversations?page=1&limit=10`: resúmenes, más recientes primero.
- `GET /api/agent/conversations/:conversationId?page=1&limit=50`: ventana más
  reciente en orden cronológico; páginas posteriores recuperan mensajes anteriores.
- `DELETE /api/agent/conversations/:conversationId`: borrado real del propietario,
  con confirmación en UI. IDs ajenos/inexistentes responden igual (404).

Los títulos son determinísticos (máximo 60 caracteres). Mensaje entrante: 2000
caracteres; texto persistido: máximo 20000; conversación: máximo 400 mensajes;
paginación: máximo 50 registros. No hay borrado automático por antigüedad.
Un fallo de ejecución conserva el mensaje del usuario como `failed`, sin inventar
respuesta. Un fallo de guardado posterior deja `pending`: se informa al usuario
y **no se regenera** automáticamente un resultado incierto. En ese caso, recargar
historial antes de iniciar otra consulta. Se conservan solamente texto y metadata
pública proyectada (agentes, skills, evidencia, uso real, fallback y latencia),
nunca prompts internos, respuestas raw ni secretos.

El historial es **persistencia para la UI**, no un prompt: listar, abrir, restaurar
y borrar usan 0 llamadas LLM. La memoria del agente sigue siendo compacta,
in-process y con TTL de 30 minutos. Un snapshot estructurado, sin mensajes y con
máximo cinco productos, permite recuperar referencias tras reinicio/TTL sin
reenviar el chat a Gemini. El frontend guarda únicamente el UUID activo bajo una
clave por usuario/negocio y lo limpia al cerrar sesión; mensajes y actividad se
recuperan del backend. La coordinación local de envíos es para la demo de una
instancia; la unicidad Mongo protege las claves duplicadas, pero no constituye
un sistema de locks distribuido ni retención corporativa.

Prueba manual cloud tras deploy: enviar una consulta determinística, ir a Productos
y volver, pulsar F5, crear un segundo chat con Nueva conversación, alternar entre
ambos, cerrar sesión/login y confirmar recuperación; eliminar uno con confirmación.
No requiere llamadas Gemini para verificar persistencia. Pruebas locales:
`node --test test/agentHistory.test.js test/agentMessages.test.js` desde backend;
`npm test`; desde frontend `npm run test:ml-forecast`, `npx tsc --noEmit`, `npm run build`.

## Telegram de reglas de stock (ACT-04B)

Los eventos persistidos `inventory.alert.opened/resolved` se entregan a Node-RED
mediante ACT-04A, sin volver a evaluar reglas. Tras emitir el ACK durable,
Node-RED solicita `POST /api/internal/inventory-alert-dispatch/channels/process`
con **solo eventId**, autenticado por `X-Internal-Secret` y
`NODE_RED_WEBHOOK_SECRET`. Backend deriva negocio y destino exclusivamente del
evento persistido y su `TelegramConnection`; no utiliza las credenciales fijas
de `telegram.command`. No hay acceso Atlas desde Node-RED.

`InventoryAlertChannelDelivery` conserva estado, intentos, fechas, lease y
categorías sanitizadas; índice único `(eventId, channel, destinationKey)`.
El destino es una huella interna, nunca expuesta al asistente. No guarda token.
El callback de recepción reserva PENDING de forma durable antes del ACK, sin enviar.
No se envía hasta que el outbox sea DELIVERED y exista recepción durable.
Si la petición de canal llega antes de ese guardado, queda PENDING y el dispatcher
drena la entrega ya solicitada después del guardado. Si llega después, la procesa
directamente. Un fallo Telegram no revierte ni invalida el ACK de ACT-04A.

En **Integraciones**, las preferencias independientes `stockRuleAlertsEnabled`
y `stockRuleResolvedAlertsEnabled` permiten avisos de activación y recuperación.
Ambas son **false** por defecto, incluso en conexiones existentes sin esos campos.
`PATCH /api/telegram/preferences` requiere auth/acceso al negocio y acepta solo
esos booleanos. `lowStockAlertsEnabled` conserva su semántica tradicional.
SKIPPED es terminal: sin conexión, conexión deshabilitada, preferencia apagada,
evento no autorizado o destino cambiado. Habilitar una preferencia no reenvía
eventos omitidos para ese destino; se aplica a nuevos eventos.

Timeout/network/429/5xx usan backoff 30 s / 2 min / 5 min / 15 min y máximo
cinco intentos; token/config/chat inválido o forbidden son terminales. Lease:
30 s; petición Telegram: máximo 8 s incluyendo body. No hay retry en bucle ni
scheduler externo. Para procesar reintentos vencidos se dispone de
`POST /api/internal/inventory-alert-dispatch/channels/run`, body `{}`, con el
secreto dedicado `INVENTORY_ALERT_DISPATCH_SECRET` (no el del webhook).
La cola se conserva tras reinicios. Si Node-RED o backend cae tras el ACK,
la reserva durable permite recuperarla con `/channels/run`, sin repetir
operaciones de stock. `/channels/process` también es idempotente por evento.
No se envían automáticamente todos los eventos históricos del outbox.

Garantía: **at-least-once + dedupe durable**, no exactly-once. Telegram no ofrece
clave idempotente: si acepta un mensaje y el proceso cae antes de persistir el
éxito, un reintento puede duplicarlo. También un fallo de red ambiguo puede haber
sido aceptado remotamente. No se debe prometer entrega exactamente una vez.

Lectura: `list_inventory_alert_channel_deliveries`, Operations, máximo 20,
tenant autenticado, 0 LLM / 0 tokens. Ejemplos: «¿Se envió por Telegram la alerta
de SKU-1?», «¿Qué notificaciones Telegram están pendientes?» y «¿Qué notificaciones
Telegram fallaron?». Pendientes incluye fallos con reintento; fallidas son
terminales. Sin chatId, payload, IDs, secretos ni lease en DTO/UI.
Reglas configuradas, eventos generados, entrega a Node-RED y envío Telegram son
consultas y estados separados.

P3 UX: cruzar stock mínimo y una regla personalizada puede generar **dos avisos**;
se distinguen por «Stock mínimo» tradicional y «Regla de stock personalizada».
No se fusionan en esta fase. Pruebas locales: `npm test`,
`npm run test:integration:alert-channels` con `MONGODB_TEST_URI` local terminada
en `_test`; Node-RED `npm test`; frontend `npm run test:ml-forecast`.
Los tests usan destinos/senders ficticios, nunca envían Telegram ni escriben cloud.

## Recuperación de conexión Telegram

En Integraciones, un usuario autenticado sin chat conectado puede solicitar
`POST /api/telegram/recovery/code` con body `{}`. El destino se obtiene únicamente
de su sesión y se verifica contra su usuario activo; no hay modelo Business
independiente en esta arquitectura. No se aceptan chatId, businessId ni userId
en el body. El código `TRF-` aleatorio de 64 bits vence a los 10 minutos; solo
se persiste su SHA-256. Una nueva solicitud invalida la anterior.

El usuario autoriza la transferencia enviando `/transfer CODIGO` en su chat
privado a @InventBil_bot. Solo el polling server-side autenticado a Telegram
procesa esa confirmación; no existe endpoint público para enviar updates ni
confirmar mediante chatId. Se comprueba que el remitente humano corresponde al
chat privado. Si el destino tiene otro chat, debe desconectarlo primero.

Una transacción Mongo libera el chat/código del origen, asigna el chat al
destino habilitándolo y consume el challenge. Los documentos de conexión y sus
preferencias permanecen por negocio; no se mueve historial ni datos comerciales.
Sin chat, el origen no es operativo aunque conserve enabled. Los índices únicos
y conflictos de escritura protegen concurrencia; un fallo revierte toda la
transferencia. Reutilizar el código no vuelve a mover el chat.

Límites: tres generaciones por negocio en 10 minutos, más el limiter HTTP por
usuario/negocio; cinco intentos de confirmación por chat en 10 minutos y 100
globales/minuto. Los límites de confirmación son in-process y se reinician con
el backend; el código fuerte, vencimiento y consumo son persistentes. Auditoría:
`telegram.connection.transferred`, solo negocios internos, actor y fecha; sin
chatId, código claro, email ni secretos. Registros usados se conservan para
auditoría/replay; el vencimiento se valida explícitamente, no por borrado TTL.

Validación local: `npm test` y `npm run test:integration:telegram-recovery`.
La integración exige Mongo local replica set y genera una base `_test` aislada
que elimina al terminar; prueba rollback, índice único, concurrencia e historial
inmutable con fixtures sintéticos. No envía Telegram real ni escribe Atlas.

## 📞 Support

For issues and questions:
- Check the API documentation at `/api/docs`
- Review error messages in response
- Check server logs for detailed errors

## 📄 License

This project is licensed under the ISC License.

## 🔄 Version History

- **v1.0.0**: Initial release with full feature set

---

**Happy Coding! 🚀**
