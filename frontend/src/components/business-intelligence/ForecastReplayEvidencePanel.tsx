'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { CertifiedForecastReplayEvidence } from '@/types/businessIntelligence';

type ReplayState = 'loading' | 'ready' | 'error' | 'unavailable';

function percentage(value: number, signed = false): string {
  return `${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2,
    signDisplay: signed ? 'always' : 'auto' }).format(value * 100)}%`;
}

function metricNumber(value: number): string {
  return new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function isExpectedCertificate(value: CertifiedForecastReplayEvidence): boolean {
  return value.demoRunId === 'cert-stable-2020' && value.purpose === 'REPLAY_ONLY' && value.requiredOrigins === 107
    && value.policy.numericPolicy === 'M6.10A22-PROMOTION-v1' && value.policy.replayPolicy === 'REPLAY-CAUSAL27-107-v1'
    && value.horizons.length === 2
    && value.horizons.some(item => item.horizonDays === 7 && item.status === 'PASS' && item.reasons.length === 0
      && Object.values(item.globalChecks).every(Boolean))
    && value.horizons.some(item => item.horizonDays === 14 && item.status === 'REJECTED'
      && item.reasons.includes('P_FOLD_CATA_MAE:F3:BEB-GAS-003') && Object.values(item.globalChecks).every(Boolean))
    && value.interpretation.isLiveState === false && value.interpretation.requiredOriginsWasWeakened === false
    && value.liveImpact.modifiesLive === false && value.liveImpact.modifiesRegistry === false
    && value.liveImpact.modifiesActive === false && value.liveImpact.promotesActive === false;
}

function focalFailure(evidence: CertifiedForecastReplayEvidence['horizons'][number]): { fold: string; sku: string } | null {
  for (const reason of evidence.reasons) {
    const match = /^P_FOLD_CATA_MAE:(F\d+):([A-Za-z0-9._-]+)$/.exec(reason);
    if (match) return { fold: match[1].slice(1), sku: match[2] };
  }
  return null;
}

function ReplayHorizonCard({ evidence, numericPolicy, replayPolicy }: { evidence: CertifiedForecastReplayEvidence['horizons'][number];
  numericPolicy: string; replayPolicy: string }) {
  const approved = evidence.status === 'PASS';
  const focal = focalFailure(evidence);
  const passedGlobalRules = Object.values(evidence.globalChecks).filter(Boolean).length;
  return <Card aria-label={`Ridge ${evidence.horizonDays} días · ${approved ? 'Aprobado' : 'Rechazado'}`}>
    <CardHeader className="pb-3">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Ridge {evidence.horizonDays} días</CardTitle>
        <Badge variant={approved ? 'default' : 'destructive'}>{approved ? 'APROBADO' : 'RECHAZADO'}</Badge>
      </div>
      <CardDescription>{approved ? 'Candidato histórico aprobado para este horizonte.' : 'La evaluación histórica rechazó este candidato.'}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Mejora global (WAPE)</dt><dd className="font-semibold">{percentage(evidence.metrics.relativeWapeImprovement, true)}</dd></div>
        <div><dt className="text-muted-foreground">WAPE</dt><dd className="font-semibold">{percentage(evidence.metrics.wape)}</dd></div>
        <div><dt className="text-muted-foreground">MAE</dt><dd className="font-semibold">{metricNumber(evidence.metrics.mae)} unidades</dd></div>
        <div><dt className="text-muted-foreground">Bias</dt><dd className="font-semibold">{percentage(evidence.metrics.normalizedBias, true)}</dd></div>
      </dl>
      <p className="text-sm"><span className="text-muted-foreground">Reglas globales:</span> {passedGlobalRules}/3 superadas</p>
      {approved
        ? <p className="rounded-md border border-emerald-600/20 bg-emerald-600/5 p-3 text-sm">El candidato histórico superó las reglas exigidas para este horizonte.</p>
        : <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <p>Aunque mejoró globalmente, fue rechazado porque falló una regla de seguridad en un producto prioritario.</p>
          {focal && <p>En el fold {focal.fold}, el SKU <strong>{focal.sku}</strong> incumplió el límite MAE exigido para productos prioritarios.</p>}
          {!focal && <p>Una protección focal adicional impidió aceptar el candidato.</p>}
        </div>}
      <details className="rounded-md border p-3 text-sm">
        <summary className="w-fit cursor-pointer font-medium">Ver detalles técnicos</summary>
        <dl className="mt-3 grid gap-2 text-muted-foreground sm:grid-cols-2">
          {Object.entries(evidence.globalChecks).map(([key, passed]) => <div key={key}><dt>{key}</dt><dd>{passed ? 'Superada' : 'No superada'}</dd></div>)}
          {evidence.selectedIdentity && <div><dt>Candidato seleccionado en replay</dt><dd>{evidence.selectedIdentity}</dd></div>}
          {evidence.selectedState && <div><dt>Estado de selección</dt><dd>{evidence.selectedState}</dd></div>}
          {evidence.candidateState && <div><dt>Estado del candidato</dt><dd>{evidence.candidateState}</dd></div>}
          {evidence.reasons.map(reason => <div key={reason}><dt>Reason code</dt><dd>{reason}</dd></div>)}
          <div><dt>Política numérica</dt><dd>{numericPolicy}</dd></div>
          <div><dt>Política de replay</dt><dd>{replayPolicy}</dd></div>
        </dl>
      </details>
    </CardContent>
  </Card>;
}

function ReplayDecisionSummary({ evidence }: { evidence: CertifiedForecastReplayEvidence }) {
  return <section aria-label="Comparación de decisiones por horizonte" className="grid gap-3 sm:grid-cols-2">
    {([7, 14] as const).map(days => {
      const item = evidence.horizons.find(row => row.horizonDays === days)!;
      const approved = item.status === 'PASS';
      const focal = focalFailure(item);
      return <div key={days} className="rounded-lg border p-3 text-sm">
        <h3 className="font-medium">{days} días · {approved ? 'APROBADO' : 'RECHAZADO'}</h3>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>✓ Mejora global: {percentage(item.metrics.relativeWapeImprovement, true)}</li>
          <li>✓ Reglas globales: {Object.values(item.globalChecks).filter(Boolean).length}/3</li>
          {approved ? <li>✓ Sin rechazo focal reportado</li>
            : <li>✕ Seguridad focal{focal ? `: fold ${focal.fold} · ${focal.sku}` : ' incumplida'}</li>}
        </ul>
      </div>;
    })}
    <p className="sm:col-span-2 text-sm font-medium">Una mejora promedio no basta: cada horizonte debe superar también sus protecciones.</p>
  </section>;
}

export function ForecastReplayEvidencePanel() {
  const [state, setState] = useState<ReplayState>('loading');
  const [evidence, setEvidence] = useState<CertifiedForecastReplayEvidence | null>(null);

  useEffect(() => {
    let current = true;
    void apiClient.getCertifiedForecastReplayEvidence().then(response => {
      if (!current) return;
      if (response.httpStatus !== 200 || !response.data) { setEvidence(null); setState('error'); return; }
      if (!isExpectedCertificate(response.data)) { setEvidence(null); setState('unavailable'); return; }
      setEvidence(response.data);
      setState('ready');
    }).catch(() => {
      if (current) { setEvidence(null); setState('error'); }
    });
    return () => { current = false; };
  }, []);

  return <section aria-labelledby="forecast-replay-evidence-title" className="space-y-4">
    <div>
      <h2 id="forecast-replay-evidence-title" className="text-xl font-semibold">Evaluación histórica de candidato</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">Esta evaluación reproduce evidencia histórica cerrada para mostrar cómo el sistema decide si un candidato puede reemplazar al modelo activo. No modifica el modelo LIVE ni los datos actuales.</p>
    </div>
    <aside className="rounded-lg border border-sky-600/20 bg-sky-600/5 p-3 text-sm">
      <p className="font-medium">Esta evaluación es histórica y aislada.</p>
      <p className="mt-1 text-muted-foreground">No cambia ACTIVE ni Registry, no modifica ventas, stock o señales LIVE y no entrena con datos actuales.</p>
    </aside>
    {state === 'loading' && <Card><CardContent className="p-5 text-sm text-muted-foreground" role="status">Cargando evaluación histórica certificada…</CardContent></Card>}
    {state === 'error' && <p role="alert" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No se pudo cargar la evaluación histórica certificada.</p>}
    {state === 'unavailable' && <p role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">La evaluación histórica certificada no está disponible.</p>}
    {state === 'ready' && evidence && <>
      <Card><CardContent className="space-y-2 p-4 text-sm">
        <p className="font-semibold">{evidence.requiredOrigins} orígenes maduros evaluados</p>
        <p className="text-muted-foreground">Un origen maduro es un punto histórico que ya dispone del futuro necesario para comprobar qué tan buena fue una predicción.</p>
        <p className="font-medium">No significa {evidence.requiredOrigins} ventas.</p>
      </CardContent></Card>
      <div className="grid gap-4 lg:grid-cols-2">{([7, 14] as const).map(days => {
        const item = evidence.horizons.find(row => row.horizonDays === days)!;
        return <ReplayHorizonCard key={days} evidence={item} numericPolicy={evidence.policy.numericPolicy} replayPolicy={evidence.policy.replayPolicy} />;
      })}</div>
      <ReplayDecisionSummary evidence={evidence} />
      <details className="rounded-lg border p-3 text-sm">
        <summary className="w-fit cursor-pointer font-medium">Contexto técnico de la evaluación</summary>
        <dl className="mt-3 grid gap-2 text-muted-foreground sm:grid-cols-2">
          <div><dt>Tipo</dt><dd>Replay histórico · REPLAY_ONLY</dd></div>
          <div><dt>Perfil</dt><dd>{evidence.profile}</dd></div>
          <div><dt>Semilla determinista</dt><dd>{evidence.seed}</dd></div>
          <div><dt>Identificador de ejecución</dt><dd>{evidence.demoRunId}</dd></div>
          <div><dt>Orígenes requeridos</dt><dd>{evidence.requiredOrigins}</dd></div>
          <div><dt>Nivel</dt><dd>{evidence.level}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Los resultados son de replay y no corresponden a versiones LIVE. Un aprobado histórico no implica promoción real.</p>
      </details>
    </>}
  </section>;
}
