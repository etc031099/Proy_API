'use client';

import { useState } from 'react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';

export default function IntegrationsPage() {
  const { t } = useLanguage();
  const [exchangeRate, setExchangeRate] = useState<any>(null);
  const [document, setDocument] = useState<any>(null);
  const [paymentMethod, setPaymentMethod] = useState<any>(null);
  const [documentType, setDocumentType] = useState<'dni' | 'ruc'>('dni');
  const [documentNumber, setDocumentNumber] = useState('12345678');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadExchangeRate = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await apiClient.getExchangeRate('USD', 'PEN');
      setExchangeRate(response.data || response);
    } catch (err: any) {
      setError(err.response?.data?.message || t('integrations.exchangeError'));
    } finally {
      setLoading(false);
    }
  };

  const validateDocumentRequest = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await apiClient.validateDocument(documentType, documentNumber);
      setDocument(response.data || response);
    } catch (err: any) {
      setError(err.response?.data?.message || t('integrations.documentError'));
    } finally {
      setLoading(false);
    }
  };

  const validatePayment = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await apiClient.validatePaymentMethod('card', 1500);
      setPaymentMethod(response.data || response);
    } catch (err: any) {
      setError(err.response?.data?.message || t('integrations.paymentError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ProtectedRoute>
      <Layout>
        <div className="space-y-6">
          <div>
            <h1 className="text-3xl font-bold">{t('integrations.title')}</h1>
            <p className="text-muted-foreground">
              {t('integrations.description')}
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>{t('integrations.exchangeRate')}</CardTitle>
                <CardDescription>USD → PEN</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button onClick={loadExchangeRate} disabled={loading}>{t('integrations.query')}</Button>
                {exchangeRate && (
                  <pre className="whitespace-pre-wrap text-xs bg-muted p-3 rounded-md">
                    {JSON.stringify(exchangeRate, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('integrations.documentValidation')}</CardTitle>
                <CardDescription>DNI / RUC</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Tipo</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={documentType}
                    onChange={(e) => setDocumentType(e.target.value as 'dni' | 'ruc')}
                  >
                    <option value="dni">DNI</option>
                    <option value="ruc">RUC</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <Label>{t('integrations.number')}</Label>
                  <Input
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    placeholder={documentType === 'dni' ? '12345678' : '20123456789'}
                  />
                </div>

                <Button onClick={validateDocumentRequest} disabled={loading}>{t('integrations.validate')}</Button>
                {document && (
                  <pre className="whitespace-pre-wrap text-xs bg-muted p-3 rounded-md">
                    {JSON.stringify(document, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('integrations.paymentMethod')}</CardTitle>
                <CardDescription>{t('integrations.paymentDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button onClick={validatePayment} disabled={loading}>{t('integrations.validate')}</Button>
                {paymentMethod && (
                  <pre className="whitespace-pre-wrap text-xs bg-muted p-3 rounded-md">
                    {JSON.stringify(paymentMethod, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </Layout>
    </ProtectedRoute>
  );
}
