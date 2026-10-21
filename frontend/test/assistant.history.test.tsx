import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AssistantPage from '@/app/assistant/page';
import { apiClient } from '@/lib/api';
import { activeConversationKey, clearActiveConversations } from '@/lib/agentHistory';
import { assistantDisplayText } from '@/lib/assistantPresentation';
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
// Sanitized shape read from the incident's persisted assistant message (no PII).
const incidentResponse: AgentResponse = { ...response, agent: 'inventory', intent: 'v3_intelligence',
  answer: 'Resumen de inventario.',
  participants: ['coordinator', 'inventory'].map(agentId => ({ ...response.participants[0], agentId })) as AgentResponse['participants'],
  v3Views: [{ kind: 'inventory', title: 'Inteligencia de inventario', items: [], metrics: [
    { label: 'Productos', value: 80 }, { label: 'Críticos', value: null }, { label: 'Stock bajo', value: 17 },
    { label: 'Requieren reposición', value: null }, { label: 'Clasificación ABC', value: 'A: 0 · B: 0 · C: 0 · UNCLASSIFIED: 80' },
    { label: 'Variabilidad XYZ', value: 'X: 55 · Y: 21 · Z: 4 · UNCLASSIFIED: 0' }
  ] }] };
beforeEach(() => {
  localStorage.clear(); vi.mocked(apiClient.sendAgentMessage).mockReset();
  vi.mocked(apiClient.listAgentConversations).mockResolvedValue({ success: true, data: { items: [item], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } } });
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: detail });
  vi.mocked(apiClient.deleteAgentConversation).mockResolvedValue({ success: true, data: { deleted: true } });
});
it('A6 legacy Analyst history still loads and renders without new generation', async () => {
  const legacy: AgentResponse = { ...response, agent: 'analyst', answer: 'Explicación histórica conservada.',
    participants: [{ ...response.participants[0], agentId: 'analyst' }] };
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: { ...detail,
    messages: [detail.messages[0], { ...detail.messages[1], text: legacy.answer, response: legacy }] } });
  render(<AssistantPage />);
  await screen.findByText(legacy.answer);
  expect(screen.getByRole('heading', { name: /Analista \(compatibilidad\)/ })).toBeTruthy();
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});

it('A6 restored durable execution is visible as a confirmed action, not a fabricated skill', async () => {
  const executed: AgentResponse = { ...response, actions: [], evidence: [],
    participants: [{ ...response.participants[0], skillCalls: 0 }], usage: { ...response.usage, totalSkillCalls: 0 },
    pendingAction: { pendingActionId: '33333333-3333-4333-8333-333333333333', action: 'create_sale', summary: 'Venta',
      status: 'EXECUTED', requiresConfirmation: true, expiresAt: '2099-01-01T00:00:00Z', fields: {},
      result: { id: 'restored-operation', type: 'sale', total: 15.06, currency: 'PEN' } } };
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: { ...detail,
    messages: [detail.messages[0], { ...detail.messages[1], response: executed }] } });
  render(<AssistantPage />);
  await screen.findByText('create_sale · Ejecutada');
  const activity = within(screen.getByLabelText('Actividad multiagente'));
  expect(activity.queryByText('Sin skills ejecutadas.')).toBeNull();
  expect(activity.getByText('Skills ejecutadas').nextElementSibling?.textContent).toBe('0');
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
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

