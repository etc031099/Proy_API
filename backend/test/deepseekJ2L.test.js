'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
const { validateGroundedOutput, HALLUCINATION_CONTRACT } = require('../src/agents/groundedContext');
const { DEEPSEEK_PRICES } = require('../src/config/deepseekPricing');
const { estimateCostUsd } = require('../src/agents/providers/neutralProvider');

const context = { evidence: [1, 2, 3].map(index => ({ ref: `E${index}`, facts: { productName: `Producto ${['A', 'B', 'C'][index - 1]}` } })),
  constraints: HALLUCINATION_CONTRACT };
const row = index => ({ evidenceRefs: [`E${index}`],
  interpretation: `Producto ${['A', 'B', 'C'][index - 1]} presenta señales que conviene revisar.`,
  advisoryRecommendation: 'Revisa la información disponible antes de decidir.' });
const response = (count, limitations = []) => JSON.stringify({
  observations: Array.from({ length: count }, (_, index) => row(index + 1)), limitations
});
const responseSizes = [1, 2, 3].map(count => {
  const text = response(count);
  return { observations: count, chars: text.length, bytes: Buffer.byteLength(text, 'utf8'),
    estimatedTokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 3) };
});
const withLimitation = response(3, [HALLUCINATION_CONTRACT[1]]);
const sizeWithLimitation = { observations: 3, limitations: 1, chars: withLimitation.length,
  bytes: Buffer.byteLength(withLimitation, 'utf8'), estimatedTokens: Math.ceil(Buffer.byteLength(withLimitation, 'utf8') / 3) };
const makeEnvelope = (text, finishReason = 'stop', outputTokens = 120) => ({ model: 'deepseek-flash',
  choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 1822, completion_tokens: outputTokens, total_tokens: 1822 + outputTokens,
    prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1822 } });
const providerFor = ({ text, finishReason = 'stop', outputTokens = 120, env = {}, onFetch = () => {} }) =>
  createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'fictional-test-key', ...env }, fetchImpl: async (_url, options) => {
    onFetch(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => makeEnvelope(text, finishReason, outputTokens) };
  } });
const request = { route: 'GROUNDED_LLM', messages: [{ role: 'system', content: 'JSON compacto.' },
  { role: 'user', content: '{}' }], maxTokens: 600, temperature: 0 };

for (const count of [1, 2, 3]) test(`J2L compact ${count}-observation fixture passes with configured 500-token cap`, async () => {
  let body;
  const result = await providerFor({ text: response(count), outputTokens: count * 70,
    onFetch: value => { body = value; } }).generate(request);
  assert.equal(body.max_tokens, 500);
  assert.equal(result.responseDiagnostic.finishReason, 'stop');
  assert.equal(validateGroundedOutput(result.text, context).observations.length, count);
});

test('J2L three compact observations and one material limitation fit with at least 20% estimated headroom', async () => {
  let body;
  const result = await providerFor({ text: withLimitation, outputTokens: 300,
    onFetch: value => { body = value; } }).generate(request);
  assert.equal(body.max_tokens, 500);
  assert.ok(sizeWithLimitation.estimatedTokens <= 400, JSON.stringify(sizeWithLimitation));
  assert.equal(validateGroundedOutput(result.text, context).limitations[0], HALLUCINATION_CONTRACT[1]);
});

test('J2L fixture measurements include JSON overhead and label the three-byte estimate', () => {
  assert.deepEqual(responseSizes.map(row => row.observations), [1, 2, 3]);
  assert.ok(responseSizes[0].bytes < responseSizes[1].bytes && responseSizes[1].bytes < responseSizes[2].bytes);
  assert.ok(sizeWithLimitation.bytes > responseSizes[2].bytes);
  assert.ok(sizeWithLimitation.estimatedTokens <= 400);
  console.log('J2L_OUTPUT_FIXTURE_SIZES', JSON.stringify({ responseSizes, threePlusLimitation: sizeWithLimitation,
    estimate: 'ceil(UTF-8 JSON bytes / 3); project heuristic, not DeepSeek tokenizer usage' }));
});

test('J2L a stop response at 499 reported output tokens continues normal grounded validation', async () => {
  const result = await providerFor({ text: response(1), outputTokens: 499 }).generate(request);
  assert.equal(result.usage.outputTokens, 499);
  assert.equal(result.responseDiagnostic.finishReason, 'stop');
  assert.equal(validateGroundedOutput(result.text, context).observations.length, 1);
});

test('J2L finish_reason stop is passed to normal schema/grounding validation', async () => {
  const result = await providerFor({ text: response(2), finishReason: 'stop', outputTokens: 180 }).generate(request);
  assert.equal(result.responseDiagnostic.validationReason, 'NONE');
  assert.doesNotThrow(() => validateGroundedOutput(result.text, context));
});

test('J2L finish_reason length rejects a partial JSON envelope as OUTPUT_TRUNCATED', async () => {
  await assert.rejects(providerFor({ text: '{"observations":[{"evidenceRefs":["E1"]',
    finishReason: 'length', outputTokens: 500 }).generate(request), error => {
    assert.equal(error.responseDiagnostic.finishReason, 'length');
    assert.equal(error.responseDiagnostic.validationReason, 'OUTPUT_TRUNCATED');
    assert.equal(error.usage.outputTokens, 500);
    assert.doesNotMatch(JSON.stringify(error), /observations.*evidenceRefs/);
    return true;
  });
});

test('J2L truncation makes exactly one provider call and never retries', async () => {
  let calls = 0;
  await assert.rejects(providerFor({ text: '{"observations":', finishReason: 'length', outputTokens: 500,
    onFetch: () => calls++ }).generate(request), error => error.responseDiagnostic.validationReason === 'OUTPUT_TRUNCATED');
  assert.equal(calls, 1);
});

test('J2L retains the existing J2B usage-based maximum theoretical cost at 1822 uncached input tokens', () => {
  const cost = outputTokens => estimateCostUsd({ provider: 'deepseek', model: 'deepseek-flash', prices: DEEPSEEK_PRICES,
    at: '2026-10-15', usage: { inputTokens: 1822, outputTokens, cachedInputTokens: 0, cacheMissInputTokens: 1822 } }).estimatedCostRangeUsd;
  for (const [tokens, expected] of [[300, [0.0004533, 0.0009066]], [450, [0.0005433, 0.0010866]],
    [500, [0.0005733, 0.0011466]]]) {
    const actual = cost(tokens);
    assert.ok(Math.abs(actual.min - expected[0]) < 1e-12, `${tokens} min ${actual.min}`);
    assert.ok(Math.abs(actual.max - expected[1]) < 1e-12, `${tokens} max ${actual.max}`);
  }
});

test('J2L price cap is a maximum only and the provider still makes no automatic second call', async () => {
  let calls = 0, body;
  const result = await providerFor({ text: response(1), outputTokens: 41, onFetch: value => { calls++; body = value; } }).generate(request);
  assert.equal(body.max_tokens, 500); assert.equal(result.usage.outputTokens, 41); assert.equal(calls, 1);
});
