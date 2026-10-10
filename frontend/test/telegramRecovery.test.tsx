import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramConnectionRecovery } from '@/components/TelegramConnectionRecovery';
import { apiClient } from '@/lib/api';
vi.mock('@/lib/api', () => ({ apiClient: { createTelegramRecoveryCode: vi.fn(), getTelegramStatus: vi.fn() } }));
const challenge = () => ({ success: true, data: { code: 'TRF-ABCDEF1234567890', expiresAt: new Date(Date.now() + 600000).toISOString() } });
afterEach(() => vi.useRealTimers());

describe('Telegram recovery', () => {
  it('shows recovery button and command without exposing previous business data', async () => {
    vi.mocked(apiClient.createTelegramRecoveryCode).mockResolvedValue(challenge());
    render(<TelegramConnectionRecovery onConnected={vi.fn()} />);
    expect(screen.getByText('¿Tu Telegram ya estaba vinculado a otra cuenta?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recuperar conexión' }));
    expect(await screen.findByText('/transfer TRF-ABCDEF1234567890')).toBeTruthy();
    expect(document.body.textContent).toContain('autorizas transferir');
    expect(document.body.textContent).not.toMatch(/chatId|businessId|admin@gmail|Mongo|sourceConnection/);
    expect(apiClient.createTelegramRecoveryCode).toHaveBeenCalledWith();
  });
  it('disables generation while awaiting its response', async () => {
    let resolve!: (result: ReturnType<typeof challenge>) => void;
    vi.mocked(apiClient.createTelegramRecoveryCode).mockReturnValue(new Promise(done => { resolve = done; }));
    render(<TelegramConnectionRecovery onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recuperar conexión' }));
    expect((screen.getByRole('button', { name: 'Espera…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(challenge()));
    expect(screen.getByText('/transfer TRF-ABCDEF1234567890')).toBeTruthy();
  });
  it('polls status and stops after confirmation, preserving destination preference values', async () => {
    vi.useFakeTimers(); vi.mocked(apiClient.createTelegramRecoveryCode).mockResolvedValue(challenge());
    vi.mocked(apiClient.getTelegramStatus).mockResolvedValue({ success: true, data: { connected: true, stockRuleAlertsEnabled: false, stockRuleResolvedAlertsEnabled: true } });
    const onConnected = vi.fn(); render(<TelegramConnectionRecovery onConnected={onConnected} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Recuperar conexión' })));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole('status').textContent).toContain('Telegram conectado correctamente');
    expect(onConnected).toHaveBeenCalledWith({ connected: true, stockRuleAlertsEnabled: false, stockRuleResolvedAlertsEnabled: true });
    expect(screen.queryByText('/transfer TRF-ABCDEF1234567890')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(20000)); expect(apiClient.getTelegramStatus).toHaveBeenCalledTimes(1);
  });
  it('hides expired code and stops polling on expiry or unmount', async () => {
    vi.useFakeTimers(); const expired = challenge(); expired.data.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(apiClient.createTelegramRecoveryCode).mockResolvedValue(expired);
    const view = render(<TelegramConnectionRecovery onConnected={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Recuperar conexión' })));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole('status').textContent).toContain('El código venció');
    expect(screen.queryByText('/transfer TRF-ABCDEF1234567890')).toBeNull(); expect(apiClient.getTelegramStatus).not.toHaveBeenCalled();
    vi.mocked(apiClient.createTelegramRecoveryCode).mockResolvedValue(challenge());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Recuperar conexión' })));
    view.unmount(); await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(apiClient.getTelegramStatus).not.toHaveBeenCalled();
  });
  it('manual refresh completes connected state and sanitizes failure', async () => {
    vi.mocked(apiClient.createTelegramRecoveryCode).mockResolvedValue(challenge());
    vi.mocked(apiClient.getTelegramStatus).mockRejectedValueOnce(Error('private old-business secret'));
    const onConnected = vi.fn(); render(<TelegramConnectionRecovery onConnected={onConnected} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recuperar conexión' })); await screen.findByText('/transfer TRF-ABCDEF1234567890');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No se pudo comprobar'));
    expect(document.body.textContent).not.toContain('private old-business secret');
    vi.mocked(apiClient.getTelegramStatus).mockResolvedValue({ success: true, data: { connected: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' })); await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  });
  it('creation failures and invalid API output never display raw provider/database information', async () => {
    vi.mocked(apiClient.createTelegramRecoveryCode).mockRejectedValue(Error('private old-business chatId token'));
    render(<TelegramConnectionRecovery onConnected={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: 'Recuperar conexión' }));
    expect((await screen.findByRole('status')).textContent).toContain('No se pudo iniciar');
    expect(document.body.textContent).not.toMatch(/chatId|token|private/);
  });
});
