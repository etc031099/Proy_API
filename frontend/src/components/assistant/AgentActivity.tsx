import type { AgentResponse, AgentUsage } from '@/types/agent';

const names = { coordinator: 'Coordinador', operations: 'Operaciones', analyst: 'Analista' };
const labels: Record<string, string> = {
  search_products: 'Buscó productos', get_product_details: 'Consultó un producto',
  get_low_stock_products: 'Consultó productos con stock bajo', get_recent_transactions: 'Consultó transacciones recientes',
  get_sales_summary: 'Consultó ventas completadas', get_top_selling_products: 'Consultó productos más vendidos',
  get_business_summary: 'Consultó el resumen del negocio', get_demand_forecast: 'Consultó la predicción ML histórica',
  get_replenishment_candidates: 'Consultó candidatos de reposición', get_product_sales_summary: 'Consultó ventas del producto'
};
const metric = (value: number | null) => value === null ? '—' : value.toLocaleString('es-PE');

function Tokens({ usage }: { usage: Pick<AgentUsage, 'inputTokens' | 'outputTokens' | 'thoughtTokens' | 'cachedInputTokens' | 'toolUseTokens' | 'totalTokens'> }) {
  return <dl className="grid grid-cols-2 gap-2 text-sm">
    {([['Entrada', usage.inputTokens], ['Salida', usage.outputTokens], ['Tokens de razonamiento', usage.thoughtTokens],
      ['Caché', usage.cachedInputTokens], ['Uso de herramientas', usage.toolUseTokens], ['Total', usage.totalTokens]] as const)
      .map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{metric(value)}</dd></div>)}
  </dl>;
}

export function AgentActivity({ response }: { response?: AgentResponse }) {
  if (!response) return <aside aria-label="Actividad multiagente" className="rounded-xl border bg-card p-5 min-w-0">
    <h2 className="font-semibold">Actividad multiagente</h2>
    <p className="mt-3 text-sm text-muted-foreground">Después de cada consulta verás los agentes participantes, las skills y el consumo real.</p>
    <p className="mt-3 text-sm">Coordinador · Operaciones · Analista</p>
    <p className="mt-2 text-sm text-muted-foreground">Solo intervienen los agentes necesarios.</p>
  </aside>;
  const u = response.usage;
  return <aside aria-label="Actividad multiagente" className="rounded-xl border bg-card p-5 min-w-0 space-y-5 break-words">
    <h2 className="font-semibold">Actividad de esta respuesta</h2>
    {u.totalLlmCalls === 0 && <p className="rounded-lg bg-emerald-500/10 p-3 text-sm font-medium">Respuesta determinística · 0 tokens IA</p>}
    <dl className="grid grid-cols-2 gap-3 text-sm">
      <div><dt>Agentes</dt><dd>{response.participants.length}</dd></div>
      <div><dt>Llamadas IA</dt><dd>{u.totalLlmCalls}</dd></div>
      <div><dt>Skills ejecutadas</dt><dd>{u.totalSkillCalls}</dd></div>
      <div><dt>Tokens totales</dt><dd>{metric(u.totalTokens)}</dd></div>
      <div><dt>Latencia total</dt><dd>{(response.latencyMs / 1000).toFixed(2)} s</dd></div>
    </dl>
    <details><summary className="cursor-pointer text-sm">Detalle de tokens totales</summary><div className="mt-3"><Tokens usage={{
      inputTokens: u.totalInputTokens, outputTokens: u.totalOutputTokens, thoughtTokens: u.totalThoughtTokens,
      cachedInputTokens: u.totalCachedInputTokens, toolUseTokens: u.totalToolUseTokens, totalTokens: u.totalTokens
    }} /></div><p className="mt-2 text-xs text-muted-foreground">{u.metricsComplete ? 'Métricas completas' : '— = no reportado por el proveedor'}</p></details>
    <section aria-label="Agentes participantes" className="space-y-3">
      {response.participants.map(p => <div key={p.agentId} className="rounded-lg border p-3">
        <h3 className="font-medium">{names[p.agentId]} <span className="text-xs text-muted-foreground">{p.agentId}</span></h3>
        <p className="text-sm mt-2">LLM: {p.llmCalls} · Skills: {p.skillCalls} · Tokens: {metric(p.totalTokens)}</p>
        <p className="text-xs text-muted-foreground">Agente: {(p.latencyMs / 1000).toFixed(2)} s · Proveedor: {(p.providerLatencyMs / 1000).toFixed(2)} s</p>
        {p.model && <p className="text-xs break-all">{p.model}</p>}
        <details className="mt-2"><summary className="text-sm cursor-pointer">Detalle de tokens de {names[p.agentId]}</summary><div className="mt-2"><Tokens usage={p} /></div></details>
      </div>)}
    </section>
    <section><h3 className="font-medium">Acciones realizadas</h3><ul className="mt-2 space-y-2 text-sm">
      {response.actions.map((a, i) => <li key={`${a.skillId}-${i}`}>
        {a.status === 'SUCCEEDED' ? '✓' : '•'} {labels[a.skillId] || 'Consultó datos del sistema'}
        <span className="block text-xs text-muted-foreground break-all">{a.skillId} · {a.status === 'SUCCEEDED' ? 'Completada' : 'No completada'}</span>
      </li>)}
      {!response.actions.length && <li className="text-muted-foreground">Sin skills ejecutadas.</li>}
    </ul></section>
    <section><h3 className="font-medium">Fuentes de datos utilizadas</h3><ul className="mt-2 space-y-3 text-sm">
      {response.evidence.map(e => <li key={e.evidenceId} className="border-l-2 pl-3">
        <p>{e.label}</p>
        {e.period && <p>Periodo: {e.period.startDate} – {e.period.endDate}</p>}
        {e.asOf && <p>{['get_demand_forecast', 'get_replenishment_candidates'].includes(e.skillId) ? 'Ancla histórica' : 'Fecha de consulta'}: {e.asOf}</p>}
        {e.recordCount !== undefined && <p>{e.recordCount} registros</p>}
        {['get_demand_forecast', 'get_replenishment_candidates'].includes(e.skillId) && <p className="text-xs text-muted-foreground">Replay histórico: predicción ML y recomendación de reposición son resultados distintos.</p>}
      </li>)}
      {!response.evidence.length && <li className="text-muted-foreground">Sin evidencia de datos para esta respuesta.</li>}
    </ul></section>
  </aside>;
}
