const { randomBytes } = require('node:crypto');
// Plain text: no HTML/Markdown parse_mode, so catalogue/provider text cannot inject markup.
const splitText = (text, max = 3500) => {
  const chunks = []; let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max / 2) cut = remaining.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    // Never split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1])) cut--;
    chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
};
const formatTelegramResponse = (response, now = Date.now()) => {
  if (typeof response?.answer !== 'string' || !response.answer.trim()) throw Error('TELEGRAM_EMPTY_RESPONSE');
  const notes = [...new Set([
    ...(Array.isArray(response.warnings) ? response.warnings : []),
    ...(Array.isArray(response.v3Views) ? response.v3Views.map(view => view.note) : [])
  ].filter(value => typeof value === 'string' && value.trim() && !response.answer.includes(value)))];
  const texts = splitText([response.answer, ...notes].join('\n'));
  if (texts.length > 20) throw Error('TELEGRAM_RESPONSE_TOO_LONG');
  const choices = [];
  if (Number.isFinite(response.suggestionsExpiresAt) && response.suggestionsExpiresAt > now) {
    for (const item of (response.suggestions || []).slice(0, 10)) {
      if (typeof item.message === 'string' && item.message.length <= 2000 && typeof item.label === 'string')
        choices.push({ purpose: 'candidate', label: item.label.slice(0, 100), selectionMessage: item.message });
    }
    const page = response.suggestionsPagination;
    if (page?.hasPrevious) choices.push({ purpose: 'page', label: '◀ Anterior', selectionMessage: 'anterior' });
    if (page?.hasMore) choices.push({ purpose: 'page', label: 'Siguiente ▶', selectionMessage: 'ver mas' });
    if (choices.length) choices.push({ purpose: 'refine', label: 'Refinar búsqueda', selectionMessage: 'refinar busqueda' },
      { purpose: 'cancel', label: 'Cancelar selección', selectionMessage: 'Cancelar selección' });
  }
  return { texts, choices: choices.map((choice, position) => ({ ...choice, position, token: `t1:${randomBytes(16).toString('base64url')}`,
    expiresAt: new Date(response.suggestionsExpiresAt) })) };
};
const telegramFrames = (response, tokens) => {
  const texts = formatTelegramResponse(response).texts;
  return texts.map((text, index) => ({ text, ...(index === texts.length - 1 && tokens.length ? {
    reply_markup: { inline_keyboard: tokens.map(row => [{ text: row.label, callback_data: row.token }]) }
  } : {}) }));
};
module.exports = { splitText, formatTelegramResponse, telegramFrames };
