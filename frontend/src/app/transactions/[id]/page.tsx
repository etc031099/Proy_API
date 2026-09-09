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
  , Printer, Copy
} from 'lucide-react';
import { api } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';

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
  customerName?: string;
  vendorName?: string;
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
  const [cancelling, setCancelling] = useState(false);
  const { t, language } = useLanguage();

  const cancelTransaction = async () => {
    if (!transaction || !window.confirm(t('transactions.cancelConfirm'))) return;
    try {
      setCancelling(true);
      setError('');
      const response = await api.updateTransactionStatus(transaction._id, 'cancelled');
      if (!response.success) {
        setError(response.message || t('transactions.cancelError'));
        return;
      }
      setTransaction(response.data.transaction);
    } catch (err: any) {
      setError(err.response?.data?.message || t('transactions.cancelError'));
    } finally {
      setCancelling(false);
    }
  };

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
    const labels: Record<string, string> = {
      cash: t('transactions.paymentCash'),
      card: t('transactions.paymentCard'),
      bank_transfer: t('transactions.paymentTransfer'),
      wallet: t('transactions.paymentWallet'),
      credit: t('transactions.paymentCredit'),
      crypto: language === 'es' ? 'Criptomoneda' : 'Cryptocurrency',
      bitcoin: 'Bitcoin',
      tether: 'Tether',
      other: language === 'es' ? 'Otro' : 'Other'
    };
    return labels[value || ''] || value || t('transactions.paymentNotSpecified');
  };

  const printReceipt = () => {
    if (!transaction) return;
    const printWindow = window.open('', '_blank', 'width=800,height=900');
    if (!printWindow) return;
    const rows = transaction.products.map((item) => `
      <tr><td>${item.productName}</td><td>${item.quantity}</td>
      <td>${formatCurrency(item.price, transactionCurrency)}</td>
      <td>${formatCurrency(item.total, transactionCurrency)}</td></tr>
    `).join('');
    printWindow.document.write(`
      <html><head><title>${t('transactions.receiptTitle')}</title>
      <style>body{font-family:Arial,sans-serif;padding:28px;color:#111;max-width:760px;margin:auto}
      h1{margin-bottom:4px}small{color:#666}table{width:100%;border-collapse:collapse;margin-top:24px}
      th,td{border-bottom:1px solid #ddd;padding:9px;text-align:left}th{background:#f3f4f6}
      .total{text-align:right;font-size:18px;font-weight:bold;margin-top:20px}</style></head>
      <body><h1>${t('transactions.receiptTitle')}</h1>
      <small>${t('transactions.receiptNumber')}: ${transaction._id}</small><br/>
      <small>${t('transactions.date')}: ${new Date(transaction.date).toLocaleString(language === 'es' ? 'es-PE' : 'en-US')}</small>
      <p><strong>${transaction.type === 'sale' ? t('transactions.customer') : t('transactions.vendor')}:</strong>
      ${transaction.type === 'sale' ? transaction.customerId?.name || t('transactions.finalConsumer') : transaction.vendorId?.name || t('transactions.unknownVendor')}</p>
      <table><thead><tr><th>${t('transactions.product')}</th><th>${t('transactions.quantity')}</th><th>${t('transactions.unitPrice')}</th><th>${t('transactions.total')}</th></tr></thead>
      <tbody>${rows}</tbody></table><div class="total">${t('transactions.totalAmount')}: ${formatCurrency(transaction.totalAmount, transactionCurrency)}</div>
      <p>${t('transactions.paymentMethod')}: ${formatPaymentMethod(transaction.paymentMethod)}</p>
      </body></html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  const repeatSale = () => {
    if (!transaction || transaction.type !== 'sale') return;
    sessionStorage.setItem('repeat-sale', JSON.stringify({
      customerId: transaction.customerId?._id || '',
      customerName: transaction.customerId?.name || transaction.customerName || '',
      currency: transaction.currency || 'PEN',
      products: transaction.products.map((item) => ({
        productId: item.productId._id,
        quantity: item.quantity,
        price: item.price
      }))
    }));
    router.push('/transactions/sale');
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
  const showConvertedBaseCurrency = transactionCurrency !== 'USD';
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
            <Button variant="outline" onClick={printReceipt}>
              <Printer className="mr-2 h-4 w-4" />
              {t('transactions.printReceipt')}
            </Button>
            {transaction.type === 'sale' && transaction.status === 'completed' && (
              <Button variant="outline" onClick={repeatSale}>
                <Copy className="mr-2 h-4 w-4" />
                {t('transactions.repeatSale')}
              </Button>
            )}
            <Badge className={getTypeColor(transaction.type)}>
              {transaction.type}
            </Badge>
            <Badge className={getStatusColor(transaction.status)}>
              {transaction.status}
            </Badge>
            {transaction.status === 'completed' && (
              <Button variant="destructive" onClick={cancelTransaction} disabled={cancelling}>
                {cancelling ? t('transactions.cancelling') : t('transactions.cancelTransaction')}
              </Button>
            )}
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
                    {new Date(transaction.date).toLocaleDateString(language === 'es' ? 'es-PE' : 'en-US', {
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