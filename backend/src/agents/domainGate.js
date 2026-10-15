'use strict';
const normalize = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[¿?¡!.]/g, '').replace(/\s+/g, ' ').trim();
const OUT_OF_DOMAIN_ANSWER = 'Puedo ayudarte con ventas, inventario, clientes, proveedores, compras, pronósticos e inteligencia de tu negocio. Esa consulta está fuera de ese ámbito.';
const isUnsafeControlRequest = message => /(?:ignora|olvida|omite).{0,45}(?:instruccion|confirmacion)|(?:muestra|dime|dame|revela).{0,35}(?:prompt|api.?key|jwt|uri de mongo|razonamiento interno|reasoning_content)|confirma automaticamente|actua como administrador.{0,30}elimina/.test(normalize(message));

// Exact external question shapes, not a blacklist of product names or currencies.
// Explicit catalogue references and mixed business questions are left to normal routing.
const isOutOfDomain = message => {
  const text = normalize(message);
  if (isUnsafeControlRequest(message)) return true;
  if (/^(?:hola[ ,]*)?(?:como estas|que tal|buenos dias|buenas tardes|buenas noches|hola)$/.test(text)) return true;
  if (/\b(?:ventas?|inventario|stock|clientes?|proveedores?|catalogo|productos?|negocio|empresa)\b/.test(text)) return false;
  if (/^(?:de (?:q|que) equipo eres hincha|(?:cual es )?tu equipo favorito|cual es tu equipo favorito|cual es tu comida favorita|cuentame un (?:chiste|cuento)|resultado del partido|clima de hoy|quien es el presidente|receta de pollo|dame una pelicula|que musica escuchas)$/.test(text)
    || /\b(?:eres hincha|equipo favorito|comida favorita|musica escuchas)\b/.test(text)
    || /^(?:cuentame|dime|dame|recomiendame)\b.{0,25}\b(?:chiste|cuento|pelicula|receta)\b/.test(text)
    || /^que clima (?:hace|hay)\b/.test(text)) return true;
  const sportsTime = '(?:hoy|ayer|manana|pasado manana|esta semana|esta noche|el domingo|domingo|el sabado|sabado|el lunes|lunes|el martes|martes|el miercoles|miercoles|el jueves|jueves|el viernes|viernes)';
  const sportsQuestion = new RegExp(`^(?:quien(?:es)? juega(?:n)? (?:${sportsTime})|que partidos? hay (?:${sportsTime})|quien(?:es)? gano (?:(?:el )?partido )?(?:${sportsTime}))$`);
  return sportsQuestion.test(text)
    || /^(?:quien gano (?:el )?partido(?: de)? ayer|(?:cual es la )?capital de francia|cuentame un cuento|que laptop me recomiendas|cuanto cuesta bitcoin|precio (?:de|del) bitcoin|que clima hay (?:hoy|manana)|(?:dame |quiero )?una receta de cocina|quien es el presidente de(?:l)? [\p{L}\s]+|como escribo un curriculum)$/u.test(text);
};
module.exports = { normalize, isOutOfDomain, isUnsafeControlRequest, OUT_OF_DOMAIN_ANSWER };
