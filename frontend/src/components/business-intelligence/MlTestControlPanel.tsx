'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { ForecastMlUpdateStatus, MlTestLifecycleStatus, MlTestScenarioAnalysisResult, ProductInventory } from '@/types/businessIntelligence';

type ViewState = 'loading' | 'ready' | 'unavailable' | 'not-local';
type Action = 'checkpoint' | 'continue' | 'finish' | null;
type Scenario = 'NORMAL' | 'OUTLIER' | 'SHIFT';
type ScenarioSnapshot = { inventory: ProductInventory; ml: ForecastMlUpdateStatus; resetEpoch: string; testCycleId: string };
const DEMO_SKU = 'BEB-AGU-001';
const SCENARIOS: Array<{ id: Scenario; title: string; description: string; quantities: number[]; requiredStock: number }> = [
  { id: 'NORMAL', title: 'NORMAL', description: 'Simula una venta cotidiana para comprobar cómo una operación normal genera nueva evidencia para el ML.', quantities: [1], requiredStock: 1 },
  { id: 'OUTLIER', title: 'OUTLIER', description: 'Simula una venta excepcionalmente alta para observar cómo el sistema registra un cambio fuera del comportamiento habitual.', quantities: [15], requiredStock: 15 },
  { id: 'SHIFT', title: 'SHIFT', description: 'Simula varias ventas altas consecutivas para representar un cambio sostenido en el patrón de demanda.', quantities: [3, 4, 3, 4, 3], requiredStock: 17 },
];

function friendlyFailure(httpStatus: number): string {
  if (httpStatus === 409) return 'La operación no puede ejecutarse en el estado actual. Actualiza el estado e inténtalo de nuevo si corresponde.';
  if (httpStatus === 503) return 'El entorno de pruebas está temporalmente no disponible. Los datos de la prueba se mantienen protegidos.';
  if (httpStatus === 401 || httpStatus === 403) return 'Esta cuenta no tiene autorización para administrar las pruebas locales.';
  return 'No se pudo conectar con el entorno de pruebas. Puedes volver a consultar el estado.';
}
function formatDate(value: string | null | undefined): string {
  if (!value) return 'No disponible';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'No disponible' : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(date);
}
function eligibilityCopy(reason: string | null | undefined): string {
  switch (reason) {
    case 'DEBOUNCE_NOT_ELAPSED': return 'El sistema está agrupando cambios recientes antes de evaluarlos.';
    case 'NOT_MATURE': return 'Todavía no existe suficiente evidencia temporal madura para evaluar un nuevo modelo.';
    case 'COOLDOWN_ACTIVE': return 'El sistema mantiene un intervalo de seguridad antes de otra evaluación.';
    case 'NO_PENDING_WORK': return 'No hay cambios pendientes por evaluar.';
    case 'PREVIOUS_FAILURE_NOT_RETRYABLE': return 'La última evaluación requiere atención antes de poder reintentarse.';
    case 'LEASE_ACTIVE': return 'Hay una evaluación en curso.';
    default: return reason ? 'La evidencia todavía no está disponible para evaluación.' : 'Estado de elegibilidad no disponible.';
  }
}
function analysisOutcomeCopy(result: MlTestScenarioAnalysisResult): string {
  if (result.outcome === 'PROMOTED') return result.promoted
    ? 'Modelo promovido.'
    : 'El worker reportó PROMOTED, pero no se confirmó un cambio de modelo ACTIVE.';
  switch (result.outcome) {
    case 'NOT_MATURE': return 'Todavía no existe suficiente evidencia temporal madura para evaluar un nuevo modelo.';
    case 'DEBOUNCE_NOT_ELAPSED': return 'El sistema está agrupando cambios recientes antes de evaluar.';
    case 'COOLDOWN_ACTIVE': return 'El sistema mantiene un intervalo de seguridad antes de otra evaluación.';
    case 'NO_PENDING_WORK': return 'No hay cambios pendientes por evaluar.';
    case 'LEASE_ACTIVE': return 'Ya existe una evaluación de este horizonte en curso.';
    case 'PREVIOUS_FAILURE_NOT_RETRYABLE': return 'La evaluación previa requiere atención antes de reintentarse.';
    case 'REJECTED': return 'Se evaluó un candidato, pero la política no permitió promoverlo.';
    case 'NO_PROMOTION_INSUFFICIENT_HISTORY': return 'La evidencia disponible no alcanzó los requisitos para evaluar o promover un candidato.';
    default: return 'La revisión local terminó; consulta los detalles técnicos si necesitas ampliar el resultado.';
  }
}
function analysisFailureCopy(httpStatus: number): string {
  if (httpStatus === 400) return 'La solicitud de análisis no es válida.';
  if (httpStatus === 401 || httpStatus === 403) return 'La cuenta o el entorno ya no están autorizados para esta prueba.';
  if (httpStatus === 409) return 'El ciclo de prueba cambió o existe otra operación incompatible.';
  if (httpStatus === 503) return 'El análisis local está temporalmente no disponible.';
  return 'No se pudo conectar con el análisis local. Puedes actualizar el estado e intentarlo de nuevo.';
}
function sameTestCycle(value: MlTestLifecycleStatus | null | undefined, token: ScenarioSnapshot): boolean {
  return value?.state === 'TEST_ACTIVE' && value.checkpoint?.status === 'READY'
    && value.testCycleId === token.testCycleId && value.resetEpoch === token.resetEpoch && value.maintenance !== true;
}
function pendingCount(status: ForecastMlUpdateStatus | null, horizon: 7 | 14): number | null {
  const row = status?.horizons.find(item => item.horizonDays === horizon);
  return typeof row?.readiness?.pendingSignalCount === 'number' ? row.readiness.pendingSignalCount : null;
}
function changedFromBaseline(before: ScenarioSnapshot, after: ScenarioSnapshot): boolean {
  return before.inventory.stock.onHand !== after.inventory.stock.onHand
    || before.ml.dataVersion !== after.ml.dataVersion
    || [7, 14].some(days => pendingCount(before.ml, days as 7 | 14) !== pendingCount(after.ml, days as 7 | 14));
}

