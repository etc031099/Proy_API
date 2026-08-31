'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  ArrowLeft, 
  Receipt, 
  User, 
  Calendar, 
  CreditCard,
  Package,
  FileText
} from 'lucide-react';
import { api } from '@/lib/api';

interface AddressValue {
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}

interface Transaction {
  _id: string;
  type: 'sale' | 'purchase';
  totalAmount: number;
  originalAmount?: number;
  currency?: 'PEN' | 'USD' | 'EUR';
  exchangeRate?: number;
  date: string;
  status: string;
  customerId?: {
    _id: string;
    name: string;
    phone: string;
    email: string;
    address?: string | AddressValue;
  };
  vendorId?: {
    _id: string;
    name: string;
    phone: string;
    email: string;
    address?: string | AddressValue;
  };
  products: Array<{
    productId: {
      _id: string;
      name: string;
      category: string;
      sku: string;
    };
    productName: string;
    quantity: number;
    price: number;
    total: number;
  }>;
  paymentMethod: string;
  notes?: string;
  invoiceNumber?: string;
}

export default function TransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const resolvedParams = React.use(params);
  const transactionId = resolvedParams?.id ?? '';
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchTransaction = async () => {
      try {
        setLoading(true);
        const response = await api.getTransaction(transactionId);
        
        if (response.success) {
          setTransaction(response.data.transaction);
        } else {
          setError('Transaction not found');
        }
      } catch (err) {
        console.error('Error fetching transaction:', err);
        setError('Error loading transaction details');
      } finally {
        setLoading(false);
      }
    };

    if (transactionId) {
      fetchTransaction();
    }
  }, [transactionId]);

  const getTypeColor = (type: string) => {
    return type === 'sale' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      case 'cancelled': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const formatAddress = (address?: string | AddressValue) => {
    if (!address) return '';
    if (typeof address === 'string') return address;

    return [address.street, address.city, address.state, address.zipCode, address.country]
      .filter(Boolean)
      .join(', ');
  };

  const formatCurrency = (value: number, currency = 'PEN') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  };

  const formatPaymentMethod = (value?: string) => {
    if (!value) return 'Not specified';
    return value
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading transaction details...</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (error || !transaction) {
    return (
      <Layout>
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={() => router.push('/transactions')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Transactions
            </Button>
          </div>
          <Alert variant="destructive">
            <AlertDescription>{error || 'Transaction not found'}</AlertDescription>
          </Alert>
        </div>
      </Layout>
    );
  }

  const contact = transaction.customerId || transaction.vendorId;
  const contactAddress = formatAddress(contact?.address);
  const transactionCurrency = transaction.currency || 'USD';
  const exchangeRate = transaction.exchangeRate ?? 1;
  const originalAmount = transaction.originalAmount ?? transaction.totalAmount;
  const showConvertedBaseCurrency = transactionCurrency !== 'USD' && exchangeRate > 1;
  const displayOriginalCurrency = showConvertedBaseCurrency ? 'USD' : transactionCurrency;
  const displayExchangeRate = transactionCurrency === 'USD' ? 1 : exchangeRate;

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={() => router.push('/transactions')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Transaction Details</h1>
              <p className="text-muted-foreground">
                Transaction ID: {transaction._id}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Badge className={getTypeColor(transaction.type)}>
              {transaction.type}
            </Badge>
            <Badge className={getStatusColor(transaction.status)}>
              {transaction.status}
            </Badge>
          </div>
        </div>

        {/* Transaction Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5" />
              Transaction Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Date:</span>
                  <span className="font-medium">
                    {new Date(transaction.date).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Payment Method:</span>
                  <span className="font-medium">{formatPaymentMethod(transaction.paymentMethod)}</span>
                </div>

                {transaction.invoiceNumber && (
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Invoice:</span>
                    <span className="font-medium">{transaction.invoiceNumber}</span>
                  </div>
                )}

                {transaction.notes && (
                  <div className="flex items-start gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div>
                      <span className="text-sm text-muted-foreground">Notes:</span>
                      <p className="font-medium text-sm mt-1">{transaction.notes}</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-4 text-right">
                <div>
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className={`text-3xl font-bold ${
                    transaction.type === 'sale' ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {formatCurrency(transaction.totalAmount, transactionCurrency)}
                  </p>
                </div>
 
                {transaction.originalAmount !== undefined && (
                  <div className="rounded-lg border bg-muted/30 p-3 text-left">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Original Amount</div>
                    <div className="mt-1 font-medium">{formatCurrency(originalAmount, displayOriginalCurrency)}</div>
                    {transaction.exchangeRate && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Exchange rate: 1 USD = {displayExchangeRate.toFixed(4)} {transactionCurrency === 'USD' ? 'USD' : transactionCurrency}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Contact Information */}
        {contact && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                {transaction.type === 'sale' ? 'Customer' : 'Vendor'} Information
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="font-semibold text-lg">{contact.name}</h3>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <p>{contact.phone}</p>
                    <p>{contact.email}</p>
                    {contactAddress && <p>{contactAddress}</p>}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Product Details */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Products ({transaction.products.length})
            </CardTitle>
            <CardDescription>
              Items included in this transaction
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transaction.products.map((item, index) => (
                  <TableRow key={index}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{item.productName}</p>
                        {item.productId && (
                          <p className="text-sm text-muted-foreground">
                            ID: {item.productId._id}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{item.productId?.sku || 'N/A'}</TableCell>
                    <TableCell>{item.productId?.category || 'N/A'}</TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell className="text-right">{formatCurrency(item.price, transactionCurrency)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(item.total, transactionCurrency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Transaction Total */}
            <div className="border-t mt-4 pt-4">
              <div className="flex justify-end">
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className={`text-xl font-bold ${
                    transaction.type === 'sale' ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {formatCurrency(transaction.totalAmount, transactionCurrency)}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}