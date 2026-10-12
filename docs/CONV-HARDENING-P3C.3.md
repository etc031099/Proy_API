# CONV-HARDENING-P3C.3 — cierre de hallazgos P1

## Alcance y trazabilidad

Se corrigieron únicamente los seis P1 identificados en el resultado real de la auditoría P3C.2 (`docs/CONV-HARDENING-P3C.2.json`). El reporte máquina-a-máquina de esta fase conserva los 827 casos y sus resultados, registra su comparación contra P3C.2 y enlaza los seis casos afectados con su clasificación y severidad anteriores: `docs/CONV-HARDENING-P3C.3.json`. El campo `evaluationBasis` deja constancia de que se evaluó el árbol de trabajo probado antes del commit, tomando HEAD previo como referencia.

| Caso | Hallazgo previo | Resultado P3C.3 |
| --- | --- | --- |
| U-0034 | “cuánto es el stock mínimo de food 2 96” se interpretaba como inventario bajo | PASS: consulta el atributo mínimo del producto; no lista productos bajo mínimo |
| U-0037 | “food 96 stock mínimo” se interpretaba como inventario bajo | PASS: resuelve el producto y responde su mínimo |
| U-0432 | `OPEN` no se convertía en filtro de estado | PASS: `InventoryAlert` con estado `OPEN` y alcance del producto conservado |
| U-0439 | “alertas pendientes de reintento” se confundía con eventos y tomaba “reintento” como producto | PASS: consulta el outbox con semántica pendiente/reintentable; sin búsqueda de producto |
| U-0440 | “outbox de alertas” se enviaba al listado de eventos | PASS: consulta el outbox/entregas, separado de los eventos generados |
| S-076 | El nombre visible “Alimentos M5 · FOODS_2 · Ítem 096” no resolvía el producto ni establecía contexto | PASS: extrae identidad estructurada `M5-FOODS_2_096`; el seguimiento “¿Y el stock mínimo?” usa ese mismo producto |

## Correcciones

- El routing de detalle reconoce las dos formas explícitas de preguntar por el stock mínimo antes de la ruta general de bajo stock. La forma con producto al final solo toma como referencia explícita un prefijo numérico; una pregunta general de productos con stock mínimo mantiene su intención colectiva.
- Los eventos de inventario aceptan `OPEN` explícito como estado abierto, conservando la búsqueda de producto.
- El vocabulario `outbox`/`reintento` se enruta a entregas del outbox antes del listado genérico de eventos. “Pendiente de reintento” usa el filtro pendiente ya existente, que incluye entregas pendientes y fallos reintentables. El vocabulario de transporte no se interpreta como nombre de producto.
- Los nombres visibles estructurados de producto se convierten en SKU solo para el formato del catálogo (`FOODS`, `HOBBIES` o `HOUSEHOLD`, grupo e ítem separados por el separador de presentación). No se amplió la coincidencia difusa ni la identidad numérica.

Los casos son determinísticos: 0 llamadas LLM y 0 tokens. Las lecturas de dominio permanecen tenant-scoped y separan reglas configuradas, eventos generados y entregas del outbox.

## Validación

- Casos P1 objetivo: 6/6 PASS; 0 objetivos ausentes.
- Auditoría conversacional completa: 827 casos (700 consultas individuales, 120 secuencias y 7 probes estructurales).
- Clasificación final: 652 PASS, 121 FAIL, 12 PARTIAL, 28 NOT_SUPPORTED y 14 NEEDS_MANUAL.
- Severidad de fallos: P0 = 0, P1 = 0, P2 = 120, P3 = 1; 0 regresiones críticas nuevas.
- Regresión P3C.1: 12/12 PASS.
- Regresión P3C.2: 9/9 PASS.
- Suite backend completa: 1118/1118 PASS.
- Frontend sin cambios.

Los 120 P2 y el P3 se mantienen fuera del alcance de esta fase; no se relajaron sus expectativas ni se hicieron cambios para ocultarlos.

## Smoke cloud sugerido

Tras publicar este commit, probar en una sesión autenticada:

1. “¿Cuánto es el stock mínimo de food 2 96?”
2. “food 96 stock mínimo”
3. “alertas OPEN del food 096”
4. “alertas pendientes de reintento”
5. “outbox de alertas”
6. “¿Cuánto stock tiene Alimentos M5 · FOODS_2 · Ítem 096?” y luego “¿Y el stock mínimo?”

Verificar que reglas/eventos/entregas no se mezclen y que las consultas determinísticas indiquen 0 LLM/0 tokens. No se ejecutan escrituras en esta fase.
