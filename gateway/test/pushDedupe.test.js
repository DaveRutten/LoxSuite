// The same notification only once per device: a push-to-all channel next to a personal push
// subscription, the same URL twice, or two rules on one event (notifications.js, webPush.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeTargets } = require('../src/notifications');
const webPush = require('../src/webPush');

test('push to all devices makes the personal push targets superfluous; the same URL is sent once', () => {
  const t = dedupeTargets([
    { name: 'Push', url: 'loxsuite-push://all' },
    { name: "dave's devices (push)", url: 'loxsuite-push://user/1' },
    { name: 'Telegram', url: 'tgram://abc/123' },
    { name: "dave's notifications", url: 'tgram://abc/123/' },
  ]);
  assert.deepEqual(t.map((x) => x.name), ['Push', 'Telegram']);
  assert.equal(dedupeTargets([{ url: 'loxsuite-push://user/1' }, { url: 'loxsuite-push://user/2' }]).length, 2);
});

test('a device gets the same message once within a few minutes, another message right away', async () => {
  webPush._recent.clear();
  const p = { title: 'Skoda Kodiaq: data source recovered', body: 'works again' };
  assert.equal(webPush.seenRecently(7, p, 1000), false);
  assert.equal(webPush.seenRecently(7, p, 2000), true, 'second rule, same event');
  assert.equal(webPush.seenRecently(8, p, 2000), false, 'another device');
  assert.equal(webPush.seenRecently(7, { ...p, body: 'fails' }, 2000), false, 'another message');
  assert.equal(webPush.seenRecently(7, p, 1000 + 4 * 60000), false, 'later again: a new event');
});
