'use strict';
// Local-only real orchestrator with the existing synthetic V3 fixture; no credentials or network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const filename = path.resolve(__dirname, '../test/v3Intelligence.test.js');
const fixtureModule = { exports: {} }, localRequire = createRequire(filename);
const fixtureRequire = name => name === 'node:test' ? Object.assign(() => {}, { skip() {}, todo() {} }) : localRequire(name);
vm.runInThisContext(`(function(require,module){${fs.readFileSync(filename, 'utf8')}\nmodule.exports={fixture,banks};})`, { filename })(fixtureRequire, fixtureModule);
const { fixture, banks } = fixtureModule.exports;

async function main() {
  const cases = [];
  let totalLlmCalls = 0, totalTokens = 0;
  async function checkCase(id, family, evaluate) {
    try { const observations = await evaluate(); cases.push({ id, family, classification: 'PASS', observations }); }
    catch (error) { cases.push({ id, family, classification: 'FAIL', severity: 'P1', reason: error.message }); }
  }
  const safe = response => {
    totalLlmCalls += response.usage.totalLlmCalls;
    totalTokens += response.usage.totalTokens ?? 0;
    assert.equal(response.usage.totalLlmCalls, 0); assert.equal(response.usage.totalTokens, 0);
    assert.equal(response.code, null); assert.equal(response.pendingAction, undefined);
    return { skills: response.actions.map(row => row.skillId), llmCalls: 0, tokens: 0,
      clarification: response.requiresClarification };
  };
  for (const [family, inputs] of Object.entries(banks)) for (const [index, input] of inputs.entries()) {
    await checkCase(`${family}-${index + 1}`, family, async () => {
      const result = await fixture().run(input), observation = safe(result);
      assert.ok(observation.skills.includes(family) || observation.clarification, 'Expected domain or safe entity/period clarification');
      return { input, ...observation };
    });
  }
  for (const [id, start, followups] of [
    ['product', 'Productos críticos', ['Cuánto debería pedir', 'Qué proveedor lo vende', 'Y qué se vende junto con él']],
    ['customer', 'Quiénes son mis mejores clientes', ['Qué suele comprar', 'Cuánto gastó este mes']],
    ['supplier', 'Qué proveedor tarda más', ['Qué productos me vende', 'Alguno está crítico']],
  ]) await checkCase(`flow-${id}`, id, async () => {
    const f = fixture(), cid = randomUUID(), first = await f.run(start, cid), observations = [safe(first)];
    assert.ok(first.suggestions?.[0], 'Clickable ranked entity is required');
    observations.push(safe(await f.run(first.suggestions[0].message, cid)));
    for (const message of followups) observations.push(safe(await f.run(message, cid)));
    return observations;
  });
  for (const [id, messages] of [
    ['inca-presentations', ['inca kola', 'BEB-GAS-004', 'Pronóstico próximos 7 días de BEB-GAS-004', 'Qué puedo vender junto con ella']],
    ['health-drilldown', ['Cómo está mi negocio', 'Amplía inventario']],
    ['business-inventory', ['Cuánto vendí esta semana y qué productos debo reponer']],
    ['supplier-inventory', ['Qué proveedor tarda más y cuáles de sus productos están críticos']],
    ['customer-preferences', ['Quién es mi mejor cliente y qué suele comprar']],
    ['unsupported-28', ['Pronóstico próximos 28 días', 'pronóstico próximos 14 días']],
    ['forecast-cloud-followup', ['¿Cuál es el pronóstico de Inca Kola para los próximos 7 días?', 'BEB-GAS-004', '¿Y para los próximos 14 días?', '¿Y para los próximos 1 días?', '¿Y para los próximos 28 días?']],
    ['categories', ['Ventas por categoría', 'BEB']],
    ['ordinal', ['Productos críticos', 'el segundo', 'Cuánto debería pedir']],
    ['visible-name', ['Pan francés', 'Pan francés', 'Cuánto debería pedir']],
  ]) await checkCase(`flow-${id}`, id, async () => {
    const f = fixture(), cid = randomUUID(), observations = [];
    for (const input of messages) observations.push({ input, ...safe(await f.run(input, cid)) });
    return observations;
  });
  const counts = Object.fromEntries(['PASS', 'FAIL', 'PARTIAL', 'NOT_SUPPORTED', 'NEEDS_MANUAL'].map(value => [value, cases.filter(row => row.classification === value).length]));
  const severity = { P0: 0, P1: counts.FAIL, P2: 0, P3: 0 };
  const report = { phase: 'M6.9E-V3-LOCAL-AUDIT', methodology: 'Real production routing/orchestrator, synthetic database and ML adapters; no cloud correctness claimed',
    families: Object.keys(banks), cases, counts, severity, llmCalls: totalLlmCalls, tokens: totalTokens, realWrites: 0 };
  const outputArg = process.argv.indexOf('--output');
  const output = outputArg >= 0 ? process.argv[outputArg + 1] : path.resolve(__dirname, '../../ml/.test-tmp/m6.9e-v3-audit.json');
  if (!output) throw new Error('Missing audit output path');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ counts, severity, families: report.families.length, multiTurnFlows: cases.filter(row => row.id.startsWith('flow-')).length }));
  if (counts.FAIL) process.exitCode = 1;
}
main().catch(error => { console.error(`V3 audit failed: ${error.name}`); process.exitCode = 1; });
