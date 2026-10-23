const assert = require('node:assert/strict');
const { fixture: transportFixture, mapping } = require('./telegramTransportFixture');
const { fixture: engineFixture } = require('./j2sProductFixture');
const { createActionService } = require('../../src/automations/execution');
const { scopeOf, bindingOf, fail } = require('../../src/automations/contracts');
const { rankEntities } = require('../../src/automations/entityResolution');
const { Product } = require('../../src/models');
const id = n => n.toString(16).padStart(24, '0');
const catalog = [['Coca-Cola Original', 'COLA-001'], ['Coca-Cola Sin Azúcar', 'COLA-002'], ['Papas Lays', 'LAYS-001'],
  ['Leche Gloria', 'LECHE-001'], ['Leche Ideal', 'LECHE-002']].map(([name, sku], n) => ({ _id: id(n + 1), name, sku,
  currency: 'PEN', stock: 20, isActive: true, supplierPrices: [{ supplierId: id(500), purchasePrice: 2 }] }));
const update = (n, text, chat = 123) => ({ update_id: n, message: { message_id: n, text,
  chat: { id: chat, type: 'private' }, from: { id: chat, is_bot: false } } });
const callback = (n, token, messageId = token.messageId, chat = 123) => ({ update_id: n, callback_query: {
  id: `cb_${n}`, data: token.token, from: { id: chat, is_bot: false },
  message: { message_id: messageId, date: 1, chat: { id: chat, type: 'private' } } } });
const fixture = ({ operationsEnabled = true, noSupplier = false, longPreview = false, actionOptions = {} } = {}) => {
  const engine = engineFixture(), rows = new Map(), executions = [], audits = [];
  let tail = Promise.resolve(), executeHook;
  const scoped = (context, row) => row && Object.entries({ ...scopeOf(context), ...bindingOf(context) }).every(([k, v]) => row[k] === v);
  const get = async (context, key) => { const row = rows.get(key); return scoped(context, row) ? structuredClone(row) : null; };
  const repository = { checkConversation: async () => {}, get,
    findExternal: async (ctx, key) => [...rows.values()].find(row => scoped(ctx, row) && row.externalRequestId === key),
    recent: async ctx => [...rows.values()].filter(row => scoped(ctx, row) && row.status === 'PENDING'),
    insert: async (_ctx, row) => { rows.set(row.pendingActionId, structuredClone(row)); return row; },
    transition(ctx, key, decision, clock, execute) {
      const operation = tail.then(async () => {
        const row = await get(ctx, key); if (!row) fail('ACTION_NOT_ALLOWED');
        if (row.status === 'EXECUTED' && decision === 'confirm') return row;
        if (row.status !== 'PENDING') fail('ACTION_CONFLICT');
        if (row.expiresAt <= clock()) row.status = 'EXPIRED';
        else if (decision === 'cancel') row.status = 'CANCELLED';
        else { row.result = await execute(row, {}); row.status = 'EXECUTED'; }
        rows.set(key, structuredClone(row)); audits.push(row.status); return row;
      }); tail = operation.catch(() => {}); return operation;
    } };
  const executor = type => ({
    async preview(args) {
      const quantities = new Map();
      args.products.forEach(item => quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity));
      const items = [...quantities].map(([key, quantity]) => { const p = catalog.find(p => p._id === key);
        return { sku: p.sku, name: longPreview ? p.name.repeat(450) : p.name, quantity, price: 2, total: quantity * 2,
          stock: p.stock, resultingStock: type === 'sale' ? p.stock - quantity : p.stock + quantity }; });
      return { summary: 'Preview autorizado', fields: { currency: 'PEN', total: items.reduce((s, i) => s + i.total, 0),
        contact: type === 'purchase' ? 'Proveedor sintético' : 'Consumidor final', paymentMethod: 'cash' }, items };
    },
    async execute(args, context) {
      await executeHook?.(); executions.push({ args, context });
      const preview = await this.preview(args);
      return { id: id(1000), type, total: preview.fields.total, currency: 'PEN',
        items: preview.items.map(i => ({ sku: i.sku, name: i.name, quantity: i.quantity, stock: i.resultingStock })) };
    }
  });
  const service = createActionService({ repository, executors: { create_sale: executor('sale'), create_purchase: executor('purchase') } });
  const resolver = async (model, context, ref, _type, offset = 0) => {
    assert.equal(context.businessId, engine.request.businessId);
    const products = model === Product ? catalog : [{ _id: id(500), name: 'Proveedor sintético', isActive: true }];
    const exact = products.find(row => row._id === ref || row.sku === ref);
    return exact ? { confidence: 'EXACT', value: structuredClone(exact) } : { ...rankEntities(products, ref, offset), clarification: 'Elige una opción.' };
  };
  const f = transportFixture({ runtime: engine.runtime, operationsEnabled, actionService: service,
    userRole: 'admin',
    mappings: [{ ...mapping, businessId: engine.request.businessId, systemUserId: engine.request.user._id }],
    actionOptions: { resolver, supplierLookup: async () => noSupplier ? [] : [{ _id: id(500), name: 'Proveedor sintético' }], ...actionOptions } });
  const response = () => f.state.messages.filter(row => row.role === 'assistant').at(-1)?.response;
  const deliver = async input => { const t = f.make(); const admitted = await t.admit(input); await t.recover(); return admitted; };
  return { f, rows, service, executions, audits, response, deliver, hook: fn => { executeHook = fn; },
    token: purpose => f.state.tokens.filter(row => row.purpose === purpose && row.messageId).at(-1) };
};
module.exports = { fixture, update, callback, catalog };
