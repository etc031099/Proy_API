// Exact phrases only: entity selection, questions and corrections never authorize a write.
const normalizeDecision = message => message.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim().replace(/[,.!]+/g, ' ').replace(/\s+/g, ' ').trim();
const CONFIRM = new Set(['confirmar', 'confirma', 'confirmalo', 'confirmo', 'confimra',
  'si confirmar', 'si confirma', 'si hazlo', 'si procede', 'hazlo', 'procede', 'adelante', 'acepto', 'de acuerdo',
  'ok confirma', 'correcto confirma', 'confirm', 'ok confirm', 'yes confirm']);
const SHORT = new Set(['si', 'ok', 'vale', 'correcto', 'dale']);
const CANCEL = new Set(['cancelar', 'cancela', 'cancelalo', 'cancelo', 'cansela', 'no lo hagas', 'mejor no',
  'dejalo', 'olvidalo', 'descarta', 'descartalo', 'anula', 'no quiero hacerlo', 'mejor cancela eso', 'mejor no cancela', 'cancel', 'no cancel']);
const HOLD = new Set(['no', 'no todavia', 'no confirmes', 'no espera', 'todavia no', 'no quiero', 'no procede']);
function actionDecision(message) {
  const text = normalizeDecision(message);
  if (/[¿?]/.test(message)) {
    const question = text.replace(/[¿?]/g, '').trim();
    return /\b(?:confirm\w*|hazlo|cancel\w*)\b/.test(question)
      || /^(?:esta bien el precio|puedo cambiar el cliente)$/.test(question) ? 'hold' : null;
  }
  if (CANCEL.has(text)) return 'cancel';
  if (HOLD.has(text) || /\bno\b/.test(text) && /\b(?:si|ok|vale|correcto|confirm\w*|hazlo|procede|adelante|acepto|dale|revisar)\b/.test(text)) return 'hold';
  if (CONFIRM.has(text)) return 'confirm';
  if (SHORT.has(text)) return 'short';
  // Mixed instructions containing approval are not an explicit approval.
  if (/\b(?:confirm\w*|hazlo|procede)\b/.test(text)) return 'hold';
  return null;
}
module.exports = { actionDecision };
