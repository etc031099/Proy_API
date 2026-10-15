'use strict';
// Bounded language aliases only; quantities, codes and stored names are unchanged.
const normalizeConversationalInput = message => message
  .replace(/^me equivoqu[eé],?\s*quiero\s+(\S+?)(?:\s+unidades?)?[.!]?$/i, 'mejor $1')
  .replace(/\bventas del mes\b/gi, 'ventas de este mes')
  .replace(/\bq\b/gi, 'que')
  .replace(/\bdl\b/gi, 'del')
  .replace(/\bd(?=\s+(?:el|la|los|las)\b)/gi, 'de')
  .replace(/\bse ta\b/gi, 'se esta')
  .replace(/\bproveedor ta\b/gi, 'proveedor esta')
  .replace(/\bcomo tan\b/gi, 'como estan')
  .replace(/\bcuanto ha gastado\b/gi, 'cuanto gasto')
  .replace(/\bproductos? repongo\b/gi, 'productos deberia reponer')
  .replace(/^que compro esta semana[?!.]*$/i, 'que productos deberia reponer esta semana')
  .replace(/\s+(?:ps|pls|porfa)[?!.]*$/i, '');
module.exports = { normalizeConversationalInput };
