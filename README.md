# 📦 Inventory & Billing Management System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-6.0+-green.svg)](https://www.mongodb.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A comprehensive, modern inventory and billing management system designed for small to medium-sized businesses. Built with a powerful tech stack including Next.js 15, Node.js, Express, and MongoDB, this system provides a complete solution for managing products, customers, vendors, transactions, and generating insightful reports.

## ✨ Features

### Core Functionality
- **🔐 Authentication & Authorization**: Secure JWT-based authentication with role-based access control
- **📦 Product Management**: Complete CRUD operations for inventory items with stock tracking
- **👥 Contact Management**: Manage both customers and vendors in a unified system
- **💰 Transaction Processing**: Handle purchases and sales with automatic inventory updates
- **📊 Reporting & Analytics**: Real-time dashboards with sales trends, inventory status, and financial summaries
- **🌓 Dark Mode Support**: Modern UI with light/dark theme toggle
- **📱 Responsive Design**: Fully responsive interface that works on all devices

### Technical Features
- **⚡ Real-time Updates**: Instant inventory updates on transactions
- **🔒 Security First**: Helmet.js, CORS, rate limiting, and input validation
- **🐳 Docker Support**: Easy deployment with Docker and Docker Compose
- **📝 API Documentation**: Comprehensive Postman collection included
- **🎨 Modern UI**: Built with Shadcn/ui components and Tailwind CSS
- **🚀 Performance**: Optimized with Next.js 15 Turbopack

## 🛠️ Tech Stack

### Backend
- **Runtime**: Node.js (v18+)
- **Framework**: Express.js 5
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT (jsonwebtoken)
- **Security**: Helmet.js, bcrypt, express-rate-limit
- **Validation**: express-validator
- **Logging**: Morgan

### Frontend
- **Framework**: Next.js 15 with TypeScript
- **UI Components**: Shadcn/ui
- **Styling**: Tailwind CSS
- **Forms**: React Hook Form with Zod validation
- **State Management**: React Context API
- **HTTP Client**: Axios
- **Charts**: Recharts
- **Animations**: Framer Motion

## 📋 Prerequisites

Before you begin, ensure you have the following installed:
- **Node.js** (v18.0.0 or higher)
- **npm** or **yarn** package manager
- **MongoDB** (v6.0 or higher) - Local or Atlas
- **Git** for version control
- **Docker** (optional, for containerized deployment)

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/Inventory-Billing-Management-System.git
cd Inventory-Billing-Management-System
```

### 2. Backend Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Configure your .env file with:
# - MongoDB connection string
# - JWT secret
# - Port configuration
# Edit .env with your preferred editor

# Start development server
npm run dev
```

### 3. Frontend Setup

```bash
# In a new terminal, navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Create environment file
cp .env.example .env.local

# Configure your .env.local file with:
# - Backend API URL (default: http://localhost:5000)
# Edit .env.local with your preferred editor

# Start development server
npm run dev
```

### 4. Access the Application

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:5000
- **API Documentation**: Import the Postman collection from `backend/Inventory_Billing_API.postman_collection.json`

## 🐳 Docker Deployment

The Docker environment uses the single-node MongoDB replica set `rs0`, which is
required by sales, purchases, cancellations, and credit-payment transactions.
Configure the Mongo credentials and both host/container MongoDB URIs in
`backend/.env` using `backend/.env.example` as the template.

```bash
# Navigate to backend directory
cd backend

# Validate and start MongoDB, replica-set initialization, and the API
docker compose config
docker compose up -d mongodb mongo-init api

# View logs
docker compose logs -f mongodb mongo-init api

# Confirm rs0 has a PRIMARY
docker compose exec mongodb sh -lc 'mongosh --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --quiet --eval "rs.status().members.map(({name,stateStr}) => ({name,stateStr}))"'

# Stop containers
docker compose down
```

The persistent `mongodb_data` volume survives normal stops and restarts. Use
`docker compose down -v` only when intentionally deleting local database data.

## 📁 Project Structure

```
Inventory-Billing-Management-System/
├── backend/
│   ├── src/
│   │   ├── app.js              # Express app entry point
│   │   ├── config/             # Configuration files
│   │   ├── controllers/        # Route controllers
│   │   ├── middleware/         # Custom middleware
│   │   ├── models/            # Mongoose models
│   │   ├── routes/            # API routes
│   │   └── utils/             # Utility functions
│   ├── .env.example           # Environment variables template
│   ├── docker-compose.yml     # Docker compose configuration
│   ├── Dockerfile             # Docker image configuration
│   └── package.json           # Backend dependencies
│
├── frontend/
│   ├── src/
│   │   ├── app/              # Next.js app directory
│   │   ├── components/       # React components
│   │   ├── contexts/         # React contexts
│   │   ├── hooks/           # Custom React hooks
│   │   ├── lib/             # Utility libraries
│   │   ├── services/        # API service functions
│   │   └── types/           # TypeScript type definitions
│   ├── public/              # Static assets
│   ├── .env.example         # Frontend environment template
│   └── package.json         # Frontend dependencies
│
├── LICENSE                  # MIT License
├── README.md               # Project documentation
└── CONTRIBUTING.md         # Contribution guidelines
```

