'use client';
import { RemoteEntitySelect } from '@/components/RemoteEntitySelect';
import { PaginationControls } from '@/components/PaginationControls';


import { useCallback, useEffect, useRef, useState } from 'react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiClient } from '@/lib/api';
import { openPrintDocument } from '@/lib/print-document';
import { useAuth } from '@/contexts/AuthContext';
import { InventoryReport, Contact, Transaction } from '@/types';
import { 
  Package, 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  AlertTriangle, 
  Users, 
  BarChart3,
  Download,
  RefreshCw
} from 'lucide-react';
import { FadeIn, SlideIn, StaggerContainer, StaggerItem } from '@/components/animations';
import { useLanguage } from '@/contexts/LanguageContext';

interface ContactReportData {
  customer?: Contact;
  vendor?: Contact;
  statistics: {
    totalPurchases: number;
    totalTransactions: number;
    averagePurchaseAmount: number;
    currentBalance: number;
    creditLimit?: number;
  };
  topProducts?: Array<{
    product: { name: string; category: string };
    totalQuantity: number;
    totalAmount: number;
    transactionCount: number;
  }>;
  monthlyBreakdown?: Array<{
    month: string;
    count: number;
    amount: number;
  }>;
}

interface TransactionReportData {
  recentTransactions: Transaction[];
  groupedData: Array<{
    period: string;
    sales: { count: number; amount: number };
    purchases: { count: number; amount: number };
  }>;
  range: {
    from: string | null;
    to: string | null;
    groupBy: string;
  };
  summary: {
    totalSales: number;
    totalPurchases: number;
    profit: number;
    salesCount: number;
    purchasesCount: number;
    averageSaleAmount: number;
    averagePurchaseAmount: number;
    currency?: 'PEN' | 'USD' | 'EUR';
  };
}

