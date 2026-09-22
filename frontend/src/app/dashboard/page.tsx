'use client';

import { useEffect, useState } from 'react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import { DashboardSummary } from '@/types';
import { Package, Users, Receipt, TrendingUp, AlertTriangle, DollarSign } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [periodMode, setPeriodMode] = useState<'current' | 'latest'>('current');
  const { language, t } = useLanguage();

  useEffect(() => {
    loadDashboardData();
  }, [periodMode]);

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      const response = await apiClient.getDashboard({ period: periodMode });
      if (response.success) {
        setSummary(response.data);
      }

    } catch (error) {
      console.error('Failed to load dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <ProtectedRoute>
        <Layout>
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </Layout>
      </ProtectedRoute>
    );
  }

  const formatAmount = (amount?: number) =>
    new Intl.NumberFormat(language === 'es' ? 'es-PE' : 'en-US', {
      style: 'currency',
      currency: summary?.baseCurrency || 'PEN',
      minimumFractionDigits: 2,
    }).format(amount || 0);

  const formatPeriod = () => {
    if (!summary?.period) return '';
    const formatter = new Intl.DateTimeFormat(language === 'es' ? 'es-PE' : 'en-US', {
      year: 'numeric',
      month: 'long',
      timeZone: 'UTC'
    });
    return formatter.format(new Date(summary.period.monthFrom));
  };

  return (
    <ProtectedRoute>
      <Layout>
        <div className="space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold">{t('dashboard.title')}</h1>
              <p className="text-muted-foreground">{t('dashboard.subtitle')}</p>
              <p className="text-sm text-muted-foreground">
                {t('dashboard.periodShown')}: {formatPeriod()}
                {summary?.period.mode === 'latest' ? ` (${t('dashboard.latestPeriod')})` : ''}
              </p>
            </div>
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t('dashboard.periodMode')}
              <select
                className="h-9 rounded-md border border-input bg-background px-3"
                value={periodMode}
                onChange={(event) => setPeriodMode(event.target.value as 'current' | 'latest')}
              >
                <option value="current">{t('dashboard.currentPeriod')}</option>
                <option value="latest">{t('dashboard.latestPeriod')}</option>
              </select>
            </label>
          </div>

          {/* Overview Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('dashboard.totalProducts')}</CardTitle>
                <Package className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{summary?.overview.totalProducts || 0}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('dashboard.customers')}</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{summary?.overview.totalCustomers || 0}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('dashboard.vendors')}</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{summary?.overview.totalVendors || 0}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('dashboard.lowStockItems')}</CardTitle>
                <AlertTriangle className="h-4 w-4 text-orange-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-orange-500">
                  {summary?.overview.lowStockProductsCount || 0}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Financial Overview */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('dashboard.monthlySales')}</CardTitle>
                <DollarSign className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-500">
                  {formatAmount(summary?.monthly.sales)}
                </div>
                <p className="text-xs text-muted-foreground">
                  {summary?.monthly.transactionCount || 0} {t('dashboard.transactions')}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('dashboard.monthlyPurchases')}</CardTitle>
                <Receipt className="h-4 w-4 text-red-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-500">
                  {formatAmount(summary?.monthly.purchases)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('dashboard.monthlyProfit')}</CardTitle>
                <TrendingUp className="h-4 w-4 text-blue-500" />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${
                  (summary?.monthly.profit || 0) >= 0 ? 'text-green-500' : 'text-red-500'
                }`}>
                  {formatAmount(summary?.monthly.profit)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t('dashboard.yearlyPerformance')}</CardTitle>
                <TrendingUp className="h-4 w-4 text-purple-500" />
              </CardHeader>
              <CardContent>
                <div className="text-lg font-bold text-purple-500">
                  {formatAmount(summary?.yearly.sales)}
                </div>
                <p className="text-xs text-muted-foreground">{t('dashboard.annualSales')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('dashboard.annualProfit')}: {formatAmount(summary?.yearly.profit)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Recent Activity */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Low Stock Products */}
            <Card>
              <CardHeader>
                <CardTitle>{t('dashboard.lowStockProducts')}</CardTitle>
                <CardDescription>{t('dashboard.restockingDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                {summary?.lowStockProducts && summary.lowStockProducts.length > 0 ? (
                  <div className="space-y-2">
                    {summary.lowStockProducts.slice(0, 5).map((product) => (
                      <div key={product._id} className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{product.name}</p>
                          <p className="text-sm text-muted-foreground">{product.category}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-medium text-orange-500">{product.stock} {t('dashboard.itemsLeft')}</p>
                          <p className="text-sm text-muted-foreground">{t('dashboard.minimum')}: {product.minStockLevel}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">{t('dashboard.noLowStock')}</p>
                )}
              </CardContent>
            </Card>

            {/* Recent Transactions */}
            <Card>
              <CardHeader>
                <CardTitle>{t('dashboard.recentTransactions')}</CardTitle>
                <CardDescription>{t('dashboard.recentDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                {summary?.recentTransactions && summary.recentTransactions.length > 0 ? (
                  <div className="space-y-2">
                    {summary.recentTransactions.slice(0, 5).map((transaction) => (
                      <div key={transaction._id} className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">
                            {transaction.type === 'sale' ? transaction.customerName : transaction.vendorName}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {(transaction.type === 'sale' ? t('dashboard.sale') : t('dashboard.purchase'))} • {new Date(transaction.date).toLocaleDateString(language === 'es' ? 'es-PE' : 'en-US')}
                          </p>
                        </div>
                        <div className={`font-medium ${
                          transaction.type === 'sale' ? 'text-green-500' : 'text-red-500'
                        }`}>
                          {transaction.type === 'sale' ? '+' : '-'}{formatAmount(transaction.totalAmount)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">{t('dashboard.noRecentTransactions')}</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </Layout>
    </ProtectedRoute>
  );
}
