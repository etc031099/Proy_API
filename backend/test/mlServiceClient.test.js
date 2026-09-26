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
