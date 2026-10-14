import { CircleHelp } from 'lucide-react';
import { useId, useState } from 'react';

/** Native details keeps help available to mouse, touch and keyboard users. */
export function MetricInfo({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  return <span className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!pinned) setOpen(false); }} onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !pinned) setOpen(false); }}>
    <button type="button" aria-label={`Ayuda: ${label}`} aria-describedby={open ? id : undefined} aria-expanded={open} onClick={() => { const nextPinned = !pinned; setPinned(nextPinned); setOpen(nextPinned); }} className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <CircleHelp aria-hidden="true" className="h-4 w-4" />
    </button>
    {open && <span id={id} role="tooltip" className="absolute left-0 top-full z-30 mt-1 w-64 max-w-[calc(100vw-3rem)] rounded-lg border bg-popover p-3 text-left text-xs leading-relaxed text-popover-foreground shadow-lg">
      {children}
    </span>}
  </span>;
}

export function MetricLabel({ label, help }: { label: string; help?: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1">{label}{help && <MetricInfo label={label}>{help}</MetricInfo>}</span>;
}

export function ChartCard({ title, description, help, children }: { title: string; description?: string; help?: React.ReactNode; children: React.ReactNode }) {
  return <section className="min-w-0 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
    <div className="mb-4"><h3 className="flex items-center gap-1 font-semibold"><MetricLabel label={title} help={help} /></h3>{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}</div>
    {children}
  </section>;
}
