import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PendingActionCard } from '@/components/assistant/PendingActionCard';
import { apiClient } from '@/lib/api';
import type { PendingActionPreview } from '@/types/agent';
vi.mock('@/lib/api', () => ({ apiClient: { decideAgentAction: vi.fn() } }));
const pending: PendingActionPreview = { pendingActionId: '11111111-1111-4111-8111-111111111111', action: 'create_product',
  summary: 'Crear producto demo', fields: { stock: 5, sku: 'SKU-001', price: 10 }, expiresAt: '2099-01-01T00:00:00Z',
  requiresConfirmation: true, status: 'PENDING' };
it('preview is visible and confirmation sends only bound action ID and conversation once', async () => {
  let finish!: (value: { success: boolean; data: PendingActionPreview }) => void;
  vi.mocked(apiClient.decideAgentAction).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  expect(screen.getByText('Crear producto demo')).toBeTruthy(); expect(screen.getByText(/0 tokens/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect(apiClient.decideAgentAction).toHaveBeenCalledTimes(1);
  expect(apiClient.decideAgentAction).toHaveBeenCalledWith(pending.pendingActionId, 'conversation', 'confirm');
  expect(screen.getByRole('button', { name: 'Cancelar' }).hasAttribute('disabled')).toBe(true);
  finish({ success: true, data: { ...pending, status: 'EXECUTED' } });
  expect(await screen.findByText(/Estado: EXECUTED/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
});
it('cancel is explicit and never sends product arguments', async () => {
  vi.mocked(apiClient.decideAgentAction).mockResolvedValue({ success: true, data: { ...pending, status: 'CANCELLED' } });
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(await screen.findByText(/Estado: CANCELLED/)).toBeTruthy();
  expect(apiClient.decideAgentAction).toHaveBeenCalledWith(pending.pendingActionId, 'conversation', 'cancel');
});
it('expired preview cannot be confirmed', () => {
  render(<PendingActionCard action={{ ...pending, expiresAt: '2000-01-01T00:00:00Z' }} conversationId="conversation" />);
  expect(screen.getByText(/Estado: EXPIRED/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
});
it('uncertain failure is safe and does not auto-retry', async () => {
  vi.mocked(apiClient.decideAgentAction).mockRejectedValue(new Error('password=private'));
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect((await screen.findByRole('alert')).textContent).not.toContain('private');
  expect(apiClient.decideAgentAction).toHaveBeenCalledTimes(1);
});
