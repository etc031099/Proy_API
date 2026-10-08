'use client';

import { useEffect, useRef, useState } from 'react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { AgentActivity } from '@/components/assistant/AgentActivity';
import { ConversationHistory } from '@/components/assistant/ConversationHistory';
import { useAuth } from '@/contexts/AuthContext';
import { activeConversationKey, readActiveConversation, writeActiveConversation } from '@/lib/agentHistory';
import { apiClient, AgentApiError } from '@/lib/api';
import type { AgentMessageRequest, AgentResponse, AgentConversationList, HistoryPagination } from '@/types/agent';

const suggestions = ['Muéstrame los productos con stock bajo', '¿Cuánto vendimos este mes?',
  '¿Cuáles son los productos más vendidos?', '¿Qué productos debería reponer?',
  'Resume cómo está mi negocio y qué debería vigilar'];
interface Message { id: number | string; role: 'user' | 'assistant'; text: string; response?: AgentResponse; status?: string }

export default function AssistantPage() {
  const { user } = useAuth();
  const storageKey = user ? activeConversationKey(user.id, user.businessId) : undefined;
  const identity = useRef(storageKey);
  identity.current = storageKey;
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [conversationId, setConversationId] = useState<string>();
  const [activity, setActivity] = useState<AgentResponse>();
  const [activityOpen, setActivityOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ text: string; retryable: boolean }>();
  const inFlight = useRef(false);
  const nextId = useRef(0);
  const lastRequest = useRef<{ input: AgentMessageRequest; key: string } | undefined>(undefined);
  const [history, setHistory] = useState<AgentConversationList>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [messagePagination, setMessagePagination] = useState<HistoryPagination>();
  const historyEpoch = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }, [messages, loading]);
  useEffect(() => {
    const epochRef = historyEpoch;
    const epoch = ++epochRef.current;
    inFlight.current = false; setLoading(false); setHistoryBusy(false); setHistoryError(undefined);
    setMessages([]); setConversationId(undefined); setActivity(undefined); setHistory(undefined);
    if (!storageKey) return;
    void apiClient.listAgentConversations().then(async result => {
      if (historyEpoch.current !== epoch || !result.data) return;
      setHistory(result.data);
      const selected = readActiveConversation(storageKey) || result.data.items[0]?.conversationId;
      if (selected && !inFlight.current) await openConversation(selected);
    }).catch(() => { if (historyEpoch.current === epoch) setHistoryError('No fue posible cargar el historial. Puedes reintentarlo.'); });
    return () => { epochRef.current++; };
    // History is fetched only when the authenticated identity changes, never from chat context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  async function refreshHistory(page = 1) {
    const scope = storageKey;
    setHistoryBusy(true); setHistoryError(undefined);
    try { const result = await apiClient.listAgentConversations(page); if (!result.data) throw new Error(); if (identity.current === scope) setHistory(result.data); }
    catch { if (identity.current === scope) setHistoryError('No fue posible cargar el historial. Puedes reintentarlo.'); }
    finally { if (identity.current === scope) setHistoryBusy(false); }
  }
  async function openConversation(id: string, olderPage?: number) {
    if (inFlight.current) return;
    const scope = storageKey;
    const epoch = historyEpoch.current;
    inFlight.current = true; setHistoryBusy(true); setHistoryError(undefined);
    try {
      const result = await apiClient.getAgentConversation(id, olderPage || 1);
      if (identity.current !== scope || historyEpoch.current !== epoch) return;
      if (!result.data) throw new Error();
      const restored = result.data.messages;
      setMessages(previous => olderPage ? [...restored.filter(row => !previous.some(existing => existing.id === row.id)), ...previous] : restored);
      if (!olderPage) {
        setActivity([...restored].reverse().find(message => message.response)?.response);
        setConversationId(id); setError(undefined); lastRequest.current = undefined;
        if (storageKey) writeActiveConversation(storageKey, id);
      }
      setMessagePagination(result.data.pagination);
    } catch { if (identity.current === scope && historyEpoch.current === epoch) setHistoryError('No fue posible abrir la conversación. Tu conversación actual sigue disponible.'); }
    finally { if (identity.current === scope && historyEpoch.current === epoch) { inFlight.current = false; setHistoryBusy(false); } }
  }
  async function deleteConversation(id: string) {
    if (inFlight.current || !window.confirm('¿Eliminar esta conversación y todos sus mensajes? Esta acción no se puede deshacer.')) return;
    const scope = storageKey;
    inFlight.current = true; setHistoryBusy(true);
    try { await apiClient.deleteAgentConversation(id); if (identity.current !== scope) return; if (id === conversationId) { inFlight.current = false; reset(); }
      await refreshHistory(history?.pagination.page || 1); }
    catch { if (identity.current === scope) setHistoryError('No fue posible eliminar la conversación. Inténtalo nuevamente.'); }
    finally { if (identity.current === scope) { inFlight.current = false; setHistoryBusy(false); } }
  }

  async function send(text: string, retry = false) {
    const message = text.trim();
    if (inFlight.current || message.length < 2 || message.length > 2000) return;
    const scope = storageKey;
    inFlight.current = true;
    setLoading(true); setError(undefined);
    const request = retry && lastRequest.current ? lastRequest.current : {
      input: { message, ...(conversationId ? { conversationId } : {}) }, key: crypto.randomUUID() };
    lastRequest.current = request;
    if (!retry) { const id = ++nextId.current; setMessages(previous => [...previous, { id, role: 'user', text: message }]); setDraft(''); }
    try {
      const result = await apiClient.sendAgentMessage(request.input, request.key);
      if (identity.current !== scope) return;
      if (!result.success || !result.data) throw new AgentApiError(500);
      const response = result.data;
      setConversationId(response.conversationId); setActivity(response);
      if (storageKey) writeActiveConversation(storageKey, response.conversationId);
      const answer = response.requiresClarification ? response.clarificationQuestion || response.answer : response.answer;
      const id = ++nextId.current;
      setMessages(previous => [...previous, { id, role: 'assistant', text: answer, response }]);
      void refreshHistory();
    } catch (failure) {
      if (identity.current !== scope) return;
      const status = failure instanceof AgentApiError ? failure.status : 500;
      if (failure instanceof AgentApiError && failure.conversationId) {
        setConversationId(failure.conversationId); request.input.conversationId = failure.conversationId;
        if (storageKey) writeActiveConversation(storageKey, failure.conversationId);
      }
      void refreshHistory();
      setError({ text: failure instanceof AgentApiError && ['AGENT_HISTORY_PERSISTENCE_FAILED', 'AGENT_HISTORY_CONFLICT'].includes(failure.code || '')
        ? 'No se pudo confirmar el resultado guardado. Recarga el historial antes de enviar otra consulta.'
        : status === 503 || status === undefined ? 'El servicio no está disponible temporalmente. Vuelve a intentarlo.'
        : status === 429 ? 'Se alcanzó el límite de consultas. Espera un momento antes de reintentar.'
          : status === 404 ? 'El asistente todavía no está habilitado.' : 'No fue posible consultar el asistente.',
      retryable: failure instanceof AgentApiError && failure.retryable });
    } finally { if (identity.current === scope) { inFlight.current = false; setLoading(false); } }
  }

  function reset() {
    if (inFlight.current) return;
    setMessages([]); setConversationId(undefined); setActivity(undefined); setError(undefined); setDraft(''); lastRequest.current = undefined;
    setMessagePagination(undefined); historyEpoch.current++;
    if (storageKey) writeActiveConversation(storageKey);
  }

  return <ProtectedRoute><Layout><div className="mx-auto max-w-7xl min-w-0 space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-bold">Asistente Inteligente</h1>
        <p className="mt-2 text-muted-foreground">Consulta productos, ventas, inventario y predicciones utilizando agentes especializados.</p>
        <p className="mt-2 text-xs text-muted-foreground">{conversationId ? 'Conversación activa' : 'Nueva conversación'} · Historial guardado; contexto del agente compacto.</p>
      </div>
      <Button variant="outline" disabled={loading || historyBusy} onClick={reset}>Nueva conversación</Button>
    </header>
    <ConversationHistory history={history} selected={conversationId} busy={loading || historyBusy} error={historyError}
      onSelect={id => void openConversation(id)} onDelete={id => void deleteConversation(id)}
      onPage={page => void refreshHistory(page)} onReload={() => void refreshHistory(history?.pagination.page || 1)} />
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
      <section aria-label="Conversación" className="rounded-xl border bg-card p-4 sm:p-6 min-w-0">
        <div role="log" aria-label="Mensajes" aria-live="polite" className="max-h-[60vh] min-h-64 overflow-y-auto space-y-4">
          {messagePagination && conversationId && messagePagination.page < messagePagination.totalPages && <Button variant="outline" disabled={loading || historyBusy}
            onClick={() => void openConversation(conversationId, messagePagination.page + 1)}>Cargar mensajes anteriores</Button>}
          {!messages.length && <div><h2 className="font-semibold">¿Qué quieres consultar?</h2>
            <p className="mt-2 text-sm text-muted-foreground">Las consultas claras usan skills determinísticas sin consumir tokens IA. El asistente solo consulta: no realiza compras ni cambia el inventario.</p>
            <div className="mt-4 flex flex-col gap-2">{suggestions.map(text => <button key={text} disabled={loading}
              onClick={() => void send(text)} className="rounded-lg border p-3 text-left text-sm hover:bg-muted disabled:opacity-50">{text}</button>)}</div>
          </div>}
          {messages.map(m => <article key={m.id} className={`rounded-lg p-4 min-w-0 ${m.role === 'user' ? 'bg-muted' : 'border'}`}>
            <p className="text-xs font-medium mb-2">{m.role === 'user' ? 'Tú' : 'Asistente'}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{m.text}</p>
            {m.status === 'failed' && <p className="text-xs text-muted-foreground">Consulta no completada.</p>}
            {m.status === 'pending' && <p className="text-xs text-muted-foreground">No hay un resultado confirmado para esta consulta.</p>}
            {m.response && <button className="mt-3 text-xs underline underline-offset-4" onClick={() => setActivity(m.response)}>
              Ver actividad · {m.response.usage.totalLlmCalls} llamadas IA · {m.response.usage.totalTokens === null ? '—' : m.response.usage.totalTokens} tokens
            </button>}
          </article>)}
          {loading && <p role="status" className="text-sm">Consultando el asistente… El servicio puede tardar unos segundos en activarse.</p>}
          <div ref={end} />
        </div>
        {error && <div role="alert" className="mt-4 rounded-lg border border-destructive/40 p-3 text-sm">
          <p>{error.text}</p>{error.retryable && <Button className="mt-2" variant="outline" disabled={loading}
            onClick={() => void send(lastRequest.current?.input.message || '', true)}>Reintentar consulta</Button>}
        </div>}
        <form className="mt-5 space-y-3" onSubmit={event => { event.preventDefault(); void send(draft); }}>
          <label htmlFor="assistant-message" className="text-sm font-medium">Tu consulta</label>
          <textarea id="assistant-message" value={draft} onChange={event => setDraft(event.target.value)} disabled={loading || historyBusy}
            maxLength={2000} rows={3} placeholder="Escribe tu pregunta…" className="block w-full min-w-0 rounded-lg border bg-background p-3 text-sm resize-y"
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(draft); } }} />
          <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{draft.length}/2000 · Shift+Enter: nueva línea</span>
            <Button type="submit" disabled={loading || historyBusy || draft.trim().length < 2}>Enviar</Button></div>
        </form>
      </section>
      <div className="min-w-0 space-y-3">
        <Button variant="outline" className="lg:hidden" aria-expanded={activityOpen} aria-controls="assistant-activity"
          onClick={() => setActivityOpen(!activityOpen)}>Actividad y consumo IA</Button>
        <div id="assistant-activity" className={`${activityOpen ? 'block' : 'hidden'} lg:block`}><AgentActivity response={activity} /></div>
      </div>
    </div>
  </div></Layout></ProtectedRoute>;
}
