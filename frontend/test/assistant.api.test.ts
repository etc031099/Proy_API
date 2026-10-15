import { expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
it('preserves candidate transport including expiry in live and history API responses', async () => {
  const data = { suggestions: [{ label: '1. Foods A — FOOD-A', message: 'Opción 1' }], suggestionsExpiresAt: 123456 };
  const post = vi.spyOn(instance, 'post').mockResolvedValue({ data: { success: true, data } });
  const get = vi.spyOn(instance, 'get').mockResolvedValue({ data: { success: true, data: { messages: [{ response: data }] } } });
  try {
    expect((await apiClient.sendAgentMessage({ message: 'vende 2 food' })).data).toEqual(data);
    expect((await apiClient.getAgentConversation('conversation')).data?.messages[0].response).toEqual(data);
  } finally { post.mockRestore(); get.mockRestore(); }
});
const instance = (apiClient as unknown as { instance: {
  post: (url: string, input: unknown, config?: unknown) => Promise<unknown>;
  get: (url: string, config?: unknown) => Promise<unknown>;
  delete: (url: string) => Promise<unknown>;
} }).instance;
it('J4 preserves separate semantic and grounded telemetry without changing authenticated transport', async () => {
  const stage = { provider: 'deepseek', model: 'deepseek-flash', calls: 1, inputTokens: 300, outputTokens: 50,
    totalTokens: 350, latencyMs: 10, finishReason: 'stop', accepted: true, fallbackReason: null, estimatedCostUsd: null };
  const data = { answer: 'Ranking verificado', routingMode: 'semantic_fallback', semanticClassification: stage, groundedAnswer: stage,
    languageDecision: { detectedIntent: 'FORECAST', entitySource: 'active_context', contextEntityType: 'product',
      contextEntityId: 'ABA-ACE-002', semanticFallbackUsed: true } };
  const post = vi.spyOn(instance, 'post').mockResolvedValue({ data: { success: true, data } });
  const get = vi.spyOn(instance, 'get').mockResolvedValue({ data: { success: true, data: { messages: [{ response: data }] } } });
  try {
    expect((await apiClient.sendAgentMessage({ message: 'qué se mueve más' })).data).toEqual(data);
    expect((await apiClient.getAgentConversation('conversation')).data?.messages[0].response).toEqual(data);
  } finally { post.mockRestore(); get.mockRestore(); }
});
it.each(['AGENT_PROVIDER_FAILED', 'AGENT_SKILL_FAILED', 'AGENT_INVALID_REQUEST', 'AGENT_INTERNAL_ERROR'])('J3 preserves only a safe error code: %s', async code => {
  vi.spyOn(instance, 'post').mockRejectedValue({ isAxiosError: true, response: { status: 503, data: { code, message: 'PRIVATE_PROVIDER' } } });
  await expect(apiClient.sendAgentMessage({ message: 'consulta' })).rejects.toMatchObject({ code });
});
it('J3 discards unknown backend error codes and raw text', async () => {
  vi.spyOn(instance, 'post').mockRejectedValue({ isAxiosError: true, response: { status: 500, data: { code: 'PRIVATE_PROVIDER', message: 'PRIVATE' } } });
  await expect(apiClient.sendAgentMessage({ message: 'consulta' })).rejects.toMatchObject({ code: undefined,
    message: 'No pude completar la consulta en este momento. Intenta nuevamente.' });
});
it('assistant uses existing API instance and only sends message/conversationId', async () => {
  const post = vi.spyOn(instance, 'post').mockResolvedValue({ data: { success: true, data: { answer: 'OK' } } });
  const input = { message: 'stock bajo', conversationId: 'example' };
  await expect(apiClient.sendAgentMessage(input)).resolves.toMatchObject({ success: true });
  expect(post).toHaveBeenCalledWith('/agent/messages', input);
});
it.each([503, 429, 400, 500])('assistant sanitizes HTTP %s without exposing provider payload', async status => {
  vi.spyOn(instance, 'post').mockRejectedValue({ isAxiosError: true, response: { status, data: { message: 'secret raw provider' } } });
  await expect(apiClient.sendAgentMessage({ message: 'hello' })).rejects.toMatchObject({ status, message: 'No pude completar la consulta en este momento. Intenta nuevamente.', retryable: status === 503 || status === 429 });
});
it('assistant sanitizes network failures with manual retry', async () => {
  vi.spyOn(instance, 'post').mockRejectedValue({ isAxiosError: true });
  await expect(apiClient.sendAgentMessage({ message: 'hello' })).rejects.toMatchObject({ retryable: true });
});
it('history reuses authenticated API, scoped pagination and request deduplication header', async () => {
  const post = vi.spyOn(instance, 'post').mockResolvedValue({ data: { success: true } });
  const get = vi.spyOn(instance, 'get').mockResolvedValue({ data: { success: true } });
  const remove = vi.spyOn(instance, 'delete').mockResolvedValue({ data: { success: true } });
  const key = '11111111-1111-4111-8111-111111111111';
  await apiClient.sendAgentMessage({ message: 'stock bajo' }, key);
  expect(post).toHaveBeenCalledWith('/agent/messages', { message: 'stock bajo' }, { headers: { 'Idempotency-Key': key } });
  await apiClient.listAgentConversations(2);
  expect(get).toHaveBeenCalledWith('/agent/conversations', { params: { page: 2, limit: 10 } });
  await apiClient.getAgentConversation(key, 2);
  expect(get).toHaveBeenCalledWith(`/agent/conversations/${key}`, { params: { page: 2, limit: 50 } });
  await apiClient.deleteAgentConversation(key);
  expect(remove).toHaveBeenCalledWith(`/agent/conversations/${key}`);
});
it('uncertain persistence cannot trigger an automatic/manual regeneration retry', async () => {
  vi.spyOn(instance, 'post').mockRejectedValue({ isAxiosError: true, response: { status: 503,
    data: { code: 'AGENT_HISTORY_PERSISTENCE_FAILED', message: 'raw secret' } } });
  await expect(apiClient.sendAgentMessage({ message: 'hello' })).rejects.toMatchObject({ retryable: false, code: 'AGENT_HISTORY_PERSISTENCE_FAILED' });
});
