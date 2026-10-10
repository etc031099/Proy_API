const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const normalizeSupplier = value => normalize(value).replace(/\b(?:proveedor|supplier|sintetico)\b/g, ' ')
  .replace(/\b(?:el|la|de|del)\b/g, ' ').replace(/\b0*(\d+)\b/g, (_, digits) => String(Number(digits)))
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const MAX_SUPPLIER_CANDIDATES = 100;
const editDistance = (left, right) => {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1,
      row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    row = next;
  }
  return row[right.length];
};
const resolveSupplier = (reference, offers, suppliers = [], candidateLimit = 20) => {
  const query = normalizeSupplier(reference);
  if (!query) return { status: 'NOT_FOUND', candidates: [] };
  const byId = offers.filter(offer => String(offer.supplierId) === String(reference));
  if (byId.length === 1) return { status: 'MATCH', offer: byId[0], confidence: 'EXACT' };
  const rank = rows => rows.map(row => {
    const name = normalizeSupplier(row.supplierName || row.name);
    if (!name) return null;
    const queryTokens = query.split(' '), nameTokens = name.split(' ');
    const matched = queryTokens.filter(token => nameTokens.some(candidate => candidate === token
      || (token.length >= 4 && editDistance(token, candidate) <= 1)));
    const coverage = matched.length / queryTokens.length;
    const similarity = 1 - editDistance(query, name) / Math.max(query.length, name.length, 1);
    const score = query === name ? 1 : name.includes(query) ? 0.94 : Math.max(coverage * 0.85, similarity);
    return { row, name, score };
  }).filter(row => row && row.score >= 0.72).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)
    || String(a.row.supplierId ?? a.row._id ?? '').localeCompare(String(b.row.supplierId ?? b.row._id ?? '')));
  const rankedOffers = rank(offers);
  const exact = rankedOffers.filter(item => item.score === 1);
  if (exact.length === 1) return { status: 'MATCH', offer: exact[0].row, confidence: 'NORMALIZED' };
  if (exact.length > 1) return { status: 'AMBIGUOUS', candidates: exact.slice(0, candidateLimit).map(item => item.row), totalMatches: exact.length };
  if (rankedOffers.length === 1 && rankedOffers[0].score >= 0.85) {
    return { status: 'MATCH', offer: rankedOffers[0].row, confidence: rankedOffers[0].score === 1 ? 'NORMALIZED' : 'FUZZY_CLEAR' };
  }
  if (rankedOffers.length > 1) {
    const first = rankedOffers[0], second = rankedOffers[1];
    if (first.score >= 0.85 && first.score - second.score >= 0.08) {
      return { status: 'MATCH', offer: first.row, confidence: 'FUZZY_CLEAR' };
    }
    return { status: 'AMBIGUOUS', candidates: rankedOffers.slice(0, candidateLimit).map(item => item.row), totalMatches: rankedOffers.length };
  }
  const known = rank(suppliers);
  if (known.length === 1 && known[0].score >= 0.85) return { status: 'NO_OFFER', supplier: known[0].row };
  if (known.length > 1 && known[0].score >= 0.85 && known[0].score - known[1].score < 0.08) {
    return { status: 'AMBIGUOUS_SUPPLIER', candidates: known.slice(0, candidateLimit).map(item => item.row), totalMatches: known.length };
  }
  return { status: 'NOT_FOUND', candidates: offers.slice(0, 5) };
};
const toCents = value => {
  if (!Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
};
const fromCents = value => Number((value / 100).toFixed(2));
const formatMetric = value => Number.isFinite(value) ? new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value) : '—';
const formatCoverage = value => Number.isFinite(value) ? new Intl.NumberFormat('es-PE', { style: 'percent', maximumFractionDigits: 1 }).format(value) : 'sin demanda prevista';

const selectOffer = (product, contacts, supplierRef) => {
  const byId = new Map(contacts.map(row => [String(row._id), row]));
  const offers = (product.supplierPrices || []).flatMap(row => {
    const contact = byId.get(String(row.supplierId));
    const unitCostCents = toCents(row.purchasePrice);
    if (!contact || contact.businessId !== product.businessId || contact.type !== 'vendor' || contact.isActive !== true
      || product.currency !== 'PEN' || unitCostCents === null) return [];
    return [{ supplierId: String(contact._id), supplierName: contact.name, unitCostCents,
      unitCost: fromCents(unitCostCents), preferred: String(product.preferredSupplierId || '') === String(contact._id) }];
  });
  const compare = (a, b) => normalize(a.supplierName).localeCompare(normalize(b.supplierName))
    || a.supplierId.localeCompare(b.supplierId);
  if (supplierRef) {
    const selected = offers.filter(row => row.supplierId === supplierRef || normalize(row.supplierName) === normalize(supplierRef));
    if (selected.length === 1) return { offers, selected: selected[0], selectionRule: 'USER_SPECIFIED' };
    return { offers, selected: null, selectionRule: 'USER_SPECIFIED_UNAVAILABLE' };
  }
  const preferred = offers.find(row => row.preferred);
  if (preferred) return { offers, selected: preferred, selectionRule: 'PREFERRED_SUPPLIER' };
  const selected = [...offers].sort((a, b) => a.unitCostCents - b.unitCostCents || compare(a, b))[0] || null;
  return { offers, selected, selectionRule: selected ? 'LOWEST_VALID_PRICE' : 'NO_USABLE_OFFER' };
};

