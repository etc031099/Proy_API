# A.3 — Identidades y contratos multiagente

## Estado

A.3 registra seis identidades previstas y amplía los contratos de memoria e historial para aceptarlas. No activa su routing ni les asigna skills ejecutables. Las nuevas definiciones permanecen `PLANNED`, con cero skills, cero llamadas LLM y cero acciones. Una identidad solo aparece en actividad cuando figura realmente entre los participantes recibidos.

## Identidades

| ID | Nombre visible | Estado | Lectura prevista | Escritura |
| --- | --- | --- | --- | --- |
| `coordinator` | Coordinador | Activo | Clasifica y coordina; no consulta skills | Ninguna |
| `operations` | Operaciones | Activo | Operaciones y datos factuales | Sí, exclusivamente por el gateway de acciones existente |
| `analyst` | Analista (compatibilidad) | Generalista activo legado | Agregados, rankings, forecast y análisis actuales | Ninguna |
| `sales` | Ventas | Previsto | Ventas, transacciones y anomalías | Ninguna |
| `inventory` | Inventario | Previsto | Stock, riesgo, reposición e historial operacional | Ninguna |
| `forecast` | Pronóstico | Previsto | Ridge LIVE, estado de modelos y evaluación | Ninguna |
| `customers` | Clientes | Previsto | RFM, clustering y actividad de clientes | Ninguna |
| `procurement` | Compras y proveedores | Previsto | Proveedores, compras, recepción y desempeño | Ninguna |
| `associations` | Productos relacionados | Previsto | FP-Growth y cross-sell | Ninguna |

Las familias declaradas en cada definición son metadatos de alcance futuro, no permisos de ejecución. La autorización efectiva sigue dependiendo de `allowedSkills`, el registro de skills y, para escrituras, `allowedActionSkills` y el gateway. Las seis identidades previstas tienen ambas listas vacías; sus skills no se amplían automáticamente.

## Compatibilidad y routing

`coordinator`, `operations` y `analyst` continúan admitidos. `analyst` se mantiene activo como generalista durante la transición; conserva sus skills y responsabilidades actuales. A.4/A.5 podrán migrar gradualmente consultas de ventas, inventario, forecast y clientes; compras/proveedores y asociaciones quedarán para las subfases especializadas posteriores. La retirada de responsabilidades de `analyst` requiere una fase separada y evidencia de paridad.

El clasificador y el routing determinístico siguen eligiendo únicamente las rutas actuales. Registrar un ID no crea un nuevo destino de ejecución. Las definiciones previstas tienen presupuesto de llamadas cero y no pueden ejecutar skills ni acciones.

## Memoria e historial

El campo persistido `lastAgent`, los snapshots compactos y la proyección pública aceptan las nueve identidades. Los documentos existentes no se migran ni reescriben; los valores históricos se conservan tal cual. Los campos de actividad (`agentId`, skill, llamadas LLM, tokens y latencia) siguen pasando por las proyecciones existentes. Un agente no participante no se agrega a la respuesta.

## Envelope compartido

No se agrega un formato paralelo. Se reutilizan el response de conversación (`agent`, `intent`, `evidence`, `actions`, `suggestions` y `usage`) y el resultado de skill (`status`, `data`, `metadata` y evidencia cuando corresponde). Las limitaciones ya se proyectan desde la síntesis estructurada. Cualquier especialista futuro debe adaptar hechos de sus tools a estas estructuras; `suggestions` son propuestas presentadas al usuario y no ejecutan acciones.

## Seguridad

La autenticación, identidad de usuario, tenant confiable, filtros de negocio, schemas cerrados, propiedad de conversación y permisos del gateway no cambian. Los agentes previstos son de solo lectura y actualmente no tienen siquiera skills de lectura activas. `operations` conserva las escrituras ya autorizadas; no se crean permisos de checkpoint, restore, entrenamiento ni promoción.
