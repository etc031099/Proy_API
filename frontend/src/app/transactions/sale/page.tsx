'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { 
  Plus, 
  Minus, 
  Save, 
  ArrowLeft,
  ShoppingCart 
  , UserPlus, Search
} from 'lucide-react';
import { api } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';

// Form validation schema
const saleFormSchema = z.object({
  customerId: z.string().optional(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerEmail: z.string().email().optional().or(z.literal('')),
  saveCustomer: z.boolean().default(false),
  paymentMethod: z.enum(['cash', 'credit', 'card', 'bank_transfer', 'wallet'], {
    required_error: 'Payment method is required',
  }),
  currency: z.enum(['PEN', 'USD', 'EUR'], {
    required_error: 'Currency is required',
  }),
  notes: z.string().optional(),
  products: z.array(z.object({
    productId: z.string().min(1, 'Product is required'),
    quantity: z.number().min(1, 'Quantity must be at least 1'),
    price: z.number().min(0, 'Price must be positive'),
  })).min(1, 'At least one product is required'),
}).superRefine((data, context) => {
  if (data.paymentMethod === 'credit' && !data.customerId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customerId'],
      message: 'A registered customer is required for credit sales'
    });
  }
});

type SaleFormValues = z.infer<typeof saleFormSchema>;

interface Customer {
  _id: string;
  name: string;
  email: string;
  phone: string;
  currentBalance?: number;
  creditLimit?: number;
  balancesByCurrency?: { PEN: number; USD: number; EUR: number };
}

interface Product {
  _id: string;
  name: string;
  price: number;
  currency?: 'PEN' | 'USD' | 'EUR';
  stock: number;
  category: string;
  sku: string;
}

