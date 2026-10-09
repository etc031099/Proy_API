'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function RegisterDemoV2Page() {
  const { user, loading, registerDemoV2 } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      await registerDemoV2(form);
      setForm({ name: '', email: '', password: '' });
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'No se pudo crear la cuenta demo V2.');
      setForm(current => ({ ...current, password: '' }));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };
  return <main className="min-h-screen bg-muted/50 p-4 flex items-center justify-center">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Crear cuenta demo V2</CardTitle>
        <CardDescription>Cuenta separada para la demostración ML. La cuenta V1 no se modifica.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && !submitting ? <p role="status">Comprobando sesión…</p>
          : !user ? <p>Inicia sesión con la cuenta demo V1 y vuelve a esta página. <Link href="/login" className="underline">Iniciar sesión</Link></p>
          : <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-muted-foreground">El servidor asigna el negocio automáticamente. Al crear la cuenta, esta sesión pasará a V2; podrás volver a V1 iniciando sesión con sus credenciales.</p>
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <div><Label htmlFor="demo-name">Nombre</Label><Input id="demo-name" autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} minLength={2} maxLength={50} required disabled={submitting} /></div>
            <div><Label htmlFor="demo-email">Correo</Label><Input id="demo-email" type="email" autoComplete="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required disabled={submitting} /></div>
            <div><Label htmlFor="demo-password">Contraseña</Label><Input id="demo-password" type="password" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} minLength={6} maxLength={72} required disabled={submitting} aria-describedby="demo-password-help" />
              <p id="demo-password-help" className="text-xs text-muted-foreground mt-1">Mínimo 6 caracteres, una mayúscula, una minúscula y un número. Máximo 72 bytes.</p></div>
            <Button type="submit" disabled={submitting || loading} className="w-full">{submitting ? 'Creando cuenta…' : 'Crear cuenta demo V2'}</Button>
            {submitting && <p role="status">El servicio puede tardar unos segundos en activarse.</p>}
          </form>}
      </CardContent>
    </Card>
  </main>;
}
