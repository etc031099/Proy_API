'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient } from '@/lib/api';
import { CreateProductData, Product, SupplierPrice } from '@/types';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/contexts/LanguageContext';

export default function EditProductPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const productId = params?.id ?? '';
  const { t } = useLanguage();

  const [formData, setFormData] = useState<CreateProductData & { _id?: string }>({
    name: '',
    description: '',
    price: 0,
    costPrice: 0,
    stock: 0,
    category: '',
    sku: '',
    minStockLevel: 0,
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [vendors, setVendors] = useState<{ _id: string; name: string }[]>([]);
  const [supplierPrices, setSupplierPrices] = useState<SupplierPrice[]>([]);
  const [preferredSupplierId, setPreferredSupplierId] = useState('');
  const [markupPercentage, setMarkupPercentage] = useState(30);

  useEffect(() => {
    const fetchProduct = async () => {
      if (!productId) {
        setInitialLoading(false);
        return;
      }

      try {
        const response = await apiClient.getProduct(productId);
        if (response.success) {
          const product: Product = response.data.product;
          setFormData({
            _id: product._id,
            name: product.name,
            description: product.description || '',
            price: product.price,
            costPrice: product.costPrice || 0,
            stock: product.stock,
            category: product.category,
            sku: product.sku || '',
            minStockLevel: product.minStockLevel,
          });
          setSupplierPrices(product.supplierPrices || []);
          setPreferredSupplierId(product.preferredSupplierId || '');
        } else {
          setError(response.message || 'Failed to load product');
        }
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to load product');
      } finally {
        setInitialLoading(false);
      }
    };

    fetchProduct();
  }, [productId]);

  useEffect(() => {
    apiClient.getVendors({ limit: 100 }).then(response => {
      if (response.success) setVendors(response.data?.vendors || response.data?.contacts || []);
    }).catch(() => undefined);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: name === 'price' || name === 'costPrice' || name === 'stock' || name === 'minStockLevel'
        ? parseFloat(value) || 0
        : value
    }));
  };

  const applySuggestedPrice = () => {
    const configuredSupplierCost = supplierPrices.find(entry => Number(entry.purchasePrice) > 0)?.purchasePrice;
    const cost = Number(formData.costPrice || configuredSupplierCost || 0);
    const markup = Math.min(99.99, Math.max(0, Number(markupPercentage) || 0));
    if (cost > 0) {
      setFormData(prev => ({ ...prev, price: Number((cost / (1 - markup / 100)).toFixed(2)) }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await apiClient.updateProduct(productId, {
        ...formData,
        supplierPrices,
        preferredSupplierId: preferredSupplierId || null,
        description: formData.description?.trim() || undefined,
        sku: formData.sku?.trim() || undefined,
      });

      if (response.success) {
        router.push('/products');
      } else {
        setError(response.message || 'Failed to update product');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update product');
    } finally {
      setLoading(false);
    }
  };

  if (initialLoading) {
    return (
      <ProtectedRoute>
        <Layout>
          <div className="flex items-center justify-center min-h-[300px]">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>

        </Layout>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
      <Layout>
        <div className="space-y-6">
          <div className="flex items-center space-x-2">
            <Link href="/products">
              <Button variant="outline" size="sm">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-3xl font-bold">{t('products.edit')}</h1>
              <p className="text-muted-foreground">{t('products.updateDescription')}</p>
            </div>
          </div>

          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>{t('products.details')}</CardTitle>
              <CardDescription>{t('products.updateInformation')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">{t('products.productName')} *</Label>
                    <Input
                      id="name"
                      name="name"
                      value={formData.name}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="category">{t('products.category')} *</Label>
                    <Input
                      id="category"
                      name="category"
                      value={formData.category}
                      onChange={handleChange}
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">{t('products.description')}</Label>
                  <Textarea
                    id="description"
                    name="description"
                    value={formData.description}
                    onChange={handleChange}
                    rows={3}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="price">{t('products.salePrice')} *</Label>
                    <Input
                      id="price"
                      name="price"
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.price}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="costPrice">{t('products.purchaseCost')} (USD)</Label>
                    <Input
                      id="costPrice"
                      name="costPrice"
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.costPrice}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stock">{t('products.stockQuantity')} *</Label>
                    <Input
                      id="stock"
                      name="stock"
                      type="number"
                      min="0"
                      value={formData.stock}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="minStockLevel">{t('products.minStock')}</Label>
                    <Input
                      id="minStockLevel"
                      name="minStockLevel"
                      type="number"
                      min="0"
                      value={formData.minStockLevel}
                      onChange={handleChange}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
                  <div className="space-y-2">
                    <Label htmlFor="markupPercentage">{t('products.suggestedMargin')}</Label>
                    <Input id="markupPercentage" type="number" min="0" max="99.99" step="0.01"
                      value={markupPercentage}
                      onChange={e => setMarkupPercentage(parseFloat(e.target.value) || 0)} />
                  </div>
                  <Button type="button" variant="outline" onClick={applySuggestedPrice}>
                    {t('products.applySuggestedPrice')}
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    Uses cost ÷ (1 − margin), and only changes the sale price when applied.
                  </p>
                </div>

                <div className="space-y-3">
                  <Label>{t('products.supplierPrices')}</Label>
                  <select
                    className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                    value={preferredSupplierId}
                    onChange={e => setPreferredSupplierId(e.target.value)}
                    disabled={supplierPrices.length === 0}
                  >
                    <option value="">{t('products.selectSupplier')}</option>
                    {vendors
                      .filter(vendor => supplierPrices.some(entry => entry.supplierId === vendor._id))
                      .map(vendor => <option key={vendor._id} value={vendor._id}>{vendor.name}</option>)}
                  </select>
                  <p className="text-xs text-muted-foreground">{t('products.preferredSupplierHelp')}</p>
                  {supplierPrices.map((entry, index) => (
                    <div key={`${entry.supplierId}-${index}`} className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                      <select className="h-10 min-w-0 w-full rounded-md border bg-background px-3 text-sm"
                        value={entry.supplierId}
                        onChange={e => setSupplierPrices(items => items.map((item, i) =>
                          i === index ? { ...item, supplierId: e.target.value } : item
                        ))}>
                        <option value="">{t('products.selectSupplier')}</option>
                        {vendors.map(vendor => <option key={vendor._id} value={vendor._id}>{vendor.name}</option>)}
                      </select>
                      <Input className="w-32 shrink-0" type="number" min="0" step="0.01"
                        value={entry.purchasePrice}
                        onChange={e => setSupplierPrices(items => items.map((item, i) =>
                          i === index ? { ...item, purchasePrice: parseFloat(e.target.value) || 0 } : item
                        ))} />
                      <Button type="button" variant="outline" className="w-full sm:w-auto"
                        onClick={() => {
                          if (entry.supplierId === preferredSupplierId) setPreferredSupplierId('');
                          setSupplierPrices(items => items.filter((_, i) => i !== index));
                        }}>{t('products.remove')}</Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline"
                    onClick={() => setSupplierPrices(items => [...items, { supplierId: '', purchasePrice: 0 }])}>
                    {t('products.addSupplierPrice')}
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="sku">{t('products.sku')}</Label>
                  <Input
                    id="sku"
                    name="sku"
                    value={formData.sku}
                    onChange={handleChange}
                    placeholder="e.g., PROD-001"
                  />
                </div>

                <div className="flex space-x-2">
                  <Button type="submit" disabled={loading}>
                    {loading ? t('products.saving') : t('products.saveChanges')}
                  </Button>
                  <Link href="/products">
                    <Button type="button" variant="outline">
                      {t('common.cancel')}
                    </Button>
                  </Link>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </Layout>
    </ProtectedRoute>
  );
}
