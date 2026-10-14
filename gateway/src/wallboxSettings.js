// Key/value settings of the Wallbox features (table wallbox_settings, migration 023). Values are
// JSON; get() merges the stored object over the given defaults so new options get a sane value on
// existing installs without a migration.
//
// A read that fails is not "nothing stored" (v0.63.2). When the database restarts at the same moment as
// LoxSuite (Unraid updating containers at night: "the database system is shutting down"), a failed read
// used to be remembered as empty: every setting — heat pump, Smart charging, … — then showed its default
// until the next restart, and saving a page (or the hourly heat pump history) wrote those defaults over
// what was stored. Now a read is tried a few times, then throws (nothing remembered), so the caller tries
// again later and never works on, or saves, defaults instead of your settings.
const db = require('./db');

const memo = new Map();
const RETRY_MS = [300, 1000, 2500];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readRow(key) {
  let last;
  for (let i = 0; i <= RETRY_MS.length; i++) {
    try {
      return await db.prepare('SELECT value FROM wallbox_settings WHERE setting_key = ?').get(key);
    } catch (err) {
      last = err;
      if (i < RETRY_MS.length) await sleep(RETRY_MS[i]);
    }
  }
  const e = new Error(`The settings could not be read from the database (${last?.message || 'no answer'}).`);
  e.code = 'SETTINGS_UNREADABLE';
  e.cause = last;
  throw e;
}

async function get(key, defaults = {}) {
  let value = memo.get(key);
  if (value === undefined) {
    const row = await readRow(key); // throws when the database doesn't answer: nothing remembered
    try {
      value = row?.value ? JSON.parse(row.value) : null;
    } catch {
      value = null; // stored but unreadable JSON: as if nothing was stored
    }
    memo.set(key, value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && defaults && typeof defaults === 'object') {
    return { ...defaults, ...value };
  }
  return value ?? defaults;
}

async function set(key, value) {
  await db.upsert('wallbox_settings', { setting_key: key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, ['setting_key']);
  memo.set(key, value);
  return value;
}

async function patch(key, partial, defaults = {}) {
  const cur = await get(key, defaults);
  return set(key, { ...cur, ...partial });
}

function clearCache() { memo.clear(); }

module.exports = { get, set, patch, clearCache, RETRY_MS };
