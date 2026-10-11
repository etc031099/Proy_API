// Shared by read selections and write drafts. A negated choice is never authority.
const ordinalSelection = message => {
  const text = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const indices = { primer: 0, primero: 0, primera: 0, segundo: 1, segunda: 1,
    tercer: 2, tercero: 2, tercera: 2, cuarto: 3, cuarta: 3, quinto: 4, quinta: 4,
    sexto: 5, sexta: 5, ultimo: -1, ultima: -1 };
  const positives = new Set(), negatives = new Set();
  let matched = false;
  for (const clause of text.split(/[,;]|\bpero\b/)) {
    for (const match of clause.matchAll(/\b(?:el|la|ese|esa)\s+(primer(?:o|a)?|segund[oa]|tercer(?:o|a)?|cuart[oa]|quint[oa]|sext[oa]|ultim[oa])\b|\b(primer(?:o|a)?|segund[oa]|tercer(?:o|a)?|cuart[oa]|quint[oa]|sext[oa]|ultim[oa])(?=\s+(?:producto|de la lista)\b|\s*$)/g)) {
      matched = true;
      const index = indices[match[1] || match[2]];
      const before = clause.slice(0, match.index);
      (/\bno\b|\bni\b/.test(before) ? negatives : positives).add(index);
    }
  }
  if (!matched && /\bel de arriba\b/.test(text)) {
    return { matched: true, index: /\bno\b/.test(text) ? null : 0 };
  }
  const choices = [...positives].filter(index => !negatives.has(index));
  return { matched, index: choices.length === 1 ? choices[0] : null };
};
module.exports = { ordinalSelection };
