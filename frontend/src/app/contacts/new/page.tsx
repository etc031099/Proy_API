'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
import { CreateContactData } from '@/types';
import { ArrowLeft, Plus, User, Phone, Mail, MapPin, CreditCard, FileText } from 'lucide-react';
import { FadeIn, SlideIn, FormFieldAnimation, ScaleOnHover } from '@/components/animations';

export default function AddContactPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [documentMessage, setDocumentMessage] = useState('');

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
    businessId: '20765432102',
    creditLimit: 0,
    notes: ''
  } as any);

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
        businessId: '20765432101',
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

      const response = await apiClient.createContact(payload as any);
      if (response.success) {
        setSuccess('Contact created successfully!');
        setTimeout(() => {
          router.push('/contacts');
        }, 1500);
      } else {
        setError(response.message || 'Failed to create contact');
      }
    } catch (err: any) {
      const apiError = err.response?.data;
      const validationErrors = Array.isArray(apiError?.errors)
        ? apiError.errors.map((e: any) => e.field ? `${e.field}: ${e.message}` : e.message).join(' | ')
        : '';

      setError(validationErrors || apiError?.message || 'Failed to create contact');
    } finally {
      setLoading(false);
    }
  };

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
                <h1 className="text-3xl font-bold">Add New Contact</h1>
                <p className="text-muted-foreground">Create a new customer or vendor</p>
              </div>
            </div>
          </FadeIn>

          <SlideIn direction="up" duration={0.5}>
            <Card className="max-w-4xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  Contact Information
                </CardTitle>
                <CardDescription>
                  Enter the details for the new contact
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
                          Full Name *
                        </Label>
                        <Input
                          id="name"
                          name="name"
                          type="text"
                          placeholder="Enter full name"
                          value={formData.name}
                          onChange={handleChange}
                          required
                          className="transition-all duration-300 focus:scale-105"
                        />
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.3}>
                      <div className="space-y-2">
                        <Label htmlFor="type">Contact Type *</Label>
                        <Select value={formData.type} onValueChange={handleTypeChange}>
                          <SelectTrigger className="transition-all duration-300 focus:scale-105">
                            <SelectValue placeholder="Select contact type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="customer">Customer</SelectItem>
                            <SelectItem value="vendor">Vendor</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.4}>
                      <div className="space-y-2">
                        <Label htmlFor="phone">
                          <Phone className="inline h-4 w-4 mr-1" />
                          Phone Number *
                        </Label>
                        <Input
                          id="phone"
                          name="phone"
                          type="tel"
                          placeholder="Enter phone number"
                          value={formData.phone}
                          onChange={handleChange}
                          required
                          className="transition-all duration-300 focus:scale-105"
                        />
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.5}>
                      <div className="space-y-2">
                        <Label htmlFor="documentType">Document Type</Label>
                        <div className="flex gap-2">
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
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="dni">DNI</SelectItem>
                              <SelectItem value="ruc">RUC</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </FormFieldAnimation>

                    <FormFieldAnimation delay={0.6}>
                      <div className="space-y-2">
                        <Label htmlFor="documentNumber">Document Number</Label>
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
                          Email Address
                        </Label>
                        <Input
                          id="email"
                          name="email"
                          type="email"
                          placeholder="Enter email address"
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
                        <Label className="text-base font-semibold">Address</Label>
                      </div>
                      
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="address.street">Street Address</Label>
                          <Input
                            id="address.street"
                            name="address.street"
                            type="text"
                            placeholder="Enter street address"
                            value={formData.address?.street || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="address.city">City</Label>
                          <Input
                            id="address.city"
                            name="address.city"
                            type="text"
                            placeholder="Enter city"
                            value={formData.address?.city || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="address.state">State/Province</Label>
                          <Input
                            id="address.state"
                            name="address.state"
                            type="text"
                            placeholder="Enter state or province"
                            value={formData.address?.state || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="address.zipCode">ZIP/Postal Code</Label>
                          <Input
                            id="address.zipCode"
                            name="address.zipCode"
                            type="text"
                            placeholder="Enter ZIP or postal code"
                            value={formData.address?.zipCode || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="address.country">Country</Label>
                          <Input
                            id="address.country"
                            name="address.country"
                            type="text"
                            placeholder="Enter country"
                            value={formData.address?.country || ''}
                            onChange={handleChange}
                            className="transition-all duration-300 focus:scale-105"
                          />
                        </div>
                      </div>
                    </div>
                  </FormFieldAnimation>

                  {/* Financial Information */}
                  <div className="grid gap-6 md:grid-cols-2">
                    <FormFieldAnimation delay={0.7}>
                      <div className="space-y-2">
                        <Label htmlFor="creditLimit">
                          <CreditCard className="inline h-4 w-4 mr-1" />
                          Credit Limit
                        </Label>
                        <Input
                          id="creditLimit"
                          name="creditLimit"
                          type="number"
                          placeholder="Enter credit limit"
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
                          Notes
                        </Label>
                        <Textarea
                          id="notes"
                          name="notes"
                          placeholder="Enter any additional notes"
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
                          <Plus className="mr-2 h-4 w-4" />
                          {loading ? 'Creating Contact...' : 'Create Contact'}
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