// Telegram through apprise 2.x (v0.51.1): apprise now turns the Markdown it gets into Telegram's own
// flavour itself, so LoxSuite hands it plain Markdown (-i markdown) with everything escaped, and asks
// for MarkdownV2 — not our own legacy-Markdown text, which apprise 2 escaped again ("Bad Request: can't
// parse entities: Can't find end of the entity starting at byte offset 29").
const test = require('node:test');
const assert = require('node:assert/strict');
const { telegramMessage, escapeCommonMark } = require('../src/notifications');

const event = {
  title: 'Test notification', severity: 'info',
  message: 'This is a test message from LoxSuite — if you can read this, the channel is configured correctly.',
  fields: [{ label: 'Channel', value: 'Tele_gram (home)' }, { label: 'Sent at', value: '08-10-2026 09:12' }],
};

test('apprise 2: Markdown in, MarkdownV2 out, the title plain (apprise makes it bold)', () => {
  const m = telegramMessage(event, 'tgram://123:ABC/25043668', 2);
  assert.equal(m.url, 'tgram://123:ABC/25043668?format=markdown&mdv=v2');
  assert.deepEqual(m.args, ['-i', 'markdown']);
  assert.equal(m.title, 'ℹ️ Test notification', 'no * of our own: apprise escaped those, and Telegram choked on them');
  assert.equal(m.body, 'This is a test message from LoxSuite — if you can read this, the channel is configured correctly\\.\n\n*Channel:* Tele\\_gram \\(home\\)\n*Sent at:* 08\\-10\\-2026 09:12');
  // a URL with its own format is left alone
  assert.equal(telegramMessage(event, 'tgram://1:A/2?format=html', 2).url, 'tgram://1:A/2?format=html');
  assert.equal(telegramMessage({ ...event, fields: [] }, 'tgram://1:A/2', 2).body.endsWith('correctly\\.'), true);
});

test('apprise 1: our own legacy Markdown, as before', () => {
  const m = telegramMessage({ ...event, title: 'Temp_sensor', severity: 'warning' }, 'tgram://1:A/2', 1);
  assert.equal(m.url, 'tgram://1:A/2?format=markdown&mdv=v1');
  assert.equal(m.title, '🟠 *Temp\\_sensor*');
  assert.deepEqual(m.args, []);
  assert.ok(m.body.includes('_Channel:_ Tele\\_gram (home)'));
});

test('escapeCommonMark: nothing in a value can start formatting, a list or a heading', () => {
  assert.equal(escapeCommonMark('a_b *c* [d](e) `f` <g> #1 - 2. ! | ~ & {h} \\'), 'a\\_b \\*c\\* \\[d\\]\\(e\\) \\`f\\` \\<g\\> \\#1 \\- 2\\. \\! \\| \\~ \\& \\{h\\} \\\\');
  assert.equal(escapeCommonMark('31,5 °C — ok: yes/no?'), '31,5 °C — ok: yes/no?');
});
