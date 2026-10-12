import type { AgentResponse } from '@/types/agent';

export const unitLabel = (value: number) => `${value} ${value === 1 ? 'unidad' : 'unidades'}`;
export const assistantMoney = (value: number, currency = 'PEN') => {
  const amount = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return currency === 'PEN' ? `S/ ${amount}` : `${amount} ${currency}`;
};
// Keep the API's textual fallback; omit only lines already rendered as cards.
export const assistantDisplayText = (text: string, response?: AgentResponse) => {
  if (!response?.suggestions?.length) return text;
  const clean = (line: string) => line.trim().replace(/^(?:[•*-]\s*)?\d+[.)]\s*/, '');
  return text.split('\n').filter(line => !response.suggestions?.some(option => {
    const value = clean(line), label = clean(option.label);
    return value === label || Boolean(option.detail && value === `${label} — ${option.detail}`);
  })).join('\n').trim();
};
