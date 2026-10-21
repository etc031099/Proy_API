import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastMlUpdateHistoryPanel } from '@/components/business-intelligence/ForecastMlUpdateHistoryPanel';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ForecastMlProductImpact, ForecastMlUpdateExecution,
  ForecastMlUpdateExecutionDetail, ForecastMlUpdateHistoryPage, ForecastMlUpdateProductsPage } from '@/types/businessIntelligence';

const executionId = '11111111-1111-4111-8111-111111111111';
const counts = { totalProductsEvaluated: 2, comparableProductsCount: 1, predictionChangedCount: 1,
  p7: { increasedCount: 1, decreasedCount: 0 }, p14: { increasedCount: 0, decreasedCount: 1 },
  riskChangedCount: 1, reorderDecisionChangedCount: 1, recommendedQtyChangedCount: 1,
  reorderPointChangedCount: 1, coverageChangedCount: 1, rankingChangedCount: 0, notComparableCount: 1 };
const makeExecution = (overrides: Partial<ForecastMlUpdateExecution> = {}): ForecastMlUpdateExecution => ({
  executionId, triggerSource: 'MANUAL', requestSource: 'MANUAL', requestedAt: '2026-10-17T15:30:00.000Z',
  startedAt: null, finishedAt: null, status: 'PROMOTED', reasonCode: null, dataVersionEvaluated: '92',
  observationsClosedThrough: '2026-10-16', availableOrigins: 92, requiredOrigins: 107, pendingBefore: true, pendingAfter: false,
  horizons: [7, 14].map(horizonDays => ({ horizonDays: horizonDays as 7 | 14,
    activeVersionBefore: 1, activeVersionAfter: 2, candidateVersion: 2, resultStatus: 'PROMOTED' as const,
    promotionDecision: 'PROMOTED' as const, promotionReason: null, availableOrigins: 92, requiredOrigins: 107,
    trainingJobReference: null })),
  impact: { status: 'COMPLETE', reasonCode: null,
    prediction: { status: 'COMPLETE', reasonCode: null, summary: counts },
    inventory: { status: 'COMPLETE', reasonCode: null, summary: counts } }, ...overrides,
});
const withoutCandidate = (status: ForecastMlUpdateExecution['status'], reasonCode: string | null = null) => makeExecution({
  status, reasonCode, horizons: [7, 14].map(horizonDays => ({ horizonDays: horizonDays as 7 | 14,
    activeVersionBefore: 1, activeVersionAfter: 1, candidateVersion: null, resultStatus: status,
    promotionDecision: 'NOT_EVALUATED', promotionReason: reasonCode, availableOrigins: null, requiredOrigins: null,
    trainingJobReference: null })),
});
const detail = (row: ForecastMlUpdateExecution = makeExecution()): ForecastMlUpdateExecutionDetail => ({
  ...row, stage: 'FINISHED', eligibility: 'ELIGIBLE', signalTypes: ['SALE_COMPLETED'],
  attempts: [{ runAttempt: 1, status: row.status, reasonCode: null, startedAt: row.startedAt,
    finishedAt: row.finishedAt, horizons: row.horizons }], dataVersionBefore: '91', message: null,
  impact: { ...row.impact, prediction: { ...row.impact.prediction,
    versions: [{ horizonDays: 7, beforeVersion: 1, afterVersion: 2 }, { horizonDays: 14, beforeVersion: 1, afterVersion: 2 }] } },
});
const product: ForecastMlProductImpact = {
  sku: 'SKU-1', productName: 'Sprite 500 ml',
  prediction: { p7: { old: 0, new: 2, delta: 2, deltaPct: null, direction: 'INCREASED' },
    p14: { old: null, new: 5, delta: null, deltaPct: null, direction: 'NOT_COMPARABLE' } },
  inventory: { risk: { before: null, after: 'HIGH', changed: null },
    shouldReorder: { before: null, after: false, changed: null },
    recommendedQty: { before: null, after: 0, delta: null }, reorderPoint: { before: 4, after: 6, delta: 2 },
    coverage: { daysCoverBefore: null, daysCoverAfter: 7, delta: null },
    ranking: { positionBefore: null, positionAfter: 2, delta: null, status: 'NOT_COMPARABLE' } },
};
const ok = <T,>(data: T): AuthenticatedDiagnosticResult<T> => ({ httpStatus: 200, data });
const historyPage = (items: ForecastMlUpdateExecution[], nextCursor: string | null = null): ForecastMlUpdateHistoryPage => ({
  items, page: { limit: 5, nextCursor },
});
const productsPage = (items: ForecastMlProductImpact[], nextCursor: string | null = null): ForecastMlUpdateProductsPage => ({
  executionId, items, page: { limit: 25, nextCursor },
});

