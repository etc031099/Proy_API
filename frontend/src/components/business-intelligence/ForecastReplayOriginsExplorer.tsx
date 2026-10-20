'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import type { ReplayFoldKey, ReplayOriginDetail, ReplayOriginsPage } from '@/types/businessIntelligence';

const number = (value: number) => new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3 }).format(value);
const percent = (value: number | null) => value === null ? 'No definido (volumen cero)' : `${number(value * 100)}%`;
const dateLabel = (value: string) => new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
const steps = ['Datos históricos', 'Orígenes maduros', 'Folds temporales', 'Candidato', 'Comparación contra referencia', 'Reglas de seguridad', 'Aprobar/Rechazar'];
const descriptions = [
  'Se reconstruyó el dataset aislado STABLE, semilla 2020. Sus datos de demostración no son ventas actuales de producción.',
  'Cada fecha dispone de las observaciones futuras necesarias para evaluar 7 o 14 días. Un origen agrupa varios SKU y no representa una venta.',
  'Los 107 orígenes se agrupan en tres bloques temporales. Los horizontes pueden solaparse: no son 107 muestras independientes.',
  'Ridge se ajustó causalmente para cada fold, usando solo etiquetas cerradas antes de su primer origen de evaluación.',
  'El candidato se compara con MA28 sobre los mismos SKU y fechas. MA28 es la referencia formal; no es el modelo LIVE v1.',
  'Además de las métricas globales se comprueban folds, categorías, segmentos y productos prioritarios. Una protección focal puede vetar la selección.',
  '7d fue seleccionado dentro del replay; 14d fue rechazado. Ninguna de estas decisiones modifica el modelo LIVE.',
];

