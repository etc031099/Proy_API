import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import RegisterDemoV2Page from '@/app/register-demo-v2/page';
import { apiClient } from '@/lib/api';

const auth = vi.hoisted(() => ({ user: null as null | { id: string }, loading: false, registerDemoV2: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const instance = (apiClient as unknown as { instance: { post: (url: string, input: unknown) => Promise<unknown> } }).instance;
const fields = { name: 'Demo Owner', email: 'demo@example.com', password: 'SyntheticPass123' };
beforeEach(() => { auth.user = { id: 'owner' }; auth.loading = false; auth.registerDemoV2.mockReset(); localStorage.clear(); });
function fill() {
  fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: fields.name } });
  fireEvent.change(screen.getByLabelText('Correo'), { target: { value: fields.email } });
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: fields.password } });
}
it('requires an existing session instead of exposing public provisioning', () => {
  auth.user = null; render(<RegisterDemoV2Page />);
  expect(screen.getByRole('link', { name: 'Iniciar sesión' }).getAttribute('href')).toBe('/login');
  expect(screen.queryByRole('button', { name: 'Crear cuenta demo V2' })).toBeNull();
});
it('shows only human identity fields, warns about session switching and submits once', async () => {
  let finish!: () => void;
  auth.registerDemoV2.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  render(<RegisterDemoV2Page />); fill();
  expect(screen.queryByLabelText(/business|negocio/i)).toBeNull();
  expect(screen.getByText(/esta sesión pasará a V2/)).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Crear cuenta demo V2' });
  fireEvent.click(button); fireEvent.click(button);
  expect(auth.registerDemoV2).toHaveBeenCalledExactlyOnceWith(fields);
  expect(screen.getByRole('button', { name: 'Creando cuenta…' }).hasAttribute('disabled')).toBe(true);
  finish();
  await waitFor(() => expect((screen.getByLabelText('Contraseña') as HTMLInputElement).value).toBe(''));
});
it('clears the password on failure and permits a manual retry', async () => {
  auth.registerDemoV2.mockRejectedValue(new Error('El registro demo V2 está deshabilitado.'));
  render(<RegisterDemoV2Page />); fill(); fireEvent.click(screen.getByRole('button', { name: 'Crear cuenta demo V2' }));
  expect((await screen.findByRole('alert')).textContent).toBe('El registro demo V2 está deshabilitado.');
  expect((screen.getByLabelText('Contraseña') as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('button', { name: 'Crear cuenta demo V2' }).hasAttribute('disabled')).toBe(false);
});
it('API projects only name/email/password and reuses the existing token storage', async () => {
  const post = vi.spyOn(instance, 'post').mockResolvedValue({ data: { success: true, data: { token: 'synthetic-v2-token' } } });
  await apiClient.registerDemoV2({ ...fields, businessId: 'FORBIDDEN', role: 'admin' } as typeof fields);
  expect(post).toHaveBeenCalledExactlyOnceWith('/auth/register-demo-v2', fields);
  expect(localStorage.getItem('token')).toBe('synthetic-v2-token');
});
it('failed provisioning preserves the previous browser session', async () => {
  localStorage.setItem('token', 'synthetic-v1-token');
  vi.spyOn(instance, 'post').mockRejectedValue({ response: { status: 403 } });
  await expect(apiClient.registerDemoV2(fields)).rejects.toMatchObject({ response: { status: 403 } });
  expect(localStorage.getItem('token')).toBe('synthetic-v1-token');
});
