'use client';
import { useEffect, useState } from 'react';
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
  return <div aria-label="Opciones de la operación" className="mt-3 space-y-2">
    {pagination && <p className="text-sm">{pagination.totalMatches} coincidencias para «{pagination.query}» · Mostrando {pagination.offset + 1}–{pagination.offset + response.suggestions.length}</p>}
    {expired && <p className="text-sm text-muted-foreground">Estas opciones vencieron. Inicia nuevamente la operación.</p>}
    <div className="flex flex-wrap gap-2">{response.suggestions.map(option =>
      <button key={option.message} disabled={disabled || expired} onClick={() => onSelect(option.message)}
        className="rounded-md border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50">
        <span className="block">{option.label}</span>
        {option.detail && <span className="block text-xs text-muted-foreground">{option.detail}</span>}
      </button>)}</div>
    {pagination && <div className="flex flex-wrap gap-2">
      {pagination.hasPrevious && <button disabled={disabled || expired} onClick={() => onSelect('Anterior')} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50">Anterior</button>}
      {pagination.hasMore && <button disabled={disabled || expired} onClick={() => onSelect('Ver más')} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50">Ver más</button>}
      <button disabled={disabled || expired} onClick={() => onSelect('Refinar búsqueda')} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50">Refinar búsqueda</button>
      <p className="w-full text-xs text-muted-foreground">“1” o “el primero” seleccionan el primer producto de esta página.</p>
    </div>}
  </div>;
}
