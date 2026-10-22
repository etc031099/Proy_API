# A.6.2.1 — Corrección local y certificación cloud pendiente

**Estado: corrección validada localmente. A.6.2 NO está cerrada ni certificada en
producción hasta obtener el smoke real descrito al final.**

## Evidencia y trazado previo a los cambios

Se reprodujo el gate anterior con los valores reportados (stock 13, cobertura
1.67, riesgo HIGH, cantidad sugerida 102 y Ridge 7d READY, 55.36). La ejecución
de prueba devolvió `providerCalls=0`, `providerAvailabilityChecked=0` y un fallo
operativo marcado `PARTIAL`. No se consultó Atlas ni se ejecutó el proveedor real.

| Caso cloud | Regla / intención anterior | Síntesis | Causa de 0 IA |
| --- | --- | --- | --- |
| «Viendo lo q tengo… q hago con coca» + elección | `requestsInterpretation` → `grounded-product` → `product_interpretation`; resolver V3 y dos skills | Considerada, bloqueada | Inventario `PARTIAL` activa `incomplete=true`; el gate se detiene antes de `hasGroundedProvider` / `generateGrounded` |
| «Qué harías con esta coca cola» | Mismo plan, con la entidad del contexto | Considerada, bloqueada | Mismo veto indiscriminado de `PARTIAL`, aunque las métricas necesarias estén presentes |
| «Según los datos… explícame en palabras simples si debería preocuparme…» | `classifyGrounded=DETERMINISTIC`, `routeV3=null`; el probe legacy puede elegir `product_details` por «producto» | No requerida por la ruta equivocada | Operations / `get_product_details` devuelve ficha, sin entrar a grounded |
| «Comprame coca» | `actionIntent=null`; `ambiguousMovement=true` | No corresponde | Aclaración genérica venta/compra, perdiendo PURCHASE conocida |
| «Ayer salieron 4 lays» | Mismo guard genérico; no coincidía `saleNarrative` | No corresponde | Aclaración genérica sin conservar la venta narrativa |

En los primeros dos casos el fallback factual y sus contadores 0 son reales: no
hubo una llamada fallida oculta. La decisión de no llamar fue anterior al proveedor.
Las fixtures anteriores de A.6.2 usaban Inventario READY para probar la síntesis;
no cubrían PARTIAL con métricas críticas presentes. Esa cobertura ahora se exige.

## Configuración real: qué sabemos y qué no

El usuario confirmó, sin revelar valores secretos:

- `AGENT_ENABLED=true`
- `LLM_PROVIDER=deepseek`
- `DEEPSEEK_API_KEY` presente

El código real utiliza `configuredGroundedProvider()` cuando no se inyecta un
proveedor de test. No depende de mocks en producción. NLU y síntesis comparten
ese proveedor/configuración; `execution.js` diferencia sus llamadas y métricas.
No hay un flag separado nuevo para grounded generation.

Esto confirma presencia/habilitación, **no validez de la credencial, saldo, acceso
al modelo ni disponibilidad remota**. No se verificó Render por API ni se hizo
una llamada real durante el desarrollo. El gate previo explica el bloqueo sin
atribuirlo especulativamente a la clave. Una vez alcanzado el proveedor, el smoke
debe confirmar su funcionamiento.

## Cambios focales

### Evidencia parcial utilizable

Para `product_interpretation`, un resultado Inventory PARTIAL es utilizable cuando
sus filas autorizadas conservan SKU, stock onHand, cobertura y recommendedQty
numéricos finitos no negativos, y riesgo conocido CRITICAL/HIGH/MEDIUM/LOW.

Se conservan `status=PARTIAL`, sus notas y las limitaciones server-side; no se
reescribe como READY. Forecast sigue pasando por la autoridad y contrato existentes.
Un resultado NO_DATA/fallido o métricas críticas ausentes no autoriza la síntesis
completa. No se sustituyen null por cero ni se relajan validadores de salida.
La excepción previa de comparación de ventas permanece intacta.

### Routing de interpretación

El matcher existente reconoce preocupación y explicaciones «en palabras simples».
La referencia del prefijo «según los datos que tienes de…» se extrae sin incorporar
el resto de la pregunta al nombre del producto. Se reutilizan selección/contexto
V3 y máximo dos especialistas: Inventory + Forecast, no la ficha de Operations.

### Semántica de Operations

- Cómprame/comprame es PURCHASE explícita. Se normaliza en `parseAction` a la
  misma gramática de compra. Resolver, cantidad faltante, proveedor y preview
  permanecen en el flujo existente; nunca se infiere cantidad.
- «Ayer salieron 4 lays» se adapta como venta narrativa probable y reutiliza el
  borrador `registrationIntent` de A.6.1. Conserva cantidad/referencia, sin resolver,
  preview ni escritura hasta aclarar intención. «Confirmar» no salta esa etapa.
  No se crea una operación histórica ni se aplica automáticamente la fecha «ayer».

## Diagnóstico sanitizado y Actividad

El nuevo campo opcional `grounded.generation` conserva únicamente:

