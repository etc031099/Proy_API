export type Language = 'en' | 'es';

const dictionary = {
  en: {
    common: { language: 'Language', save: 'Save' },
    contacts: {
      addTitle: 'Add New Contact',
      newDetails: 'Enter the details for the new contact',
      fullName: 'Full Name',
      phone: 'Phone Number',
      email: 'Email Address',
      documentType: 'Document Type',
      documentNumber: 'Document Number',
      selectDocumentType: 'Enter document number',
      type: 'Contact Type',
      customer: 'Customer',
      vendor: 'Vendor',
      address: 'Address',
      streetAddress: 'Street Address',
      city: 'City',
      state: 'State/Province',
      zipCode: 'ZIP/Postal Code',
      country: 'Country',
    },
    placeholders: {
      fullName: 'Enter full name',
      phone: 'Enter phone number',
      email: 'Enter email address',
      street: 'Enter street address',
      city: 'Enter city',
      state: 'Enter state or province',
      zipCode: 'Enter ZIP or postal code',
      country: 'Enter country',
    },
    maps: {
      searchAddress: 'Search address with Google Maps',
      optionalManual: 'You can also enter the address manually.',
      unavailable: 'Google Maps is temporarily unavailable.',
      notConfigured: 'Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to .env.local.',
    },
    mapsDemo: {
      title: 'Contact Registration',
      subtitle: 'Official Google Maps geolocation module for address registration.',
      evaluator: 'Evaluator Panel',
      geolocationTelemetry: 'Real-Time Geolocation',
      parsedLocationData: 'Parsed Location Data',
      latitude: 'Latitude',
      longitude: 'Longitude',
    },
  },
  es: {
    common: { language: 'Idioma', save: 'Guardar' },
    contacts: {
      addTitle: 'Agregar nuevo contacto',
      newDetails: 'Ingresa los datos del nuevo contacto',
      fullName: 'Nombre completo',
      phone: 'Número de teléfono',
      email: 'Correo electrónico',
      documentType: 'Tipo de documento',
      documentNumber: 'Número de documento',
      selectDocumentType: 'Ingresa el número de documento',
      type: 'Tipo de contacto',
      customer: 'Cliente',
      vendor: 'Proveedor',
      address: 'Dirección',
      streetAddress: 'Dirección',
      city: 'Ciudad',
      state: 'Estado/Provincia',
      zipCode: 'Código postal',
      country: 'País',
    },
    placeholders: {
      fullName: 'Ingresa el nombre completo',
      phone: 'Ingresa el número de teléfono',
      email: 'Ingresa el correo electrónico',
      street: 'Ingresa la dirección',
      city: 'Ingresa la ciudad',
      state: 'Ingresa el estado o provincia',
      zipCode: 'Ingresa el código postal',
      country: 'Ingresa el país',
    },
    maps: {
      searchAddress: 'Buscar dirección con Google Maps',
      optionalManual: 'También puedes ingresar la dirección manualmente.',
      unavailable: 'Google Maps no está disponible temporalmente.',
      notConfigured: 'Agrega NEXT_PUBLIC_GOOGLE_MAPS_API_KEY a .env.local.',
    },
    mapsDemo: {
      title: 'Registro de Contactos',
      subtitle: 'Módulo oficial de geolocalización de Google Maps para registrar direcciones.',
      evaluator: 'Panel del evaluador',
      geolocationTelemetry: 'Geolocalización en Tiempo Real',
      parsedLocationData: 'Datos de Ubicación Parseada',
      latitude: 'Latitud',
      longitude: 'Longitud',
    },
  },
} as const;

export function getTranslation(language: Language, key: string): string {
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (typeof current !== 'object' || current === null) return undefined;
    return (current as Record<string, unknown>)[part];
  }, dictionary[language]);
  return typeof value === 'string' ? value : key;
}
