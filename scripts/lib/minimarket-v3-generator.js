'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.resolve(__dirname, '../../data/minimarket-pasco-v3');
const BUSINESS_KEY = 'MINIMARKET-PASCO-V3';
const GENERATOR_VERSION = 'minimarket-pasco-v3-generator/1.0.0';
const LOCAL_OFFSET = '-05:00';

function seedToUint32(seed, stream) {
  return crypto.createHash('sha256').update(`${seed}|${stream}`).digest().readUInt32LE(0) || 1;
}

class Random {
  constructor(seed, stream) { this.state = seedToUint32(seed, stream); }
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  pick(items) { return items[this.int(0, items.length - 1)]; }
  weighted(entries) {
    const sum = entries.reduce((total, entry) => total + Math.max(0, entry.weight), 0);
    if (!(sum > 0)) return entries[0]?.value;
    let cursor = this.next() * sum;
    for (const entry of entries) {
      cursor -= Math.max(0, entry.weight);
      if (cursor < 0) return entry.value;
    }
    return entries.at(-1)?.value;
  }
  normal() {
    const u1 = Math.max(Number.EPSILON, this.next());
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  gamma(shape, scale = 1) {
    if (shape < 1) return this.gamma(shape + 1, scale) * Math.pow(this.next(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.normal();
      const v0 = 1 + c * x;
      if (v0 <= 0) continue;
      const v = v0 * v0 * v0;
      const u = this.next();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }
  poisson(lambda) {
    if (!(lambda > 0)) return 0;
    if (lambda < 40) {
      const limit = Math.exp(-lambda);
      let product = 1;
      let count = 0;
      do { count += 1; product *= this.next(); } while (product > limit);
      return count - 1;
    }
    return Math.max(0, Math.floor(lambda + Math.sqrt(lambda) * this.normal() + 0.5));
  }
}

function readJson(file) {
  const bytes = fs.readFileSync(path.join(DATA_DIR, file));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function loadDefinitions() {
  return {
    scenario: readJson('scenario.json'),
    categories: readJson('categories.json'),
    products: readJson('products.json').catalog,
    suppliers: readJson('suppliers.json').suppliers,
    offers: readJson('supplier-offers.json'),
    customers: readJson('customers.json').customers,
    profiles: readJson('profiles.json'),
    simulation: readJson('simulation-config.json'),
    promotions: readJson('promotions.json'),
    dailyContract: readJson('forecast-daily-row-contract.json'),
    stableKeys: readJson('stable-keys.json'),
    canonicalization: readJson('canonicalization.json'),
    manifestSchema: readJson('v3-manifest.schema.json'),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function dateKey(date) { return date.toISOString().slice(0, 10); }
function dayDate(key) { return new Date(`${key}T00:00:00.000Z`); }
function addDays(key, amount) {
  const date = dayDate(key);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateKey(date);
}
function dayDifference(left, right) { return Math.round((dayDate(right) - dayDate(left)) / 86400000); }
function dateRange(start, end) {
  const result = [];
  for (let day = start; day <= end; day = addDays(day, 1)) result.push(day);
  return result;
}
function dateTimeLocal(date, time) { return new Date(`${date}T${time}${LOCAL_OFFSET}`).toISOString(); }
function isoWeekday(key) { const day = dayDate(key).getUTCDay(); return day === 0 ? 7 : day; }
function monthKey(key) { return key.slice(0, 7); }
function isMonthEnd(key) { return dayDate(addDays(key, 3)).getUTCMonth() !== dayDate(key).getUTCMonth(); }
function cents(value) { return Math.round(Number(value) * 100); }
function money(valueCents) { return valueCents / 100; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function seq(value, width = 4) { return String(value).padStart(width, '0'); }

function getCsvDayPart(date, rng, config) {
  const entry = rng.weighted(config.ticket.dayParts.map((part) => ({ value: part, weight: part.share })));
  const [startHour, startMinute] = entry.start.split(':').map(Number);
  const [endHour, endMinute] = entry.end.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const minute = rng.int(start, end - 1);
  return { key: entry.key, time: `${seq(Math.floor(minute / 60), 2)}:${seq(minute % 60, 2)}`, minute };
}

function isoYearWeek(key) {
  const date = dayDate(key);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return `${date.getUTCFullYear()}-${seq(Math.ceil((((date - yearStart) / 86400000) + 1) / 7), 2)}`;
}

function buildCalendar(definitions, rng) {
  const { scenario, simulation } = definitions;
  const days = dateRange(scenario.historyStart, scenario.historyEnd);
  const weekdayRaw = simulation.calendar.weekdayMultipliers;
  const rawByDay = (day) => {
    const weekday = isoWeekday(day);
    return weekday <= 4 ? weekdayRaw.mondayToThursday : weekday === 5 ? weekdayRaw.friday : weekday === 6 ? weekdayRaw.saturday : weekdayRaw.sunday;
  };
  const weekdayMean = days.reduce((sum, day) => sum + rawByDay(day), 0) / days.length;
  const holidays = new Set(simulation.calendar.holidays);
  const pulseStarts = [];
  while (pulseStarts.length < simulation.calendar.specialSyntheticPulses.count) {
    const candidate = days[rng.int(20, days.length - 20)];
    if (pulseStarts.every((date) => Math.abs(dayDifference(date, candidate)) > 20)) pulseStarts.push(candidate);
  }
  pulseStarts.sort();
  const pulses = pulseStarts.map((start, index) => ({
    pulseCode: `V3-PULSE-${seq(index + 1, 2)}`,
    startDate: start,
    endDate: addDays(start, simulation.calendar.specialSyntheticPulses.durationDays - 1),
    announcedAt: addDays(start, -14),
    multiplier: Number((1 + rng.next() * (simulation.calendar.specialSyntheticPulses.maxMultiplier - 1)).toFixed(4)),
  }));
  return days.map((day) => {
    const weekday = isoWeekday(day);
    const holiday = holidays.has(day);
    const pulse = pulses.find((item) => day >= item.startDate && day <= item.endDate);
    const weekdayFactor = rawByDay(day) / weekdayMean;
    const payday = Number(day.slice(-2)) >= simulation.calendar.payday.days[0] && Number(day.slice(-2)) <= simulation.calendar.payday.days[2];
    const monthEnd = isMonthEnd(day) && !(payday && simulation.calendar.monthEnd.skipWhenOverlapsPayday);
    const factors = {
      arrivalsMultiplier: weekdayFactor
        * (payday ? simulation.calendar.payday.arrivalMultiplier : 1)
        * (monthEnd ? simulation.calendar.monthEnd.arrivalMultiplier : 1)
        * (holiday ? simulation.calendar.holiday.arrivalMultiplier : 1)
        * (pulse ? pulse.multiplier : 1),
      weekdayIso: weekday,
      weekend: weekday >= 6,
      payday,
      monthEnd,
      holiday,
      holidayCode: holiday ? `PE-${day}` : null,
      pulseCode: pulse?.pulseCode ?? null,
      pulseKnownAtOrigin: pulse ? pulse.announcedAt <= addDays(day, -1) : false,
      pulseMultiplier: pulse?.multiplier ?? 1,
      weekKey: isoYearWeek(day),
      month: Number(day.slice(5, 7)),
      historyProgress: days.length > 1 ? dayDifference(scenario.historyStart, day) / (days.length - 1) : 0,
    };
    return { date: day, ...factors };
  });
}

function buildPriceAndCostHistories(definitions, streams, calendarDays) {
  const { products, suppliers, offers } = definitions;
  const byProductPrice = new Map();
  const basePrice = new Map();
  for (const product of products) {
    const rng = streams.price;
    let price = cents(product.salePriceDemo);
    basePrice.set(product.sku, price);
    const count = rng.weighted([{ value: 0, weight: 0.62 }, { value: 1, weight: 0.34 }, { value: 2, weight: 0.04 }]);
    const points = [];
    const chosen = new Set();
    while (chosen.size < count) chosen.add(rng.int(50, 330));
    for (const offset of [...chosen].sort((a, b) => a - b)) {
      const effectiveFrom = calendarDays[offset].date;
      const announcedAt = addDays(effectiveFrom, -7);
      const pct = Number((rng.next() * 5).toFixed(3));
      const nextPrice = Math.max(price + 1, Math.round(price * (1 + pct / 100)));
      points.push({ sku: product.sku, productKey: product.productKey, effectiveFrom, announcedAt, priorPriceCents: price, priceCents: nextPrice, currency: 'PEN', simulationAssumption: true });
      price = nextPrice;
    }
    byProductPrice.set(product.sku, points);
  }

  const productBySku = new Map(products.map((product) => [product.sku, product]));
  const supplierByCode = new Map(suppliers.map((supplier) => [supplier.supplierCode, supplier]));
  const offerPrice = new Map();
  for (const product of products) offerPrice.set(`${product.sku}|${product.preferredSupplierCode}`, cents(product.purchaseCostDemo));
  for (const assignment of offers.secondaryAssignments) {
    const product = productBySku.get(assignment.sku);
    offerPrice.set(`${assignment.sku}|${assignment.supplierCode}`, Math.round(cents(product.purchaseCostDemo) * assignment.priceFactor));
  }

  const costRows = [];
  const costEvents = new Map();
  for (const [key, startingPrice] of offerPrice) {
    const rng = streams.cost;
    const count = rng.weighted([{ value: 0, weight: 0.72 }, { value: 1, weight: 0.24 }, { value: 2, weight: 0.04 }]);
    const dates = new Set();
    while (dates.size < count) dates.add(rng.int(60, 325));
    const sku = key.split('|')[0];
    const supplierCode = key.split('|')[1];
    const product = productBySku.get(sku);
    const events = [];
    let current = startingPrice;
    for (const offset of [...dates].sort((a, b) => a - b)) {
      const effectiveFrom = calendarDays[offset].date;
      const announcedAt = addDays(effectiveFrom, -7);
      const pct = Number((rng.next() * 4).toFixed(3));
      let next = Math.max(current, Math.round(current * (1 + pct / 100)));
      const maxPermitted = Math.floor(basePrice.get(sku) * 0.94);
      next = Math.min(next, maxPermitted);
      if (next <= current || next >= basePrice.get(sku)) continue;
      events.push({ sku, productKey: product.productKey, supplierCode, effectiveFrom, announcedAt, priorCostCents: current, purchaseCostCents: next, currency: 'PEN', simulationAssumption: true });
      current = next;
    }
    costEvents.set(key, events);
    costRows.push(...events);
  }
  return {
    priceHistories: byProductPrice,
    basePrice,
    costEvents,
    costRows: costRows.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.sku.localeCompare(b.sku) || a.supplierCode.localeCompare(b.supplierCode)),
    offerPrice,
    supplierByCode,
    priceRows: [...byProductPrice.values()].flat().sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.sku.localeCompare(b.sku)),
  };
}

function currentPriceAt(sku, date, histories, basePrice) {
  const event = [...(histories.get(sku) ?? [])].reverse().find((row) => row.effectiveFrom <= date);
  return event ? event.priceCents : basePrice.get(sku);
}

function currentCostAt(sku, supplierCode, date, histories, offerPrice) {
  const base = offerPrice.get(`${sku}|${supplierCode}`);
  const event = [...(histories.get(`${sku}|${supplierCode}`) ?? [])].reverse().find((row) => row.effectiveFrom <= date);
  return event ? event.purchaseCostCents : base;
}

function schedulePromotions(definitions, streams, calendarDays, prices, costs) {
  const { products, promotions, simulation } = definitions;
  const bySku = new Map(products.map((product) => [product.sku, []]));
  const episodes = [];
  const occupied = new Map(products.map((product) => [product.sku, new Set()]));
  const templateByKey = new Map(promotions.templates.map((template) => [template.key, template]));
  const episodeCountsByMonth = new Map();
  const productBySku = new Map(products.map((product) => [product.sku, product]));
  const monthStarts = [...new Set(calendarDays.map((day) => monthKey(day.date)))];
  let promoSequence = 0;
  for (const month of monthStarts) {
    for (let index = 0; index < 10; index += 1) {
      const monthDays = calendarDays.filter((day) => monthKey(day.date) === month);
      const weekendTemplate = templateByKey.get('WEEKEND_BEVERAGES');
      const snackTemplate = templateByKey.get('SNACK_COMBO');
      const monthlyTemplate = templateByKey.get('MONTHLY_SELECTED_PRODUCTS');
      const template = streams.promotion.weighted([
        { value: weekendTemplate, weight: 0.38 },
        { value: snackTemplate, weight: 0.34 },
        { value: monthlyTemplate, weight: 0.28 },
      ]);
      const duration = streams.promotion.int(simulation.promotions.episodeDurationDays[0], simulation.promotions.episodeDurationDays[1]);
      let startDate = monthDays[streams.promotion.int(0, monthDays.length - 1)].date;
      if (month === '2026-10' && index === 0) startDate = '2026-10-07';
      const categorySet = new Set(template.categoryCodes);
      const candidates = products.filter((product) => categorySet.has(product.categoryCode)
        && !product.perishable
        && product.salePriceDemo > product.purchaseCostDemo * 1.2);
      const skuCount = streams.promotion.int(simulation.promotions.skuCountPerEpisode[0], simulation.promotions.skuCountPerEpisode[1]);
      const selected = [];
      const pool = [...candidates];
      while (selected.length < skuCount && pool.length > 0) {
        const product = pool.splice(streams.promotion.int(0, pool.length - 1), 1)[0];
        const days = dateRange(startDate, addDays(startDate, duration - 1));
        const clear = days.every((date) => date > definitions.scenario.historyEnd || !occupied.get(product.sku).has(date));
        if (clear) selected.push(product);
      }
      if (!selected.length) continue;
      promoSequence += 1;
      const requestedDiscount = streams.promotion.int(simulation.promotions.discountPct[0], simulation.promotions.discountPct[1]);
      const effectiveEnd = startDate <= definitions.scenario.historyEnd
        ? (addDays(startDate, duration - 1) > definitions.scenario.historyEnd ? definitions.scenario.historyEnd : addDays(startDate, duration - 1))
        : definitions.scenario.historyEnd;
      const promo = {
        promotionCode: `V3-PROMO-${month.replace('-', '')}-${seq(promoSequence, 4)}`,
        templateKey: template.key,
        displayName: template.displayName,
        startDate,
        endDate: effectiveEnd,
        announcedAt: addDays(startDate, -5),
        skus: selected.map((product) => product.sku).sort(),
        discountPct: requestedDiscount,
        syntheticUplift: Number((1.1 + streams.promotion.next() * 0.25).toFixed(4)),
        status: startDate > definitions.scenario.historyEnd ? 'scheduled_outside_history' : 'generated',
        simulationAssumption: true,
      };
      episodes.push(promo);
      for (const product of selected) {
        const itemDays = dateRange(startDate, effectiveEnd);
        for (const date of itemDays) {
          const price = currentPriceAt(product.sku, date, prices.priceHistories, prices.basePrice);
          const maxCost = Math.max(...[...prices.supplierByCode.keys()].map((supplierCode) => currentCostAt(product.sku, supplierCode, date, prices.costEvents, prices.offerPrice)).filter(Number.isFinite));
          const maxDiscount = Math.floor((1 - maxCost / price) * 100);
          if (maxDiscount < 1) continue;
          const discountPct = Math.min(requestedDiscount, maxDiscount);
          const effectivePrice = Math.floor(price * (100 - discountPct) / 100);
          if (effectivePrice <= maxCost) continue;
          const row = { promotionCode: promo.promotionCode, sku: product.sku, date, discountPct, effectivePriceCents: effectivePrice, uplift: promo.syntheticUplift, announcedAt: promo.announcedAt };
          bySku.get(product.sku).push(row);
          occupied.get(product.sku).add(date);
        }
      }
    }
  }
  return {
    episodes: episodes.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.promotionCode.localeCompare(b.promotionCode)),
    bySku,
    productDays: [...bySku.values()].reduce((sum, rows) => sum + rows.length, 0),
  };
}

function buildAssociations(profiles) {
  return (profiles.associationProfiles ?? []).flatMap((profile) => (profile.rules ?? []).map((rule) => ({ ...rule, profileKey: profile.key })));
}

function getSeasonality(product, profile, date) {
  const month = Number(date.slice(5, 7));
  let multiplier = profile.seasonality?.default ?? 1;
  if (profile.seasonality?.summerWaterMultiplier && product.subcategoryCode === 'BEB-AGUAS' && [12, 1, 2, 3].includes(month)) multiplier *= profile.seasonality.summerWaterMultiplier;
  if (profile.seasonality?.decemberBeverageSnackMultiplier && month === 12 && ['BEB', 'SNA', 'GAL'].includes(product.categoryCode)) multiplier *= profile.seasonality.decemberBeverageSnackMultiplier;
  if (profile.seasonality?.coldBreakfastMayAugMultiplier && ['DES', 'PAN'].includes(product.categoryCode) && [5, 6, 7, 8].includes(month)) multiplier *= profile.seasonality.coldBreakfastMayAugMultiplier;
  return multiplier;
}

function categoryMissionWeights(mission, dayPart, calendar, customerProfile, customerPrefs) {
  const base = {
    breakfast: { DES: 3.5, PAN: 2.4, GAL: 1.2, BEB: 1.0, ABA: 0.5, CON: 0.2, SNA: 0.4, LIM: 0.1, CUI: 0.1, REG: 0.2 },
    groceries: { ABA: 3.5, DES: 1.4, CON: 1.3, BEB: 1.0, LIM: 1.0, CUI: 0.7, PAN: 0.4, GAL: 0.4, SNA: 0.3, REG: 0.5 },
    snack: { SNA: 3.0, GAL: 2.5, BEB: 2.5, DES: 0.4, ABA: 0.4, CON: 0.2, PAN: 0.5, LIM: 0.1, CUI: 0.1, REG: 0.3 },
    household: { LIM: 3.0, CUI: 2.5, ABA: 1.2, DES: 0.5, BEB: 0.3, CON: 0.2, PAN: 0.1, GAL: 0.1, SNA: 0.1, REG: 0.2 },
    regional: { REG: 4.0, ABA: 1.4, DES: 0.3, BEB: 0.2, CON: 0.2, PAN: 0.1, GAL: 0.1, SNA: 0.1, LIM: 0.1, CUI: 0.1 },
  }[mission] ?? {};
  const weights = { ...base };
  if (dayPart === 'morning' && mission === 'breakfast') weights.DES *= 1.15;
  if (dayPart === 'evening' && mission === 'snack') weights.SNA *= 1.1;
  if (calendar?.holiday) for (const category of ['BEB', 'SNA', 'GAL']) weights[category] *= 1.08;
  if (calendar?.monthEnd && mission === 'household') for (const category of ['LIM', 'CUI', 'ABA']) weights[category] *= 1.08;
  for (const [category, preference] of Object.entries(customerProfile?.categoryPreferences ?? {})) weights[category] = (weights[category] ?? 0.1) * preference;
  for (const [category, preference] of Object.entries(customerPrefs ?? {})) weights[category] = (weights[category] ?? 0.1) * preference;
  return weights;
}

function assignCustomer(day, customerRng, customers, customerProfileByKey, customerState, recentTicketCounts) {
  if (customerRng.next() < 0.8) return { customer: null, profile: null };
  const eligible = customers.filter((customer) => {
    const state = customerState.get(customer.customerCode);
    if (customer.registrationDate > day || !state.enabled || (state.endDate && day > state.endDate)) return false;
    if (state.firstTicketDate && day < state.firstTicketDate) return false;
    if (state.firstTicketDate && !state.firstTicketComplete) return day >= state.firstTicketDate;
    const last = state.lastTicketDate;
    if (!last) return true;
    const interval = dayDifference(last, day);
    const range = customerProfileByKey.get(customer.customerProfileKey)?.shoppingFrequencyDays ?? [1, 30];
    return interval >= Math.max(1, Math.floor(range[0] * 0.55));
  });
  if (!eligible.length) return { customer: null, profile: null };
  const customer = customerRng.weighted(eligible.map((item) => {
    const profile = customerProfileByKey.get(item.customerProfileKey);
    const state = customerState.get(item.customerCode);
    const range = profile?.shoppingFrequencyDays ?? [1, 20];
    const elapsed = state.lastTicketDate ? dayDifference(state.lastTicketDate, day) : 30;
    const intervalBoost = clamp(elapsed / Math.max(1, range[1]), 0.55, 2.5);
    const firstPurchaseBoost = state.firstTicketDate && !state.firstTicketComplete ? 2.8 : 1;
    const recentCountPenalty = 1 / (1 + (recentTicketCounts.get(item.customerCode) ?? 0) * 0.01);
    return { value: item, weight: (profile?.registeredPurchaseSelectionWeight ?? 1) * intervalBoost * firstPurchaseBoost * recentCountPenalty };
  }));
  return { customer, profile: customerProfileByKey.get(customer.customerProfileKey) };
}

function buildCustomerState(customers, simulation, rng) {
  const recentCutoff = addDays(simulation.referenceDate, -29);
  const inactiveCutoff = '2026-07-14';
  const atRiskEndMax = addDays(simulation.referenceDate, -31);
  const atRiskEndMin = addDays(simulation.referenceDate, -60);
  const state = new Map();
  for (const customer of customers) {
    let endDate = null;
    let firstTicketDate = null;
    let enabled = true;
    if (customer.customerProfileKey === 'INACTIVE') {
      endDate = addDays(inactiveCutoff, -rng.int(0, 45));
      firstTicketDate = addDays(customer.registrationDate, rng.int(1, 45));
    } else if (customer.customerProfileKey === 'AT_RISK') {
      endDate = addDays(atRiskEndMax, -rng.int(0, dayDifference(atRiskEndMin, atRiskEndMax)));
      firstTicketDate = addDays(customer.registrationDate, rng.int(1, 20));
    } else if (customer.customerProfileKey === 'RECENT') {
      firstTicketDate = customer.registrationDate;
      if (firstTicketDate < recentCutoff) firstTicketDate = recentCutoff;
    } else if (customer.customerProfileKey === 'OCCASIONAL') {
      firstTicketDate = addDays(customer.registrationDate, rng.int(1, 45));
    } else {
      firstTicketDate = addDays(customer.registrationDate, rng.int(1, 10));
    }
    if (firstTicketDate < simulation.historyStart) firstTicketDate = simulation.historyStart;
    state.set(customer.customerCode, { enabled, endDate, firstTicketDate, firstTicketComplete: false, lastTicketDate: null });
  }
  return state;
}

function chooseItemCount(rng, customerProfile, mission) {
  let min = 1;
  let max = 8;
  if (customerProfile?.ticketLines) [min, max] = customerProfile.ticketLines;
  else if (mission === 'breakfast') [min, max] = [1, 5];
  else if (mission === 'groceries') [min, max] = [2, 7];
  else if (mission === 'snack') [min, max] = [1, 4];
  else if (mission === 'household') [min, max] = [2, 7];
  else [min, max] = [1, 4];
  const weights = [0.12, 0.22, 0.28, 0.19, 0.11, 0.05, 0.02, 0.01];
  const possible = [];
  for (let count = min; count <= max; count += 1) possible.push({ value: count, weight: weights[count - 1] ?? 0.01 });
  return rng.weighted(possible);
}

function matchesAssociation(product, rule, source = false) {
  const category = source ? rule.sourceCategoryCode : null;
  if (category && product.categoryCode !== category) return false;
  const subcodes = source ? rule.sourceSubcategoryCodes : rule.targetSubcategoryCodes;
  const catcodes = source ? null : rule.targetCategoryCodes;
  if (subcodes?.length && !subcodes.includes(product.subcategoryCode)) return false;
  if (catcodes?.length && !catcodes.includes(product.categoryCode)) return false;
  return Boolean(category || subcodes?.length || catcodes?.length);
}

function selectBasketProducts({ rng, itemCount, mission, dayPart, date, customerProfile, customerPrefs, products, productProfiles, calendar, promoBySkuDate, prices, associationRules }) {
  const chosen = [];
  const categoryWeights = categoryMissionWeights(mission, dayPart, calendar, customerProfile, customerPrefs);
  const priceMap = new Map();
  for (const product of products) {
    const price = currentPriceAt(product.sku, date, prices.priceHistories, prices.basePrice);
    const promo = promoBySkuDate.get(`${product.sku}|${date}`);
    priceMap.set(product.sku, { price, promo });
  }
  for (let position = 0; position < itemCount; position += 1) {
    const remaining = products.filter((product) => !chosen.some((item) => item.product.sku === product.sku));
    const entries = remaining.map((product) => {
      const profile = productProfiles.get(product.demandProfileKey);
      const adjustedCategoryWeight = categoryWeights[product.categoryCode] ?? 0.12;
      const weekly = profile?.weekdayMultipliers?.[String(calendar.weekdayIso)] ?? 1;
      const weekend = calendar.weekend ? (profile?.weekendMultiplier ?? 1) : 1;
      const seasonality = getSeasonality(product, profile ?? {}, date);
      const promo = priceMap.get(product.sku).promo;
      const current = priceMap.get(product.sku).price;
      const elasticity = productProfiles.get(`elasticity:${product.sku}`) ?? -0.7;
      const trend = productProfiles.get(`trend:${product.sku}`) ?? 1;
      const popularity = productProfiles.get(`popularity:${product.sku}`) ?? 1;
      const trendFactor = 1 + (trend - 1) * (calendar.historyProgress ?? 1);
      const relativePrice = current / prices.basePrice.get(product.sku);
      const base = Math.max(0.001, product.baseUnitsPerDay * (profile?.baseDemandMultiplier ?? 1));
      let associationFactor = 1;
      if (position > 0 && chosen.length) {
        for (const sourceItem of chosen) {
          const rules = associationRules.filter((rule) => matchesAssociation(sourceItem.product, rule, true) && matchesAssociation(product, rule, false));
          for (const rule of rules) {
            if (rng.next() < rule.probabilityUplift) associationFactor *= 1.15;
          }
        }
      }
      const weight = base * popularity * adjustedCategoryWeight * weekly * weekend * seasonality * (promo?.uplift ?? 1)
        * Math.pow(relativePrice, elasticity) * trendFactor * associationFactor;
      return { value: product, weight };
    });
    const chosenProduct = rng.weighted(entries);
    if (!chosenProduct) break;
    let qtyWeights = [{ value: 1, weight: 0.7 }, { value: 2, weight: 0.18 }, { value: 3, weight: 0.08 }, { value: 4, weight: 0.04 }];
    if (customerProfile?.quantityBias) qtyWeights = qtyWeights.map((item) => ({ ...item, weight: item.value === 1 ? item.weight * 0.75 : item.weight * Math.pow(customerProfile.quantityBias, item.value - 1) }));
    const quantity = rng.weighted(qtyWeights);
    const { price, promo } = priceMap.get(chosenProduct.sku);
    chosen.push({ product: chosenProduct, quantity, basePriceCents: price, promotion: promo ?? null });
  }
  return chosen;
}

function drawMission(rng, config, calendar, dayPart) {
  const dayPartBoost = {
    morning: { breakfast: 1.25, groceries: 0.95, snack: 0.55, household: 0.8, regional: 1 },
    midday: { breakfast: 0.8, groceries: 1.05, snack: 1, household: 1, regional: 1 },
    afternoon: { breakfast: 0.5, groceries: 0.9, snack: 1.2, household: 1, regional: 1 },
    evening: { breakfast: 0.3, groceries: 0.85, snack: 1.35, household: 1.05, regional: 1 },
  }[dayPart];
  return rng.weighted(config.missions.map((entry) => ({ value: entry.key, weight: entry.share * (dayPartBoost[entry.key] ?? 1) })));
}

function ceilToMultiple(quantity, multiple) { return Math.ceil(quantity / multiple) * multiple; }

function chooseSupplier(product, date, definitions, prices, rng) {
  const candidates = [{ supplierCode: product.preferredSupplierCode, priceCents: currentCostAt(product.sku, product.preferredSupplierCode, date, prices.costEvents, prices.offerPrice), preferred: true }];
  for (const assignment of definitions.offers.secondaryAssignments) {
    if (assignment.sku === product.sku) candidates.push({ supplierCode: assignment.supplierCode, priceCents: currentCostAt(product.sku, assignment.supplierCode, date, prices.costEvents, prices.offerPrice), preferred: false });
  }
  const preferred = candidates.find((offer) => offer.preferred);
  const cheaper = candidates.filter((offer) => !offer.preferred && offer.priceCents < preferred.priceCents * 0.98);
  if (cheaper.length && rng.next() < 0.32) return cheaper.sort((a, b) => a.priceCents - b.priceCents || a.supplierCode.localeCompare(b.supplierCode))[0];
  return preferred;
}

function sampleLeadDays(supplier, rng) {
  const sample = Math.round(supplier.leadTimeMeanDays + supplier.leadTimeStdDays * rng.normal());
  return clamp(sample, 1, supplier.leadTimeMaxDays);
}

function choosePreferredQuantityAndSupplier(product, date, productState, outstandingQty, recentSales, definitions, prices, rng) {
  const offer = chooseSupplier(product, date, definitions, prices, rng);
  const supplier = prices.supplierByCode.get(offer.supplierCode);
  const leadDays = sampleLeadDays(supplier, rng);
  const expectedDaily = recentSales.length >= 28 ? recentSales.slice(-28).reduce((a, b) => a + b, 0) / 28 : product.baseUnitsPerDay;
  const reviewDays = product.perishable ? rng.int(...definitions.simulation.inventory.reviewDaysPerishable) : definitions.simulation.inventory.reviewDaysNonPerishable;
  const inventoryPosition = productState.stock + outstandingQty;
  const target = Math.ceil(expectedDaily * (leadDays + reviewDays)) + product.safetyStockInitial;
  let orderQty = Math.max(0, target - inventoryPosition);
  const packMultiple = definitions.offers.packMultipleBySupplier[`${offer.supplierCode}:${product.sku}`]
    ?? definitions.offers.packMultipleBySupplier[offer.supplierCode] ?? 1;
  if (product.perishable && product.shelfLifeDays) {
    const shelfCap = Math.ceil(expectedDaily * product.shelfLifeDays);
    if (ceilToMultiple(Math.max(orderQty, 1), packMultiple) > shelfCap) {
      if (shelfCap < packMultiple) orderQty = 0;
      else orderQty = Math.min(orderQty, shelfCap);
    }
  }
  if (orderQty > 0) orderQty = ceilToMultiple(orderQty, packMultiple);
  return { ...offer, supplier, leadDays, reviewDays, inventoryPosition, target, orderQty, packMultiple, expectedDaily };
}

function getWriter(outputDir) {
  const fds = new Map();
  const hashes = new Map();
  const counts = new Map();
  function write(file, record) {
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, 'utf8');
    let fd = fds.get(file);
    if (fd == null) {
      fd = fs.openSync(path.join(outputDir, file), 'w');
      fds.set(file, fd);
      hashes.set(file, crypto.createHash('sha256'));
      counts.set(file, 0);
    }
    fs.writeSync(fd, bytes);
    hashes.get(file).update(bytes);
    counts.set(file, counts.get(file) + 1);
  }
  function close() { for (const fd of fds.values()) fs.closeSync(fd); }
  function digest() { close(); return Object.fromEntries([...hashes.entries()].sort().map(([file, hash]) => [file, hash.digest('hex')])); }
  return { write, close, digest, counts };
}

function makeStreams(seed) {
  return Object.fromEntries(['calendar', 'price', 'cost', 'promotion', 'demand', 'basket', 'customer', 'status', 'quantity', 'supplier', 'delay', 'misc'].map((key) => [key, new Random(seed, key)]));
}

function selectControlledIncidents(definitions, rng) {
  const count = rng.int(...definitions.simulation.inventory.controlledIncidentSkuCount);
  const candidates = [...definitions.products].filter((product) => !product.perishable)
    .sort((a, b) => b.baseUnitsPerDay - a.baseUnitsPerDay || a.sku.localeCompare(b.sku)).slice(0, 36);
  const groups = new Map();
  for (const product of candidates) {
    const rows = groups.get(product.categoryCode) ?? [];
    rows.push(product);
    groups.set(product.categoryCode, rows);
  }
  const pool = [...groups.values()].flatMap((rows) => rows.slice(0, 2));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const target = rng.int(0, index);
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  const startDays = dateRange(definitions.scenario.historyStart, definitions.scenario.historyEnd);
  return new Map(pool.slice(0, count).sort((a, b) => a.sku.localeCompare(b.sku)).map((product, index) => [product.sku, {
    sku: product.sku,
    incidentStartDate: startDays[100 + index * 22],
    extraDelayDays: rng.int(...definitions.simulation.inventory.controlledIncidentDurationDays),
    applied: false,
    purchaseCode: null,
    supplierCode: null,
    orderedAtDate: null,
    promisedAtDate: null,
    receivedAtDate: null,
    actualDelayDays: null,
  }]));
}

function makeProductProfiles(definitions, streams) {
  const profiles = new Map(definitions.profiles.demandProfiles.map((profile) => [profile.key, profile]));
  for (const product of definitions.products) {
    profiles.set(`popularity:${product.sku}`, 0.8 + streams.demand.next() * 0.4);
    profiles.set(`elasticity:${product.sku}`, -1.2 + streams.demand.next() * 0.9);
    profiles.set(`trend:${product.sku}`, 0.85 + streams.demand.next() * 0.3);
    const profile = profiles.get(product.demandProfileKey);
    if (profile?.seasonality?.coldBreakfastMayAugMultiplier && ['DES', 'PAN'].includes(product.categoryCode)) {
      profiles.set(`coldBreakfastOverride:${product.sku}`, 1.15);
    }
  }
  return profiles;
}

function computeAnalytics(summary) {
  const topProducts = [...summary.productUnits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([sku, units]) => ({ sku, units }));
  const topCategories = [...summary.categoryUnits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([categoryCode, units]) => ({ categoryCode, units }));
  const monthlySales = [...summary.monthlySales.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, totals]) => ({ month, ...totals }));
  const weekdaySales = [...summary.weekdaySales.entries()].sort(([a], [b]) => a - b).map(([weekdayIso, totals]) => ({ weekdayIso: Number(weekdayIso), ...totals }));
  const topCustomers = [...summary.customers.entries()].map(([customerCode, data]) => ({ customerCode, ...data }))
    .sort((a, b) => b.netRevenueCents - a.netRevenueCents || a.customerCode.localeCompare(b.customerCode)).slice(0, 10);
  const topSuppliers = [...summary.supplierPurchases.entries()].map(([supplierCode, data]) => {
    const { leadDaysTotal, minLeadDays, maxLeadDays, ...metrics } = data;
    return {
      supplierCode,
      ...metrics,
      averageLeadDays: data.receivedOrders ? Number((leadDaysTotal / data.receivedOrders).toFixed(3)) : null,
      minLeadDays: minLeadDays ?? null,
      maxLeadDays: maxLeadDays ?? null,
      onTimeRatePct: data.receivedOrders ? Number(((data.receivedOrders - data.delayedOrders) * 100 / data.receivedOrders).toFixed(2)) : null,
    };
  })
    .sort((a, b) => b.purchaseValueCents - a.purchaseValueCents || a.supplierCode.localeCompare(b.supplierCode));
  return { topProducts, topCategories, monthlySales, weekdaySales, topCustomers, topSuppliers };
}

function generateDataset({ outputDir, seed = 2026, definitions = loadDefinitions() }) {
  if (!outputDir) throw new Error('outputDir es obligatorio');
  const resolvedOutput = path.resolve(outputDir);
  if (fs.existsSync(resolvedOutput)) throw new Error(`El directorio de salida ya existe; el generador no lo sobrescribe: ${resolvedOutput}`);
  fs.mkdirSync(resolvedOutput, { recursive: true });
  const streams = makeStreams(seed);
  const calendar = buildCalendar(definitions, streams.calendar);
  const prices = buildPriceAndCostHistories(definitions, streams, calendar);
  const promotions = schedulePromotions(definitions, streams, calendar, prices, prices.costEvents);
  const promoBySkuDate = new Map();
  for (const [sku, rows] of promotions.bySku) for (const row of rows) promoBySkuDate.set(`${sku}|${row.date}`, row);
  const productProfiles = makeProductProfiles(definitions, streams);
  const associations = buildAssociations(definitions.profiles);
  const controlledIncidents = selectControlledIncidents(definitions, streams.misc);
  const customerProfileByKey = new Map(definitions.profiles.customerProfiles.map((profile) => [profile.key, profile]));
  const customerState = buildCustomerState(definitions.customers, definitions.simulation, streams.customer);
  const recentTicketCounts = new Map(definitions.customers.map((customer) => [customer.customerCode, 0]));
  const customerPreferences = new Map(definitions.customers.map((customer) => {
    const categories = definitions.categories.categories.map((category) => category.code);
    const shuffled = [...categories].sort(() => streams.customer.next() - 0.5);
    return [customer.customerCode, Object.fromEntries(shuffled.slice(0, 2).map((code) => [code, Number((1.3 + streams.customer.next() * 0.6).toFixed(3))]))];
  }));
  const productBySku = new Map(definitions.products.map((product) => [product.sku, product]));
  const supplierByCode = new Map(definitions.suppliers.map((supplier) => [supplier.supplierCode, supplier]));
  const productState = new Map();
  const recentSales = new Map(definitions.products.map((product) => [product.sku, []]));
  const outstanding = new Map(definitions.products.map((product) => [product.sku, []]));
  const inventoryHistory = new Map(definitions.products.map((product) => [product.sku, []]));
  const movementSequence = { value: 0 };
  const purchaseSequenceByDay = new Map();
  const saleSequenceByDay = new Map();
  const writer = getWriter(resolvedOutput);
  let dailyStatsForMovement = null;
  const summary = {
    arrivedTickets: 0, completedSales: 0, saleItems: 0, cancelledSales: 0, pendingSales: 0, purchases: 0, purchaseItems: 0,
    receivedPurchaseValueCents: 0, revenueCents: 0, cogsCents: 0, unitsSold: 0, lostDemand: 0,
    movements: 0, stockoutProductDays: 0, productDays: 0, promoProductDays: promotions.productDays,
    guestTickets: 0, registeredTickets: 0, productUnits: new Map(), categoryUnits: new Map(), monthlySales: new Map(), weekdaySales: new Map(),
    customers: new Map(definitions.customers.map((customer) => [customer.customerCode, { tickets: 0, netRevenueCents: 0, units: 0, firstDate: null, lastDate: null }])),
    supplierPurchases: new Map(definitions.suppliers.map((supplier) => [supplier.supplierCode, { orders: 0, receivedOrders: 0, purchaseValueCents: 0, units: 0, delayedOrders: 0, leadDaysTotal: 0, minLeadDays: null, maxLeadDays: null }])),
    monthlyPromoVsRegular: { promoUnits: 0, promoProductDays: 0, regularUnits: 0, regularProductDays: 0 },
    pairCounts: new Map(),
  };

  for (const product of definitions.products) {
    const calculated = Math.ceil(product.baseUnitsPerDay * (product.leadTimeDays + 7)) + product.safetyStockInitial;
    const openingStock = product.perishable && product.shelfLifeDays
      ? Math.min(calculated, Math.ceil(product.baseUnitsPerDay * product.shelfLifeDays) + product.safetyStockInitial)
      : calculated;
    productState.set(product.sku, { stock: openingStock, valueCents: openingStock * cents(product.purchaseCostDemo), averageCostCents: cents(product.purchaseCostDemo), initialStock: openingStock, expiredUnits: 0 });
    inventoryHistory.get(product.sku).push({ date: definitions.scenario.historyStart, openingStock, endingStock: null });
    const lotExpiry = product.perishable && product.shelfLifeDays ? addDays(definitions.scenario.historyStart, product.shelfLifeDays) : null;
    productState.get(product.sku).lots = [{ lotCode: `V3-LOT-${product.sku}-OPEN`, qty: openingStock, unitCostCents: cents(product.purchaseCostDemo), receivedAt: dateTimeLocal(definitions.scenario.historyStart, '06:30'), expiryDate: lotExpiry }];
  }

  function writeMovement(sku, type, qtyDelta, day, time, transactionCode, reason, costCents, eventPriority = 0, valueDeltaOverride = null) {
    const state = productState.get(sku);
    const before = state.stock;
    if (!Number.isInteger(qtyDelta)) throw new Error(`Movimiento con cantidad inválida ${sku} ${day}: ${qtyDelta}`);
    const after = before + qtyDelta;
    if (after < 0) throw new Error(`Stock negativo ${sku} ${day}: ${before} + ${qtyDelta}`);
    const stats = dailyStatsForMovement?.get(sku);
    if (stats) {
      const [hours, minutes] = time.split(':').map(Number);
      const eventMinute = clamp(hours * 60 + minutes, 390, 1290);
      if (before > 0) stats.availableMinutes += Math.max(0, eventMinute - stats.minuteMarker);
      if ((before === 0) !== (after === 0) || before > 0) stats.minuteMarker = eventMinute;
    }
    state.stock = after;
    movementSequence.value += 1;
    const movementCode = `V3-MOV-${day.replaceAll('-', '')}-${seq(movementSequence.value, 7)}`;
    writer.write('inventory-movements.ndjson', {
      movementCode,
      sourceEventId: `${definitions.scenario.datasetVersion}|inventory-movement|${movementCode}|1`,
      scenarioId: definitions.scenario.scenarioId,
      businessKey: BUSINESS_KEY,
      sku,
      productKey: productBySku.get(sku).productKey,
      transactionCode: transactionCode ?? null,
      type,
      reason: reason ?? null,
      quantityDelta: qtyDelta,
      stockBefore: before,
      stockAfter: after,
      unitCostCents: costCents ?? state.averageCostCents,
      valueDeltaCents: valueDeltaOverride ?? qtyDelta * (costCents ?? state.averageCostCents),
      currency: 'PEN',
      occurredAt: dateTimeLocal(day, time),
      localDate: day,
      eventPriority,
    });
    summary.movements += 1;
  }

  for (const product of definitions.products) {
    const state = productState.get(product.sku);
    movementSequence.value += 1;
    const movementCode = `V3-MOV-${definitions.scenario.historyStart.replaceAll('-', '')}-${seq(movementSequence.value, 7)}`;
    writer.write('inventory-movements.ndjson', {
      movementCode,
      sourceEventId: `${definitions.scenario.datasetVersion}|inventory-movement|${movementCode}|1`,
      scenarioId: definitions.scenario.scenarioId,
      businessKey: BUSINESS_KEY,
      sku: product.sku,
      productKey: product.productKey,
      transactionCode: null,
      type: 'opening',
      reason: 'scenario_opening_balance',
      quantityDelta: state.stock,
      stockBefore: 0,
      stockAfter: state.stock,
      unitCostCents: state.averageCostCents,
      valueDeltaCents: state.stock * state.averageCostCents,
      currency: 'PEN',
      occurredAt: dateTimeLocal(definitions.scenario.historyStart, '06:00'),
      localDate: definitions.scenario.historyStart,
      eventPriority: 0,
    });
    summary.movements += 1;
  }

  const expiringLots = new Map();
  for (const dayMeta of calendar) {
    const day = dayMeta.date;
    const daily = new Map(definitions.products.map((product) => [product.sku, {
      demanded: 0, sold: 0, lost: 0, stockout: false, inboundAtOrigin: 0, costSoldCents: 0,
      stockAtOrigin: productState.get(product.sku).stock, availableMinutes: 0, minuteMarker: 390,
      unitsSubstitutedIn: 0, unitsSubstitutedOut: 0,
    }]));
    dailyStatsForMovement = daily;

    // Expire perishable lots at store opening using FEFO lot order.
    for (const product of definitions.products) {
      if (!product.perishable) continue;
      const state = productState.get(product.sku);
      let expired = 0;
      for (const lot of state.lots) {
        if (lot.qty > 0 && lot.expiryDate && lot.expiryDate < day) {
          expired += lot.qty;
          lot.qty = 0;
        }
      }
      if (expired > 0) {
        state.valueCents = Math.max(0, state.valueCents - expired * state.averageCostCents);
        state.expiredUnits += expired;
        writeMovement(product.sku, 'waste', -expired, day, '06:20', null, 'expiry_fefo', state.averageCostCents, 0);
      }
      state.lots = state.lots.filter((lot) => lot.qty > 0);
    }

    // Deliveries and their stock movements precede same-time sales.
    const receiving = [];
    for (const order of outstanding.values()) {
      for (const item of order) if (item.receivedAtDate === day) receiving.push(item);
    }
    receiving.sort((a, b) => a.purchaseCode.localeCompare(b.purchaseCode) || a.sku.localeCompare(b.sku));
    for (const item of receiving) {
      const product = productBySku.get(item.sku);
      const state = productState.get(item.sku);
      const oldValue = state.valueCents;
      const newValue = item.qty * item.purchasePriceCents;
      const newStock = state.stock + item.qty;
      state.valueCents += newValue;
      state.averageCostCents = newStock > 0 ? Math.round(state.valueCents / newStock) : item.purchasePriceCents;
      state.lots.push({ lotCode: `V3-LOT-${item.purchaseCode}-${item.sku}`, qty: item.receivedQty, unitCostCents: item.purchasePriceCents, receivedAt: item.receivedAt, expiryDate: product.perishable && product.shelfLifeDays ? addDays(day, product.shelfLifeDays) : null });
      state.lots.sort((a, b) => String(a.expiryDate ?? '9999-99-99').localeCompare(String(b.expiryDate ?? '9999-99-99')) || a.receivedAt.localeCompare(b.receivedAt));
      writeMovement(item.sku, 'purchase_receipt', item.qty, day, '06:30', item.purchaseCode, 'full_receipt', item.purchasePriceCents, 1);
      item.receivedValueCents = newValue;
      item.inventoryValueBeforeCents = oldValue;
      item.inventoryValueAfterCents = state.valueCents;
    }

    for (const product of definitions.products) {
      daily.get(product.sku).inboundAtOrigin = (outstanding.get(product.sku) ?? []).filter((order) => order.orderedAtDate < day && order.receivedAtDate >= day).reduce((sum, order) => sum + order.qty, 0);
    }

    const arrivalsRng = streams.demand;
    const k = definitions.simulation.demand.shapeK;
    const dailyShock = arrivalsRng.gamma(k, 1 / k);
    const lambda = definitions.simulation.demand.baseTicketsPerDayTarget * dayMeta.arrivalsMultiplier * dailyShock;
    const arrivalCount = arrivalsRng.poisson(lambda);
    summary.arrivedTickets += arrivalCount;
    const arrivalTimes = Array.from({ length: arrivalCount }, () => getCsvDayPart(day, streams.basket, definitions.simulation)).sort((a, b) => a.minute - b.minute);
    let ticketOrdinal = 0;
    for (const timeInfo of arrivalTimes) {
      ticketOrdinal += 1;
      const statusDraw = streams.status.next();
      const status = statusDraw < definitions.simulation.ticket.cancellationRateTarget ? 'cancelled'
        : statusDraw < definitions.simulation.ticket.cancellationRateTarget + definitions.simulation.ticket.pendingRateMax ? 'pending' : 'completed';
      const mission = drawMission(streams.basket, definitions.simulation, dayMeta, timeInfo.key);
      const { customer, profile: customerProfile } = assignCustomer(day, streams.customer, definitions.customers, customerProfileByKey, customerState, recentTicketCounts);
      const prefs = customer ? customerPreferences.get(customer.customerCode) : null;
      const itemCount = chooseItemCount(streams.basket, customerProfile, mission);
      const basket = selectBasketProducts({ rng: streams.basket, itemCount, mission, dayPart: timeInfo.key, date: day, customerProfile, customerPrefs: prefs, products: definitions.products, productProfiles, calendar: dayMeta, promoBySkuDate, prices, associationRules: associations });
      const saleSeq = (saleSequenceByDay.get(day) ?? 0) + 1;
      saleSequenceByDay.set(day, saleSeq);
      const saleCode = `V3-SALE-${day.replaceAll('-', '')}-${seq(saleSeq)}`;
      const occurredAt = dateTimeLocal(day, timeInfo.time);
      const potentialLines = [];
      let grossPotentialCents = 0;
      let potentialDiscountCents = 0;
      for (const basketItem of basket) {
        const promo = basketItem.promotion;
        const effectivePriceCents = promo ? promo.effectivePriceCents : basketItem.basePriceCents;
        const discountCentsPerUnit = basketItem.basePriceCents - effectivePriceCents;
        const lineTotalCents = effectivePriceCents * basketItem.quantity;
        const lineDiscountCents = discountCentsPerUnit * basketItem.quantity;
        grossPotentialCents += basketItem.basePriceCents * basketItem.quantity;
        potentialDiscountCents += lineDiscountCents;
        potentialLines.push({ basketItem, effectivePriceCents, lineTotalCents, lineDiscountCents });
      }
      if (status !== 'completed') {
        if (status === 'cancelled') summary.cancelledSales += 1; else summary.pendingSales += 1;
        const canceledAt = status === 'cancelled' ? dateTimeLocal(day, timeInfo.time) : null;
        writer.write('sales.ndjson', {
          saleCode,
          sourceEventId: `${definitions.scenario.datasetVersion}|sale|${saleCode}|1`,
          businessKey: BUSINESS_KEY,
          scenarioId: definitions.scenario.scenarioId,
          occurredAt,
          localDate: day,
          customerCode: customer?.customerCode ?? null,
          customerKey: customer?.customerKey ?? null,
          customerName: customer?.displayName ?? definitions.scenario.consumerFinal.displayName,
          customerProfileKey: customer?.customerProfileKey ?? null,
          mission,
          dayPart: timeInfo.key,
          paymentMethod: streams.status.weighted(Object.entries(definitions.simulation.ticket.paymentShares).map(([value, weight]) => ({ value, weight }))),
          currency: 'PEN',
          grossBeforeDiscountCents: grossPotentialCents,
          itemDiscountCents: potentialDiscountCents,
          ticketDiscountCents: 0,
          subtotalAfterDiscountCents: grossPotentialCents - potentialDiscountCents,
          totalCents: grossPotentialCents - potentialDiscountCents,
          lineCount: potentialLines.length,
          status,
          cancelledAt: canceledAt,
          cancellationConvention: status === 'cancelled' ? 'same_day_before_close' : null,
          scenarioAssumption: true,
        });
        for (const line of potentialLines) {
          writer.write('sale-items.ndjson', {
            saleCode,
            saleLineKey: `${saleCode}|${line.basketItem.product.productKey}`,
            sourceEventId: `${definitions.scenario.datasetVersion}|sale-line|${saleCode}|${line.basketItem.product.productKey}|1`,
            businessKey: BUSINESS_KEY,
            scenarioId: definitions.scenario.scenarioId,
            sku: line.basketItem.product.sku, productKey: line.basketItem.product.productKey,
            quantity: line.basketItem.quantity, unitsSold: 0,
            baseUnitPriceCents: line.basketItem.basePriceCents,
            effectiveUnitPriceCents: line.effectivePriceCents,
            costAtSaleCents: productState.get(line.basketItem.product.sku).averageCostCents,
            lineDiscountCents: line.lineDiscountCents,
            lineTotalCents: line.lineTotalCents,
            promotionCode: line.basketItem.promotion?.promotionCode ?? null,
            transactionStatus: status,
            currency: 'PEN',
          });
          summary.saleItems += 1;
        }
        continue;
      }

      const lines = [];
      const soldProducts = [];
      for (const line of potentialLines) {
        const product = line.basketItem.product;
        const state = productState.get(product.sku);
        const stats = daily.get(product.sku);
        stats.demanded += line.basketItem.quantity;
        const quantity = Math.min(line.basketItem.quantity, state.stock);
        const lost = line.basketItem.quantity - quantity;
        stats.sold += quantity;
        stats.lost += lost;
        stats.stockout ||= lost > 0;
        summary.lostDemand += lost;
        if (quantity <= 0) continue;
        const costAtSale = state.averageCostCents;
        let needed = quantity;
        for (const lot of state.lots) {
          if (needed <= 0) break;
          const take = Math.min(needed, lot.qty);
          lot.qty -= take;
          needed -= take;
        }
        state.lots = state.lots.filter((lot) => lot.qty > 0);
        const saleValueCents = quantity * costAtSale;
        const unvaluedRoundingCents = Math.max(0, saleValueCents - state.valueCents);
        state.valueCents = Math.max(0, state.valueCents - saleValueCents);
        writeMovement(product.sku, 'sale', -quantity, day, timeInfo.time, saleCode, null, costAtSale, 2);
        if (unvaluedRoundingCents > 0) {
          writeMovement(product.sku, 'valuation_adjustment', 0, day, timeInfo.time, saleCode, 'moving_average_rounding', 0, 3, unvaluedRoundingCents);
        }
        const lineTotalCents = line.effectivePriceCents * quantity;
        const lineDiscountCents = (line.basketItem.basePriceCents - line.effectivePriceCents) * quantity;
        const soldLine = {
          saleCode,
          saleLineKey: `${saleCode}|${product.productKey}`,
          sourceEventId: `${definitions.scenario.datasetVersion}|sale-line|${saleCode}|${product.productKey}|1`,
          businessKey: BUSINESS_KEY,
          scenarioId: definitions.scenario.scenarioId,
          sku: product.sku,
          productKey: product.productKey,
          quantity,
          requestedQuantity: line.basketItem.quantity,
          unitsSold: quantity,
          baseUnitPriceCents: line.basketItem.basePriceCents,
          effectiveUnitPriceCents: line.effectivePriceCents,
          costAtSaleCents: costAtSale,
          lineDiscountCents,
          lineTotalCents,
          promotionCode: line.basketItem.promotion?.promotionCode ?? null,
          transactionStatus: 'completed',
          currency: 'PEN',
        };
        lines.push(soldLine);
        soldProducts.push(product.sku);
        writer.write('sale-items.ndjson', soldLine);
        summary.saleItems += 1;
        summary.unitsSold += quantity;
        summary.revenueCents += lineTotalCents;
        summary.cogsCents += quantity * costAtSale;
        stats.costSoldCents += quantity * costAtSale;
        summary.productUnits.set(product.sku, (summary.productUnits.get(product.sku) ?? 0) + quantity);
        summary.categoryUnits.set(product.categoryCode, (summary.categoryUnits.get(product.categoryCode) ?? 0) + quantity);
        if (line.basketItem.promotion) summary.monthlyPromoVsRegular.promoUnits += quantity; else summary.monthlyPromoVsRegular.regularUnits += quantity;
      }
      if (!lines.length) continue;
      const lineTotals = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
      const lineDiscounts = lines.reduce((sum, line) => sum + line.lineDiscountCents, 0);
      const lineGross = lines.reduce((sum, line) => sum + line.baseUnitPriceCents * line.quantity, 0);
      const paymentMethod = streams.status.weighted(Object.entries(definitions.simulation.ticket.paymentShares).map(([value, weight]) => ({ value, weight })));
      const sale = {
        saleCode,
        sourceEventId: `${definitions.scenario.datasetVersion}|sale|${saleCode}|1`,
        businessKey: BUSINESS_KEY,
        scenarioId: definitions.scenario.scenarioId,
        occurredAt,
        localDate: day,
        customerCode: customer?.customerCode ?? null,
        customerKey: customer?.customerKey ?? null,
        customerName: customer?.displayName ?? definitions.scenario.consumerFinal.displayName,
        customerProfileKey: customer?.customerProfileKey ?? null,
        mission,
        dayPart: timeInfo.key,
        paymentMethod,
        currency: 'PEN',
        grossBeforeDiscountCents: lineGross,
        itemDiscountCents: lineDiscounts,
        ticketDiscountCents: 0,
        subtotalAfterDiscountCents: lineTotals,
        totalCents: lineTotals,
        status: 'completed',
        cancelledAt: null,
        lineCount: lines.length,
      };
      writer.write('sales.ndjson', sale);
      summary.completedSales += 1;
      if (customer) {
        summary.registeredTickets += 1;
        const customerStats = summary.customers.get(customer.customerCode);
        customerStats.tickets += 1;
        customerStats.netRevenueCents += lineTotals;
        customerStats.units += lines.reduce((sum, line) => sum + line.quantity, 0);
        recentTicketCounts.set(customer.customerCode, (recentTicketCounts.get(customer.customerCode) ?? 0) + 1);
        customerStats.firstDate ||= day;
        customerStats.lastDate = day;
        const state = customerState.get(customer.customerCode);
        state.firstTicketComplete = true;
        state.lastTicketDate = day;
      } else summary.guestTickets += 1;
      const monthStats = summary.monthlySales.get(monthKey(day)) ?? { revenueCents: 0, tickets: 0, units: 0 };
      monthStats.revenueCents += lineTotals; monthStats.tickets += 1; monthStats.units += lines.reduce((sum, line) => sum + line.quantity, 0);
      summary.monthlySales.set(monthKey(day), monthStats);
      const weekdayStats = summary.weekdaySales.get(String(dayMeta.weekdayIso)) ?? { revenueCents: 0, tickets: 0, units: 0 };
      weekdayStats.revenueCents += lineTotals; weekdayStats.tickets += 1; weekdayStats.units += lines.reduce((sum, line) => sum + line.quantity, 0);
      summary.weekdaySales.set(String(dayMeta.weekdayIso), weekdayStats);
      if (customer) {
        const state = customerState.get(customer.customerCode);
        if (state && !state.firstTicketDate) state.firstTicketDate = day;
      }
      const sortedSkus = [...new Set(soldProducts)].sort();
      for (let i = 0; i < sortedSkus.length; i += 1) for (let j = i + 1; j < sortedSkus.length; j += 1) {
        const key = `${sortedSkus[i]}|${sortedSkus[j]}`;
        summary.pairCounts.set(key, (summary.pairCounts.get(key) ?? 0) + 1);
      }
    }

    // Availability hours are measured from open to close, using the stock path during arrivals.
    const closeMinute = 1290;
    for (const product of definitions.products) {
      const stats = daily.get(product.sku);
      if (stats.minuteMarker < closeMinute && productState.get(product.sku).stock > 0) stats.availableMinutes += closeMinute - stats.minuteMarker;
      const availableHours = Number((stats.availableMinutes / 60).toFixed(4));
      const stockout = stats.demanded > stats.sold;
      if (stockout) summary.stockoutProductDays += 1;
      summary.productDays += 1;
      const observedPrice = currentPriceAt(product.sku, day, prices.priceHistories, prices.basePrice);
      const promo = promoBySkuDate.get(`${product.sku}|${day}`);
      const avgSaleCost = stats.sold > 0 ? Math.round(stats.costSoldCents / stats.sold) : productState.get(product.sku).averageCostCents;
      const weekNo = Number(dayMeta.weekKey.split('-')[1]);
      writer.write('product-daily.ndjson', {
        dailyRowKey: `${definitions.scenario.scenarioId}|${product.sku}|${day}`,
        localDate: day,
        scenarioId: definitions.scenario.scenarioId,
        sku: product.sku,
        productKey: product.productKey,
        categoryCode: product.categoryCode,
        subcategoryCode: product.subcategoryCode,
        unitsSold: stats.sold,
        unitsDemandedSynthetic: stats.demanded,
        lostDemandSynthetic: stats.lost,
        unitsSubstitutedOut: stats.unitsSubstitutedOut,
        unitsSubstitutedIn: stats.unitsSubstitutedIn,
        announcedSalePriceAtOrigin: observedPrice,
        realizedSalePrice: observedPrice,
        currency: 'PEN',
        promotionKnownAtOrigin: Boolean(promo && promo.announcedAt < day),
        promotionOccurred: Boolean(promo),
        promotionCode: promo?.promotionCode ?? null,
        promotionDiscountPct: promo?.discountPct ?? null,
        onHandUsableAtOrigin: stats.stockAtOrigin,
        knownInboundAtOrigin: stats.inboundAtOrigin,
        stockoutFlag: stockout,
        availableHours,
        weekdayIso: dayMeta.weekdayIso,
        weekend: dayMeta.weekend,
        weekKey: dayMeta.weekKey,
        month: dayMeta.month,
        paydayWindow: dayMeta.payday,
        monthEnd: dayMeta.monthEnd,
        holidayCode: dayMeta.holidayCode,
        syntheticPulseCode: dayMeta.pulseCode,
        syntheticPulseKnownAtOrigin: dayMeta.pulseKnownAtOrigin,
        endingStock: productState.get(product.sku).stock,
        effectiveUnitCostAtSale: avgSaleCost,
        scenarioAssumption: true,
      });
      if (promo) summary.monthlyPromoVsRegular.promoProductDays += 1; else summary.monthlyPromoVsRegular.regularProductDays += 1;
      const state = productState.get(product.sku);
      const row = inventoryHistory.get(product.sku).at(-1);
      row.endingStock = state.stock;
      inventoryHistory.get(product.sku).push({ date: day, sold: stats.sold, demanded: stats.demanded, lost: stats.lost, stockout, endingStock: state.stock, availableHours });
    }

    // Review inventory at close. Group by supplier and day; open requirements are never duplicated.
    const ordersForDay = new Map();
    for (const product of definitions.products) {
      const sku = product.sku;
      const state = productState.get(sku);
      const outstandingRows = outstanding.get(sku).filter((order) => order.receivedAtDate >= addDays(day, 1));
      outstanding.set(sku, outstandingRows);
      const outstandingQty = outstandingRows.reduce((sum, order) => sum + order.qty, 0);
      const leadRng = streams.supplier;
      const orderChoice = choosePreferredQuantityAndSupplier(product, day, state, outstandingQty, recentSales.get(sku), definitions, prices, leadRng);
      const reorderPoint = Math.ceil(product.baseUnitsPerDay * orderChoice.leadDays) + product.safetyStockInitial;
      if (orderChoice.inventoryPosition > reorderPoint || orderChoice.orderQty <= 0) continue;
      const bucket = ordersForDay.get(orderChoice.supplierCode) ?? { supplierCode: orderChoice.supplierCode, leadDays: orderChoice.leadDays, lines: [] };
      bucket.lines.push({ product, choice: orderChoice });
      ordersForDay.set(orderChoice.supplierCode, bucket);
    }
    for (const bucket of [...ordersForDay.values()].sort((a, b) => a.supplierCode.localeCompare(b.supplierCode))) {
      const poSeq = (purchaseSequenceByDay.get(day) ?? 0) + 1;
      purchaseSequenceByDay.set(day, poSeq);
      const purchaseCode = `V3-PO-${day.replaceAll('-', '')}-${seq(poSeq)}`;
      const supplier = supplierByCode.get(bucket.supplierCode);
      const orderedAt = dateTimeLocal(day, '21:35');
      const promisedDate = addDays(day, bucket.leadDays);
      const isLate = streams.delay.next() > supplier.onTimeProbabilityDemo;
      const controlledIncident = bucket.lines.map(({ product }) => controlledIncidents.get(product.sku))
        .find((incident) => incident && !incident.applied && day >= incident.incidentStartDate);
      const sampledDelay = isLate ? streams.delay.int(1, 3) : 0;
      const delayDays = Math.max(sampledDelay, controlledIncident?.extraDelayDays ?? 0);
      const receivedDate = addDays(promisedDate, delayDays);
      if (controlledIncident) {
        controlledIncident.applied = true;
        controlledIncident.purchaseCode = `V3-PO-${day.replaceAll('-', '')}-${seq((purchaseSequenceByDay.get(day) ?? 0) + 1)}`;
        controlledIncident.supplierCode = bucket.supplierCode;
        controlledIncident.orderedAtDate = day;
        controlledIncident.promisedAtDate = promisedDate;
        controlledIncident.receivedAtDate = receivedDate <= definitions.scenario.historyEnd ? receivedDate : null;
        controlledIncident.actualDelayDays = delayDays;
      }
      const promisedAt = dateTimeLocal(promisedDate, '06:30');
      const receivedAt = dateTimeLocal(receivedDate, '06:30');
      let totalCostCents = 0;
      const itemRows = [];
      for (const { product, choice } of bucket.lines.sort((a, b) => a.product.sku.localeCompare(b.product.sku))) {
        const qty = choice.orderQty;
        const itemCost = qty * choice.priceCents;
        totalCostCents += itemCost;
        const item = {
          purchaseCode,
          purchaseLineKey: `${purchaseCode}|${product.productKey}`,
          sourceEventId: `${definitions.scenario.datasetVersion}|purchase-line|${purchaseCode}|${product.productKey}|1`,
          businessKey: BUSINESS_KEY,
          scenarioId: definitions.scenario.scenarioId,
          sku: product.sku, productKey: product.productKey,
          supplierCode: bucket.supplierCode, quantityOrdered: qty,
          quantityReceived: receivedDate <= definitions.scenario.historyEnd ? qty : 0,
          purchasePriceCents: choice.priceCents, currency: 'PEN',
          orderedAt, promisedAt, receivedAt: receivedDate <= definitions.scenario.historyEnd ? receivedAt : null,
          expectedLeadDays: bucket.leadDays,
          actualLeadDays: receivedDate <= definitions.scenario.historyEnd ? bucket.leadDays + delayDays : null,
          minOrderQty: 1, packMultiple: choice.packMultiple,
          status: receivedDate <= definitions.scenario.historyEnd ? 'received' : 'pending',
          lineTotalCents: itemCost,
        };
        itemRows.push(item);
        writer.write('purchase-items.ndjson', item);
        summary.purchaseItems += 1;
        if (receivedDate <= definitions.scenario.historyEnd) {
          outstanding.get(product.sku).push({ sku: product.sku, qty, orderedAtDate: day, receivedAtDate: receivedDate, receivedAt, purchaseCode, purchasePriceCents: choice.priceCents });
        } else {
          outstanding.get(product.sku).push({ sku: product.sku, qty, orderedAtDate: day, receivedAtDate: receivedDate, receivedAt: null, purchaseCode, purchasePriceCents: choice.priceCents });
        }
      }
      const received = receivedDate <= definitions.scenario.historyEnd;
      writer.write('purchases.ndjson', {
        purchaseCode,
        sourceEventId: `${definitions.scenario.datasetVersion}|purchase|${purchaseCode}|1`,
        scenarioId: definitions.scenario.scenarioId,
        businessKey: BUSINESS_KEY,
        supplierCode: bucket.supplierCode,
        supplierKey: `v3.${bucket.supplierCode}`,
        orderedAt,
        promisedAt,
        receivedAt: received ? receivedAt : null,
        orderedLocalDate: day,
        promisedLocalDate: promisedDate,
        receivedLocalDate: received ? receivedDate : null,
        currency: 'PEN',
        totalCostCents,
        itemCount: itemRows.length,
        status: received ? 'completed' : 'pending',
        delayDays: received ? delayDays : null,
        late: received ? delayDays > 0 : null,
        simulationAssumption: true,
      });
      summary.purchases += 1;
      const supplierStats = summary.supplierPurchases.get(bucket.supplierCode);
      supplierStats.orders += 1;
      if (received) {
        supplierStats.receivedOrders += 1;
        supplierStats.purchaseValueCents += totalCostCents;
        const actualLeadDays = bucket.leadDays + delayDays;
        supplierStats.leadDaysTotal += actualLeadDays;
        supplierStats.minLeadDays = supplierStats.minLeadDays == null ? actualLeadDays : Math.min(supplierStats.minLeadDays, actualLeadDays);
        supplierStats.maxLeadDays = supplierStats.maxLeadDays == null ? actualLeadDays : Math.max(supplierStats.maxLeadDays, actualLeadDays);
        if (delayDays > 0) supplierStats.delayedOrders += 1;
        summary.receivedPurchaseValueCents += totalCostCents;
        for (const item of itemRows) supplierStats.units += item.quantityReceived;
      }
    }

    writer.write('calendar.ndjson', {
      localDate: day,
      scenarioId: definitions.scenario.scenarioId,
      businessKey: BUSINESS_KEY,
      weekdayIso: dayMeta.weekdayIso,
      weekend: dayMeta.weekend,
      weekKey: dayMeta.weekKey,
      month: dayMeta.month,
      paydayWindow: dayMeta.payday,
      monthEnd: dayMeta.monthEnd,
      holidayCode: dayMeta.holidayCode,
      syntheticPulseCode: dayMeta.pulseCode,
      syntheticPulseKnownAtOrigin: dayMeta.pulseKnownAtOrigin,
      scheduledArrivalLambda: definitions.simulation.demand.baseTicketsPerDayTarget * dayMeta.arrivalsMultiplier,
      arrivedTickets: arrivalCount,
      simulationAssumption: true,
    });
    for (const product of definitions.products) recentSales.get(product.sku).push(daily.get(product.sku).sold);
  }

  // Materialize source maestros enriched with generated end-state, while preserving canonical presentation/SKU identity.
  for (const product of [...definitions.products].sort((a, b) => a.sku.localeCompare(b.sku))) {
    const state = productState.get(product.sku);
    const life = inventoryHistory.get(product.sku).slice(1);
    const last28 = life.slice(-28);
    const sold28 = last28.reduce((sum, row) => sum + row.sold, 0);
    const zeroSaleDays28 = last28.filter((row) => row.sold === 0).length;
    const classification = state.stock <= product.minStockInitial ? 'below_minimum'
      : last28.some((row) => row.stockout) ? 'recent_stockout'
        : sold28 === 0 ? 'dead_or_no_recent_movement'
          : sold28 <= Math.max(1, product.baseUnitsPerDay * 28 * 0.25) ? 'slow_moving'
            : state.stock > product.reorderPointInitial * 2 ? 'overstock_candidate' : 'healthy';
    writer.write('products.ndjson', {
      ...product,
      businessKey: BUSINESS_KEY,
      scenarioId: definitions.scenario.scenarioId,
      initialStock: state.initialStock,
      initialStockValueCents: state.initialStock * cents(product.purchaseCostDemo),
      endingStock: state.stock,
      endingInventoryValueCents: state.valueCents,
      endingAverageCostCents: state.averageCostCents,
      endingClassification: classification,
      recent28SoldUnits: sold28,
      recent28ZeroSaleDays: zeroSaleDays28,
      totalExpiredUnits: state.expiredUnits,
      currency: 'PEN',
    });
    writer.write('inventory-snapshot.ndjson', {
      scenarioId: definitions.scenario.scenarioId,
      businessKey: BUSINESS_KEY,
      snapshotLocalDate: definitions.scenario.historyEnd,
      sku: product.sku,
      productKey: product.productKey,
      onHandUsable: state.stock,
      inventoryValueCents: state.valueCents,
      averageUnitCostCents: state.averageCostCents,
      classification,
      currency: 'PEN',
    });
  }
  for (const category of definitions.categories.categories) {
    writer.write('categories.ndjson', { ...category, scenarioId: definitions.scenario.scenarioId, businessKey: BUSINESS_KEY });
  }
  for (const supplier of [...definitions.suppliers].sort((a, b) => a.supplierCode.localeCompare(b.supplierCode))) {
    const stats = summary.supplierPurchases.get(supplier.supplierCode);
    const onTimeRatePct = stats.receivedOrders ? Number(((stats.receivedOrders - stats.delayedOrders) * 100 / stats.receivedOrders).toFixed(2)) : null;
    writer.write('suppliers.ndjson', { ...supplier, scenarioId: definitions.scenario.scenarioId, businessKey: BUSINESS_KEY, generatedPurchases: stats.orders, completedReceipts: stats.receivedOrders, delayedReceipts: stats.delayedOrders, observedOnTimeRatePct: onTimeRatePct, simulationAssumption: true });
  }
  for (const customer of [...definitions.customers].sort((a, b) => a.customerCode.localeCompare(b.customerCode))) {
    const stats = summary.customers.get(customer.customerCode);
    writer.write('customers.ndjson', { ...customer, scenarioId: definitions.scenario.scenarioId, businessKey: BUSINESS_KEY, completedTickets: stats.tickets, revenueCents: stats.netRevenueCents, unitsSold: stats.units, firstPurchaseObserved: stats.firstDate, lastPurchaseObserved: stats.lastDate, simulationProfileNotObservedFact: customer.customerProfileKey });
  }
  for (const promo of promotions.episodes) writer.write('promotions.ndjson', { ...promo, scenarioId: definitions.scenario.scenarioId, businessKey: BUSINESS_KEY });
  for (const row of prices.priceRows) writer.write('price-history.ndjson', { ...row, scenarioId: definitions.scenario.scenarioId, businessKey: BUSINESS_KEY });
  for (const row of prices.costRows) writer.write('supplier-cost-history.ndjson', { ...row, scenarioId: definitions.scenario.scenarioId, businessKey: BUSINESS_KEY });
  const pulseRows = [];
  const pulseStarts = calendar.filter((item) => item.pulseCode);
  for (const group of new Map(pulseStarts.map((item) => [item.pulseCode, item])).values()) {
    pulseRows.push({ pulseCode: group.pulseCode, startDate: group.date, endDate: addDays(group.date, definitions.simulation.calendar.specialSyntheticPulses.durationDays - 1), announcedAt: addDays(group.date, -14), multiplier: group.pulseMultiplier, simulationAssumption: true });
  }

  const analytics = computeAnalytics(summary);
  const dailyRows = summary.productDays;
  const receivedCostCents = summary.receivedPurchaseValueCents;
  const avgSaleValue = summary.completedSales ? summary.revenueCents / summary.completedSales : 0;
  const allCustomers = [...summary.customers.values()];
  const profileEvidence = Object.fromEntries(definitions.profiles.customerProfiles.map((profile) => [profile.key, {
    configuredCustomers: profile.count,
    customersWithTickets: definitions.customers.filter((customer) => customer.customerProfileKey === profile.key && summary.customers.get(customer.customerCode).tickets > 0).length,
    tickets: definitions.customers.filter((customer) => customer.customerProfileKey === profile.key).reduce((total, customer) => total + summary.customers.get(customer.customerCode).tickets, 0),
  }]));
  const coefficientOfVariation = (values) => {
    if (!values.length) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (mean === 0) return 0;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Number((Math.sqrt(variance) / mean).toFixed(4));
  };
  const promotedAverageUnits = summary.monthlyPromoVsRegular.promoProductDays
    ? summary.monthlyPromoVsRegular.promoUnits / summary.monthlyPromoVsRegular.promoProductDays : 0;
  const regularAverageUnits = summary.monthlyPromoVsRegular.regularProductDays
    ? summary.monthlyPromoVsRegular.regularUnits / summary.monthlyPromoVsRegular.regularProductDays : 0;
  const inventoryReadiness = definitions.products.map((product) => {
    const rows = inventoryHistory.get(product.sku).slice(1);
    const mean = rows.reduce((sum, row) => sum + row.sold, 0) / rows.length;
    const variance = rows.reduce((sum, row) => sum + (row.sold - mean) ** 2, 0) / rows.length;
    return {
      sku: product.sku,
      daysWithSales: rows.filter((row) => row.sold > 0).length,
      zeroSalesDays: rows.filter((row) => row.sold === 0).length,
      stockoutDays: rows.filter((row) => row.stockout).length,
      meanDailyUnitsSold: Number(mean.toFixed(4)),
      dailyUnitsSoldVariance: Number(variance.toFixed(4)),
      recent28Units: rows.slice(-28).reduce((sum, row) => sum + row.sold, 0),
      forecastReadiness: rows.filter((row) => row.sold > 0).length >= 30 ? 'sufficient_history' : mean <= 0.05 ? 'very_low_demand' : 'limited_history',
    };
  });
  const topPairs = [...summary.pairCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 25).map(([key, tickets]) => ({ skus: key.split('|'), tickets }));
  const reports = {
    scenarioId: definitions.scenario.scenarioId,
    seed,
    dateRange: { min: definitions.scenario.historyStart, max: definitions.scenario.historyEnd },
    totals: {
      arrivedTickets: summary.arrivedTickets,
      completedTickets: summary.completedSales,
      saleItems: summary.saleItems,
      cancelledTickets: summary.cancelledSales,
      pendingTickets: summary.pendingSales,
      purchases: summary.purchases,
      purchaseItems: summary.purchaseItems,
      inventoryMovements: summary.movements,
      productDailyRows: dailyRows,
      inventorySnapshotRows: definitions.products.length,
      promotions: promotions.episodes.length,
      promotionProductDays: promotions.productDays,
      unitsSold: summary.unitsSold,
      lostDemandSynthetic: summary.lostDemand,
      revenueCents: summary.revenueCents,
      cogsCents: summary.cogsCents,
      grossMarginCents: summary.revenueCents - summary.cogsCents,
      receivedPurchaseValueCents: receivedCostCents,
      customerFinalSharePct: summary.completedSales ? Number((summary.guestTickets * 100 / summary.completedSales).toFixed(3)) : null,
      averageTicketCents: Math.round(avgSaleValue),
      stockoutProductDays: summary.stockoutProductDays,
      stockoutProductDayPct: Number((summary.stockoutProductDays * 100 / Math.max(1, dailyRows)).toFixed(3)),
    },
    analytics: {
      ...analytics,
      customerFinalSharePct: summary.completedSales ? Number((summary.guestTickets * 100 / summary.completedSales).toFixed(3)) : null,
      registeredCustomersWithAtLeast3Tickets: allCustomers.filter((row) => row.tickets >= 3).length,
      customerProfileEvidence: profileEvidence,
      supplierDelayReadiness: analytics.topSuppliers,
      controlledSupplierDelayIncidents: [...controlledIncidents.values()].map((incident) => ({ ...incident })),
      stockoutProducts: inventoryReadiness.filter((row) => row.stockoutDays > 0).map((row) => ({ sku: row.sku, stockoutDays: row.stockoutDays })),
      slowMovers: definitions.products.map((product) => ({ product, rows: inventoryHistory.get(product.sku).slice(-31, -1) }))
        .map(({ product, rows }) => ({ sku: product.sku, unitsLast30: rows.reduce((sum, row) => sum + row.sold, 0), daysWithoutSaleLast30: rows.filter((row) => row.sold === 0).length }))
        .filter((row) => row.daysWithoutSaleLast30 >= 25).sort((a, b) => b.daysWithoutSaleLast30 - a.daysWithoutSaleLast30).slice(0, 20),
      inventoryReadiness,
      topCooccurrencePairs: topPairs,
      promoVsNonPromo: summary.monthlyPromoVsRegular,
      promotionEffectSanity: {
        promotedProductDayAverageUnits: Number(promotedAverageUnits.toFixed(4)),
        regularProductDayAverageUnits: Number(regularAverageUnits.toFixed(4)),
        observedUnitsRatio: regularAverageUnits > 0 ? Number((promotedAverageUnits / regularAverageUnits).toFixed(4)) : null,
      },
      diversityDiagnostics: {
        productUnitsCoefficientOfVariation: coefficientOfVariation(definitions.products.map((product) => summary.productUnits.get(product.sku) ?? 0)),
        registeredCustomerTicketsCoefficientOfVariation: coefficientOfVariation([...summary.customers.values()].map((customer) => customer.tickets)),
        supplierPurchaseValueCoefficientOfVariation: coefficientOfVariation([...summary.supplierPurchases.values()].map((supplier) => supplier.purchaseValueCents)),
      },
      priceMarginPct: {
        min: Number(Math.min(...definitions.products.map((product) => 100 * (product.salePriceDemo - product.purchaseCostDemo) / product.salePriceDemo)).toFixed(3)),
        median: Number([...definitions.products.map((product) => 100 * (product.salePriceDemo - product.purchaseCostDemo) / product.salePriceDemo)].sort((a, b) => a - b)[40].toFixed(3)),
        max: Number(Math.max(...definitions.products.map((product) => 100 * (product.salePriceDemo - product.purchaseCostDemo) / product.salePriceDemo)).toFixed(3)),
      },
      diversityWarnings: [],
    },
  };
  if (reports.analytics.diversityDiagnostics.productUnitsCoefficientOfVariation < 0.15) reports.analytics.diversityWarnings.push('Los SKUs tienen ventas casi iguales; revisar diversidad de demanda.');
  if (reports.analytics.diversityDiagnostics.registeredCustomerTicketsCoefficientOfVariation < 0.15) reports.analytics.diversityWarnings.push('Los clientes registrados tienen frecuencias casi idénticas; revisar heterogeneidad de perfiles.');
  if (reports.analytics.diversityDiagnostics.supplierPurchaseValueCoefficientOfVariation < 0.15) reports.analytics.diversityWarnings.push('Los proveedores tienen compras casi iguales; revisar variedad de abastecimiento.');
  if (Object.values(profileEvidence).some((item) => item.customersWithTickets === 0)) reports.analytics.diversityWarnings.push('Algún perfil de cliente no tiene ejemplos observados.');
  if (summary.monthlyPromoVsRegular.promoProductDays === 0 || summary.monthlyPromoVsRegular.promoUnits === 0) reports.analytics.diversityWarnings.push('Promociones no muestran días/unidades efectivos; revisar su efecto.');
  if (reports.analytics.promotionEffectSanity.observedUnitsRatio != null && reports.analytics.promotionEffectSanity.observedUnitsRatio <= 1) reports.analytics.diversityWarnings.push('Promociones no muestran mayor volumen observado que días regulares; revisar, sin afirmar causalidad.');
  if (summary.stockoutProductDays / Math.max(1, dailyRows) > 0.05) reports.analytics.diversityWarnings.push('Stockout supera el máximo objetivo de 5% product-day.');
  if (topPairs.length && topPairs[0].tickets >= summary.completedSales * 0.95) reports.analytics.diversityWarnings.push('Una pareja aparece en casi todos los tickets; posible asociación artificialmente perfecta.');
  if (summary.completedSales < 10000 || summary.completedSales > 15000) reports.analytics.diversityWarnings.push('Tickets completados quedan fuera del rango 10k–15k; calibración requerida antes de congelar.');
  if (summary.saleItems < 30000 || summary.saleItems > 50000) reports.analytics.diversityWarnings.push('Líneas de venta quedan fuera del rango 30k–50k; calibración requerida antes de congelar.');
  writer.write('analytics-summary.json', reports);
  writer.write('customer-profile-evidence.json', profileEvidence);
  writer.write('forecast-readiness.json', inventoryReadiness);
  writer.write('cooccurrence-summary.json', { candidatePairs: topPairs, method: 'ticket-level pair counts, no FP-Growth', hiddenTruth: false });
  writer.write('simulation-truth.json', {
    scenarioId: definitions.scenario.scenarioId,
    seed,
    generatorVersion: GENERATOR_VERSION,
    productLatentParameters: definitions.products.map((product) => ({ sku: product.sku, popularity: productProfiles.get(`popularity:${product.sku}`), elasticity: productProfiles.get(`elasticity:${product.sku}`), trend: productProfiles.get(`trend:${product.sku}`) })),
    pulseEvents: pulseRows,
    controlledSupplierDelayIncidents: [...controlledIncidents.values()].map((incident) => ({ ...incident, simulationAssumption: true })),
    associationRules: associations.map((rule) => ({ ...rule, usage: 'offline_simulation_truth_not_feature' })),
    note: 'Offline-only synthetic parameters; never operational facts or model inputs.',
  });

  const fileHashes = writer.digest();
  const logicalDatasetSha256 = sha256(Buffer.from(canonicalJson(fileHashes)));
  const counts = {
    products: definitions.products.length,
    categories: definitions.categories.categories.length,
    subcategories: definitions.categories.categories.reduce((sum, category) => sum + category.subcategories.length, 0),
    suppliers: definitions.suppliers.length,
    customers: definitions.customers.length,
    sales: summary.completedSales + summary.cancelledSales + summary.pendingSales,
    completedSales: summary.completedSales,
    cancelledSales: summary.cancelledSales,
    pendingSales: summary.pendingSales,
    saleItems: summary.saleItems,
    purchases: summary.purchases,
    purchaseItems: summary.purchaseItems,
    promotions: promotions.episodes.length,
    movements: summary.movements,
    productDailyRows: dailyRows,
    inventorySnapshotRows: definitions.products.length,
    supplierOffers: 80 + definitions.offers.secondaryAssignments.length,
    priceChanges: prices.priceRows.length,
    supplierCostChanges: prices.costRows.length,
  };
  const manifest = {
    manifestSchemaVersion: '1.0.0',
    scenarioId: definitions.scenario.scenarioId,
    scenarioVersion: definitions.scenario.scenarioVersion,
    datasetVersion: definitions.scenario.datasetVersion,
    seed,
    generatorVersion: GENERATOR_VERSION,
    generatorCommit: null,
    generatedAt: definitions.scenario.snapshotAtUtc,
    generatedAtSemantics: 'deterministic logical build timestamp anchored to scenario snapshot; wall-clock job time is excluded',
    referenceDate: definitions.scenario.referenceDate,
    timezone: definitions.scenario.timezone,
    dateRange: { historyStart: definitions.scenario.historyStart, historyEnd: definitions.scenario.historyEnd, minUtc: dateTimeLocal(definitions.scenario.historyStart, '00:00'), maxUtc: dateTimeLocal(addDays(definitions.scenario.historyEnd, 1), '00:00') },
    counts,
    configSha256: sha256(Buffer.from(canonicalJson({
      scenario: definitions.scenario,
      categories: definitions.categories,
      products: definitions.products,
      suppliers: definitions.suppliers,
      offers: definitions.offers,
      customers: definitions.customers,
      profiles: definitions.profiles,
      simulation: definitions.simulation,
      promotions: definitions.promotions,
      dailyContract: definitions.dailyContract,
      stableKeys: definitions.stableKeys,
      canonicalization: definitions.canonicalization,
    }))),
    aggregates: {
      currency: 'PEN',
      revenueCents: summary.revenueCents,
      cogsCents: summary.cogsCents,
      grossMarginCents: summary.revenueCents - summary.cogsCents,
      purchaseValueReceivedCents: summary.receivedPurchaseValueCents,
      unitsSold: summary.unitsSold,
      lostDemandSynthetic: summary.lostDemand,
      customerFinalSharePct: summary.completedSales ? Number((summary.guestTickets * 100 / summary.completedSales).toFixed(3)) : null,
      promotionProductDayPct: Number((promotions.productDays * 100 / Math.max(1, dailyRows)).toFixed(4)),
      stockoutProductDayPct: Number((summary.stockoutProductDays * 100 / Math.max(1, dailyRows)).toFixed(4)),
      totalEndingStock: [...productState.values()].reduce((sum, state) => sum + state.stock, 0),
      totalOpeningStock: [...productState.values()].reduce((sum, state) => sum + state.initialStock, 0),
      averageTicketCents: summary.completedSales ? Math.round(summary.revenueCents / summary.completedSales) : null,
    },
    hashes: { canonicalizationVersion: 'v3-canonical-json-v1', logicalDatasetSha256, files: fileHashes },
    integrity: { orphanReferences: 0, crossTenantReferences: 0, duplicateStableKeys: 0, invalidStockBalances: 0 },
    definitionsOnly: false,
    transactionsGenerated: true,
    mongoLoaded: false,
    modelTrained: false,
  };
  fs.writeFileSync(path.join(resolvedOutput, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8');
  const report = { manifest, analytics: reports.analytics, totals: reports.totals, profileEvidence };
  fs.writeFileSync(path.join(resolvedOutput, 'report.json'), `${canonicalJson(report)}\n`, 'utf8');
  return { outputDir: resolvedOutput, manifest, report };
}

module.exports = {
  BUSINESS_KEY,
  DATA_DIR,
  GENERATOR_VERSION,
  Random,
  addDays,
  canonicalJson,
  cents,
  dateRange,
  dateTimeLocal,
  generateDataset,
  loadDefinitions,
  sha256,
};
