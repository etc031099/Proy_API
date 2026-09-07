'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient } from '@/lib/api';
import { Contact, CreateContactData } from '@/types';
import { ArrowLeft, Save, User, Phone, Mail, MapPin, CreditCard, FileText } from 'lucide-react';
import { FadeIn, SlideIn, FormFieldAnimation, ScaleOnHover } from '@/components/animations';
import { APIProvider } from '@vis.gl/react-google-maps';
import { AddressAutocomplete, AddressSelection } from '@/components/maps/AddressAutocomplete';
import { GoogleMap } from '@/components/maps/GoogleMap';
import { useLanguage } from '@/contexts/LanguageContext';

export default function EditContactPage() {
  const router = useRouter();
  const params = useParams();
  const contactId = params?.id as string;
  
  const [loading, setLoading] = useState(false);
  const [loadingContact, setLoadingContact] = useState(true);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [documentMessage, setDocumentMessage] = useState('');
  const [contact, setContact] = useState<Contact | null>(null);

  const [formData, setFormData] = useState<CreateContactData>({
    name: '',
    phone: '',
    documentType: 'dni',
    documentNumber: '',
    email: '',
    address: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: ''
    },
    type: 'customer',
    creditLimit: 0,
    notes: '',
    latitude: undefined,
    longitude: undefined
  });
  const googleMapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const { t } = useLanguage();

  useEffect(() => {
    if (contactId) {
      loadContact();
    }
  }, [contactId]);

  const loadContact = async () => {
    try {
      const response = await apiClient.getContact(contactId);
      if (response.success) {
        const contactData = response.data.contact;
        setContact(contactData);
        setFormData({
          name: contactData.name,
          phone: contactData.phone,
          documentType: contactData.documentType || 'dni',
          documentNumber: contactData.documentNumber || '',
          email: contactData.email || '',
          address: contactData.address || {
            street: '',
            city: '',
            state: '',
            zipCode: '',
            country: ''
          },
          type: contactData.type,
          creditLimit: contactData.creditLimit || 0,
          notes: contactData.notes || '',
          latitude: contactData.latitude,
          longitude: contactData.longitude
        });
      } else {
        setError('Failed to load contact');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load contact');
    } finally {
      setLoadingContact(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    if (name.startsWith('address.')) {
      const addressField = name.split('.')[1];
      setFormData(prev => ({
        ...prev,
        address: {
          ...prev.address,
          [addressField]: value
        }
      }));
      return;
    }

    if (name === 'documentNumber') {
      setFormData(prev => ({
        ...prev,
        documentNumber: value,
        name: '',
        email: '',
        notes: ''
      }));
      return;
    }

    setFormData(prev => ({
      ...prev,
      [name]: name === 'creditLimit' ? Number(value) : value
    }));
  };

  const handleTypeChange = (value: 'customer' | 'vendor') => {
    setFormData(prev => ({
      ...prev,
      type: value
    }));
  };

  const handleAddressSelection = (selection: AddressSelection) => {
    setFormData(prev => ({
      ...prev,
      address: {
        ...prev.address,
        ...selection.addressComponents
      },
      latitude: selection.latitude,
      longitude: selection.longitude
    }));
  };

  const handleMapLocationChange = (latitude: number, longitude: number) => {
    setFormData(prev => ({ ...prev, latitude, longitude }));
  };

  const handleMapAddressChange = (address: AddressSelection['addressComponents']) => {
    setFormData(prev => ({
      ...prev,
      address: {
        ...prev.address,
        street: address.street,
        city: address.city,
        state: address.state,
        zipCode: address.zipCode,
        country: address.country,
      },
    }));
  };

  useEffect(() => {
    const documentNumber = formData.documentNumber?.trim() || '';
    if (!documentNumber) {
      return;
    }

    const expectedLength = (formData.documentType || 'dni') === 'ruc' ? 11 : 8;
    if (documentNumber.length < expectedLength) {
      return;
    }

    const timer = setTimeout(() => {
      handleDocumentLookup();
    }, 500);

    return () => clearTimeout(timer);
  }, [formData.documentType, formData.documentNumber]);

  const handleDocumentLookup = async () => {
    const documentType = formData.documentType || 'dni';
    const documentNumber = formData.documentNumber?.trim();

    if (!documentNumber) {
      setDocumentMessage('Ingrese un DNI o RUC para buscar datos.');
      return;
    }

    setDocumentLoading(true);
    setDocumentMessage('');
    setError('');

    try {
      const response = await apiClient.validateDocument(documentType, documentNumber);
      const result = response?.data?.data ?? response?.data ?? response;

      if (!result?.valid) {
        setFormData(prev => ({
          ...prev,
          name: '',
          email: '',
          notes: ''
        }));
        setDocumentMessage(result?.message || 'No se pudo validar el documento.');
        return;
      }

      const details = result?.details ?? {};
      setFormData(prev => ({
        ...prev,
        name: details.name || '',
        email: details.email || '',
        notes: details.company ? `Cliente validado: ${details.company}` : '',
      }));

      setDocumentMessage(result?.message || 'Documento válido.');
    } catch (err: any) {
      const apiError = err.response?.data;
      setFormData(prev => ({
        ...prev,
        name: '',
        email: '',
        notes: ''
      }));
      setDocumentMessage(apiError?.message || 'No se pudieron completar los datos del documento.');
    } finally {
      setDocumentLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      const payload = {
        ...formData,
        documentType: formData.documentType?.trim() || undefined,
        documentNumber: formData.documentNumber?.trim() || undefined,
        email: formData.email?.trim() || undefined,
        notes: formData.notes?.trim() || undefined,
        address: {
          ...formData.address,
          street: formData.address?.street?.trim() || undefined,
          city: formData.address?.city?.trim() || undefined,
          state: formData.address?.state?.trim() || undefined,
          zipCode: formData.address?.zipCode?.trim() || undefined,
          country: formData.address?.country?.trim() || undefined,
        }
      };

      const response = await apiClient.updateContact(contactId, payload);
      if (response.success) {
        setSuccess('Contact updated successfully!');
        setTimeout(() => {
          router.push('/contacts');
        }, 1500);
      } else {
        setError(response.message || 'Failed to update contact');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update contact');
    } finally {
      setLoading(false);
    }
  };

  if (loadingContact) {
    return (
      <ProtectedRoute>
        <Layout>
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">{t('contacts.loading')}</p>
            </div>
          </div>
        </Layout>
      </ProtectedRoute>
    );
  }

  if (!contact) {
    return (
      <ProtectedRoute>
        <Layout>
          <div className="space-y-6">
            <div className="flex items-center gap-4">
              <Button variant="outline" onClick={() => router.push('/contacts')}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Contacts
              </Button>
            </div>
            <Alert variant="destructive">
              <AlertDescription>{error || 'Contact not found'}</AlertDescription>
            </Alert>
          </div>
        </Layout>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
      <Layout>
        <div className="space-y-6">
          <FadeIn delay={0.1}>
            <div className="flex items-center space-x-2">
              <Link href="/contacts">
                <ScaleOnHover>
                  <Button variant="outline" size="sm">
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                </ScaleOnHover>
              </Link>
              <div>
                <h1 className="text-3xl font-bold">{t('contacts.editTitle')}</h1>
                <p className="text-muted-foreground">{t('contacts.editSubtitle')}</p>
              </div>
            </div>
          </FadeIn>

          <SlideIn direction="up" duration={0.5}>
            <Card className="max-w-4xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  {t('contacts.information')}
                </CardTitle>
                <CardDescription>
                  Update the details for {contact.name}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-6">
                  {error && (
                    <SlideIn direction="down" duration={0.3}>
                      <Alert variant="destructive">
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    </SlideIn>
                  )}

                  {success && (
                    <SlideIn direction="down" duration={0.3}>
                      <Alert className="border-green-200 bg-green-50 text-green-800">
                        <AlertDescription>{success}</AlertDescription>
                      </Alert>
                    </SlideIn>
                  )}

                  {documentMessage && (
                    <SlideIn direction="down" duration={0.3}>
                      <Alert className={documentMessage.toLowerCase().includes('válido') || documentMessage.toLowerCase().includes('valid') ? 'border-green-200 bg-green-50 text-green-800' : 'border-blue-200 bg-blue-50 text-blue-800'}>
                        <AlertDescription>{documentMessage}</AlertDescription>
                      </Alert>
                    </SlideIn>
                  )}

                  {/* Basic Information */}
                  <div className="grid gap-6 md:grid-cols-2">
                    <FormFieldAnimation delay={0.2}>
                      <div className="space-y-2">
                        <Label htmlFor="name">
                          <User className="inline h-4 w-4 mr-1" />
                          {t('contacts.fullName')} *
                        </Label>
                        <Input
                          id="name"
                          name="name"
                          type="text"
                          placeholder={t('placeholders.fullName')}
                          value={formData.name}
                          onChange={handleChange}
                          required
                          className="transition-all duration-300 focus:scale-105"
                        />
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.3}>
                      <div className="space-y-2">
                        <Label htmlFor="type">{t('contacts.type')} *</Label>
                        <Select value={formData.type} onValueChange={handleTypeChange}>
                          <SelectTrigger className="transition-all duration-300 focus:scale-105">
                            <SelectValue placeholder={t('contacts.selectType')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="customer">{t('contacts.customer')}</SelectItem>
                            <SelectItem value="vendor">{t('contacts.vendor')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.4}>
                      <div className="space-y-2">
                        <Label htmlFor="phone">
                          <Phone className="inline h-4 w-4 mr-1" />
                          {t('contacts.phone')} *
                        </Label>
                        <Input
                          id="phone"
                          name="phone"
                          type="tel"
                          placeholder={t('placeholders.phone')}
                          value={formData.phone}
                          onChange={handleChange}
                          required
                          className="transition-all duration-300 focus:scale-105"
                        />
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.5}>
                      <div className="space-y-2">
                        <Label htmlFor="documentType">{t('contacts.documentType')}</Label>
                        <Select
                          value={formData.documentType || 'dni'}
                          onValueChange={(value) => setFormData(prev => ({
                            ...prev,
                            documentType: value as 'dni' | 'ruc',
                            documentNumber: '',
                            name: '',
                            email: '',
                            notes: ''
                          }))}
                        >
                          <SelectTrigger className="transition-all duration-300 focus:scale-105">
                            <SelectValue placeholder={t('contacts.selectDocumentType')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="dni">DNI</SelectItem>
                            <SelectItem value="ruc">RUC</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.6}>
                      <div className="space-y-2">
                        <Label htmlFor="documentNumber">{t('contacts.documentNumber')}</Label>
                        <div className="flex gap-2">
                          <Input
                            id="documentNumber"
                            name="documentNumber"
                            type="text"
                            placeholder={formData.documentType === 'ruc' ? '20123456789' : '12345678'}
                            value={formData.documentNumber || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleDocumentLookup}
                            disabled={documentLoading}
                            className="whitespace-nowrap"
                          >
                            {documentLoading ? 'Buscando...' : 'Buscar'}
                          </Button>
                        </div>
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.7}>
                      <div className="space-y-2">
                        <Label htmlFor="email">
                          <Mail className="inline h-4 w-4 mr-1" />
                          {t('contacts.email')}
                        </Label>
                        <Input
                          id="email"
                          name="email"
                          type="email"
                          placeholder={t('placeholders.email')}
                          value={formData.email}
                          onChange={handleChange}
                          className="transition-all duration-300 focus:scale-105"
                        />
                      </div>
                    </FormFieldAnimation>
                  </div>

                  {/* Address Information */}
                  <FormFieldAnimation delay={0.6}>
                    <div className="space-y-4">
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4" />
                        <Label className="text-base font-semibold">{t('contacts.address')}</Label>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="google-address-search">{t('maps.searchAddress')}</Label>
                        {googleMapsApiKey ? (
                          <APIProvider apiKey={googleMapsApiKey} libraries={['places']}>
                            <AddressAutocomplete
                              value={formData.address?.street || ''}
                              onChange={(value) => setFormData(prev => ({
                                ...prev,
                                address: { ...prev.address, street: value }
                              }))}
                              onPlaceSelect={handleAddressSelection}
                              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            />
                          </APIProvider>
                        ) : (
                          <Input
                            id="google-address-search"
                            placeholder={t('maps.manualAddress')}
                            value={formData.address?.street || ''}
                            onChange={(event) => setFormData(prev => ({
                              ...prev,
                              address: { ...prev.address, street: event.target.value }
                            }))}
                          />
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t('maps.optionalManual')}
                        </p>
                      </div>
                      
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="address.street">{t('contacts.streetAddress')}</Label>
                          <Input
                            id="address.street"
                            name="address.street"
                            type="text"
                            placeholder={t('placeholders.street')}
                            value={formData.address?.street || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="address.city">{t('contacts.city')}</Label>
                          <Input
                            id="address.city"
                            name="address.city"
                            type="text"
                            placeholder={t('placeholders.city')}
                            value={formData.address?.city || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="address.state">{t('contacts.state')}</Label>
                          <Input
                            id="address.state"
                            name="address.state"
                            type="text"
                            placeholder={t('placeholders.state')}
                            value={formData.address?.state || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="address.zipCode">{t('contacts.zipCode')}</Label>
                          <Input
                            id="address.zipCode"
                            name="address.zipCode"
                            type="text"
                            placeholder={t('placeholders.zipCode')}
                            value={formData.address?.zipCode || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="address.country">{t('contacts.country')}</Label>
                          <Input
                            id="address.country"
                            name="address.country"
                            type="text"
                            placeholder={t('placeholders.country')}
                            value={formData.address?.country || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>
                      </div>

                      <GoogleMap
                        latitude={formData.latitude}
                        longitude={formData.longitude}
                        onLocationChange={handleMapLocationChange}
                        onAddressChange={handleMapAddressChange}
                      />
                    </div>
                  </FormFieldAnimation>

                  {/* Financial Information */}
                  <div className="grid gap-6 md:grid-cols-2">
                    <FormFieldAnimation delay={0.7}>
                      <div className="space-y-2">
                        <Label htmlFor="creditLimit">
                          <CreditCard className="inline h-4 w-4 mr-1" />
                          {t('contacts.creditLimit')}
                        </Label>
                        <Input
                          id="creditLimit"
                          name="creditLimit"
                          type="number"
                          placeholder={t('placeholders.creditLimit')}
                          value={formData.creditLimit}
                          onChange={handleChange}
                          min="0"
                          step="0.01"
                          className="transition-all duration-300 focus:scale-105"
                        />
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.8}>
                      <div className="space-y-2">
                        <Label htmlFor="notes">
                          <FileText className="inline h-4 w-4 mr-1" />
                          {t('contacts.notes')}
                        </Label>
                        <Textarea
                          id="notes"
                          name="notes"
                          placeholder={t('placeholders.additionalNotes')}
                          value={formData.notes}
                          onChange={handleChange}
                          className="transition-all duration-300 focus:scale-105"
                          rows={3}
                        />
                      </div>
                    </FormFieldAnimation>
                  </div>

                  {/* Submit Button */}
                  <FormFieldAnimation delay={0.9}>
                    <div className="flex gap-4 pt-4">
                      <ScaleOnHover>
                        <Button 
                          type="submit" 
                          className="flex-1 transition-all duration-300" 
                          disabled={loading}
                        >
                          <Save className="mr-2 h-4 w-4" />
                          {loading ? 'Updating Contact...' : 'Update Contact'}
                        </Button>
                      </ScaleOnHover>
                      
                      <ScaleOnHover>
                        <Button 
                          type="button" 
                          variant="outline" 
                          onClick={() => router.push('/contacts')}
                          className="transition-all duration-300"
                        >
                          Cancel
                        </Button>
                      </ScaleOnHover>
                    </div>
                  </FormFieldAnimation>
                </form>
              </CardContent>
            </Card>
          </SlideIn>
        </div>
      </Layout>
    </ProtectedRoute>
  );
}