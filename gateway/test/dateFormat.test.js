// dateFormat.js pulls the display timezone from gateway_settings, which requires the async db
// facade — pointed at an in-memory database (see helpers/testDb.js) so running this suite never
// touches the real gateway.db, and every migration is exercised fresh each time as a side effect.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb } = require('./helpers/testDb');
const { formatDateTime, getDisplayTimezone, invalidateTimezoneCache, loadTimezoneCache } = require('../src/dateFormat');

let db;

before(async () => {
  db = await initTestDb();
  // getDisplayTimezone() reads a synchronous in-memory cache (see dateFormat.js's own comment on
  // why) that's normally populated once by server.js's async bootstrap right after db.init() —
  // this test suite has no bootstrap of its own, so it has to fill that cache itself before
  // relying on getDisplayTimezone()'s default-to-UTC read below.
  await loadTimezoneCache();
});

after(async () => {
  await db.close();
});

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

test('formatDateTime follows a saved timezone once the cache is invalidated', async () => {
  await db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run('Pacific/Kiritimati'); // UTC+14, no DST to complicate the assertion
  await invalidateTimezoneCache();
  assert.equal(getDisplayTimezone(), 'Pacific/Kiritimati');
  assert.equal(formatDateTime('2026-03-05T14:30:00.000Z'), '06/03/2026, 04:30:00');
});

test('formatDateTime falls back to UTC if the saved timezone name is somehow invalid', async () => {
  await db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run('Not/A_Real_Zone');
  await invalidateTimezoneCache();
  assert.equal(formatDateTime('2026-03-05T14:30:00.000Z'), '05/03/2026, 14:30:00');
});
