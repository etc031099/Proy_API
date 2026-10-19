'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api';
import type { MlTestControlStatus, MlTestLifecycleStatus } from '@/types/businessIntelligence';

type ViewState = 'loading' | 'unavailable' | 'not-local' | 'ready';
type Action = 'checkpoint' | 'continue' | 'finish' | null;

function friendlyFailure(httpStatus: number): string {
  if (httpStatus === 409) return 'La operación no puede ejecutarse en el estado actual. Actualiza el estado e inténtalo de nuevo si corresponde.';
  if (httpStatus === 503) return 'El entorno de pruebas está temporalmente no disponible. Los datos de la prueba se mantienen protegidos.';
  if (httpStatus === 401 || httpStatus === 403) return 'Esta cuenta no tiene autorización para administrar las pruebas locales.';
  return 'No se pudo conectar con el entorno de pruebas. Puedes volver a consultar el estado.';
}

export function MlTestControlPanel() {
  const [view, setView] = useState<ViewState>('loading');
  const [status, setStatus] = useState<MlTestLifecycleStatus | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (clearMessage = true) => {
    if (clearMessage) setMessage(null);
    try {
      const gate = await apiClient.getMlTestControlStatus();
      if (gate.httpStatus !== 200 || !gate.data) {
        setStatus(null);
        setView('unavailable');
        return;
      }
      const nextCapability = gate.data.capabilities?.destructiveMlTestControls;
      if (nextCapability?.allowed !== true || nextCapability.target !== 'LOCAL') {
        setStatus(null);
        setView('not-local');
        return;
      }

      const lifecycle = await apiClient.getMlTestLifecycleStatus();
      if (lifecycle.httpStatus !== 200 || !lifecycle.data) {
        setStatus(null);
        setView('unavailable');
        return;
      }
      setStatus(lifecycle.data);
      setView('ready');
    } catch {
      setStatus(null);
      setView('unavailable');
    }
  }, []);

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
      }
      await refresh(false);
    } catch {
      setMessage('No se pudo conectar con el entorno de pruebas. Puedes volver a consultar el estado.');
      await refresh(false);
    } finally {
      setAction(null);
    }
  };

  const busy = action !== null;
  const maintenance = status?.maintenance === true;
  const checkpointReady = status?.checkpoint?.status === 'READY';
  const canStart = status?.state === 'NO_TEST' && !maintenance && !busy;
  const canRestore = status?.state === 'TEST_ACTIVE' && checkpointReady && !maintenance && !busy;

  return <section aria-labelledby="ml-test-controls-title" className="space-y-3">
    <div>
      <h2 id="ml-test-controls-title" className="text-xl font-semibold">Pruebas del Machine Learning</h2>
      <p className="text-sm text-muted-foreground">Entorno local de demostración con checkpoint y restauración</p>
    </div>
    {view === 'loading' && <Card><CardContent role="status" className="p-5 text-sm text-muted-foreground">Verificando disponibilidad del entorno local…</CardContent></Card>}
    {view === 'unavailable' && <Card><CardContent className="space-y-3 p-5"><p role="status" className="text-sm">No se pudo consultar el estado del entorno de pruebas. Business Intelligence sigue disponible; vuelve a consultar cuando el servicio responda.</p><Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>Consultar estado</Button></CardContent></Card>}
    {view === 'not-local' && <Card><CardContent className="p-5"><p className="text-sm text-muted-foreground">Las pruebas destructivas del ML solo están disponibles en el entorno local autorizado.</p></CardContent></Card>}
    {view === 'ready' && status && <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Estado del ciclo de prueba</CardTitle>
          <div className="flex gap-2"><Badge variant="outline">LOCAL AUTORIZADO</Badge><Badge variant={status.state === 'TEST_ACTIVE' ? 'default' : 'secondary'}>{status.state === 'TEST_ACTIVE' ? 'TEST ACTIVE' : status.state === 'NO_TEST' ? 'SIN PRUEBA ACTIVA' : status.state}</Badge></div>
        </div>
        <CardDescription>Estas acciones solo restauran o guardan el estado del entorno local; no ejecutan entrenamiento.</CardDescription>
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
    </Card>}
  </section>;
}
