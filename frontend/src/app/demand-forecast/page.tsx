'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Card, CardContent } from '@/components/ui/card';
import { ForecastDashboard } from '@/components/ml/ForecastDashboard';
import { apiClient, DemandForecastApiError } from '@/lib/api';
import type { DemandForecastResponse } from '@/types';
import { getForecastErrorCopy } from '@/lib/demandForecast';
import { AlertTriangle, BrainCircuit, Loader2 } from 'lucide-react';

export default function DemandForecastPage() {
  const [forecast, setForecast] = useState<DemandForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'unavailable' | 'not-ready' | 'empty' | 'unknown' | null>(null);
  const requestInFlight = useRef(false);

  const loadForecast = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      const response = await apiClient.getDemandForecast();
      const data = response.data;
      if (!response.success || !data) { setError('unknown'); return; }
      if (data.status === 'ML_NOT_READY') { setError('not-ready'); return; }
      if (data.status !== 'READY' || !data.products?.length) { setError('empty'); return; }
      setForecast(data);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof DemandForecastApiError ? requestError.category : 'unknown');
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadForecast();
  }, [loadForecast]);

  const errorCopy = error ? getForecastErrorCopy(error) : null;
  return (
    <ProtectedRoute>
      <Layout>
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="flex items-center gap-2 text-primary"><BrainCircuit className="h-5 w-5" /><span className="text-sm font-semibold uppercase tracking-wider">Machine Learning</span></div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Predicción de Demanda con Machine Learning</h1>
            <p className="max-w-3xl text-muted-foreground">El modelo estima la demanda de los próximos 7 días. Explora sus predicciones y las sugerencias de reposición calculadas por el sistema.</p>
          </header>

          {loading && <Card><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3"><Loader2 className="h-8 w-8 animate-spin text-primary" /><p className="font-medium">Analizando demanda con el modelo ML…</p><p className="text-sm text-muted-foreground">Consultando el historial de tu negocio</p></CardContent></Card>}

          {errorCopy && <Card className="border-amber-200 dark:border-amber-900"><CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 text-center"><AlertTriangle className="h-8 w-8 text-amber-500" /><p className="font-semibold">{errorCopy.title}</p><p className="max-w-xl text-sm text-muted-foreground">{errorCopy.description}</p>{errorCopy.retry && <button type="button" onClick={() => void loadForecast()} disabled={loading} className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">{loading ? 'Analizando demanda con el modelo ML…' : 'Reintentar predicción'}</button>}</CardContent></Card>}

          {!loading && !error && forecast && <ForecastDashboard forecast={forecast} />}
        </div>
      </Layout>
    </ProtectedRoute>
  );
}
