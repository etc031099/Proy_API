'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { CertifiedForecastReplayEvidence } from '@/types/businessIntelligence';

type ReplayState = 'loading' | 'ready' | 'unavailable';

function percentage(value: number, digits = 2, signed = false): string {
  const formatted = new Intl.NumberFormat('es-PE', { minimumFractionDigits: digits, maximumFractionDigits: digits,
    signDisplay: signed ? 'always' : 'auto' }).format(value * 100);
  return `${formatted} %`;
}

function ReplayHorizonCard({ evidence }: { evidence: CertifiedForecastReplayEvidence['horizons'][number] }) {
  const passed = evidence.status === 'PASS';
  const rejectedSku = evidence.reasons.find(reason => reason.startsWith('P_FOLD_CATA_MAE:'))?.split(':').at(-1);
  return <Card>
    <CardHeader className="pb-3">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>{evidence.horizonDays} días</CardTitle>
        <Badge variant="outline" className="text-muted-foreground">{passed ? 'Aprobado en replay' : 'Rechazado en replay'}</Badge>
      </div>
      <CardDescription>{passed ? 'Cumplió los criterios de esta evaluación histórica.' : 'La evaluación histórica aplicó protecciones por producto y fold.'}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Mejora WAPE</dt><dd className="font-semibold">+{percentage(evidence.metrics.relativeWapeImprovement)}</dd></div>
        <div><dt className="text-muted-foreground">WAPE</dt><dd className="font-semibold">{percentage(evidence.metrics.wape)}</dd></div>
        <div><dt className="text-muted-foreground">MAE</dt><dd className="font-semibold">{new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(evidence.metrics.mae)}</dd></div>
        <div><dt className="text-muted-foreground">Bias</dt><dd className="font-semibold">{percentage(evidence.metrics.normalizedBias, 2, true)}</dd></div>
      </dl>
      <ul className="flex flex-wrap gap-2 text-xs" aria-label={`Protecciones globales ${evidence.horizonDays} días`}>
        {Object.entries(evidence.globalChecks).map(([key, passed], index) => <li key={key}><Badge variant="outline" className="font-normal text-muted-foreground">G{index + 1} {passed ? 'aprobado' : 'no aprobado'}</Badge></li>)}
      </ul>
      {evidence.horizonDays === 14 && evidence.reasons.length > 0 && <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <p>El candidato mejoró las métricas globales, pero fue rechazado porque empeoró demasiado el error de un producto prioritario.</p>
        {rejectedSku && <p>Producto afectado: <strong>{rejectedSku}</strong>.</p>}
        <details className="pt-1">
        <summary className="cursor-pointer font-medium">¿Por qué se rechazó?</summary>
        <p className="mt-2 text-muted-foreground">La mejora global no basta: también deben respetarse las protecciones por producto y fold. Así se evita que una mejora del promedio perjudique un caso concreto.</p>
        </details>
      </div>}
    </CardContent>
  </Card>;
}

export function ForecastReplayEvidencePanel() {
  const [state, setState] = useState<ReplayState>('loading');
  const [evidence, setEvidence] = useState<CertifiedForecastReplayEvidence | null>(null);

  useEffect(() => {
    let current = true;
    void apiClient.getCertifiedForecastReplayEvidence().then(response => {
      if (!current) return;
      if (response.httpStatus !== 200 || !response.data) throw new Error('Replay evidence unavailable');
      setEvidence(response.data);
      setState('ready');
    }).catch(() => {
      if (current) { setEvidence(null); setState('unavailable'); }
    });
    return () => { current = false; };
  }, []);

  return <section aria-labelledby="forecast-replay-evidence-title" className="space-y-4">
    <div>
      <h2 id="forecast-replay-evidence-title" className="text-xl font-semibold">Evidencia histórica de promoción</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">Evaluación histórica y offline. No representa el estado LIVE, no cambia el Registry ni los modelos activos. Un aprobado en replay no equivale a una promoción LIVE.</p>
    </div>
    {state === 'loading' && <Card><CardContent className="p-5 text-sm text-muted-foreground" role="status">Cargando evidencia histórica…</CardContent></Card>}
    {state === 'unavailable' && <p role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">La evidencia histórica no está disponible temporalmente.</p>}
    {state === 'ready' && evidence && <>
      <Card><CardContent className="grid gap-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <p><span className="text-muted-foreground">Perfil:</span> {evidence.profile}</p>
        <p><span className="text-muted-foreground">Tipo:</span> Replay histórico certificado</p>
        <p><span className="text-muted-foreground">Orígenes requeridos:</span> {evidence.requiredOrigins}</p>
        <p><span className="text-muted-foreground">Política:</span> {evidence.policy.numericPolicy}</p>
      </CardContent></Card>
      <div className="grid gap-4 lg:grid-cols-2">{evidence.horizons.map(item => <ReplayHorizonCard key={item.horizonDays} evidence={item} />)}</div>
      <p className="text-sm text-muted-foreground">El requisito de 107 orígenes maduros se mantuvo; no se redujo para esta evidencia.</p>
      <details className="rounded-lg border p-3 text-sm"><summary className="w-fit cursor-pointer font-medium">Ver detalles técnicos</summary><dl className="mt-3 grid gap-2 text-muted-foreground sm:grid-cols-2">
        <div><dt>Semilla reproducible</dt><dd>{evidence.seed}. Es una semilla determinista, no el año de los datos.</dd></div>
        <div><dt>Identificador de ejecución</dt><dd>{evidence.demoRunId}</dd></div>
        <div><dt>Política numérica</dt><dd>{evidence.policy.numericPolicy}</dd></div>
        <div><dt>Política del replay</dt><dd>{evidence.policy.replayPolicy}</dd></div>
        {evidence.horizons.flatMap(item => item.reasons.map(reason => <div key={`${item.horizonDays}-${reason}`}><dt>Motivo técnico · {item.horizonDays} días</dt><dd>{reason}</dd></div>))}
      </dl><div className="mt-3 space-y-2 text-xs text-muted-foreground"><p>No hubo cambio de Registry, ACTIVE ni promoción LIVE.</p><p>El rechazo de 14 días se debe a una protección focal aunque su WAPE global mejoró más.</p></div></details>
    </>}
  </section>;
}
