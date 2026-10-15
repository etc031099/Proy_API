'use strict';
const normalize = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[¿?¡!.]/g, '').replace(/\s+/g, ' ').trim();
const OUT_OF_DOMAIN_ANSWER = 'Puedo ayudarte con ventas, inventario, clientes, proveedores, compras, pronósticos e inteligencia de tu negocio. Esa consulta está fuera de ese ámbito.';

// Exact external question shapes, not a blacklist of product names or currencies.
// Explicit catalogue references and mixed business questions are left to normal routing.
const isOutOfDomain = message => {
  const text = normalize(message);
  if (/\b(?:ventas?|inventario|stock|clientes?|proveedores?|catalogo|producto|negocio|empresa)\b/.test(text)) return false;
  const sportsTime = '(?:hoy|ayer|manana|pasado manana|esta semana|esta noche|el domingo|domingo|el sabado|sabado|el lunes|lunes|el martes|martes|el miercoles|miercoles|el jueves|jueves|el viernes|viernes)';
  const sportsQuestion = new RegExp(`^(?:quien(?:es)? juega(?:n)? (?:${sportsTime})|que partidos? hay (?:${sportsTime})|quien(?:es)? gano (?:(?:el )?partido )?(?:${sportsTime}))$`);
  return sportsQuestion.test(text)
    || /^(?:quien gano (?:el )?partido(?: de)? ayer|(?:cual es la )?capital de francia|cuentame un cuento|que laptop me recomiendas|cuanto cuesta bitcoin|quien es el presidente de [\p{L}\s]+|como escribo un curriculum)$/u.test(text);
};
module.exports = { normalize, isOutOfDomain, OUT_OF_DOMAIN_ANSWER };