export default function ReportsPage() {
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const [activeTab, setActiveTab] = useState('inventory');
  const [loading, setLoading] = useState(false);
  
  // Inventory Report State
  const [inventoryPage, setInventoryPage] = useState(1);
  const [inventorySearch, setInventorySearch] = useState('');
  const [inventoryError, setInventoryError] = useState('');
  const inventoryRequest = useRef(0);
  const contactRequest = useRef(0);
  const [inventoryReport, setInventoryReport] = useState<InventoryReport | null>(null);
  const [inventoryFilters, setInventoryFilters] = useState({
    category: '',
    sortBy: 'name'
  });

  // Transaction Report State
  const [transactionReport, setTransactionReport] = useState<TransactionReportData | null>(null);
  const [transactionFilters, setTransactionFilters] = useState({
    startDate: '',
    endDate: '',
    type: ''
  });

  // Contact Reports State
  const [selectedContact, setSelectedContact] = useState<string>('');
  const [contactReport, setContactReport] = useState<ContactReportData | null>(null);

  const loadInventoryReport = useCallback(async () => {
    if (!user) return;
    
    const version = ++inventoryRequest.current;
    setLoading(true); setInventoryError('');
    try {
      const response = await apiClient.getInventoryReport({ ...inventoryFilters, search: inventorySearch, page: inventoryPage, limit: 20 });
      if (version !== inventoryRequest.current) return;
      if (response.success) {
        setInventoryReport(response.data); setInventoryPage(response.data.pagination.current);
      }
    } catch {
      if (version === inventoryRequest.current) setInventoryError('No fue posible cargar el inventario.');
    } finally {
      if (version === inventoryRequest.current) setLoading(false);
    }
  }, [user, inventoryPage, inventorySearch, inventoryFilters]);
  useEffect(() => { void loadInventoryReport(); }, [loadInventoryReport]);

  const loadTransactionReport = async () => {
    if (!user) return;
    
    setLoading(true);
    try {
      const response = await apiClient.getTransactionReport(transactionFilters);
      if (response.success) {
        setTransactionReport(response.data);
      }
    } catch (error) {
      console.error('Failed to load transaction report:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadContactReport = async (contactId: string, type: 'customer' | 'vendor') => {
    if (!user) return;
    const version = ++contactRequest.current;
    setContactReport(null);
    
    setLoading(true);
    try {
      const response = type === 'customer' 
        ? await apiClient.getCustomerReport(contactId)
        : await apiClient.getVendorReport(contactId);
      
      if (response.success && version === contactRequest.current) {
        setContactReport(response.data);
      }
    } catch (error) {
      console.error('Failed to load contact report:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount: number, currency = 'USD') => {
    return new Intl.NumberFormat(language === 'es' ? 'es-PE' : 'en-US', {
      style: 'currency',
      currency
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(language === 'es' ? 'es-PE' : 'en-US');
  };

  const getExportData = (inventory = inventoryReport) => {
    if (activeTab === 'inventory' && inventory) {
      return {
        title: t('reports.inventory'),
        headers: [t('reports.product'), 'SKU', t('reports.category'), t('reports.price'), t('reports.stock'), t('reports.status')],
        rows: inventory.products.map((product) => [
          product.name,
          product.sku,
          product.category,
          product.price,
          product.stock,
          product.stock === 0 ? t('reports.outOfStock') : product.stock <= product.minStockLevel ? t('reports.lowStock') : t('products.inStock')
        ]),
        summary: `${t('reports.totalProducts')}: ${inventory.statistics.totalProducts} | ${t('reports.totalValue')}: ${formatCurrency(inventory.statistics.totalValue, inventory.statistics.currency || 'PEN')}`
      };
    }

    if (activeTab === 'transactions' && transactionReport) {
      return {
        title: t('reports.transactionReport'),
        headers: [t('reports.date'), t('reports.type'), t('reports.contact'), t('reports.amount'), t('reports.currency')],
        rows: [
          [t('reports.totalSales'), transactionReport.summary.totalSales, '', '', ''],
          [t('reports.totalPurchases'), transactionReport.summary.totalPurchases, '', '', ''],
          [t('reports.netProfit'), transactionReport.summary.profit, '', '', ''],
          ...transactionReport.groupedData.map((period) => [
            period.period,
            t('reports.totalSales'),
            '',
            period.sales.amount,
            transactionReport.summary.currency || 'PEN'
          ]),
          ...transactionReport.groupedData.map((period) => [
            period.period,
            t('reports.totalPurchases'),
            '',
            period.purchases.amount,
            transactionReport.summary.currency || 'PEN'
          ])
        ],
        summary: `${t('reports.totalSales')}: ${formatCurrency(transactionReport.summary.totalSales, transactionReport.summary.currency || 'PEN')} | ${t('reports.totalPurchases')}: ${formatCurrency(transactionReport.summary.totalPurchases, transactionReport.summary.currency || 'PEN')} | ${t('reports.netProfit')}: ${formatCurrency(transactionReport.summary.profit, transactionReport.summary.currency || 'PEN')}`
      };
    }

    if ((activeTab === 'customers' || activeTab === 'vendors') && contactReport) {
      const contact = activeTab === 'customers' ? contactReport.customer : contactReport.vendor;
      return {
        title: activeTab === 'customers' ? t('reports.customerReports') : t('reports.vendorReports'),
        headers: [t('reports.product'), t('reports.category'), t('reports.amount'), t('reports.totalTransactions')],
        rows: (contactReport.topProducts || []).map((item) => [
          item.product.name,
          item.product.category,
          item.totalAmount,
          item.transactionCount
        ]),
        summary: `${contact?.name || ''} - ${t('reports.totalTransactions')}: ${contactReport.statistics.totalTransactions}`
      };
    }

    return null;
  };

  const escapeCsv = (value: unknown) => {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
  };

  const exportData = async () => {
    if (activeTab !== 'inventory') return getExportData();
    const response = await apiClient.getInventoryReport({ ...inventoryFilters, search: inventorySearch });
    if (!response.success) throw new Error('Export unavailable');
    return getExportData(response.data);
  };
  const exportAsExcel = async () => {
    const report = await exportData().catch(() => null);
    if (!report) {
      window.alert(t('reports.exportUnavailable'));
      return;
    }
    const csv = [report.headers, ...report.rows]
      .map((row) => row.map(escapeCsv).join(';'))
      .join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${report.title.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportAsPdf = async () => {
    const popup = window.open('', '_blank', 'width=1100,height=800');
    if (!popup) return;
    popup.opener = null;
    const report = await exportData().catch(() => null);
    if (!report) {
      popup.close();
      window.alert(t('reports.exportUnavailable'));
      return;
    }
    openPrintDocument({
      title: report.title,
      summary: report.summary,
      headers: report.headers,
      rows: report.rows
    }, 'width=1100,height=800', () => popup);
  };

  const canExport = Boolean(getExportData());

  return (
    <ProtectedRoute>
      <Layout>
        <FadeIn>
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold">{t('reports.title')}</h1>
                <p className="text-muted-foreground">{t('reports.subtitle')}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" className="gap-2" onClick={exportAsExcel} disabled={!canExport}>
                  <Download className="h-4 w-4" />
                  {t('reports.exportExcel')}
                </Button>
                <Button variant="outline" className="gap-2" onClick={exportAsPdf} disabled={!canExport}>
                  <Download className="h-4 w-4" />
                  {t('reports.exportPdf')}
                </Button>
              </div>
            </div>

            <Tabs value={activeTab} onValueChange={value => { contactRequest.current++; setActiveTab(value); setSelectedContact(''); setContactReport(null); }} className="space-y-6">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="inventory" className="gap-2">
                  <Package className="h-4 w-4" />
                  {t('reports.inventory')}
                </TabsTrigger>
                <TabsTrigger value="transactions" className="gap-2">
                  <BarChart3 className="h-4 w-4" />
                  {t('reports.transactions')}
                </TabsTrigger>
                <TabsTrigger value="customers" className="gap-2">
                  <Users className="h-4 w-4" />
                  {t('reports.customers')}
                </TabsTrigger>
                <TabsTrigger value="vendors" className="gap-2">
                  <Users className="h-4 w-4" />
                  {t('reports.vendors')}
                </TabsTrigger>
              </TabsList>

              {/* Inventory Report */}
              <TabsContent value="inventory" className="space-y-6">
                <Input aria-label="Buscar inventario" placeholder="Buscar producto o SKU" value={inventorySearch} onChange={e => { inventoryRequest.current++; setInventorySearch(e.target.value); setInventoryPage(1); }} />
                {inventoryError && <p role="alert">{inventoryError}</p>}
                {inventoryReport?.pagination && <PaginationControls page={inventoryPage} pageSize={20} total={inventoryReport.pagination.total} entity="productos" language={language} onPageChange={setInventoryPage} />}
                <SlideIn direction="up">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Package className="h-5 w-5" />
                        {t('reports.inventoryReport')}
                      </CardTitle>
                      <CardDescription>
                        {t('reports.inventoryDescription')}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {/* Filters */}
                      <div className="flex gap-4 mb-6 flex-wrap">
                        <div className="space-y-2">
                          <Label htmlFor="category">{t('reports.category')}</Label>
                          <Input
                            id="category"
                            placeholder={t('reports.categoryPlaceholder')}
                            value={inventoryFilters.category}
                            onChange={(e) => { inventoryRequest.current++; setInventoryPage(1); setInventoryFilters(prev => ({ ...prev, category: e.target.value })); }}
                          />
                        </div>
                        <div className="flex items-end">
                          <Button onClick={loadInventoryReport} className="gap-2">
                            <RefreshCw className="h-4 w-4" />
                            Refresh
                          </Button>
                        </div>
                      </div>

                      {loading ? (
                        <div className="flex items-center justify-center h-32">
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                        </div>
                      ) : inventoryReport ? (
                        <div className="space-y-6">
                          {/* Statistics Cards */}
                          <StaggerContainer>
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                              <StaggerItem>
                                <Card>
                                  <CardContent className="pt-6">
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <p className="text-sm font-medium text-muted-foreground">{t('reports.totalProducts')}</p>
                                        <p className="text-2xl font-bold">{inventoryReport.statistics.totalProducts}</p>
                                      </div>
                                      <Package className="h-8 w-8 text-blue-500" />
                                    </div>
                                  </CardContent>
                                </Card>
                              </StaggerItem>

                              <StaggerItem>
                                <Card>
                                  <CardContent className="pt-6">
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <p className="text-sm font-medium text-muted-foreground">{t('reports.totalValue')}</p>
                                        <p className="text-2xl font-bold">{formatCurrency(inventoryReport.statistics.totalValue, inventoryReport.statistics.currency || 'PEN')}</p>
                                      </div>
                                      <DollarSign className="h-8 w-8 text-green-500" />
                                    </div>
                                  </CardContent>
                                </Card>
                              </StaggerItem>

                              <StaggerItem>
                                <Card>
                                  <CardContent className="pt-6">
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <p className="text-sm font-medium text-muted-foreground">{t('reports.lowStock')}</p>
                                        <p className="text-2xl font-bold text-orange-500">{inventoryReport.statistics.lowStockCount}</p>
                                      </div>
                                      <AlertTriangle className="h-8 w-8 text-orange-500" />
                                    </div>
                                  </CardContent>
                                </Card>
                              </StaggerItem>

                              <StaggerItem>
                                <Card>
                                  <CardContent className="pt-6">
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <p className="text-sm font-medium text-muted-foreground">{t('reports.outOfStock')}</p>
                                        <p className="text-2xl font-bold text-red-500">{inventoryReport.statistics.outOfStockCount}</p>
                                      </div>
                                      <TrendingDown className="h-8 w-8 text-red-500" />
                                    </div>
                                  </CardContent>
                                </Card>
                              </StaggerItem>
                            </div>
                          </StaggerContainer>

                          {/* Products Table */}
                          <Card>
                            <CardHeader>
                              <CardTitle>{t('reports.productDetails')}</CardTitle>
                            </CardHeader>
                            <CardContent>
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>{t('reports.product')}</TableHead>
                                    <TableHead>{t('reports.category')}</TableHead>
                                    <TableHead>{t('reports.price')}</TableHead>
                                    <TableHead>{t('reports.stock')}</TableHead>
                                    <TableHead>{t('reports.status')}</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {inventoryReport.products.map((product) => (
                                    <TableRow key={product._id}>
                                      <TableCell>
                                        <div>
                                          <p className="font-medium">{product.name}</p>
                                          <p className="text-sm text-muted-foreground">{product.sku}</p>
                                        </div>
                                      </TableCell>
                                      <TableCell>{product.category}</TableCell>
                                      <TableCell>{formatCurrency(product.price, product.currency || 'USD')}</TableCell>
                                      <TableCell>{product.stock}</TableCell>
                                      <TableCell>
                                        {product.stock === 0 ? (
                                          <Badge variant="destructive">{t('reports.outOfStock')}</Badge>
                                        ) : product.stock <= product.minStockLevel ? (
                                          <Badge variant="secondary">{t('reports.lowStock')}</Badge>
                                        ) : (
                                          <Badge variant="default">{t('products.inStock')}</Badge>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </CardContent>
                          </Card>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                </SlideIn>
              </TabsContent>

              {/* Transaction Report */}
              <TabsContent value="transactions" className="space-y-6">
                <SlideIn direction="up">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <BarChart3 className="h-5 w-5" />
                        {t('reports.transactionReport')}
                      </CardTitle>
                      <CardDescription>
                        Analyze your sales and purchase transactions over time
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {/* Filters */}
                      <div className="flex gap-4 mb-6 flex-wrap">
                        <div className="space-y-2">
                          <Label htmlFor="startDate">{t('transactions.startDate')}</Label>
                          <Input
                            id="startDate"
                            type="date"
                            value={transactionFilters.startDate}
                            onChange={(e) => setTransactionFilters(prev => ({ ...prev, startDate: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="endDate">{t('transactions.endDate')}</Label>
                          <Input
                            id="endDate"
                            type="date"
                            value={transactionFilters.endDate}
                            onChange={(e) => setTransactionFilters(prev => ({ ...prev, endDate: e.target.value }))}
                          />
                        </div>
                        <div className="flex items-end">
                          <Button onClick={loadTransactionReport} className="gap-2">
                            <RefreshCw className="h-4 w-4" />
                            {t('reports.generateReport')}
                          </Button>
                        </div>
                      </div>

                      {loading ? (
                        <div className="flex items-center justify-center h-32">
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                        </div>
                      ) : transactionReport ? (
                        <div className="space-y-6">
                          {/* Summary Cards */}
                          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                            <Card>
                              <CardContent className="pt-6">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.totalSales')}</p>
                                    <p className="text-2xl font-bold text-green-600">{formatCurrency(transactionReport.summary.totalSales, transactionReport.summary.currency || 'PEN')}</p>
                                  </div>
                                  <TrendingUp className="h-8 w-8 text-green-500" />
                                </div>
                              </CardContent>
                            </Card>

                            <Card>
                              <CardContent className="pt-6">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.totalPurchases')}</p>
                                    <p className="text-2xl font-bold text-red-600">{formatCurrency(transactionReport.summary.totalPurchases, transactionReport.summary.currency || 'PEN')}</p>
                                  </div>
                                  <TrendingDown className="h-8 w-8 text-red-500" />
                                </div>
                              </CardContent>
                            </Card>

                            <Card>
                              <CardContent className="pt-6">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.netProfit')}</p>
                                    <p className={`text-2xl font-bold ${transactionReport.summary.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                      {formatCurrency(transactionReport.summary.profit, transactionReport.summary.currency || 'PEN')}
                                    </p>
                                  </div>
                                  <DollarSign className="h-8 w-8 text-blue-500" />
                                </div>
                              </CardContent>
                            </Card>

                            <Card>
                              <CardContent className="pt-6">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.avgSale')}</p>
                                    <p className="text-2xl font-bold">{formatCurrency(transactionReport.summary.averageSaleAmount, transactionReport.summary.currency || 'PEN')}</p>
                                  </div>
                                  <BarChart3 className="h-8 w-8 text-purple-500" />
                                </div>
                              </CardContent>
                            </Card>
                          </div>

                          {/* Aggregated periods */}
                          <Card>
                            <CardHeader>
                              <CardTitle>{t('reports.periodBreakdown')}</CardTitle>
                            </CardHeader>
                            <CardContent>
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>{t('reports.period')}</TableHead>
                                    <TableHead>{t('reports.totalSales')}</TableHead>
                                    <TableHead>{t('reports.totalPurchases')}</TableHead>
                                    <TableHead>{t('reports.totalTransactions')}</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {transactionReport.groupedData.slice(-12).map((period) => (
                                    <TableRow key={period.period}>
                                      <TableCell>{period.period}</TableCell>
                                      <TableCell className="text-green-600">
                                        {formatCurrency(period.sales.amount, transactionReport.summary.currency || 'PEN')}
                                      </TableCell>
                                      <TableCell className="text-red-600">
                                        {formatCurrency(period.purchases.amount, transactionReport.summary.currency || 'PEN')}
                                      </TableCell>
                                      <TableCell>{period.sales.count + period.purchases.count}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </CardContent>
                          </Card>

                          {/* Recent Transactions */}
                          <Card>
                            <CardHeader>
                              <CardTitle>{t('reports.recentTransactions')}</CardTitle>
                            </CardHeader>
                            <CardContent>
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>{t('reports.date')}</TableHead>
                                    <TableHead>{t('reports.type')}</TableHead>
                                    <TableHead>{t('reports.contact')}</TableHead>
                                    <TableHead>{t('reports.amount')}</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {transactionReport.recentTransactions.map((transaction) => (
                                    <TableRow key={transaction._id}>
                                      <TableCell>{formatDate(transaction.date)}</TableCell>
                                      <TableCell>
                                        <Badge variant={transaction.type === 'sale' ? 'default' : 'secondary'}>
                                          {transaction.type}
                                        </Badge>
                                      </TableCell>
                                      <TableCell>
                                        {transaction.type === 'sale' ? transaction.customerName : transaction.vendorName}
                                      </TableCell>
                                      <TableCell className={transaction.type === 'sale' ? 'text-green-600' : 'text-red-600'}>
                                        {formatCurrency(transaction.totalAmount, transaction.currency || 'PEN')}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </CardContent>
                          </Card>
                        </div>
                      ) : (
                        <div className="text-center py-8">
                          <p className="text-muted-foreground">{t('reports.generatePrompt')}</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </SlideIn>
              </TabsContent>

              {/* Customer Reports */}
              <TabsContent value="customers" className="space-y-6">
                <SlideIn direction="up">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Users className="h-5 w-5" />
                        {t('reports.customerReports')}
                      </CardTitle>
                      <CardDescription>
                        Detailed analysis of customer purchase behavior
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="customer">{t('reports.selectCustomer')}</Label>
                          <RemoteEntitySelect kind="customer" label="cliente" value={selectedContact} onChange={value => { setSelectedContact(value); if (value) loadContactReport(value, 'customer'); }} />
                        </div>

                        {contactReport && contactReport.customer && (
                          <div className="space-y-6 mt-6">
                            <div className="grid gap-4 md:grid-cols-3">
                              <Card>
                                <CardContent className="pt-6">
                                  <div className="text-center">
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.totalPurchases')}</p>
                                    <p className="text-2xl font-bold text-green-600">
                                      {formatCurrency(contactReport.statistics.totalPurchases)}
                                    </p>
                                  </div>
                                </CardContent>
                              </Card>

                              <Card>
                                <CardContent className="pt-6">
                                  <div className="text-center">
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.totalTransactions')}</p>
                                    <p className="text-2xl font-bold">{contactReport.statistics.totalTransactions}</p>
                                  </div>
                                </CardContent>
                              </Card>

                              <Card>
                                <CardContent className="pt-6">
                                  <div className="text-center">
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.averagePurchase')}</p>
                                    <p className="text-2xl font-bold">
                                      {formatCurrency(contactReport.statistics.averagePurchaseAmount)}
                                    </p>
                                  </div>
                                </CardContent>
                              </Card>
                            </div>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </SlideIn>
              </TabsContent>

              {/* Vendor Reports */}
              <TabsContent value="vendors" className="space-y-6">
                <SlideIn direction="up">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Users className="h-5 w-5" />
                        {t('reports.vendorReports')}
                      </CardTitle>
                      <CardDescription>
                        Analysis of vendor relationships and purchase patterns
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="vendor">{t('reports.selectVendor')}</Label>
                          <RemoteEntitySelect kind="vendor" label="proveedor" value={selectedContact} onChange={value => { setSelectedContact(value); if (value) loadContactReport(value, 'vendor'); }} />
                        </div>

                        {contactReport && contactReport.vendor && (
                          <div className="space-y-6 mt-6">
                            <div className="grid gap-4 md:grid-cols-3">
                              <Card>
                                <CardContent className="pt-6">
                                  <div className="text-center">
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.totalPurchases')}</p>
                                    <p className="text-2xl font-bold text-red-600">
                                      {formatCurrency(contactReport.statistics.totalPurchases)}
                                    </p>
                                  </div>
                                </CardContent>
                              </Card>

                              <Card>
                                <CardContent className="pt-6">
                                  <div className="text-center">
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.totalTransactions')}</p>
                                    <p className="text-2xl font-bold">{contactReport.statistics.totalTransactions}</p>
                                  </div>
                                </CardContent>
                              </Card>

                              <Card>
                                <CardContent className="pt-6">
                                  <div className="text-center">
                                    <p className="text-sm font-medium text-muted-foreground">{t('reports.averagePurchase')}</p>
                                    <p className="text-2xl font-bold">
                                      {formatCurrency(contactReport.statistics.averagePurchaseAmount)}
                                    </p>
                                  </div>
                                </CardContent>
                              </Card>
                            </div>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </SlideIn>
              </TabsContent>
            </Tabs>
          </div>
        </FadeIn>
      </Layout>
    </ProtectedRoute>
  );
}
