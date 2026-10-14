'use strict';
// Local isolation benchmark: actual frontend cache + actual ML engines + synthetic revision relay.
// Excludes Express, Mongo snapshot reads, Internet RTT, Render sleep and browser rendering.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const ts = require('../frontend/node_modules/typescript');
const Module = require('node:module');

async function main() {
  const root = path.resolve(__dirname, '..');
  const child = spawn(path.join(root, 'ml', '.venv', 'Scripts', 'python.exe'), [path.join(__dirname, 'profile-v3-intelligence-reads.py'), '--serve'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic += chunk.toString(); });
  const timer = setTimeout(() => child.kill(), 90_000);
  try {
    const info = await new Promise((resolve, reject) => {
      lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Local profiler exited (${code}): ${diagnostic.slice(-500)}`)));
    });
    const source = readFileSync(path.join(root, 'frontend/src/lib/intelligenceReadCache.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const filename = path.join(root, 'frontend/src/lib/intelligenceReadCache.benchmark.cjs');
    const local = new Module(filename);
    local._compile(compiled, filename);
    const { IntelligenceReadCache } = local.exports;
    const url = `http://127.0.0.1:${info.port}`;
    const get = async name => { const response = await fetch(`${url}/${name}`); if (!response.ok) throw new Error(`Local ${name}: ${response.status}`); return response.json(); };
    const cache = new IntelligenceReadCache(() => get('revision'));
    const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
    const result = { scope: 'local-ML-loopback/synthetic-revision', runtimeLoadMs: info.runtimeLoadMs, samples: {} };
    for (const name of ['business', 'forecast', 'inventory', 'sales', 'customers', 'suppliers', 'associations', 'health']) {
      const baseline = [], cached = [];
      const versioned = name !== 'associations';
      const expected = await get(name); // warm-up, excluded
      for (let i = 0; i < 5; i++) { const start = performance.now(); await get(name); baseline.push(performance.now() - start); }
      await cache.read(name, () => get(name), versioned); // prime, excluded
      for (let i = 0; i < 5; i++) {
        const start = performance.now(); const value = await cache.read(name, () => get(name), versioned); cached.push(performance.now() - start);
        if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`Parity mismatch ${name}`);
      }
      result.samples[name] = { beforeWarmMedianMs: +median(baseline).toFixed(3), afterWarmMedianMs: +median(cached).toFixed(3),
        afterWarmMaxMs: +Math.max(...cached).toFixed(3), parity: 'MATCH', hash: createHash('sha256').update(JSON.stringify(expected)).digest('hex') };
    }
    console.log(JSON.stringify(result));
  } finally { clearTimeout(timer); lines.close(); child.kill(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
