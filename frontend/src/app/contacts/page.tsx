'use client';

import { useEffect, useState } from 'react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiClient } from '@/lib/api';
import { Contact } from '@/types';
import { Plus, Search, Edit, Trash2, Phone, Mail, CreditCard } from 'lucide-react';
import Link from 'next/link';

export default function ContactsPage() {
  const { t } = useLanguage();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [paymentContact, setPaymentContact] = useState<Contact | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'bank_transfer' | 'wallet'>('cash');
  const [paymentError, setPaymentError] = useState('');
  const [paymentHistory, setPaymentHistory] = useState<Array<{ _id: string; amount: number; paymentMethod: string; date: string }>>([]);
  const [paymentCurrency, setPaymentCurrency] = useState<'PEN' | 'USD' | 'EUR'>('PEN');

  useEffect(() => {
    loadContacts();
  }, [search, activeTab]);

  const loadContacts = async () => {
    try {
      let response;
      if (activeTab === 'customers') {
        response = await apiClient.getCustomers({ search });
      } else if (activeTab === 'vendors') {
        response = await apiClient.getVendors({ search });
      } else {
        response = await apiClient.getContacts({ search });
      }
      
      if (response.success) {
        setContacts(response.data.contacts || response.data.customers || response.data.vendors);
      }
    } catch (error) {
      console.error('Failed to load contacts:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this contact?')) {
      try {
        await apiClient.deleteContact(id);
        loadContacts();
      } catch (error) {
        console.error('Failed to delete contact:', error);
      }
    }
  };

  const registerPayment = async () => {
    if (!paymentContact) return;
    setPaymentError('');
    try {
      const response = await apiClient.createCreditPayment({
        customerId: paymentContact._id,
        amount: Number(paymentAmount),
        currency: paymentCurrency,
        paymentMethod
      });
      if (!response.success) {
        setPaymentError(response.message || t('contacts.paymentError'));
        return;
      }
      setPaymentContact(null);
      setPaymentAmount('');
      setPaymentCurrency('PEN');
      setPaymentHistory([]);
      loadContacts();
    } catch (error: any) {
      setPaymentError(error.response?.data?.message || t('contacts.paymentError'));
    }
  };

  const openPaymentForm = async (contact: Contact) => {
    setPaymentContact(contact);
    setPaymentError('');
    const response = await apiClient.getCreditPayments(contact._id);
    if (response.success) setPaymentHistory(response.data.payments || []);
    const balances = response.data?.balancesByCurrency || contact.balancesByCurrency;
    const firstCurrency = (['PEN', 'USD', 'EUR'] as const).find((currency) => Number(balances?.[currency] || 0) > 0);
    if (firstCurrency) setPaymentCurrency(firstCurrency);
  };

  const currencySymbol = (currency: string) => currency === 'PEN' ? 'S/' : currency === 'EUR' ? '€' : '$';
  const getBalances = (contact: Contact) => ({
    PEN: Number(contact.balancesByCurrency?.PEN || contact.currentBalance || 0),
    USD: Number(contact.balancesByCurrency?.USD || 0),
    EUR: Number(contact.balancesByCurrency?.EUR || 0)
  });

  const ContactTable = ({ contacts }: { contacts: Contact[] }) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('contacts.name')}</TableHead>
          <TableHead>{t('contacts.type')}</TableHead>
          <TableHead>{t('contacts.contactInfo')}</TableHead>
          <TableHead>{t('contacts.balance')}</TableHead>
          <TableHead>{t('contacts.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {contacts.map((contact) => (
          <TableRow key={contact._id}>
            <TableCell>
              <div>
                <div className="font-medium">{contact.name}</div>
                {contact.address?.city && (
                  <div className="text-sm text-muted-foreground">
                    {contact.address.city}, {contact.address.state}
                  </div>
                )}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant={contact.type === 'customer' ? 'default' : 'secondary'}>
                {contact.type}
              </Badge>
            </TableCell>
            <TableCell>
              <div className="space-y-1">
                <div className="flex items-center space-x-1 text-sm">
                  <Phone className="h-3 w-3" />
                  <span>{contact.phone}</span>
                </div>
                {contact.email && (
                  <div className="flex items-center space-x-1 text-sm text-muted-foreground">
                    <Mail className="h-3 w-3" />
                    <span>{contact.email}</span>
                  </div>
                )}
              </div>
            </TableCell>
            <TableCell>
              <div className={`font-medium ${
                contact.currentBalance > 0 ? 'text-red-500' :
                contact.currentBalance < 0 ? 'text-red-500' : ''
              }`}>
                {Object.entries(getBalances(contact))
                  .filter(([, amount]) => amount > 0)
                  .map(([currency, amount]) => `${currencySymbol(currency)} ${amount.toFixed(2)}`)
                  .join(' · ') || 'S/ 0.00'}
              </div>
              <div className="text-sm text-muted-foreground">
                {contact.creditLimit > 0 && `${t('contacts.creditLimitCurrency')}: S/ ${contact.creditLimit.toFixed(2)}`}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center space-x-2">
                {contact.type === 'customer' && Object.values(getBalances(contact)).some((amount) => amount > 0) && (
                  <Button variant="outline" size="sm" onClick={() => openPaymentForm(contact)} aria-label={t('contacts.registerPayment')}>
                    <CreditCard className="h-4 w-4" />
                  </Button>
                )}
                <Link href={`/contacts/${contact._id}/edit`}>
                  <Button variant="outline" size="sm" aria-label={`Edit ${contact.name}`}>
                    <Edit className="h-4 w-4" />
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDelete(contact._id)}
                  aria-label={`Delete ${contact.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
        {contacts.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-muted-foreground">
              No contacts found
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );

  return (
    <ProtectedRoute>
      <Layout>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">{t('contacts.title')}</h1>
              <p className="text-muted-foreground">{t('contacts.manage')}</p>
            </div>
            <Link href="/contacts/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                {t('contacts.add')}
              </Button>
            </Link>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t('contacts.management')}</CardTitle>
              <CardDescription>{t('contacts.allDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-2 mb-4">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t('contacts.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-sm"
                />
              </div>

              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value="all">{t('contacts.all')}</TabsTrigger>
                  <TabsTrigger value="customers">{t('contacts.customers')}</TabsTrigger>
                  <TabsTrigger value="vendors">{t('contacts.vendors')}</TabsTrigger>
                </TabsList>

                <TabsContent value="all" className="mt-4">
                  {loading ? (
                    <div className="flex items-center justify-center h-32">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  ) : (
                    <ContactTable contacts={contacts} />
                  )}
                </TabsContent>

                <TabsContent value="customers" className="mt-4">
                  {loading ? (
                    <div className="flex items-center justify-center h-32">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  ) : (
                    <ContactTable contacts={contacts} />
                  )}
                </TabsContent>

                <TabsContent value="vendors" className="mt-4">
                  {loading ? (
                    <div className="flex items-center justify-center h-32">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  ) : (
                    <ContactTable contacts={contacts} />
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
          {paymentContact && (
            <Card className="border-primary">
              <CardHeader>
                <CardTitle>{t('contacts.registerPayment')}</CardTitle>
                <CardDescription>{paymentContact.name} · {t('contacts.currentDebt')}: {Object.entries(getBalances(paymentContact)).filter(([, amount]) => amount > 0).map(([currency, amount]) => `${currencySymbol(currency)} ${amount.toFixed(2)}`).join(' · ')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {paymentError && <div className="text-sm text-destructive">{paymentError}</div>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input type="number" min="0.01" max={getBalances(paymentContact)[paymentCurrency]} step="0.01" placeholder={t('contacts.paymentAmount')} value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} />
                  <Select value={paymentCurrency} onValueChange={(value) => { setPaymentCurrency(value as typeof paymentCurrency); setPaymentAmount(''); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['PEN', 'USD', 'EUR'] as const).filter((currency) => getBalances(paymentContact)[currency] > 0).map((currency) => (
                        <SelectItem key={currency} value={currency}>{currencySymbol(currency)} {currency} - {getBalances(paymentContact)[currency].toFixed(2)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={paymentMethod} onValueChange={(value) => setPaymentMethod(value as typeof paymentMethod)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">{t('transactions.paymentCash')}</SelectItem>
                      <SelectItem value="card">{t('transactions.paymentCard')}</SelectItem>
                      <SelectItem value="bank_transfer">{t('transactions.paymentTransfer')}</SelectItem>
                      <SelectItem value="wallet">{t('transactions.paymentWallet')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setPaymentContact(null)}>{t('common.cancel')}</Button>
                  <Button onClick={registerPayment} disabled={!Number(paymentAmount)}>{t('contacts.confirmPayment')}</Button>
                </div>
                {paymentHistory.length > 0 && (
                  <div className="border-t pt-3">
                    <p className="mb-2 text-sm font-medium">{t('contacts.paymentHistory')}</p>
                    <div className="space-y-1 text-sm text-muted-foreground">
                      {paymentHistory.slice(0, 5).map((payment) => (
                        <div key={payment._id} className="flex justify-between">
                          <span>{new Date(payment.date).toLocaleDateString()} · {payment.paymentMethod}</span>
                          <span>S/ {Number(payment.amount).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </Layout>
    </ProtectedRoute>
  );
}