## 🔧 Configuration

### Backend Environment Variables

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# Database (MongoDB replica set `rs0` running in Docker)
MONGODB_REPLICA_SET=rs0
MONGODB_URI=mongodb://user:password@localhost:27017/inventory_billing?authSource=admin&replicaSet=rs0&directConnection=true
# For MongoDB Atlas, replace the URI and leave MONGODB_REPLICA_SET unset unless
# it matches the replica-set name reported by Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/inventory_billing

# Authentication
JWT_SECRET=
JWT_EXPIRE=7d

# CORS
FRONTEND_URL=http://localhost:3000
```

`JWT_SECRET` is mandatory and must be a random value of at least 32 characters.
Generate it locally and store it only in the untracked backend `.env` or the
deployment secret manager:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

### Frontend Environment Variables

```env
# API Configuration
NEXT_PUBLIC_API_URL=http://localhost:5000/api

# Application Settings
NEXT_PUBLIC_APP_NAME=Inventory & Billing System
NEXT_PUBLIC_APP_VERSION=1.0.0
```

## 📚 API Documentation

The API follows RESTful principles with the following main endpoints:

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `GET /api/auth/profile` - Get user profile
- `PUT /api/auth/profile` - Update profile
- `PUT /api/auth/change-password` - Change password

### Products
- `GET /api/products` - List all products
- `GET /api/products/:id` - Get product details
- `POST /api/products` - Create new product
- `PUT /api/products/:id` - Update product
- `DELETE /api/products/:id` - Delete product

### Contacts
- `GET /api/contacts` - List all contacts
- `GET /api/contacts/:id` - Get contact details
- `POST /api/contacts` - Create new contact
- `PUT /api/contacts/:id` - Update contact
- `DELETE /api/contacts/:id` - Delete contact

### Transactions
- `GET /api/transactions` - List all transactions
- `GET /api/transactions/:id` - Get transaction details
- `POST /api/transactions` - Create new transaction
- `PUT /api/transactions/:id` - Update transaction
- `DELETE /api/transactions/:id` - Delete transaction

### Reports
- `GET /api/reports/dashboard` - Dashboard statistics
- `GET /api/reports/sales` - Sales reports
- `GET /api/reports/inventory` - Inventory reports
- `GET /api/reports/financial` - Financial summaries

For detailed API documentation, import the Postman collection located at `backend/Inventory_Billing_API.postman_collection.json`.

## 🧪 Testing

### Backend Testing

```bash
cd backend
npm test
```

### Frontend Testing

```bash
cd frontend
npm test
```

### End-to-End Testing

```bash
# Run both frontend and backend
# Then run E2E tests
npm run test:e2e
```

## 🤝 Contributing

We welcome contributions from the community! Please read our [Contributing Guidelines](CONTRIBUTING.md) to get started.

### How to Contribute

1. **Fork the repository**
2. **Create your feature branch** (`git checkout -b feature/AmazingFeature`)
3. **Commit your changes** (`git commit -m 'Add some AmazingFeature'`)
4. **Push to the branch** (`git push origin feature/AmazingFeature`)
5. **Open a Pull Request**

### Development Guidelines

- Follow the existing code style and conventions
- Write clear, descriptive commit messages
- Add tests for new features
- Update documentation as needed
- Ensure all tests pass before submitting PR

## 🐛 Bug Reports & Feature Requests

Found a bug or have a feature request? Please check the [existing issues](https://github.com/janvi100104/Inventory-Billing-Management-System/issues) first, then feel free to [open a new issue](https://github.com/100104/Inventory-Billing-Management-System/issues/new).

### Issue Templates

We provide templates for:
- 🐛 Bug Reports
- ✨ Feature Requests
- 📚 Documentation Improvements
- 💬 Questions

## 📈 Roadmap

### Version 1.1 (Q2 2025)
- [ ] Multi-language support
- [ ] Advanced reporting with PDF export
- [ ] Barcode/QR code scanning
- [ ] Email notifications
- [ ] Backup and restore functionality

### Version 1.2 (Q3 2025)
- [ ] Mobile applications (iOS/Android)
- [ ] Multi-warehouse support
- [ ] Advanced user roles and permissions
- [ ] Integration with accounting software
- [ ] Real-time collaboration features

### Version 2.0 (Q4 2025)
- [ ] AI-powered demand forecasting
- [ ] Automated reordering system
- [ ] Customer portal
- [ ] Advanced analytics dashboard
- [ ] Plugin system for extensions

## 👥 Team

- **Janvi Singhal** - *Initial work* - [GitHub Profile](https://github.com/janvi100104)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Thanks to all contributors who have helped shape this project
- Special thanks to the open-source community for the amazing tools and libraries
- Inspired by modern inventory management best practices

## 💬 Support

For support, please:
1. Check the [Documentation](https://github.com/janvi100104Inventory-Billing-Management-System/wiki)
2. Search [existing issues](https://github.com/janvi100104/Inventory-Billing-Management-System/issues)
3. Join our [Discord community](https://discord.gg/yourdiscord)
4. Email us at support@yourdomain.com

---


<p align="center">
  Made with ❤️ by the community
</p>
