'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clearLatestCustomerImpact, CUSTOMER_IMPACT_CHANNEL, readLatestCustomerImpact, saveLatestCustomerImpact } from '@/lib/customerImpactChannel';
import { sameCustomerImpactContext, type CustomerImpactEvent, type CustomerImpactSnapshot } from '@/lib/customerImpactSnapshot';

type ImpactState = { event: CustomerImpactEvent | null; verified: boolean; loading: boolean; message: string | null };
const RETRY_DELAY_MS = 30000;
const MAX_RETRIES = 2;
const number = (value: number | null, digits = 2) => value === null ? 'No disponible'
  : new Intl.NumberFormat('es-PE', { maximumFractionDigits: digits }).format(value);
const money = (value: number | null) => value === null ? 'No disponible'
  : new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(value);
const status = (row: CustomerImpactSnapshot | null) => !row ? 'No capturado'
  : row.captureStatus === 'INSUFFICIENT_HISTORY' ? 'Historial insuficiente'
    : row.captureStatus === 'ASSIGNED' ? 'Asignación actual disponible' : 'Elegible';
function pair<T>(before: T | null | undefined, after: T | null | undefined, format: (value: T | null) => string, changed?: boolean): string {
  const left = before === undefined ? null : before, right = after === undefined ? null : after;
  const suffix = changed === true ? ' · Sin cambio' : '';
  return `${format(left)} → ${format(right)}${suffix}`;
}

export function CustomerImpactPanel() {
  const [state, setState] = useState<ImpactState>({ event: null, verified: false, loading: false, message: null });
  const retries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const verify = useCallback(async (event: CustomerImpactEvent, allowRetry = true) => {
    setState({ event, verified: false, loading: true, message: null });
    try {
      const response = await apiClient.getIntelligenceRevision();
      if (!response.success || !response.data) throw new Error('revision unavailable');
      const context = { businessId: response.data.businessId, scenarioId: response.data.scenarioId,
        datasetVersion: response.data.datasetVersion };
      if (!sameCustomerImpactContext(event.businessContext, context)) {
        clearLatestCustomerImpact();
        if (mounted.current) setState({ event: null, verified: false, loading: false, message: null });
        return;
      }
      retries.current = 0;
      if (mounted.current) setState({ event, verified: true, loading: false, message: null });
    } catch {
      saveLatestCustomerImpact(event);
      if (mounted.current) setState({ event, verified: false, loading: false,
        message: 'No se pudo confirmar temporalmente el contexto. La comparación se conserva.' });
      if (allowRetry && mounted.current && retries.current < MAX_RETRIES && !timer.current) {
        retries.current += 1;
        timer.current = setTimeout(() => { timer.current = null; void verify(event); }, RETRY_DELAY_MS);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const saved = readLatestCustomerImpact();
    if (saved) void verify(saved);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CUSTOMER_IMPACT_CHANNEL);
    if (channel) channel.onmessage = message => {
      const event = message.data as CustomerImpactEvent;
      if (event?.version === 1) { retries.current = 0; if (timer.current) clearTimeout(timer.current); timer.current = null; void verify(event); }
    };
    return () => { mounted.current = false; channel?.close(); if (timer.current) clearTimeout(timer.current); };
  }, [verify]);

  if (!state.event && !state.loading && !state.message) return <Card>
    <CardHeader><CardTitle>Impacto de la última venta en el cliente</CardTitle></CardHeader>
    <CardContent className="text-sm text-muted-foreground">La próxima venta a un cliente identificado podrá compararse automáticamente. Consumer Final no tiene una comparación individual.</CardContent>
  </Card>;

  const event = state.event;
  const before = event?.before || null, after = event?.after || null;
  const sameCluster = Boolean(before && after && before.cluster !== null && before.cluster === after.cluster);
  const clusterText = (row: CustomerImpactSnapshot | null) => !row ? 'No disponible'
    : row.captureStatus === 'INSUFFICIENT_HISTORY' ? 'Historial insuficiente'
      : row.cluster === null ? 'No disponible' : `Cluster ${row.cluster}`;
  return <Card>
    <CardHeader><CardTitle>Impacto de la última venta en el cliente</CardTitle>
      {event && <CardDescription>{event.displayName} · transacción {event.transactionId || 'sin referencia'} · {new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(event.occurredAt))}</CardDescription>}
    </CardHeader>
    <CardContent className="space-y-4 text-sm">
      {state.loading && <p role="status">Verificando contexto de la comparación…</p>}
      {state.message && <div role="alert" className="space-y-2"><p>{state.message}</p><Button variant="outline" size="sm" onClick={() => { retries.current = 0; if (event) void verify(event, false); }}>Reintentar verificación</Button></div>}
      {event && state.verified && <>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-lg border p-3"><h3 className="font-semibold">RFM</h3><dl className="mt-2 space-y-2">
            <div><dt className="text-muted-foreground">Recencia · días</dt><dd>{pair(before?.recency, after?.recency, value => number(value, 0))}</dd></div>
            <div><dt className="text-muted-foreground">Frecuencia 90 días · compras/tickets</dt><dd>{pair(before?.frequency, after?.frequency, value => number(value, 0))}</dd></div>
            <div><dt className="text-muted-foreground">Monetario 90 días · PEN</dt><dd>{pair(before?.monetary, after?.monetary, money)}</dd></div>
            <div><dt className="text-muted-foreground">Segmento RFM</dt><dd>{pair(before?.rfmSegment, after?.rfmSegment, value => value || 'No disponible')}</dd></div>
          </dl></section>
          <section className="rounded-lg border p-3"><h3 className="font-semibold">K-Means congelado</h3><dl className="mt-2 space-y-2">
            <div><dt className="text-muted-foreground">Cluster</dt><dd>{pair(clusterText(before), clusterText(after), value => value || 'No disponible', sameCluster)}</dd></div>
            <div><dt className="text-muted-foreground">Nombre del cluster</dt><dd>{pair(before?.clusterName, after?.clusterName, value => value || 'No disponible', before?.clusterName === after?.clusterName)}</dd></div>
            <div><dt className="text-muted-foreground">Distancia al centroide</dt><dd>{pair(before?.distance, after?.distance, value => number(value), before?.distance === after?.distance)}</dd></div>
            <div><dt className="text-muted-foreground">Estado de asignación</dt><dd>{status(before)} → {status(after)}</dd></div>
          </dl></section>
        </div>
        <p className="text-muted-foreground">Modelo {after?.modelVersion || before?.modelVersion || 'No disponible'} · corte de entrenamiento {after?.trainingCutoff || before?.trainingCutoff || 'No disponible'} · asignación {after?.assignmentSource || before?.assignmentSource || 'No disponible'} · observado al {after?.assignmentAsOfDate || before?.assignmentAsOfDate || 'No disponible'}.</p>
        <p className="rounded-md bg-muted/50 p-3">El modelo K-Means no fue reentrenado. Se recalculó el RFM del cliente y el modelo congelado realizó una nueva inferencia.</p>
        <details><summary className="cursor-pointer">Coordenadas PCA (solo visualización)</summary><p className="mt-2">PC1 {pair(before?.pc1, after?.pc1, value => number(value))} · PC2 {pair(before?.pc2, after?.pc2, value => number(value))}</p></details>
        {event.captureStatus !== 'COMPLETE' && <p className="text-muted-foreground">Captura parcial: BEFORE/AFTER no disponible en uno de los momentos.</p>}
      </>}
    </CardContent>
  </Card>;
}
