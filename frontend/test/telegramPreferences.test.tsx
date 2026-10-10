import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TelegramRulePreferences } from '@/components/TelegramRulePreferences';
import { apiClient } from '@/lib/api';
vi.mock('@/lib/api', () => ({ apiClient: { updateTelegramRulePreferences: vi.fn() } }));
describe('Telegram stock rule preferences', () => {
  it('defaults false and sends only explicit opt-ins, without secrets', async () => {
    vi.mocked(apiClient.updateTelegramRulePreferences).mockResolvedValue({ success: true });
    render(<TelegramRulePreferences />);
    const boxes = screen.getAllByRole('checkbox');
    expect((boxes[0] as HTMLInputElement).checked).toBe(false); expect((boxes[1] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(boxes[0]); fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar preferencias' }));
    await waitFor(() => expect(apiClient.updateTelegramRulePreferences).toHaveBeenCalledWith({ stockRuleAlertsEnabled: true, stockRuleResolvedAlertsEnabled: true }));
    expect((await screen.findByRole('status')).textContent).toContain('Preferencias guardadas');
    expect(document.body.textContent).not.toMatch(/chatId|token|businessId/);
  });
  it('existing explicit preferences can be disabled independently', async () => {
    vi.mocked(apiClient.updateTelegramRulePreferences).mockResolvedValue({ success: true });
    render(<TelegramRulePreferences initialOpen initialResolved />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar preferencias' }));
    await waitFor(() => expect(apiClient.updateTelegramRulePreferences).toHaveBeenCalledWith({ stockRuleAlertsEnabled: true, stockRuleResolvedAlertsEnabled: false }));
  });
  it('shows a sanitized error with manual retry', async () => {
    vi.mocked(apiClient.updateTelegramRulePreferences).mockRejectedValue(new Error('private raw failure'));
    render(<TelegramRulePreferences />);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar preferencias' }));
    expect((await screen.findByRole('status')).textContent).toContain('No se pudieron guardar');
    expect(document.body.textContent).not.toContain('private raw failure');
  });
});
