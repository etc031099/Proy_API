'use strict';
const { isPlainObject } = require('./contracts');
const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = text => normalize(text).match(/\p{L}+/gu) || [];
const PACK = /(?<![\w.,+\-])(\d+(?:[.,]\d+)?)\s*(ml|kg|mg|g|l)\b/giu;
const numberValue = value => Number(value.replace(',', '.'));
const stripStructuralListMarkers = text => text.replace(
  /(^|\n)([ \t]{0,3}(?:[-*+][ \t]+)?)([1-3])[.)](?=[ \t]+\S)/g, '$1$2');
const NUMBER_PATTERNS = Object.freeze(['LINE_LIST_MARKER', 'PAREN_INDEX', 'BRACKET_INDEX', 'HASH_INDEX',
  'ORDINAL_INDEX', 'ENTITY_PRESENTATION', 'QUANTITY_WITH_UNIT', 'PERCENTAGE', 'DECIMAL_METRIC',
  'STANDALONE_NUMBER', 'UNKNOWN_CONTEXT', 'EVIDENCE_REFERENCE']);
const UNIT_START = /^(?:unidad(?:es)?|proveedor(?:es)?|productos?|tickets?|dias?|semanas?|ml|kg|mg|g|l|%|por ciento)\b/u;
const numberPattern = (text, match) => {
  const before = normalize(text.slice(Math.max(0, match.index - 45), match.index));
  const after = normalize(text.slice(match.index + match[0].length, match.index + match[0].length + 45));
  if (/(?:^|\n)[ \t]*(?:[-*+][ \t]+)?$/.test(before) && /^[.)][ \t]+/.test(after)) return 'LINE_LIST_MARKER';
  if (/^\s*%/.test(after) || /^\s*por ciento\b/.test(after)) return 'PERCENTAGE';
  if (UNIT_START.test(after.trimStart())) return 'QUANTITY_WITH_UNIT';
  if (/[.,]/.test(match[0])) return 'DECIMAL_METRIC';
  if (/(?:\be|evidencia\s*|fuente\s*)$/.test(before)) return 'EVIDENCE_REFERENCE';
  if (/\([^)]*$/.test(before) && /^[^()]*\)/.test(after)) return 'PAREN_INDEX';
  if (/\[[^\]]*$/.test(before) && /^[^\[\]]*\]/.test(after)) return 'BRACKET_INDEX';
  if (/#\s*$/.test(before)) return 'HASH_INDEX';
  if (/^[ºª]/.test(after) || /(?:productos?|proveedor(?:es)?|opcion(?:es)?|puntos?|n[.º°\s]*)\s*$/.test(before)) return 'ORDINAL_INDEX';
  if (/(?:stock|cobertura|demanda|cantidad)\s*$/.test(before)) return 'UNKNOWN_CONTEXT';
  return 'STANDALONE_NUMBER';
};
const stripExplicitIndexLabels = text => text.replace(
  /(^|\n)([ \t]{0,3}(?:[-*+][ \t]+)?)(?:\([1-3]\)|\[[1-3]\]|#[1-3])(?=[ \t]+\S)/g,
  (marker, line, indent, offset) => {
    const following = normalize(text.slice(offset + marker.length).trimStart());
    // A bare quantity/unit after the label is ambiguous; preserve it for grounding.
    return UNIT_START.test(following) || /^\d|^%/.test(following) ? marker : `${line}${indent}`;
  });
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
const unsupportedNumberDetails = (text, evidence) => {
  const metricText = withoutPresentationNumbers(stripExplicitIndexLabels(stripStructuralListMarkers(text)), evidence.presentations);
  return [...metricText.matchAll(/-?\d+(?:[.,]\d+)?/g)].filter(match => {
    const number = match[0];
    const normalized = number.replace(',', '.'), claim = Number(normalized), decimals = normalized.split('.')[1]?.length;
    return !evidence.numbers.some(fact => fact === claim
      || decimals >= 1 && decimals <= 2 && Number(fact.toFixed(decimals)) === claim);
  }).map(match => ({ value: numberValue(match[0]), pattern: numberPattern(metricText, match) }));
};
const unsupportedNumbers = (text, evidence) => [...new Set(unsupportedNumberDetails(text, evidence).map(detail => detail.value))];
module.exports = { numericEvidence, stripStructuralListMarkers, unsupportedNumbers, unsupportedNumberDetails, NUMBER_PATTERNS };
