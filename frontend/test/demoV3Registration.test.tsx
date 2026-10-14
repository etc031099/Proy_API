import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import RegisterDemoV3Page from '@/app/register-demo-v3/page';
import { apiClient } from '@/lib/api';

const auth = vi.hoisted(() => ({ user: null as null | { id: string }, loading: false, registerDemoV3: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const instance = (apiClient as unknown as { instance: { post: (url: string, input: unknown) => Promise<unknown> } }).instance;
const fields = { name: 'Demo V3 Owner', email: 'demo-v3@example.com', password: 'SyntheticPass123' };
beforeEach(() => { auth.user = { id: 'owner' }; auth.loading = false; auth.registerDemoV3.mockReset(); localStorage.clear(); });
function fill() {
  fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: fields.name } });
  fireEvent.change(screen.getByLabelText('Correo autorizado'), { target: { value: fields.email } });
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: fields.password } });
}
it('requires an existing V1 session for demo provisioning', () => {
  auth.user = null; render(<RegisterDemoV3Page />);
  expect(screen.getByRole('link', { name: 'Iniciar sesión' }).getAttribute('href')).toBe('/login');
  expect(screen.queryByRole('button', { name: 'Crear cuenta demo V3' })).toBeNull();
});
it('submits only owner identity and makes duplicate clicks idempotent', async () => {
  let finish!: () => void;
  auth.registerDemoV3.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  render(<RegisterDemoV3Page />); fill();
  expect(screen.queryByLabelText(/business|negocio/i)).toBeNull();
  expect(screen.getByText(/servidor asigna el negocio V3 automáticamente/)).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Crear cuenta demo V3' });
  fireEvent.click(button); fireEvent.click(button);
  expect(auth.registerDemoV3).toHaveBeenCalledExactlyOnceWith(fields);
  finish();
  await waitFor(() => expect((screen.getByLabelText('Contraseña') as HTMLInputElement).value).toBe(''));
});
it('projects only name/email/password and stores successful token', async () => {
  const post = vi.spyOn(instance, 'post').mockResolvedValue({ data: { success: true, data: { token: 'synthetic-v3-token' } } });
  await apiClient.registerDemoV3({ ...fields, businessId: 'FORBIDDEN', role: 'admin' } as typeof fields);
  expect(post).toHaveBeenCalledExactlyOnceWith('/auth/register-demo-v3', fields);
  expect(localStorage.getItem('token')).toBe('synthetic-v3-token');
});
it('failed provisioning preserves the previous browser session', async () => {
  localStorage.setItem('token', 'synthetic-v1-token');
  vi.spyOn(instance, 'post').mockRejectedValue({ response: { status: 403 } });
  await expect(apiClient.registerDemoV3(fields)).rejects.toMatchObject({ response: { status: 403 } });
  expect(localStorage.getItem('token')).toBe('synthetic-v1-token');
});
