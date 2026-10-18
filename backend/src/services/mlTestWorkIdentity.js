'use strict';
const F = require('./mlTestFence');
const config = require('../config/v3Operational');
// Called before execution-history creation, Python, claim, or preflight writes.
async function bindLaunch(db, { testEpoch, queuedAt, github = false, manualRequestKey } = {}) {
  const row = await db.collection('mltestcontrols').findOne({ businessId: config.businessId }, { promoteLongs: false });
  const current = F.tokenOf(row);
  if (testEpoch) await F.assertCurrent(db, F.parseToken(testEpoch));
  const fenced = current.present && BigInt(current.resetEpoch) > 0n;
  if (fenced && github) {
    if (manualRequestKey && !testEpoch) F.fail('TEST_EPOCH_REQUIRED');
    const requestedAt = Date.parse(queuedAt), changedAt = row?.epochChangedAt?.getTime?.();
    if (!Number.isFinite(requestedAt) || !Number.isFinite(changedAt)) F.fail('TEST_QUEUE_IDENTITY_REQUIRED');
    if (requestedAt < changedAt) F.fail('STALE_TEST_EPOCH');
  }
  await F.assertCurrent(db, current);
  return F.durableToken(testEpoch ? F.parseToken(testEpoch) : current);
}
module.exports = { bindLaunch };
