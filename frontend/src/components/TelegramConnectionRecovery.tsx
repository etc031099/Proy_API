'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api';

export interface RecoveredTelegramStatus {
  connected: boolean;
  stockRuleAlertsEnabled?: boolean;
  stockRuleResolvedAlertsEnabled?: boolean;
}

export function TelegramConnectionRecovery({ onConnected }: { onConnected: (status: RecoveredTelegramStatus) => void }) {
  const [challenge, setChallenge] = useState<{ code: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [expired, setExpired] = useState(false);

  const start = async () => {
    setLoading(true); setNotice(''); setExpired(false);
    try {
      const response = await apiClient.createTelegramRecoveryCode();
      if (!response.success || !response.data || !/^TRF-[A-F0-9]{16}$/.test(response.data.code)
        || !Number.isFinite(Date.parse(response.data.expiresAt))) throw new Error('Invalid recovery');
      setChallenge(response.data);
    } catch {
      setNotice('No se pudo iniciar la recuperación. Si tienes otro Telegram conectado, desconéctalo primero; si solicitaste varios códigos, espera unos minutos.');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!challenge) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (Date.now() >= Date.parse(challenge.expiresAt)) {
        if (!cancelled) { setExpired(true); setChallenge(null); setNotice('El código venció. Solicita uno nuevo.'); }
        return;
      }
      try {
        const response = await apiClient.getTelegramStatus();
        if (!cancelled && response.data?.connected) {
          setChallenge(null); setNotice('Telegram conectado correctamente.');
          onConnected(response.data as RecoveredTelegramStatus);
          return;
        }
      } catch { if (!cancelled) setNotice('No se pudo comprobar la conexión. Puedes actualizar el estado manualmente.'); }
      if (!cancelled) timer = setTimeout(check, 5000);
    };
    // Sequential polling stops on success, expiry, unmount or a replacement code.
    timer = setTimeout(check, 5000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [challenge, onConnected]);

  const refresh = async () => {
    setLoading(true);
    try {
      const response = await apiClient.getTelegramStatus();
      if (response.data?.connected) { setChallenge(null); setNotice('Telegram conectado correctamente.'); onConnected(response.data as RecoveredTelegramStatus); }
      else setNotice('Todavía no se confirmó la conexión desde Telegram.');
    } catch { setNotice('No se pudo comprobar la conexión. Vuelve a intentarlo.'); }
    finally { setLoading(false); }
  };

  return <div className="space-y-3 border-t pt-3">
    <p className="text-sm text-muted-foreground">¿Tu Telegram ya estaba vinculado a otra cuenta?</p>
    <Button variant="outline" onClick={start} disabled={loading}>{loading ? 'Espera…' : 'Recuperar conexión'}</Button>
    {challenge && <div className="space-y-2 rounded-md bg-muted p-3 text-sm">
      <p>Envía este comando a @InventBil_bot desde tu chat privado:</p>
      <code className="block break-all font-bold">/transfer {challenge.code}</code>
      <p>Vence en 10 minutos. Al enviarlo, autorizas transferir este Telegram al negocio de tu sesión. Las preferencias de este negocio se conservan.</p>
      <Button variant="outline" onClick={refresh} disabled={loading}>Actualizar estado</Button>
    </div>}
    {notice && <p role="status" className={expired ? 'text-sm text-muted-foreground' : 'text-sm'}>{notice}</p>}
  </div>;
}
