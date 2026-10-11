import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import ContactsPage from '@/app/contacts/page';
const api = vi.hoisted(() => ({ getContacts: vi.fn(), getCustomers: vi.fn(), getVendors: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiClient: api }));
vi.mock('@/components/ProtectedRoute', () => ({ ProtectedRoute: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/Layout', () => ({ Layout: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/contexts/LanguageContext', () => ({ useLanguage: () => ({ t: (value: string) => value, language: 'es' }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
describe('P2C.1 contact collection navigation', () => {
  it('shows real totals, navigates remotely and resets to page one when searching', async () => {
    api.getContacts.mockImplementation(async ({ page }) => ({ success: true, data: { contacts: [{ _id: '1', name: 'Contact', phone: '123456789', type: 'customer', currentBalance: 0, creditLimit: 0 }], pagination: { total: 43, current: page } } }));
    render(<ContactsPage />);
    await screen.findByText('Mostrando 1–20 de 43 contactos');
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    await screen.findByText('Mostrando 21–40 de 43 contactos');
    expect(api.getContacts).toHaveBeenLastCalledWith({ search: '', page: 2, limit: 20 });
    fireEvent.change(screen.getByPlaceholderText('contacts.search'), { target: { value: 'Juan' } });
    await waitFor(() => expect(api.getContacts).toHaveBeenLastCalledWith({ search: 'Juan', page: 1, limit: 20 }));
  });
  it('renders empty and sanitized failure states instead of an infinite spinner', async () => {
    api.getContacts.mockResolvedValue({ success: true, data: { contacts: [], pagination: { total: 0, current: 1 } } });
    render(<ContactsPage />); await screen.findByText('No contacts found');
    expect(screen.getByRole('button', { name: 'Siguiente' }).hasAttribute('disabled')).toBe(true);
    api.getContacts.mockRejectedValue(new Error('private backend details'));
    fireEvent.change(screen.getByPlaceholderText('contacts.search'), { target: { value: 'Other' } });
    await screen.findByRole('alert'); expect(screen.queryByText('private backend details')).toBeNull();
  });
});
