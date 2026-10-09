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
  return <div aria-label="Opciones de la operación" className="mt-3 space-y-2">
    {expired && <p className="text-sm text-muted-foreground">Estas opciones vencieron. Inicia nuevamente la operación.</p>}
    <div className="flex flex-wrap gap-2">{response.suggestions.map(option =>
      <button key={option.message} disabled={disabled || expired} onClick={() => onSelect(option.message)}
        className="rounded-md border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50">
        <span className="block">{option.label}</span>
        {option.detail && <span className="block text-xs text-muted-foreground">{option.detail}</span>}
      </button>)}</div>
  </div>;
}
