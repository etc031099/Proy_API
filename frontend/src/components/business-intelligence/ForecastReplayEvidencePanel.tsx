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
  return <Card>
    <CardHeader className="pb-3">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>{evidence.horizonDays} días</CardTitle>
        <Badge variant={passed ? 'default' : 'destructive'}>{passed ? 'PASS' : 'REJECTED'}</Badge>
      </div>
      <CardDescription>{passed ? 'Candidato seleccionado en replay' : 'Candidato rechazado por la política de replay'}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Mejora WAPE</dt><dd className="font-semibold">+{percentage(evidence.metrics.relativeWapeImprovement)}</dd></div>
        <div><dt className="text-muted-foreground">WAPE</dt><dd className="font-semibold">{percentage(evidence.metrics.wape)}</dd></div>
        <div><dt className="text-muted-foreground">MAE</dt><dd className="font-semibold">{new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(evidence.metrics.mae)}</dd></div>
        <div><dt className="text-muted-foreground">Bias</dt><dd className="font-semibold">{percentage(evidence.metrics.normalizedBias, 2, true)}</dd></div>
      </dl>
      <ul className="flex flex-wrap gap-2 text-xs" aria-label={`Protecciones globales ${evidence.horizonDays} días`}>
        {Object.entries(evidence.globalChecks).map(([key, passed]) => <li key={key}><Badge variant="outline">{key.slice(0, 2)} {passed ? 'aprobado' : 'no aprobado'}</Badge></li>)}
      </ul>
      {evidence.horizonDays === 14 && evidence.reasons.length > 0 && <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <p>El candidato mejoró las métricas globales, pero fue bloqueado porque degradó demasiado el MAE de un producto en el fold F3: <strong>BEB-GAS-003</strong>.</p>
        <p className="text-xs text-muted-foreground">Protección focal deliberada de la política: <code>{evidence.reasons[0]}</code></p>
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
      <p className="text-sm text-muted-foreground">Replay histórico certificado · no modifica el modelo LIVE</p>
    </div>
    {state === 'loading' && <Card><CardContent className="p-5 text-sm text-muted-foreground" role="status">Cargando evidencia histórica…</CardContent></Card>}
    {state === 'unavailable' && <p role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">La evidencia histórica no está disponible temporalmente.</p>}
    {state === 'ready' && evidence && <>
      <Card><CardContent className="grid gap-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <p><span className="text-muted-foreground">Perfil:</span> {evidence.profile}</p>
        <p><span className="text-muted-foreground">Seed:</span> {evidence.seed}</p>
        <p><span className="text-muted-foreground">Orígenes requeridos:</span> {evidence.requiredOrigins}</p>
        <p><span className="text-muted-foreground">Política:</span> {evidence.policy.numericPolicy}</p>
      </CardContent></Card>
      <div className="grid gap-4 lg:grid-cols-2">{evidence.horizons.map(item => <ReplayHorizonCard key={item.horizonDays} evidence={item} />)}</div>
      <Card><CardHeader><CardTitle className="text-base">¿Por qué 14 días fue rechazado si mejoró más?</CardTitle></CardHeader><CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>La mejora global no basta: el candidato también debe superar protecciones por producto y fold. Así se evita promover un modelo que mejora el promedio, pero perjudica casos importantes.</p>
        <p>Este resultado es histórico/offline: no modifica Registry, no modifica ACTIVE y no promociona modelos LIVE. PASS de replay ≠ promoción LIVE.</p>
        <p>El requisito de 107 origins no se debilitó.</p>
      </CardContent></Card>
    </>}
  </section>;
}
