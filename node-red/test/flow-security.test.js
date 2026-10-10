const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const nodeRedDirectory = path.resolve(__dirname, '..');
const flows = JSON.parse(fs.readFileSync(path.join(nodeRedDirectory, 'flows.json'), 'utf8'));
const byId = new Map(flows.map((node) => [node.id, node]));

test('the only HTTP In endpoint is the authenticated POST /webhook', () => {
  const endpoints = flows.filter((node) => node.type === 'http in');

  assert.deepEqual(
    endpoints.map(({ url, method }) => ({ url, method })),
    [{ url: '/webhook', method: 'post' }]
  );
  assert.deepEqual(byId.get('in_hook').wires, [['fn_hook']]);
});

test('webhook auth node is fail-closed and isolates rejected requests', () => {
  const authNode = byId.get('fn_hook');

  assert.equal(authNode.outputs, 2);
  assert.match(authNode.func, /global\.get\('webhookSecurity'\)/);
  assert.match(authNode.func, /WEBHOOK_SECURITY_UNAVAILABLE/);
  assert.deepEqual(authNode.wires[0], ['dbg_hook', 'res_hook', 'sw_event']);
  assert.deepEqual(authNode.wires[1], ['res_hook_reject']);
  assert.equal(byId.get('res_hook_reject').type, 'http response');
  assert.equal(byId.get('res_hook_reject').statusCode, '');
});
test('inventory events wait for durable receipt and never enter dashboard or Telegram branches', async () => {
  const fn = new Function('msg', 'global', 'env', 'node', byId.get('fn_hook').func);
  const sent = []; let done = 0;
  const reply = { statusCode: 200, payload: { success: true, eventId: 'synthetic-event' } };
  const security = { routeMessage() { throw Error('Must not route inventory to legacy effects'); },
    async receiveInventoryAlert() { return reply; } };
  assert.equal(fn({ payload: { eventType: 'inventory.alert.opened' } }, { get: () => security },
    { get: () => 'https://backend.example/api' }, { send: value => sent.push(value), done: () => done++ }), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [[null, reply]]); assert.equal(done, 1);
});

test('no Function node requests dynamic external modules', () => {
  const functionNodes = flows.filter((node) => node.type === 'function');

  for (const node of functionNodes) {
    assert.equal(node.libs.length, 0, node.id);
    assert.doesNotMatch(node.func, /require\s*\(/, node.id);
  }
});

test('Telegram HTTP calls stop before constructing a token URL when token is absent', () => {
  assert.match(byId.get('tg_send').func, /if \(!token\)/);
  assert.match(byId.get('tg_menu_prep').func, /if \(!token\) return null/);
});

test('Telegram HTTP errors are caught and stripped before safe logging', () => {
  const catchNode = byId.get('tg_http_catch');
  const sanitizer = byId.get('tg_http_error_safe');

  assert.deepEqual(catchNode.scope.sort(), ['tg_menu_http', 'tg_send_http']);
  assert.deepEqual(catchNode.wires, [['tg_http_error_safe']]);
  assert.match(sanitizer.func, /delete msg\.error/);
  assert.match(sanitizer.func, /delete msg\.url/);
  assert.doesNotMatch(sanitizer.func, /TELEGRAM_BOT_TOKEN/);
});

test('Docker and deployment files enforce the production policy', () => {
  const dockerfile = fs.readFileSync(path.join(nodeRedDirectory, 'Dockerfile'), 'utf8');
  const render = fs.readFileSync(path.join(nodeRedDirectory, 'render.yaml'), 'utf8');

  assert.match(dockerfile, /^FROM nodered\/node-red:4\.1\.15-22/m);
  assert.doesNotMatch(dockerfile, /node-red:latest/);
  assert.match(dockerfile, /npm ci/);
  assert.match(render, /NODE_ENV\s*\n\s*value: production/);
  assert.match(render, /NODE_RED_ENABLE_EDITOR\s*\n\s*value: "true"/);
  assert.match(render, /NODE_RED_ADMIN_USER\s*\n\s*sync: false/);
  assert.match(render, /NODE_RED_ADMIN_PASSWORD_HASH\s*\n\s*sync: false/);
  assert.match(render, /NODE_RED_WEBHOOK_SECRET/);
  assert.match(render, /NODE_RED_HTTP_PASSWORD/);
});
