'use strict';
// Local certification limits only. Cloud capture/restore remains disabled.
const LIMITS = Object.freeze({ captureMs: 120000, restoreMs: 300000, verificationMs: 120000,
  maxBytes: 128 * 1024 * 1024, maxDocuments: 200000, maxChunks: 128, maxRssBytes: 512 * 1024 * 1024 });
function budget(milliseconds, { now = Date.now, memory = process.memoryUsage } = {}) {
  const started = now();
  return () => {
    const code = now() - started > milliseconds ? 'CHECKPOINT_OPERATION_TIMEOUT'
      : memory().rss > LIMITS.maxRssBytes ? 'CHECKPOINT_MEMORY_LIMIT_EXCEEDED' : null;
    if (code) throw Object.assign(new Error(code), { code });
  };
}
module.exports = { LIMITS, budget };
