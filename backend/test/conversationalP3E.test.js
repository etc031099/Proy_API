const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { routeDeterministically } = require('../src/agents/intentRouting');
const { buildSkillAnswer } = require('../src/agents/responses');
const { readFixture, writeFixture, products, read } = require('./audit/p3bFixtures');
const now = new Date('2026-10-09T12:00:00Z');
const cases = [
  {
    "id": "U-0003",
    "group": "G01",
    "input": "dime el stock de food 096",
    "expected": {
      "level": "route",
      "intents": [
        "product_details"
      ],
      "deterministic": true,
      "attribute": "stock"
    }
  },
  {
    "id": "U-0007",
    "group": "G01",
    "input": "q stock tiene food 96",
    "expected": {
      "level": "route",
      "intents": [
        "product_details"
      ],
      "deterministic": true,
      "attribute": "stock"
    }
  },
  {
    "id": "U-0008",
    "group": "G01",
    "input": "muéstrame el stock de food 96",
    "expected": {
      "level": "route",
      "intents": [
        "product_details"
      ],
      "deterministic": true,
      "attribute": "stock"
    }
  },
  {
    "id": "U-0018",
    "group": "G01",
    "input": "a cuánto está food 96",
    "expected": {
      "level": "route",
      "intents": [
        "product_details"
      ],
      "deterministic": true,
      "attribute": "price"
    }
  },
  {
    "id": "U-0021",
    "group": "G01",
    "input": "cuánto cuesta food 96",
    "expected": {
      "level": "route",
      "intents": [
        "product_details"
      ],
      "deterministic": true,
      "attribute": "price"
    }
  },
  {
    "id": "U-0026",
    "group": "G01",
    "input": "¿Qué precio tiene food 96?",
    "expected": {
      "level": "route",
      "intents": [
        "product_details"
      ],
      "deterministic": true,
      "attribute": "price"
    }
  },
  {
    "id": "U-0046",
    "group": "G01",
    "input": "dime si food 96 está activo",
    "expected": {
      "level": "route",
      "intents": [
        "product_details"
      ],
      "deterministic": true,
      "attribute": "active"
    }
  },
  {
    "id": "U-0058",
    "group": "G01",
    "input": "dame los detalles de food 96",
    "expected": {
      "level": "route",
      "intents": [
        "product_details"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0138",
    "group": "G01",
    "input": "qué está bajo de stock",
    "expected": {
      "level": "route",
      "intents": [
        "low_stock"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0163",
    "group": "G02",
    "input": "dime el total vendido este mes",
    "expected": {
      "level": "route",
      "intents": [
        "sales_summary"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0168",
    "group": "G02",
    "input": "venta total de octubre 2026",
    "expected": {
      "level": "route",
      "intents": [
        "sales_summary"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0188",
    "group": "G02",
    "input": "unidades vendidas de item 96 este mes",
    "expected": {
      "level": "route",
      "intents": [
        "product_sales_summary"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0201",
    "group": "G02",
    "input": "transacciones completadas",
    "expected": {
      "level": "route",
      "intents": [
        "recent_transactions"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0202",
    "group": "G02",
    "input": "transacciones pendientes",
    "expected": {
      "level": "route",
      "intents": [
        "recent_transactions"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0203",
    "group": "G02",
    "input": "transacciones canceladas",
    "expected": {
      "level": "route",
      "intents": [
        "recent_transactions"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0210",
    "group": "G02",
    "input": "dame movimientos de ventas y compras",
    "expected": {
      "level": "route",
      "intents": [
        "recent_transactions"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0213",
    "group": "G02",
    "input": "últimas compras",
    "expected": {
      "level": "route",
      "intents": [
        "recent_transactions"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0218",
    "group": "G02",
    "input": "compras pendientes",
    "expected": {
      "level": "route",
      "intents": [
        "recent_transactions"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0219",
    "group": "G02",
    "input": "compras canceladas",
    "expected": {
      "level": "route",
      "intents": [
        "recent_transactions"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0223",
    "group": "G02",
    "input": "dame 5 compras recientes",
    "expected": {
      "level": "route",
      "intents": [
        "recent_transactions"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0236",
    "group": "G02",
    "input": "ranking por unidades vendidas",
    "expected": {
      "level": "route",
      "intents": [
        "top_selling_products"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0314",
    "group": "G03",
    "input": "costo de food 96 con proveedor 001 foods",
    "expected": {
      "level": "route",
      "intents": [
        "replenishment_commercial"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0339",
    "group": "G03",
    "input": "proveedor más económico de food 096",
    "expected": {
      "level": "route",
      "intents": [
        "cheapest_supplier",
        "replenishment_commercial"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0340",
    "group": "G03",
    "input": "quién provee food 96",
    "expected": {
      "level": "route",
      "intents": [
        "cheapest_supplier",
        "replenishment_commercial"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0367",
    "group": "G03",
    "input": "oferta de food 096 con proveedor 001 foods",
    "expected": {
      "level": "route",
      "intents": [
        "supplier_products",
        "replenishment_commercial"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0327",
    "group": "G03",
    "input": "con S/ 50 qué puedo comprar",
    "expected": {
      "level": "route",
      "intents": [
        "replenishment_commercial"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0413",
    "group": "G05",
    "input": "lista mis reglas de stock",
    "expected": {
      "level": "route",
      "intents": [
        "stock_alert_rules"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0443",
    "group": "G05",
    "input": "estado de entrega para food 210",
    "expected": {
      "level": "route",
      "intents": [
        "inventory_alert_deliveries"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0458",
    "group": "G05",
    "input": "por qué se omitió Telegram de food 96",
    "expected": {
      "level": "route",
      "intents": [
        "inventory_alert_channel_deliveries"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0472",
    "group": "G06",
    "input": "por qué los proveedores llegaron tarde",
    "expected": {
      "level": "route",
      "intents": [
        "unsupported_supplier_causality"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0484",
    "group": "G06",
    "input": "confidence exacta de la predicción",
    "expected": {
      "level": "route",
      "intents": [
        "forecast_confidence"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0485",
    "group": "G06",
    "input": "precisión exacta de la predicción",
    "expected": {
      "level": "route",
      "intents": [
        "forecast_confidence"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0487",
    "group": "G06",
    "input": "probabilidad de acertar la demanda de food 210",
    "expected": {
      "level": "route",
      "intents": [
        "forecast_confidence"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0490",
    "group": "G06",
    "input": "seguridad de la predicción",
    "expected": {
      "level": "route",
      "intents": [
        "forecast_confidence"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0498",
    "group": "G06",
    "input": "dinero perdido si no compro food 210",
    "expected": {
      "level": "route",
      "intents": [
        "unsupported_financial_impact"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0499",
    "group": "G06",
    "input": "cuánto perderé sin comprar",
    "expected": {
      "level": "route",
      "intents": [
        "unsupported_financial_impact"
      ],
      "deterministic": true
    }
  },
  {
    "id": "U-0251",
    "group": "G07",
    "input": "¿Cuál es la predicción de M5-FOODS_2_210?",
    "expected": {
      "level": "route",
      "intents": [
        "demand_forecast"
      ],
      "deterministic": true
    }
  }
];
const intents = names => names.map(x => ({forecast_analytics:'ml_analytics',clarification:'ambiguous_query'}[x] || x));
const zero = r => { assert.equal(r.usage.totalLlmCalls,0); assert.equal(r.usage.totalTokens,0); };
for (const c of cases) test(`P3E ${c.group} ${c.id}: ${c.input}`, async () => {
  const plan = routeDeterministically(c.input, {}, now);
  assert.ok(plan);
  assert.ok(intents(c.expected.intents).includes(plan.intent), JSON.stringify(plan));
  const f=readFixture(), result=await f.run(c.input, randomUUID());
  zero(result); assert.equal(f.calls.length,0);
  assert.ok([null,'AGENT_CLARIFICATION_REQUIRED'].includes(result.code));
  assert.equal(result.pendingAction,undefined);
  if (c.group==='G06') {
    assert.equal(result.usage.totalSkillCalls,0);
    assert.match(result.answer,/no (?:tengo|expone|puedo)|no cuenta/i);
  }
  if (c.expected.attribute && !result.requiresClarification) {
    assert.match(result.answer,/M5-FOODS_2_096/);
    const patterns={stock:/unidades/,price:/S\/ 29\.45/,active:/activo/};
    if(patterns[c.expected.attribute])assert.match(result.answer,patterns[c.expected.attribute]);
    if(c.expected.attribute==='price')assert.doesNotMatch(result.answer,/Stock mínimo|está activo/);
  }
  if(c.id==='U-0188'){
    assert.equal(plan.lookupQuery,'item 96');
    assert.deepEqual(plan.period,{startDate:'2026-10-01',endDate:'2026-10-31'});
    assert.ok(result.actions.some(a=>a.skillId==='get_product_sales_summary'));
  }
  if(c.id==='U-0210')assert.equal(plan.type,undefined);
  if(c.id==='U-0213'||c.id==='U-0223')assert.equal(plan.type,'purchase');
  if(c.id==='U-0202'||c.id==='U-0218')assert.equal(plan.status,'pending');
  if(c.id==='U-0203'||c.id==='U-0219')assert.equal(plan.status,'cancelled');
  if(c.id==='U-0236')assert.equal(plan.period,undefined);
  if(c.id==='U-0314'||c.id==='U-0367'){
    assert.equal(plan.args.supplierRef,'001 foods');
    if (!result.requiresClarification) assert.match(result.answer,/15\.67/);
  }
  if(c.id==='U-0458'){
    assert.equal(plan.selector.status,'SKIPPED');
    assert.equal(plan.lookupQuery,'food 96');
    assert.ok(f.reads.some(r=>r.model==='InventoryAlertChannelDelivery'&&r.match.status==='SKIPPED'));
  }
  if(c.id==='U-0251')assert.match(result.answer,/1 unidad disponible\b/);
});

for(const count of [0,1,2]) test(`P3E G07 forecast availability ${count}`,()=>{
  const result={status:'READY',data:[{...products[0],mlStatus:'READY',stockAtAnchor:count,predictedDemand7d:8,salesLast7Days:1,safetyStock:2,recommendedQty:3}],
    metadata:{anchor:'2026-05-17'}};
  const text=buildSkillAnswer('get_demand_forecast',result,'');
  assert.ok(text.includes(`${count} ${count===1?'unidad disponible':'unidades disponibles'}`));
  assert.doesNotMatch(text,/1 unidad disponibles/);
});
for(const phrase of ['próximo mes','próxima semana'])test(`P3E G07 visible accent ${phrase}`,async()=>{
  const f=readFixture(),r=await f.run(`¿Cuál es la predicción de food 96 ${phrase}?`);
  zero(r);assert.equal(r.usage.totalSkillCalls,0);assert.ok(r.answer.includes(phrase));
  assert.doesNotMatch(r.answer,/para proximo|para proxima/);
});

test('P3E G15 NO_DATA responds once, preserves evidence and product context',async()=>{
  const f=read.fixture({products:[products[0]],emptyProductSalesHistory:true}),id=randomUUID();
  const r=await f.run('¿Cuánto vendí de food 96 ayer?',id);
  zero(r);assert.equal(r.requiresClarification,false);assert.match(r.answer,/no registra ventas completadas/);
  assert.doesNotMatch(r.answer,/Encontré|búsqueda/);
  assert.deepEqual(r.actions.map(a=>a.skillId),['search_products','get_product_sales_summary']);
  assert.ok(r.evidence.some(e=>e.skillId==='search_products'));
  const next=await f.run('¿Y el stock mínimo?',id);zero(next);assert.match(next.answer,/M5-FOODS_2_096/);
});
test('P3E G15 explicit search keeps its visible single result',async()=>{
  const f=readFixture(),r=await f.run('Busca food 96');zero(r);
  assert.match(r.answer,/Encontré 1 producto/);assert.deepEqual(r.actions.map(a=>a.skillId),['search_products']);
});
test('P3E G08 S-084 question preserves pending then cancellation without execution',async()=>{
  const f=writeFixture();const p=await f.send('vende 2 del food 96');zero(p);
  const q=await f.send('¿cuánto quedaré de stock?');zero(q);assert.match(q.answer,/10 unidades/);
  assert.match(q.answer,/sigue pendiente/);assert.equal(q.pendingAction.pendingActionId,p.pendingAction.pendingActionId);
  assert.equal(f.confirmed.length,0);
  const cancel=await f.send('cancela');zero(cancel);assert.equal(f.confirmed.length,0);assert.equal(f.cancelled.length,1);
});

for(const [group,phrase,forbidden] of [
 ['G01','Explícame los principales problemas que observas en el inventario y la predicción','product_details'],
 ['G01','dime el stock de food 96 y el precio de food 210','product_details'],
 ['G01','¿Cuánto stock tiene food 196?','low_stock'],
 ['G02','¿Cuánto vendí ayer?','product_sales_summary'],
 ['G02','vende 3 del food 96','recent_transactions'],
 ['G03','¿Cuál es el precio de food 96?','replenishment_commercial'],
 ['G03','cuánto cuesta la cantidad recomendada de food 96','product_details'],
 ['G03','¿Qué productos vende proveedor 55 foods?','cheapest_supplier'],
 ['G05','¿Qué alertas de inventario se han generado?','stock_alert_rules'],
 ['G05','¿Qué alertas de stock tengo configuradas?','inventory_alert_deliveries'],
 ['G06','¿Cuál es la predicción de food 96?','forecast_confidence'],
 ['G06','¿Cuánto cuesta reponer M5-FOODS_3_511?','unsupported_financial_impact']
]) test(`P3E ${group} contrast: ${phrase}`,()=>{
  const p=routeDeterministically(phrase,{},now);
  assert.notEqual(p?.intent,forbidden);
});
test('P3E G02 general sales do not inherit product and transactions retain both filters',async()=>{
  const f=readFixture(),id=randomUUID();
  await f.run('¿Cuánto vendí de food 96 ayer?',id);
  const r=await f.run('¿Cuánto vendí ayer?',id);zero(r);assert.equal(r.intent,'sales_summary');
  const p=routeDeterministically('Muéstrame las compras canceladas de ayer',{},now);
  assert.equal(p.type,'purchase');assert.equal(p.status,'cancelled');
  assert.deepEqual(p.period,{startDate:'2026-10-08',endDate:'2026-10-08'});
});
test('P3E G03 positive aliases preserve product and supplier, no new budget edge behavior',()=>{
  const p=routeDeterministically('costo de food 96 con proveedor 001 foods',{},now);
  assert.deepEqual(p.args,{productRef:'food 96',supplierRef:'001 foods'});
  assert.equal(routeDeterministically('con S/ 50 qué puedo comprar',{},now).args.budget,50);
  assert.notEqual(routeDeterministically('tengo S/ -500 para reponer',{},now)?.skillId,'plan_replenishment_budget');
  assert.ok(!routeDeterministically('proveedor más económico de food 96 y food 210',{},now)?.args?.productRef);
});
test('P3E G03 exact commercial identity returns the configured offer instead of a catalog',async()=>{
  const f=readFixture();
  const r=await f.run('Compara los proveedores de M5-FOODS_2_096');zero(r);
  assert.equal(r.requiresClarification,false);assert.match(r.answer,/15\.67/);
  assert.ok(r.actions.some(a=>a.skillId==='compare_supplier_costs'));
  assert.ok(!r.actions.some(a=>a.skillId==='get_supplier_products'));
});
test('P3E G13 auditor correction: omitted year follows approved operational UTC year',()=>{
  const p=routeDeterministically('ventas del 9 de octubre',{},now);
  assert.equal(p.intent,'sales_summary');assert.deepEqual(p.period,{startDate:'2026-10-09',endDate:'2026-10-09'});
  const explicit=routeDeterministically('venta total de octubre 2026',{},new Date('2027-03-01T00:00:00Z'));
  assert.deepEqual(explicit.period,{startDate:'2026-10-01',endDate:'2026-10-31'});
});
test('P3E G08 questions never approve and repeated informational questions preserve preview',async()=>{
  const f=writeFixture(),r=await f.send('vende 1 del food 96');zero(r);
  for(const text of ['¿cuánto quedará de stock?','¿cuál es el precio?','¿cuántas unidades son?']){
    const q=await f.send(text);zero(q);assert.equal(f.confirmed.length,0);
    assert.equal(q.pendingAction.pendingActionId,r.pendingAction.pendingActionId);
  }
});
