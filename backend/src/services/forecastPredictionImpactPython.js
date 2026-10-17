'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..');
const fail = code => Object.assign(new Error(code), { code });
function scorePredictionImpact(payload, { executable, spawnProcess = spawn, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof executable !== 'string' || !executable) return reject(fail('IMPACT_SCORING_FAILED'));
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > 32 * 1024 * 1024) return reject(fail('IMPACT_SIZE_LIMIT'));
    const child = spawnProcess(executable, ['-B', '-m', 'ml.service.v3_ridge_prediction_impact'],
      { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill(); }, timeoutMs);
    child.stderr.resume(); // Never retain or log raw Python errors.
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 512 * 1024) { invalid = true; child.kill(); }
    });
    child.on('error', () => { clearTimeout(timer); reject(fail('IMPACT_SCORING_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (invalid || code !== 0) return reject(fail('IMPACT_SCORING_FAILED'));
      try {
        const envelope = JSON.parse(output);
        if (envelope.ok !== true || !Array.isArray(envelope.result?.horizons)) throw new Error();
        resolve(envelope.result);
      } catch { reject(fail('IMPACT_SCORING_INVALID')); }
    });
    child.stdin.end(input);
  });
}
module.exports = { scorePredictionImpact };
