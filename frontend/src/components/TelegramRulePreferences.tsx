'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';

export function TelegramRulePreferences({ initialOpen = false, initialResolved = false }: {
  initialOpen?: boolean; initialResolved?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [resolved, setResolved] = useState(initialResolved);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const save = async () => {
    setSaving(true); setMessage('');
    try {
      await apiClient.updateTelegramRulePreferences({ stockRuleAlertsEnabled: open, stockRuleResolvedAlertsEnabled: resolved });
      setMessage('Preferencias guardadas. Se aplican a nuevos eventos de reglas de stock.');
    } catch { setMessage('No se pudieron guardar las preferencias. Inténtalo nuevamente.'); }
    finally { setSaving(false); }
  };
  return <fieldset className="space-y-3 rounded-md border p-3" disabled={saving}>
    <legend className="text-sm font-medium">Reglas de stock personalizadas</legend>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={open} onChange={event => setOpen(event.target.checked)} />
      Avisar cuando se activa una regla de stock
    </label>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={resolved} onChange={event => setResolved(event.target.checked)} />
      Avisar cuando el stock se recupera
    </label>
    <p className="text-xs text-muted-foreground">Independientes de las alertas tradicionales de stock mínimo. Ambas pueden generar avisos.</p>
    <Button onClick={save} disabled={saving} size="sm">{saving ? 'Guardando…' : 'Guardar preferencias'}</Button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </fieldset>;
}
