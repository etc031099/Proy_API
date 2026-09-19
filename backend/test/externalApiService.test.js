const test = require('node:test');
const assert = require('node:assert/strict');

const { getExchangeRate } = require('../src/services/externalApiService');

const originalFetch = global.fetch;
const originalWarn = console.warn;
const tolerance = 1e-12;

test.afterEach(() => {
  global.fetch = originalFetch;
  console.warn = originalWarn;
});

const fallbackCases = [
  ['USD', 'PEN', 3.7],
  ['PEN', 'USD', 1 / 3.7],
  ['USD', 'EUR', 0.92],
  ['EUR', 'USD', 1 / 0.92],
  ['PEN', 'EUR', 0.92 / 3.7],
  ['EUR', 'PEN', 3.7 / 0.92]
];

for (const [base, target, expectedRate] of fallbackCases) {
  test(`uses the correct fallback for ${base} -> ${target} when the network fails`, async () => {
    global.fetch = async () => {
      throw new Error('network unavailable');
    };
    console.warn = () => {};

    const result = await getExchangeRate({ base, target });

    assert.equal(result.source, 'fallback');
    assert.equal(result.base, base);
    assert.equal(result.target, target);
    assert.ok(Math.abs(result.rate - expectedRate) < tolerance);
  });
}

test('returns rate 1 without calling the API for the same currency', async () => {
  global.fetch = async () => {
    throw new Error('fetch must not be called');
  };

  const result = await getExchangeRate({ base: 'pen', target: 'PEN' });

  assert.equal(result.source, 'direct');
  assert.equal(result.base, 'PEN');
  assert.equal(result.target, 'PEN');
  assert.equal(result.rate, 1);
});

test('queries the external API with the normalized base currency', async () => {
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ rates: { USD: 1.08 } })
    };
  };

  const result = await getExchangeRate({ base: 'eur', target: 'usd' });

  assert.equal(requestedUrl, 'https://api.exchangerate-api.com/v4/latest/EUR');
  assert.equal(result.source, 'ExchangeRate-API');
  assert.equal(result.base, 'EUR');
  assert.equal(result.target, 'USD');
  assert.equal(result.rate, 1.08);
});

test('rejects an unsupported base currency', async () => {
  await assert.rejects(
    getExchangeRate({ base: 'BTC', target: 'PEN' }),
    (error) => error.code === 'INVALID_CURRENCY' && error.statusCode === 400
  );
});

test('rejects an unsupported target currency', async () => {
  await assert.rejects(
    getExchangeRate({ base: 'PEN', target: 'BTC' }),
    (error) => error.code === 'INVALID_CURRENCY' && error.statusCode === 400
  );
});

test('uses the fallback when the API response contains an invalid rate', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ rates: { PEN: 'not-a-rate' } })
  });

  const result = await getExchangeRate({ base: 'USD', target: 'PEN' });

  assert.equal(result.source, 'fallback');
  assert.ok(Math.abs(result.rate - 3.7) < tolerance);
});

test('rejects a non-scalar API rate and uses the fallback', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ rates: { PEN: [3.7] } })
  });
  console.warn = () => {};

  const result = await getExchangeRate({ base: 'USD', target: 'PEN' });

  assert.equal(result.source, 'fallback');
  assert.ok(Math.abs(result.rate - 3.7) < tolerance);
});
