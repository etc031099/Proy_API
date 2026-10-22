const fail = () => { throw Object.assign(new Error('Invalid Telegram configuration'), { code: 'TELEGRAM_CONFIGURATION_INVALID' }); };
const readTelegramConfig = (env = process.env) => {
  for (const key of ['TELEGRAM_ASSISTANT_ENABLED', 'TELEGRAM_ASSISTANT_OPERATIONS_ENABLED']) {
    if (env[key] !== undefined && !['true', 'false'].includes(env[key])) fail();
  }
  const mode = env.TELEGRAM_UPDATES_MODE || 'disabled';
  if (!['disabled', 'webhook', 'legacy_polling'].includes(mode)) fail();
  const enabled = env.TELEGRAM_ASSISTANT_ENABLED === 'true';
  // A.8.2A has no commercial runtime. Even accidental configuration cannot enable writes.
  if (env.TELEGRAM_ASSISTANT_OPERATIONS_ENABLED === 'true') fail();
  if (enabled && mode !== 'webhook' || !enabled && mode === 'webhook') fail();
  let bindings = [];
  if (enabled) {
    if (env.AGENT_ENABLED !== 'true') fail();
    if (!/^\d{5,15}:[A-Za-z0-9_-]{20,200}$/.test(env.TELEGRAM_BOT_TOKEN || '')
      || !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || '')
      || env.TELEGRAM_WEBHOOK_SECRET === env.NODE_RED_WEBHOOK_SECRET
      || env.TELEGRAM_WEBHOOK_SECRET === env.JWT_SECRET
      || env.TELEGRAM_WEBHOOK_SECRET === env.TELEGRAM_BOT_TOKEN) fail();
    try { bindings = JSON.parse(env.TELEGRAM_ASSISTANT_BINDINGS); } catch { fail(); }
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 20) fail();
    const chats = new Set(), businesses = new Set();
    bindings = bindings.map(row => {
      if (!row || Array.isArray(row) || typeof row !== 'object'
        || Object.keys(row).some(key => !['telegramUserId', 'chatId', 'systemUserId', 'businessId', 'bindingGeneration'].includes(key))
        || typeof row.chatId !== 'string' || !/^[1-9]\d{0,15}$/.test(row.chatId) || !Number.isSafeInteger(Number(row.chatId))
        || row.telegramUserId !== row.chatId || !/^[a-f0-9]{24}$/.test(row.systemUserId)
        || typeof row.businessId !== 'string' || !row.businessId.trim() || row.businessId.length > 50
        || !Number.isSafeInteger(row.bindingGeneration) || row.bindingGeneration < 1
        || chats.has(row.chatId) || businesses.has(row.businessId)) fail();
      chats.add(row.chatId); businesses.add(row.businessId);
      return Object.freeze({ ...row });
    });
  }
  return Object.freeze({ enabled, mode, secret: enabled ? env.TELEGRAM_WEBHOOK_SECRET : null,
    operationsEnabled: false, bindings: Object.freeze(bindings) });
};
const legacyPollingEnabled = () => {
  try { const config = readTelegramConfig(); return !config.enabled && config.mode === 'legacy_polling'; }
  catch { return false; }
};
module.exports = { readTelegramConfig, legacyPollingEnabled };
