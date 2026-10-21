import type { AgentResponse } from '@/types/agent';

export const unitLabel = (value: number) => `${value} ${value === 1 ? 'unidad' : 'unidades'}`;
export const assistantMoney = (value: number, currency = 'PEN') => {
  const amount = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return currency === 'PEN' ? `S/ ${amount}` : `${amount} ${currency}`;
};

export const isTechnicalAgentQuestion = (question = '') =>
  /\b(modelo|feature.?version|versi[oó]n|revisi[oó]n|observaciones cerradas|metodolog[ií]a|m[eé]todo|ridge|causal27|por qu[eé].{0,24}(?:1 d[ií]a|ma[ñn]ana|no hay forecast))\b/i.test(question);

const directForecast = (text: string) => text.match(/(?:Se esperan .+? unidades .+? en los pr[oó]ximos \d+ d[ií]as seg[uú]n Ridge LIVE ACTIVE\.|El pron[oó]stico Ridge LIVE de .+? para \d+ d[ií]as no est[aá] disponible\.)/i)?.[0];
const directInventory = (text: string) => {
  const end = text.indexOf('\n\nEscenario V3 ·');
  const introduction = (end < 0 ? text : text.slice(0, end)).trim();
  return introduction.split(/\n\s*\n/)[0]?.trim() || undefined;
};

// The specialist conclusion is user facing; the V3 scenario dump is repeated in cards/activity.
export const assistantDisplayText = (text: string, response?: AgentResponse, question = '') => {
  const skills = response?.actions?.map(action => action.skillId) || [];
  const hasInventory = skills.includes('get_inventory_intelligence') || response?.v3Views?.some(view => view?.kind === 'inventory');
  const hasForecast = skills.includes('get_product_forecast') || response?.v3Views?.some(view => view?.kind === 'forecast');
  if (response?.v3Views?.length && (hasInventory || hasForecast)) {
    if (isTechnicalAgentQuestion(question)) return text;
    const conclusions = [
      ...(hasInventory ? [directInventory(text)].filter((value): value is string => Boolean(value)) : []),
      ...(hasForecast ? [directForecast(text)].filter((value): value is string => Boolean(value)) : [])
    ];
    return conclusions.join('\n\n');
  }
  if (response?.v3Views?.some(view => view?.note === text && !view?.metrics?.length && !view?.items?.length)) return '';
  if (response?.v3Views?.length) return '';
  if (!response?.suggestions?.length) return text;
  const clean = (line: string) => line.trim().replace(/^(?:[•*-]\s*)?\d+[.)]\s*/, '');
  return text.split('\n').filter(line => !response.suggestions?.some(option => {
    const value = clean(line), label = clean(option.label);
    return value === label || Boolean(option.detail && value === `${label} — ${option.detail}`);
  })).join('\n').trim();
};
