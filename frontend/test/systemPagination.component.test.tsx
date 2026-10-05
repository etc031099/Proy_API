import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaginationControls } from '@/components/PaginationControls';

describe('system list pagination controls', () => {
  it('shows a real Spanish transaction count and sends next-page navigation', () => {
    const onPageChange = vi.fn();
    render(
      <PaginationControls
        page={1}
        pageSize={10}
        total={3051}
        entity="transacciones"
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByText('Mostrando 1–10 de 3051 transacciones')).toBeTruthy();
    expect(screen.getByText('Página 1 de 306')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('shows the final incomplete range and disables forward navigation', () => {
    const onPageChange = vi.fn();
    render(
      <PaginationControls
        page={7}
        pageSize={10}
        total={61}
        entity="productos"
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByText('Mostrando 61–61 de 61 productos')).toBeTruthy();
    expect(screen.getByText('Página 7 de 7')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Siguiente' }).hasAttribute('disabled')).toBe(true);
  });

  it('changes products per page and clamps controls for an empty result', () => {
    const onPageSizeChange = vi.fn();
    const { rerender } = render(
      <PaginationControls
        page={1}
        pageSize={10}
        total={12}
        entity="productos"
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Elementos por página' }), {
      target: { value: '25' },
    });
    expect(onPageSizeChange).toHaveBeenCalledWith(25);

    rerender(
      <PaginationControls
        page={4}
        pageSize={10}
        total={0}
        entity="productos"
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    expect(screen.getByText('Mostrando 0–0 de 0 productos')).toBeTruthy();
    expect(screen.queryByText(/Página/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Siguiente' }).hasAttribute('disabled')).toBe(true);
  });
});