export default function AddSalePage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const { t } = useLanguage();

  const form = useForm<SaleFormValues>({
    resolver: zodResolver(saleFormSchema),
    defaultValues: {
      customerId: '',
      customerName: '',
      customerPhone: '',
      customerEmail: '',
      saveCustomer: false,
      paymentMethod: 'cash',
      currency: 'PEN',
      notes: '',
      products: [{ productId: '', quantity: 1, price: 0 }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'products',
  });

  // Fetch customers and products
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [customersResponse, productsResponse] = await Promise.all([
          api.getContacts({ type: 'customer' }),
          api.getProducts()
        ]);

        if (customersResponse.success) {
          setCustomers(customersResponse.data.contacts);
        }

        if (productsResponse.success) {
          setProducts(productsResponse.data.products);
        }
      } catch (err) {
        console.error('Error fetching data:', err);
        setError('Failed to load data');
      }
    };

    fetchData();
  }, []);

  useEffect(() => {
    const savedSale = window.sessionStorage.getItem('repeat-sale');
    if (!savedSale) return;
    try {
      const repeated = JSON.parse(savedSale);
      form.reset({
        customerId: repeated.customerId || '',
        customerName: repeated.customerName || '',
        customerPhone: '',
        customerEmail: '',
        saveCustomer: false,
        paymentMethod: 'cash',
        currency: repeated.currency || 'PEN',
        notes: '',
        products: repeated.products?.length
          ? repeated.products
          : [{ productId: '', quantity: 1, price: 0 }]
      });
      window.sessionStorage.removeItem('repeat-sale');
    } catch {
      window.sessionStorage.removeItem('repeat-sale');
    }
  }, [form]);

  // Update price when product is selected
  const handleProductChange = (index: number, productId: string) => {
    const selectedProduct = products.find(p => p._id === productId);
    if (selectedProduct) {
      const customerKey = form.getValues('customerId') || 'final-consumer';
      const savedPrice = window.localStorage.getItem(`sale-price:${customerKey}:${productId}`);
      form.setValue(`products.${index}.price`, savedPrice ? Number(savedPrice) : selectedProduct.price);
    }
  };

  const saveLastPrice = (productId: string, price: number) => {
    const customerKey = form.getValues('customerId') || 'final-consumer';
    if (productId && Number.isFinite(price) && price >= 0) {
      window.localStorage.setItem(`sale-price:${customerKey}:${productId}`, String(price));
    }
  };

  const getCurrencyRate = (currency: 'PEN' | 'USD' | 'EUR') => {
    switch (currency) {
      case 'PEN':
        return 3.7;
      case 'EUR':
        return 0.92;
      case 'USD':
      default:
        return 1;
    }
  };

  const convertAmountToSelectedCurrency = (value: number, sourceCurrency: 'PEN' | 'USD' | 'EUR' = 'USD') => {
    const selectedCurrency = form.watch('currency');
    return value * getCurrencyRate(selectedCurrency) / getCurrencyRate(sourceCurrency);
  };

  // Calculate total amount in the selected transaction currency.
  const calculateTotal = () => {
    const lineItems = form.watch('products');
    return lineItems.reduce((total, product) => {
      const numericPrice = Number(product.price || 0);
      const numericQuantity = Number(product.quantity || 0);
      const selectedProduct = products.find(item => item._id === product.productId);
      const sourceCurrency = selectedProduct?.currency || 'USD';
      return total + convertAmountToSelectedCurrency(numericQuantity * numericPrice, sourceCurrency);
    }, 0);
  };

  const onSubmit = async (data: SaleFormValues) => {
    try {
      setLoading(true);
      setError('');

      let customerId = data.customerId || undefined;
      if (showNewCustomer && data.saveCustomer) {
        const customerName = data.customerName?.trim();
        if (!customerName) {
          setError(t('transactions.customerNameRequired'));
          return;
        }
        if (!data.customerPhone?.trim()) {
          setError(t('transactions.customerPhoneRequired'));
          return;
        }
        const contactResponse = await api.createContact({
          name: customerName,
          phone: data.customerPhone.trim(),
          email: data.customerEmail?.trim() || undefined,
          type: 'customer'
        });
        if (!contactResponse.success) {
          setError(contactResponse.message || t('transactions.customerCreateError'));
          return;
        }
        customerId = contactResponse.data.contact._id;
      }

      const saleData = {
        type: 'sale',
        customerId,
        customerName: showNewCustomer ? data.customerName?.trim() : undefined,
        products: data.products,
        paymentMethod: data.paymentMethod,
        currency: data.currency,
        notes: data.notes,
      };

      data.products.forEach((item) => saveLastPrice(item.productId, item.price));

      const response = await api.createTransaction(saleData);

      if (response.success) {
        setSuccess('Sale recorded successfully!');
        setTimeout(() => {
          router.push('/transactions');
        }, 2000);
      } else {
        setError(response.message || 'Failed to record sale');
      }
    } catch (err: unknown) {
      console.error('Error creating sale:', err);
      const responseData = (err as any).response?.data;
      const validationDetails = responseData?.errors
        ?.map((item: { message?: string }) => item.message)
        .filter(Boolean)
        .join(' ');
      setError(validationDetails || responseData?.message || 'Error recording sale');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('transactions.back')}
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t('transactions.addSaleTitle')}</h1>
            <p className="text-muted-foreground">
              {t('transactions.saleDescription')}
            </p>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert>
            <AlertDescription className="text-green-600">{success}</AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Customer & Payment Info */}
            <Card>
              <CardHeader>
                <CardTitle>{t('transactions.customerPayment')}</CardTitle>
                <CardDescription>
                  {t('transactions.selectCustomer')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="customerId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('transactions.customer')}</FormLabel>
                        <Input
                          value={customerSearch}
                          onChange={(event) => setCustomerSearch(event.target.value)}
                          placeholder={t('transactions.searchCustomers')}
                          className="mb-2"
                        />
                        <Select onValueChange={(value) => field.onChange(value === 'none' ? '' : value)} value={field.value || 'none'}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('transactions.selectCustomerPlaceholder')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">{t('transactions.finalConsumer')}</SelectItem>
                            {customers
                              .filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(customerSearch.toLowerCase()))
                              .map((customer) => (
                              <SelectItem key={customer._id} value={customer._id}>
                                {customer.name} - {customer.phone}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                        {form.watch('paymentMethod') === 'credit' && form.watch('customerId') && (() => {
                          const customer = customers.find((item) => item._id === form.watch('customerId'));
                          if (!customer) return null;
                          const selectedCurrency = form.watch('currency');
                          const balance = Number(customer.balancesByCurrency?.[selectedCurrency] || (selectedCurrency === 'PEN' ? customer.currentBalance : 0));
                          const limit = Number(customer.creditLimit || 0);
                          return (
                            <div className="rounded-md bg-muted p-3 text-sm">
                              <div className="font-medium">{t('transactions.currentBalance')}: {selectedCurrency} {balance.toFixed(2)}</div>
                              {limit > 0 && selectedCurrency === 'PEN' && <div className="text-muted-foreground">{t('transactions.availableCredit')}: PEN {Math.max(0, limit - balance).toFixed(2)}</div>}
                            </div>
                          );
                        })()}
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto px-0 text-xs"
                          onClick={() => {
                            setShowNewCustomer((visible) => !visible);
                            form.setValue('customerId', '');
                          }}
                        >
                          <UserPlus className="mr-1 h-3.5 w-3.5" />
                          {t('transactions.registerNewCustomer')}
                        </Button>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="paymentMethod"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('transactions.paymentMethod')} *</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('transactions.selectPayment')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="cash">{t('transactions.paymentCash')}</SelectItem>
                            <SelectItem value="card">{t('transactions.paymentCard')}</SelectItem>
                            <SelectItem value="bank_transfer">{t('transactions.paymentTransfer')}</SelectItem>
                            <SelectItem value="wallet">{t('transactions.paymentWallet')}</SelectItem>
                            <SelectItem value="credit">{t('transactions.paymentCredit')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                        <p className="text-xs text-muted-foreground">
                          {t(`transactions.paymentHelp${form.watch('paymentMethod') === 'credit' ? 'Credit' : form.watch('paymentMethod') === 'bank_transfer' ? 'Transfer' : form.watch('paymentMethod') === 'wallet' ? 'Wallet' : form.watch('paymentMethod') === 'card' ? 'Card' : 'Cash'}`)}
                        </p>
                      </FormItem>
                    )}
                  />
                </div>

                {showNewCustomer && (
                  <div className="rounded-lg border border-dashed p-4 space-y-3">
                    <FormField
                      control={form.control}
                      name="customerName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('transactions.customerName')}</FormLabel>
                          <FormControl>
                            <Input placeholder={t('transactions.customerNamePlaceholder')} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FormField
                        control={form.control}
                        name="customerPhone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('transactions.customerPhone')}</FormLabel>
                            <FormControl><Input placeholder={t('transactions.customerPhonePlaceholder')} {...field} /></FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="customerEmail"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('transactions.customerEmail')}</FormLabel>
                            <FormControl><Input type="email" placeholder={t('transactions.customerEmailPlaceholder')} {...field} /></FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.watch('saveCustomer')}
                        onChange={(event) => form.setValue('saveCustomer', event.target.checked)}
                        className="h-4 w-4 rounded border-input accent-primary"
                      />
                      {t('transactions.saveCustomer')}
                    </label>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="currency"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('transactions.currency')} *</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('transactions.selectCurrency')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="PEN">PEN</SelectItem>
                            <SelectItem value="USD">USD</SelectItem>
                            <SelectItem value="EUR">EUR</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('transactions.notes')}</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder={t('transactions.saleNotes')}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Products */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{t('transactions.products')}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => append({ productId: '', quantity: 1, price: 0 })}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {t('transactions.addProduct')}
                  </Button>
                </CardTitle>
                <CardDescription>
                  {t('transactions.saleProductsDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {fields.map((field, index) => {
                  const selectedProduct = products.find(
                    p => p._id === form.watch(`products.${index}.productId`)
                  );

                  return (
                    <div key={field.id} className="grid gap-4 md:grid-cols-5 items-end p-4 border rounded-lg">
                      <FormField
                        control={form.control}
                        name={`products.${index}.productId`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('transactions.product')} *</FormLabel>
                            <Input
                              value={productSearch}
                              onChange={(event) => setProductSearch(event.target.value)}
                              placeholder={t('transactions.searchProducts')}
                              className="mb-2"
                            />
                            <Select 
                              onValueChange={(value) => {
                                field.onChange(value);
                                handleProductChange(index, value);
                              }} 
                              defaultValue={field.value}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder={t('transactions.selectProduct')} />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {products
                                  .filter((product) => `${product.name} ${product.sku} ${product.category}`.toLowerCase().includes(productSearch.toLowerCase()))
                                  .map((product) => (
                                  <SelectItem key={product._id} value={product._id}>
                                    {product.name} - Stock: {product.stock}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name={`products.${index}.quantity`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('transactions.quantity')} *</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min="1"
                                max={selectedProduct?.stock || 999}
                                {...field}
                                onChange={(e) => field.onChange(Number(e.target.value))}
                                onBlur={(e) => saveLastPrice(form.getValues(`products.${index}.productId`), Number(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name={`products.${index}.price`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('transactions.unitPrice')} *</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                {...field}
                                onChange={(e) => field.onChange(Number(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="space-y-2">
                        <Label>{t('transactions.total')}</Label>
                        <div className="h-10 flex items-center px-3 py-2 border rounded-md bg-muted">
                          {(() => {
                            const currency = form.watch('currency');
                            const amount = Number(form.watch(`products.${index}.quantity`) || 0) * Number(form.watch(`products.${index}.price`) || 0);
                            const converted = convertAmountToSelectedCurrency(amount, selectedProduct?.currency || 'USD');
                            const symbol = currency === 'PEN' ? 'S/' : currency === 'EUR' ? '€' : '$';
                            return `${symbol}${converted.toFixed(2)}`;
                          })()}
                        </div>
                      </div>

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => remove(index)}
                        disabled={fields.length === 1}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}

                {/* Stock warning */}
                {fields.some((_, index) => {
                  const productId = form.watch(`products.${index}.productId`);
                  const quantity = form.watch(`products.${index}.quantity`);
                  const product = products.find(p => p._id === productId);
                  return product && quantity > product.stock;
                }) && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {t('transactions.insufficientStock')}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Total Amount */}
                <div className="border-t pt-4">
                  <div className="flex justify-between items-center">
                    <span className="text-lg font-medium">{t('transactions.totalAmount')}:</span>
                    <span className="text-2xl font-bold text-green-600">
                      {(() => {
                        const currency = form.watch('currency');
                        const symbol = currency === 'PEN' ? 'S/' : currency === 'EUR' ? '€' : '$';
                        return `${symbol}${calculateTotal().toFixed(2)}`;
                      })()}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Submit Button */}
            <div className="flex justify-end gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? (
                  <>
                    <div className="mr-2 h-4 w-4 animate-spin rounded-full border-b-2 border-white"></div>
                    {t('transactions.recordingSale')}
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    {t('transactions.recordSale')}
                  </>
                )}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </Layout>
  );
}