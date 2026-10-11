import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteEntitySelect } from '@/components/RemoteEntitySelect';
const mocks = vi.hoisted(() => ({ getContacts: vi.fn(), getProducts: vi.fn(), getContact: vi.fn(), getProduct: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiClient: mocks }));
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); };
const response = (total = 43, current = 1) => ({ success: true, data: { contacts: [{ _id: 'visible', name: 'Cliente visible' }], pagination: { total, current } } });
describe('P2C.1 remote entity selection', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.getContacts.mockResolvedValue(response()); mocks.getContact.mockResolvedValue({ success: true, data: { contact: { _id: 'saved', name: 'Cliente seleccionado' } } }); });
  afterEach(() => vi.useRealTimers());
  it('loads bounded results, advances, returns and resets the remote page when searching', async () => {
    render(<RemoteEntitySelect kind="customer" label="cliente" value="" onChange={vi.fn()} />);
    await tick(); expect(mocks.getContacts).toHaveBeenLastCalledWith({ type: 'customer', search: '', page: 1, limit: 20 });
    expect(screen.getByText('Mostrando 1–20 de 43')).toBeTruthy();
    mocks.getContacts.mockResolvedValue(response(43, 2)); fireEvent.click(screen.getByRole('button', { name: 'Siguiente' })); await tick();
    expect(mocks.getContacts).toHaveBeenLastCalledWith({ type: 'customer', search: '', page: 2, limit: 20 });
    mocks.getContacts.mockResolvedValue(response()); fireEvent.click(screen.getByRole('button', { name: 'Anterior' })); await tick();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar cliente' }), { target: { value: 'Juan' } }); await tick();
    expect(mocks.getContacts).toHaveBeenLastCalledWith({ type: 'customer', search: 'Juan', page: 1, limit: 20 });
  });
  it('debounces typing and hydrates a selected entity outside the visible page', async () => {
    render(<RemoteEntitySelect kind="vendor" label="proveedor" value="saved" onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'J' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Juan' } }); await tick();
    expect(mocks.getContacts).toHaveBeenCalledTimes(1); expect(mocks.getContact).toHaveBeenCalledWith('saved');
    expect(screen.getByRole('combobox', { name: 'proveedor' }).textContent).toContain('Cliente seleccionado');
  });
  it('shows empty/error states and disables navigation at the end', async () => {
    mocks.getContacts.mockResolvedValue({ success: true, data: { contacts: [], pagination: { total: 0, current: 1 } } });
    render(<RemoteEntitySelect kind="vendor" label="proveedor" value="" onChange={vi.fn()} />); await tick();
    expect(screen.getByText('No se encontraron resultados')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Siguiente' }).hasAttribute('disabled')).toBe(true);
    mocks.getContacts.mockRejectedValue(new Error('network'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Other' } }); await tick();
    expect(screen.getByText('No fue posible cargar los resultados.')).toBeTruthy();
  });
  it('ignores older responses after a more recent search', async () => {
    let oldResolve: (value: ReturnType<typeof response>) => void = () => {};
    mocks.getContacts.mockReturnValueOnce(new Promise(resolve => { oldResolve = resolve; }));
    render(<RemoteEntitySelect kind="customer" label="cliente" value="" onChange={vi.fn()} />); await tick();
    mocks.getContacts.mockResolvedValue(response(1)); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Latest' } }); await tick();
    await act(async () => { oldResolve(response(99)); });
    expect(screen.getByText('Mostrando 1–1 de 1')).toBeTruthy();
  });
  it('filters products remotely by supplier and avoids loading while disabled', async () => {
    mocks.getProducts.mockResolvedValue({ success: true, data: { products: [], pagination: { total: 0, current: 1 } } });
    const { rerender } = render(<RemoteEntitySelect kind="product" label="producto" value="" disabled onChange={vi.fn()} />); await tick();
    expect(mocks.getProducts).not.toHaveBeenCalled();
    rerender(<RemoteEntitySelect kind="product" label="producto" value="" supplierId="supplier" onChange={vi.fn()} />); await tick();
    expect(mocks.getProducts).toHaveBeenCalledWith({ search: '', page: 1, limit: 20, supplierId: 'supplier' });
  });
});
