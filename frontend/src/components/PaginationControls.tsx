'use client';

import { Button } from '@/components/ui/button';

interface PaginationControlsProps {
  page: number;
  pageSize: number;
  total: number;
  entity: 'productos' | 'transacciones';
  language?: string;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}

export function PaginationControls({
  page,
  pageSize,
  total,
  entity,
  language = 'es',
  onPageChange,
  onPageSizeChange,
}: PaginationControlsProps) {
  const totalPages = Math.ceil(total / pageSize);
  const safePage = totalPages === 0 ? 1 : Math.min(Math.max(1, page), totalPages);
  const start = total === 0 ? 0 : ((safePage - 1) * pageSize) + 1;
  const end = Math.min(safePage * pageSize, total);
  const isSpanish = language === 'es';
  const entityLabel = isSpanish ? entity : entity === 'productos' ? 'products' : 'transactions';

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {isSpanish
            ? `Mostrando ${start}–${end} de ${total} ${entityLabel}`
            : `Showing ${start}–${end} of ${total} ${entityLabel}`}
        </p>
        {onPageSizeChange && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {isSpanish ? 'Por página' : 'Per page'}
            <select
              aria-label={isSpanish ? 'Elementos por página' : 'Items per page'}
              className="h-8 rounded-md border border-input bg-background px-2 text-foreground"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {[10, 25, 50].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        {totalPages > 0 && (
          <span className="mr-2 text-sm text-muted-foreground">
            {isSpanish ? `Página ${safePage} de ${totalPages}` : `Page ${safePage} of ${totalPages}`}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.max(1, safePage - 1))}
          disabled={safePage <= 1 || totalPages === 0}
        >
          {isSpanish ? 'Anterior' : 'Previous'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
          disabled={safePage >= totalPages || totalPages === 0}
        >
          {isSpanish ? 'Siguiente' : 'Next'}
        </Button>
      </div>
    </div>
  );
}
