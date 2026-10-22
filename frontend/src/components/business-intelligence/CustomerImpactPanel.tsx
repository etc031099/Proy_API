'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clearLatestCustomerImpact, CUSTOMER_IMPACT_CHANNEL, CUSTOMER_IMPACT_LOCAL_EVENT, readLatestCustomerImpact, saveLatestCustomerImpact } from '@/lib/customerImpactChannel';
import { CUSTOMER_FEATURE_ORDER, isCustomerImpactEvent, readCustomerFeatureInputs, sameCustomerImpactContext, type CustomerImpactEvent, type CustomerImpactSnapshot } from '@/lib/customerImpactSnapshot';
import { mayReplaceImpact } from '@/lib/operationImpactIdentity';

type ImpactState = { event: CustomerImpactEvent | null; verified: boolean; loading: boolean; message: string | null };
const RETRY_DELAY_MS = 30000;
const MAX_RETRIES = 2;
function invalidateRequest(ref: { current: number }): void { ref.current++; }
const number = (value: number | null | undefined, digits = 2) => value == null ? 'No disponible'
  : new Intl.NumberFormat('es-PE', { maximumFractionDigits: digits }).format(value);
const money = (value: number | null) => value === null ? 'No disponible'
  : new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(value);
const status = (row: CustomerImpactSnapshot | null) => !row ? 'No capturado'
  : row.captureStatus === 'INSUFFICIENT_HISTORY' ? 'Historial insuficiente'
    : row.captureStatus === 'ASSIGNED' ? 'Asignación actual disponible' : 'Elegible';
function pair<T>(before: T | null | undefined, after: T | null | undefined, format: (value: T | null) => string, changed?: boolean): string {
  const left = before === undefined ? null : before, right = after === undefined ? null : after;
  if (left === null && right === null) return 'No disponible';
  if (left === null) return `Actual: ${format(right)}`;
  if (right === null) return `BEFORE: ${format(left)}`;
  const suffix = changed === true ? ' · Sin cambio' : '';
  return `${format(left)} → ${format(right)}${suffix}`;
}

function sameArtifact(before: CustomerImpactSnapshot | null, after: CustomerImpactSnapshot | null): boolean | null {
  return before?.artifactHash && after?.artifactHash ? before.artifactHash === after.artifactHash : null;
}

function explainImpact(before: CustomerImpactSnapshot | null, after: CustomerImpactSnapshot | null): string {
  if (!before && !after) return 'No se obtuvieron capturas BEFORE ni AFTER para esta venta.';
  if (!before || !after) return 'Comparación parcial: falta la captura BEFORE o AFTER.';
  const identicalArtifact = sameArtifact(before, after);
  if (identicalArtifact === false) return 'El artifact cambió entre BEFORE y AFTER. Las salidas no corresponden al mismo modelo congelado.';
  const a = readCustomerFeatureInputs(before.featureInputs), b = readCustomerFeatureInputs(after.featureInputs);
  if (identicalArtifact === null || !a || !b || before.customerRef !== after.customerRef
    || before.captureStatus !== 'ASSIGNED' || after.captureStatus !== 'ASSIGNED'
    || before.cluster == null || after.cluster == null || before.distance == null || after.distance == null) {
    return 'Comparación parcial: falta evidencia de entradas, identidad del artifact o asignación; no se puede confirmar una comparación completa.';
  }
  const changed = a.filter((feature, index) => feature.rawValue !== b[index].rawValue).length;
  const inputs = changed ? `Entre BEFORE y AFTER cambiaron ${changed} de las 3 entradas RFM.` : 'Las 3 entradas RFM permanecieron iguales.';
  const cluster = before.cluster === after.cluster ? 'El cluster permaneció igual' : `El cluster cambió de ${before.cluster} a ${after.cluster}`;
  const distance = before.distance === after.distance ? 'la distancia al centroide permaneció igual.' : 'la distancia al centroide cambió.';
  return `${inputs} El mismo K-Means congelado volvió a evaluar al cliente. ${cluster}; ${distance}`;
}

