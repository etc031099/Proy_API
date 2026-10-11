# Auditoría de colecciones y smoke UI-DATA-P2C.1

Auditoría previa al cambio: las rutas normales comparten backend y tenant autenticado. No hay pantallas independientes de clientes/proveedores: son pestañas de Contactos.

| Vista/componente | Endpoint | Antes: límite, búsqueda, filtros, total | Riesgo / decisión |
|---|---|---|---|
| Contactos, clientes y proveedores | /contacts, /contacts/customers, /contacts/vendors | Backend página 10, búsqueda y tipo; frontend sin páginas ni total | Truncamiento visible. MODIFICADA |
| Productos | /products | Página 10/25/50, búsqueda, total real | Navegación correcta; reforzar orden estable y respuestas fuera de orden. MODIFICADA |
| Transacciones (ventas/compras) | /transactions | Página 10, búsqueda/tipo/estado, total real | YA ESTABA BIEN; facturas son detalle individual |
| Reportes inventario | /reports/inventory | Descarga completa; tabla slice(0,10), categoría y orden; estadísticas globales | Truncamiento visible y descarga innecesaria. MODIFICADA |
| Reportes cliente/proveedor | /contacts/customers, /contacts/vendors; /reports/customer/:id, /reports/vendor/:id | Selector con primera página 10; reporte individual con agregados/top 10 | Selector MODIFICADO; agregados individuales preservados |
| Venta: cliente y productos | /contacts, /products | Primera página 10; búsqueda local sobre esa página | Catálogo incompleto. MODIFICADA |
| Compra: proveedor y productos | /contacts/vendors, /products | Proveedores 100; productos 10; oferta filtrada localmente | Catálogo incompleto y selector masivo. MODIFICADA |
| Producto nuevo/editar: proveedores | /contacts/vendors | Hasta 100 opciones; preferido dentro de relaciones del producto | Selector de oferta MODIFICADO; preferido conserva solo relaciones seleccionadas |
| Dashboard | /reports/dashboard | Agregados, top 5 y recientes intencionalmente limitados | YA ESTABA BIEN: resumen, no listado completo |
| Reportes transacciones | /reports/transactions | Agregados completos y recientes explícitamente limitados | YA ESTABA BIEN: resumen |
| Forecast | /ml/demand-forecast | Batch ML completo con búsqueda/filtros locales y ranking | FUERA DE ALCANCE: contrato/inferencia ML excluidos por esta fase |
| Asistente/historial/candidatos | /agent/messages, /agent/conversations | Historial server-side 10/50; candidatos paginados | FUERA DE ALCANCE: runtime conversacional excluido |
| Alertas/reglas/entregas/notificaciones | Consultas del asistente; Integraciones | No listado UI independiente; consultas acotadas | FUERA DE ALCANCE |
| Usuarios, movimientos | Sin listado UI independiente | Formularios auth/detalles de transacción | No colección navegable adicional |
| Integraciones, mapas | Estado individual/API externa | Estado Telegram, mapa/servicio externo | FUERA DE ALCANCE |

Patrón: contrato existente `data.pagination {current,pages,total,limit}`; contactos y selectores 20 por página, productos conserva 10/25/50; límite API máximo 100. Búsqueda literal escapada, orden con `_id` como desempate, conteos con el mismo filtro de tenant. Selectores remotos con debounce 300 ms, página reiniciada al buscar y selección hidratada por ID cuando no está en la página visible. No se crean índices nuevos.

Exportación de inventario: sigue exportando el conjunto filtrado completo a solicitud del usuario, independientemente de la página visible. La consulta de vista usa paginación; las estadísticas siguen correspondiendo a todo el filtro.

Mojibake: la búsqueda de `Ã`, `Â` y `â€` en las páginas revisadas y LanguageContext no encontró coincidencias. No se hicieron reemplazos de codificación.

## Resultado de la auditoría

