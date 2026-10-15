'use strict';
const { isPlainObject } = require('./contracts');
const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = text => normalize(text).match(/\p{L}+/gu) || [];
const PACK = /(?<![\w.,+\-])(\d+(?:[.,]\d+)?)\s*(ml|kg|mg|g|l)\b/giu;
const numberValue = value => Number(value.replace(',', '.'));
const numericEvidence = facts => {
  const numbers = [], presentations = [];
  const collect = value => {
    if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (isPlainObject(value)) {
      // Only product identities, never arbitrary strings or numeric SKU suffixes.
      if (typeof value.sku === 'string') for (const field of ['productName', 'name', 'displayName']) {
        if (typeof value[field] !== 'string') continue;
        for (const match of value[field].matchAll(PACK)) {
          const prefix = words(value[field].slice(0, match.index));
          if (prefix.length >= 2) presentations.push({ prefix, amount: numberValue(match[1]), unit: match[2].toLowerCase() });
        }
      }
      Object.values(value).forEach(collect);
    }
  };
  facts.forEach(collect);
  return { numbers, presentations };
};
const withoutPresentationNumbers = (text, presentations) => text.replace(PACK, (match, amount, unit, offset) => {
  // A shortened name must retain >=2 consecutive words from the generated name,
  // in canonical order, directly before the exact package amount and unit.
  // The package number is not added to the numeric fact whitelist.
  const prefix = words(text.slice(0, offset).split(/[.!?;:\n\d]/u).pop());
  const supported = presentations.some(presentation => {
    if (numberValue(amount) !== presentation.amount || unit.toLowerCase() !== presentation.unit) return false;
    for (let length = 2; length <= Math.min(prefix.length, presentation.prefix.length); length++) {
      let index = 0;
      const suffix = prefix.slice(-length);
      for (const word of presentation.prefix) if (word === suffix[index]) index++;
      if (index === suffix.length && new Set(suffix).size >= 2) return true;
    }
    return false;
  });
  return supported ? '[presentación]' : match;
});
const unsupportedNumbers = (text, evidence) => {
  const metricText = withoutPresentationNumbers(text, evidence.presentations);
  return [...new Set((metricText.match(/-?\d+(?:[.,]\d+)?/g) || []).filter(number => {
    const normalized = number.replace(',', '.'), claim = Number(normalized), decimals = normalized.split('.')[1]?.length;
    return !evidence.numbers.some(fact => fact === claim
      || decimals >= 1 && decimals <= 2 && Number(fact.toFixed(decimals)) === claim);
  }).map(numberValue))];
};
module.exports = { numericEvidence, unsupportedNumbers };
