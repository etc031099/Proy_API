import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MetricInfo } from './MetricInfo';

export interface MethodologyField { label: string; value: React.ReactNode; }

/** Compact result-first method summary with a keyboard/touch accessible native disclosure. */
export function MethodologyCard({ algorithm, learningType, objective, summary, explanation, fields, className = '' }: {
  algorithm: string; learningType: string; objective: string; summary: React.ReactNode;
  explanation: string; fields: MethodologyField[]; className?: string;
}) {
  return <Card className={className}>
    <CardHeader className="space-y-2 pb-3">
      <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">{algorithm}</CardTitle><Badge variant="outline">{learningType}</Badge><MetricInfo label={`Acerca de ${algorithm}`}>{explanation}</MetricInfo></div>
      <CardDescription>{objective}</CardDescription>
      <p className="text-sm font-medium text-foreground">{summary}</p>
    </CardHeader>
    <CardContent className="pt-0">
      <details className="rounded-md border px-3 py-2 text-sm">
        <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Ver metodología y limitaciones</summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">{fields.map(field => <div key={field.label}><dt className="font-medium">{field.label}</dt><dd className="break-words text-muted-foreground">{field.value}</dd></div>)}</dl>
      </details>
    </CardContent>
  </Card>;
}