export function MlTestControlPanel() {
  const [view, setView] = useState<ViewState>('loading');
  const [status, setStatus] = useState<MlTestLifecycleStatus | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [snapshot, setSnapshot] = useState<ScenarioSnapshot | null>(null);
  const [current, setCurrent] = useState<ScenarioSnapshot | null>(null);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [changesObserved, setChangesObserved] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<Partial<Record<7 | 14, MlTestScenarioAnalysisResult>>>({});
  const [analysisErrors, setAnalysisErrors] = useState<Partial<Record<7 | 14, string>>>({});
  const [analysisRunning, setAnalysisRunning] = useState<7 | 14 | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);

  const clearScenario = useCallback(() => {
    setScenario(null); setSnapshot(null); setCurrent(null); setScenarioError(null); setChangesObserved(false);
    setAnalysisResults({}); setAnalysisErrors({}); setAnalysisRunning(null); setAnalysisMessage(null);
  }, []);

  const refresh = useCallback(async (clearMessage = true) => {
    if (clearMessage) setMessage(null);
    try {
      const gate = await apiClient.getMlTestControlStatus();
      if (gate.httpStatus !== 200 || !gate.data) {
        setStatus(null); setView('unavailable'); return;
      }
      const capability = gate.data.capabilities?.destructiveMlTestControls;
      if (capability?.allowed !== true || capability.target !== 'LOCAL') {
        setStatus(null); setView('not-local'); return;
      }
      const lifecycle = await apiClient.getMlTestLifecycleStatus();
      if (lifecycle.httpStatus !== 200 || !lifecycle.data) {
        setStatus(null); setView('unavailable'); return;
      }
      setStatus(lifecycle.data); setView('ready');
      if (lifecycle.data.state !== 'TEST_ACTIVE' || lifecycle.data.checkpoint?.status !== 'READY') clearScenario();
    } catch {
      setStatus(null); setView('unavailable');
    }
  }, [clearScenario]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (requestedAction: Exclude<Action, null>) => {
    if (action) return;
    const confirmations: Record<Exclude<Action, null>, string> = {
      checkpoint: 'Se guardará un checkpoint del estado actual para poder regresar exactamente a este punto.',
      continue: 'Se eliminarán los cambios realizados durante esta prueba y el sistema volverá al checkpoint guardado. El ciclo de prueba continuará activo.',
      finish: 'Se restaurará el checkpoint y se cerrará el ciclo de prueba.',
    };
    if (!window.confirm(confirmations[requestedAction])) return;
    setAction(requestedAction);
    setMessage(requestedAction === 'checkpoint' ? 'Creando checkpoint…' : 'Restaurando checkpoint…');
    try {
      const response = requestedAction === 'checkpoint'
        ? await apiClient.createMlTestCheckpoint()
        : await apiClient.restoreMlTestCheckpoint(requestedAction);
      if (response.httpStatus < 200 || response.httpStatus >= 300 || !response.data) {
        setMessage(friendlyFailure(response.httpStatus));
      } else {
        setMessage(requestedAction === 'finish'
          ? 'Checkpoint restaurado y ciclo de prueba finalizado.'
          : requestedAction === 'continue' ? 'Checkpoint restaurado. El ciclo de prueba continúa activo.' : 'Checkpoint creado. La prueba local está activa.');
        clearScenario();
      }
      await refresh(false);
    } catch {
      setMessage('No se pudo conectar con el entorno de pruebas. Puedes volver a consultar el estado.');
      await refresh(false);
    } finally { setAction(null); }
  };

  const selectScenario = async (selected: Scenario) => {
    if (!status || status.state !== 'TEST_ACTIVE' || status.checkpoint?.status !== 'READY' || scenarioBusy) return;
    clearScenario(); setScenario(selected); setScenarioBusy(true);
    try {
      const [lifecycle, inventory, ml] = await Promise.all([
        apiClient.getMlTestLifecycleStatus(),
        apiClient.getBusinessIntelligenceProductInventory(DEMO_SKU),
        apiClient.getForecastMlUpdateStatus(),
      ]);
      const cycle = lifecycle.data;
      if (lifecycle.httpStatus !== 200 || !cycle || cycle.state !== 'TEST_ACTIVE'
          || cycle.checkpoint?.status !== 'READY' || !cycle.testCycleId || !cycle.resetEpoch) {
        throw new Error('STATE_UNAVAILABLE');
      }
      if (!inventory.success || !inventory.data || inventory.data.product.sku !== DEMO_SKU || !ml.data || ml.httpStatus !== 200) {
        throw new Error(inventory.success && inventory.data ? 'STATE_UNAVAILABLE' : 'PRODUCT_NOT_FOUND');
      }
      if (typeof inventory.data.stock.onHand !== 'number' || !Number.isFinite(inventory.data.stock.onHand)) throw new Error('STOCK_UNAVAILABLE');
      const baseline: ScenarioSnapshot = { inventory: inventory.data, ml: ml.data,
        resetEpoch: cycle.resetEpoch, testCycleId: cycle.testCycleId };
      setStatus(cycle);
      setSnapshot(baseline); setCurrent(baseline);
    } catch (error) {
      setScenarioError(error instanceof Error && error.message === 'STOCK_UNAVAILABLE'
        ? 'No se pudo confirmar el stock actual del producto.'
        : error instanceof Error && error.message === 'STATE_UNAVAILABLE'
          ? 'El ciclo cambió o no está listo. Actualiza el estado antes de continuar.'
          : 'No se encontró exactamente el producto de demostración activo BEB-AGU-001 en este negocio y escenario.');
      setSnapshot(null); setCurrent(null);
    } finally { setScenarioBusy(false); }
  };

  const checkChanges = async () => {
    if (!snapshot || !status?.testCycleId || scenarioBusy) return;
    setScenarioBusy(true); setScenarioError(null);
    try {
      apiClient.invalidateIntelligenceReads();
      const [lifecycle, inventory, ml] = await Promise.all([
        apiClient.getMlTestLifecycleStatus(), apiClient.getBusinessIntelligenceProductInventory(DEMO_SKU),
        apiClient.getForecastMlUpdateStatus(),
      ]);
      if (lifecycle.httpStatus !== 200 || !lifecycle.data || lifecycle.data.state !== 'TEST_ACTIVE'
          || lifecycle.data.checkpoint?.status !== 'READY' || lifecycle.data.testCycleId !== snapshot.testCycleId
          || lifecycle.data.resetEpoch !== snapshot.resetEpoch) {
        clearScenario(); setStatus(lifecycle.data || null);
        throw new Error('CYCLE_CHANGED');
      }
      if (!inventory.success || !inventory.data || inventory.data.product.sku !== DEMO_SKU || !ml.data || ml.httpStatus !== 200) throw new Error('READ_FAILED');
      const next: ScenarioSnapshot = { inventory: inventory.data, ml: ml.data,
        resetEpoch: lifecycle.data.resetEpoch, testCycleId: lifecycle.data.testCycleId };
      setStatus(lifecycle.data); setCurrent(next); setChangesObserved(changedFromBaseline(snapshot, next));
    } catch (error) {
      setScenarioError(error instanceof Error && error.message === 'CYCLE_CHANGED'
        ? 'El ciclo cambió; se limpió la comparación para proteger el checkpoint actual.'
        : 'No se pudieron actualizar las lecturas. El estado anterior se conserva; puedes reintentar.');
    } finally { setScenarioBusy(false); }
  };

  const analyzeScenario = async () => {
    if (!snapshot || !changesObserved || scenarioBusy || action || maintenance || analysisRunning !== null) return;
    if (!window.confirm('Se revisarán las señales del escenario para 7 y 14 días. El análisis respetará las políticas de madurez, debounce, cooldown y 107 orígenes.')) return;
    const token = snapshot;
    setAnalysisResults({}); setAnalysisErrors({}); setAnalysisMessage(null); setAnalysisRunning(7);
    try {
      for (const horizonDays of [7, 14] as const) {
        setAnalysisRunning(horizonDays);
        let response;
        try { response = await apiClient.analyzeMlTestScenario(horizonDays); }
        catch { response = { httpStatus: 0 }; }
        const result = response.data;
        if (response.httpStatus < 200 || response.httpStatus >= 300 || !result) {
          setAnalysisErrors(previous => ({ ...previous, [horizonDays]: analysisFailureCopy(response.httpStatus) }));
          break;
        }
        if (result.horizonDays !== horizonDays || result.testCycleId !== token.testCycleId || result.resetEpoch !== token.resetEpoch) {
          clearScenario();
          setAnalysisMessage('El ciclo de prueba cambió durante el análisis. Actualiza el estado antes de continuar.');
          return;
        }
        setAnalysisResults(previous => ({ ...previous, [horizonDays]: result }));
        if (horizonDays === 7) {
          let lifecycle;
          try { lifecycle = await apiClient.getMlTestLifecycleStatus(); }
          catch { lifecycle = { httpStatus: 0 }; }
          if (lifecycle.httpStatus !== 200 || !lifecycle.data) {
            setAnalysisMessage('No se pudo confirmar el ciclo después del análisis de 7 días; no se ejecutó el análisis de 14 días. Actualiza el estado antes de continuar.');
            break;
          }
          if (!sameTestCycle(lifecycle.data, token)) {
            clearScenario(); setStatus(lifecycle.data);
            setAnalysisMessage('El ciclo de prueba cambió durante el análisis. Actualiza el estado antes de continuar.');
            return;
          }
        }
      }
    } finally { setAnalysisRunning(null); }
  };

  // Capability failures intentionally hide the whole section, not just its destructive controls.
  if (view !== 'ready' || !status) return null;

  const busy = action !== null;
  const maintenance = status.maintenance === true;
  const checkpointReady = status.checkpoint?.status === 'READY';
  const canStart = status.state === 'NO_TEST' && !maintenance && !busy;
  const canRestore = status.state === 'TEST_ACTIVE' && checkpointReady && !maintenance && !busy;
  const canChooseScenario = canRestore && !scenarioBusy;
  const selectedDefinition = SCENARIOS.find(item => item.id === scenario);
  const stockSufficient = Boolean(snapshot && selectedDefinition && (snapshot.inventory.stock.onHand ?? -1) >= selectedDefinition.requiredStock);

  return <section aria-labelledby="ml-test-controls-title" className="space-y-3">
    <div>
      <h2 id="ml-test-controls-title" className="text-xl font-semibold">Pruebas del Machine Learning</h2>
      <p className="text-sm text-muted-foreground">Guía local de escenarios con checkpoint y lecturas comparativas.</p>
    </div>
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Estado del ciclo de prueba</CardTitle>
          <div className="flex gap-2"><Badge variant="outline">LOCAL AUTORIZADO</Badge><Badge variant={status.state === 'TEST_ACTIVE' ? 'default' : 'secondary'}>{status.state === 'TEST_ACTIVE' ? 'TEST ACTIVE' : status.state === 'NO_TEST' ? 'SIN PRUEBA ACTIVA' : status.state}</Badge></div>
        </div>
        <CardDescription>La venta se registra en la pantalla comercial habitual. Este panel no crea ventas ni fuerza entrenamiento o promoción.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-muted-foreground">Ciclo de prueba</dt><dd className="break-all font-medium">{status.testCycleId || 'Ninguno'}</dd></div>
          <div><dt className="text-muted-foreground">Época de restauración</dt><dd className="font-medium">{status.resetEpoch}</dd></div>
          <div><dt className="text-muted-foreground">Mantenimiento</dt><dd className="font-medium">{maintenance ? 'Activo' : 'No'}</dd></div>
          <div><dt className="text-muted-foreground">Checkpoint</dt><dd className="font-medium">{status.checkpoint?.status || 'No disponible'}</dd></div>
        </dl>
        {maintenance && <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">Restauración en progreso. Las operaciones están temporalmente bloqueadas.</p>}
        {!maintenance && status.state === 'TEST_ACTIVE' && !checkpointReady && <p role="status" className="text-sm text-muted-foreground">No hay un checkpoint listo para restaurar.</p>}
        {!maintenance && <div className="flex flex-wrap gap-2">
          {status.state === 'NO_TEST' && <Button type="button" disabled={!canStart} onClick={() => void run('checkpoint')}>{action === 'checkpoint' ? 'Creando checkpoint…' : 'Iniciar prueba'}</Button>}
          {status.state === 'TEST_ACTIVE' && <>
            <Button type="button" variant="outline" disabled={!canRestore} onClick={() => void run('continue')}>{action === 'continue' ? 'Restaurando…' : 'Restaurar checkpoint'}</Button>
            <Button type="button" variant="destructive" disabled={!canRestore} onClick={() => void run('finish')}>{action === 'finish' ? 'Finalizando…' : 'Finalizar prueba'}</Button>
          </>}
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void refresh()}>Actualizar estado</Button>
        </div>}
        {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      </CardContent>
    </Card>

    {canRestore && <Card>
      <CardHeader><CardTitle className="text-base">Escenario de prueba</CardTitle><CardDescription>Elige un caso solo después de tener el checkpoint listo. Cada operación se registra manualmente en la pantalla normal de ventas.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          {SCENARIOS.map(item => <button key={item.id} type="button" disabled={!canChooseScenario}
            aria-pressed={scenario === item.id} onClick={() => void selectScenario(item.id)}
            className={`rounded-lg border p-4 text-left transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-60 ${scenario === item.id ? 'border-primary bg-primary/5' : ''}`}>
            <span className="font-semibold">{item.title}</span><span className="mt-2 block text-sm text-muted-foreground">{item.description}</span>
          </button>)}
        </div>
        {scenarioBusy && <p role="status" className="text-sm text-muted-foreground">Consultando producto y estado inicial…</p>}
        {scenarioError && <p role="alert" className="rounded-md border border-amber-500/40 p-3 text-sm">{scenarioError}</p>}
        {analysisMessage && <p role="status" className="rounded-md border p-3 text-sm">{analysisMessage}</p>}
        {scenario && snapshot && selectedDefinition && <div className="space-y-4 rounded-lg border p-4">
          <div><h3 className="font-semibold">{selectedDefinition.title}: {selectedDefinition.description}</h3>
            <p className="mt-1 text-sm text-muted-foreground">Producto de demostración: <span className="font-medium text-foreground">{snapshot.inventory.product.sku} · {snapshot.inventory.product.name || snapshot.inventory.product.sku}</span></p>
            <p className="text-sm text-muted-foreground">Stock actual: <span className="font-medium text-foreground">{snapshot.inventory.stock.onHand}</span></p>
          </div>
          {!stockSufficient ? <p role="alert" className="rounded-md border border-amber-500/40 p-3 text-sm">El producto no tiene stock suficiente para ejecutar este escenario desde el estado actual.</p> : <>
            <div className="rounded-md bg-muted/40 p-3 text-sm"><p className="font-medium">Estado inicial observado</p><p>Stock: {snapshot.inventory.stock.onHand} · Revisión operativa: {snapshot.ml.dataVersion} · Época: {snapshot.resetEpoch} · Ciclo: {snapshot.testCycleId}</p></div>
            <ol className="list-inside list-decimal space-y-1 text-sm">
              {selectedDefinition.quantities.map((quantity, index) => <li key={`${index}-${quantity}`}>Venta {selectedDefinition.quantities.length > 1 ? `${index + 1} → ` : ''}SKU {DEMO_SKU}, cantidad {quantity} unidad{quantity === 1 ? '' : 'es'}{selectedDefinition.quantities.length > 1 ? ' (una transacción separada)' : ''}.</li>)}
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" asChild>
                <Link href="/transactions/sale" target="_blank" rel="noopener noreferrer">Abrir pantalla de ventas</Link>
              </Button>
              <Button type="button" disabled={scenarioBusy} onClick={() => void checkChanges()}>{scenarioBusy ? 'Comprobando…' : 'Comprobar cambios'}</Button>
            </div>
            <p className="text-sm text-muted-foreground">Se abrirá en otra pestaña para conservar el estado inicial de esta prueba.</p>
            {current && <section aria-label="Comparación del escenario" className="space-y-3 rounded-md border p-3">
              <h4 className="font-medium">Cambios observados desde el inicio del escenario</h4>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-muted-foreground">Stock</dt><dd>{snapshot.inventory.stock.onHand} → {current.inventory.stock.onHand}</dd></div>
                <div><dt className="text-muted-foreground">Revisión operativa</dt><dd>{snapshot.ml.dataVersion} → {current.ml.dataVersion}</dd></div>
                {[7, 14].map(days => <div key={days}><dt className="text-muted-foreground">Señales pendientes {days}d</dt><dd>{pendingCount(snapshot.ml, days as 7 | 14) ?? 'No disponible'} → {pendingCount(current.ml, days as 7 | 14) ?? 'No disponible'}</dd></div>)}
              </dl>
              <p className="text-xs text-muted-foreground">Las señales y revisiones son agregadas del negocio; no permiten atribuir cada señal exclusivamente a este escenario.</p>
              <div className="space-y-2">
                {[7, 14].map(days => {
                  const horizon = current.ml.horizons.find(item => item.horizonDays === days);
                  const readiness = horizon?.readiness;
                  return <div key={days} className="rounded-md bg-muted/30 p-3 text-sm">
                    <p className="font-medium">Ridge {days} días · {horizon?.pending ? 'Hay señales pendientes' : 'Sin señales pendientes'}</p>
                    <p className="text-muted-foreground">{eligibilityCopy(horizon?.eligibility)}</p>
                    <p className="text-xs text-muted-foreground">Primera señal: {formatDate(readiness?.firstPendingSignalAt)} · Última señal: {formatDate(readiness?.lastPendingSignalAt)} · Orígenes requeridos: {horizon?.requiredOrigins ?? 107}</p>
                  </div>;
                })}
              </div>
              <details className="rounded-md border px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium">Detalles técnicos de preparación</summary>
                <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">Cierre operativo</dt><dd>{current.ml.closedThrough || 'No disponible'}</dd></div>
                  {[7, 14].map(days => {
                    const before = snapshot.ml.horizons.find(item => item.horizonDays === days);
                    const after = current.ml.horizons.find(item => item.horizonDays === days);
                    return <div key={days}><dt className="text-muted-foreground">Código de elegibilidad {days}d · inicial → actual</dt>
                      <dd>{before?.readiness?.reasonCode || before?.eligibility || 'No disponible'} → {after?.readiness?.reasonCode || after?.eligibility || 'No disponible'}</dd>
                      <dd className="text-muted-foreground">Última revisión procesada: {after?.readiness?.processedRevision || 'No disponible'} · Última revisión con señales: {after?.readiness?.latestPendingRevision || 'No disponible'}</dd>
                    </div>;
                  })}
                </dl>
              </details>
              <p className="text-sm font-medium">107 orígenes maduros no significan 107 ventas.</p>
              <p className="text-xs text-muted-foreground">Generar señales no significa que el modelo haya sido entrenado o promocionado.</p>
              {changesObserved && <div className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3">
                <div><p className="font-medium">Escenario listo para análisis</p><p className="text-sm text-muted-foreground">El análisis local revisa primero 7 días y luego 14 días; respeta madurez, debounce, cooldown y 107 orígenes.</p></div>
                <Button type="button" disabled={scenarioBusy || busy || maintenance || analysisRunning !== null}
                  onClick={() => void analyzeScenario()}>{analysisRunning === 7 ? 'Analizando 7 días…' : analysisRunning === 14 ? 'Analizando 14 días…' : 'Analizar escenario'}</Button>
              </div>}
              {(analysisResults[7] || analysisResults[14] || analysisErrors[7] || analysisErrors[14]) && <section aria-label="Resultados del análisis local" className="space-y-3">
                <div><p className="font-medium">Resultados del análisis</p><p className="text-sm text-muted-foreground">Entrenar un candidato no significa promoverlo. La política de promoción sigue siendo la autoridad final.</p></div>
                {([7, 14] as const).map(days => {
                  const result = analysisResults[days];
                  const error = analysisErrors[days];
                  if (!result && !error) return null;
                  return <div key={days} className="rounded-md border p-3 text-sm">
                    <h4 className="font-medium">{days} días</h4>
                    {error ? <p role="alert" className="mt-1 text-destructive">{error}</p> : result && <>
                      <p className="mt-1">{analysisOutcomeCopy(result)}</p>
                      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div><dt className="text-muted-foreground">Entrenamiento realizado</dt><dd>{result.trained ? 'Sí' : 'No'}</dd></div>
                        <div><dt className="text-muted-foreground">Candidato creado</dt><dd>{result.candidateCreated ? 'Sí' : 'No'}</dd></div>
                        <div><dt className="text-muted-foreground">Modelo promovido</dt><dd>{result.promoted ? 'Sí' : 'No'}</dd></div>
                        <div><dt className="text-muted-foreground">Orígenes requeridos / disponibles</dt><dd>{result.requiredOrigins} / {result.availableOrigins ?? 'No disponible'}</dd></div>
                      </dl>
                      {result.activeModelBefore && result.activeModelAfter && <p className="mt-2 text-muted-foreground">ACTIVE: {result.activeModelBefore.modelVersion == null ? 'No disponible' : `v${result.activeModelBefore.modelVersion}`} → {result.activeModelAfter.modelVersion == null ? 'No disponible' : `v${result.activeModelAfter.modelVersion}`}</p>}
                    </>}
                  </div>;
                })}
                {analysisErrors[7] && <p className="text-sm text-muted-foreground">No se ejecutó el horizonte de 14 días porque falló la solicitud de 7 días.</p>}
              </section>}
            </section>}
          </>}
        </div>}
      </CardContent>
    </Card>}
  </section>;
}
