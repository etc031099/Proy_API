import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PendingActionCard } from '@/components/assistant/PendingActionCard';
import { apiClient } from '@/lib/api';
import type { PendingActionPreview } from '@/types/agent';
vi.mock('@/lib/api', () => ({ apiClient: { decideAgentAction: vi.fn() } }));
const pending: PendingActionPreview = { pendingActionId: '11111111-1111-4111-8111-111111111111', action: 'create_product',
  summary: 'Crear producto demo', fields: { stock: 5, sku: 'SKU-001', price: 10 }, expiresAt: '2099-01-01T00:00:00Z',
  requiresConfirmation: true, status: 'PENDING' };
it('stock rule card displays configured condition without fake stock, Mongo ID or notification promise', () => {
  render(<PendingActionCard action={{ ...pending, action: 'create_stock_alert_rule', summary: 'Configurar regla de stock',
    fields: { sku: 'SKU-001', name: 'Demo', description: 'Stock <= 3 unidades' }, status: 'EXECUTED',
    result: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', sku: 'SKU-001', operator: '<=', threshold: 3, ruleConfigured: true, alreadyExists: true } }} conversationId="conversation" />);
  expect(screen.getByText(/Regla activa existente: SKU-001/)).toBeTruthy();
  expect(screen.getByText(/Todavía no envía avisos automáticos/)).toBeTruthy();
  expect(screen.queryByText(/Stock: undefined/)).toBeNull(); expect(screen.queryByText(/bbbbbbbbbbbbbbbbbbbbbbbb/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('preview is visible and confirmation sends only bound action ID and conversation once', async () => {
  let finish!: (value: { success: boolean; data: PendingActionPreview }) => void;
  vi.mocked(apiClient.decideAgentAction).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  expect(screen.getByText('Crear producto demo')).toBeTruthy(); expect(screen.getByText(/Confirmación sin IA/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect(apiClient.decideAgentAction).toHaveBeenCalledTimes(1);
  expect(apiClient.decideAgentAction).toHaveBeenCalledWith(pending.pendingActionId, 'conversation', 'confirm');
  expect(screen.getByRole('button', { name: 'Cancelar' }).hasAttribute('disabled')).toBe(true);
  finish({ success: true, data: { ...pending, status: 'EXECUTED' } });
  expect(await screen.findByText(/Estado: Ejecutada/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
});
it('cancel is explicit and never sends product arguments', async () => {
  vi.mocked(apiClient.decideAgentAction).mockResolvedValue({ success: true, data: { ...pending, status: 'CANCELLED' } });
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(await screen.findByText(/Estado: Cancelada/)).toBeTruthy();
  expect(apiClient.decideAgentAction).toHaveBeenCalledWith(pending.pendingActionId, 'conversation', 'cancel');
});
it('expired preview cannot be confirmed', () => {
  render(<PendingActionCard action={{ ...pending, expiresAt: '2000-01-01T00:00:00Z' }} conversationId="conversation" />);
  expect(screen.getByText(/Estado: Expirada/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
});
it('uncertain failure is safe and does not auto-retry', async () => {
  vi.mocked(apiClient.decideAgentAction).mockRejectedValue(new Error('password=private'));
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect((await screen.findByRole('alert')).textContent).not.toContain('private');
  expect(apiClient.decideAgentAction).toHaveBeenCalledTimes(1);
});
for (const type of ['sale', 'purchase'] as const) it(`restored ${type} preview shows items, prices and stock without executing`, () => {
  render(<PendingActionCard action={{ ...pending, action: `create_${type}`, summary: type === 'sale' ? 'Registrar venta' : 'Registrar compra',
    fields: { currency: 'PEN', total: 30, paymentMethod: type === 'sale' ? 'credit' : 'cash', contact: 'Contacto demo' },
    items: [{ sku: 'SKU-002', name: 'Agua', quantity: 3, stock: 20, resultingStock: type === 'sale' ? 17 : 23, price: 10, total: 30 }] }} conversationId="conversation" />);
  expect(screen.getByText(/Agua · SKU-002/)).toBeTruthy();
  expect(screen.getByText(/Stock actual: 20/)).toBeTruthy(); expect(screen.getByText(/Precio unitario: 10 PEN/)).toBeTruthy();
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('restored executed action displays persisted result and never offers confirmation', () => {
  render(<PendingActionCard action={{ ...pending, status: 'EXECUTED', result: { id: 'op-synthetic', type: 'sale', currency: 'PEN', total: 30,
    items: [{ sku: 'SKU-002', name: 'Agua', quantity: 3, stock: 17 }] } }} conversationId="conversation" />);
  expect(screen.getByText(/3 unidades de SKU-002 · Stock resultante: 17/)).toBeTruthy();
  expect(screen.getByText('Total: 30 PEN')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('restored expired action stays expired even with future expiresAt', () => {
  render(<PendingActionCard action={{ ...pending, status: 'EXPIRED' }} conversationId="conversation" />);
  expect(screen.getByText('Esta acción expiró.')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('refreshed authoritative history replaces an existing pending card with its executed result', () => {
  const view = render(<PendingActionCard action={pending} conversationId="conversation" />);
  view.rerender(<PendingActionCard action={{ ...pending, status: 'EXECUTED', result: { id: 'op-refreshed', sku: 'SKU-001', stock: 5 } }} conversationId="conversation" />);
  expect(screen.getByText(/Estado: Ejecutada/)).toBeTruthy(); expect(screen.getByText(/op-refreshed/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull(); expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
