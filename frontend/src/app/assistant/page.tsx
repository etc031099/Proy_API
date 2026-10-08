'use client';

import { useEffect, useRef, useState } from 'react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { AgentActivity } from '@/components/assistant/AgentActivity';
import { apiClient, AgentApiError } from '@/lib/api';
import type { AgentMessageRequest, AgentResponse } from '@/types/agent';

const suggestions = ['Muéstrame los productos con stock bajo', '¿Cuánto vendimos este mes?',
  '¿Cuáles son los productos más vendidos?', '¿Qué productos debería reponer?',
  'Resume cómo está mi negocio y qué debería vigilar'];
interface Message { id: number; role: 'user' | 'assistant'; text: string; response?: AgentResponse }

export default function AssistantPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [conversationId, setConversationId] = useState<string>();
  const [activity, setActivity] = useState<AgentResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ text: string; retryable: boolean }>();
  const inFlight = useRef(false);
  const nextId = useRef(0);
  const lastRequest = useRef<AgentMessageRequest | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }, [messages, loading]);

  async function send(text: string, retry = false) {
    const message = text.trim();
    if (inFlight.current || message.length < 2 || message.length > 2000) return;
    inFlight.current = true;
    setLoading(true); setError(undefined);
    const input = retry && lastRequest.current ? lastRequest.current : { message, ...(conversationId ? { conversationId } : {}) };
    lastRequest.current = input;
    if (!retry) { const id = ++nextId.current; setMessages(previous => [...previous, { id, role: 'user', text: message }]); setDraft(''); }
    try {
      const result = await apiClient.sendAgentMessage(input);
      if (!result.success || !result.data) throw new AgentApiError(500);
      const response = result.data;
      setConversationId(response.conversationId); setActivity(response);
      const answer = response.requiresClarification ? response.clarificationQuestion || response.answer : response.answer;
      const id = ++nextId.current;
      setMessages(previous => [...previous, { id, role: 'assistant', text: answer, response }]);
    } catch (failure) {
      const status = failure instanceof AgentApiError ? failure.status : 500;
      setError({ text: status === 503 || status === undefined ? 'El servicio no está disponible temporalmente. Vuelve a intentarlo.'
        : status === 429 ? 'Se alcanzó el límite de consultas. Espera un momento antes de reintentar.'
          : status === 404 ? 'El asistente todavía no está habilitado.' : 'No fue posible consultar el asistente.',
      retryable: failure instanceof AgentApiError && failure.retryable });
    } finally { inFlight.current = false; setLoading(false); }
  }

  function reset() {
    if (inFlight.current) return;
    setMessages([]); setConversationId(undefined); setActivity(undefined); setError(undefined); setDraft(''); lastRequest.current = undefined;
  }

  return <ProtectedRoute><Layout><div className="mx-auto max-w-7xl min-w-0 space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-bold">Asistente Inteligente</h1>
        <p className="mt-2 text-muted-foreground">Consulta productos, ventas, inventario y predicciones utilizando agentes especializados.</p>
        <p className="mt-2 text-xs text-muted-foreground">{conversationId ? 'Conversación activa' : 'Nueva conversación'} · Contexto temporal de conversación (30 minutos; se pierde al reiniciar el servicio).</p>
      </div>
      <Button variant="outline" disabled={loading} onClick={reset}>Nueva conversación</Button>
    </header>
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
      <section aria-label="Conversación" className="rounded-xl border bg-card p-4 sm:p-6 min-w-0">
        <div role="log" aria-label="Mensajes" aria-live="polite" className="max-h-[60vh] min-h-64 overflow-y-auto space-y-4">
          {!messages.length && <div><h2 className="font-semibold">¿Qué quieres consultar?</h2>
            <p className="mt-2 text-sm text-muted-foreground">Las consultas claras usan skills determinísticas sin consumir tokens IA. El asistente solo consulta: no realiza compras ni cambia el inventario.</p>
            <div className="mt-4 flex flex-col gap-2">{suggestions.map(text => <button key={text} disabled={loading}
              onClick={() => void send(text)} className="rounded-lg border p-3 text-left text-sm hover:bg-muted disabled:opacity-50">{text}</button>)}</div>
          </div>}
          {messages.map(m => <article key={m.id} className={`rounded-lg p-4 min-w-0 ${m.role === 'user' ? 'bg-muted' : 'border'}`}>
            <p className="text-xs font-medium mb-2">{m.role === 'user' ? 'Tú' : 'Asistente'}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{m.text}</p>
            {m.response && <button className="mt-3 text-xs underline underline-offset-4" onClick={() => setActivity(m.response)}>
              Ver actividad · {m.response.usage.totalLlmCalls} llamadas IA · {m.response.usage.totalTokens === null ? '—' : m.response.usage.totalTokens} tokens
            </button>}
          </article>)}
          {loading && <p role="status" className="text-sm">Consultando el asistente… El servicio puede tardar unos segundos en activarse.</p>}
          <div ref={end} />
        </div>
        {error && <div role="alert" className="mt-4 rounded-lg border border-destructive/40 p-3 text-sm">
          <p>{error.text}</p>{error.retryable && <Button className="mt-2" variant="outline" disabled={loading}
            onClick={() => void send(lastRequest.current?.message || '', true)}>Reintentar consulta</Button>}
        </div>}
        <form className="mt-5 space-y-3" onSubmit={event => { event.preventDefault(); void send(draft); }}>
          <label htmlFor="assistant-message" className="text-sm font-medium">Tu consulta</label>
          <textarea id="assistant-message" value={draft} onChange={event => setDraft(event.target.value)} disabled={loading}
            maxLength={2000} rows={3} placeholder="Escribe tu pregunta…" className="block w-full min-w-0 rounded-lg border bg-background p-3 text-sm resize-y"
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(draft); } }} />
          <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{draft.length}/2000 · Shift+Enter: nueva línea</span>
            <Button type="submit" disabled={loading || draft.trim().length < 2}>Enviar</Button></div>
        </form>
      </section>
      <AgentActivity response={activity} />
    </div>
  </div></Layout></ProtectedRoute>;
}
