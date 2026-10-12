# CONV-HARDENING-P3C.1 — Temporales y forecast P1

Validación local sobre el código de trabajo derivado de `6c74b1b`.
El informe P3B original permanece intacto; `evaluatedCommit` en el informe
comparativo identifica el commit base, no un deployment cloud.

## Casos cerrados

Los 12 P1 del área forecast identificados en P3B pasan:
`U-0242`, `U-0243`, `U-0250`, `U-0252`, `U-0262`, `U-0282`,
`U-0283`, `U-0285`, `U-0287`, `U-0290`, `U-0291`, `U-0292`.

- La guarda futura no reconocía próximo mes y sus variantes; ahora bloquea
  antes de resolver/consultar ML, conservando la referencia explícita o contextual.
- Algunas expresiones específicas no entraban en el extractor anterior y
  caían al forecast batch. Ahora pasan por resolución de producto: un producto
  inequívoco usa forecast específico, varios ofrecen selección y ninguno aclara.
- Resumen, readiness y demanda agregada podían caer en conteo operativo o
  forecast genérico. Ahora usan los modos existentes de `analyze_demand_forecast`.

Próximo mes, mes que viene, mes siguiente, próxima semana, semana que viene,
mañana, pasado mañana, en 7 días y en un mes no presentan replay como forecast
vigente. Los follow-ups mantienen producto e intención; una entidad explícita
tiene prioridad. Las fechas ISO/españolas conservan la limitación diaria:
el servicio ofrece un horizonte histórico agregado de 7 días, no predicciones
diarias. El escenario histórico en su ancla sigue disponible.

Batch se permite para consultas generales; no es fallback de producto inexistente
o ambiguo. Todas estas decisiones siguen determinísticas: 0 LLM / 0 tokens.

## Validación

- 26 pruebas nuevas basadas en P3B y regresiones mínimas.
- Forecast/temporal/orchestrator/servicio ML y cliente HTTP mocks: 378/378.
- Backend completo: 1078/1078 (baseline 1052).
- Auditoría reproducida con `node backend/scripts/audit-conversation-p3b.js --forecast-p3c1`:
  subset P1 12/12 PASS; 827 casos reevaluados; 0 nuevos P0/P1.
- Resultado global comparativo: PASS 628, FAIL 145, PARTIAL 12,
  NOT_SUPPORTED 28, NEEDS_MANUAL 14; P0=0, P1=15, P2=129, P3=1.
  Los hallazgos restantes son ajenos al alcance de esta fase.
- Reporte independiente: `CONV-HARDENING-P3C.1.json`; baseline P3B no sobrescrito.
- Sintaxis y diff verificados. Sin llamadas pagadas ni escrituras de negocio.

Frontend no modificado; no se cambia ML, proveedor LLM, periodos de ventas,
alertas/outbox, acciones, proveedores, Telegram ni contratos públicos.
Sin RAG, entrenamiento, cambios cloud ni push.
