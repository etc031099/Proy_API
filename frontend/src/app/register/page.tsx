'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
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
  const { register, user, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const { t } = useLanguage();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4">
        <div className="flex items-center space-x-2">
          <LoadingSpinner size={20} />
          <span>{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  // A signed-in visitor must NOT be silently bounced into the existing session.
  // Showing an explicit message makes it clear why no new account was created.
  if (user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4">
        <FadeIn delay={0.2}>
          <Card className="w-full max-w-md shadow-lg">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl text-center">{t('auth.alreadySignedIn')}</CardTitle>
              <CardDescription className="text-center">
                {t('auth.alreadySignedInDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md bg-muted/50 p-3 text-center text-sm">
                <span className="font-medium">{user.email}</span>
              </div>
              <Button className="w-full" onClick={() => router.replace('/dashboard')}>
                {t('auth.goToDashboard')}
              </Button>
              <Button variant="outline" className="w-full" onClick={() => logout()}>
                {t('common.logout')}
              </Button>
            </CardContent>
          </Card>
        </FadeIn>
      </div>
    );
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
      setError(t('auth.passwordMinError'));
      return;
    }
    if (!/[a-z]/.test(formData.password) || !/[A-Z]/.test(formData.password) || !/\d/.test(formData.password)) {
      setError(t('auth.passwordComplexityError'));
      return;
    }

    setLoading(true);

    try {
      await register(formData);
    } catch (err: any) {
      if (err?.code === 'EMAIL_EXISTS') {
        setError(t('auth.emailExistsError'));
      } else if (err?.code === 'BUSINESS_EXISTS') {
        setError(t('auth.businessExistsError'));
      } else if (/timeout|network/i.test(err?.message || '')) {
        setError(t('auth.serverWakingUp'));
      } else {
        setError(err?.message || 'Registration failed');
      }
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
                <CardTitle className="text-2xl text-center">{t('auth.createTitle')}</CardTitle>
              </FadeIn>
              <FadeIn delay={0.5}>
                <CardDescription className="text-center">
                  {t('auth.createDescription')}
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
                    <Label htmlFor="name">{t('auth.fullName')}</Label>
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
                    <Label htmlFor="email">{t('auth.email')}</Label>
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
                    <Label htmlFor="password">{t('auth.password')}</Label>
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
                      <p className="font-medium text-foreground">{t('auth.passwordTitle')}</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        <li className={formData.password.length >= 6 ? 'text-green-600' : ''}>
                          {t('auth.reqLength')}
                        </li>
                        <li className={/[A-Z]/.test(formData.password) ? 'text-green-600' : ''}>
                          {t('auth.reqUpper')}
                        </li>
                        <li className={/[a-z]/.test(formData.password) ? 'text-green-600' : ''}>
                          {t('auth.reqLower')}
                        </li>
                        <li className={/\d/.test(formData.password) ? 'text-green-600' : ''}>
                          {t('auth.reqNumber')}
                        </li>
                      </ul>
                    </div>
                  </div>
                </FormFieldAnimation>
                
                <FormFieldAnimation delay={0.9}>
                  <div className="space-y-2">
                    <Label htmlFor="businessId">{t('auth.businessId')}</Label>
                    <Input
                      id="businessId"
                      name="businessId"
                      type="text"
                      placeholder={t('auth.businessIdPlaceholder')}
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
                        <span>{t('auth.creatingAccount')}</span>
                      </div>
                    ) : (
                      t('auth.createAccount')
                    )}
                  </Button>
                </FormFieldAnimation>
              </form>
              
              <FadeIn delay={1.1}>
                <div className="mt-4 text-center text-sm">
                  {t('auth.haveAccount')}{' '}
                  <Link href="/login" className="text-primary hover:underline transition-colors duration-300 hover:scale-105 inline-block">
                    {t('auth.signIn')}
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