'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Binary } = require('mongoose').mongo;
const { verifyArtifact, createForecastModelRegistryService } = require('../src/services/forecastModelRegistryService');

const bytes = Buffer.from('ridge-persisted-artifact');
const artifactHash = createHash('sha256').update(bytes).digest('hex');
const representations = {
  Buffer: () => Buffer.from(bytes),
  Uint8Array: () => new Uint8Array(bytes),
  'BSON Binary': () => new Binary(Buffer.from(bytes)),
};

for (const [name, represent] of Object.entries(representations)) {
  test(`registry integrity checks ${name} bytes, SHA256 and recorded size`, () => {
    const artifact = { artifactData: represent(), artifactHash, artifactBytes: bytes.length };
    assert.equal(verifyArtifact(artifact), true);
    for (const invalid of [{ artifactHash: '0'.repeat(64) }, { artifactBytes: bytes.length + 1 }]) {
      assert.throws(() => verifyArtifact({ ...artifact, ...invalid }), { code: 'ARTIFACT_HASH_MISMATCH' });
    }
  });

  test(`registry serving returns verified ${name} as an exact Buffer for 7d/14d`, async () => {
    const read = value => ({ session() { return this; }, select() { return this; },
      lean() { return this; }, maxTimeMS: async () => value });
    const registry = createForecastModelRegistryService({
      registryModel: { findOne: () => read({ activeArtifactId: 'active', activeModelVersion: 1 }) },
      artifactModel: { findOne: scope => read({ ...scope, artifactData: represent(),
        artifactHash, artifactBytes: bytes.length }) },
      startSession: async () => ({ startTransaction() {}, commitTransaction: async () => {},
        endSession: async () => {}, inTransaction: () => false }),
    });
    for (const horizonDays of [7, 14]) {
      const result = await registry.getActiveModelArtifact({ businessId: 'TEST', scenarioId: 'test', horizonDays });
      assert.equal(Buffer.isBuffer(result.artifactData), true);
      assert.deepEqual(result.artifactData, bytes);
      assert.equal(createHash('sha256').update(result.artifactData).digest('hex'), artifactHash);
    }
  });
}

test('BSON Binary integrity uses logical bytes rather than unused capacity', () => {
  const binary = new Binary();
  binary.write(bytes, 0);
  assert.ok(binary.buffer.length > binary.position);
  assert.equal(verifyArtifact({ artifactData: binary, artifactHash, artifactBytes: bytes.length }), true);
});

test('invalid binary values and malformed positions fail integrity checks', () => {
  for (const artifactData of [null, {}, { _bsontype: 'Binary', buffer: bytes, position: -1 },
    { _bsontype: 'Binary', buffer: bytes, position: bytes.length + 1 }]) {
    assert.throws(() => verifyArtifact({ artifactData, artifactHash, artifactBytes: bytes.length }),
      { code: 'ARTIFACT_HASH_MISMATCH' });
  }
});