const priority = { REPONER: 0, VIGILAR: 1, OK: 2 };
const sortPriority = (a, b) => priority[a.inventoryStatus] - priority[b.inventoryStatus]
  || (a.coverage === null ? 1 : b.coverage === null ? -1 : a.coverage - b.coverage)
  || b.shortage - a.shortage || b.recommendedQty - a.recommendedQty
  || a.selected.unitCostCents - b.selected.unitCostCents || String(a.sku).localeCompare(String(b.sku))
  || String(a.productId).localeCompare(String(b.productId));

const buildBudgetPlan = ({ rows, budget, limit, offset }) => {
  if (!Number.isFinite(budget) || budget <= 0) throw Object.assign(new Error('AGENT_INVALID_SKILL_ARGS'), { code: 'AGENT_INVALID_SKILL_ARGS' });
  const budgetCents = toCents(budget);
  if (!budgetCents) throw Object.assign(new Error('AGENT_INVALID_SKILL_ARGS'), { code: 'AGENT_INVALID_SKILL_ARGS' });
  const candidates = rows.filter(row => row.selected && row.mlStatus === 'READY' && row.recommendedQty > 0)
    .map(row => ({ ...row, unitCostCents: row.selected.unitCostCents,
      shortage: Math.max(row.predictedDemand7d - row.stockAtAnchor, 0),
      coverage: row.predictedDemand7d > 0 ? row.stockAtAnchor / row.predictedDemand7d : null }))
    .sort(sortPriority);
  let remaining = budgetCents;
  const items = candidates.flatMap(row => {
    const plannedQty = Math.min(row.recommendedQty, Math.floor(remaining / row.unitCostCents));
    if (plannedQty < 1) return [];
    const plannedCostCents = plannedQty * row.unitCostCents;
    remaining -= plannedCostCents;
    return [{ sku: row.sku, productName: row.name, supplierName: row.selected.supplierName,
      selectionRule: row.selectionRule, unitCost: row.selected.unitCost, currency: 'PEN',
      recommendedQty: row.recommendedQty, plannedQty, unplannedQty: row.recommendedQty - plannedQty,
      plannedCost: fromCents(plannedCostCents), predictedDemand7d: row.predictedDemand7d,
      stockAtAnchor: row.stockAtAnchor, shortage: row.shortage, inventoryStatus: row.inventoryStatus,
      reason: `${row.inventoryStatus}; cobertura ${formatCoverage(row.coverage)}; déficit ${formatMetric(row.shortage)}` }];
  });
  const spentCents = budgetCents - remaining;
  const eligible = rows.filter(row => row.mlStatus === 'READY' && Number.isSafeInteger(row.recommendedQty) && row.recommendedQty > 0);
  const excluded = rows.filter(row => row.mlStatus !== 'READY' || row.productMissing
    || (row.mlStatus === 'READY' && row.recommendedQty > 0 && !row.selected));
  const recommendedUnits = eligible.reduce((sum, row) => sum + row.recommendedQty, 0);
  const plannedUnits = items.reduce((sum, row) => sum + row.plannedQty, 0);
  return { budget: fromCents(budgetCents), spent: fromCents(spentCents), remaining: fromCents(remaining),
    consideredProducts: rows.length, costedProducts: candidates.length,
    excludedProducts: excluded.length, nonReadyProducts: rows.filter(row => row.mlStatus !== 'READY').length,
    recommendedUnits,
    plannedUnits, unplannedUnits: recommendedUnits - plannedUnits,
    exclusionsByReason: excluded.reduce((out, row) => { const reason = row.mlStatus !== 'READY' ? `FORECAST_${row.mlStatus}`
      : row.exclusionReason || 'NO_USABLE_OFFER'; out[reason] = (out[reason] || 0) + 1; return out; }, {}),
    items: items.slice(offset, offset + limit), pagination: { total: items.length, limit, offset, returnedCount: items.slice(offset, offset + limit).length,
      truncated: offset + limit < items.length } };
};

module.exports = { toCents, fromCents, selectOffer, sortPriority, buildBudgetPlan, normalizeSupplier, resolveSupplier, MAX_SUPPLIER_CANDIDATES };
