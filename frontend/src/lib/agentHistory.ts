// Only a UUID is stored locally. Messages and activity always come from the API.
export const activeConversationKey = (userId: string, businessId: string) => `assistant.activeConversationId.${userId}.${businessId}`;
export function readActiveConversation(key: string) {
  try { const id = localStorage.getItem(key); return id && /^[a-f\d-]{36}$/i.test(id) ? id : undefined; } catch { return undefined; }
}
export function writeActiveConversation(key: string, id?: string) {
  try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}
export function clearActiveConversations() {
  try { Object.keys(localStorage).filter(key => key.startsWith('assistant.activeConversationId.')).forEach(key => localStorage.removeItem(key)); } catch { /* Storage may be disabled. */ }
}
