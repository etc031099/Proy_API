'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { ForecastMlUpdateStatus, ForecastResponse, MlTestLifecycleStatus, MlTestScenarioAnalysisResult } from '@/types/businessIntelligence';
import { useMlTestScenarioUiState, type MlTestScenario, type MlTestScenarioSnapshot } from './MlTestScenarioUiContext';

type ViewState = 'loading' | 'ready' | 'unavailable' | 'not-local';
type Action = 'checkpoint' | 'continue' | 'finish' | null;
type ForecastObservation = { state: 'AVAILABLE' | 'UNAVAILABLE'; units: number | null };
type Scenario = MlTestScenario;
type ScenarioSnapshot = MlTestScenarioSnapshot;
const DEMO_SKU = 'BEB-AGU-001';
const SCENARIOS: Array<{ id: Scenario; title: string; description: string; quantities: number[]; requiredStock: number }> = [
  { id: 'NORMAL', title: 'Escenario normal (NORMAL)', description: 'Simula una venta cotidiana para comprobar cómo una operación normal genera nueva evidencia para el ML.', quantities: [1], requiredStock: 1 },
  { id: 'OUTLIER', title: 'Venta excepcional (OUTLIER)', description: 'Simula una venta excepcionalmente alta para observar cómo el sistema registra un cambio fuera del comportamiento habitual.', quantities: [15], requiredStock: 15 },
  { id: 'SHIFT', title: 'Cambio sostenido (SHIFT)', description: 'Simula varias ventas altas consecutivas para representar un cambio sostenido en el patrón de demanda.', quantities: [3, 4, 3, 4, 3], requiredStock: 17 },
];

