import { expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
const instance = (apiClient as unknown as { instance: { post: (url: string, input: unknown) => Promise<unknown> } }).instance;
it('assistant uses existing API instance and only sends message/conversationId', async () => {
  const post = vi.spyOn(instance, 'post').mockResolvedValue({ data: { success: true, data: { answer: 'OK' } } });
  const input = { message: 'stock bajo', conversationId: 'example' };
  await expect(apiClient.sendAgentMessage(input)).resolves.toMatchObject({ success: true });
  expect(post).toHaveBeenCalledWith('/agent/messages', input);
});
it.each([503, 429, 400, 500])('assistant sanitizes HTTP %s without exposing provider payload', async status => {
  vi.spyOn(instance, 'post').mockRejectedValue({ isAxiosError: true, response: { status, data: { message: 'secret raw provider' } } });
  await expect(apiClient.sendAgentMessage({ message: 'hello' })).rejects.toMatchObject({ status, message: 'No fue posible consultar el asistente.', retryable: status === 503 || status === 429 });
});
it('assistant sanitizes network failures with manual retry', async () => {
  vi.spyOn(instance, 'post').mockRejectedValue({ isAxiosError: true });
  await expect(apiClient.sendAgentMessage({ message: 'hello' })).rejects.toMatchObject({ retryable: true });
});
