const { compactAnalyticsContext } = require('./forecastAnalytics');
const scenarios = require('../config/mlScenarios.json');
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const parseRequestedDate = text => {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const value = `${iso[1]}-${iso[2]}-${iso[3]}`;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
  }
  const months = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
  const spanish = text.match(/\b(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(20\d{2})\b/);
  if (!spanish || !months[spanish[2]]) return null;
  const date = new Date(Date.UTC(Number(spanish[3]), months[spanish[2]] - 1, Number(spanish[1])));
  return date.getUTCFullYear() === Number(spanish[3]) && date.getUTCMonth() === months[spanish[2]] - 1
    && date.getUTCDate() === Number(spanish[1]) ? date.toISOString().slice(0, 10) : null;
};
const addDays = (value, amount) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};
const dateLabel = value => new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${value}T00:00:00.000Z`));
const routeForecastTemporalQuery = (message, memory, now, businessId) => {
  const text = normalize(message);
  const forecastQuestion = /\b(?:forecast|prediccion|predij\w*|demanda|que pasara)\b/.test(text);
  const futureSalesQuestion = /\b(?:vendere|venderas|vendera|venderemos|venderan)\b/.test(text);
  const requestedPastDay = /\b(ayer|anteayer)\b/.exec(text)?.[1];
  const tomorrow = /mañana|man\u0303ana|manana/i.test(message);
  const dayAfterTomorrow = /pasado\s+(?:mañana|man\u0303ana|manana)/i.test(message);
  const relativeFuture = tomorrow || dayAfterTomorrow
    || /\b(?:hoy|actual|actualmente|esta semana|la semana que viene|proxima semana|la proxima semana|el lunes que viene|dentro de \d+ dias?)\b/.test(text);
  const forecastFollowup = relativeFuture
    && ['demand_forecast', 'ml_analytics', 'forecast_risk_explanation'].includes(memory.lastIntent);
  const requestedDate = parseRequestedDate(text);
  if (forecastQuestion && requestedPastDay) {
    const requestedPastDate = addDays(now.toISOString().slice(0, 10), requestedPastDay === 'anteayer' ? -2 : -1);
    const product = message.match(/\bM5-[A-Z]+_\d+_\d+\b/i)?.[0]
      || memory.selectedProductReference?.sku || memory.lastEntity?.sku;
    if (!product) return { intent: 'ml_daily_granularity_clarification', agent: 'coordinator',
      clarificationQuestion: `¿De qué producto deseas consultar la predicción de ${requestedPastDay} (${dateLabel(requestedPastDate)})?` };
    return { intent: 'ml_daily_granularity_clarification', agent: 'coordinator',
      clarificationQuestion: `No puedo consultar una predicción diaria de ${product} para ${requestedPastDay} (${dateLabel(requestedPastDate)}). El modelo disponible ofrece un forecast histórico agregado de 7 días, no un valor diario para esa fecha.` };
  }
  if (!forecastQuestion && !futureSalesQuestion && !(relativeFuture && ['demand_forecast', 'ml_analytics', 'forecast_risk_explanation'].includes(memory.lastIntent))) return null;

  const scenario = Object.values(scenarios).find(row => row.businessId === businessId);
  if (requestedDate && scenario) {
    const firstForecastDay = addDays(scenario.anchorOperationalDate, 1);
    const lastForecastDay = addDays(scenario.anchorOperationalDate, scenario.horizonDays || 7);
    if (requestedDate >= firstForecastDay && requestedDate <= lastForecastDay
      && /\b(?:que se predijo|que predijo|prediccion para|demanda para|que demanda hubo|estimacion para)\b/.test(text)) {
      return { intent: 'ml_daily_granularity_clarification', agent: 'coordinator',
        clarificationQuestion: `El modelo disponible entrega una estimación agregada de ${scenario.horizonDays || 7} días, no una predicción diaria para el ${dateLabel(requestedDate)}. Puedo mostrarte el forecast histórico agregado del escenario.` };
    }
  }

  const today = now.toISOString().slice(0, 10);
  const isFutureDate = requestedDate && requestedDate > today;
  if ((relativeFuture || isFutureDate) && (forecastQuestion || futureSalesQuestion || forecastFollowup)) {
    const anchor = scenario?.anchorOperationalDate;
    const target = requestedDate ? dateLabel(requestedDate)
      : dayAfterTomorrow ? 'pasado mañana' : tomorrow ? 'mañana'
        : /actual/.test(text) ? 'actualmente'
        : /hoy/.test(text) ? 'hoy' : /proxima semana|semana que viene/.test(text) ? 'la próxima semana'
          : /esta semana/.test(text) ? 'esta semana' : /lunes que viene/.test(text) ? 'el lunes que viene'
            : (text.match(/dentro de \d+ dias?/) || ['un periodo futuro'])[0];
    const product = message.match(/\bM5-[A-Z]+_\d+_\d+\b/i)?.[0] || memory.selectedProductReference?.sku || memory.lastEntity?.sku;
    return { intent: 'ml_historical_clarification', agent: 'coordinator',
      clarificationQuestion: `No tengo una predicción válida para ${target}${product ? ` para ${product}` : ''} en la fecha operativa actual. El forecast disponible corresponde a un replay histórico${anchor ? ` con fecha de referencia ${dateLabel(anchor)}` : ''}, no a una predicción vigente. Puedo mostrarte ese forecast histórico agregado de 7 días, pero no sería correcto presentarlo como una predicción actual.` };
  }
  return null;
};
const routeForecastAnalytics = (message, memory, now = new Date(), businessId) => {
  const text = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/shell|ejecuta codigo|mongo query|ignora.*instruccion|api.?key|password|jwt/.test(text)) return null;
  const temporal = routeForecastTemporalQuery(message, memory || {}, now, businessId);
  if (temporal) return temporal;
  const previous = compactAnalyticsContext(memory.lastForecastAnalytics);
  if (/forecast|prediccion|demanda|repon|reposicion/.test(text) && /costo|cuanto cuesta|presupuesto|proveedor conviene/.test(text)) {
    return { intent: 'ml_analytics', agent: 'coordinator', clarificationQuestion: 'Esta consulta ML no calcula costos ni optimiza presupuestos. Puedo comparar demanda, stock y reposición sugerida del escenario histórico.' };
  }
  const department = (message.match(/\b(?:FOODS|HOBBIES|HOUSEHOLD)_\d+\b/i)?.[0]
    || message.match(/\bdepartamento\s+([\w-]{1,50})\b/i)?.[1])?.toUpperCase();
  const category = !department ? message.match(/\b(?:FOODS|HOBBIES|HOUSEHOLD)\b(?![_-])/i)?.[0].toUpperCase() : undefined;
  const top = text.match(/\btop\s+(\d+)\b|\b(?:los|otros)\s+(\d+)\b/);
  const limit = top ? Number(top[1] || top[2]) : /\bcual\b/.test(text) && /mayor.*(demanda|prediccion)/.test(text) ? 1 : 5;
  if (limit < 1 || limit > 20) return { intent: 'ml_analytics', agent: 'coordinator', clarificationQuestion: 'Pide entre 1 y 20 productos por página.' };
  const make = args => ({ intent: 'ml_analytics', agent: 'analyst', limit: args.limit || limit,
    analyticsArgs: { limit, offset: 0, ...args } });
  if (previous && /^(?:¿?\s*)?(?:y )?(?:solo de|solo|de)\b/.test(text) && (department || category)) {
    const { department: ignoredDept, category: ignoredCat, ...rest } = previous;
    return make({ ...rest, offset: 0, ...(department ? { department } : { category }) });
  }
  if (/^(?:¿?\s*)?(?:ver mas|siguiente|otros \d+|muestrame mas)[?!.\s]*$/.test(text) && previous && !['compare', 'summary'].includes(previous.mode)) {
    return make({ ...previous, limit: top ? limit : previous.limit, offset: previous.offset + previous.limit });
  }
  if (previous?.mode === 'compare' && /cual.*(comprar primero|reponer primero|mayor demanda|estos dos)/.test(text)) return make(previous);
  const explicitSkus = message.match(/\bM5-[A-Z]+_\d+_\d+\b/gi) || [];
  if (explicitSkus.length >= 2 && /\b(?:compara|comparar|versus|vs\.?|contra)\b/i.test(text)) {
    return make({ mode: 'compare', first: explicitSkus[0], second: explicitSkus[1] });
  }
  const comparison = message.match(/\bcompara(?:r)?\s+(?:(?:el )?producto\s+)?(.+?)\s+(?:con|y)\s+(?:(?:el )?producto\s+)?(.+?)[?.!]*$/i);
  if (comparison) return make({ mode: 'compare', first: comparison[1].trim(), second: comparison[2].trim() });
  if (/cual.*estos dos.*(demanda|prediccion)/.test(text)) return previous?.mode === 'compare' ? make(previous)
    : { intent: 'ml_analytics', agent: 'coordinator', clarificationQuestion: 'Indica los dos nombres o SKU para comparar.' };
  let mode;
  if (/sin (prediccion|forecast)|no tienen prediccion|fallo el ml|no ready/.test(text)) mode = 'not_ready';
  else if (/(mas|mayor) demanda.*stock|demanda.*(mas.*stock|supera.*(inventario|stock)|mayor.*stock)|no alcanza el stock/.test(text)) mode = 'exceeding_stock';
  else if (/resum.*(forecast|prediccion|reposicion|ml)|inventario.*segun.*ml/.test(text)) mode = 'summary';
  else if (/mayor (demanda|prediccion)|top.*demanda/.test(text)
    || (department || category) && /demanda|prediccion|top|forecast/.test(text)) mode = 'top';
  if (!mode) return null;
  return make({ mode, ...(department ? { department } : {}), ...(category ? { category } : {}) });
};
module.exports = { routeForecastAnalytics, routeForecastTemporalQuery, parseRequestedDate };
