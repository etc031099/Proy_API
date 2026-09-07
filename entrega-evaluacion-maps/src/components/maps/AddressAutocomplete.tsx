'use client';

import { useEffect, useRef, useState } from 'react';
import { useMapsLibrary } from '@vis.gl/react-google-maps';
import { useLanguage } from '@/contexts/LanguageContext';

export interface AddressSelection {
  address: string;
  latitude: number;
  longitude: number;
  placeId?: string;
  addressComponents: AddressComponents;
}

export interface AddressComponents {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

type AddressComponentLike = {
  types: string[];
  longText?: string | null;
  long_name?: string;
};

export function getAddressComponents(
  components: AddressComponentLike[] = [],
  displayName = '',
  formattedAddress = '',
) : AddressComponents {
  const findComponent = (type: string) =>
    components.find((component) => component.types.includes(type))?.longText
      || components.find((component) => component.types.includes(type))?.long_name
      || '';
  const route = findComponent('route');
  const streetNumber = findComponent('street_number');

  return {
    street: [route, streetNumber].filter(Boolean).join(' ')
      || displayName
      || formattedAddress,
    city: findComponent('locality') || findComponent('administrative_area_level_2'),
    state: findComponent('administrative_area_level_1'),
    zipCode: findComponent('postal_code'),
    country: findComponent('country'),
  };
}

interface AddressAutocompleteProps {
  value?: string;
  onChange?: (value: string) => void;
  onPlaceSelect?: (selection: AddressSelection) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function AddressAutocomplete({
  value = '',
  onChange,
  onPlaceSelect,
  placeholder = 'Search for an address',
  className,
  disabled = false,
}: AddressAutocompleteProps) {
  const { t } = useLanguage();
  const resolvedPlaceholder = placeholder || t('maps.searchAddress');
  const elementContainerRef = useRef<HTMLDivElement>(null);
  const placesLibrary = useMapsLibrary('places');
  const [placesError, setPlacesError] = useState(false);
  const onChangeRef = useRef(onChange);
  const onPlaceSelectRef = useRef(onPlaceSelect);
  const valueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
    onPlaceSelectRef.current = onPlaceSelect;
    valueRef.current = value;
  }, [onChange, onPlaceSelect, value]);

  useEffect(() => {
    if (!placesLibrary || disabled || !elementContainerRef.current) {
      return;
    }

    setPlacesError(false);

    let autocomplete: google.maps.places.PlaceAutocompleteElement;
    try {
      autocomplete = new placesLibrary.PlaceAutocompleteElement({
        includedRegionCodes: ['pe'],
        placeholder: resolvedPlaceholder,
      });
      autocomplete.value = valueRef.current;
      autocomplete.disabled = disabled;
      elementContainerRef.current.replaceChildren(autocomplete);
    } catch {
      setPlacesError(true);
      return;
    }

    const handleSelect = async (event: google.maps.places.PlacePredictionSelectEvent) => {
      try {
        const place = event.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['formattedAddress', 'location', 'id', 'displayName', 'addressComponents'],
        });

        if (!place.location) {
          return;
        }

        const address = place.formattedAddress || autocomplete.value || '';

        onPlaceSelectRef.current?.({
          address,
          latitude: place.location.lat(),
          longitude: place.location.lng(),
          placeId: place.id,
          addressComponents:           getAddressComponents(place.addressComponents, place.displayName || '', address),
        });
        onChangeRef.current?.(address);
      } catch {
        setPlacesError(true);
      }
    };

    const handleError = () => setPlacesError(true);
    const handleInput = () => onChangeRef.current?.(autocomplete.value);
    autocomplete.addEventListener('gmp-select', handleSelect);
    autocomplete.addEventListener('gmp-error', handleError);
    autocomplete.addEventListener('input', handleInput);

    return () => {
      autocomplete.removeEventListener('gmp-select', handleSelect);
      autocomplete.removeEventListener('gmp-error', handleError);
      autocomplete.removeEventListener('input', handleInput);
      autocomplete.remove();
    };
  }, [disabled, placesLibrary, resolvedPlaceholder]);

  return (
    <>
      {!placesError && placesLibrary ? (
        <div ref={elementContainerRef} className={className} aria-label={resolvedPlaceholder} />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          placeholder={resolvedPlaceholder}
          className={className}
          disabled={disabled}
          autoComplete="off"
        />
      )}
    </>
  );
}
