import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PendingActionCard } from '@/components/assistant/PendingActionCard';
import { apiClient } from '@/lib/api';
import type { PendingActionPreview } from '@/types/agent';
import { assistantDisplayText } from '@/lib/assistantPresentation';
import type { AgentResponse } from '@/types/agent';
vi.mock('@/lib/api', () => ({ apiClient: { decideAgentAction: vi.fn() } }));
const pending: PendingActionPreview = { pendingActionId: '11111111-1111-4111-8111-111111111111', action: 'create_product',
  summary: 'Crear producto demo', fields: { stock: 5, sku: 'SKU-001', price: 10 }, expiresAt: '2099-01-01T00:00:00Z',
  requiresConfirmation: true, status: 'PENDING' };
it.each(['create_sale', 'create_purchase'] as const)('A5.3 %s multi-line preview retains all lines and one confirmation', action => {
  vi.mocked(apiClient.decideAgentAction).mockReset();
  const purchase = action === 'create_purchase';
  render(<PendingActionCard conversationId="22222222-2222-4222-8222-222222222222" action={{ ...pending, action, summary: 'Registrar operación de 3 productos',
    fields: { currency: 'PEN', total: 17, contact: 'Contacto configurado' }, items: [
      { name: 'Papas Lays', sku: 'LAYS-001', quantity: 1, price: 2, total: 2, stock: 20, resultingStock: purchase ? 21 : 19 },
      { name: 'Coca-Cola', sku: 'COLA-001', quantity: 1, price: 3, total: 3, stock: 20, resultingStock: purchase ? 21 : 19 },
      { name: 'Leche', sku: 'LECHE-002', quantity: 2, price: 6, total: 12, stock: 20, resultingStock: purchase ? 22 : 18 }
    ] }} />);
  expect(screen.getByText('Papas Lays · LAYS-001')).toBeTruthy();
  expect(screen.getByText('Coca-Cola · COLA-001')).toBeTruthy();
  expect(screen.getByText('Leche · LECHE-002')).toBeTruthy();
  expect(screen.getByText(/2 unidades · Precio unitario: S\/ 6\.00 · Total: S\/ 12\.00/)).toBeTruthy();
  expect(screen.getByText(`Stock actual: 20 · Stock después: ${purchase ? 22 : 18}`)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Confirmar' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Cancelar' })).toHaveLength(1);
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('candidate text fallback remains in API while cards avoid duplicate visible lists', () => {
  const response = { suggestions: [{ label: '1. Agua', message: 'SKU-001', detail: 'SKU-001' }] } as AgentResponse;
  const text = 'Encontré 2 coincidencias.\n1. Agua — SKU-001\nMostrando 1–1.';
  expect(assistantDisplayText(text, response)).toBe('Encontré 2 coincidencias.\nMostrando 1–1.');
  expect(assistantDisplayText(text)).toBe(text);
});
it('A4.2 keeps Inventory and Forecast conclusions while removing repeated V3 dumps', () => {
  const inventory = 'Sí, debes reponer Coca-Cola Sabor Original 500 ml. La posición es 14 frente al punto de reorden 57. Cobertura: 1.8 días; riesgo: alto. Cantidad sugerida por el servicio: 102 unidades.';
  const forecast = 'Se esperan 107.3 unidades de Coca-Cola Sabor Original 500 ml en los próximos 14 días según Ridge LIVE ACTIVE. Modelo v1 · ACTIVE · featureVersion RIDGE_CAUSAL27_V1.';
  const raw = `${inventory}\n\nEscenario V3 · datos operativos al 20/10/2026.\n1. fila larga de evidencia\n\n${forecast}\n\nEscenario V3 · datos operativos al 20/10/2026.\n1. fila Ridge extensa`;
  const result = assistantDisplayText(raw, { actions: [{ skillId: 'get_inventory_intelligence' }, { skillId: 'get_product_forecast' }],
    v3Views: [{ note: '', metrics: [], items: [] }] } as unknown as AgentResponse, 'Para Coca-Cola, ¿debo reponerla y cuánto se espera vender en 14 días?');
  expect(result).toContain(inventory);
  expect(result).toContain('Se esperan 107.3 unidades');
  expect(result).not.toContain('featureVersion');
  expect(result).not.toContain('Escenario V3');
  expect(result.match(/Se esperan 107\.3 unidades/g)).toHaveLength(1);
});
it('A4.2 keeps technical lineage for a question about the active model', () => {
  const text = 'Para Coca-Cola, la autoridad es Ridge LIVE. Modelo v1 · ACTIVE · featureVersion RIDGE_CAUSAL27_V1.\n\nEscenario V3 · detalle técnico';
  const displayed = assistantDisplayText(text, { actions: [{ skillId: 'get_product_forecast' }], v3Views: [{ note: '', metrics: [], items: [] }] } as unknown as AgentResponse,
    '¿Qué featureVersion y modelo está usando?');
  expect(displayed).toBe(text);
});
it('A4.3 uses the durable requested intent after a SKU-only selection, with a legacy question fallback', () => {
  const technical = 'El pronóstico de Coca-Cola utiliza Ridge LIVE con el modelo ACTIVE v1 y featureVersion RIDGE_CAUSAL27_V1. El horizonte consultado es de 14 días.';
  const response = { requestedIntent: 'model_status', actions: [{ skillId: 'get_product_forecast' }],
    v3Views: [{ kind: 'forecast', metrics: [], items: [] }] } as unknown as AgentResponse;
  expect(assistantDisplayText(technical, response, 'BEB-GAS-001')).toBe(technical);
  const normal = 'Se esperan 107.3 unidades de Coca-Cola en los próximos 14 días según Ridge LIVE ACTIVE. Modelo v1 · ACTIVE · featureVersion RIDGE_CAUSAL27_V1.';
  expect(assistantDisplayText(normal, { ...response, requestedIntent: 'forecast' }, '¿Cuánto venderemos con Ridge?'))
    .toBe('Se esperan 107.3 unidades de Coca-Cola en los próximos 14 días según Ridge LIVE ACTIVE.');
});
for (const quantity of [0, 1, 2]) it(`card quantity ${quantity} uses natural grammar and money`, () => {
  const { container } = render(<PendingActionCard action={{ ...pending, action: 'create_sale',
    fields: { currency: 'PEN', total: 58.9, productId: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
    items: [{ name: 'Agua', sku: 'SKU-001', quantity, price: 29.45, total: 58.9, stock: 3, resultingStock: 2 }]
  }} conversationId="conversation" />);
  expect(container.textContent).toContain(`${quantity} ${quantity === 1 ? 'unidad ·' : 'unidades ·'}`);
  expect(container.textContent).toContain('S/ 29.45'); expect(container.textContent).toContain('S/ 58.90');
  expect(container.textContent).not.toContain('bbbbbbbbbbbbbbbbbbbbbbbb');
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('stock rule card displays configured condition without fake stock, Mongo ID or notification promise', () => {
  render(<PendingActionCard action={{ ...pending, action: 'create_stock_alert_rule', summary: 'Configurar regla de stock',
    fields: { sku: 'SKU-001', name: 'Demo', description: 'Stock <= 3 unidades' }, status: 'EXECUTED',
    result: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', sku: 'SKU-001', operator: '<=', threshold: 3, ruleConfigured: true, alreadyExists: true } }} conversationId="conversation" />);
  expect(screen.getByText(/Regla activa existente: SKU-001/)).toBeTruthy();
  expect(screen.getByText(/Se evalúa automáticamente al cambiar el stock/)).toBeTruthy();
  expect(screen.queryByText(/Stock: undefined/)).toBeNull(); expect(screen.queryByText(/bbbbbbbbbbbbbbbbbbbbbbbb/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('preview is visible and confirmation sends only bound action ID and conversation once', async () => {
  let finish!: (value: { success: boolean; data: PendingActionPreview }) => void;
  vi.mocked(apiClient.decideAgentAction).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  expect(screen.getByText('Crear producto demo')).toBeTruthy(); expect(screen.getByText(/Confirmación sin IA/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect(apiClient.decideAgentAction).toHaveBeenCalledTimes(1);
  expect(apiClient.decideAgentAction).toHaveBeenCalledWith(pending.pendingActionId, 'conversation', 'confirm');
  expect(screen.getByRole('button', { name: 'Cancelar' }).hasAttribute('disabled')).toBe(true);
  finish({ success: true, data: { ...pending, status: 'EXECUTED' } });
  expect(await screen.findByText(/Estado: Ejecutada/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
});
it('sale confirmation delegates to the shared impact orchestrator without duplicating the action write', async () => {
  const sale = { ...pending, action: 'create_sale' as const, items: [
    { sku: 'SKU-001', name: 'Producto', quantity: 1, price: 10, total: 10, stock: 4, resultingStock: 3 }
  ] };
  const executed = { ...sale, status: 'EXECUTED' as const, result: { id: 'sale-1', type: 'sale' as const } };
  const onConfirmSale = vi.fn(async (_action: PendingActionPreview, confirm: () => Promise<PendingActionPreview>) => confirm());
  vi.mocked(apiClient.decideAgentAction).mockResolvedValue({ success: true, data: executed });
  render(<PendingActionCard action={sale} conversationId="conversation" onConfirmSale={onConfirmSale} />);

  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

  expect(await screen.findByText(/Estado: Ejecutada/)).toBeTruthy();
  expect(onConfirmSale).toHaveBeenCalledTimes(1);
  expect(onConfirmSale.mock.calls[0][0]).toMatchObject({ pendingActionId: sale.pendingActionId, action: 'create_sale' });
  expect(apiClient.decideAgentAction).toHaveBeenCalledTimes(1);
  expect(apiClient.decideAgentAction).toHaveBeenCalledWith(sale.pendingActionId, 'conversation', 'confirm');
});
it('cancel is explicit and never sends product arguments', async () => {
  vi.mocked(apiClient.decideAgentAction).mockResolvedValue({ success: true, data: { ...pending, status: 'CANCELLED' } });
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(await screen.findByText(/Estado: Cancelada/)).toBeTruthy();
  expect(apiClient.decideAgentAction).toHaveBeenCalledWith(pending.pendingActionId, 'conversation', 'cancel');
});
it('expired preview cannot be confirmed', () => {
  render(<PendingActionCard action={{ ...pending, expiresAt: '2000-01-01T00:00:00Z' }} conversationId="conversation" />);
  expect(screen.getByText(/Estado: Expirada/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
});
it('uncertain failure is safe and does not auto-retry', async () => {
  vi.mocked(apiClient.decideAgentAction).mockRejectedValue(new Error('password=private'));
  render(<PendingActionCard action={pending} conversationId="conversation" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  expect((await screen.findByRole('alert')).textContent).not.toContain('private');
  expect(apiClient.decideAgentAction).toHaveBeenCalledTimes(1);
});
for (const type of ['sale', 'purchase'] as const) it(`restored ${type} preview shows items, prices and stock without executing`, () => {
  render(<PendingActionCard action={{ ...pending, action: `create_${type}`, summary: type === 'sale' ? 'Registrar venta' : 'Registrar compra',
    fields: { currency: 'PEN', total: 30, paymentMethod: type === 'sale' ? 'credit' : 'cash', contact: 'Contacto demo' },
    items: [{ sku: 'SKU-002', name: 'Agua', quantity: 3, stock: 20, resultingStock: type === 'sale' ? 17 : 23, price: 10, total: 30 }] }} conversationId="conversation" />);
  expect(screen.getByText(/Agua · SKU-002/)).toBeTruthy();
  expect(screen.getByText(/Stock actual: 20/)).toBeTruthy(); expect(screen.getByText(/Precio unitario: S\/ 10.00/)).toBeTruthy();
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('restored executed action displays persisted result and never offers confirmation', () => {
  render(<PendingActionCard action={{ ...pending, status: 'EXECUTED', result: { id: 'op-synthetic', type: 'sale', currency: 'PEN', total: 30,
    items: [{ sku: 'SKU-002', name: 'Agua', quantity: 3, stock: 17 }] } }} conversationId="conversation" />);
  expect(screen.getByText(/3 unidades de Agua · Stock resultante: 17 unidades/)).toBeTruthy();
  expect(screen.getByText('Total: S/ 30.00')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('restored expired action stays expired even with future expiresAt', () => {
  render(<PendingActionCard action={{ ...pending, status: 'EXPIRED' }} conversationId="conversation" />);
  expect(screen.getByText('Esta acción expiró.')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
  expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
it('refreshed authoritative history replaces an existing pending card with its executed result', () => {
  const view = render(<PendingActionCard action={pending} conversationId="conversation" />);
  view.rerender(<PendingActionCard action={{ ...pending, status: 'EXECUTED', result: { id: 'op-refreshed', sku: 'SKU-001', stock: 5 } }} conversationId="conversation" />);
  expect(screen.getByText(/Estado: Ejecutada/)).toBeTruthy(); expect(screen.queryByText(/op-refreshed/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull(); expect(apiClient.decideAgentAction).not.toHaveBeenCalled();
});
