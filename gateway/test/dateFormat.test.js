// dateFormat.js pulls the display timezone from gateway_settings, which requires db.js — pointed
// at an in-memory database (better-sqlite3 treats ':memory:' as a special path) so running this
// suite never touches the real gateway.db, and every migration db.js runs on require is exercised
// fresh each time as a side effect.
process.env.DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { formatDateTime, getDisplayTimezone, invalidateTimezoneCache } = require('../src/dateFormat');

test('getDisplayTimezone defaults to UTC on a fresh database', () => {
  assert.equal(getDisplayTimezone(), 'UTC');
});

test('formatDateTime renders in DD/MM/YYYY, HH:MM:SS shape, in UTC by default', () => {
  assert.equal(formatDateTime('2026-03-05T14:30:00.000Z'), '05/03/2026, 14:30:00');
});

test('formatDateTime returns an empty string for missing/invalid input', () => {
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime('not a date'), '');
});

test('formatDateTime follows a saved timezone once the cache is invalidated', () => {
  db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run('Pacific/Kiritimati'); // UTC+14, no DST to complicate the assertion
  invalidateTimezoneCache();
  assert.equal(getDisplayTimezone(), 'Pacific/Kiritimati');
  assert.equal(formatDateTime('2026-03-05T14:30:00.000Z'), '06/03/2026, 04:30:00');
});

test('formatDateTime falls back to UTC if the saved timezone name is somehow invalid', () => {
  db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run('Not/A_Real_Zone');
  invalidateTimezoneCache();
  assert.equal(formatDateTime('2026-03-05T14:30:00.000Z'), '05/03/2026, 14:30:00');
});
