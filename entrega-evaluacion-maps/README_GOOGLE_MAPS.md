# Módulo de geolocalización para Registro de Contactos

Esta carpeta contiene una demostración independiente del formulario completo de Registro de Contactos con integración oficial de Google Maps.

## Requisitos

- Node.js 18.18 o superior.
- npm.
- Una API Key con `Maps JavaScript API` y `Places API (New)` habilitadas (Se pude obtener una gratuitamtente aqui: https://mapsplatform.google.com/maps-demo-key/).

## Instalación local

Desde la carpeta `entrega-evaluacion-maps/`, ejecutar:

npm install

Crear `.env.local` a partir de `.env.example`:

NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=YOUR_GOOGLE_MAPS_API_KEY

## Ejecución

npm run dev

Abrir `http://localhost:3000`.

## Prueba del formulario

1. Completar Nombre Completo, Teléfono, Tipo de Documento, Número de Documento, Email y Tipo de Contacto.
2. Escribir una dirección en el buscador de Google Maps y seleccionar una sugerencia.
3. Confirmar que Street Address, City, State/Province, ZIP/Postal Code y Country se completen.
4. Hacer clic en el mapa o arrastrar el marcador para actualizar las coordenadas y los datos de dirección.
5. Revisar el panel Geolocalización en Tiempo Real, que muestra únicamente Latitud, Longitud y los datos parseados en formato JSON.
6. Alternar entre `EN` y `ES` para verificar la interfaz bilingüe.
7. Presionar **Save** para comprobar el flujo de registro local.

## Archivos principales

src/app/page.tsx
src/components/maps/AddressAutocomplete.tsx
src/components/maps/GoogleMap.tsx
src/contexts/LanguageContext.tsx
src/i18n/dict.ts
.env.example
package.json
