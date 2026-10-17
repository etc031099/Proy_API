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
  items, page: { limit: 20, nextCursor },
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

  it('loads newest-first compact executions, identifies sources, shows origins, and keeps detail lazy', async () => {
    const older = makeExecution({ executionId: '22222222-2222-4222-8222-222222222222',
      triggerSource: 'SCHEDULED', requestSource: 'SCHEDULED', status: 'NO_PENDING_WORK', availableOrigins: null, requiredOrigins: null });
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage([makeExecution(), older])));
    render(<ForecastMlUpdateHistoryPanel />);
    const card = await screen.findByText('92 / 107 orígenes maduros. El sistema requiere 107 orígenes maduros para una evaluación elegible.');
    expect(card).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy(); expect(screen.getByText('Automático')).toBeTruthy();
    expect(screen.getAllByText((_, node) => node?.tagName === 'P' && Boolean(node.textContent?.includes('Revisión evaluada: 92')))).toHaveLength(2);
    expect(screen.getAllByText('v1 → v2')).toHaveLength(4);
    expect(apiClient.getForecastMlUpdateExecution).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Ver detalle' })[0]);
    expect(await screen.findByText(/Observaciones cerradas para esta ejecución:/)).toBeTruthy();
    expect(apiClient.getForecastMlUpdateExecution).toHaveBeenCalledWith(executionId);
  });

  it('uses distinct state copy and does not collapse outcomes into “sin cambios”', async () => {
    const statuses = ['NOT_ELIGIBLE', 'EVALUATED_NO_PROMOTION', 'PROMOTED', 'PARTIAL', 'FAILED', 'INTERRUPTED', 'NO_PENDING_WORK', 'DEFERRED'] as const;
    vi.mocked(apiClient.getForecastMlUpdateHistory).mockResolvedValue(ok(historyPage(statuses.map((status, index) => makeExecution({
      executionId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`, status,
    })))));
    render(<ForecastMlUpdateHistoryPanel />);
    expect(await screen.findByText('Se recibieron cambios, pero todavía no existe evidencia suficiente para evaluar o promover un nuevo modelo.')).toBeTruthy();
    expect(screen.getByText('Se evaluó un candidato, pero no superó la política de promoción.')).toBeTruthy();
    expect(screen.getByText('Se activó una nueva versión del modelo.')).toBeTruthy();
    expect(screen.getByText('Los horizontes tuvieron resultados diferentes.')).toBeTruthy();
    expect(screen.getByText('La ejecución no pudo completarse.')).toBeTruthy();
    expect(screen.getByText('La ejecución quedó interrumpida.')).toBeTruthy();
    expect(screen.getByText('Se revisó el sistema y no había trabajo pendiente.')).toBeTruthy();
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
    expect(await screen.findByText('Orígenes maduros: No capturado.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
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
    expect(await screen.findByText('Manual')).toBeTruthy();
    await waitFor(() => expect(apiClient.getForecastMlUpdateHistory).toHaveBeenCalledTimes(2));
  });
});
