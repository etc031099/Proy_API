'use client';

import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api';
import { Contact, Product } from '@/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Entity = Contact | Product;
interface Props {
  kind: 'customer' | 'vendor' | 'product';
  value: string;
  onChange: (id: string) => void;
  onSelect?: (entity: Entity) => void;
  label: string;
  supplierId?: string;
  disabled?: boolean;
  emptyLabel?: string;
}
export function RemoteEntitySelect({ kind, value, onChange, onSelect, label, supplierId, disabled, emptyLabel }: Props) {
  const [search, setSearch] = useState(''), [page, setPage] = useState(1);
  const [rows, setRows] = useState<Entity[]>([]), [selected, setSelected] = useState<Entity | null>(null);
  const [total, setTotal] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const callback = useRef(onSelect); callback.current = onSelect;
  useEffect(() => { setPage(1); }, [kind, supplierId]);
  useEffect(() => {
    let current = true;
    if (disabled) { setRows([]); setLoading(false); return; }
    setLoading(true); setError('');
    const timer = setTimeout(async () => {
      try {
        const response = kind === 'product' ? await apiClient.getProducts({ search, page, limit: 20, supplierId })
          : await apiClient.getContacts({ type: kind, search, page, limit: 20 });
        if (!current) return;
        if (!response.success) throw new Error('Unavailable');
        setRows(response.data.products || response.data.contacts);
        setTotal(response.data.pagination.total); setPage(response.data.pagination.current);
      } catch { if (current) { setRows([]); setError('No fue posible cargar los resultados.'); } }
      finally { if (current) setLoading(false); }
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [kind, search, page, supplierId, disabled]);
  useEffect(() => {
    let current = true;
    if (!value) { setSelected(null); return; }
    const visible = rows.find(row => row._id === value);
    if (visible) { setSelected(visible); callback.current?.(visible); return; }
    if (selected?._id === value) return;
    (kind === 'product' ? apiClient.getProduct(value) : apiClient.getContact(value)).then(response => {
      if (current && response.success) {
        const entity = response.data.product || response.data.contact;
        setSelected(entity); callback.current?.(entity);
      }
    }).catch(() => { if (current) setError('No fue posible cargar la selección.'); });
    return () => { current = false; };
  }, [value, kind, rows, selected]);
  const options = selected?._id === value && !rows.some(row => row._id === value) ? [selected, ...rows] : rows;
  return <div className="min-w-0 space-y-2">
    <Input aria-label={`Buscar ${label}`} placeholder={`Buscar ${label}…`} value={search} disabled={disabled}
      onChange={event => { setSearch(event.target.value); setPage(1); }} />
    <Select value={value || (emptyLabel ? '__empty' : '')} disabled={disabled || loading} onValueChange={id => {
      if (id === '__empty') { onChange(''); return; }
      const entity = rows.find(row => row._id === id); if (entity) { setSelected(entity); callback.current?.(entity); }
      onChange(id);
    }}>
      <SelectTrigger aria-label={label}>
        <SelectValue className={selected?._id === value ? 'hidden' : ''} placeholder={`Elegir ${label}`} />
        {selected?._id === value && <span className="min-w-0 truncate">{selected.name}</span>}
      </SelectTrigger>
      <SelectContent>
        {emptyLabel && <SelectItem value="__empty">{emptyLabel}</SelectItem>}
        {options.map(row => <SelectItem key={row._id} value={row._id}>{row.name}{'sku' in row && row.sku ? ` · ${row.sku}` : 'phone' in row && row.phone ? ` · ${row.phone}` : ''}</SelectItem>)}
      </SelectContent>
    </Select>
    <div aria-live="polite" className="text-xs text-muted-foreground">
      {loading ? 'Buscando…' : error || (total ? `Mostrando ${(page - 1) * 20 + 1}–${Math.min(page * 20, total)} de ${total}` : 'No se encontraron resultados')}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled || loading || page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled || loading || page * 20 >= total} onClick={() => setPage(page + 1)}>Siguiente</Button>
    </div>
  </div>;
}
