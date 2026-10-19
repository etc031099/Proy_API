'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api';
import type { ProductOption } from '@/types/businessIntelligence';

const NO_EXCLUSIONS: string[] = [];

export function ProductSearchPicker({ id, selected, onSelect, excludedSkus = NO_EXCLUSIONS }: {
  id: string;
  selected: ProductOption | null;
  onSelect: (product: ProductOption) => void;
  excludedSkus?: string[];
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    const current = ++request.current;
    if (!query.trim()) { setResults([]); setBusy(false); setError(false); return; }
    setBusy(true); setError(false);
    const timer = setTimeout(() => {
      void apiClient.searchBusinessIntelligenceProducts(query.trim()).then(response => {
        if (current !== request.current) return;
        if (!response.success || !response.data) throw new Error('Search unavailable');
        setResults(response.data.products.filter(product => !excludedSkus.includes(product.sku)));
      }).catch(() => { if (current === request.current) { setResults([]); setError(true); } })
        .finally(() => { if (current === request.current) setBusy(false); });
    }, 300);
    return () => { clearTimeout(timer); };
  }, [excludedSkus, query]);
  const availableResults = results.filter(product => !excludedSkus.includes(product.sku));
  return <div className="space-y-2">
    <label htmlFor={id} className="text-sm font-medium">Producto</label>
    <div className="relative"><Search aria-hidden="true" className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input id={id} value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por nombre o SKU…" className="pl-9" autoComplete="off" /></div>
    {selected && <div className="rounded-md bg-muted/50 px-3 py-2 text-sm" aria-live="polite"><span className="font-medium">{selected.name}{selected.presentation ? ` · ${selected.presentation}` : ''}</span><span className="ml-2 text-xs text-muted-foreground">SKU: {selected.sku}</span></div>}
    {query.trim() && <div className="max-h-56 overflow-auto rounded-md border" aria-label="Resultados de productos">
      {busy ? <p className="p-3 text-sm text-muted-foreground">Buscando productos…</p> : error ? <p role="alert" className="p-3 text-sm text-destructive">No fue posible buscar productos.</p> : availableResults.length ? availableResults.map(product => <button type="button" key={product.id} onClick={() => { onSelect(product); setQuery(''); setResults([]); }} className="block w-full border-b px-3 py-2 text-left last:border-0 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="block font-medium">{product.name}{product.presentation ? ` · ${product.presentation}` : ''}</span><span className="text-xs text-muted-foreground">SKU: {product.sku}</span></button>) : <p className="p-3 text-sm text-muted-foreground">No se encontraron productos con SKU.</p>}
    </div>}
    {!selected && !query.trim() && <p className="text-sm text-muted-foreground">Busca y elige un producto.</p>}
  </div>;
}
