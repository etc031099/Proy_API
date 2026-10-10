import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AssistantPage from '@/app/assistant/page';
import { apiClient, AgentApiError } from '@/lib/api';
import type { AgentResponse } from '@/types/agent';
vi.mock('@/components/ProtectedRoute', () => ({ ProtectedRoute: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/Layout', () => ({ Layout: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-a', businessId: 'business-a' } }) }));
vi.mock('@/lib/api', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/api')>(), apiClient: {
  sendAgentMessage: vi.fn(), decideAgentAction: vi.fn(), listAgentConversations: vi.fn().mockResolvedValue({ success: true, data: {
    items: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 1 } } }), getAgentConversation: vi.fn(), deleteAgentConversation: vi.fn() } }));
const send = vi.mocked(apiClient.sendAgentMessage);
const response: AgentResponse = {
  requestId: '22222222-2222-4222-8222-222222222222',
  conversationId: '11111111-1111-4111-8111-111111111111', answer: 'Hay dos productos con stock bajo.', intent: 'low_stock', agent: 'operations',
  requiresClarification: false, clarificationQuestion: null, latencyMs: 100,
  participants: [{ agentId: 'operations', model: null, llmCalls: 0, skillCalls: 1, inputTokens: 0, outputTokens: 0, thoughtTokens: 0,
    cachedInputTokens: 0, toolUseTokens: 0, totalTokens: 0, latencyMs: 90, providerLatencyMs: 0, usageAvailable: true }],
  actions: [{ skillId: 'get_low_stock_products', agentId: 'operations', status: 'SUCCEEDED', durationMs: 90 }],
  evidence: [{ evidenceId: 'e1', sourceType: 'skill', skillId: 'get_low_stock_products', label: 'Inventario del negocio', recordCount: 2 }],
  usage: { totalLlmCalls: 0, totalSkillCalls: 1, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
    totalThoughtTokens: 0, totalCachedInputTokens: 0, totalToolUseTokens: 0, totalProviderLatencyMs: 0,
    totalLatencyMs: 100, toolSelectionCycles: 0, metricsComplete: true, agents: [] }
};
beforeEach(() => { send.mockReset(); localStorage.clear(); vi.mocked(apiClient.listAgentConversations).mockResolvedValue({ success: true,
  data: { items: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 1 } } }); });
