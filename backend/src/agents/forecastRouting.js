const { compactAnalyticsContext } = require('./forecastAnalytics');
const routeForecastAnalytics = (message, memory) => {
  const text = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/shell|ejecuta codigo|mongo query|ignora.*instruccion|api.?key|password|jwt/.test(text)) return null;
  if (/forecast|prediccion|demanda|que pasara/.test(text) && /\b(hoy|actual|esta semana)\b/.test(text)) {
    return { intent: 'ml_historical_clarification', agent: 'coordinator',
      clarificationQuestion: 'El modelo utiliza un replay histórico, no un forecast del mercado actual. Puedo consultar el escenario y su fecha de corte, pero no predecir hoy ni la semana actual.' };
  }
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
module.exports = { routeForecastAnalytics };
