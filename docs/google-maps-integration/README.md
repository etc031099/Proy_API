# Google Maps Integration - Quick Start

This guide explains how to run and evaluate the Google Maps integration in the
Contacts module.

## 1. Prerequisites

- Node.js 18 or later.
- npm.
- Access to the project repository.
- A Google Maps Demo Key.
- The Maps JavaScript API and Places API enabled for the key.

The integration uses:

- Next.js 15.
- React 19.
- `@vis.gl/react-google-maps`.
- Google Maps JavaScript API.
- Google Places API.

## 2. Configure the Demo Key

Go to the frontend directory:

```bash
cd frontend
```

Create a file named `.env.local`:

```env
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=YOUR_GOOGLE_MAPS_DEMO_KEY
```

Replace `YOUR_GOOGLE_MAPS_DEMO_KEY` with the real key.

The project includes a safe template at:

```text
frontend/.env.example
```

Do not commit `.env.local` or expose the real key in the README, source code,
screenshots, or GitHub.

Restart the Next.js development server after changing the environment file.

## 3. Install and run

From `frontend`:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

The application may require a valid logged-in session before opening the
contacts pages.

## 4. Test contact creation

Open:

```text
http://localhost:3000/contacts/new
```

Steps:

1. Complete the required contact fields.
2. In the address section, type an address in the Google Maps search field.
3. Select one of the Places suggestions.
4. Confirm that the street/city/country fields are updated.
5. Confirm that the map centers on the selected location.
6. Drag the marker to another location.
7. Confirm that the form receives the new coordinates.
8. Save the contact.

The contact is sent to the backend with optional `latitude` and `longitude`
fields.

## 5. Test contact editing

Open the Contacts list and select an existing contact, or open:

```text
http://localhost:3000/contacts/{contact-id}/edit
```

Steps:

1. Confirm that an existing location centers the map.
2. Search for a different address.
3. Confirm that the marker moves to the new location.
4. Alternatively, drag the marker manually.
5. Save the contact.
6. Reopen the contact and confirm that the updated location persists.

## 6. Recommended test cases

### Case A: New contact with Google Maps

Expected result:

- Address suggestions appear.
- A selected suggestion updates the address and coordinates.
- The marker appears at the selected location.
- The contact saves successfully.

### Case B: Edit contact with coordinates

Expected result:

- The existing coordinates center the map.
- The marker can be moved.
- The updated coordinates are persisted.

### Case C: Edit an old contact without coordinates

Expected result:

- The page does not fail.
- The map starts in Lima, Peru.
- The user can choose a new address or keep entering it manually.
- The contact can still be saved.

### Case D: Manual address fallback

Temporarily remove or rename the API key in `.env.local` and restart the
frontend.

Expected result:

- The Google search/map is unavailable or displays a configuration message.
- Manual address fields remain usable.
- The contact can still be saved without coordinates.

### Case E: Demo quota or network failure

If Google returns an error because the Demo Key quota is exhausted or the
network is unavailable:

- The contact form remains usable.
- The user can enter the address manually.
- The application does not block contact creation or editing.

## 7. Relevant implementation files

```text
frontend/src/components/maps/GoogleMap.tsx
frontend/src/components/maps/AddressAutocomplete.tsx
frontend/src/app/contacts/new/page.tsx
frontend/src/app/contacts/[id]/edit/page.tsx
backend/src/models/Contact.js
backend/src/utils/validations.js
frontend/src/types/index.ts
```

For the detailed architecture and data flow, see:

```text
docs/google-maps-integration/IMPLEMENTATION.md
```

## 8. Troubleshooting

### The map does not appear

Check:

- `.env.local` exists inside `frontend`.
- The variable name is exactly
  `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.
- The development server was restarted.
- The Maps JavaScript API is enabled.
- The key is valid for the current environment.

### Address suggestions do not appear

Check:

- The Places API is enabled.
- The Demo Key supports the requested Places functionality.
- The browser console does not report a key or quota error.

### `REQUEST_DENIED`

Check:

- The API key is correct.
- The APIs are enabled.
- The key restrictions allow `http://localhost:3000`.
- The Demo Key has not reached its limit.

### The form cannot save

The Google Maps integration should not block saving. Use the regular manual
address fields and verify that the backend is running and the contact's
required fields are valid.

## 9. Academic delivery recommendation

The clearest delivery is:

1. Submit the complete repository so the teacher can run the integration in its
   real context.
2. Point the teacher to this folder:

```text
docs/google-maps-integration/
```

3. Include `README.md` as the entry point.
4. Use `IMPLEMENTATION.md` for the technical explanation.
5. Provide `.env.local` privately or let the teacher insert their own Demo Key.
6. Never include the real API key in GitHub or in the submitted source code.

If a smaller isolated package is required, copy the files listed in the
“Relevant implementation files” section together with this documentation, but
the complete repository is recommended because the integration depends on the
existing authentication, contact API, styling, and frontend structure.
