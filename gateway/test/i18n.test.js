const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/i18n');

test('extract finds t() calls and literal page titles, not prefixes or canEdit()', () => {
  const src = `<%- include('partials/head', { pageTitle: 'Translations' }) %> <%= t('Smart charging') %> <%= t("Say \\"hi\\"") %>
    <% if (canEdit('settings')) { %> <%= t('{n} sessions', { n }) %> pageTitle: 'Vehicle: ' + name`;
  assert.deepEqual(i18n.extract(src), ['Translations', 'Smart charging', 'Say "hi"', '{n} sessions']);
});

test('translate: shipped file, placeholders, English fallback, unknown language', () => {
  i18n._reset();
  i18n._set({ langs: [{ code: 'en', name: 'English', enabled: 1, is_default: 1 }, { code: 'nl', name: 'Nederlands', enabled: 1, is_default: 0 }], files: { nl: { 'Smart charging': 'Slim laden', '{n} sessions': '{n} sessies' } } });
  assert.equal(i18n.translate('nl', 'Smart charging'), 'Slim laden');
  assert.equal(i18n.translate('nl', '{n} sessions', { n: 3 }), '3 sessies');
  assert.equal(i18n.translate('nl', 'Not there'), 'Not there');
  assert.equal(i18n.translate('en', 'Smart charging'), 'Smart charging');
  assert.equal(i18n.resolveLanguage('nl'), 'nl');
  assert.equal(i18n.resolveLanguage('de'), 'en');
  assert.equal(i18n.resolveLanguage(null), 'en');
  i18n._reset();
});

test('the shipped Dutch file covers the whole catalog and keeps placeholders', () => {
  const nl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'nl.json'), 'utf8'));
  const missing = i18n.catalog().map((e) => e.key).filter((k) => !nl[k]);
  assert.deepEqual(missing, [], `untranslated in nl.json: ${missing.join(' | ')}`);
  for (const [en, tr] of Object.entries(nl)) {
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    assert.equal(ph(tr), ph(en), `placeholders differ: "${en}"`);
  }
});

test('every catalog text belongs to a known module', () => {
  const keys = new Set(['core', ...require('../src/modules').MODULES.map((m) => m.key)]);
  for (const e of i18n.catalog()) assert.ok(keys.has(e.module), `${e.key} → ${e.module}`);
});

test('page helpers load in every language, not only when a translation is active', () => {
  const head = require('fs').readFileSync(require('path').join(__dirname, '../src/views/partials/head.ejs'), 'utf8');
  const langBlock = head.slice(head.indexOf("lang !== 'en'"), head.indexOf('<% } %>', head.indexOf("lang !== 'en'")));
  for (const f of ['monitor-picks.js', 'show-if.js', 'mini-map.js']) {
    assert.ok(head.includes(f), `${f} is loaded`);
    assert.ok(!langBlock.includes(f), `${f} is outside the language-only block`);
  }
});
