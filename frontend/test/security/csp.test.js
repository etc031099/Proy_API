/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GOOGLE_MAPS_CONNECT_ORIGINS,
  GOOGLE_MAPS_FONT_ORIGIN,
  GOOGLE_MAPS_IMAGE_ORIGINS,
  GOOGLE_MAPS_SCRIPT_ORIGINS,
  GOOGLE_MAPS_STYLE_ORIGIN,
  createContentSecurityPolicy,
  createSecurityHeaders
} = require('../../src/config/security-headers');

const productionPolicy = () => createContentSecurityPolicy({
  nodeEnvironment: 'production',
  apiUrl: 'https://api.example.test/api'
});

test('production CSP contains the required restrictive directives', () => {
  const policy = productionPolicy();

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /form-action 'self'/);
  assert.match(policy, /frame-src 'none'/);
});

test('production CSP has no global wildcard, broad https source or unsafe-eval', () => {
  const policy = productionPolicy();

  assert.doesNotMatch(policy, /(?:^|\s)\*(?:\s|;|$)/);
  assert.doesNotMatch(policy, /(?:^|\s)https:(?:\s|;|$)/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
});

test('CSP allows only the explicit API origin, not its path', () => {
  const policy = productionPolicy();

  assert.match(policy, /connect-src[^;]*https:\/\/api\.example\.test(?:\s|;)/);
  assert.doesNotMatch(policy, /api\.example\.test\/api/);
});

test('Google Maps and geocoding hosts are explicitly scoped by resource type', () => {
  const policy = productionPolicy();

  GOOGLE_MAPS_SCRIPT_ORIGINS.forEach((origin) => assert.match(policy, new RegExp(`script-src[^;]*${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)));
  GOOGLE_MAPS_CONNECT_ORIGINS.forEach((origin) => assert.match(policy, new RegExp(`connect-src[^;]*${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)));
  GOOGLE_MAPS_IMAGE_ORIGINS.forEach((origin) => assert.match(policy, new RegExp(`img-src[^;]*${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)));
  assert.match(policy, new RegExp(`style-src[^;]*${GOOGLE_MAPS_STYLE_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(policy, new RegExp(`font-src[^;]*${GOOGLE_MAPS_FONT_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(policy, /connect-src[^;]*https:\/\/nominatim\.openstreetmap\.org/);
});

test('unsafe-eval is limited to development for Next.js HMR', () => {
  const development = createContentSecurityPolicy({
    nodeEnvironment: 'development',
    apiUrl: 'http://localhost:5000/api'
  });

  assert.match(development, /script-src[^;]*'unsafe-eval'/);
  assert.match(development, /connect-src[^;]*ws:\/\/localhost:\*/);
  assert.doesNotMatch(productionPolicy(), /'unsafe-eval'|ws:\/\//);
});

test('security header set includes CSP and browser hardening headers', () => {
  const headers = Object.fromEntries(createSecurityHeaders({
    NODE_ENV: 'production',
    NEXT_PUBLIC_API_URL: 'https://api.example.test/api'
  }).map(({ key, value }) => [key, value]));

  assert.equal(headers['Content-Security-Policy'], productionPolicy());
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=(self)');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups');
});
