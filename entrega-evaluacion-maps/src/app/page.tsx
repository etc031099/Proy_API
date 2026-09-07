'use client';

import { useState } from 'react';
import { APIProvider } from '@vis.gl/react-google-maps';
import { AddressAutocomplete, AddressSelection, AddressComponents } from '@/components/maps/AddressAutocomplete';
import { GoogleMap } from '@/components/maps/GoogleMap';
import { useLanguage } from '@/contexts/LanguageContext';

const emptyAddress: AddressComponents = { street: '', city: '', state: '', zipCode: '', country: '' };

export default function EvaluationPage() {
  const { language, setLanguage, t } = useLanguage();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [documentType, setDocumentType] = useState('dni');
  const [documentNumber, setDocumentNumber] = useState('');
  const [email, setEmail] = useState('');
  const [contactType, setContactType] = useState('customer');
  const [address, setAddress] = useState<AddressComponents>(emptyAddress);
  const [search, setSearch] = useState('');
  const [latitude, setLatitude] = useState<number>();
  const [longitude, setLongitude] = useState<number>();

  const handlePlaceSelect = (selection: AddressSelection) => {
    setSearch(selection.address);
    setAddress(selection.addressComponents);
    setLatitude(selection.latitude);
    setLongitude(selection.longitude);
  };

  return (
    <main>
      <div className="topbar">
        <div>
          <h1>{t('mapsDemo.title')}</h1>
          <p>{t('mapsDemo.subtitle')}</p>
        </div>
        <div className="language" aria-label={t('common.language')}>
          <span>{t('common.language')}: </span>
          <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>EN</button>
          <span>|</span>
          <button className={language === 'es' ? 'active' : ''} onClick={() => setLanguage('es')}>ES</button>
        </div>
      </div>

      <div className="grid">
        <section className="card">
          <h2>{t('contacts.addTitle')}</h2>
          <p>{t('contacts.newDetails')}</p>
          <div className="field">
            <label htmlFor="name">{t('contacts.fullName')}</label>
            <input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('placeholders.fullName')} />
          </div>
          <div className="address-grid">
            <div className="field">
              <label htmlFor="phone">{t('contacts.phone')}</label>
              <input id="phone" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder={t('placeholders.phone')} />
            </div>
            <div className="field">
              <label htmlFor="email">{t('contacts.email')}</label>
              <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t('placeholders.email')} />
            </div>
            <div className="field">
              <label htmlFor="documentType">{t('contacts.documentType')}</label>
              <select id="documentType" value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
                <option value="dni">DNI</option>
                <option value="ruc">RUC</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="documentNumber">{t('contacts.documentNumber')}</label>
              <input id="documentNumber" value={documentNumber} onChange={(event) => setDocumentNumber(event.target.value)} placeholder={t('contacts.selectDocumentType')} />
            </div>
            <div className="field">
              <label htmlFor="contactType">{t('contacts.type')}</label>
              <select id="contactType" value={contactType} onChange={(event) => setContactType(event.target.value)}>
                <option value="customer">{t('contacts.customer')}</option>
                <option value="vendor">{t('contacts.vendor')}</option>
              </select>
            </div>
          </div>

          <h2>{t('contacts.address')}</h2>
          <div className="field">
            <label htmlFor="search">{t('maps.searchAddress')}</label>
            <APIProvider apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || ''} libraries={['places']} version="weekly">
              <AddressAutocomplete
                value={search}
                onChange={setSearch}
                onPlaceSelect={handlePlaceSelect}
                placeholder={t('maps.searchAddress')}
              />
            </APIProvider>
          </div>
          <div className="address-grid">
            {([
              ['street', t('contacts.streetAddress'), 'placeholders.street'],
              ['city', t('contacts.city'), 'placeholders.city'],
              ['state', t('contacts.state'), 'placeholders.state'],
              ['zipCode', t('contacts.zipCode'), 'placeholders.zipCode'],
              ['country', t('contacts.country'), 'placeholders.country'],
            ] as const).map(([key, label, placeholderKey]) => (
              <div className="field" key={key}>
                <label htmlFor={key}>{label}</label>
                <input id={key} value={address[key]} placeholder={t(placeholderKey)} onChange={(event) => setAddress((current) => ({ ...current, [key]: event.target.value }))} />
              </div>
            ))}
          </div>
          <div className="map-wrap">
            <GoogleMap
              latitude={latitude}
              longitude={longitude}
              onLocationChange={(lat, lng) => { setLatitude(lat); setLongitude(lng); }}
              onAddressChange={setAddress}
            />
          </div>
          <button className="save" type="button" onClick={() => window.alert(language === 'en' ? 'Contact saved successfully.' : 'Contacto guardado correctamente.')}>
            {t('common.save')}
          </button>
        </section>

        <aside className="card">
          <span className="badge">{t('mapsDemo.evaluator')}</span>
          <h2>{t('mapsDemo.geolocationTelemetry')}</h2>
          <p><strong>{t('mapsDemo.latitude')}:</strong> {latitude ?? '—'}</p>
          <p><strong>{t('mapsDemo.longitude')}:</strong> {longitude ?? '—'}</p>
          <h2>{t('mapsDemo.parsedLocationData')}</h2>
          <pre className="json">{JSON.stringify(address, null, 2)}</pre>
        </aside>
      </div>
    </main>
  );
}