it('P0 restores persisted nullable inventory metrics alongside forecast and direct answers after reload', async () => {
  const composite = { ...response, agent: 'coordinator' as const,
    answer: 'Sí, debes reponer Coca-Cola.\n\nEscenario V3 · detalle redundante.\n\nSe esperan 108.27 unidades de Coca-Cola en los próximos 14 días según Ridge LIVE ACTIVE. Modelo v1 · ACTIVE · featureVersion CAUSAL27.',
    actions: [{ skillId: 'get_inventory_intelligence', agentId: 'inventory', status: 'SUCCEEDED', durationMs: 1 },
      { skillId: 'get_product_forecast', agentId: 'forecast', status: 'SUCCEEDED', durationMs: 1 }],
    participants: ['coordinator', 'inventory', 'forecast'].map(agentId => ({ ...response.participants[0], agentId })),
    v3Views: [
      { kind: 'inventory', title: 'Inventario', metrics: [{ label: 'Críticos', value: null }, { label: 'Requieren reposición', value: null }], items: [] },
      { kind: 'forecast', title: 'Pronóstico', metrics: [{ label: 'Predicción', value: 108.27 }], items: [] }
    ] } as AgentResponse;
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: { ...detail,
    messages: [...detail.messages, { ...detail.messages[1], id: 'composite', text: composite.answer, response: composite }] } });
  expect(assistantDisplayText(composite.answer, composite, 'consulta normal')).toContain('Sí, debes reponer Coca-Cola.');
  const mounted = render(<AssistantPage />);
  await waitFor(() => expect(apiClient.getAgentConversation).toHaveBeenCalledWith(id, 1));
  await screen.findByRole('region', { name: 'Inventario' });
  await waitFor(() => expect(screen.getByRole('log').textContent).toContain('Sí, debes reponer Coca-Cola.'));
  expect(screen.getByRole('log').textContent).toContain('Se esperan 108.27 unidades de Coca-Cola');
  expect(screen.getByRole('log').textContent).not.toContain('Escenario V3 · detalle redundante');
  expect(screen.getAllByText('No disponible')).toHaveLength(2);
  expect(screen.getByRole('region', { name: 'Inventario' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Pronóstico' })).toBeTruthy();
  expect(screen.getByRole('log').textContent).toContain('Sí, debes reponer Coca-Cola.');
  mounted.unmount(); render(<AssistantPage />);
  await waitFor(() => expect(screen.getByRole('log').textContent).toContain('Sí, debes reponer Coca-Cola.'));
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));
  expect(screen.getByLabelText('Tu consulta').hasAttribute('disabled')).toBe(false);
});

it('P0 auto-restores the real persisted incident shape with empty browser storage and can revisit it', async () => {
  const brokenDetail = { ...detail, messages: [detail.messages[0], { ...detail.messages[1], text: incidentResponse.answer, response: incidentResponse }] };
  vi.mocked(apiClient.listAgentConversations).mockResolvedValue({ success: true, data: { items: [item,
    { ...item, conversationId: id2, title: 'Conversación anterior' }], pagination: { page: 1, limit: 10, total: 2, totalPages: 1 } } });
  vi.mocked(apiClient.getAgentConversation).mockImplementation(async target => ({ success: true, data: target === id ? brokenDetail : detail }));
  const mounted = render(<AssistantPage />);
  await screen.findByRole('region', { name: 'Inteligencia de inventario' });
  expect(screen.getByText(/Resumen de inventario\./)).toBeTruthy();
  expect(screen.getAllByText('No disponible')).toHaveLength(2);
  expect(screen.getByText('80')).toBeTruthy(); expect(screen.getByText('17')).toBeTruthy();
  mounted.unmount(); localStorage.clear(); render(<AssistantPage />);
  await screen.findByRole('region', { name: 'Inteligencia de inventario' });
  fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));
  fireEvent.click(screen.getByRole('button', { name: 'Conversaciones' }));
  fireEvent.click(screen.getByRole('button', { name: /Conversación anterior.*2 mensajes/ }));
  await screen.findByText(response.answer);
  fireEvent.click(screen.getByRole('button', { name: /Productos con stock bajo.*2 mensajes/ }));
  await screen.findByText(incidentResponse.answer);
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});

it('P0 isolates an invalid message/activity, keeps valid history/input and permits conversation switching', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const malformed = { ...response, participants: [null], v3Views: [{ kind: 'inventory', title: 'Incompleta', metrics: [null], items: [] }] } as unknown as AgentResponse;
    vi.mocked(apiClient.listAgentConversations).mockResolvedValue({ success: true, data: { items: [item,
      { ...item, conversationId: id2, title: 'Conversación sana' }], pagination: { page: 1, limit: 10, total: 2, totalPages: 1 } } });
    vi.mocked(apiClient.getAgentConversation).mockImplementation(async target => ({ success: true, data: target === id2 ? detail : { ...detail,
      messages: [...detail.messages, { ...detail.messages[1], id: 'invalid', text: 'Respuesta incompleta', response: malformed }] } }));
    render(<AssistantPage />);
    await screen.findAllByText('No se pudo mostrar esta respuesta.');
    expect(screen.getByText(response.answer)).toBeTruthy();
    expect(screen.getByLabelText('Tu consulta').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Conversaciones' }));
    fireEvent.click(screen.getByRole('button', { name: /Conversación sana.*2 mensajes/ }));
    await waitFor(() => expect(screen.queryByText('No se pudo mostrar esta respuesta.')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));
    expect(screen.getByText('¿Qué quieres consultar?')).toBeTruthy();
  } finally { consoleError.mockRestore(); }
});

