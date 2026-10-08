import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AgentConversationList } from '@/types/agent';

export function ConversationHistory({ history, selected, busy, error, onSelect, onDelete, onPage, onReload }: {
  history?: AgentConversationList; selected?: string; busy: boolean; error?: string;
  onSelect: (id: string) => void; onDelete: (id: string) => void; onPage: (page: number) => void; onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <section aria-label="Historial de conversaciones" className="min-w-0 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="outline" aria-expanded={open} aria-controls="assistant-history" onClick={() => setOpen(!open)}>Conversaciones</Button>
      <span className="text-xs text-muted-foreground">Historial guardado · Solo tus conversaciones</span>
    </div>
    <div id="assistant-history" hidden={!open} className="mt-3 min-w-0 space-y-3">
      {(busy || !history && !error) && <p role="status">Cargando historial…</p>}
      {error && <div role="alert"><p>{error}</p><Button variant="outline" disabled={busy} onClick={onReload}>Recargar historial</Button></div>}
      {history && !history.items.length && <p className="text-sm">Todavía no tienes conversaciones guardadas.</p>}
      <ul className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {history?.items.map(item => <li key={item.conversationId} className="flex min-w-0 items-center gap-2 rounded-lg border p-2">
          <button disabled={busy} aria-current={item.conversationId === selected ? 'true' : undefined} className="min-w-0 flex-1 text-left disabled:opacity-50"
            onClick={() => onSelect(item.conversationId)}><span className="block truncate text-sm font-medium">{item.title}</span>
            <span className="text-xs text-muted-foreground">{item.messageCount} mensajes · {new Date(item.lastMessageAt).toLocaleDateString('es-PE')}</span></button>
          <Button variant="ghost" disabled={busy} aria-label={`Eliminar ${item.title}`} onClick={() => onDelete(item.conversationId)}>Eliminar</Button>
        </li>)}
      </ul>
      {history && <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button variant="outline" disabled={busy || history.pagination.page <= 1} onClick={() => onPage(history.pagination.page - 1)}>Anterior</Button>
        <span>Página {history.pagination.page} de {history.pagination.totalPages} · {history.pagination.total} conversaciones</span>
        <Button variant="outline" disabled={busy || history.pagination.page >= history.pagination.totalPages} onClick={() => onPage(history.pagination.page + 1)}>Siguiente</Button>
      </div>}
    </div>
  </section>;
}
