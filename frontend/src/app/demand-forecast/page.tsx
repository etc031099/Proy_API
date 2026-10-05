'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient, DemandForecastApiError } from '@/lib/api';
import { DemandForecastModel, DemandForecastResponse } from '@/types';
import { formatForecastNumber, getForecastErrorCopy, getForecastSummary, getStatusClass, getStatusLabel } from '@/lib/demandForecast';
import { AlertTriangle, BrainCircuit, CheckCircle2, Clock3, Database, Loader2, Package, Sparkles, TrendingUp } from 'lucide-react';

const formatAnchorDate = (value?: string) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00.000Z`));
};

function ModelMeta({ model }: { model?: DemandForecastModel }) {
  const details = [
    ['Nombre', model?.name || 'demand_forecast_v1'],
    ['Algoritmo', model?.algorithm || 'HistGradientBoostingRegressor'],
    ['Versión', model?.version || '1.0.0'],
    ['Variables de entrada', model ? `${model.featuresCount} features` : '31 features'],
    ['Horizonte', model ? `${model.horizonDays} días` : '7 días'],
    ['Ejecución', model?.execution === 'cloud' ? 'Cloud / FastAPI' : 'FastAPI'],
  ];
  return (
    <Card className="border-primary/20 bg-primary/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardDescription className="font-semibold uppercase tracking-wider">Modelo ML</CardDescription>
            <CardTitle className="mt-1 text-xl">{model?.name || 'demand_forecast_v1'}</CardTitle>
          </div>
          <Badge className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> ACTIVO
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {details.map(([label, value]) => <div key={label} className="rounded-lg border bg-background/70 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>)}
        <div className="rounded-lg border bg-background/70 p-3"><p className="text-xs text-muted-foreground">Artefacto del modelo</p><p className="mt-1 text-sm font-semibold">demand_forecast_v1.joblib</p></div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <Badge variant="outline" className={`whitespace-nowrap ${getStatusClass(status)}`}>{getStatusLabel(status)}</Badge>;
}

export default function DemandForecastPage() {
  const [forecast, setForecast] = useState<DemandForecastResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      setSelectedId(data.products[0].productId);
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

  const products = useMemo(() => forecast?.products || [], [forecast?.products]);
  const summary = useMemo(() => getForecastSummary(products), [products]);
  const selected = products.find(product => product.productId === selectedId) || products[0];

  return (
    <ProtectedRoute>
      <Layout>
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="flex items-center gap-2 text-primary"><BrainCircuit className="h-5 w-5" /><span className="text-sm font-semibold uppercase tracking-wider">Machine Learning</span></div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Predicción de Demanda con Machine Learning</h1>
            <p className="max-w-3xl text-muted-foreground">El modelo analiza el historial de ventas para estimar la demanda de los próximos 7 días y apoyar las decisiones de reposición.</p>
          </header>

          {loading && <Card><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3"><Loader2 className="h-8 w-8 animate-spin text-primary" /><p className="font-medium">Analizando demanda con el modelo ML…</p><p className="text-sm text-muted-foreground">Consultando el historial de tu negocio</p></CardContent></Card>}

          {error && <Card className="border-amber-200 dark:border-amber-900"><CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 text-center"><AlertTriangle className="h-8 w-8 text-amber-500" /><p className="font-semibold">{getForecastErrorCopy(error).title}</p><p className="max-w-xl text-sm text-muted-foreground">{getForecastErrorCopy(error).description}</p>{getForecastErrorCopy(error).retry && <button type="button" onClick={() => void loadForecast()} disabled={loading} className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">{loading ? 'Analizando demanda con el modelo ML…' : 'Reintentar predicción'}</button>}</CardContent></Card>}

          {!loading && !error && forecast && <>
            <ModelMeta model={forecast.model} />

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" />¿Cómo funciona?</CardTitle><CardDescription>El entrenamiento ocurrió previamente con M5. Esta pantalla realiza inferencia sobre el escenario operacional de demostración.</CardDescription></CardHeader>
              <CardContent><div className="grid gap-2 text-sm sm:grid-cols-4 lg:grid-cols-8"><div className="rounded-lg border p-3 text-center"><Database className="mx-auto mb-2 h-5 w-5 text-muted-foreground" /><span>Datos históricos M5</span></div><div className="flex items-center justify-center text-primary">→</div><div className="rounded-lg border p-3 text-center"><TrendingUp className="mx-auto mb-2 h-5 w-5 text-muted-foreground" /><span>Entrenamiento</span></div><div className="flex items-center justify-center text-primary">→</div><div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-center font-semibold"><BrainCircuit className="mx-auto mb-2 h-5 w-5 text-primary" /><span>Modelo .joblib</span></div><div className="flex items-center justify-center text-primary">→</div><div className="rounded-lg border p-3 text-center"><Database className="mx-auto mb-2 h-5 w-5 text-muted-foreground" /><span>Historial operacional + 31 features</span></div><div className="flex items-center justify-center text-primary">→</div><div className="rounded-lg border p-3 text-center"><Clock3 className="mx-auto mb-2 h-5 w-5 text-muted-foreground" /><span>Inferencia y predicción 7 días</span></div><div className="hidden items-center justify-center text-primary lg:flex">→</div><div className="hidden rounded-lg border p-3 text-center lg:block"><Package className="mx-auto mb-2 h-5 w-5 text-muted-foreground" /><span>Recomendación del sistema</span></div></div></CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="border-slate-200 dark:border-slate-800">
                <CardHeader className="pb-3"><CardTitle className="text-base">Entrenamiento del modelo</CardTitle><CardDescription>Proceso realizado previamente, fuera de cada consulta de la aplicación.</CardDescription></CardHeader>
                <CardContent className="space-y-3 text-sm"><div className="grid gap-2 sm:grid-cols-2"><p><span className="text-muted-foreground">Dataset:</span> M5 Forecasting — store CA_3</p><p><span className="text-muted-foreground">Observaciones procesadas:</span> 5,918,109</p><p><span className="text-muted-foreground">Productos:</span> 3,049</p><p><span className="text-muted-foreground">Modelo seleccionado:</span> HistGradientBoostingRegressor</p><p><span className="text-muted-foreground">Métrica final TEST:</span> WAPE = 30.29 %</p><p><span className="text-muted-foreground">Artefacto generado:</span> demand_forecast_v1.joblib</p></div><p className="rounded-lg bg-muted/50 p-3 text-muted-foreground">El modelo fue entrenado previamente con el conjunto histórico M5. La aplicación utiliza el artefacto ya entrenado para realizar inferencias; no vuelve a entrenar el modelo en cada consulta.</p></CardContent>
              </Card>
              <Card className="border-primary/20 bg-primary/[0.03]">
                <CardHeader className="pb-3"><CardTitle className="text-base">Escenario operativo de demostración</CardTitle><CardDescription>Datos que se consultan actualmente para mostrar inferencias.</CardDescription></CardHeader>
                <CardContent className="space-y-3 text-sm"><p><span className="text-muted-foreground">Nombre:</span> <strong>ML-CLOUD-DEMO</strong></p><p><span className="text-muted-foreground">Productos disponibles para inferencia:</span> <strong>{summary.total}</strong></p><p className="rounded-lg bg-background/70 p-3 text-muted-foreground">Los {summary.total} productos corresponden al escenario operacional preparado para la demostración del sistema. No representan el tamaño del dataset utilizado para entrenar el modelo.</p><div className="flex flex-wrap gap-2"><Badge variant="outline">ENTRENAMIENTO: previo</Badge><Badge variant="outline" className="border-primary/30 text-primary">INFERENCIA: actual</Badge></div></CardContent>
              </Card>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5"><Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Productos analizados</p><p className="mt-1 text-2xl font-bold">{summary.total}</p></CardContent></Card><Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Productos listos</p><p className="mt-1 text-2xl font-bold text-emerald-600">{summary.ready}</p></CardContent></Card><Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">A reponer</p><p className="mt-1 text-2xl font-bold text-red-600">{summary.restock}</p></CardContent></Card><Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">En vigilancia</p><p className="mt-1 text-2xl font-bold text-amber-600">{summary.watch}</p></CardContent></Card><Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Estado OK</p><p className="mt-1 text-2xl font-bold text-emerald-600">{summary.ok}</p></CardContent></Card></div>

            <Card><CardHeader><div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between"><div><CardTitle>Resultados por producto</CardTitle><CardDescription>Datos analizados hasta: {formatAnchorDate(forecast.anchorOperationalDate)}</CardDescription></div><p className="text-xs text-muted-foreground">La predicción se muestra redondeada solo para presentación.</p></div></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="px-3 py-3 font-medium">Producto</th><th className="px-3 py-3 font-medium">SKU</th><th className="px-3 py-3 text-right font-medium">Stock</th><th className="px-3 py-3 text-right font-medium">Ventas 7 días</th><th className="bg-primary/5 px-3 py-3 text-right font-semibold text-primary">Predicción ML 7 días</th><th className="px-3 py-3 text-right font-medium">Reposición sugerida</th><th className="px-3 py-3 font-medium">Estado</th></tr></thead><tbody>{products.map(product => <tr key={product.productId} className={`cursor-pointer border-b transition-colors hover:bg-muted/50 ${selected?.productId === product.productId ? 'bg-primary/[0.04]' : ''}`} onClick={() => setSelectedId(product.productId)}><td className="px-3 py-3 font-medium">{product.name}</td><td className="px-3 py-3 text-muted-foreground">{product.sku}</td><td className="px-3 py-3 text-right">{formatForecastNumber(product.stockAtAnchor, 0)}</td><td className="px-3 py-3 text-right">{formatForecastNumber(product.salesLast7Days, 0)}</td><td className="bg-primary/5 px-3 py-3 text-right font-semibold text-primary">{formatForecastNumber(product.predictedDemand7d, 2)}</td><td className="px-3 py-3 text-right">{formatForecastNumber(product.recommendedQty, 0)}</td><td className="px-3 py-3"><StatusBadge status={product.inventoryStatus} /></td></tr>)}</tbody></table></div></CardContent></Card>

            {selected && <Card className="border-primary/20"><CardHeader><CardTitle>Detalle de producto</CardTitle><CardDescription>{selected.name} · {selected.sku}</CardDescription></CardHeader><CardContent className="space-y-5"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Stock al momento del análisis</p><p className="mt-1 text-xl font-semibold">{formatForecastNumber(selected.stockAtAnchor, 0)}</p></div><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Ventas últimos 7 días</p><p className="mt-1 text-xl font-semibold">{formatForecastNumber(selected.salesLast7Days, 0)}</p></div><div className="rounded-lg border border-primary/30 bg-primary/5 p-3"><p className="text-xs font-semibold text-primary">Predicción del modelo ML</p><p className="mt-1 text-xl font-semibold text-primary">{formatForecastNumber(selected.predictedDemand7d, 2)}</p><p className="text-xs text-muted-foreground">demanda próximos 7 días</p></div><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Stock de seguridad</p><p className="mt-1 text-xl font-semibold">{formatForecastNumber(selected.safetyStock, 1)}</p></div><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Recomendación del sistema</p><p className="mt-1 text-xl font-semibold">{formatForecastNumber(selected.recommendedQty, 0)}</p><p className="text-xs text-muted-foreground">unidades a reponer</p></div></div><div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 p-4"><span className="text-sm font-medium">Estado:</span><StatusBadge status={selected.inventoryStatus} /><p className="basis-full text-sm text-muted-foreground sm:basis-auto">El modelo ML estima la demanda. El sistema combina esa predicción con el stock disponible y el stock de seguridad para calcular una sugerencia de reposición.</p></div></CardContent></Card>}

            <details className="rounded-xl border bg-card p-5"><summary className="cursor-pointer font-semibold">Detalles técnicos de inferencia</summary><div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3"><p><span className="text-muted-foreground">Modelo:</span> {forecast.model?.name}</p><p><span className="text-muted-foreground">Algoritmo:</span> {forecast.model?.algorithm}</p><p><span className="text-muted-foreground">Features:</span> {forecast.model?.featuresCount}</p><p><span className="text-muted-foreground">Horizonte:</span> {forecast.model?.horizonDays} días</p><p><span className="text-muted-foreground">Artefacto:</span> .joblib</p><p><span className="text-muted-foreground">Servicio:</span> FastAPI · {forecast.model?.execution === 'cloud' ? 'Cloud' : 'local'}</p><p className="sm:col-span-2 lg:col-span-3"><span className="text-muted-foreground">INFERENCIA:</span> ocurre cuando se consulta esta pantalla y produce <strong>predictedDemand7d</strong>. La <strong>recommendedQty</strong> es calculada después por la regla del sistema.</p></div></details>
          </>}
        </div>
      </Layout>
    </ProtectedRoute>
  );
}
