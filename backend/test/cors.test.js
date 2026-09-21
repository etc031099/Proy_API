const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const cors = require('cors');

const {
  CORS_ALLOWED_HEADERS,
  CORS_METHODS,
  createCorsOptions
} = require('../src/config/cors');

const ALLOWED_ORIGINS = [
  'https://app.example.com',
  'http://localhost:3000'
];

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(cors(createCorsOptions(ALLOWED_ORIGINS)));
  app.all('/resource', (request, response) => {
    response.status(200).json({ method: request.method });
  });

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

const request = (origin, options = {}) => fetch(`${baseUrl}/resource`, {
  ...options,
  headers: {
    ...(origin === undefined ? {} : { Origin: origin }),
    ...options.headers
  }
});

const preflight = (origin, method = 'POST', headers) => request(origin, {
  method: 'OPTIONS',
  headers: {
    'Access-Control-Request-Method': method,
    ...(headers ? { 'Access-Control-Request-Headers': headers } : {})
  }
});

for (const origin of ALLOWED_ORIGINS) {
  test(`allowed origin ${origin} receives its exact Access-Control-Allow-Origin value`, async () => {
    const response = await request(origin);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  });
}

for (const [label, origin] of [
  ['unlisted origin', 'https://not-listed.example'],
  ['evil origin', 'https://evil.example'],
  ['lookalike domain', 'https://app.example.com.evil.example'],
  ['unlisted subdomain', 'https://sub.app.example.com']
]) {
  test(`${label} receives no CORS authorization`, async () => {
    const response = await request(origin);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null, origin);
  });
}

test('requests without Origin remain available to server-side clients', async () => {
  const response = await request(undefined);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('allowed preflight returns the exact origin, methods and minimal headers', async () => {
  const response = await preflight(
    'https://app.example.com',
    'PATCH',
    'Authorization, Content-Type'
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.deepEqual(
    response.headers.get('access-control-allow-methods').split(','),
    CORS_METHODS
  );
  assert.deepEqual(
    response.headers.get('access-control-allow-headers').split(','),
    CORS_ALLOWED_HEADERS
  );
});

test('unlisted origin preflight receives no CORS authorization', async () => {
  const response = await preflight('https://evil.example');

  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('Authorization is an allowed preflight header', async () => {
  const response = await preflight('https://app.example.com', 'POST', 'Authorization');
  const allowedHeaders = response.headers.get('access-control-allow-headers');

  assert.match(allowedHeaders, /Authorization/);
});

test('Content-Type is an allowed preflight header', async () => {
  const response = await preflight('https://app.example.com', 'POST', 'Content-Type');
  const allowedHeaders = response.headers.get('access-control-allow-headers');

  assert.match(allowedHeaders, /Content-Type/);
});

test('arbitrary and legacy X-Requested-With headers are not allowed', async () => {
  const response = await preflight(
    'https://app.example.com',
    'POST',
    'X-Arbitrary-Header, X-Requested-With'
  );
  const allowedHeaders = response.headers.get('access-control-allow-headers');

  assert.doesNotMatch(allowedHeaders, /X-Arbitrary-Header/i);
  assert.doesNotMatch(allowedHeaders, /X-Requested-With/i);
});

test('all documented methods are advertised', async () => {
  const response = await preflight('https://app.example.com', 'DELETE');
  const allowedMethods = response.headers.get('access-control-allow-methods');

  for (const method of CORS_METHODS) assert.match(allowedMethods, new RegExp(`(?:^|,)${method}(?:,|$)`));
});

test('an unsupported method is not advertised', async () => {
  const response = await preflight('https://app.example.com', 'TRACE');
  const allowedMethods = response.headers.get('access-control-allow-methods');

  assert.doesNotMatch(allowedMethods, /TRACE/);
});

test('frontend Axios explicitly disables cookie credentials', () => {
  const frontendApiPath = path.resolve(__dirname, '../../frontend/src/lib/api.ts');
  const source = fs.readFileSync(frontendApiPath, 'utf8');

  assert.match(source, /withCredentials:\s*false/);
  assert.doesNotMatch(source, /withCredentials:\s*true/);
});
