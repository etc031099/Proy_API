'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Plus, 
  Search, 
  Filter,
  ArrowUpDown,
  Eye,
  Calendar,
  DollarSign,
  TrendingUp,
  TrendingDown 
} from 'lucide-react';
import { api } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';

interface Transaction {
  _id: string;
  type: 'sale' | 'purchase';
  totalAmount: number;
  currency?: 'PEN' | 'USD' | 'EUR';
  date: string;
  status: string;
  customerName?: string;
  vendorName?: string;
  products: Array<{
    productName: string;
    quantity: number;
    price: number;
    total: number;
  }>;
  paymentMethod: string;
}

interface TransactionSummary {
  sales: {
    totalAmount: number;
    transactionCount: number;
    averageAmount: number;
  };
  purchases: {
    totalAmount: number;
    transactionCount: number;
    averageAmount: number;
  };
  profitLoss: number;
}

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const { t, language } = useLanguage();

  const fetchTransactions = async () => {
    try {
      setLoading(true);
      const params: Record<string, any> = { page, limit: 10 };
      
      if (typeFilter !== 'all') params.type = typeFilter;
      if (statusFilter !== 'all') params.status = statusFilter;
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const response = await api.getTransactions(params);
      if (response.success) {
        setTransactions(response.data.transactions);
        setTotalPages(response.data.pagination.pages);
      } else {
        setError('Failed to fetch transactions');
      }
    } catch (err) {
      setError('Error loading transactions');
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSummary = async () => {
    try {
      const params: Record<string, any> = {};
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const response = await api.getTransactionSummary(params);
      if (response?.success && response?.data?.summary) {
        setSummary(response.data.summary);
      } else {
        setSummary(null);
      }
    } catch (err) {
      console.error('Error fetching summary:', err);
      setSummary(null);
    }
  };

  useEffect(() => {
    fetchTransactions();
    fetchSummary();
  }, [page, typeFilter, statusFilter, startDate, endDate]);

  const filteredTransactions = transactions.filter(transaction => {
    const searchLower = searchTerm.toLowerCase();
    return (
      transaction.customerName?.toLowerCase().includes(searchLower) ||
      transaction.vendorName?.toLowerCase().includes(searchLower) ||
      transaction._id.toLowerCase().includes(searchLower) ||
      transaction.products.some(p => p.productName.toLowerCase().includes(searchLower))
    );
  });

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

  const formatMoney = (value: number, currency: string = 'USD') => {
    const normalizedCurrency = ['PEN', 'USD', 'EUR'].includes(currency) ? currency : 'USD';
    return new Intl.NumberFormat(language === 'es' ? 'es-PE' : 'en-US', {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  };

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t('transactions.title')}</h1>
            <p className="text-muted-foreground">
              {t('transactions.subtitle')}
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild>
              <Link href="/transactions/sale">
                <Plus className="mr-2 h-4 w-4" />
                {t('transactions.addSale')}
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/transactions/purchase">
                <Plus className="mr-2 h-4 w-4" />
                {t('transactions.addPurchase')}
              </Link>
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Summary Cards */}
        {summary && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('transactions.totalSales')}</CardTitle>
                <TrendingUp className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-500">
                  {formatMoney(summary?.sales?.totalAmount ?? 0, 'USD')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {(summary?.sales?.transactionCount) ?? 0} {t('transactions.transactions')}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('transactions.totalPurchases')}</CardTitle>
                <TrendingDown className="h-4 w-4 text-red-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-500">
                  {formatMoney(summary?.purchases?.totalAmount ?? 0, 'USD')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {(summary?.purchases?.transactionCount) ?? 0} {t('transactions.transactions')}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('transactions.profitLoss')}</CardTitle>
                <DollarSign className={`h-4 w-4 ${(summary?.profitLoss ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`} />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${(summary?.profitLoss ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {formatMoney(summary?.profitLoss ?? 0, 'USD')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {(summary?.profitLoss ?? 0) >= 0 ? t('transactions.profit') : t('transactions.loss')}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('transactions.avgSale')}</CardTitle>
                <ArrowUpDown className="h-4 w-4 text-blue-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-blue-500">
                  {formatMoney(summary?.sales?.averageAmount ?? 0, 'USD')}
                </div>
                <p className="text-xs text-muted-foreground">
                  Per transaction
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('transactions.filters')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('transactions.search')}</label>
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('transactions.searchPlaceholder')}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-8"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('transactions.type')}</label>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('transactions.allTypes')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('transactions.allTypes')}</SelectItem>
                    <SelectItem value="sale">{t('transactions.sales')}</SelectItem>
                    <SelectItem value="purchase">{t('transactions.purchases')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('transactions.status')}</label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('transactions.allStatuses')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('transactions.allStatuses')}</SelectItem>
                    <SelectItem value="completed">{t('transactions.completed')}</SelectItem>
                    <SelectItem value="pending">{t('transactions.pending')}</SelectItem>
                    <SelectItem value="cancelled">{t('transactions.cancelled')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('transactions.startDate')}</label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('transactions.endDate')}</label>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Transactions Table */}
        <Card>
          <CardHeader>
            <CardTitle>{t('transactions.history')}</CardTitle>
            <CardDescription>
              {filteredTransactions.length} of {transactions.length} transactions
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">{t('transactions.loading')}</p>
              </div>
            ) : filteredTransactions.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">{t('transactions.none')}</p>
              </div>
            ) : (
              <div className="space-y-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('transactions.date')}</TableHead>
                      <TableHead>{t('transactions.type')}</TableHead>
                      <TableHead>{t('transactions.contact')}</TableHead>
                      <TableHead>{t('transactions.products')}</TableHead>
                      <TableHead>{t('transactions.amount')}</TableHead>
                      <TableHead>{t('transactions.status')}</TableHead>
                      <TableHead>{t('transactions.payment')}</TableHead>
                      <TableHead className="text-right">{t('transactions.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTransactions.map((transaction) => (
                      <TableRow key={transaction._id}>
                        <TableCell>
                          {new Date(transaction.date).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Badge className={getTypeColor(transaction.type)}>
                            {transaction.type}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {transaction.customerName || transaction.vendorName || 'N/A'}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {transaction.products.slice(0, 2).map((product, index) => (
                              <div key={index} className="text-sm">
                                {product.productName} (×{product.quantity})
                              </div>
                            ))}
                            {transaction.products.length > 2 && (
                              <div className="text-sm text-muted-foreground">
                                +{transaction.products.length - 2} more
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className={`font-medium ${
                            transaction.type === 'sale' ? 'text-green-600' : 'text-red-600'
                          }`}>
                            {formatMoney(transaction.totalAmount, transaction.currency || 'USD')}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge className={getStatusColor(transaction.status)}>
                            {transaction.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="capitalize">
                          {transaction.paymentMethod}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/transactions/${transaction._id}`}>
                              <Eye className="h-4 w-4" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* Pagination */}
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}