export function CustomerImpactPanel() {
  const [state, setState] = useState<ImpactState>({ event: null, verified: false, loading: false, message: null });
  const retries = useRef(0);
  const verification = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const verify = useCallback(async (event: CustomerImpactEvent, allowRetry = true) => {
    const attempt = ++verification.current;
    setState({ event, verified: false, loading: true, message: null });
    try {
      const response = await apiClient.getIntelligenceRevision();
      if (attempt !== verification.current) return;
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
      if (attempt !== verification.current) return;
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
      const event: unknown = message.data;
      if (isCustomerImpactEvent(event) && mayReplaceImpact({ ...event, operationType: 'SALE' },
        readLatestCustomerImpact() ? { ...readLatestCustomerImpact()!, operationType: 'SALE' } : null)) {
        saveLatestCustomerImpact(event); retries.current = 0; if (timer.current) clearTimeout(timer.current); timer.current = null; void verify(event);
      }
    };
    const onLocalImpact = (message: Event) => { const event: unknown = (message as CustomEvent<unknown>).detail;
      if (isCustomerImpactEvent(event) && mayReplaceImpact({ ...event, operationType: 'SALE' },
        readLatestCustomerImpact() ? { ...readLatestCustomerImpact()!, operationType: 'SALE' } : null)) {
        saveLatestCustomerImpact(event); retries.current = 0; if (timer.current) clearTimeout(timer.current); timer.current = null; void verify(event);
      } };
    window.addEventListener(CUSTOMER_IMPACT_LOCAL_EVENT, onLocalImpact);
    return () => { mounted.current = false; invalidateRequest(verification); channel?.close(); window.removeEventListener(CUSTOMER_IMPACT_LOCAL_EVENT, onLocalImpact);
      if (timer.current) clearTimeout(timer.current); };
  }, [verify]);

  if (!state.event && !state.loading && !state.message) return <Card>
    <CardHeader><CardTitle>Impacto de la última venta en el cliente</CardTitle></CardHeader>
    <CardContent className="text-sm text-muted-foreground">La próxima venta a un cliente identificado podrá compararse automáticamente. Consumer Final no tiene una comparación individual.</CardContent>
  </Card>;

  const event = state.event;
  const before = event?.before || null, after = event?.after || null;
  const sameCluster = Boolean(before && after && before.cluster !== null && before.cluster === after.cluster);
  const identicalArtifact = sameArtifact(before, after);
  const inputBefore = readCustomerFeatureInputs(before?.featureInputs), inputAfter = readCustomerFeatureInputs(after?.featureInputs);
  const shortHash = (value: string | null) => value ? `${value.slice(0, 12)}…` : 'No disponible';
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
      {event && state.verified && event.customerKind === 'CONSUMER_FINAL' && <section className="rounded-lg border p-3 text-sm">
        <h3 className="font-semibold">Sin atribución individual</h3>
        <p className="mt-1">La venta {event.transactionId ? `#${event.transactionId}` : ''} corresponde a {event.displayName}. No se calcula RFM ni se asigna un cluster individual a Consumer Final.</p>
      </section>}
      {event && state.verified && event.customerKind !== 'CONSUMER_FINAL' && !event.customerRef && <section className="rounded-lg border p-3 text-sm">
        <h3 className="font-semibold">Inferencia RFM no disponible</h3>
        <p className="mt-1">La venta se asocia a {event.displayName}, pero no se obtuvo una asignación individual verificable. No se inventan valores RFM ni un cluster.</p>
      </section>}
      {event && state.verified && event.customerRef && <>
          <section className="rounded-lg border p-3"><h3 className="font-semibold">Cambio RFM</h3><dl className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div><dt className="text-muted-foreground">Recencia · días</dt><dd>{pair(before?.recency, after?.recency, value => number(value, 0))}</dd></div>
            <div><dt className="text-muted-foreground">Frecuencia 90 días · compras/tickets</dt><dd>{pair(before?.frequency, after?.frequency, value => number(value, 0))}</dd></div>
            <div><dt className="text-muted-foreground">Monetario 90 días · PEN</dt><dd>{pair(before?.monetary, after?.monetary, money)}</dd></div>
            <div><dt className="text-muted-foreground">Segmento RFM</dt><dd>{pair(before?.rfmSegment, after?.rfmSegment, value => value || 'No disponible')}</dd></div>
          </dl></section>
        <section className="rounded-lg border p-3" aria-label={before && after ? 'Entradas K-Means BEFORE y AFTER' : before ? 'Entradas K-Means BEFORE' : 'Entradas actuales K-Means'}><h3 className="font-semibold">Entradas K-Means</h3>
          <p className="mt-1 text-xs text-muted-foreground">RFM bruto → log1p → StandardScaler → K-Means. Valores devueltos por la misma inferencia.</p>
          <div className="mt-2 overflow-x-auto"><table className="w-full text-xs"><caption className="sr-only">{before && after ? 'Vector K-Means · BEFORE → AFTER' : before ? 'Vector K-Means · BEFORE disponible' : 'Vector actual K-Means'}</caption>
            <thead className="text-left"><tr><th className="p-2">Feature</th><th className="p-2">Bruto</th><th className="p-2">log1p</th><th className="p-2">Escalado</th></tr></thead>
            <tbody>{CUSTOMER_FEATURE_ORDER.map((name, index) => <tr key={name} className="border-t"><th scope="row" className="p-2 text-left font-medium">{name}</th>
              {(['rawValue', 'log1pValue', 'scaledValue'] as const).map(field => <td key={field} className="p-2">{pair(inputBefore?.[index][field], inputAfter?.[index][field], value => number(value, 6))}</td>)}
            </tr>)}</tbody></table></div>
        </section>
        <section className="rounded-lg border p-3"><h3 className="font-semibold">Modelo congelado</h3><dl className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div><dt className="text-muted-foreground">Versión</dt><dd className="break-words">{pair(before?.modelVersion, after?.modelVersion, value => value || 'No disponible')}</dd></div>
          <div><dt className="text-muted-foreground">Corte de entrenamiento</dt><dd>{pair(before?.trainingCutoff, after?.trainingCutoff, value => value || 'No disponible')}</dd></div>
          <div><dt className="text-muted-foreground">Artifact</dt><dd>{pair(before?.artifactHash, after?.artifactHash, shortHash)}</dd></div>
          <div><dt className="text-muted-foreground">Mismo artifact</dt><dd>{identicalArtifact === null ? 'No disponible' : identicalArtifact ? 'Sí' : 'No'}</dd></div>
        </dl>{identicalArtifact === true && before?.captureStatus === 'ASSIGNED' && after?.captureStatus === 'ASSIGNED'
          && <p className="mt-2 text-xs text-muted-foreground">El modelo no se reentrenó; se volvió a ejecutar inferencia con nuevas entradas RFM.</p>}</section>
        <section className="rounded-lg border p-3"><h3 className="font-semibold">Salida K-Means</h3><dl className="mt-2 grid gap-3 sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Cluster</dt><dd>{pair(clusterText(before), clusterText(after), value => value || 'No disponible', sameCluster)}</dd></div>
            <div><dt className="text-muted-foreground">Nombre del cluster</dt><dd>{pair(before?.clusterName, after?.clusterName, value => value || 'No disponible', before?.clusterName === after?.clusterName)}</dd></div>
            <div><dt className="text-muted-foreground">Distancia al centroide</dt><dd>{pair(before?.distance, after?.distance, value => number(value, 6), before?.distance != null && before.distance === after?.distance)}</dd></div>
            <div><dt className="text-muted-foreground">Estado de asignación</dt><dd>{status(before)} → {status(after)}</dd></div>
          </dl><p className="mt-2 text-xs text-muted-foreground">Distancia Euclídea en el espacio escalado, al centroide asignado; no es una probabilidad. Cluster ML y segmento RFM son análisis distintos.</p></section>
        <p className="rounded-md bg-muted/50 p-3">{explainImpact(before, after)}</p>
        <details><summary className="cursor-pointer">Coordenadas PCA · solo visualización</summary><p className="mt-2">PC1 {pair(before?.pc1, after?.pc1, value => number(value, 6))} · PC2 {pair(before?.pc2, after?.pc2, value => number(value, 6))}</p>
          <p className="mt-1 text-xs text-muted-foreground">PCA solo visualiza la posición del cliente; no determina el cluster.</p></details>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Detalles de las lecturas</summary>
          <p className="mt-2">Revisión {pair(before?.revision, after?.revision, value => value || 'No disponible')}</p>
          <p>Snapshot {pair(before?.snapshotHash, after?.snapshotHash, shortHash)}</p>
          <p>Observado {pair(before?.observedAt, after?.observedAt, value => value || 'No disponible')}</p>
          <p>RFM al {pair(before?.assignmentAsOfDate, after?.assignmentAsOfDate, value => value || 'No disponible')}</p>
          <p>Origen {pair(before?.assignmentSource, after?.assignmentSource, value => value || 'No disponible')}</p>
          <p>Comparación observacional: otros cambios concurrentes pueden afectar las lecturas.</p>
        </details>
        {!before && after && <p className="rounded-md bg-muted/50 p-3 text-xs">BEFORE histórico durable no disponible. Los valores marcados como actuales son una lectura posterior del cliente; no reconstruyen el estado anterior y pueden incluir cambios concurrentes.</p>}
        {event.captureStatus !== 'COMPLETE' && <p className="text-muted-foreground">Captura parcial: {before && !after ? 'AFTER no disponible.' : after && !before ? 'BEFORE no disponible.' : 'BEFORE y AFTER no disponibles.'}</p>}
      </>}
    </CardContent>
  </Card>;
}
