'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FadeIn, SlideIn, FormFieldAnimation, LoadingSpinner } from '@/components/animations';

export default function RegisterPage() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    businessId: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { register, user, loading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user && !authLoading) {
      router.replace('/dashboard');
    }
  }, [user, authLoading, router]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4">
        <div className="flex items-center space-x-2">
          <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary"></div>
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  if (user) {
    return null;
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (formData.password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres.');
      return;
    }
    if (!/[a-z]/.test(formData.password) || !/[A-Z]/.test(formData.password) || !/\d/.test(formData.password)) {
      setError('La contraseña debe incluir al menos una letra mayúscula, una minúscula y un número.');
      return;
    }

    setLoading(true);

    try {
      await register(formData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4">
      <FadeIn delay={0.2}>
        <SlideIn direction="up" duration={0.5}>
          <Card className="w-full max-w-md shadow-lg hover:shadow-xl transition-shadow duration-300">
            <CardHeader className="space-y-1">
              <FadeIn delay={0.4}>
                <CardTitle className="text-2xl text-center">Create an account</CardTitle>
              </FadeIn>
              <FadeIn delay={0.5}>
                <CardDescription className="text-center">
                  Enter your details to create your account
                </CardDescription>
              </FadeIn>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <SlideIn direction="down" duration={0.3}>
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  </SlideIn>
                )}
                
                <FormFieldAnimation delay={0.6}>
                  <div className="space-y-2">
                    <Label htmlFor="name">Full Name</Label>
                    <Input
                      id="name"
                      name="name"
                      type="text"
                      placeholder="John Doe"
                      value={formData.name}
                      onChange={handleChange}
                      required
                      className="transition-all duration-300 focus:scale-105"
                    />
                  </div>
                </FormFieldAnimation>
                
                <FormFieldAnimation delay={0.7}>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      placeholder="m@example.com"
                      value={formData.email}
                      onChange={handleChange}
                      required
                      className="transition-all duration-300 focus:scale-105"
                    />
                  </div>
                </FormFieldAnimation>
                
                <FormFieldAnimation delay={0.8}>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      value={formData.password}
                      onChange={handleChange}
                      minLength={6}
                      autoComplete="new-password"
                      aria-describedby="password-requirements"
                      required
                      className="transition-all duration-300 focus:scale-105"
                    />
                    <div id="password-requirements" className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">Password requirements:</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        <li className={formData.password.length >= 6 ? 'text-green-600' : ''}>
                          At least 6 characters
                        </li>
                        <li className={/[A-Z]/.test(formData.password) ? 'text-green-600' : ''}>
                          At least one uppercase letter
                        </li>
                        <li className={/[a-z]/.test(formData.password) ? 'text-green-600' : ''}>
                          At least one lowercase letter
                        </li>
                        <li className={/\d/.test(formData.password) ? 'text-green-600' : ''}>
                          At least one number
                        </li>
                      </ul>
                    </div>
                  </div>
                </FormFieldAnimation>
                
                <FormFieldAnimation delay={0.9}>
                  <div className="space-y-2">
                    <Label htmlFor="businessId">Business ID</Label>
                    <Input
                      id="businessId"
                      name="businessId"
                      type="text"
                      placeholder="my-business-001"
                      value={formData.businessId}
                      onChange={handleChange}
                      required
                      className="transition-all duration-300 focus:scale-105"
                    />
                  </div>
                </FormFieldAnimation>
                
                <FormFieldAnimation delay={1.0}>
                  <Button 
                    type="submit" 
                    className="w-full transition-all duration-300 hover:scale-105" 
                    disabled={loading}
                  >
                    {loading ? (
                      <div className="flex items-center space-x-2">
                        <LoadingSpinner size={16} />
                        <span>Creating account...</span>
                      </div>
                    ) : (
                      'Create account'
                    )}
                  </Button>
                </FormFieldAnimation>
              </form>
              
              <FadeIn delay={1.1}>
                <div className="mt-4 text-center text-sm">
                  Already have an account?{' '}
                  <Link href="/login" className="text-primary hover:underline transition-colors duration-300 hover:scale-105 inline-block">
                    Sign in
                  </Link>
                </div>
              </FadeIn>
            </CardContent>
          </Card>
        </SlideIn>
      </FadeIn>
    </div>
  );
}