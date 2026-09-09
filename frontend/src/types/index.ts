// User types
export interface User {
  id: string;
  name: string;
  email: string;
  businessId: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  name: string;
  email: string;
  password: string;
  businessId: string;
}

// Product types
export interface Product {
  _id: string;
  name: string;
  description?: string;
  price: number;
  currency: 'PEN' | 'USD' | 'EUR';
  costPrice?: number;
  supplierPrices?: SupplierPrice[];
  preferredSupplierId?: string | null;
  stock: number;
  category: string;
  sku?: string;
  minStockLevel: number;
  businessId: string;
  isActive: boolean;
  isLowStock?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductData {
  name: string;
  description?: string;
  price: number;
  currency?: 'PEN' | 'USD' | 'EUR';
  costPrice?: number;
  supplierPrices?: SupplierPrice[];
  preferredSupplierId?: string | null;
  stock: number;
  category: string;
  sku?: string;
  minStockLevel?: number;
}

export interface SupplierPrice {
  supplierId: string;
  purchasePrice: number;
}

// Contact types
export interface Contact {
  _id: string;
  name: string;
  phone: string;
  documentType?: 'dni' | 'ruc';
  documentNumber?: string;
  email?: string;
  address: {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
  };
  latitude?: number;
  longitude?: number;
  type: 'customer' | 'vendor';
  businessId: string;
  creditLimit: number;
  currentBalance: number;
  balancesByCurrency?: {
    PEN: number;
    USD: number;
    EUR: number;
  };
  isActive: boolean;
  notes?: string;
  fullAddress?: string;
  contactInfo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContactData {
  name: string;
  phone: string;
  documentType?: 'dni' | 'ruc';
  documentNumber?: string;
  email?: string;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
  };
  latitude?: number;
  longitude?: number;
  type: 'customer' | 'vendor';
  creditLimit?: number;
  notes?: string;
}

// Transaction types
export interface TransactionItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  costPrice?: number;
  total: number;
}

export interface Transaction {
  _id: string;
  type: 'sale' | 'purchase';
  customerId?: string;
  customerName?: string;
  vendorId?: string;
  vendorName?: string;
  supplierId?: string;
  products: TransactionItem[];
  totalAmount: number;
  originalAmount?: number;
  currency?: 'PEN' | 'USD' | 'EUR';
  exchangeRate?: number;
  date: string;
  businessId: string;
  status: 'pending' | 'completed' | 'cancelled';
  paymentMethod: 'cash' | 'card' | 'bank_transfer' | 'credit' | 'crypto' | 'bitcoin' | 'tether' | 'wallet' | 'other';
  notes?: string;
  invoiceNumber?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTransactionData {
  type: 'sale' | 'purchase';
  customerId?: string;
  vendorId?: string;
  products: {
    productId: string;
    quantity: number;
    price: number;
    costPrice?: number;
  }[];
  paymentMethod?: string;
  notes?: string;
  currency?: 'PEN' | 'USD' | 'EUR';
  originalAmount?: number;
  exchangeRate?: number;
}

// Report types
export interface DashboardSummary {
  baseCurrency?: 'PEN' | 'USD' | 'EUR';
  overview: {
    totalProducts: number;
    totalCustomers: number;
    totalVendors: number;
    lowStockProductsCount: number;
  };
  monthly: {
    sales: number;
    purchases: number;
    profit: number;
    transactionCount: number;
  };
  yearly: {
    sales: number;
    purchases: number;
    profit: number;
    transactionCount: number;
  };
  lowStockProducts: Product[];
  recentTransactions: Transaction[];
}

export interface InventoryReport {
  products: Product[];
  statistics: {
    totalProducts: number;
    totalValue: number;
    lowStockCount: number;
    outOfStockCount: number;
    categories: number;
    currency?: 'PEN' | 'USD' | 'EUR';
  };
  lowStockProducts: Product[];
  outOfStockProducts: Product[];
  categoryBreakdown: Record<string, {
    count: number;
    totalStock: number;
    totalValue: number;
  }>;
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  errors?: Array<{
    field: string;
    message: string;
    value?: any;
  }>;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    current: number;
    pages: number;
    total: number;
    limit: number;
  };
}

// Auth context types
export interface AuthContextType {
  user: User | null;
  login: (credentials: LoginCredentials) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => void;
  loading: boolean;
  error: string | null;
}