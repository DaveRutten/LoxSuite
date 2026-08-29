// Pins the delivery retry schedule (notifications.js). A transient send failure used to lose the
// alert outright; now each target retries on a backoff before giving up. This guards both ends of
// that: the first few attempts must actually be scheduled, and the schedule must eventually END
// (return null) so a genuinely broken channel URL can't retry forever.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retryDelayMs } = require('../src/notifications');

test('the first three attempts back off on a growing delay', () => {
  assert.equal(retryDelayMs(1), 30 * 1000);
  assert.equal(retryDelayMs(2), 2 * 60 * 1000);
  assert.equal(retryDelayMs(3), 5 * 60 * 1000);
});

test('after the scheduled attempts run out it gives up (null), never loops forever', () => {
  assert.equal(retryDelayMs(4), null);
  assert.equal(retryDelayMs(5), null);
  assert.equal(retryDelayMs(100), null);
});
