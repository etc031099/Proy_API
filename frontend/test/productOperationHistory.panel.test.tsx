import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductOperationHistoryPanel } from '@/components/business-intelligence/ProductOperationHistoryPanel';
import { apiClient } from '@/lib/api';
import type { AuthenticatedDiagnosticResult, ProductOperationDetail, ProductOperationHistoryItem, ProductOperationHistoryPage } from '@/types/businessIntelligence';

const sale = { operationId: 'SALE:507f1f77bcf86cd799439101', sourceId: '507f1f77bcf86cd799439101', type: 'SALE' as const,
  occurredAt: '2026-10-18T10:00:00.000Z', quantity: 3, reference: 'S-1', customer: 'Cliente', supplier: null,
  relationQuality: 'DIRECT_REVISION' as const, ridgeImpact: { status: 'persisted' as const, horizons: [
    { horizonDays: 7 as const, eventType: 'SALE_COMPLETED' as const, dataVersion: '84', occurredAt: null, historicalCorrection: false },
  ] }, inventoryImpact: { status: 'not_found' as const, movementType: null, quantityDelta: null, stockBefore: null, stockAfter: null } };
const page: ProductOperationHistoryPage = { product: { sku: 'SKU-1', name: 'Producto' }, items: [sale], limit: 20, hasMore: true,
  nextCursor: 'signed-cursor', filters: { type: 'ALL', from: null, to: null } };
const detail: ProductOperationDetail = { operation: sale, facts: { product: { sku: 'SKU-1', name: 'Producto' }, quantity: 3,
  reference: 'S-1', customer: 'Cliente', supplier: null, status: 'completed', receiptKey: null }, inventoryMovements: [],
  ridgeEvidence: sale.ridgeImpact, traceability: { revision: '84', eventOrdinal: 0, eventKey: 'safe-event-key',
    effectiveAtUtc: sale.occurredAt, entityType: 'sale', entityKey: sale.sourceId, operation: 'CREATE', relationQuality: 'DIRECT_REVISION' } };
