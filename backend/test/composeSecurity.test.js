const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backendDirectory = path.resolve(__dirname, '..');
const composePath = path.join(backendDirectory, 'docker-compose.yml');

const runComposeConfig = (values) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-compose-test-'));
  const environmentPath = path.join(temporaryDirectory, '.env');
  const environmentFile = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join(os.EOL);

  fs.writeFileSync(environmentPath, `${environmentFile}${os.EOL}`, { mode: 0o600 });

  try {
    const environment = { ...process.env };
    for (const key of [
      'JWT_SECRET',
      'MONGO_ROOT_USERNAME',
      'MONGO_ROOT_PASSWORD',
      'MONGODB_URI_DOCKER'
    ]) {
      delete environment[key];
    }

    return spawnSync(
      'docker',
      ['compose', '--env-file', environmentPath, '-f', composePath, 'config', '--quiet'],
      {
        cwd: backendDirectory,
        env: environment,
        encoding: 'utf8',
        windowsHide: true
      }
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

const validComposeEnvironment = () => {
  const mongoPassword = randomBytes(24).toString('hex');
  return {
    MONGO_ROOT_USERNAME: 'compose_test_admin',
    MONGO_ROOT_PASSWORD: mongoPassword,
    MONGODB_URI_DOCKER: `mongodb://compose_test_admin:${mongoPassword}@mongodb:27017/inventory_billing?authSource=admin&replicaSet=rs0`,
    JWT_SECRET: randomBytes(32).toString('hex')
  };
};

test('Docker Compose rejects missing MongoDB root variables', () => {
  for (const missingVariable of ['MONGO_ROOT_USERNAME', 'MONGO_ROOT_PASSWORD']) {
    const environment = validComposeEnvironment();
    delete environment[missingVariable];

    const result = runComposeConfig(environment);

    assert.notEqual(result.status, 0, `${missingVariable} should be required`);
    assert.match(result.stderr, new RegExp(missingVariable));
  }
});

test('Docker Compose rejects a missing JWT_SECRET', () => {
  const environment = validComposeEnvironment();
  delete environment.JWT_SECRET;

  const result = runComposeConfig(environment);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET/);
});

test('Docker Compose accepts complete external configuration', () => {
  const result = runComposeConfig(validComposeEnvironment());

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('docker-compose.yml contains no critical secret literal and binds MongoDB to loopback', () => {
  const source = fs.readFileSync(composePath, 'utf8');
  const jwtSecretLines = source
    .split(/\r?\n/)
    .filter((line) => line.includes('JWT_SECRET:'));

  assert.equal(jwtSecretLines.length, 1);
  assert.match(jwtSecretLines[0].trim(), /^JWT_SECRET:\s*\$\{JWT_SECRET:\?/);
  assert.match(source, /MONGO_INITDB_ROOT_USERNAME:\s*\$\{MONGO_ROOT_USERNAME:\?/);
  assert.match(source, /MONGO_INITDB_ROOT_PASSWORD:\s*\$\{MONGO_ROOT_PASSWORD:\?/);
  assert.match(source, /127\.0\.0\.1:27017:27017/);
});
