# Google Maps Integration - Technical Implementation

## 1. Objective

This module integrates Google Maps into the Contacts section of the Inventory
and Billing Management System. It allows a user to search for an address,
visualize it on a map, move the marker, and persist the selected coordinates
with the contact.

The integration is intended for academic development and demonstration using a
Google Maps Demo Key.

## 2. Architecture

### Frontend

The frontend uses:

- Next.js 15 App Router.
- React 19.
- TypeScript.
- `@vis.gl/react-google-maps`.

The map integration is implemented through two client components:

- `GoogleMap.tsx`: loads the map, displays the marker, and emits coordinates
  when the marker is moved.
- `AddressAutocomplete.tsx`: loads the Places library and emits the selected
  formatted address and coordinates.

The components are used by the contact creation and editing pages. The API key
is read from the browser-safe environment variable:

```env
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
```

### Backend

The backend uses:

- Node.js.
- Express.
- Mongoose.
- MongoDB.

The Contact Mongoose schema stores optional `latitude` and `longitude` fields.
The contact validation middleware verifies that the values are numeric and
within valid geographic ranges:

- Latitude: `-90` to `90`.
- Longitude: `-180` to `180`.

The existing contact controller already forwards the request body to the
Mongoose model, so no special controller route is necessary for the
coordinates.

## 3. Data flow

### Address search

1. The user types an address in the contact form.
2. `AddressAutocomplete` loads the Google Places library through
   `useMapsLibrary('places')`.
3. Google displays address suggestions.
4. The user selects a suggestion.
5. The component emits:
   - formatted address,
   - latitude,
   - longitude,
   - optional Google `placeId`.
6. The contact form updates its address and coordinate state.

### Map and marker

1. `GoogleMap` receives optional `latitude` and `longitude` props.
2. If valid coordinates exist, the map centers on them.
3. If they do not exist, the map starts in Lima, Peru:

```text
Latitude:  -12.0464
Longitude: -77.0428
```

4. A draggable marker is displayed.
5. When the marker is moved, `onLocationChange` updates the form state.

### Saving a contact

The contact page sends the coordinate fields together with the existing contact
payload:

```json
{
  "name": "Example Contact",
  "phone": "999888777",
  "address": {
    "street": "Av. Arequipa 123",
    "city": "Lima",
    "country": "Peru"
  },
  "latitude": -12.0464,
  "longitude": -77.0428,
  "type": "customer"
}
```

The backend validates and stores the values in MongoDB.

## 4. Files to review

### Existing files modified for the integration

```text
backend/src/models/Contact.js
backend/src/utils/validations.js
frontend/src/types/index.ts
frontend/src/app/contacts/new/page.tsx
frontend/src/app/contacts/[id]/edit/page.tsx
frontend/package.json
frontend/package-lock.json
frontend/.env.example
```

### New files created

```text
frontend/src/components/maps/GoogleMap.tsx
frontend/src/components/maps/AddressAutocomplete.tsx
docs/google-maps-integration/IMPLEMENTATION.md
docs/google-maps-integration/README.md
```

## 5. Error handling and resilience

The map is an enhancement to the contact form, not a requirement for saving a
contact.

### Missing API key

If `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is not configured:

- The map component displays a configuration message.
- The form continues to expose manual address fields.
- The user can save the contact manually.

### Network errors or exhausted demo quota

If Google Maps cannot load because of network problems, restrictions, or an
exhausted Demo Key quota:

- The existing manual address inputs remain available.
- The user can continue without coordinates.
- Existing contacts without coordinates remain valid.

### Existing contacts

`latitude` and `longitude` are optional. Contacts created before this
integration do not require a migration and open in the edit page with Lima as
the initial map location.

### Coordinate validation

The backend rejects coordinates outside valid geographic ranges. This prevents
invalid map positions from being stored.

## 6. API key and quota considerations

The Demo Key must be stored in `frontend/.env.local` and must not be committed
to Git:

```env
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=YOUR_DEMO_KEY
```

The implementation should be used for local academic demonstration only. The
Google Maps Demo Key has usage restrictions and may stop responding after its
quota is reached. The application remains usable through manual address entry.

## 7. Verification

From the frontend directory:

```bash
npm install
npm run build
```

The build verifies TypeScript validity and confirms that the map components can
be compiled by Next.js.