describe('forecast ML update history panel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'getForecastMlUpdateHistory').mockResolvedValue(ok(historyPage([makeExecution()])));
    vi.spyOn(apiClient, 'getForecastMlUpdateExecution').mockResolvedValue(ok(detail()));
    vi.spyOn(apiClient, 'getForecastMlUpdateProducts').mockResolvedValue(ok(productsPage([product])));
  });
  afterEach(() => cleanup());

  async function openFullHistory() {
    fireEvent.click(await screen.findByRole('button', { name: 'Ver historial completo' }));
  }

  it('loads newest-first compact executions, identifies sources, shows origins, and keeps detail lazy', async () => {
    const older = makeExecution({ executionId: '22222222-2222-4222-8222-222222222222',
      triggerSource: 'SCHEDULED', requestSource: 'SCHEDULED', status: 'NO_PENDING_WORK', availableOrigins: null, requiredOrigins: null });
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage([makeExecution(), older])));
    render(<ForecastMlUpdateHistoryPanel />);
    expect(apiClient.getForecastMlUpdateHistory).toHaveBeenCalledWith({ limit: 5 });
    await screen.findAllByText('Modelo promovido');
    expect(screen.getByText((_, node) => node?.tagName === 'SPAN' && Boolean(node.textContent?.startsWith('Manual')))).toBeTruthy();
    expect(screen.getByText((_, node) => node?.tagName === 'SPAN' && Boolean(node.textContent?.startsWith('Automático')))).toBeTruthy();
    expect(screen.getAllByRole('article').every(article => article.textContent?.includes('Revisión 92'))).toBe(true);
    expect(screen.getAllByText('v1 → v2')).toHaveLength(4);
    expect(apiClient.getForecastMlUpdateExecution).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Ver detalle' })[0]);
    expect(await screen.findByText('92 / 107 orígenes maduros. Se requieren 107 orígenes maduros para una evaluación elegible.')).toBeTruthy();
    expect(await screen.findByText(/Observaciones cerradas para esta ejecución:/)).toBeTruthy();
    expect(apiClient.getForecastMlUpdateExecution).toHaveBeenCalledWith(executionId);
  });

  it('shows at most three recent executions until the complete-history disclosure is opened', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => makeExecution({
      executionId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    }));
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage(rows, 'next-page')));
    render(<ForecastMlUpdateHistoryPanel />);
    await screen.findAllByText('Modelo promovido');
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial completo' }));
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(screen.getByRole('group', { name: 'Filtrar historial' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cargar más' })).toBeTruthy();
  });

  it('uses distinct state copy and does not collapse outcomes into “sin cambios”', async () => {
    const statuses = ['NOT_ELIGIBLE', 'EVALUATED_NO_PROMOTION', 'PROMOTED', 'PARTIAL', 'FAILED', 'INTERRUPTED', 'NO_PENDING_WORK', 'DEFERRED'] as const;
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage(statuses.map((status, index) => makeExecution({
      executionId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`, status, horizons: [],
    })))));
    render(<ForecastMlUpdateHistoryPanel />);
    await openFullHistory();
    expect(await screen.findByText('La evidencia aún no es elegible.')).toBeTruthy();
    expect(screen.getByText('Candidato evaluado; no se promovió.')).toBeTruthy();
    expect(screen.getByText('Se activó una nueva versión.')).toBeTruthy();
    expect(screen.getByText('Los horizontes tuvieron resultados diferentes.')).toBeTruthy();
    expect(screen.getByText('La ejecución requiere revisión.')).toBeTruthy();
    expect(screen.getByText('La ejecución quedó interrumpida.')).toBeTruthy();
    expect(screen.getByText('No había trabajo nuevo por procesar.')).toBeTruthy();
    expect(screen.getByText('La solicitud quedó pendiente para una ejecución posterior.')).toBeTruthy();
  });

  it('loads execution detail on expansion and then products and cursor pages only on request', async () => {
    vi.mocked(apiClient.getForecastMlUpdateProducts)
      .mockResolvedValueOnce(ok(productsPage([product], 'products-cursor')))
      .mockResolvedValueOnce(ok(productsPage([{ ...product, sku: 'SKU-2', productName: 'Pan' }])));
    render(<ForecastMlUpdateHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalle' }));
    expect(await screen.findByText('Predicciones · COMPLETE')).toBeTruthy();
    expect(screen.getByText('Productos con cambios: 1')).toBeTruthy();
    expect(screen.getByText('Riesgo: 1 productos con cambio')).toBeTruthy();
    expect(screen.getByText(/mismo snapshot operacional/)).toBeTruthy();
    expect(screen.getByText(/solo Ridge 7d y 14d/)).toBeTruthy();
    expect(screen.queryByText(/Horizonte 1 día/)).toBeNull();
    expect(apiClient.getForecastMlUpdateProducts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ver productos afectados' }));
    expect(await screen.findByText('P7 antes → después: 0 → 2')).toBeTruthy();
    expect(screen.getAllByText('No capturado').length).toBeGreaterThan(0);
    expect(screen.queryByText(/secret|artifact|feature matrix/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más productos' }));
    expect(await screen.findByText('Pan')).toBeTruthy();
    expect(apiClient.getForecastMlUpdateProducts).toHaveBeenNthCalledWith(1, executionId, { limit: 25 });
    expect(apiClient.getForecastMlUpdateProducts).toHaveBeenNthCalledWith(2, executionId, { limit: 25, cursor: 'products-cursor' });
  });

  it('shows not-applicable impact for a non-promoted execution and preserves uncaptured origins', async () => {
    const noPromotion = makeExecution({ status: 'NOT_ELIGIBLE', availableOrigins: null, requiredOrigins: null,
      horizons: [7, 14].map(horizonDays => ({ horizonDays: horizonDays as 7 | 14, activeVersionBefore: 1,
        activeVersionAfter: 1, candidateVersion: null, resultStatus: 'NOT_ELIGIBLE' as const,
        promotionDecision: 'NOT_EVALUATED' as const, promotionReason: 'NO_PROMOTION_INSUFFICIENT_HISTORY',
        availableOrigins: null, requiredOrigins: null, trainingJobReference: null })),
      impact: { status: 'NOT_APPLICABLE', reasonCode: 'NO_MODEL_PROMOTION',
        prediction: { status: 'NOT_CAPTURED', reasonCode: 'NO_MODEL_PROMOTION', summary: null },
        inventory: { status: 'NOT_CAPTURED', reasonCode: 'NO_MODEL_PROMOTION', summary: null } },
    });
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage([noPromotion])));
    vi.mocked(apiClient.getForecastMlUpdateExecution).mockResolvedValue(ok(detail(noPromotion)));
    render(<ForecastMlUpdateHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalle' }));
    expect(await screen.findByText('Orígenes maduros: No capturado.')).toBeTruthy();
    expect(await screen.findByText('No aplica porque no se activó una nueva versión.')).toBeTruthy();
    expect(screen.getByText('El modelo activo no cambió.')).toBeTruthy();
  });

  it('keeps history failures local and supports retry', async () => {
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockRejectedValueOnce(new Error('private backend detail'))
      .mockResolvedValueOnce(ok(historyPage([makeExecution()])));
    render(<ForecastMlUpdateHistoryPanel />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/pronósticos siguen disponibles/)).toBeTruthy();
    expect(screen.queryByText('private backend detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText((_, node) => node?.tagName === 'SPAN' && Boolean(node.textContent?.startsWith('Manual')))).toBeTruthy();
    await waitFor(() => expect(apiClient.getForecastMlUpdateHistory).toHaveBeenCalledTimes(2));
  });

  it('filters by durable statuses and reason codes, not by displayed copy', async () => {
    const rows = [
      makeExecution(),
      makeExecution({ executionId: '22222222-2222-4222-8222-222222222222', status: 'EVALUATED_NO_PROMOTION',
        horizons: makeExecution().horizons.map(item => ({ ...item, activeVersionAfter: 1,
          candidateVersion: 2, resultStatus: 'EVALUATED_NO_PROMOTION', promotionDecision: 'NOT_PROMOTED' })) }),
      { ...withoutCandidate('NOT_ELIGIBLE', 'NOT_MATURE'), executionId: '33333333-3333-4333-8333-333333333333' },
      { ...withoutCandidate('NO_PENDING_WORK', 'NO_PENDING_WORK'), executionId: '44444444-4444-4444-8444-444444444444' },
      { ...withoutCandidate('FAILED', 'WORKER_FAILED'), executionId: '55555555-5555-4555-8555-555555555555' },
    ];
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage(rows)));
    render(<ForecastMlUpdateHistoryPanel />);
    await openFullHistory();
    await screen.findByText('Modelo promovido');

    fireEvent.click(screen.getByRole('button', { name: 'Promovidos' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('Modelo promovido')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Evaluados' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('Modelo promovido')).toBeTruthy();
    expect(screen.getByText('Evaluado · sin promoción')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'No elegibles' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.queryByText('Modelo promovido')).toBeNull();
    expect(screen.getByText('No elegible')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sin trabajo' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.queryByText('Modelo promovido')).toBeNull();
    expect(screen.getByText('Sin trabajo pendiente')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Errores' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.queryByText('Modelo promovido')).toBeNull();
    expect(screen.getByText('Error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    expect(screen.getAllByRole('article')).toHaveLength(5);

    const unknown = { ...withoutCandidate('UNKNOWN', 'A message mentioning NOT_MATURE is not a reason code'),
      executionId: '66666666-6666-4666-8666-666666666666' };
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage([unknown])));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar historial' }));
    await screen.findByText('No capturado');
    fireEvent.click(screen.getByRole('button', { name: 'No elegibles' }));
    expect(screen.getByText('No hay más ejecuciones que coincidan con este filtro.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    expect(screen.getByText('No capturado')).toBeTruthy();
  });

  it('uses the existing cursor, appends unique executions, keeps filter active and hides load more at the end', async () => {
    const first = makeExecution();
    const second = { ...withoutCandidate('NO_PENDING_WORK', 'NO_PENDING_WORK'), executionId: '22222222-2222-4222-8222-222222222222' };
    vi.mocked(apiClient.getForecastMlUpdateHistory)
      .mockResolvedValueOnce(ok(historyPage([first], 'cursor-1')))
      .mockResolvedValueOnce(ok(historyPage([first, second])))
      .mockResolvedValueOnce(ok(historyPage([second])));
    render(<ForecastMlUpdateHistoryPanel />);
    await openFullHistory();
    await screen.findByText('Modelo promovido');
    fireEvent.click(screen.getByRole('button', { name: 'Sin trabajo' }));
    expect(screen.getByText('No hay coincidencias entre los registros cargados.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    expect(await screen.findByText('Sin trabajo pendiente')).toBeTruthy();
    expect(apiClient.getForecastMlUpdateHistory).toHaveBeenNthCalledWith(2, { limit: 5, cursor: 'cursor-1' });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Sin trabajo' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar historial' }));
    await waitFor(() => expect(apiClient.getForecastMlUpdateHistory).toHaveBeenCalledTimes(3));
    expect(apiClient.getForecastMlUpdateHistory).toHaveBeenNthCalledWith(3, { limit: 5 });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Sin trabajo' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('expands only one execution at a time and leaves technical codes collapsed', async () => {
    const other = { ...withoutCandidate('NO_PENDING_WORK', 'NO_PENDING_WORK'), executionId: '22222222-2222-4222-8222-222222222222' };
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage([makeExecution(), other])));
    render(<ForecastMlUpdateHistoryPanel />);
    const expanders = await screen.findAllByRole('button', { name: 'Ver detalle' });
    fireEvent.click(expanders[0]);
    await screen.findByRole('region', { name: 'Resultado ML por horizonte' });
    expect(screen.getAllByText('v1 → v2').length).toBeGreaterThan(0);
    expect(screen.getByText('Detalles técnicos').closest('details')?.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ocultar detalle' })).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /detalle/ }).filter(button => button.getAttribute('aria-expanded') === 'true')).toHaveLength(1);
    expect(apiClient.getForecastMlUpdateExecution).toHaveBeenCalledTimes(2);
  });
});
