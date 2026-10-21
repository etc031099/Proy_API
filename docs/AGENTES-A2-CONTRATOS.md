# Agentes A.2 — Lecturas alineadas con BI final

El asistente conserva coordinator / operations / analyst. Las escrituras existentes
siguen utilizando preview, confirmación, idempotencia y auditoría.

## Autoridad de lectura

`v3RidgeServingAuthority` comparte con BI la selección de artefactos ACTIVE por
businessId/scenarioId/horizonte y el envelope ya certificado. Registry sigue
validando los artefactos; no se escriben modelos ni se modifican políticas.

El executor conversacional utiliza `executeAssistant`, que conecta esta autoridad
al mismo `execute` V3 del dashboard. Inventario y Health reciben la pareja 7d/14d;
si falta un modelo, los campos dependientes pueden seguir parciales y se conservan
stock y null. Health es un assembly/diagnóstico, no un modelo propio.

Forecast LIVE usa exclusivamente Ridge ACTIVE CAUSAL27 para 7d/14d. El horizonte
1d solicita aclaración antes de inferencia. Si falta ACTIVE, no hay sustitución.
La respuesta incluye predictionUnits, estado, versión, featureVersion, revisión
y observaciones cerradas cuando el contrato los proporciona. No envía las 27
features al LLM por defecto.

El serving aprobado de Ridge es por producto. Se admiten comparaciones explícitas
acotadas a cinco referencias, fijando un artefacto y snapshot por petición. Una
solicitud global de ranking/total sin producto pide selección; no usa un ranking
MA28 ni calcula un total parcial como si fuera global.

Las consultas explícitamente históricas y la evaluación HGB/MA28 conservan sus
contratos, con etiquetas históricas. No representan el modelo LIVE.

## Otros dominios y alcance diferido

- RFM permanece separado de K-Means. El modelo congelado y sus asignaciones
  siguen siendo propiedad de customerClustering; no se cambia su cálculo.
- FP-Growth conserva artefacto/corte y support/confidence/lift. Asociación no
  equivale a causalidad.
- Isolation Forest histórico conserva el modo anomalies y su evidencia congelada.
  Una anomalía no confirma fraude ni su probabilidad.
- El provisional ya existe en `salesAnomalyProvisional`, pero se difiere su tool
  conversacional a A.5: necesita routing y una proyección propia para EVALUATED /
  NOT_EVALUABLE, diferenciada de la serie histórica. Debe invocar ese servicio
  read-only, usar businessId del contexto y preservar revisión/localDate/observedAt,
  estado/motivo e inferencia validada; sin aceptar features desde el mensaje ni fit.
- get_inventory_summary, get_purchase_summary y get_supplier_details se retiran
  de las capacidades anunciadas porque no tenían executor. No se agregan escrituras.

## Validación posterior al despliegue controlado

Después de revisión/publicación manual, abrir el asistente autenticado y consultar
un SKU real a 7 y 14 días; verificar modelo ACTIVE y revisión frente a BI.
Preguntar por mañana: debe aclarar que 1d no está aprobado sin fallback.
Consultar inventario y Health, verificando que desconocidos siguen no disponibles.
Consultar RFM/K-Means, anomalías históricas y asociaciones, comprobando sus cortes.
No confirmar operaciones ni solicitar actualización ML en ese smoke read-only
de datos comerciales. El chat puede persistir su historial de conversación normal.
