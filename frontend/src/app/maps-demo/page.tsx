'use client';

import { useState } from 'react';
import { APIProvider } from '@vis.gl/react-google-maps';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AddressAutocomplete, AddressComponents, AddressSelection } from '@/components/maps/AddressAutocomplete';
import { GoogleMap } from '@/components/maps/GoogleMap';
import { LanguageSelector } from '@/components/LanguageSelector';
import { useLanguage } from '@/contexts/LanguageContext';

const EMPTY_ADDRESS: AddressComponents = {
  street: '',
  city: '',
  state: '',
  zipCode: '',
  country: '',
};

export default function MapsDemoPage() {
  const { t } = useLanguage();
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [address, setAddress] = useState<AddressComponents>(EMPTY_ADDRESS);
  const [searchValue, setSearchValue] = useState('');
  const [latitude, setLatitude] = useState<number | undefined>();
  const [longitude, setLongitude] = useState<number | undefined>();
  const [source, setSource] = useState('');

  const handlePlaceSelect = (selection: AddressSelection) => {
    setSearchValue(selection.address);
    setAddress(selection.addressComponents);
    setLatitude(selection.latitude);
    setLongitude(selection.longitude);
    setSource(t('mapsDemo.googleSource'));
  };

  const handleMapAddressChange = (nextAddress: AddressComponents) => {
    setAddress(nextAddress);
    setSource(t('mapsDemo.nominatimSource'));
  };

  const handleAddressInput = (field: keyof AddressComponents, value: string) => {
    setAddress((previous) => ({ ...previous, [field]: value }));
    if (field === 'street') {
      setSearchValue(value);
    }
  };

  return (
    <main className="min-h-screen bg-muted/30 p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">{t('mapsDemo.title')}</h1>
            <p className="text-muted-foreground">{t('mapsDemo.subtitle')}</p>
          </div>
          <LanguageSelector />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <Card>
            <CardHeader>
              <CardTitle>{t('contacts.address')}</CardTitle>
              <CardDescription>{t('mapsDemo.manualFallback')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {apiKey ? (
                <APIProvider apiKey={apiKey} libraries={['places']} version="weekly">
                  <AddressAutocomplete
                    value={searchValue}
                    onChange={setSearchValue}
                    onPlaceSelect={handlePlaceSelect}
                    placeholder={t('maps.searchAddress')}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </APIProvider>
              ) : (
                <Input
                  value={searchValue}
                  onChange={(event) => setSearchValue(event.target.value)}
                  placeholder={t('maps.manualAddress')}
                />
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                {([
                  ['street', t('contacts.streetAddress')],
                  ['city', t('contacts.city')],
                  ['state', t('contacts.state')],
                  ['zipCode', t('contacts.zipCode')],
                  ['country', t('contacts.country')],
                ] as const).map(([field, label]) => (
                  <div className="space-y-2" key={field}>
                    <Label htmlFor={`demo-${field}`}>{label}</Label>
                    <Input
                      id={`demo-${field}`}
                      value={address[field]}
                      onChange={(event) => handleAddressInput(field, event.target.value)}
                      placeholder={label}
                    />
                  </div>
                ))}
              </div>

              <GoogleMap
                latitude={latitude}
                longitude={longitude}
                onLocationChange={(lat, lng) => {
                  setLatitude(lat);
                  setLongitude(lng);
                }}
                onAddressChange={handleMapAddressChange}
              />
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card className="border-slate-800 bg-slate-950 text-slate-100">
              <CardHeader>
                <CardTitle>{t('mapsDemo.evaluator')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 font-mono text-sm">
                <div>
                  <p className="text-slate-400">{t('mapsDemo.coordinates')}</p>
                  <p>{t('mapsDemo.latitude')}: {latitude?.toFixed(6) || '—'}</p>
                  <p>{t('mapsDemo.longitude')}: {longitude?.toFixed(6) || '—'}</p>
                </div>
                <div>
                  <p className="text-slate-400">{t('mapsDemo.source')}</p>
                  <p className="text-emerald-300">{source || '—'}</p>
                </div>
                <div>
                  <p className="mb-2 text-slate-400">{t('mapsDemo.addressData')}</p>
                  <pre className="overflow-auto rounded bg-slate-900 p-3 text-xs text-sky-200">
                    {JSON.stringify(address, null, 2)}
                  </pre>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('mapsDemo.architecture')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{t('mapsDemo.architectureText')}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