| Vista | Antes | Después | Backend paginado | Búsqueda | Total | Selector |
|---|---|---|---|---|---|---|
| Contactos/clientes/proveedores — MODIFICADA | Solo 10 sin navegación | 20 + anterior/siguiente | Sí | Remota literal | Real | No aplica |
| Productos — MODIFICADA | Paginación existente, orden sin desempate | Orden estable y respuestas viejas ignoradas | Sí | Remota | Real | No aplica |
| Reportes inventario — MODIFICADA | Descarga completa y muestra 10 | Página 20 + estadísticas globales del filtro | Sí con page; consulta sin page conserva exportación completa | Remota + categoría | Real | No aplica |
| Reportes clientes/proveedores — MODIFICADA | Selector incompleto | Búsqueda y páginas limitadas | Sí | Remota 300 ms | Real | Buscable con selección persistente |
| Venta — MODIFICADA | Catálogo limitado a 10 + búsqueda local | Cliente/producto buscables | Sí | Remota 300 ms | Real | Conserva IDs y labels |
| Compra — MODIFICADA | Proveedores 100, productos 10 | Proveedor/producto buscables; ofertas filtradas server-side | Sí | Remota 300 ms | Real | Conserva selección |
| Producto nuevo/editar — MODIFICADA | Proveedores 100 | Proveedores buscables para relaciones | Sí | Remota 300 ms | Real | Preferido limitado a relaciones seleccionadas |
| Transacciones — YA ESTABA BIEN | Página 10 + filtros y total | Preservado | Sí | Remota | Real | No aplica |
| Dashboard/reportes transacciones — YA ESTABA BIEN | Resúmenes/top/recientes explícitos | Preservado | Resumen | Filtros existentes | Agregados | No aplica |
| Detalle factura/transacción, editar contacto — YA ESTABA BIEN | Entidad individual | Preservado | No aplica | No aplica | No aplica | No colección |
| Forecast — FUERA DE ALCANCE | Batch ML completo | Preservado | No | Local | Batch | Contrato ML excluido |
| Asistente, alertas/reglas/entregas — FUERA DE ALCANCE | Runtime/consultas acotadas | Preservado | Según contrato existente | Existente | Existente | Candidatos existentes |
| Usuarios/movimientos — SIN VISTA DE COLECCIÓN | Auth/detalles individuales | Preservado | No aplica | No aplica | No aplica | No aplica |
| Integraciones/mapas — FUERA DE ALCANCE | Estado/API externa | Preservado | No aplica | Existente | No aplica | No catálogo de negocio |

La API conserva el contrato de exportación sin `page`; la vista siempre envía `page`. No se crea un endpoint de exportación nuevo. Solo una exportación solicitada descarga el conjunto completo.

Archivos de fase: controladores contact/product/report, rutas contacts/reports, validations, helpers listPagination/paginatedInventoryReport; páginas contacts/products/reports/sale/purchase/new-product/edit-product; PaginationControls, RemoteEntitySelect, api.ts, types/index.ts; pruebas paginationControllers, remoteEntitySelect, contactsPagination y vitest.config.ts; este documento.

## Smoke manual posterior

Validación local: backend focal 8/8 y completo 951/951; frontend 93/93 y helpers 8/8; TypeScript, build, sintaxis y diff checks correctos. Lint de los archivos nuevos y páginas sin errores previos correcto. El lint ampliado conserva seis errores `any` preexistentes en contactos, nuevo/editar producto, compra y venta; no se modificaron para esta fase. No se realizó smoke autenticado cloud ni validación visual en navegador: los pasos siguientes quedan para después de publicar.

1. Contactos: abrir todas/clientes/proveedores, comprobar total y 1–20, avanzar a 21–40, retroceder; buscar desde página 2 y comprobar página 1. Borrar el último registro de una última página solo en entorno de prueba y comprobar ajuste de página.
2. Reportes → Inventario: avanzar/retroceder, buscar SKU y filtrar categoría; conservar filtro al paginar. Exportar CSV/PDF y verificar que incluyen todos los productos filtrados, no solo la página.
3. Venta: buscar cliente fuera de primera página, seleccionarlo y volver a buscar; la selección permanece. Buscar producto por SKU fuera de primera página. Preparar formulario sin registrar venta.
4. Compra: buscar proveedor, elegirlo y buscar productos; solo ofertas válidas de ese proveedor. Cambiar proveedor y comprobar validación existente. No registrar compra.
5. Productos nuevo/editar: buscar proveedor fuera de primera página, agregar relación y precio, comprobar label seleccionado al cambiar búsqueda; editar relación existente fuera de primera página. No guardar durante smoke cloud.
6. Reportes cliente/proveedor: buscar contacto, paginar coincidencias, seleccionar y comprobar reporte individual.
7. Productos/transacciones: comprobar navegación y filtros existentes, estados vacío/error y controles móviles a 390 px.
