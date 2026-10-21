'use client';
import { Button } from '@/components/ui/button';
import type { AgentResponse, V3DisplayItem, V3DisplayView } from '@/types/agent';

const riskLabels: Record<string, string> = { CRITICAL: 'Crítico', HIGH: 'Alto', MEDIUM: 'Medio', LOW: 'Bajo' };
const entityLabels = { product: 'producto', customer: 'cliente', supplier: 'proveedor', category: 'categoría' } as const;
const metricValue = (value: unknown) => typeof value === 'string' ? (riskLabels[value] || value)
  : typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('es-PE') : 'No disponible';

function DisplayItem({ item, onSelect, disabled, rank }: { item: V3DisplayItem; onSelect: (message: string) => void; disabled: boolean; rank: number }) {
  const label = item.label;
  const content = <>
    <span className="flex min-w-0 items-start gap-2"><span aria-hidden="true" className="shrink-0 text-muted-foreground">{rank}.</span><span className="min-w-0 break-words font-medium">{label}</span></span>
    {item.secondaryLabel && <span className="block break-all text-xs text-muted-foreground">{item.secondaryLabel}</span>}
    {Array.isArray(item.metrics) && !!item.metrics.length && <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {item.metrics.map(metric => <span key={metric.label}>{metric.label}: {metricValue(metric.value)}</span>)}
    </span>}
  </>;
  if (!item.selectMessage) return <li className="min-w-0 rounded-md border p-3">{content}</li>;
  return <li className="min-w-0"><Button type="button" variant="outline" disabled={disabled}
    aria-label={`Seleccionar ${entityLabels[item.type]} ${label}`} onClick={() => onSelect(item.selectMessage!)}
    className="h-auto w-full min-w-0 justify-start whitespace-normal px-3 py-3 text-left">
    <span className="block min-w-0 w-full">{content}</span>
  </Button></li>;
}

export function V3ResponseCards({ views, response, disabled, onSelect }: {
  views: V3DisplayView[]; response: AgentResponse; disabled: boolean; onSelect: (message: string) => void;
}) {
  return <div className="mt-3 min-w-0 space-y-3" aria-label="Resultados de inteligencia V3">
    {views.map((view, index) => {
      const metrics = Array.isArray(view.metrics) ? view.metrics : [];
      const items = Array.isArray(view.items) ? view.items : [];
      return <section key={`${view.kind}-${index}`} className="min-w-0 rounded-lg border bg-card p-3 sm:p-4" aria-label={view.title}>
      <h3 className="break-words font-semibold">{view.title}</h3>
      {view.subtitle && <p className="mt-1 break-words text-sm text-muted-foreground">{view.subtitle}</p>}
      {!!metrics.length && <dl className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {metrics.map(metric => <div key={metric.label} className="min-w-0 rounded-md bg-muted/50 p-2">
          <dt className="text-xs text-muted-foreground">{metric.label}</dt>
          <dd className="break-words text-sm font-medium">{metricValue(metric.value)}</dd>
        </div>)}
      </dl>}
      {items.length > 0 && <ol className="mt-3 min-w-0 list-none space-y-2">
        {items.map((item, itemIndex) => <DisplayItem key={`${item.type}-${item.key}-${itemIndex}`} item={item} rank={itemIndex + 1} disabled={disabled} onSelect={onSelect} />)}
      </ol>}
      {view.note && !!(metrics.length || items.length)
        && <p className="mt-3 break-words text-xs text-muted-foreground">{view.note}</p>}
      {!metrics.length && !items.length && <p className="mt-2 break-words text-sm text-muted-foreground">
        {view.note || 'No hay datos para los filtros solicitados.'}</p>}
    </section>; })}
    {!response.suggestionsPagination && !!response.suggestions?.length && <div className="flex min-w-0 flex-wrap gap-2" aria-label="Opciones de consulta">
      {response.suggestions.map(option => <Button type="button" variant="outline" key={option.message} disabled={disabled}
        onClick={() => onSelect(option.message)} className="h-auto max-w-full whitespace-normal text-left">
        <span className="break-words">{option.label}</span>
      </Button>)}
    </div>}
    {response.suggestionsPagination && <div className="flex min-w-0 flex-wrap gap-2">
      {response.suggestionsPagination.hasPrevious && <Button type="button" variant="outline" disabled={disabled} onClick={() => onSelect('Anterior')}>Anterior</Button>}
      {response.suggestionsPagination.hasMore && <Button type="button" variant="outline" disabled={disabled} onClick={() => onSelect('Ver más')}>Ver más</Button>}
      <Button type="button" variant="outline" disabled={disabled} onClick={() => onSelect('Refinar búsqueda')}>Refinar búsqueda</Button>
      <p className="w-full text-xs text-muted-foreground">{response.suggestionsPagination.totalMatches} coincidencias · mostrando {response.suggestionsPagination.offset + 1}–{response.suggestionsPagination.offset + (response.suggestions?.length || 0)}</p>
    </div>}
  </div>;
}
