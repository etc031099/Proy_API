'use client';

import { APIProvider, Map, Marker } from '@vis.gl/react-google-maps';
import { useCallback, useState } from 'react';
import { AddressComponents, getAddressComponents } from './AddressAutocomplete';
import { useLanguage } from '@/contexts/LanguageContext';

const DEFAULT_CENTER = {
  lat: -12.0464,
  lng: -77.0428,
};

interface GoogleMapProps {
  latitude?: number;
  longitude?: number;
  onLocationChange?: (lat: number, lng: number) => void;
  onAddressChange?: (address: AddressComponents) => void;
}

const isValidCoordinate = (latitude?: number, longitude?: number) =>
  typeof latitude === 'number' &&
  Number.isFinite(latitude) &&
  latitude >= -90 &&
  latitude <= 90 &&
  typeof longitude === 'number' &&
  Number.isFinite(longitude) &&
  longitude >= -180 &&
  longitude <= 180;

const readCoordinate = (value: unknown, method: 'lat' | 'lng'): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const coordinate = (value as Record<string, unknown>)[method];
    if (typeof coordinate === 'number' && Number.isFinite(coordinate)) {
      return coordinate;
    }
    if (typeof coordinate === 'function') {
      const result = coordinate();
      return typeof result === 'number' && Number.isFinite(result) ? result : null;
    }
  }
  return null;
};

const extractCoordinates = (latLng: unknown) => {
  const lat = readCoordinate(latLng, 'lat');
  const lng = readCoordinate(latLng, 'lng');
  return lat !== null && lng !== null ? { lat, lng } : null;
};

function GoogleMapContent({
  latitude,
  longitude,
  onLocationChange,
  onAddressChange,
  mapError,
}: GoogleMapProps & {mapError: boolean}) {
  const { t } = useLanguage();
  const hasLocation = isValidCoordinate(latitude, longitude);
  const position = {
    lat: hasLocation ? Number(latitude) : DEFAULT_CENTER.lat,
    lng: hasLocation ? Number(longitude) : DEFAULT_CENTER.lng,
  };
  const updateLocation = useCallback((lat: number, lng: number) => {
    onLocationChange?.(lat, lng);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 8000);
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({
      format: 'json',
      lat: String(lat),
      lon: String(lng),
      addressdetails: '1',
      email: process.env.NEXT_PUBLIC_NOMINATIM_EMAIL || 'dev@example.com',
    }).toString();

    fetch(url.toString(), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Nominatim request failed with status ${response.status}`);
        }
        return response.json() as Promise<{
          display_name?: string;
          address?: {
            road?: string;
            pedestrian?: string;
            suburb?: string;
            city?: string;
            town?: string;
            village?: string;
            county?: string;
            state?: string;
            region?: string;
            postcode?: string;
            country?: string;
          };
        }>;
      })
      .then((data) => {
        const address = data.address || {};
        onAddressChange?.({
          street: address.road || address.pedestrian || address.suburb || data.display_name || '',
          city: address.city || address.town || address.village || address.county || '',
          state: address.state || address.region || '',
          zipCode: address.postcode || '',
          country: address.country || '',
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.debug('[GoogleMap] Nominatim reverse geocoding unavailable:', error);
      })
      .finally(() => window.clearTimeout(timeoutId));
  }, [onAddressChange, onLocationChange]);

  return (
    <div className="h-[320px] w-full overflow-hidden rounded-lg border">
        {mapError && (
          <div className="flex h-full items-center justify-center bg-muted p-4 text-center text-sm text-muted-foreground">
            {t('maps.unavailable')}
          </div>
        )}
      <Map
          className={mapError ? 'hidden' : undefined}
          defaultCenter={{
            lat: hasLocation ? Number(latitude) : DEFAULT_CENTER.lat,
            lng: hasLocation ? Number(longitude) : DEFAULT_CENTER.lng,
          }}
          defaultZoom={hasLocation ? 15 : 12}
          gestureHandling="greedy"
          disableDefaultUI={false}
          onClick={(event) => {
            const location = extractCoordinates(event.detail.latLng);
            if (location) {
              updateLocation(location.lat, location.lng);
            }
          }}
      >
          <Marker
            position={position}
            draggable
            onDragEnd={(event) => {
              const nextPosition = extractCoordinates(event.latLng);
              if (nextPosition) {
                updateLocation(nextPosition.lat, nextPosition.lng);
              }
            }}
          />
      </Map>
    </div>
  );
}

export function GoogleMap(props: GoogleMapProps) {
  const { t } = useLanguage();
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [mapError, setMapError] = useState(false);

  if (!apiKey) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-lg border bg-muted p-4 text-center text-sm text-muted-foreground">
        {t('maps.notConfigured')}
      </div>
    );
  }

  return (
    <APIProvider
      apiKey={apiKey}
      version="weekly"
      onError={() => setMapError(true)}
    >
      <GoogleMapContent {...props} mapError={mapError} />
    </APIProvider>
  );
}
