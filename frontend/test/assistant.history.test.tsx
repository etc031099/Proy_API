import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AssistantPage from '@/app/assistant/page';
import { apiClient } from '@/lib/api';
import { activeConversationKey, clearActiveConversations } from '@/lib/agentHistory';
import type { AgentConversationDetail, AgentResponse } from '@/types/agent';
vi.mock('@/components/ProtectedRoute', () => ({ ProtectedRoute: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/Layout', () => ({ Layout: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-a', businessId: 'tenant-a' } }) }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), apiClient: {
  sendAgentMessage: vi.fn(), listAgentConversations: vi.fn(), getAgentConversation: vi.fn(), deleteAgentConversation: vi.fn()
} }));
const id = '11111111-1111-4111-8111-111111111111', id2 = '22222222-2222-4222-8222-222222222222';
const key = activeConversationKey('user-a', 'tenant-a');
const item = { conversationId: id, title: 'Productos con stock bajo', messageCount: 2, lastMessageAt: '2026-10-08T12:00:00Z',
  createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z', status: 'active' as const };
const response: AgentResponse = { requestId: id2, conversationId: id, answer: 'Resultado persistido.', agent: 'operations', intent: 'low_stock',
  participants: [{ agentId: 'operations', model: null, llmCalls: 0, skillCalls: 1, inputTokens: 0, outputTokens: 0, thoughtTokens: 0,
    cachedInputTokens: 0, toolUseTokens: 0, totalTokens: 0, usageAvailable: true, latencyMs: 1, providerLatencyMs: 0 }],
  actions: [{ skillId: 'get_low_stock_products', agentId: 'operations', status: 'SUCCEEDED', durationMs: 1 }],
  evidence: [{ evidenceId: 'e1', sourceType: 'skill', skillId: 'get_low_stock_products', label: 'Inventario guardado', recordCount: 2 }],
  usage: { totalLlmCalls: 0, totalSkillCalls: 1, totalInputTokens: 0, totalOutputTokens: 0, totalThoughtTokens: 0,
    totalCachedInputTokens: 0, totalToolUseTokens: 0, totalTokens: 0, totalProviderLatencyMs: 0, totalLatencyMs: 1, metricsComplete: true, agents: [], toolSelectionCycles: 0 },
  requiresClarification: false, clarificationQuestion: null, latencyMs: 1 };
const detail: AgentConversationDetail = { conversation: item, pagination: { page: 1, limit: 50, total: 2, totalPages: 1 }, messages: [
  { id: 'm1', role: 'user', text: 'stock bajo', status: 'completed', createdAt: item.createdAt },
  { id: 'm2', role: 'assistant', text: response.answer, status: 'completed', createdAt: item.createdAt, response }
] };
beforeEach(() => {
  localStorage.clear(); vi.mocked(apiClient.sendAgentMessage).mockReset();
  vi.mocked(apiClient.listAgentConversations).mockResolvedValue({ success: true, data: { items: [item], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } } });
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: detail });
  vi.mocked(apiClient.deleteAgentConversation).mockResolvedValue({ success: true, data: { deleted: true } });
});
for (const expired of [false, true]) it(`restores food choices from history, expired=${expired}`, async () => {
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: { ...detail, messages: [
    detail.messages[0], { ...detail.messages[1], response: { ...response, suggestionsExpiresAt: expired ? 0 : Date.now() + 120000,
      suggestionsPagination: { query: 'food', offset: 5, limit: 5, totalMatches: 28, hasMore: true, hasPrevious: true },
      suggestions: [{ label: '1. Foods A — FOOD-A', message: 'Opción 1' }] } }
  ] } });
  vi.mocked(apiClient.sendAgentMessage).mockResolvedValue({ success: true, data: response });
  render(<AssistantPage />);
  const choice = await screen.findByRole('button', { name: '1. Foods A — FOOD-A' });
  await waitFor(() => expect(choice.hasAttribute('disabled')).toBe(expired));
  expect(screen.getByText('28 coincidencias para «food» · Mostrando 6–6')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ver más' }).hasAttribute('disabled')).toBe(expired);
  expect(screen.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(expired);
  expect(screen.getByRole('button', { name: 'Refinar búsqueda' }).hasAttribute('disabled')).toBe(expired);
  fireEvent.click(choice);
  if (expired) {
    expect(screen.getByText(/Estas opciones vencieron/)).toBeTruthy(); expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
  } else await waitFor(() => expect(apiClient.sendAgentMessage).toHaveBeenCalledWith({ message: 'Opción 1', conversationId: id }, expect.any(String)));
});
it('loads history, restores messages/activity and stores only the active UUID without generation', async () => {
  render(<AssistantPage />); await screen.findByText(response.answer);
  fireEvent.click(screen.getByRole('button', { name: 'Conversaciones' }));
  expect(screen.getByText(item.title)).toBeTruthy(); expect(screen.getByText('Inventario guardado')).toBeTruthy();
  expect(screen.getByText('Respuesta determinística · 0 tokens IA')).toBeTruthy();
  expect(localStorage.getItem(key)).toBe(id); expect(Object.values(localStorage)).not.toContain(response.answer);
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});
it('activity panel can collapse independently to prioritize chat on small screens', async () => {
  render(<AssistantPage />); await screen.findByText(response.answer);
  const toggle = screen.getByRole('button', { name: 'Actividad y consumo IA' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('complementary', { name: 'Actividad multiagente' })).toBeTruthy();
  fireEvent.click(toggle); expect(toggle.getAttribute('aria-expanded')).toBe('false');
});
it('remount/refresh restores selected conversation via API rather than local message copies', async () => {
  localStorage.setItem(key, id2);
  const view = render(<AssistantPage />); await screen.findByText(response.answer);
  expect(apiClient.getAgentConversation).toHaveBeenCalledWith(id2, 1);
  view.unmount(); render(<AssistantPage />); await screen.findByText(response.answer);
  expect(apiClient.getAgentConversation).toHaveBeenCalledTimes(2); expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});
it('selects older conversations and sends follow-up with the restored conversationId and a request key', async () => {
  vi.mocked(apiClient.listAgentConversations).mockResolvedValue({ success: true, data: { items: [item, { ...item, conversationId: id2, title: 'Resumen del negocio' }],
    pagination: { page: 1, limit: 10, total: 2, totalPages: 1 } } });
  render(<AssistantPage />); await screen.findByText(response.answer);
  fireEvent.click(screen.getByRole('button', { name: 'Conversaciones' }));
  fireEvent.click(screen.getByRole('button', { name: /Resumen del negocio.*2 mensajes/ }));
  await waitFor(() => expect(localStorage.getItem(key)).toBe(id2));
  vi.mocked(apiClient.sendAgentMessage).mockResolvedValue({ success: true, data: { ...response, conversationId: id2 } });
  fireEvent.change(screen.getByLabelText('Tu consulta'), { target: { value: '¿Y el primero?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  await waitFor(() => expect(apiClient.sendAgentMessage).toHaveBeenCalledWith({ message: '¿Y el primero?', conversationId: id2 }, expect.any(String)));
});
it('new conversation clears selection/messages without creating a document or losing existing history', async () => {
  render(<AssistantPage />); await screen.findByText(response.answer);
  fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));
  expect(screen.queryByText(response.answer)).toBeNull(); expect(localStorage.getItem(key)).toBeNull();
  expect(screen.getByText('¿Qué quieres consultar?')).toBeTruthy(); expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});
it('deletes only the explicitly confirmed conversation and clears its active pointer', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<AssistantPage />); await screen.findByText(response.answer);
  fireEvent.click(screen.getByRole('button', { name: 'Conversaciones' }));
  vi.mocked(apiClient.listAgentConversations).mockResolvedValue({ success: true, data: { items: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 1 } } });
  fireEvent.click(screen.getByRole('button', { name: `Eliminar ${item.title}` }));
  await waitFor(() => expect(apiClient.deleteAgentConversation).toHaveBeenCalledWith(id));
  await screen.findByText('Todavía no tienes conversaciones guardadas.');
  expect(localStorage.getItem(key)).toBeNull(); expect(screen.queryByText(response.answer)).toBeNull();
});
it('empty history exposes mobile collapse and creates nothing', async () => {
  vi.mocked(apiClient.listAgentConversations).mockResolvedValue({ success: true, data: { items: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 1 } } });
  render(<AssistantPage />); const toggle = screen.getByRole('button', { name: 'Conversaciones' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false'); fireEvent.click(toggle);
  await screen.findByText('Todavía no tienes conversaciones guardadas.'); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});
it('recoverable history failure preserves active messages and can be retried', async () => {
  render(<AssistantPage />); await screen.findByText(response.answer);
  vi.mocked(apiClient.listAgentConversations).mockRejectedValueOnce(Error('private raw error'));
  fireEvent.click(screen.getByRole('button', { name: 'Conversaciones' }));
  // Force another page while preserving the chat.
  vi.mocked(apiClient.getAgentConversation).mockRejectedValueOnce(Error('private raw error'));
  fireEvent.click(screen.getByRole('button', { name: /Productos con stock bajo.*2 mensajes/ }));
  await screen.findByText('No fue posible abrir la conversación. Tu conversación actual sigue disponible.');
  expect(screen.getByText(response.answer)).toBeTruthy(); expect(screen.queryByText('private raw error')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Recargar historial' }));
  await screen.findByText('No fue posible cargar el historial. Puedes reintentarlo.');
  fireEvent.click(screen.getByRole('button', { name: 'Recargar historial' }));
  await waitFor(() => expect(screen.queryByText('No fue posible cargar el historial. Puedes reintentarlo.')).toBeNull());
});
it('restores paginated older messages in order with no LLM request', async () => {
  vi.mocked(apiClient.getAgentConversation).mockResolvedValueOnce({ success: true, data: { ...detail, pagination: { page: 1, limit: 50, total: 52, totalPages: 2 } } })
    .mockResolvedValueOnce({ success: true, data: { ...detail, messages: [{ ...detail.messages[0], id: 'older', text: 'Mensaje anterior' }],
      pagination: { page: 2, limit: 50, total: 52, totalPages: 2 } } });
  render(<AssistantPage />); await screen.findByText(response.answer);
  fireEvent.click(screen.getByRole('button', { name: 'Cargar mensajes anteriores' }));
  await screen.findByText('Mensaje anterior');
  const log = screen.getByRole('log'); expect(within(log).getAllByRole('article')[0].textContent).toContain('Mensaje anterior');
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});
it('loading a selected conversation is visible and never runs inference', async () => {
  let resolve!: (value: { success: boolean; data: AgentConversationDetail }) => void;
  vi.mocked(apiClient.getAgentConversation).mockReturnValue(new Promise(done => { resolve = done; }));
  render(<AssistantPage />); fireEvent.click(screen.getByRole('button', { name: 'Conversaciones' }));
  await screen.findByText('Cargando historial…');
  await act(async () => resolve({ success: true, data: detail })); await screen.findByText(response.answer);
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});
it('logout cleanup removes active UUIDs only, leaving unrelated storage alone', () => {
  localStorage.setItem(key, id); localStorage.setItem('theme', 'dark'); clearActiveConversations();
  expect(localStorage.getItem(key)).toBeNull(); expect(localStorage.getItem('theme')).toBe('dark');
});
