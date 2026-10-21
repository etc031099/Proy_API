'use strict';

// Matching/extraction only: never rewrite stored names, codes or action quantities.
const normalizeProductReference = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/^[\s"'«»“”¿?¡!]+|[\s"'«»“”¿?¡!.,;:]+$/g, '').trim().replace(/\s+/g, ' ')
  .replace(/^(?:(?:de|del|el|la|los|las|un|una)\s+)+/, '')
  .replace(/\bpanes\b/g, 'pan').replace(/\bfranceses\b/g, 'frances')
  .replace(/\bcoca[ -]*colas?\b/g, 'coca cola');
const isContextualProductReference = value => /^(?:(?:ese|esa|este|esta)(?: mism[oa])?|eso|lo|la|el anterior|la anterior|el mismo|la misma|su)(?: (?:mism[oa] )?(?:producto|articulo|item|pronostico|forecast|estimacion|prediccion))?$/.test(
  String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[¿?¡!.]/g, '').trim());
const extractProductReference = message => {
  const text = String(message || '').replace(/[¿?¡!]/g, '').trim();
  const code = text.match(/\b(?:[a-z]{2,}(?:-[a-z0-9]+){1,5}|M5-[a-z]+_\d+_\d+)\b/i);
  const sku = code && (/\d/.test(code[0]) || /^[A-Z]{2,}(?:-[A-Z]{2,})+$/.test(code[0])
    && !text.slice(code.index + code[0].length).replace(/[.!?]/g, '').trim()) ? code[0] : null;
  if (sku) return sku;
  const match = text.match(/(?:\bjunto con\b|\bjunto a\b|\bcon\b|\bde(?:l)?\b(?!\s+aqu[ií]\b))\s+(.+?)(?:\s+y\s+|$)/i)
    || text.match(/\b(?:reponer|reabastecer|pedir)\s+(.+?)(?:\s+y\s+|$)/i);
  const ref = match?.[1]?.trim().replace(/\s+(?:(?:para|a|en|de aqu[ií] a)\s+(?:(?:los|las|estas?|estos?)\s+)?(?:pr[oó]xim[oa]s?\s+)?(?:\d+|dos|una)\s+(?:d[ií]as?|semanas?)|o\s+(?:(?:todav[ií]a|a[uú]n)\s+(?:aguanta|alcanza)|repongo)\b|hoy|ayer|anteayer|esta semana|este mes|el mes pasado|los pr[oó]ximos|los [uú]ltimos|en los|durante|para ma[ñn]ana|ma[ñn]ana|por favor|el \d+ de).*$/i, '').replace(/[.!?]+$/, '').trim();
  if (!ref) return null;
  const normalized = normalizeProductReference(ref);
  if (/^(?:el|ella|ellos|ayer|hoy|anteayer|manana|\d+ dias?|los? ultimos? \d+ dias?)$/.test(normalized)) return null;
  return isContextualProductReference(ref) ? ref : ref.replace(/^(?:(?:el|la|los|las)\s+)+/i, '');
};
module.exports = { normalizeProductReference, isContextualProductReference, extractProductReference };
