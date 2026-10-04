// Key/value settings of the Wallbox features (table wallbox_settings, migration 023). Values are
// JSON; get() merges the stored object over the given defaults so new options get a sane value on
// existing installs without a migration.
const db = require('./db');

const memo = new Map();

async function get(key, defaults = {}) {
  let value = memo.get(key);
  if (value === undefined) {
    try {
      const row = await db.prepare('SELECT value FROM wallbox_settings WHERE setting_key = ?').get(key);
      value = row?.value ? JSON.parse(row.value) : null;
    } catch {
      value = null;
    }
    memo.set(key, value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && defaults && typeof defaults === 'object') {
    return { ...defaults, ...value };
  }
  return value ?? defaults;
}

async function set(key, value) {
  memo.set(key, value);
  await db.upsert('wallbox_settings', { setting_key: key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, ['setting_key']);
  return value;
}

async function patch(key, partial, defaults = {}) {
  const cur = await get(key, defaults);
  return set(key, { ...cur, ...partial });
}

function clearCache() { memo.clear(); }

module.exports = { get, set, patch, clearCache };