```json
{
  "required": true,
  "providerConfigured": true,
  "groundedGenerationEnabled": true,
  "attempted": true,
  "status": "SUCCEEDED",
  "reason": null
}
```

`providerConfigured` representa presencia de configuración/key, no validación
remota. `attempted` señala que se invocó la etapa; para acreditar respuesta HTTP
real se exige además `responseDiagnostic.providerResponseReceived` y el smoke.

| Situación | Estado / motivo |
| --- | --- |
| Lectura clara determinística | Sin generación requerida; 0 IA |
| Evidencia insuficiente | NOT_ATTEMPTED / INSUFFICIENT_EVIDENCE |
| Proveedor no habilitado o sin configuración | NOT_ATTEMPTED / PROVIDER_UNAVAILABLE |
| Error de contexto compacto | NOT_ATTEMPTED / CONTEXT_REJECTED |
| Falló el proveedor | FAILED / PROVIDER_FAILED |
| Salida inventada/inválida | REJECTED / GROUNDING_REJECTED |
| Generación validada | SUCCEEDED / null |

`groundedAnswer` continúa registrando llamadas, usage reportado, proveedor/modelo,
aceptación y fallo de la etapa. La proyección de respuesta/historial permite la
nueva metadata sin secretos. No se añadió endpoint ni esquema Mongo.

Actividad muestra «Síntesis grounded», sus llamadas/tokens y estado. Una síntesis
requerida no realizada ya no aparece como «Respuesta determinística». Tokens no
reportados siguen siendo desconocidos (—), nunca un cero inventado.

## Pruebas locales y límite de certificación

- Backend focal (routing, grounded, A.4.6, Operations, auth/history y seguridad):
  **549/549 PASS**.
- Frontend assistant (component/actions/history): **110/110 PASS**.
- TypeScript, sintaxis Node, ESLint focal y diff-check comprobados en la entrega.
- Nuevo `groundedCloudA621.test.js`: 15 controles unitarios de la forma cloud,
  evidencia faltante, proveedor ausente/fallido, número inventado, routing,
  proyección sanitizada y selección/configuración lazy de producción.
- Cuatro recorridos de `inventoryForecastAgents` ahora exigen PARTIAL con
  métricas conocidas y exactamente una llamada de síntesis tras la selección.
- Operations comprueba intención PURCHASE, cantidad/proveedor/preview y ausencia
  de ejecución; SALE narrativa conserva 4/lays y no autoriza confirmación.

**Los HTTP del proveedor en tests están simulados mediante fetch inyectado.**
Las pruebas de factory usan la selección real pero no hacen HTTP. Estos resultados
no certifican calidad, credencial ni consumo real cloud. Consumo pagado: 0.

## Único smoke cloud para ejecutar después del deploy manual

Esta fase no hace stage/commit/push/deploy ni cambia variables. La corrección del
backend y su indicador de Actividad requieren el despliegue correspondiente.

Después, desde la sesión real autorizada del asistente, enviar **una sola vez**:

> Según los datos que tienes de BEB-GAS-001, explícame en palabras simples si debería preocuparme por este producto y por qué.

El SKU explícito evita una ronda de selección ambigua. No registrar ventas ni
confirmar operaciones. Revisar Actividad y el JSON de la respuesta de
`POST /api/agent/messages`, sin copiar Authorization, cookies ni claves.

Criterios acumulativos de PASS:

- Participan Inventory y Forecast; máximo dos especialistas, más Coordinator y
  Analyst para la síntesis, sin Operations/get_product_details.
- `grounded.generation.required=true`, `providerConfigured=true`,
  `groundedGenerationEnabled=true`, `attempted=true`, `status=SUCCEEDED`.
- `groundedAnswer.provider=deepseek`, `calls=1`, `accepted=true`.
- `grounded.responseDiagnostic.providerResponseReceived=true`, `httpStatus=200`,
  `validationResult=ACCEPTED`.
- `usage.totalLlmCalls=1` y `usage.totalTokens>0` reportados; no contadores simulados.
- Respuesta descriptiva sustentada, sin operaciones ejecutadas; PARTIAL conserva
  sus advertencias cuando corresponda. No exigir números hardcodeados: la evidencia
  operacional puede cambiar.

Si falta un criterio, **NO declarar PASS ni repetir masivamente**. Guardar solo
requestId, estado/motivo de generation, diagnóstico sanitizado y usage para revisar
el bloqueo. Tokens ausentes o salida rechazada no certifican el objetivo.

## Archivos

Backend: `agents/grounded.js`, `groundedRouting.js`, `execution.js`,
`providers/selection.js`, `automations/actionInput.js`,
`services/agentHistoryProjection.js`.

Frontend: `components/assistant/AgentActivity.tsx`, `types/agent.ts`.

Tests: `groundedCloudA621.test.js` (nuevo), `assistantFallbackA62.test.js`,
`inventoryForecastAgents.test.js`, `operationsMultiProduct.test.js`,
`frontend/test/assistant.component.test.tsx`. Más este informe nuevo.

Sin cambios ML/BI, A.5.3.3, timeouts, transacciones, locks, idempotencia, Telegram
ni datos comerciales. `entrega-tutoria-bullying/` preservado.
