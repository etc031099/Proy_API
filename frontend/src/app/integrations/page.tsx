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

export default function IntegrationsPage() {
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
      setError(err.response?.data?.message || 'No se pudo consultar el tipo de cambio.');
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
      setError(err.response?.data?.message || 'No se pudo validar el documento.');
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
      setError(err.response?.data?.message || 'No se pudo validar el método de pago.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ProtectedRoute>
      <Layout>
        <div className="space-y-6">
          <div>
            <h1 className="text-3xl font-bold">Integraciones externas</h1>
            <p className="text-muted-foreground">
              Servicios de tipo de cambio, validación de documentos y métodos de pago.
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
                <CardTitle>Tipo de cambio</CardTitle>
                <CardDescription>USD → PEN</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button onClick={loadExchangeRate} disabled={loading}>Consultar</Button>
                {exchangeRate && (
                  <pre className="whitespace-pre-wrap text-xs bg-muted p-3 rounded-md">
                    {JSON.stringify(exchangeRate, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Validación de documento</CardTitle>
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
                  <Label>Número</Label>
                  <Input
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    placeholder={documentType === 'dni' ? '12345678' : '20123456789'}
                  />
                </div>

                <Button onClick={validateDocumentRequest} disabled={loading}>Validar</Button>
                {document && (
                  <pre className="whitespace-pre-wrap text-xs bg-muted p-3 rounded-md">
                    {JSON.stringify(document, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Método de pago</CardTitle>
                <CardDescription>Validación de tarjeta / transferencia / crypto</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button onClick={validatePayment} disabled={loading}>Validar</Button>
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
