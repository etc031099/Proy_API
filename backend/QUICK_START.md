# 🚀 Quick Start Guide

## Prerequisites
- Node.js (v14+)
- MongoDB (local installation OR MongoDB Atlas account)

## 1. Install Dependencies
```bash
npm install
```

## 2. Setup Database

### Option A: Docker MongoDB replica set (recommended for local development)
1. Copy `.env.example` to `.env` and replace the MongoDB credential placeholders.
2. Start the single-node replica set named `rs0`:

```bash
docker compose up -d mongodb mongo-init
```

3. Confirm that MongoDB reports a PRIMARY:

```bash
docker compose exec mongodb sh -lc 'mongosh --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --quiet --eval "rs.status().members.map(({name,stateStr}) => ({name,stateStr}))"'
```

### Option B: MongoDB Atlas
1. Go to [MongoDB Atlas](https://cloud.mongodb.com/)
2. Create free cluster
3. Get connection string
4. Update `.env` file with your connection string

## 3. Environment Setup
```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your settings
# For MongoDB Atlas, update MONGODB_URI
# For production, change JWT_SECRET
```

## 4. Start Application
```bash
# Development mode
npm run dev

# Production mode
npm start
```

## 5. Test API
```bash
# Health check
curl http://localhost:5000/health

# API documentation
curl http://localhost:5000/api/docs

# Register user
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","password":"Password123","businessId":"test_business"}'
```

## 6. Test MongoDB Transactions

With `MONGODB_TEST_URI` pointing to the dedicated `inventory_billing_test`
database on `rs0`:

```bash
npm test
npm run test:integration
```

Stop or restart without deleting data:

```bash
docker compose restart mongodb
docker compose down
```

Use `docker compose down -v` only to intentionally erase the local database.

## 7. Import Postman Collection
1. Open Postman
2. Import `Inventory_Billing_API.postman_collection.json`
3. Import `Inventory_Billing.postman_environment.json`
4. Start testing all endpoints!

## 8. Deploy to Production
See `DEPLOYMENT.md` for detailed deployment instructions to Render.

---

**🎉 You're ready to go!**
