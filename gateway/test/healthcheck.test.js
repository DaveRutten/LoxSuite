// Regression guard for a real, reported bug: a Miniserver (specifically its own Gateway, in the
// report that caught this — see healthcheck.js's own AUTH_FAILED_RECHECK_MS comment) landing in
// 'auth_failed' after a container restart and staying there FOREVER, even though the credentials
// were never actually wrong — a manual "Test now" always worked instantly. checkAllMiniservers'
// own recurring sweep used to filter these out unconditionally and permanently; dueForRecheck is
// what now lets that filter expire after AUTH_FAILED_RECHECK_MS instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dueForRecheck } = require('../src/healthcheck');

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

test('dueForRecheck is always true for a Miniserver that is not currently auth_failed', () => {
  assert.equal(dueForRecheck({ status: 'online', last_checked_at: isoMinutesAgo(0) }), true);
  assert.equal(dueForRecheck({ status: 'offline', last_checked_at: isoMinutesAgo(0) }), true);
  assert.equal(dueForRecheck({ status: 'unknown', last_checked_at: null }), true);
});

test('dueForRecheck is true for an auth_failed Miniserver with no last_checked_at at all', () => {
  // Shouldn't happen in practice (checkMiniserver/markMiniserverAuthFailed both always set it
  // alongside the status itself), but a missing timestamp must never mean "wait forever" —
  // erring toward re-checking sooner is always the safe direction here.
  assert.equal(dueForRecheck({ status: 'auth_failed', last_checked_at: null }), true);
});

test('dueForRecheck stays false for a recently auth_failed Miniserver, within the cooldown', () => {
  assert.equal(dueForRecheck({ status: 'auth_failed', last_checked_at: isoMinutesAgo(1) }), false);
  assert.equal(dueForRecheck({ status: 'auth_failed', last_checked_at: isoMinutesAgo(14) }), false);
});

test('dueForRecheck turns true again once the cooldown has actually elapsed', () => {
  assert.equal(dueForRecheck({ status: 'auth_failed', last_checked_at: isoMinutesAgo(15) }), true);
  assert.equal(dueForRecheck({ status: 'auth_failed', last_checked_at: isoMinutesAgo(60) }), true);
});
