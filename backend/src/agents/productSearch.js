const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const accents = { a: '[aáàäâ]', e: '[eéèëê]', i: '[iíìïî]', o: '[oóòöô]', u: '[uúùüû]', n: '[nñ]' };
const { normalizeProductText } = require('../utils/entityIdentity');

// All components must match. Numeric components cannot match a different item
// number; optional plural suffixes and accents are matching-only normalization.
const productTokenFilter = query => {
  if (!/^[\p{L}\p{N}\s_.-]+$/u.test(query)) return null;
  const words = normalizeProductText(query).split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 12 || words.some(word => !/^\d+$/.test(word) && word.length < 3)) return null;
  return { $and: words.map(word => {
    const numeric = /^\d+$/.test(word);
    const stem = word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
    const component = numeric ? `0*${word.replace(/^0+(?=\d)/, '')}`
      : [...stem].map(char => accents[char] || escape(char)).join('') + 's?';
    const regex = new RegExp(`(?:^|[^a-z0-9áéíóúñ])${component}(?=$|[^a-z0-9áéíóúñ])`, 'i');
    return { $or: [{ name: regex }, { sku: regex }, ...(!numeric ? [{ category: regex }] : [])] };
  }) };
};
module.exports = { productTokenFilter };
