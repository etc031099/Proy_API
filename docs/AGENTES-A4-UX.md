# UX del asistente multiagente A.4

## Chat y Actividad

El chat presenta la conclusión del especialista y evidencia compacta para la consulta. La tarjeta no identifica al agente como encabezado: usa títulos de contenido como «Datos clave» y «Pronóstico 14 días». La Actividad conserva participantes, skills, llamadas, tokens, latencias y fuentes para explicar cómo se obtuvo la respuesta.

## Preguntas normales y técnicas

Para consultas normales de reposición y pronóstico se conserva la conclusión directa. Se omite del chat el bloque redundante «Escenario V3» y su lista extensa, porque la tarjeta contiene los datos clave. En Inventory, la tarjeta compacta muestra stock, cobertura, riesgo y cantidad sugerida cuando están disponibles. En Ridge LIVE muestra estado y versión del modelo; la conclusión conserva las unidades esperadas y el horizonte.

Una pregunta que menciona modelo, versión, featureVersion, revisión, observaciones cerradas, método o metodología puede mostrar la respuesta y las métricas técnicas disponibles. Las limitaciones de disponibilidad se mantienen cuando son relevantes. Los valores nulos continúan como «No disponible» y nunca se convierten a cero.

## Respuestas compuestas

Cuando participan Inventory y Forecast, se conservan ambas conclusiones en el orden de la respuesta y se muestran sus datos en tarjetas compactas. La tarjeta no repite la identidad de cada agente. La sección Actividad sigue mostrando participantes como Coordinador, Inventario y Pronóstico, junto con skills y demás trazabilidad.

## Compatibilidad

Las respuestas sin vistas V3 y las sugerencias legacy mantienen su presentación anterior. Las tarjetas aceptan métricas desconocidas y las respuestas antiguas sin actividad muestran que esas métricas no se registraron. El aislamiento por mensaje evita que una respuesta malformada o una actividad parcial desmonte el historial, el campo de consulta o la navegación.