const ok = <T,>(data: T): AuthenticatedDiagnosticResult<T> => ({ httpStatus: 200, data });
function historyItem(type: 'SALE' | 'SALE_CANCELLED' | 'PURCHASE_CREATED', persisted: boolean, relationQuality: 'DIRECT_REVISION' | 'LIMITED_LEGACY' = 'DIRECT_REVISION'): ProductOperationHistoryItem {
  const eventType: 'SALE_COMPLETED' | 'SALE_CANCELLED' = type === 'SALE' ? 'SALE_COMPLETED' : 'SALE_CANCELLED';
  return { ...sale, operationId: `${type}:507f1f77bcf86cd799439101`, type, relationQuality,
    ridgeImpact: persisted ? { status: 'persisted' as const, horizons: [{ horizonDays: 7 as const, eventType, dataVersion: '84', occurredAt: null, historicalCorrection: type === 'SALE_CANCELLED' }] }
      : { status: 'not_found' as const, horizons: [] } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('ProductOperationHistoryPanel', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'getProductOperations').mockResolvedValue(ok(page));
    vi.spyOn(apiClient, 'getProductOperationDetail').mockResolvedValue(ok(detail));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('loads only when mounted, sends filters to backend and renders persisted sale evidence and detail', async () => {
    render(<ProductOperationHistoryPanel sku="SKU-1" />);
    expect(await screen.findByText('Ventas')).toBeTruthy();
    expect(apiClient.getProductOperations).toHaveBeenCalledWith('SKU-1', { type: 'ALL', limit: 20 }, expect.any(AbortSignal));
    fireEvent.change(screen.getByLabelText('Filtrar por tipo'), { target: { value: 'SALE' } });
    await waitFor(() => expect(apiClient.getProductOperations).toHaveBeenLastCalledWith('SKU-1', { type: 'SALE', limit: 20 }, expect.any(AbortSignal)));
    expect(screen.getByText('Evidencia Ridge')).toBeTruthy();
    expect(screen.getByText(/No implica reentrenamiento ni promoción inmediata/)).toBeTruthy();
    fireEvent.click(document.querySelector('summary')!);
    expect(await screen.findByText('Relación con Ridge')).toBeTruthy();
    expect(apiClient.getProductOperationDetail).toHaveBeenCalledWith('SKU-1', sale.operationId, expect.any(AbortSignal));
  });

  it('uses evidence-confirming sale copy and badge only when a persisted SALE_COMPLETED signal is linked', async () => {
    const item = historyItem('SALE', true);
    vi.mocked(apiClient.getProductOperations).mockResolvedValue(ok({ ...page, items: [item], hasMore: false, nextCursor: null }));
    render(<ProductOperationHistoryPanel sku="SKU-1" />);
    expect(await screen.findByText('Esta venta aportó evidencia de demanda al pipeline Ridge. No implica reentrenamiento ni promoción inmediata.')).toBeTruthy();
    expect(screen.getByText('Evidencia Ridge')).toBeTruthy();
  });

  it('does not claim pipeline evidence for a sale without a persisted signal', async () => {
    const item = historyItem('SALE', false);
    vi.mocked(apiClient.getProductOperations).mockResolvedValue(ok({ ...page, items: [item], hasMore: false, nextCursor: null }));
    render(<ProductOperationHistoryPanel sku="SKU-1" />);
    expect(await screen.findByText('Esta venta representa demanda observada, pero no existe una señal Ridge persistida que permita confirmar su incorporación al pipeline.')).toBeTruthy();
    expect(screen.getByText('Sin evidencia Ridge')).toBeTruthy();
    expect(screen.queryByText(/aportó evidencia al pipeline/)).toBeNull();
  });

  it('states that a cancellation corrected Ridge evidence only when its persisted signal is linked', async () => {
    const item = historyItem('SALE_CANCELLED', true);
    vi.mocked(apiClient.getProductOperations).mockResolvedValue(ok({ ...page, items: [item], hasMore: false, nextCursor: null }));
    render(<ProductOperationHistoryPanel sku="SKU-1" />);
    expect(await screen.findByText('Esta cancelación corrigió evidencia previamente registrada en el pipeline Ridge.')).toBeTruthy();
    expect(screen.getByText('Corrección Ridge')).toBeTruthy();
  });

  it('describes a legacy cancellation without claiming a persisted Ridge correction', async () => {
    const item = historyItem('SALE_CANCELLED', false, 'LIMITED_LEGACY');
    vi.mocked(apiClient.getProductOperations).mockResolvedValue(ok({ ...page, items: [item], hasMore: false, nextCursor: null }));
    render(<ProductOperationHistoryPanel sku="SKU-1" />);
    expect(await screen.findByText('Esta cancelación revierte una venta registrada, pero no existe una señal Ridge persistida que permita confirmar una corrección histórica en el pipeline.')).toBeTruthy();
    expect(screen.getByText('Sin evidencia Ridge')).toBeTruthy();
    expect(screen.getByText('Histórico limitado')).toBeTruthy();
    expect(screen.queryByText(/corrigió evidencia previamente registrada/)).toBeNull();
  });

  it('keeps purchase copy that separates inventory impact from Ridge demand', async () => {
    const item = historyItem('PURCHASE_CREATED', false);
    vi.mocked(apiClient.getProductOperations).mockResolvedValue(ok({ ...page, items: [item], hasMore: false, nextCursor: null }));
    render(<ProductOperationHistoryPanel sku="SKU-1" />);
    expect(await screen.findByText('Esta compra afecta inventario, pero no representa demanda observada por Ridge.')).toBeTruthy();
    expect(screen.getByText('Sin evidencia Ridge')).toBeTruthy();
  });

  it('sends date boundaries and cursor to server and appends next page', async () => {
    vi.spyOn(apiClient, 'getProductOperations').mockImplementation(async (_sku, params) => ok(params?.cursor
      ? { ...page, items: [], hasMore: false, nextCursor: null } : page));
    render(<ProductOperationHistoryPanel sku="SKU-1" />);
    await screen.findByText('Ventas');
    fireEvent.change(screen.getByLabelText('Fecha desde'), { target: { value: '2026-10-18' } });
    await waitFor(() => expect(apiClient.getProductOperations).toHaveBeenLastCalledWith('SKU-1', { type: 'ALL', from: '2026-10-18', limit: 20 }, expect.any(AbortSignal)));
    fireEvent.click(await screen.findByText('Cargar más'));
    await waitFor(() => expect(apiClient.getProductOperations).toHaveBeenLastCalledWith('SKU-1', { type: 'ALL', from: '2026-10-18', limit: 20, cursor: 'signed-cursor' }, expect.any(AbortSignal)));
  });

  it('clears the prior SKU page and aborts its request when the selected product changes', async () => {
    const firstPage = deferred<AuthenticatedDiagnosticResult<ProductOperationHistoryPage>>();
    vi.spyOn(apiClient, 'getProductOperations').mockReturnValueOnce(firstPage.promise).mockResolvedValueOnce(ok({ ...page, product: { sku: 'SKU-2', name: 'Producto dos' }, items: [], hasMore: false, nextCursor: null }));
    const { rerender } = render(<ProductOperationHistoryPanel sku="SKU-1" />);
    const firstSignal = vi.mocked(apiClient.getProductOperations).mock.calls[0][2];
    rerender(<ProductOperationHistoryPanel sku="SKU-2" />);
    expect(firstSignal?.aborted).toBe(true);
    expect(await screen.findByText('No hay operaciones para los filtros seleccionados.')).toBeTruthy();
    expect(apiClient.getProductOperations).toHaveBeenLastCalledWith('SKU-2', { type: 'ALL', limit: 20 }, expect.any(AbortSignal));
    firstPage.resolve(ok(page));
  });

  it('provides retry and empty/error states without client-side filtering', async () => {
    vi.spyOn(apiClient, 'getProductOperations').mockResolvedValueOnce({ httpStatus: 503, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' }).mockResolvedValueOnce(ok({ ...page, items: [], hasMore: false, nextCursor: null }));
    render(<ProductOperationHistoryPanel sku="SKU-1" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText('Reintentar'));
    expect(await screen.findByText('No hay operaciones para los filtros seleccionados.')).toBeTruthy();
  });
});
