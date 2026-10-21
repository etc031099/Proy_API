'use strict';
// Independent editorial utterances. No generated accent/punctuation variants.
// Labels are offline semantic oracles, not predictions measured on a real LLM.
const groups = {
  INVENTORY_FORECAST: ['¿Necesito reposición de cocinero y cuánta demanda habrá en 14 días?'],
  FORECAST_MODEL_STATUS: ['Consulta la versión técnica de cocinero'],
  FORECAST_METHOD: ['Describe cómo se obtiene la estimación de demanda'],
  TOP_SELLING_PRODUCTS: [
    'q mas se vende?', 'q productos se vende mas?', 'q producto vendo mas?', 'q es lo q mas sale?',
    'q cosa sale mas', 'lo q mas vendo', 'mis productos top', 'q producto se mueve más', 'cual compran mas',
    'top ventas', 'q se vendio mas', 'que tiene mas salida', 'productos más vendidos', 'ranking de ventas',
    'dime los artículos más populares por unidades', 'q mas sale x aca ultimamente', 'q cosas se estan moviendo mas',
    'qué artículos lideran las ventas', 'muestra el ranking de productos vendidos', 'qué mercancía tiene mayor rotación comercial',
    'ordena lo vendido por cantidad', 'qué se llevan más seguido', 'dónde está el mayor volumen vendido',
    'necesito ver los líderes en unidades', 'qué artículos encabezan mi facturación', 'lista de favoritos por ventas',
    'cuáles salen como pan caliente', 'lo más solicitado en caja', 'dime mi top por unidades', 'qué productos tienen más salida'
  ],
  INVENTORY_LOOKUP: [
    'stock del pan', 'stock pan', 'cuanto pan queda', 'cuanto queda d la coca?', 'hay cocinero?', 'queda leche',
    'q tal el stock de ese', 'existencias del primor', 'dame stock d la coca', 'cuántas unidades hay de bimbo',
    'cuánto tenemos de aceite', 'revísame lo que queda de pan francés', 'sigue habiendo coca en almacén',
    'de la bimbo cuánto hay', 'mira la existencia de cocinero', 'necesito saber el saldo de pan',
    'consulta stock de ABA-ACE-001', 'tenemos primor disponible', 'el cocinero está disponible',
    'revisa cuántas botellas de coca quedan', 'stock actual de pan francés', 'cuánto inventario tengo de arroz',
    'hay alguna leche en existencia', 'cuántos paquetes de pan quedan', 'qué saldo tiene ese producto',
    'dime las unidades disponibles del cocinero', 'queda algo del primor', 'cuánto me queda del bimbo',
    'quiero consultar el inventario del pan', 'consulta las existencias de ese'
  ],
  LOW_STOCK: [
    'q tengo poco?', 'q se ta acabando', 'que anda bajo', 'productos con poco stock', 'stock bajo',
    'muéstrame productos por acabarse', 'dime qué productos están debajo del mínimo', 'qué existencias están escasas',
    'hay productos casi agotados', 'lista lo que queda poquito', 'q tengo con poco stock', 'qué artículos andan bajos',
    'se me está acabando algo del inventario', 'quiero los productos con stock bajo y su mínimo',
    'qué artículos tienen menos que el mínimo configurado', 'busco mercancía con pocas existencias',
    'muéstrame lo que anda escaso', 'qué productos están cortos de stock', 'dónde me estoy quedando sin existencias',
    'inventario que ya está por terminarse', 'qué bienes tienen stock insuficiente', 'qué tengo escaso en almacén',
    'cuáles tienen poquitas unidades', 'enséñame el stock que falta al mínimo', 'productos que quedan muy pocos'
  ],
  REPLENISHMENT: [
    'q compro', 'q debo comprar?', 'q debo reponer', 'q debería pedir', 'q me falta comprar',
    'q tengo q reponer esta semana', 'qué artículos necesitan reposición', 'que comprarias para el negocio',
    'q producto necesita reposicion', 'qué debería reabastecer', 'qué tengo q comprar para no quedarme corto',
    'muéstrame los productos que debería reponer', 'necesidades de abastecimiento', 'quiero sugerencias de reposición',
    'qué mercancía debo volver a pedir', 'dime las compras sugeridas de inventario', 'qué artículos conviene reponer',
    'de qué productos debo hacer pedido', 'cuáles debería pedir al proveedor', 'qué me recomiendas reabastecer',
    'necesito la lista para reposición', 'qué productos debería encargar', 'cuáles necesitan otro pedido',
    'plan de reabastecimiento sin ejecutar compras', 'qué hay que volver a comprar'
  ],
  FORECAST: [
    'pronostico cocinero', 'pronostico del cocinero', 'cuanto se vendera del cocinero?', 'cuanto venderemos',
    'q se espera vender', 'como viene la demanda', 'esto se vendera', 'cuanto podria salir', 'q dice el pronostico',
    'cómo viene el cocinero', 'ventas esperadas mañana', 'pronóstico de mañana', 'cuánto venderé mañana',
    'forecast de mañana', 'demanda esperada mañana', 'cuánto se venderá de Sprite mañana',
    'pronóstico del pan para mañana', 'forecast 1 día', 'pronóstico de pan francés próximos 7 días',
    'predicción de bimbo próximos 14 días', 'demanda estimada del primor', 'estimación de unidades del cocinero',
    'qué volumen esperar del pan', 'cómo se proyecta la demanda de ese', 'cuanto crees q salga este',
    'cuántas unidades prevés que se vendan', 'cuánto podría vender del aceite', 'calcula la previsión del pan',
    'qué cantidad estiman para la próxima semana', 'demanda futura del producto activo'
  ],
  CUSTOMERS_AT_RISK: [
    'clientes en riesgo', 'quien ya no viene', 'q clientes se estan perdiendo', 'quien ya no compra',
    'clientes q debo recuperar', 'a quienes debería llamar xq ya no vienen', 'qué compradores dejaron de venir',
    'lista clientes inactivos', 'quién lleva tiempo sin comprarme', 'clientes para retención',
    'qué clientes necesito recuperar', 'muéstrame compradores alejados', 'quiénes dejaron de comprar recientemente',
    'clientes que hace mucho no veo', 'cuáles se están ausentando', 'qué compradores están desconectados',
    'a quién conviene recordar que vuelva a comprar', 'muéstrame clientes con recencia alta',
    'qué clientes no han retornado', 'quiénes no vuelven al negocio', 'lista para recuperar compradores',
    'clientes q ya no compran', 'compradores que debemos intentar reactivar', 'identifica clientes que se están perdiendo',
    'a qué clientes llamar por inactividad'
  ],
  CUSTOMER_VALUE: [
    'mis mejores clientes', 'quienes gastan más', 'clientes de alto valor', 'qué clientes compran más por gasto',
    'muéstrame los clientes con mayor gasto', 'ranking de clientes por dinero gastado', 'clientes más valiosos',
    'quiénes aportan más compras en dinero', 'dime los compradores de alto valor', 'top clientes por gasto',
    'clientes que más dinero gastan', 'cuáles son mis compradores de mayor valor', 'personas que más compran en soles',
    'muéstrame TOP_HIGH_VALUE', 'dime los de mayor gasto observado', 'me interesan compradores de gasto alto',
    'ranking monetario de clientes', 'cuáles clientes destacan por gasto', 'busco clientes de gran valor comercial',
    'quién ha gastado más en el negocio'
  ],
  CUSTOMER_ACTIVITY: [
    'actividad de clientes', 'qué actividad tienen mis clientes', 'cómo compran mis clientes', 'resumen de actividad de compradores',
    'cuántos clientes tuvieron actividad', 'muestra visitas de clientes', 'compras recientes de los compradores',
    'qué movimientos tienen mis clientes', 'quiero ver actividad de compradores', 'cómo está la actividad de clientes',
    'lista la actividad reciente de clientes', 'seguimiento de actividad de compradores', 'resumen de compras por cliente',
    'qué clientes estuvieron activos', 'muéstrame la actividad comercial de clientes', 'qué clientes están comprando actualmente',
    'necesito revisar frecuencia de compra de clientes', 'cuántas compras hacen mis clientes',
    'dime la actividad observada en clientes', 'revisemos las compras recientes de los clientes'
  ],
  SUPPLIER_PERFORMANCE: [
    'proveedores puntuales', 'proveedores mas puntuales', 'quien llega tarde?', 'quien cumple mas', 'mejor proveedor',
    'quien entrega mejor', 'q proveedor es mas puntual', 'qué proveedores se retrasan', 'puntualidad de proveedores',
    'ranking de proveedores por entregas', 'qué proveedor está llegando tarde', 'cuál cumple mejor los plazos',
    'quién retrasa las entregas', 'compara puntualidad entre proveedores', 'qué proveedor tiene más demora',
    'quién abastece con menos retrasos', 'dime el cumplimiento de proveedores', 'a quién le tardan los pedidos',
    'revisa desempeño de proveedores', 'los proveedores están cumpliendo', 'qué proveedor respeta los tiempos',
    'quién tiene mejor historial de entrega', 'muéstrame tardanzas de proveedores', 'q proveedor ta llegando tarde',
    'a qué proveedor se le atrasan los pedidos'
  ],
  CROSS_SELL: [
    'q se compra con ese?', 'q se compra con el pan', 'con q sale ese', 'q llevan junto al pan', 'q le ofrezco con ese',
    'algo q combine con ese', 'qué compran junto al primor', 'productos relacionados con cocinero',
    'qué se compra con PAN-FRE-001', 'recomendaciones de venta cruzada del pan', 'asociaciones del pan francés',
    'qué acompaña a la compra de coca', 'qué otro producto llevan con bimbo', 'con qué compran ese producto',
    'qué artículos se llevan juntos con el pan', 'dame asociaciones de compra del aceite',
    'qué suelen comprar junto con el primor', 'busca reglas de cesta para el cocinero', 'qué productos acompañan ese',
    'qué ofrezco junto a ese producto', 'dime pares asociados al pan', 'qué complementa la compra del arroz',
    'qué reglas de canasta hay para bimbo', 'relaciones de compra de ese', 'muestra venta cruzada del producto activo'
  ],
  BUSINESS_HEALTH: [
    'cómo está mi negocio', 'q tal el negocio', 'cómo vamos con el negocio', 'salud del negocio', 'diagnóstico del negocio',
    'muéstrame el estado de la empresa', 'hay algo mal en mi negocio', 'revisión general del negocio',
    'cómo están las cosas en la tienda', 'qué indicadores del negocio revisar', 'necesito un diagnóstico comercial',
    'dime el estado general de mi tienda', 'qué debería vigilar en el negocio', 'cómo viene la tienda en general',
    'revisa la salud de la empresa', 'qué tal está operando mi negocio', 'quiero ver señales del negocio',
    'muestra la salud comercial', 'cómo está el panorama de mi tienda', 'revísame el negocio'
  ],
  SALES_SUMMARY: [
    'como van mis ventas', 'cómo tan mis ventas', 'cuánto vendí', 'dame el resumen de ventas', 'cuántos tickets tuve',
    'ventas últimos 7 días', 'ventas de hoy', 'ingresos de este mes', 'cuánto facturamos', 'resumen comercial de ventas',
    'cuántas unidades vendimos', 'total de ventas de ayer', 'quiero mis cifras de ventas', 'ticket promedio de ventas',
    'qué total ingresó por ventas', 'dime las ventas de 30 días', 'cuánto vendió el negocio', 'reporte de facturación actual',
    'ventas en soles', 'resumen de tickets de hoy', 'cuántos tickets de venta salieron', 'cuánto recaudamos en ventas',
    'totales de venta del período', 'consulta mis ventas', 'dime el importe vendido'
  ],
  SALES_EVOLUTION: [
    'cómo han evolucionado las ventas', 'qué tendencias observas en ventas', 'qué debería vigilar en ventas',
    'cómo vienen las ventas y qué revisar', 'compara mis ventas con el período anterior', 'las ventas están subiendo',
    'analiza si están cayendo las ventas', 'qué cambios notas en ingresos', 'evolución reciente de facturación',
    'quiero entender la variación de ventas', 'qué observar de la evolución comercial', 'interpreta la comparación de ventas',
    'se está vendiendo mejor que antes', 'hay crecimiento en mis ventas', 'cómo cambió el volumen vendido',
    'qué muestran las variaciones de facturación', 'estamos vendiendo menos que el período anterior',
    'dime si mejoró el ritmo de ventas', 'cómo fue la evolución de tickets vendidos', 'explica las tendencias comerciales'
  ],
  PRODUCT_SEARCH: [
    'busca producto primor', 'busca cocinero', 'busca pan francés', 'encuentra el producto bimbo', 'buscar leche gloria',
    'muéstrame coincidencias de coca', 'busca un producto llamado primor', 'quiero encontrar coca cola',
    'localiza el SKU ABA-ACE-002', 'consulta el catálogo buscando bimbo', 'busca productos de marca gloria',
    'encuentra aceite cocinero', 'busca pan en el catálogo', 'localiza el producto PAN-FRE-001',
    'muéstrame los productos llamados primor'
  ],
  CREATE_SALE: [
    'vende dos panes', 'vende 2 primor', 'registra una venta de 3 cocinero', 'vende 4 unidades de bimbo',
    'vende 1 PAN-FRE-001', 'quiero registrar una venta de 2 coca', 'vender tres panes franceses',
    'prepara la venta de 5 cocinero', 'registra venta de 6 panes', 'vende dos del producto activo',
    'vende siete panes', 'necesito vender 3 bimbo', 'vende una unidad de primor',
    'prepara una venta con dos panes', 'quiero vender 4 paquetes de pan'
  ],
  CONFIRM_WRITE: [
    'si hazlo', 'confirmar', 'confirma', 'confirmalo', 'confirmo', 'si confirmar', 'si confirma', 'si procede',
    'hazlo', 'procede', 'adelante', 'acepto', 'de acuerdo', 'ok confirma', 'correcto confirma'
  ],
  CANCEL_WRITE: [
    'mejor no', 'cancelalo', 'dejalo', 'cancela', 'cancelar', 'no lo hagas', 'ya no', 'descarta', 'olvidalo',
    'anula', 'no quiero hacerlo', 'descartalo', 'mejor cancela eso', 'cancelo', 'mejor no cancela'
  ],
  AMBIGUOUS: [
    'pan', 'a quien debería llamar?', 'ya dale', 'saca dos panes', 'retira 2 panes', 'registrame 2 panes',
    'ponme dos de ese', 'como viene ese producto', 'cuales andan medio flojos', 'q me conviene mirar hoy',
    'q me recomiendas?', 'me falta algo', 'a quien llamo', 'cual anda mal', 'cómo vamos', 'hay algo mal',
    'como estan las cosas', 'q debería vigilar', 'y ese?', 'el segundo', 'cuánto de ese', 'eso de antes',
    'me ayudas con lo de ayer', 'quiero ver lo otro', 'qué tal va', 'revisa eso', 'el primero', '2', 'ese producto', 'haz algo'
  ],
  OUT_OF_DOMAIN: [
    'de q equipo eres hincha?', 'como estas', 'cuentame algo', 'quien juega hoy', 'clima', 'bitcoin', 'peliculas', 'musica',
    'cuéntame un cuento', 'cuánto cuesta Bitcoin', 'capital de Francia', 'quien juega mañana', 'qué partido hay mañana',
    'qué partidos hay esta semana', 'quién juega el domingo', 'quién ganó ayer', 'cuál es tu equipo favorito',
    'cuéntame un chiste', 'qué música escuchas', 'recomiéndame una película', 'hola', 'dame una receta de cocina',
    'quién es el presidente de Perú', 'qué clima hace mañana', 'cómo escribo un curriculum'
  ]
};
module.exports = Object.freeze(Object.entries(groups).flatMap(([intent, messages]) => messages.map(message => Object.freeze({ intent, message }))));