function lifecycleLabel(state: string): string {
  if (state === 'TEST_ACTIVE') return 'Prueba activa';
  if (state === 'NO_TEST') return 'Sin prueba activa';
  if (state === 'CHECKPOINT_CREATING') return 'Preparando punto de restauración';
  if (state === 'RESTORING') return 'Restauración en curso';
  if (state === 'FAILED') return 'Requiere atención';
  return 'Estado no disponible';
}

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
    case 'DEBOUNCE_NOT_ELAPSED': return 'El sistema recibió nueva evidencia, pero todavía está agrupando los cambios recientes antes de evaluar un candidato.';
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
    case 'DEBOUNCE_NOT_ELAPSED': return 'El sistema recibió nueva evidencia, pero todavía está agrupando los cambios recientes antes de evaluar un candidato.';
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
async function readForecastObservation(sku: string, days: 7 | 14): Promise<ForecastObservation> {
  try {
    const response = await apiClient.getBusinessIntelligenceForecast(sku, days);
    const data = response.success ? response.data as ForecastResponse | undefined : undefined;
    const units = data?.forecastPeriod?.units ?? data?.horizons[`${days}d`];
    if (data?.status !== 'READY' || data.modelFamily !== 'RIDGE_REGRESSION' || data.activeModelStatus !== 'ACTIVE'
        || typeof units !== 'number' || !Number.isFinite(units)) return { state: 'UNAVAILABLE', units: null };
    return { state: 'AVAILABLE', units };
  } catch { return { state: 'UNAVAILABLE', units: null }; }
}
function activeVersion(snapshot: ScenarioSnapshot, days: 7 | 14): number | null {
  const version = snapshot.ml.horizons.find(row => row.horizonDays === days)?.activeModelVersion;
  return typeof version === 'number' ? version : null;
}
function sameValue(before: number | string | null, after: number | string | null): boolean | null {
  return before === null || after === null ? null : before === after;
}
function displayValue(value: number | string | null, digits = 2): string {
  if (value === null) return 'No disponible';
  return typeof value === 'number' ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: digits }).format(value) : value;
}
function forecastLabel(value: ForecastObservation): string {
  return value.state === 'AVAILABLE' && value.units !== null ? `${displayValue(value.units)} unidades` : 'No disponible';
}
function verificationResult(baseline: ScenarioSnapshot, observed: ScenarioSnapshot): boolean | null {
  const comparisons: Array<boolean | null> = [
    sameValue(baseline.inventory.stock.onHand, observed.inventory.stock.onHand),
    sameValue(baseline.ml.dataVersion, observed.ml.dataVersion),
    ...([7, 14] as const).flatMap(days => [
      sameValue(pendingCount(baseline.ml, days), pendingCount(observed.ml, days)),
      sameValue(activeVersion(baseline, days), activeVersion(observed, days)),
      baseline.forecast[days].state === 'AVAILABLE' && observed.forecast[days].state === 'AVAILABLE'
        ? sameValue(baseline.forecast[days].units, observed.forecast[days].units) : null,
    ]),
  ];
  if (comparisons.some(value => value === false)) return false;
  return comparisons.every(value => value === true) ? true : null;
}
function observedInventoryMetric(snapshot: ScenarioSnapshot, metric: 'coverage' | 'risk' | 'recommendation'): string | null {
  if (metric === 'coverage') return typeof snapshot.inventory.coverage.daysCover === 'number' ? `${displayValue(snapshot.inventory.coverage.daysCover)} días` : null;
  if (metric === 'risk') return snapshot.inventory.risk.level || null;
  const value = snapshot.inventory.recommendation.recommendedQty;
  return typeof value === 'number' ? `${displayValue(value, 0)} unidades` : null;
}
function verificationLine(label: string, expected: number | string | null, observed: number | string | null, digits = 2) {
  const match = sameValue(expected, observed);
  return <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>Post-restore: {displayValue(observed, digits)} · Baseline esperado: {displayValue(expected, digits)} · {match === true ? 'Coincide' : match === false ? 'Difiere' : 'No se pudo verificar'}</dd></div>;
}
function changedFromBaseline(before: ScenarioSnapshot, after: ScenarioSnapshot): boolean {
  return before.inventory.stock.onHand !== after.inventory.stock.onHand
    || before.ml.dataVersion !== after.ml.dataVersion
    || [7, 14].some(days => pendingCount(before.ml, days as 7 | 14) !== pendingCount(after.ml, days as 7 | 14));
}
async function readScenarioSnapshot(cycle: { resetEpoch: string; testCycleId: string | null }): Promise<ScenarioSnapshot> {
  const [inventory, ml, forecast7, forecast14] = await Promise.all([
    apiClient.getBusinessIntelligenceProductInventory(DEMO_SKU), apiClient.getForecastMlUpdateStatus(),
    readForecastObservation(DEMO_SKU, 7), readForecastObservation(DEMO_SKU, 14),
  ]);
  if (!inventory.success || !inventory.data || inventory.data.product.sku !== DEMO_SKU || !ml.data || ml.httpStatus !== 200) {
    throw new Error('SCENARIO_READ_FAILED');
  }
  if (typeof inventory.data.stock.onHand !== 'number' || !Number.isFinite(inventory.data.stock.onHand)) throw new Error('STOCK_UNAVAILABLE');
  return { inventory: inventory.data, ml: ml.data, forecast: { 7: forecast7, 14: forecast14 },
    resetEpoch: cycle.resetEpoch, testCycleId: cycle.testCycleId };
}

