// Regression guard for the reported bug where a Miniserver got permanently stuck in 'auth_failed'
// after the gateway and Miniserver restarted together (e.g. an unattended backup snapshot
// restarting the container) — even though the credentials were never wrong; a manual "Test now"
// worked instantly. The fix (CHANGELOG 0.18.27) is that ONLY Loxone's own documented 401 counts as
// a permanent, never-retry auth failure; every other non-200 gettoken code must be treated as
// temporary so it falls through to the normal reconnect backoff. isPermanentAuthFailure is that
// exact distinction, pinned here so a future refactor can't quietly widen it back to "any non-200".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPermanentAuthFailure } = require('../src/loxoneWebSocket');

test('401 (string or number) is the one permanent auth failure', () => {
  assert.equal(isPermanentAuthFailure('401'), true);
  assert.equal(isPermanentAuthFailure(401), true);
});

test('every other non-200 code is treated as temporary (retryable)', () => {
  // The stale-session-after-simultaneous-restart case reports codes like these — genuinely
  // transient, must NOT get stuck in auth_failed the way a real 401 does.
  for (const code of ['500', '503', '400', '403', '404', '200', '0', '1']) {
    assert.equal(isPermanentAuthFailure(code), false, `code ${code} should be retryable`);
  }
});

test('missing / malformed codes are treated as temporary, never permanent', () => {
  // tokenResp?.LL?.Code can be absent — stringified to "undefined"/"null" upstream, or passed raw.
  assert.equal(isPermanentAuthFailure(undefined), false);
  assert.equal(isPermanentAuthFailure(null), false);
  assert.equal(isPermanentAuthFailure(''), false);
  assert.equal(isPermanentAuthFailure('undefined'), false);
  assert.equal(isPermanentAuthFailure('401 Unauthorized'), false); // not the literal code
});