export function ForecastReplayOriginsExplorer() {
  const [horizon, setHorizon] = useState<7 | 14>(7);
  const [fold, setFold] = useState<ReplayFoldKey | ''>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ReplayOriginsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [origin, setOrigin] = useState('');
  const [date, setDate] = useState('');
  const [detail, setDetail] = useState<ReplayOriginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [showRejection, setShowRejection] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true); setError(false);
    void apiClient.getCertifiedForecastReplayOrigins({ horizonDays: horizon, fold: fold || undefined, page }).then(response => {
      if (!current) return;
      if (response.httpStatus === 200 && response.data) setData(response.data);
      else { setData(null); setError(true); }
      setLoading(false);
    }).catch(() => { if (current) { setError(true); setLoading(false); } });
    return () => { current = false; };
  }, [horizon, fold, page]);

  useEffect(() => {
    let current = true;
    setDetail(null); setDetailError(false);
    if (!origin) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void apiClient.getCertifiedForecastReplayOrigin(origin, horizon).then(response => {
      if (!current) return;
      if (response.httpStatus === 200 && response.data) setDetail(response.data);
      else setDetailError(true);
      setDetailLoading(false);
    }).catch(() => { if (current) { setDetailError(true); setDetailLoading(false); } });
    return () => { current = false; };
  }, [origin, horizon]);

  function resetDetail() { setOrigin(''); setDate(''); setDetail(null); setDetailError(false); }
  const focal = data?.horizonDays === 14 ? data.focalEvidence : null;

  return <section aria-label="Explorador de orígenes certificados" className="space-y-4 rounded-lg border p-4">
    <div>
      <h3 className="text-lg font-semibold">Explorar evidencia histórica</h3>
      <p className="text-sm text-muted-foreground">Un origen es una fecha histórica desde la que se evaluó una predicción cuando su futuro ya era conocido. No representa una venta.</p>
    </div>
    <div aria-label="Flujo de evaluación histórica" className="space-y-2">
      <div className="flex flex-wrap gap-2">{steps.map((label, index) => <button key={label} type="button" aria-pressed={step === index}
        onClick={() => setStep(index)} className={`rounded-md border px-3 py-2 text-sm ${step === index ? 'bg-muted font-semibold' : ''}`}>{index + 1}. {label}</button>)}</div>
      <p aria-live="polite" className="text-sm text-muted-foreground">{descriptions[step]}</p>
    </div>
    {data && <div aria-label="Folds certificados" className="grid gap-3 sm:grid-cols-3">{data.folds.map(item => <div key={item.key} className="rounded-md border p-3 text-sm">
      <h4 className="font-medium">Fold {item.order} · clave {item.key}</h4>
      <p>{item.origins} orígenes</p><p className="text-muted-foreground">{dateLabel(item.startOrigin)} – {dateLabel(item.endOrigin)}</p>
    </div>)}</div>}
    <p className="text-sm">Las claves técnicas del certificado son F2, F3 y VALIDATION; no indican su posición en la lista.</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Horizonte histórico<select className="ml-2 rounded-md border bg-background p-2" value={horizon} onChange={event => {
        setHorizon(Number(event.target.value) as 7 | 14); setFold(''); setPage(1); resetDetail(); setShowRejection(false);
      }}><option value={7}>7 días</option><option value={14}>14 días</option></select></label>
      <label className="text-sm">Fold<select className="ml-2 rounded-md border bg-background p-2" value={fold} onChange={event => {
        setFold(event.target.value as ReplayFoldKey | ''); setPage(1); resetDetail();
      }}><option value="">Todos</option>{data?.folds.map(item => <option key={item.key} value={item.key}>Fold {item.order} · {item.key}</option>)}</select></label>
      <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); if (date) setOrigin(date); }}>
        <label className="text-sm">Fecha de origen<input type="date" value={date} required onChange={event => setDate(event.target.value)} className="ml-2 rounded-md border bg-background p-2" /></label>
        <button type="submit" className="rounded-md border px-3 py-2 text-sm">Abrir origen</button>
      </form>
    </div>
    <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={() => {
      setHorizon(14); setFold('F3'); setPage(1); resetDetail(); setShowRejection(true);
    }}>Ver evidencia del rechazo 14d</button>
    {loading && <p role="status">Cargando orígenes certificados…</p>}
    {error && <p role="alert">No se pudieron cargar los orígenes. El resumen certificado sigue disponible.</p>}
    {!loading && !error && data && <>
      <p className="text-sm font-medium">{data.totalOrigins} orígenes maduros · {data.passedCheckCount}/{data.allCheckCount} comprobaciones superadas en {data.horizonDays}d</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Orígenes del horizonte {horizon} días</caption>
        <thead><tr><th scope="col">Origen</th><th scope="col">Clave de fold</th><th scope="col">Resumen de evaluación</th></tr></thead>
        <tbody>{data.items.map(item => <tr key={item.origin} className="border-t">
          <td><button type="button" aria-pressed={origin === item.origin} onClick={() => { setOrigin(item.origin); setDate(item.origin); }} className="py-3 text-primary underline">{item.origin}</button></td>
          <td>{item.fold}</td><td>{item.sampleCount} SKU · MAE candidato {number(item.candidateMae)} / MA28 {number(item.baselineMae)}</td>
        </tr>)}</tbody></table></div>
      <nav aria-label="Paginación de orígenes" className="flex items-center gap-3 text-sm">
        <button type="button" disabled={page === 1} onClick={() => setPage(value => value - 1)} className="rounded-md border px-3 py-2 disabled:opacity-50">Anterior</button>
        <span>Página {data.page} de {data.totalPages} · {data.total} orígenes en este filtro</span>
        <button type="button" disabled={page === data.totalPages} onClick={() => setPage(value => value + 1)} className="rounded-md border px-3 py-2 disabled:opacity-50">Siguiente</button>
      </nav>
    </>}
    {detailLoading && <p role="status">Cargando detalle del origen…</p>}
    {detailError && <p role="alert">No se pudo consultar ese origen en el certificado seleccionado.</p>}
    {detail && <section aria-label="Detalle del origen" className="space-y-2 rounded-lg border p-3 text-sm">
      <h4 className="font-semibold">Detalle del origen {detail.origin} · {detail.horizonDays} días · {detail.fold}</h4>
      <p>{detail.sampleCount} pares SKU/origen. La decisión PASS/REJECTED corresponde al horizonte completo; no se asigna una aprobación por fecha.</p>
      <dl className="grid gap-2 sm:grid-cols-3">
        <div><dt>Unidades reales evaluadas</dt><dd>{number(detail.actualUnits)}</dd></div>
        <div><dt>Suma de predicciones del candidato</dt><dd>{number(detail.candidateUnits)}</dd></div>
        <div><dt>Suma de predicciones MA28</dt><dd>{number(detail.baselineUnits)}</dd></div>
        <div><dt>MAE candidato / MA28</dt><dd>{number(detail.candidate.mae)} / {number(detail.baseline.mae)}</dd></div>
        <div><dt>WAPE candidato / MA28</dt><dd>{percent(detail.candidate.wape)} / {percent(detail.baseline.wape)}</dd></div>
        <div><dt>Sesgo normalizado candidato / MA28</dt><dd>{percent(detail.candidate.normalized_bias)} / {percent(detail.baseline.normalized_bias)}</dd></div>
      </dl>
      <p className="text-muted-foreground">Las unidades son etiquetas futuras agregadas del horizonte. Sumarlas entre fechas solapadas contaría observaciones repetidas; no son un total de ventas únicas.</p>
    </section>}
    {showRejection && !loading && focal && <section aria-label="Evidencia focal del rechazo" className="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm">
      <h4 className="font-semibold">14d rechazado: protección de producto prioritario</h4>
      <p>El SKU {focal.sku}, en el fold con clave {focal.fold}, supera el límite de error frente a MA28. La mejora global no anula esta protección.</p>
      <dl className="grid gap-2 sm:grid-cols-3">
        <div><dt>Soporte</dt><dd>{focal.support.origins} orígenes · {number(focal.support.uniqueDayUnits)} unidades observadas únicas</dd></div>
        <div><dt>MAE candidato / MA28</dt><dd>{number(focal.candidateMae)} / {number(focal.baselineMae)}</dd></div>
        <div><dt>Ratio / máximo permitido</dt><dd>{number(focal.ratio)} / {number(focal.threshold)} · {focal.passed ? 'Cumple' : 'No cumple'}</dd></div>
      </dl>
      <details><summary className="cursor-pointer">Regla técnica del rechazo</summary><p>{focal.ruleKey}</p><p>Condición exigida: ratio {focal.operator} {focal.threshold}</p></details>
    </section>}
    <p className="text-sm font-medium">Ninguna de estas decisiones modifica el modelo LIVE.</p>
  </section>;
}