export function MlTestControlPanel() {
  const { restoreVerification, setRestoreVerification, restoreScrollPending, setRestoreScrollPending, operation, setOperation } = useMlTestScenarioUiState();
  const restoreResultRef = useRef<HTMLDivElement>(null);
  const restorePhaseAtMountRef = useRef(restoreVerification?.phase ?? null);
  const restoreWasVerifyingRef = useRef(restoreVerification?.phase === 'VERIFYING');
  const restoreScrollHandledRef = useRef(false);
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
  const [hasCheckedChanges, setHasCheckedChanges] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<Partial<Record<7 | 14, MlTestScenarioAnalysisResult>>>({});
  const [analysisErrors, setAnalysisErrors] = useState<Partial<Record<7 | 14, string>>>({});
  const [analysisRunning, setAnalysisRunning] = useState<7 | 14 | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);

  useEffect(() => {
    const phase = restoreVerification?.phase;
    if (phase === 'VERIFYING') restoreWasVerifyingRef.current = true;
    if (view !== 'ready' || !restoreResultRef.current) return;
    const terminal = phase === 'COMPLETE' || phase === 'FAILED';
    const resultMountedAfterRestore = terminal && phase === restorePhaseAtMountRef.current && restoreScrollPending;
    const failedWithoutEpochChange = phase === 'FAILED' && restoreWasVerifyingRef.current && operation === null && restoreScrollPending;
    if (!terminal || (!resultMountedAfterRestore && !failedWithoutEpochChange) || restoreScrollHandledRef.current) return;

    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const result = restoreResultRef.current;
        if (!result) return;
        result.scrollIntoView({ behavior: 'smooth', block: 'start' });
        restoreScrollHandledRef.current = true;
        restoreWasVerifyingRef.current = false;
        setRestoreScrollPending(false);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [operation, restoreScrollPending, restoreVerification?.phase, setRestoreScrollPending, view]);

  const clearScenario = useCallback(() => {
    setScenario(null); setSnapshot(null); setCurrent(null); setScenarioError(null); setChangesObserved(false); setHasCheckedChanges(false);
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
      checkpoint: 'Se guardará un punto de restauración del estado actual para poder regresar exactamente a este punto.',
      continue: 'Se eliminarán los cambios realizados durante esta prueba y el sistema volverá al punto de restauración guardado. El ciclo continuará activo.',
      finish: 'Se restaurará el punto de restauración y se cerrará el ciclo de prueba.',
    };
    if (!window.confirm(confirmations[requestedAction])) return;
    const verificationTarget = requestedAction !== 'checkpoint' && snapshot && scenario
      ? { mode: requestedAction, scenario, baseline: snapshot } as const : null;
    if (verificationTarget) {
      setRestoreScrollPending(true);
      setRestoreVerification({ ...verificationTarget, phase: 'VERIFYING' });
    }
    setOperation(requestedAction === 'checkpoint' ? 'Creando punto de restauración…'
      : requestedAction === 'finish' ? 'Finalizando prueba y restaurando el punto…' : 'Restaurando punto de restauración…');
    setAction(requestedAction);
    setMessage(requestedAction === 'checkpoint' ? 'Creando punto de restauración…' : 'Restaurando punto de restauración…');
    try {
      const response = requestedAction === 'checkpoint'
        ? await apiClient.createMlTestCheckpoint()
        : await apiClient.restoreMlTestCheckpoint(requestedAction);
      if (response.httpStatus < 200 || response.httpStatus >= 300 || !response.data) {
        setMessage(friendlyFailure(response.httpStatus));
        if (verificationTarget) setRestoreVerification({ ...verificationTarget, phase: 'FAILED', message: friendlyFailure(response.httpStatus) });
      } else {
        if (verificationTarget) await verifyRestoredScenario(verificationTarget);
        else setMessage('Punto de restauración creado. La prueba local está activa.');
        clearScenario();
      }
      await refresh(false);
    } catch {
      setMessage('No se pudo conectar con el entorno de pruebas. Puedes volver a consultar el estado.');
      if (verificationTarget) setRestoreVerification({ ...verificationTarget, phase: 'FAILED', message: 'No se pudo confirmar la restauración. Actualiza el estado y vuelve a verificar.' });
      await refresh(false);
    } finally { setAction(null); setOperation(null); }
  };

  const verifyRestoredScenario = async (target: { mode: 'continue' | 'finish'; scenario: Scenario; baseline: ScenarioSnapshot }) => {
    try {
      apiClient.invalidateIntelligenceReads();
      const lifecycle = await apiClient.getMlTestLifecycleStatus();
      const cycle = lifecycle.data;
      const epochAdvanced = cycle && /^\d+$/.test(cycle.resetEpoch) && /^\d+$/.test(target.baseline.resetEpoch)
        && BigInt(cycle.resetEpoch) > BigInt(target.baseline.resetEpoch);
      const stateMatches = target.mode === 'continue'
        ? cycle?.state === 'TEST_ACTIVE' && cycle.checkpoint?.status === 'READY' && cycle.testCycleId === target.baseline.testCycleId
        : cycle?.state === 'NO_TEST' && cycle.testCycleId === null;
      if (lifecycle.httpStatus !== 200 || !cycle || !epochAdvanced || !stateMatches) throw new Error('RESTORE_LIFECYCLE_MISMATCH');
      const observed = await readScenarioSnapshot(cycle);
      setStatus(cycle);
      setRestoreVerification({ ...target, phase: 'COMPLETE', observed });
      const matches = verificationResult(target.baseline, observed);
      setMessage(target.mode === 'finish'
        ? matches === true ? 'Prueba finalizada. El sistema volvió al punto inicial.' : 'La prueba finalizó, pero la verificación detectó diferencias o lecturas no disponibles.'
        : matches === true ? 'Punto de restauración aplicado. La prueba continúa activa.' : 'La restauración terminó; revisa las diferencias de verificación antes de continuar.');
    } catch (error) {
      setRestoreVerification({ ...target, phase: 'FAILED', message: error instanceof Error && error.message === 'STOCK_UNAVAILABLE'
        ? 'La restauración terminó, pero no se pudo verificar el stock del producto.'
        : 'La restauración terminó, pero no se pudo confirmar que todas las lecturas coincidan con el ciclo restaurado.' });
      setMessage(target.mode === 'finish' ? 'La prueba finalizó, pero no se pudo verificar el retorno completo al punto inicial.' : 'La restauración terminó, pero no se pudo verificar el retorno completo al punto inicial.');
    }
  };

  const selectScenario = async (selected: Scenario) => {
    if (!status || status.state !== 'TEST_ACTIVE' || status.checkpoint?.status !== 'READY' || scenarioBusy) return;
    setRestoreVerification(null);
    setRestoreScrollPending(false);
    clearScenario(); setScenario(selected); setScenarioBusy(true);
    try {
      const lifecycle = await apiClient.getMlTestLifecycleStatus();
      const cycle = lifecycle.data;
      if (lifecycle.httpStatus !== 200 || !cycle || cycle.state !== 'TEST_ACTIVE'
          || cycle.checkpoint?.status !== 'READY' || !cycle.testCycleId || !cycle.resetEpoch) {
        throw new Error('STATE_UNAVAILABLE');
      }
      const baseline = await readScenarioSnapshot(cycle);
      setStatus(cycle);
      setSnapshot(baseline); setCurrent(baseline);
    } catch (error) {
      setScenarioError(error instanceof Error && error.message === 'STOCK_UNAVAILABLE'
        ? 'No se pudo confirmar el stock actual del producto.'
        : error instanceof Error && error.message === 'STATE_UNAVAILABLE'
          ? 'El ciclo cambió o no está listo. Actualiza el estado antes de continuar.'
          : error instanceof Error && error.message === 'SCENARIO_READ_FAILED'
            ? 'No se pudieron leer las métricas actuales del producto de demostración.'
            : 'No se encontró exactamente el producto de demostración activo BEB-AGU-001 en este negocio y escenario.');
      setSnapshot(null); setCurrent(null);
    } finally { setScenarioBusy(false); }
  };

  const checkChanges = async () => {
    if (!snapshot || !status?.testCycleId || scenarioBusy) return;
    setScenarioBusy(true); setScenarioError(null);
    try {
      apiClient.invalidateIntelligenceReads();
      const lifecycle = await apiClient.getMlTestLifecycleStatus();
      if (lifecycle.httpStatus !== 200 || !lifecycle.data || lifecycle.data.state !== 'TEST_ACTIVE'
          || lifecycle.data.checkpoint?.status !== 'READY' || lifecycle.data.testCycleId !== snapshot.testCycleId
          || lifecycle.data.resetEpoch !== snapshot.resetEpoch) {
        clearScenario(); setStatus(lifecycle.data || null);
        throw new Error('CYCLE_CHANGED');
      }
      const next = await readScenarioSnapshot(lifecycle.data);
      setStatus(lifecycle.data); setCurrent(next); setChangesObserved(changedFromBaseline(snapshot, next)); setHasCheckedChanges(true);
    } catch (error) {
      setScenarioError(error instanceof Error && error.message === 'CYCLE_CHANGED'
        ? 'El ciclo cambió; se limpió la comparación para proteger el punto de restauración actual.'
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

  return <section id="ml-test-controls" aria-labelledby="ml-test-controls-title" className="space-y-3">
    <div>
      <h2 id="ml-test-controls-title" className="text-xl font-semibold">Pruebas del Machine Learning</h2>
      <p className="text-sm text-muted-foreground">Guía de escenarios locales con punto de restauración y lecturas comparativas.</p>
    </div>
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Estado de la prueba</CardTitle>
          <Badge variant={status.state === 'TEST_ACTIVE' ? 'default' : 'secondary'}>{lifecycleLabel(status.state)}</Badge>
        </div>
        <CardDescription>La venta se registra en la pantalla comercial habitual. Este panel no crea ventas ni fuerza entrenamiento o promoción.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Punto de restauración</dt><dd className="font-medium">{checkpointReady ? 'Listo' : status.state === 'NO_TEST' ? 'Aún no creado' : 'No disponible'}</dd></div>
          {status.state === 'TEST_ACTIVE' && <div><dt className="text-muted-foreground">Mantenimiento</dt><dd className="font-medium">{maintenance ? 'Activo' : 'No'}</dd></div>}
        </dl>
        <details className="rounded-md border px-3 py-2 text-sm"><summary className="w-fit cursor-pointer font-medium">Detalles técnicos</summary><dl className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div><dt>Identificador del ciclo</dt><dd className="break-all">{status.testCycleId || 'Ninguno'}</dd></div>
          <div><dt>Época de restauración</dt><dd>{status.resetEpoch}</dd></div>
          <div><dt>Estado técnico del punto</dt><dd>{status.checkpoint?.status || 'No disponible'}</dd></div>
          <div><dt>Entorno</dt><dd>Pruebas habilitadas solo localmente</dd></div>
        </dl></details>
        {busy && <p role="status" aria-live="polite" className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />{operation || (action === 'finish' ? 'Finalizando prueba y restaurando el punto…' : action === 'continue' ? 'Restaurando punto de restauración…' : 'Creando punto de restauración…')}</p>}
        {maintenance && <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">Restauración en progreso. Las operaciones están temporalmente bloqueadas.</p>}
        {!maintenance && status.state === 'TEST_ACTIVE' && !checkpointReady && <p role="status" className="text-sm text-muted-foreground">No hay un punto de restauración listo.</p>}
        {!maintenance && <div className="flex flex-wrap gap-2">
          {status.state === 'NO_TEST' && <Button type="button" disabled={!canStart} onClick={() => void run('checkpoint')}>{action === 'checkpoint' ? 'Creando punto de restauración…' : 'Iniciar prueba'}</Button>}
          {status.state === 'TEST_ACTIVE' && <>
            <Button type="button" variant="outline" disabled={!canRestore} onClick={() => void run('continue')}>{action === 'continue' ? 'Restaurando…' : 'Restaurar punto de restauración'}</Button>
            <Button type="button" variant="destructive" disabled={!canRestore} onClick={() => void run('finish')}>{action === 'finish' ? 'Finalizando…' : 'Finalizar prueba'}</Button>
          </>}
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void refresh()}>Actualizar estado</Button>
        </div>}
        {message && !busy && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      </CardContent>
    </Card>

    {canRestore && <Card>
      <CardHeader><CardTitle className="text-base">Escenario de prueba</CardTitle><CardDescription>Elige un caso solo después de tener listo el punto de restauración. Cada operación se registra manualmente en la pantalla normal de ventas.</CardDescription></CardHeader>
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
            <div aria-label="Estado inicial observado" className="rounded-md bg-muted/40 p-3 text-sm"><p className="font-medium">Estado inicial observado</p>
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                <div><dt className="text-muted-foreground">Stock</dt><dd>{displayValue(snapshot.inventory.stock.onHand, 0)}</dd></div>
                <div><dt className="text-muted-foreground">Revisión operativa</dt><dd>{snapshot.ml.dataVersion}</dd></div>
                {[7, 14].map(days => <div key={days}><dt className="text-muted-foreground">Señales pendientes {days}d</dt><dd>{pendingCount(snapshot.ml, days as 7 | 14) ?? 'No disponible'}</dd></div>)}
                {[7, 14].map(days => <div key={days}><dt className="text-muted-foreground">Pronóstico Ridge {days}d</dt><dd>{forecastLabel(snapshot.forecast[days as 7 | 14])}</dd></div>)}
                {[7, 14].map(days => <div key={days}><dt className="text-muted-foreground">Modelo activo {days}d</dt><dd>{activeVersion(snapshot, days as 7 | 14) === null ? 'No disponible' : `v${activeVersion(snapshot, days as 7 | 14)}`}</dd></div>)}
              </dl>
              <details className="mt-2 text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">Identificadores técnicos</summary><p className="mt-1 break-all">Época: {snapshot.resetEpoch} · Ciclo: {snapshot.testCycleId}</p></details></div>
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
            {current && hasCheckedChanges && <section aria-label="Comparación del escenario" className="space-y-3 rounded-md border p-3">
              <h4 className="font-medium">Impacto observado del escenario</h4>
              <p className="text-xs text-muted-foreground">Cambio observado durante el escenario; esta comparación no atribuye causalidad exclusiva a una operación.</p>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-muted-foreground">Stock</dt><dd>{snapshot.inventory.stock.onHand} → {current.inventory.stock.onHand}</dd></div>
                <div><dt className="text-muted-foreground">Revisión operativa</dt><dd>{snapshot.ml.dataVersion} → {current.ml.dataVersion}</dd></div>
                {[7, 14].map(days => <div key={days}><dt className="text-muted-foreground">Señales pendientes {days}d</dt><dd>{pendingCount(snapshot.ml, days as 7 | 14) ?? 'No disponible'} → {pendingCount(current.ml, days as 7 | 14) ?? 'No disponible'}</dd></div>)}
                {[7, 14].map(days => { const horizon = days as 7 | 14; return <div key={days}><dt className="text-muted-foreground">Pronóstico Ridge {days}d</dt><dd>{forecastLabel(snapshot.forecast[horizon])} → {forecastLabel(current.forecast[horizon])}</dd>{snapshot.forecast[horizon].state === 'AVAILABLE' && current.forecast[horizon].state === 'AVAILABLE' && snapshot.forecast[horizon].units === current.forecast[horizon].units && <dd className="text-xs text-muted-foreground">Sin cambio observable en esta consulta.</dd>}</div>; })}
                {[7, 14].map(days => { const horizon = days as 7 | 14; const before = activeVersion(snapshot, horizon); const after = activeVersion(current, horizon); return <div key={days}><dt className="text-muted-foreground">Modelo activo {days}d</dt><dd>{before === null ? 'No disponible' : `v${before}`} → {after === null ? 'No disponible' : `v${after}`}</dd></div>; })}
                {(['coverage', 'risk', 'recommendation'] as const).map(metric => { const before = observedInventoryMetric(snapshot, metric); const after = observedInventoryMetric(current, metric); if (before === null && after === null) return null; const label = metric === 'coverage' ? 'Cobertura' : metric === 'risk' ? 'Riesgo' : 'Recomendación de reposición'; return <div key={metric}><dt className="text-muted-foreground">{label}</dt><dd>{before ?? 'No disponible'} → {after ?? 'No disponible'}</dd></div>; })}
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
              {(analysisResults[7] || analysisResults[14] || analysisErrors[7] || analysisErrors[14]) && <section aria-label="Resultado de la revisión ML" className="space-y-3">
                <div><p className="font-medium">Resultado de la revisión ML</p><p className="text-sm text-muted-foreground">Una revisión que no entrena no es un error. Entrenar un candidato tampoco significa promoverlo; la política de promoción sigue siendo la autoridad final.</p></div>
                {([7, 14] as const).map(days => {
                  const result = analysisResults[days];
                  const error = analysisErrors[days];
                  if (!result && !error) return null;
                  return <div key={days} className="rounded-md border p-3 text-sm">
                    <h4 className="font-medium">{days} días</h4>
                    {error ? <p role="alert" className="mt-1 text-destructive">{error}</p> : result && <>
                      <p className="mt-1">{analysisOutcomeCopy(result)}</p>
                      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div><dt className="text-muted-foreground">Entrenamiento</dt><dd>{result.trained ? 'Sí' : 'No'}</dd></div>
                        <div><dt className="text-muted-foreground">Candidato creado</dt><dd>{result.candidateCreated ? 'Sí' : 'No'}</dd></div>
                        <div><dt className="text-muted-foreground">Modelo promovido</dt><dd>{result.promoted ? 'Sí' : 'No'}</dd></div>
                        <div><dt className="text-muted-foreground">Orígenes requeridos / disponibles</dt><dd>{result.requiredOrigins} / {result.availableOrigins ?? 'No disponible'}</dd></div>
                      </dl>
                      {result.activeModelBefore && result.activeModelAfter && <p className="mt-2 text-muted-foreground">ACTIVE: {result.activeModelBefore.modelVersion == null ? 'No disponible' : `v${result.activeModelBefore.modelVersion}`} → {result.activeModelAfter.modelVersion == null ? 'No disponible' : `v${result.activeModelAfter.modelVersion}`}</p>}
                      <details className="mt-2 rounded border px-2 py-1 text-xs"><summary className="cursor-pointer">Ver detalles técnicos</summary><dl className="mt-2 grid gap-1"><div><dt className="text-muted-foreground">reasonCode</dt><dd>{result.reasonCode || 'No disponible'}</dd></div><div><dt className="text-muted-foreground">Resultado técnico</dt><dd>{result.outcome}</dd></div></dl></details>
                    </>}
                  </div>;
                })}
                {analysisErrors[7] && <p className="text-sm text-muted-foreground">No se ejecutó el horizonte de 14 días porque falló la solicitud de 7 días.</p>}
              </section>}
              {(changesObserved || analysisResults[7] || analysisResults[14]) && <section aria-label="¿Qué ocurrió en esta prueba?" className="rounded-md bg-muted/40 p-3 text-sm">
                <h4 className="font-medium">¿Qué ocurrió en esta prueba?</h4>
                <p className="mt-1">{snapshot.inventory.stock.onHand !== current.inventory.stock.onHand
                  ? `El stock observado cambió de ${snapshot.inventory.stock.onHand} a ${current.inventory.stock.onHand}. ` : 'El stock consultado no mostró cambios observables. '}
                  {snapshot.ml.dataVersion !== current.ml.dataVersion ? `La revisión operativa pasó de ${snapshot.ml.dataVersion} a ${current.ml.dataVersion}. ` : 'La revisión operativa se mantuvo igual en estas lecturas. '}
                  {[7, 14].map(days => { const horizon = days as 7 | 14; const before = pendingCount(snapshot.ml, horizon); const after = pendingCount(current.ml, horizon); return before !== after ? `Las señales pendientes ${days}d cambiaron de ${before ?? 'no disponible'} a ${after ?? 'no disponible'}. ` : ''; }).join('')}
                  {[7, 14].map(days => { const horizon = days as 7 | 14; const before = snapshot.forecast[horizon]; const after = current.forecast[horizon]; return before.state === 'AVAILABLE' && after.state === 'AVAILABLE' ? `El pronóstico Ridge ${days}d ${before.units === after.units ? 'se mantuvo' : 'cambió'} en las lecturas consultadas. ` : `El pronóstico Ridge ${days}d no estuvo disponible en una o ambas lecturas. `; }).join('')}
                  {analysisResults[7] || analysisResults[14]
                    ? [analysisResults[7], analysisResults[14]].filter(Boolean).every(result => !result?.trained && !result?.candidateCreated)
                      ? `La revisión no entrenó ni creó un candidato; los modelos ACTIVE permanecen en las versiones observadas: 7d ${analysisResults[7]?.activeModelAfter?.modelVersion ? `v${analysisResults[7].activeModelAfter.modelVersion}` : 'no disponible'} y 14d ${analysisResults[14]?.activeModelAfter?.modelVersion ? `v${analysisResults[14].activeModelAfter.modelVersion}` : 'no disponible'}.`
                      : 'El resultado de la revisión se muestra por horizonte arriba; no se infiere un cambio distinto de los datos observados.'
                    : 'Los pronósticos Ridge y las versiones activas se comparan arriba con sus lecturas iniciales.'}</p>
              </section>}
            </section>}
          </>}
        </div>}
      </CardContent>
    </Card>}
    {restoreVerification && <Card ref={restoreResultRef} id="ml-test-restore-result" aria-label="Verificación de restauración" className="scroll-mt-24">
      <CardHeader><CardTitle className="text-base">{restoreVerification.phase === 'VERIFYING' ? 'Restaurando punto de restauración…' : restoreVerification.phase === 'COMPLETE' ? 'Restauración completada' : 'No se pudo verificar la restauración'}</CardTitle>
        <CardDescription>Escenario {restoreVerification.scenario}. La comprobación posterior usa nuevas lecturas y no reutiliza el snapshot como estado actual.</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {restoreVerification.phase === 'VERIFYING' ? <p>Al finalizar, se volverán a leer el inventario, los pronósticos y el estado ML para verificar el retorno.</p>
          : restoreVerification.phase === 'FAILED' ? <p role="alert">{restoreVerification.message || 'La verificación no está completa.'}</p>
            : restoreVerification.observed && <>
              {verificationResult(restoreVerification.baseline, restoreVerification.observed) === true
                ? <p className="font-medium text-emerald-700">Coincide con el punto de restauración</p>
                : <p role="alert" className="font-medium">La verificación detectó diferencias o lecturas no disponibles; no se presenta como coincidencia.</p>}
              <dl className="grid gap-2 sm:grid-cols-2">
                {verificationLine('Stock', restoreVerification.baseline.inventory.stock.onHand, restoreVerification.observed.inventory.stock.onHand, 0)}
                {verificationLine('Revisión operativa', restoreVerification.baseline.ml.dataVersion, restoreVerification.observed.ml.dataVersion, 0)}
                {[7, 14].map(days => { const horizon = days as 7 | 14; return <div key={days}><dt className="text-muted-foreground">Señales pendientes {days}d</dt><dd>Post-restore: {pendingCount(restoreVerification.observed!.ml, horizon) ?? 'No disponible'} · Baseline esperado: {pendingCount(restoreVerification.baseline.ml, horizon) ?? 'No disponible'} · {sameValue(pendingCount(restoreVerification.baseline.ml, horizon), pendingCount(restoreVerification.observed!.ml, horizon)) === true ? 'Coincide' : sameValue(pendingCount(restoreVerification.baseline.ml, horizon), pendingCount(restoreVerification.observed!.ml, horizon)) === false ? 'Difiere' : 'No se pudo verificar'}</dd></div>; })}
                {[7, 14].map(days => { const horizon = days as 7 | 14; const before = restoreVerification.baseline.forecast[horizon]; const after = restoreVerification.observed!.forecast[horizon]; const match = before.state === 'AVAILABLE' && after.state === 'AVAILABLE' ? sameValue(before.units, after.units) : null; return <div key={days}><dt className="text-muted-foreground">Pronóstico Ridge {days}d</dt><dd>Post-restore: {forecastLabel(after)} · Baseline esperado: {forecastLabel(before)} · {match === true ? 'Coincide' : match === false ? 'Difiere' : 'No se pudo verificar'}</dd></div>; })}
                {[7, 14].map(days => { const horizon = days as 7 | 14; return verificationLine(`Modelo ACTIVE ${days}d`, activeVersion(restoreVerification.baseline, horizon) === null ? null : `v${activeVersion(restoreVerification.baseline, horizon)}`, activeVersion(restoreVerification.observed!, horizon) === null ? null : `v${activeVersion(restoreVerification.observed!, horizon)}`); })}
              </dl>
              {restoreVerification.mode === 'continue' ? <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => { const next = restoreVerification.scenario; setRestoreVerification(null); setRestoreScrollPending(false); void selectScenario(next); }}>Repetir escenario</Button><Button type="button" variant="outline" onClick={() => { setRestoreVerification(null); setRestoreScrollPending(false); }}>Elegir otro escenario</Button></div> : verificationResult(restoreVerification.baseline, restoreVerification.observed) === true ? <p>Prueba finalizada. El sistema volvió al punto inicial.</p> : <p role="alert">La prueba finalizó, pero el retorno al punto inicial no coincide completamente o contiene lecturas no disponibles.</p>}
            </>}
      </CardContent>
    </Card>}
  </section>;
}
