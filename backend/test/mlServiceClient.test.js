const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MlServiceUnavailableError,
  createMlServiceClient
} = require('../src/services/mlServiceClient');

test('ML client sends one POST with the backend-only secret header', async () => {
  const calls = [];
  const client = createMlServiceClient({
    serviceUrl: 'https://ml.internal.example/',
    serviceSecret: 'test-ml-secret-at-least-32-characters',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ results: [] }) };
    }
  });

  const payload = { requestId: 'request-1', items: [] };
  await client.predictDemand(payload);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ml.internal.example/v1/predict/demand');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-ML-Service-Secret'], 'test-ml-secret-at-least-32-characters');
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test('ML client sanitizes upstream authentication and unavailable responses', async () => {
  for (const status of [401, 403, 503]) {
    const client = createMlServiceClient({
      serviceUrl: 'https://ml.internal.example',
      serviceSecret: 'test-ml-secret-at-least-32-characters',
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ detail: 'internal' }) })
    });
    await assert.rejects(client.predictDemand({}), error => (
      error instanceof MlServiceUnavailableError
      && error.code === 'ML_SERVICE_UNAVAILABLE'
      && !error.message.includes('internal')
    ));
  }
});

test('ML client converts timeout into ML_SERVICE_UNAVAILABLE without retries', async () => {
  let calls = 0;
  const client = createMlServiceClient({
    serviceUrl: 'https://ml.internal.example',
    serviceSecret: 'test-ml-secret-at-least-32-characters',
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
  });

  await assert.rejects(client.predictDemand({}), { code: 'ML_SERVICE_UNAVAILABLE' });
  assert.equal(calls, 1);
});

test('ML client rejects malformed result structure with a sanitized error', async () => {
  const valid = { productId: 'p1', sku: 'M5-ITEM', status: 'READY', predictedDemand7d: 0.802037 };
  for (const body of [
    null, {}, { results: null }, { results: [null] }, { results: [[]] },
    { results: [{ ...valid, productId: 1 }] }, { results: [{ ...valid, sku: '' }] },
    { results: [{ ...valid, status: undefined }] }, { results: [{ ...valid, status: '' }] }
  ]) {
    const client = createMlServiceClient({
      serviceUrl: 'https://ml.internal.example',
      serviceSecret: 'test-ml-secret-at-least-32-characters',
      fetchImpl: async () => ({ ok: true, json: async () => body })
    });
    await assert.rejects(client.predictDemand({}), error => (
      error instanceof MlServiceUnavailableError
      && error.code === 'ML_SERVICE_UNAVAILABLE'
      && error.message === 'ML service is unavailable'
    ));
  }
});

test('ML client accepts READY and non-READY protocol records without coercing predictions', async () => {
  const body = { results: [
    { productId: 'p1', sku: 'M5-ONE', status: 'READY', predictedDemand7d: 0.802037 },
    { productId: 'p2', sku: 'M5-TWO', status: 'INSUFFICIENT_HISTORY' }
  ] };
  const client = createMlServiceClient({
    serviceUrl: 'https://ml.internal.example',
    serviceSecret: 'test-ml-secret-at-least-32-characters',
    fetchImpl: async () => ({ ok: true, json: async () => body })
  });
  assert.deepEqual(await client.predictDemand({}), body);
});
