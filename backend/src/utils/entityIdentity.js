// Matching-only invariants. Stored labels, SKUs and tenant scope stay canonical.
const normalizeEntityText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const normalizeProductText = value => normalizeEntityText(value)
  .replace(/\b(?:foods?|fods|fooods)\b/g, 'food').replace(/\b(?:item|itme)\b/g, 'item')
  .replace(/\bprodcto\b/g, 'producto');
const canonicalNumber = value => value.replace(/^0+(?=\d)/, '');
const extractIdentityNumbers = value => normalizeEntityText(value).split(' ')
  .filter(token => /^\d+$/.test(token)).map(canonicalNumber);
const productComponents = value => {
  const text = normalizeProductText(value);
  const sku = text.match(/^m 5 ([a-z]+) (\d+) (\d+)$/);
  if (sku) return { family: sku[1], group: canonicalNumber(sku[2]), item: canonicalNumber(sku[3]) };
  const match = text.match(/\bfood\s+(\d+)\s+(?:item\s+)?(\d+)\b/);
  return match ? { family: 'food', group: canonicalNumber(match[1]), item: canonicalNumber(match[2]) } : null;
};
const requestedItem = value => normalizeProductText(value).match(/\b(?:item|food)\s+(\d+)\s*$/)?.[1];
const exactProductComponents = (reference, candidate) => {
  if (!/^(?:m 5 )?food \d+ (?:item )?\d+$/.test(normalizeProductText(reference))) return false;
  const requested = productComponents(reference), actual = productComponents(candidate.sku);
  return Boolean(requested && actual && requested.family === actual.family && requested.group === actual.group && requested.item === actual.item);
};
const numbersCompatible = (reference, candidate, { product = false } = {}) => {
  const required = extractIdentityNumbers(reference);
  const available = extractIdentityNumbers(`${candidate.name || candidate.label || ''} ${candidate.sku || ''}`);
  if (!required.every(number => available.includes(number))) return false;
  const requested = product && productComponents(reference);
  const actual = product && (productComponents(candidate.sku) || productComponents(candidate.name || candidate.label));
  if (requested) {
    if (!actual || actual.family !== requested.family || actual.group !== requested.group || actual.item !== requested.item) return false;
  }
  const item = product && !requested && requestedItem(reference);
  if (item && actual && actual.item !== canonicalNumber(item)) return false;
  return true;
};
const numericIdentityFilter = reference => {
  const numbers = [...new Set(extractIdentityNumbers(reference))];
  const clauses = numbers.map(number => {
    const regex = new RegExp(`(?:^|[^0-9])0*${number}(?=$|[^0-9])`, 'i');
    return { $or: [{ name: regex }, { sku: regex }] };
  });
  const components = productComponents(reference);
  if (components) {
    const family = components.family === 'food' ? 'foods?' : components.family;
    const regex = new RegExp(`(?:^|[^a-z0-9])${family}[^a-z0-9]+0*${components.group}[^a-z0-9]+(?:[ií]tem[^a-z0-9]+)?0*${components.item}(?=$|[^0-9])`, 'i');
    clauses.push({ $or: [{ name: regex }, { sku: regex }] });
  }
  const item = !components && requestedItem(reference);
  if (item) clauses.push({ $or: [
    { sku: new RegExp(`^M5-[A-Z]+_\\d+_0*${canonicalNumber(item)}$`, 'i') },
    { sku: /^(?!M5-[A-Z]+_\d+_)/i }
  ] });
  return clauses.length ? { $and: clauses } : {};
};
module.exports = { normalizeEntityText, normalizeProductText, extractIdentityNumbers, numbersCompatible, numericIdentityFilter, exactProductComponents };