function submit(text = 'stock bajo') { fireEvent.change(screen.getByLabelText('Tu consulta'), { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: 'Enviar' })); }
it('labels configured stock rules as a read-only consultation with real zero-token activity', async () => {
  send.mockResolvedValue({ success: true, data: { ...response, answer: 'Tienes 1 regla de alerta de stock configurada.',
    intent: 'stock_alert_rules', actions: [{ skillId: 'list_stock_alert_rules', agentId: 'operations', status: 'SUCCEEDED', durationMs: 20 }],
    evidence: [{ evidenceId: 'rule-1', sourceType: 'skill', skillId: 'list_stock_alert_rules', label: 'Reglas de alerta de stock configuradas', recordCount: 1 }] } });
  render(<AssistantPage />); submit('¿Qué alertas tengo configuradas?');
  await screen.findByText('Tienes 1 regla de alerta de stock configurada.');
  expect(screen.getByText(/Consultó reglas de alerta de stock configuradas/)).toBeTruthy();
  expect(screen.getAllByText(/0 tokens IA/).length).toBeGreaterThan(0);
});
it('shows generated inventory alert evidence separately from configured rules', async () => {
  send.mockResolvedValue({ success: true, data: { ...response,
    answer: '• M5-FOODS_3_511 (Producto demo) — Abierta. Origen: regla de stock. Regla: stock <= 3. Cambio: 4 → 3 unidades.',
    intent: 'inventory_alert_events',
    actions: [{ skillId: 'list_inventory_alerts', agentId: 'operations', status: 'SUCCEEDED', durationMs: 20 }],
    evidence: [{ evidenceId: 'alert-event-1', sourceType: 'skill', skillId: 'list_inventory_alerts',
      label: 'Alertas de inventario generadas', recordCount: 1 }] } });
  render(<AssistantPage />); submit('¿Qué alertas de inventario se generaron?');
  await screen.findByText(/M5-FOODS_3_511 \(Producto demo\).*Abierta/);
  expect(screen.getByText(/Consultó alertas de inventario generadas/)).toBeTruthy();
  expect(screen.getByText('Alertas de inventario generadas')).toBeTruthy();
  expect(screen.getByText('1 registros')).toBeTruthy();
  expect(screen.getAllByText(/0 tokens IA/).length).toBeGreaterThan(0);
});
it('shows outbox delivery activity separately from generated alert events', async () => {
  send.mockResolvedValue({ success: true, data: { ...response,
    answer: 'Se encontró 1 evento de entrega de alertas:\n• M5-FOODS_3_511 — Alerta abierta — Entregada.',
    intent: 'inventory_alert_deliveries',
    actions: [{ skillId: 'list_inventory_alert_outbox_events', agentId: 'operations', status: 'SUCCEEDED', durationMs: 20 }],
    evidence: [{ evidenceId: 'outbox-event-1', sourceType: 'skill', skillId: 'list_inventory_alert_outbox_events',
      label: 'Eventos de distribución de alertas', recordCount: 1 }] } });
  render(<AssistantPage />); submit('¿Cuál es el estado de entrega de mis alertas de inventario?');
  await screen.findByText(/Alerta abierta — Entregada/);
  expect(screen.getByText(/Consultó estado de entrega de alertas/)).toBeTruthy();
  expect(screen.getByText('Eventos de distribución de alertas')).toBeTruthy();
  expect(screen.getByText('1 registros')).toBeTruthy();
});
it('shows safe conversation context provenance for a clarification without implying ML evidence', async () => {
  send.mockResolvedValue({ success: true, data: { ...response, answer: 'No puedo consultar una predicción diaria para ayer.',
    intent: 'ml_daily_granularity_clarification', actions: [], evidence: [],
    contextProvenance: { sourceType: 'conversation_context', entityType: 'product',
      label: 'Producto M5-FOODS_3_511 y fecha 9 de octubre de 2026 resueltos desde el contexto conversacional; no se consultó ML.' } } });
  render(<AssistantPage />); submit('¿Cuál es la predicción de ayer?');
  await screen.findByText(/No puedo consultar una predicción diaria/);
  expect(screen.getByText('Contexto conversacional · producto')).toBeTruthy();
  expect(screen.getByText(/no se consultó ML/)).toBeTruthy();
  expect(screen.queryByText('Sin evidencia de datos para esta respuesta.')).toBeNull();
});
it('navigates five visible candidates with real totals and starts refinement in the same conversation', async () => {
  const page = (offset: number): AgentResponse => ({ ...response, answer: `Opciones ${offset}`, suggestionsExpiresAt: Date.now() + 120000,
    suggestionsPagination: { query: 'food', offset, limit: 5, totalMatches: 28, hasMore: offset < 25, hasPrevious: offset > 0 },
    suggestions: Array.from({ length: offset === 25 ? 3 : 5 }, (_, i) => ({ label: `${i + 1}. Food ${offset + i} — SKU-${offset + i}`, message: `Opción ${i + 1}` })) });
  send.mockResolvedValueOnce({ success: true, data: page(0) }).mockResolvedValueOnce({ success: true, data: page(5) })
    .mockResolvedValueOnce({ success: true, data: page(0) }).mockResolvedValueOnce({ success: true, data: page(25) })
    .mockResolvedValueOnce({ success: true, data: { ...response, answer: 'Escribe una búsqueda más específica.' } })
    .mockResolvedValueOnce({ success: true, data: response });
  render(<AssistantPage />); submit('vende 2 food');
  await screen.findByText('28 coincidencias para «food» · Mostrando 1–5');
  const choices = () => screen.getAllByLabelText('Opciones de la operación').at(-1)!;
  expect(within(choices()).queryByRole('button', { name: 'Anterior' })).toBeNull();
  fireEvent.click(within(choices()).getByRole('button', { name: 'Ver más' }));
  await screen.findByText('28 coincidencias para «food» · Mostrando 6–10');
  expect(screen.getByRole('button', { name: '1. Food 5 — SKU-5' })).toBeTruthy();
  fireEvent.click(within(choices()).getByRole('button', { name: 'Anterior' }));
  await screen.findAllByText('Opciones 0');
  fireEvent.click(within(choices()).getByRole('button', { name: 'Ver más' }));
  await screen.findByText('28 coincidencias para «food» · Mostrando 26–28');
  expect(within(choices()).queryByRole('button', { name: 'Ver más' })).toBeNull();
  fireEvent.click(within(choices()).getByRole('button', { name: 'Refinar búsqueda' }));
  await screen.findByText('Escribe una búsqueda más específica.'); submit('food 3'); await screen.findByText(response.answer);
  expect(send.mock.calls.slice(1).map(call => call[0].message)).toEqual(['Ver más', 'Anterior', 'Ver más', 'Refinar búsqueda', 'food 3']);
  expect(send.mock.calls.slice(1).every(call => call[0].conversationId === response.conversationId)).toBe(true);
});
it('food choices show names/SKUs and numbered fallback, and click sends deterministic selection', async () => {
  const answer = 'Elige una coincidencia.\n1. Foods A — FOOD-A\n2. Foods B — FOOD-B';
  send.mockResolvedValueOnce({ success: true, data: { ...response, answer, suggestionsExpiresAt: Date.now() + 120000,
    suggestions: [{ label: '1. Foods A — FOOD-A', message: 'Opción 1' }, { label: '2. Foods B — FOOD-B', message: 'Opción 2' }] } })
    .mockResolvedValueOnce({ success: true, data: response });
  render(<AssistantPage />); submit('vende 2 food');
  const button = await screen.findByRole('button', { name: '1. Foods A — FOOD-A' });
  expect(screen.getByText(/Elige una coincidencia/).textContent).toContain('2. Foods B — FOOD-B');
  fireEvent.click(button); await screen.findByText(response.answer);
  expect(send.mock.calls[1][0]).toEqual({ message: 'Opción 1', conversationId: response.conversationId });
});
it('does not render an empty choices container', async () => {
  send.mockResolvedValue({ success: true, data: { ...response, suggestions: [] } });
  render(<AssistantPage />); submit(); await screen.findByText(response.answer);
  expect(screen.queryByLabelText('Opciones de la operación')).toBeNull();
});
it('guided candidates show real costs and send only the selection in the same conversation', async () => {
  send.mockResolvedValueOnce({ success: true, data: { ...response, answer: 'Elige un proveedor.', suggestions: [
    { label: '1. Distribuidora Inka', message: 'Opción 1', detail: 'COC500: 2.8 PEN' }, { label: '2. Central', message: 'Opción 2' }] } })
    .mockResolvedValueOnce({ success: true, data: response });
  render(<AssistantPage />); submit('Compra 2 coca');
  const first = await screen.findByRole('button', { name: /1. Distribuidora Inka/ });
  expect(screen.getByText('COC500: 2.8 PEN')).toBeTruthy();
  fireEvent.click(first); fireEvent.click(first); await screen.findByText(response.answer);
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0]).toEqual({ message: 'Opción 1', conversationId: response.conversationId });
  expect(first.hasAttribute('disabled')).toBe(true);
});
it('supplier candidate pagination labels ordinal selection as supplier and renders choices as separate rows', async () => {
  send.mockResolvedValueOnce({ success: true, data: { ...response, intent: 'supplier_products', suggestionsEntityType: 'supplier',
    contextProvenance: { sourceType: 'candidate_snapshot', entityType: 'supplier', query: 'food', page: 2, pageSize: 5, totalMatches: 25 },
    suggestionsPagination: { query: 'food', offset: 0, limit: 5, totalMatches: 20, hasMore: true, hasPrevious: false },
    suggestionsExpiresAt: Date.now() + 120000, suggestions: [
      { label: '1. Proveedor sintético 001 FOODS', message: 'Proveedor sintético 001 FOODS' },
      { label: '2. Proveedor sintético 010 FOODS', message: 'Proveedor sintético 010 FOODS' }] } });
  render(<AssistantPage />); submit('proveedor food');
  const first = await screen.findByRole('button', { name: '1. Proveedor sintético 001 FOODS' });
  expect(screen.getByText('“1” o “el primero” seleccionan el primer proveedor de esta página.')).toBeTruthy();
  expect(screen.getByText(/Continuación desde la conversación; no se ejecutó una consulta nueva/)).toBeTruthy();
  expect(screen.queryByText('Sin evidencia de datos para esta respuesta.')).toBeNull();
  expect(first.parentElement?.className).toContain('flex-col');
});
it('single digit candidate choices can be typed and do not confirm actions', async () => {
  send.mockResolvedValue({ success: true, data: response }); render(<AssistantPage />); submit('1');
  await screen.findByText(response.answer); expect(send.mock.calls[0][0].message).toBe('1');
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('assistant renders action preview and confirms using its bound conversation without another chat generation', async () => {
  const pending: NonNullable<AgentResponse['pendingAction']> = { pendingActionId: '33333333-3333-4333-8333-333333333333',
    action: 'create_product', summary: 'Crear producto demostrativo', fields: { name: 'Demostrativo', stock: 0 },
    expiresAt: '2099-01-01T00:00:00Z', requiresConfirmation: true, status: 'PENDING' };
  send.mockResolvedValue({ success: true, data: { ...response, answer: 'Revisa y confirma.', pendingAction: pending } });
  vi.mocked(apiClient.decideAgentAction).mockResolvedValue({ success: true, data: { ...pending, status: 'EXECUTED' } });
  render(<AssistantPage />); submit('Crear producto {"name":"Demostrativo"}');
  await screen.findByRole('region', { name: 'Acción pendiente' });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect(await screen.findByText(/Estado: Ejecutada/)).toBeTruthy();
  expect(apiClient.decideAgentAction).toHaveBeenCalledWith(pending.pendingActionId, response.conversationId, 'confirm');
  expect(send).toHaveBeenCalledTimes(1);
});
it('renders initial suggestions and sends a suggested query', async () => {
  send.mockResolvedValue({ success: true, data: response }); render(<AssistantPage />);
  expect(screen.getByRole('heading', { name: 'Asistente Inteligente' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Muéstrame los productos con stock bajo' }));
  await screen.findByText(response.answer); expect(send).toHaveBeenCalledWith({ message: 'Muéstrame los productos con stock bajo' }, expect.any(String));
});
it('displays loading, prevents parallel sends, and renders response, participants, evidence and zero tokens', async () => {
  let resolve!: (value: { success: boolean; data: AgentResponse }) => void;
  send.mockReturnValue(new Promise(done => { resolve = done; })); render(<AssistantPage />); submit();
  expect(screen.getByRole('status')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Enviar' }).hasAttribute('disabled')).toBe(true);
  fireEvent.keyDown(screen.getByLabelText('Tu consulta'), { key: 'Enter' }); fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ success: true, data: response }));
  expect(screen.getByText('Respuesta determinística · 0 tokens IA')).toBeTruthy();
  expect(screen.getByText('operations')).toBeTruthy(); expect(screen.getByText('Inventario del negocio')).toBeTruthy();
  expect(screen.getByText('get_low_stock_products · Completada')).toBeTruthy(); expect(screen.getByText('2 registros')).toBeTruthy();
});
it('reuses conversationId and starts a clean new conversation', async () => {
  send.mockResolvedValue({ success: true, data: response }); render(<AssistantPage />); submit(); await screen.findByText(response.answer);
  submit('¿y sus ventas?'); await screen.findAllByText(response.answer);
  expect(send.mock.calls[1][0]).toEqual({ message: '¿y sus ventas?', conversationId: response.conversationId });
  fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));
  expect(screen.queryByText(response.answer)).toBeNull(); expect(screen.queryByText('Inventario del negocio')).toBeNull();
  submit('ventas del mes'); await screen.findByText(response.answer); expect(send.mock.calls[2][0]).toEqual({ message: 'ventas del mes' });
});
it('shows clarification normally and preserves conversation', async () => {
  send.mockResolvedValue({ success: true, data: { ...response, requiresClarification: true, clarificationQuestion: '¿Qué SKU necesitas?' } });
  render(<AssistantPage />); submit('su predicción'); await screen.findByText('¿Qué SKU necesitas?'); expect(screen.queryByRole('alert')).toBeNull();
  submit('SKU-001'); await screen.findAllByText('¿Qué SKU necesitas?'); expect(send.mock.calls[1][0].conversationId).toBe(response.conversationId);
});
it('keeps missing metrics as dashes and shows historical forecast evidence', async () => {
  send.mockResolvedValue({ success: true, data: { ...response,
    participants: [{ ...response.participants[0], agentId: 'analyst', llmCalls: 1, totalTokens: null, thoughtTokens: null }],
    usage: { ...response.usage, totalLlmCalls: 1, totalTokens: null, totalThoughtTokens: null, metricsComplete: false },
    evidence: [{ evidenceId: 'e2', sourceType: 'skill', skillId: 'get_demand_forecast', label: 'Forecast', asOf: '2025-07-01' }] } });
  render(<AssistantPage />); submit(); await screen.findByText(response.answer);
  fireEvent.click(screen.getByRole('button', { name: 'Actividad y consumo IA' }));
  const panel = screen.getByRole('complementary', { name: 'Actividad multiagente' });
  expect(within(panel).getAllByText('—').length).toBeGreaterThan(0); expect(screen.queryByText('Respuesta determinística · 0 tokens IA')).toBeNull();
  expect(screen.getByText('Ancla histórica: 2025-07-01')).toBeTruthy();
});
it('supports Enter send and Shift+Enter without sending', async () => {
  send.mockResolvedValue({ success: true, data: response }); render(<AssistantPage />);
  const input = screen.getByLabelText('Tu consulta'); fireEvent.change(input, { target: { value: 'stock bajo' } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' }); await screen.findByText(response.answer); expect(send).toHaveBeenCalledTimes(1);
});
it('shows safe error and recovers on explicit retry without duplicating user message', async () => {
  send.mockRejectedValueOnce(new AgentApiError(503)).mockResolvedValueOnce({ success: true, data: response });
  render(<AssistantPage />); submit(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar consulta' })); await screen.findByText(response.answer);
  expect(send).toHaveBeenCalledTimes(2); expect(screen.getAllByText('stock bajo')).toHaveLength(1); expect(screen.queryByRole('alert')).toBeNull();
});
it('unknown error is generic, no raw payload and no automatic retry', async () => {
  send.mockRejectedValue(new Error('private secret')); render(<AssistantPage />); submit(); await screen.findByRole('alert');
  expect(screen.getByText('No fue posible consultar el asistente.')).toBeTruthy(); expect(screen.queryByText('private secret')).toBeNull(); expect(send).toHaveBeenCalledTimes(1);
});
it('shows final fallback model, physical attempts and partial known usage without treating fallback as an error', async () => {
  const reported = { usageAvailable: true, inputTokens: 10, outputTokens: 3, thoughtTokens: 2,
    cachedInputTokens: null, toolUseTokens: null, totalTokens: 15 };
  const unknown = { usageAvailable: false, inputTokens: null, outputTokens: null, thoughtTokens: null,
    cachedInputTokens: null, toolUseTokens: null, totalTokens: null };
  send.mockResolvedValue({ success: true, data: { ...response, usage: { ...response.usage, totalLlmCalls: 1,
    providerGenerations: [{ agentId: 'analyst', requestedModel: 'gemini-3.8-flash', finalModel: 'gemini-3.7-flash',
      fallbackUsed: true, fallbackIndex: 1, providerAttempts: 3, deadlineMs: 40000,
      logicalGenerationUsage: reported, totalKnownUsage: reported, attemptMetricsComplete: false,
      providerAttemptUsage: [
        { providerAttempt: 1, model: 'gemini-3.8-flash', status: 'FAILED', durationMs: 10, usage: unknown },
        { providerAttempt: 2, model: 'gemini-3.8-flash', status: 'FAILED', durationMs: 10, usage: unknown },
        { providerAttempt: 3, model: 'gemini-3.7-flash', status: 'SUCCEEDED', durationMs: 10, usage: reported }
      ] }] } } });
  render(<AssistantPage />); submit(); await screen.findByText(response.answer);
  expect(screen.getByText('gemini-3.7-flash · respaldo')).toBeTruthy();
  expect(screen.getByText('Intentos del proveedor: 3 · 1 llamada IA lógica')).toBeTruthy();
  expect(screen.getByText('Tokens conocidos de todos los intentos: 15')).toBeTruthy();
  expect(screen.getByText(/Consumo parcial/)).toBeTruthy();
  expect(screen.getByText('gemini-3.8-flash · intento 1 · tokens: —')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