it('P0 renders partial pre-A3 activity without treating missing usage as zero or hiding the answer', async () => {
  const legacy = { answer: 'Respuesta antigua sin actividad.', conversationId: id } as AgentResponse;
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: { ...detail,
    messages: [{ ...detail.messages[1], text: legacy.answer, response: legacy }] } });
  render(<AssistantPage />);
  await screen.findByText(legacy.answer);
  expect(screen.getByText('Esta respuesta antigua no incluye métricas de actividad.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ver actividad · — llamadas IA · — tokens' })).toBeTruthy();
});

for (const [agent, answer] of [
  ['inventory', 'Sí, debes reponer Coca-Cola Sabor Original 500 ml.'],
  ['forecast', 'Se esperan 108.27 unidades de Coca-Cola Sabor Original 500 ml en los próximos 14 días según Ridge LIVE ACTIVE.']
] as const) it(`P0 ${agent} direct conclusion remains visible before its evidence card`, async () => {
  const specialized = { ...response, agent, answer, v3Views: [{ kind: agent, title: 'Evidencia del especialista', metrics: [],
    items: [{ type: 'product' as const, key: 'BEB-GAS-001', label: 'Coca-Cola Sabor Original 500 ml',
      metrics: [{ label: 'Dato parcial', value: null }] }] }] };
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: { ...detail,
    messages: [{ ...detail.messages[1], text: answer, response: { ...specialized, actions: [{ skillId: agent === 'inventory' ? 'get_inventory_intelligence' : 'get_product_forecast', agentId: agent, status: 'SUCCEEDED', durationMs: 1 }] } }] } });
  render(<AssistantPage />);
  const conclusion = await screen.findByText(new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const card = screen.getByRole('region', { name: agent === 'inventory' ? 'Datos clave' : 'Pronóstico' });
  expect(conclusion.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card).toBeTruthy();
});

it('P0 a partial view with absent legacy collections keeps its answer and a controlled empty state', async () => {
  const partial = { ...response, v3Views: [{ kind: 'inventory', title: 'Vista antigua', metrics: null, items: null }] } as unknown as AgentResponse;
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: { ...detail,
    messages: [{ ...detail.messages[1], response: partial }] } });
  render(<AssistantPage />);
  await screen.findByRole('region', { name: 'Vista antigua' });
  expect(screen.getByRole('region', { name: 'Vista antigua' })).toBeTruthy();
  expect(screen.getByText('No hay datos para los filtros solicitados.')).toBeTruthy();
});

it('A4.3 persisted forecast model intent remains technical after a SKU selection and reload', async () => {
  const answer = 'El pronóstico de Coca-Cola utiliza Ridge LIVE con el modelo ACTIVE v1 y featureVersion RIDGE_CAUSAL27_V1. El horizonte consultado es de 14 días.';
  const technical: AgentResponse = { ...response, agent: 'forecast', requestedIntent: 'model_status', answer,
    actions: [{ skillId: 'get_product_forecast', agentId: 'forecast', status: 'SUCCEEDED', durationMs: 1 }],
    v3Views: [{ kind: 'forecast', title: 'Pronóstico', metrics: [], items: [{ type: 'product', key: 'BEB-GAS-001', label: 'Coca-Cola', metrics: [
      { label: 'Unidades esperadas · 14 días', value: 107.3 }, { label: 'Estado', value: 'READY' },
      { label: 'Modelo ACTIVE', value: 'v1' }, { label: 'Feature version', value: 'RIDGE_CAUSAL27_V1' }
    ] }] }] };
  vi.mocked(apiClient.getAgentConversation).mockResolvedValue({ success: true, data: { ...detail,
    messages: [{ ...detail.messages[0], text: 'BEB-GAS-001' }, { ...detail.messages[1], text: answer, response: technical }] } });
  const mounted = render(<AssistantPage />);
  await screen.findByText(answer); expect(screen.getByText('Feature version: RIDGE_CAUSAL27_V1')).toBeTruthy();
  mounted.unmount(); render(<AssistantPage />);
  await screen.findByText(answer); expect(screen.getByText('Feature version: RIDGE_CAUSAL27_V1')).toBeTruthy();
  expect(apiClient.sendAgentMessage).not.toHaveBeenCalled();
});
