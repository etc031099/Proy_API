'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateDataset } = require('./lib/minimarket-v3-generator');

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requiere un valor`);
  return args[index + 1];
}

function printResult(result) {
  console.log(JSON.stringify({
    outputDir: result.outputDir,
    counts: result.manifest.counts,
    aggregates: result.manifest.aggregates,
    logicalDatasetSha256: result.manifest.hashes.logicalDatasetSha256,
    warnings: result.report.analytics.diversityWarnings,
  }, null, 2));
}

function runReproducibilityCheck(seed) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'minimarket-pasco-v3-repro-'));
  const first = path.join(workspace, 'run-a');
  const second = path.join(workspace, 'run-b');
  try {
    const a = generateDataset({ outputDir: first, seed });
    const b = generateDataset({ outputDir: second, seed });
    const equal = a.manifest.hashes.logicalDatasetSha256 === b.manifest.hashes.logicalDatasetSha256;
    console.log(JSON.stringify({ reproducible: equal, seed, runA: a.manifest.hashes.logicalDatasetSha256, runB: b.manifest.hashes.logicalDatasetSha256 }, null, 2));
    if (!equal) process.exitCode = 1;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const seed = Number(readOption(args, '--seed', 2026));
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('--seed debe ser entero entre 0 y 4294967295');
  if (args.includes('--verify-reproducibility')) return runReproducibilityCheck(seed);
  const output = readOption(args, '--output', path.join(__dirname, '../data/minimarket-pasco-v3/generated'));
  const result = generateDataset({ outputDir: output, seed });
  printResult(result);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main, runReproducibilityCheck };
