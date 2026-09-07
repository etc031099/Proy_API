# Google Maps en el formulario de Contactos

## Objetivo de la integración

Google Maps se integra directamente en los formularios reales de gestión de contactos:

- `/contacts/new`
- `/contacts/[id]/edit`

La integración acelera el registro de clientes y proveedores, reduce errores de tipeo y guarda coordenadas exactas (`latitude` y `longitude`). Estas coordenadas pueden utilizarse posteriormente para procesos de facturación, entregas y localización de clientes.

La solución no modifica el flujo normal del formulario: el usuario puede buscar una dirección, completar los datos manualmente, mover el marcador y guardar el contacto.

## Arquitectura híbrida

La implementación combina dos servicios:

1. **Google Maps JavaScript API + Places API (New)**
   - Renderiza el mapa interactivo.
   - Proporciona el autocompletado de direcciones.
   - Devuelve la dirección seleccionada y sus coordenadas.

2. **OpenStreetMap Nominatim**
   - Realiza la geocodificación inversa al hacer clic en el mapa o mover el marcador.
   - Actualiza calle, ciudad, estado, código postal y país.
   - Evita utilizar la geocodificación de Google, que requiere Billing habilitado.
   - Permite realizar la demostración sin registrar una tarjeta en Google Cloud.

Esta separación permite utilizar Google para la experiencia visual y el autocompletado, y Nominatim para convertir coordenadas en dirección sin depender de la facturación de Google.

## Prueba rápida para el evaluador

1. Configurar la clave en `frontend/.env.local`:

   ```env
   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=YOUR_GOOGLE_MAPS_DEMO_KEY
   NEXT_PUBLIC_NOMINATIM_EMAIL=dev@example.com
   ```

2. Iniciar la aplicación:

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

3. Abrir `http://localhost:3000/contacts`.
4. Seleccionar **Contacts → Add Contact**.
5. En el campo **Search address with Google Maps**, escribir una dirección y seleccionar una sugerencia.
6. Verificar que se completen automáticamente:
   - Street Address
   - City
   - State/Province
   - ZIP/Postal Code
   - Country
7. Confirmar que el mapa muestra el marcador en las coordenadas seleccionadas.
8. Arrastrar el marcador a otra ubicación o hacer clic en un punto diferente del mapa.
9. Verificar que:
   - `latitude` y `longitude` cambian.
   - Nominatim actualiza los campos de dirección.
   - No aparece ningún error no controlado en la consola del navegador (`F12`).
10. Completar los campos obligatorios y guardar el contacto.
11. Abrir nuevamente el contacto desde la lista o entrar a `/contacts/[id]/edit`.
12. Confirmar que la dirección y las coordenadas persisten después de guardar.
13. Alternar entre `EN` y `ES` y verificar que el formulario, los textos de dirección, los mensajes del mapa y la navegación cambian de idioma.

## Prueba de tolerancia a fallos

- Si Google Places no carga o la cuota se agota, el campo continúa disponible como entrada manual.
- Si Nominatim no responde, las coordenadas siguen actualizándose y el formulario no se bloquea.
- La dirección puede escribirse manualmente y el contacto puede guardarse sin coordenadas.

## Archivos que debe revisar el docente

Para evaluar únicamente esta implementación, entregar la carpeta con estos archivos y sus dependencias de interfaz:

```text
frontend/src/app/contacts/new/page.tsx
frontend/src/app/contacts/[id]/edit/page.tsx
frontend/src/components/maps/AddressAutocomplete.tsx
frontend/src/components/maps/GoogleMap.tsx
frontend/src/contexts/LanguageContext.tsx
frontend/src/components/LanguageSelector.tsx
frontend/src/i18n/dict.ts
frontend/src/app/layout.tsx
frontend/.env.example
frontend/package.json
```

También debe incluirse el modelo y las validaciones del backend si se desea demostrar la persistencia completa:

```text
backend/src/models/Contact.js
backend/src/utils/validations.js
```

La demostración depende de la estructura existente de Next.js, los componentes UI y los tipos de contacto. Por ello, lo más seguro es entregar un repositorio reducido que conserve esas dependencias, eliminando módulos ajenos al objetivo, en lugar de copiar únicamente los dos componentes del mapa.

## Credenciales y seguridad

La clave real debe permanecer únicamente en `frontend/.env.local`. No debe incluirse en el repositorio, en capturas ni en el material entregado.

El archivo seguro de referencia es:

```text
frontend/.env.example
```

La clave utilizada debe tener habilitadas `Maps JavaScript API` y `Places API (New)`, con restricciones de dominio apropiadas para la demostración.

## Archivos técnicos principales

- `frontend/src/components/maps/AddressAutocomplete.tsx`: autocompletado y extracción de componentes de dirección.
- `frontend/src/components/maps/GoogleMap.tsx`: mapa, marcador, clic, arrastre y reverse geocoding con Nominatim.
- `frontend/src/app/contacts/new/page.tsx`: creación de contactos.
- `frontend/src/app/contacts/[id]/edit/page.tsx`: edición y carga de coordenadas existentes.
- `frontend/src/i18n/dict.ts`: traducciones EN/ES.
