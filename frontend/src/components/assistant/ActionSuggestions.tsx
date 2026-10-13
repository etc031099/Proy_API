'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AgentResponse } from '@/types/agent';

export function ActionSuggestions({ response, disabled, onSelect }: {
  response: AgentResponse; disabled: boolean; onSelect: (message: string) => void;
}) {
  const expiresAt = response.suggestionsExpiresAt;
  const [expired, setExpired] = useState(expiresAt !== undefined && expiresAt <= Date.now());
  useEffect(() => {
    setExpired(expiresAt !== undefined && expiresAt <= Date.now());
    if (expiresAt === undefined || expiresAt <= Date.now()) return;
    const timer = setTimeout(() => setExpired(true), Math.min(expiresAt - Date.now(), 2147483647));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  if (!response.suggestions?.length) return null;
  const pagination = response.suggestionsPagination;
  const entityLabel = response.suggestionsEntityType === 'supplier' ? 'proveedor'
    : response.suggestionsEntityType === 'customer' ? 'cliente' : response.suggestionsEntityType === 'category' ? 'categoría' : 'producto';
  return <div aria-label="Opciones de la operación" className="mt-3 space-y-2">
    {pagination && <p className="text-sm">{pagination.totalMatches} coincidencias para «{pagination.query}» · Mostrando {pagination.offset + 1}–{pagination.offset + response.suggestions.length}</p>}
    {expired && <p className="text-sm text-muted-foreground">Estas opciones vencieron. Inicia nuevamente la operación.</p>}
    <div className="flex flex-col items-stretch gap-2">{response.suggestions.map(option =>
      <Button type="button" variant="outline" key={option.message} disabled={disabled || expired} onClick={() => onSelect(option.message)}
        className="h-auto w-full min-w-0 justify-start whitespace-normal px-3 py-2 text-left">
        <span className="block">{option.label}</span>
        {option.detail && <span className="block text-xs text-muted-foreground">{option.detail}</span>}
      </Button>)}</div>
    {pagination && <div className="flex flex-wrap gap-2">
      {pagination.hasPrevious && <Button type="button" variant="outline" disabled={disabled || expired} onClick={() => onSelect('Anterior')}>Anterior</Button>}
      {pagination.hasMore && <Button type="button" variant="outline" disabled={disabled || expired} onClick={() => onSelect('Ver más')}>Ver más</Button>}
      <Button type="button" variant="outline" disabled={disabled || expired} onClick={() => onSelect('Refinar búsqueda')}>Refinar búsqueda</Button>
      <p className="w-full text-xs text-muted-foreground">“1” o “el primero” seleccionan el primer {entityLabel} de esta página.</p>
    </div>}
  </div>;
}
