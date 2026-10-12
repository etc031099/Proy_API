// Local-only smokes: existing synthetic fixtures, no dotenv, HTTP, Mongo or real provider.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {readFixture,writeFixture,read,products}=require('../test/audit/p3bFixtures');
const results=[];
const zero=r=>{assert.equal(r.usage.totalLlmCalls,0);assert.equal(r.usage.totalTokens,0);};
const summary=r=>({intent:r.intent,code:r.code||null,answer:r.answer,skills:r.actions.map(a=>a.skillId),
  llmCalls:r.usage.totalLlmCalls,totalTokens:r.usage.totalTokens,clarification:r.requiresClarification});
async function single(id,query,verify){const f=readFixture(),r=await f.run(query,randomUUID());zero(r);verify(r,f);
  results.push({id,queries:[query],classification:'PASS',actual:[summary(r)],basis:'real runtime with synthetic read-only models'});}
(async()=>{
  await single(1,'dime el stock de food 096',r=>assert.ok(r.answer.includes(products[0].sku)));
  await single(2,'cuánto cuesta food 96',r=>assert.match(r.answer,/S\/ 29\.45/));
  {const f=readFixture(),id=randomUUID(),qs=['Busca food 210','M5-FOODS_3_210','¿Y el precio?'],rows=[];
    for(const q of qs){const r=await f.run(q,id);zero(r);rows.push(r);}
    assert.match(rows[0].answer,/M5-FOODS_2_210/);assert.match(rows[0].answer,/M5-FOODS_3_210/);
    assert.match(rows[2].answer,/M5-FOODS_3_210/);
    results.push({id:3,queries:qs,classification:'NEEDS_MANUAL',actual:rows.map(summary),uiClickNeedsManual:true,
      reason:'Search list and SKU continuation pass locally; the explicit search response has no suggestions cards. The proposed real-click step needs UI verification; no frontend change is in scope.'});}
  {const f=read.fixture({products:[products[0]],emptyProductSalesHistory:true}),q='¿Cuánto vendí de food 96 ayer?',r=await f.run(q);
    zero(r);assert.match(r.answer,/no registra ventas/);assert.doesNotMatch(r.answer,/Encontré/);
    results.push({id:4,queries:[q],classification:'PASS',actual:[summary(r)],basis:'NO_DATA fixture'});}
  await single(5,'dime el total vendido este mes',r=>assert.equal(r.intent,'sales_summary'));
  await single(6,'últimas compras',(r,f)=>{assert.equal(r.intent,'recent_transactions');
    assert.equal(f.reads.find(x=>x.model==='Transaction').pipeline[0].$match.type,'purchase');});
  await single(7,'¿Cuál es la predicción de food 96?',r=>{assert.match(r.answer,/17 de mayo de 2026/);assert.match(r.answer,/M5-FOODS_2_096/);});
  await single(8,'¿Cuál es la predicción del próximo mes?',r=>{assert.match(r.answer,/próximo mes/);assert.equal(r.usage.totalSkillCalls,0);});
  await single(9,'¿Cuál es la precisión exacta de la predicción?',r=>{assert.equal(r.intent,'forecast_confidence');assert.equal(r.usage.totalSkillCalls,0);});
  {const f=readFixture(),q='quién provee food 96',r=await f.run(q);zero(r);
    assert.equal(r.intent,'replenishment_commercial');assert.ok(r.actions.some(x=>x.skillId==='compare_supplier_costs'));
    results.push({id:10,queries:[q],classification:r.requiresClarification?'NEEDS_MANUAL':'PASS',actual:[summary(r)],
      reason:r.requiresClarification?'The existing commercial matcher requires an exact SKU in this synthetic fixture; supplier values need real-tenant verification. Routing/0LLM checked.':null});}
  {const f=readFixture(),q='¿Cuánto cuesta reponer M5-FOODS_3_511 usando el proveedor 55 foods?',r=await f.run(q);zero(r);
    assert.ok(r.actions.some(x=>x.skillId==='get_replenishment_cost'));
    results.push({id:11,queries:[q],classification:'NEEDS_MANUAL',actual:[summary(r)],
      reason:'The local audit fixture has 25 suppliers and does not contain supplier 055. Cloud offer and exact cost require the existing V2 dataset.'});}
  {const f=readFixture(),id=randomUUID(),qs=['Tengo S/ 500, ¿qué productos debería comprar primero?','¿Cuánto dinero sobra?'],rows=[];
    for(const q of qs){const r=await f.run(q,id);zero(r);rows.push(r);}
    assert.equal(rows[0].actions[0].skillId,'plan_replenishment_budget');assert.equal(rows[1].usage.totalSkillCalls,0);
    results.push({id:12,queries:qs,classification:'PASS',actual:rows.map(summary),basis:'synthetic prices and frozen plan; not cloud S/1.53'});}
  await single(13,'lista mis reglas de stock',r=>assert.ok(r.actions.some(x=>x.skillId==='list_stock_alert_rules')));
  await single(14,'¿Qué alertas abiertas tengo?',r=>assert.ok(r.actions.some(x=>x.skillId==='list_inventory_alerts')));
  await single(15,'¿Cuál es el estado de entrega de mis alertas de inventario?',r=>assert.ok(r.actions.some(x=>x.skillId==='list_inventory_alert_outbox_events')));
  {const f=readFixture(),id=randomUUID(),qs=['¿Qué Telegram fueron omitidas para food 210?','M5-FOODS_3_210'],rows=[];
    for(const q of qs){const r=await f.run(q,id);zero(r);rows.push(r);}
    assert.equal(rows[0].suggestions.length,2);assert.ok(rows[1].actions.some(x=>x.skillId==='list_inventory_alert_channel_deliveries'));
    assert.ok(f.reads.some(x=>x.model==='InventoryAlertChannelDelivery'&&x.match.status==='SKIPPED'&&x.match.sku==='M5-FOODS_3_210'));
    results.push({id:16,queries:qs,classification:'PASS',actual:rows.map(summary)});}
  {const f=writeFixture(),qs=['vende 1 del food 96','¿cuánto quedaré de stock?','cancela'],rows=[];
    for(const q of qs){const r=await f.send(q);zero(r);rows.push(r);}
    assert.match(rows[1].answer,/11 unidades/);assert.equal(f.confirmed.length,0);assert.equal(f.cancelled.length,1);
    results.push({id:17,queries:qs,classification:'PASS',actual:rows.map(summary),businessWrites:0,basis:'in-memory preview and cancellation only'});}
  {const f=readFixture(),id=randomUUID(),qs=['Explícame los principales problemas que observas en el inventario y la predicción','¿Por qué ocurre esto?'],rows=[];
    for(const q of qs)rows.push(await f.run(q,id));
    assert.ok(rows[0].usage.totalLlmCalls<=1);zero(rows[1]);assert.equal(rows[1].usage.totalSkillCalls,0);
    results.push({id:18,queries:qs,classification:'NEEDS_MANUAL',actual:rows.map(summary),
      reason:'Real Gemini groundedness and interpretation cannot be verified by a fake provider; local bounded fallback/context checked, no paid calls.'});}
  const report={phase:'CONV-POLISH-P3E',noNetwork:true,noDatabaseWrites:true,noRealBusinessWrites:true,paidLlmCalls:0,
    counts:{PASS:results.filter(x=>x.classification==='PASS').length,NEEDS_MANUAL:results.filter(x=>x.classification==='NEEDS_MANUAL').length},results};
  fs.writeFileSync(path.resolve(__dirname,'../../docs/CONV-POLISH-P3E-smokes.json'),JSON.stringify(report,null,2)+'\n','utf8');
  console.log(JSON.stringify(report.counts));
})().catch(error=>{console.error(`Smoke ${results.length+1}: ${error.message}`);process.exitCode=1;});
