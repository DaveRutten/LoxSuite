// Administration home (src/adminHub.js): who sees which tile — the same rules as the old tab bar —
// where the Administration link goes, and a status on every tile.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const hub = require('../src/adminHub');
const nav = require('../src/navigation');

// res.locals-like: a user with these rights (area -> 'view' | 'edit'), admin or not, modules on.
function locals({ admin = false, rights = {}, off = [], multiLang = false } = {}) {
  const level = (a) => (admin ? 2 : rights[a] === 'edit' ? 2 : rights[a] === 'view' ? 1 : 0);
  return {
    currentUser: { id: 1, isAdmin: admin },
    canView: (a) => level(a) >= 1,
    canEdit: (a) => level(a) >= 2,
    moduleOn: (k) => !off.includes(k),
    multiLang,
    t: (k, vars) => String(k).replace(/\{(\w+)\}/g, (m, n) => (vars && vars[n] !== undefined ? vars[n] : m)),
  };
}
const keys = (l) => hub.visibleTiles(l).map((x) => x.key);
const adminHref = (l) => nav.context(l).adminHref;

before(async () => { await initTestDb(); });
after(() => db.close());

test('an admin sees every tile; AI only with the AI module on, Translations only with more languages', () => {
  assert.deepEqual(keys(locals({ admin: true, multiLang: true })), ['users', 'roles', 'security', 'general', 'settings', 'modules', 'backup', 'languages', 'translations', 'notifications', 'energy', 'ai', 'mcp']);
  assert.ok(!keys(locals({ admin: true, off: ['ai'] })).includes('ai'));
  assert.ok(!keys(locals({ admin: true })).includes('translations'));
  assert.equal(adminHref(locals({ admin: true })), '/admin');
});

test('someone without admin rights sees only the parts their role allows', () => {
  assert.deepEqual(keys(locals({ rights: { settings: 'edit' } })), ['settings']);
  assert.deepEqual(keys(locals({ rights: { settings: 'view' } })), []);
  assert.deepEqual(keys(locals({ rights: { charging: 'view' } })), ['energy']);
  assert.deepEqual(keys(locals({ rights: { charging: 'view' }, off: ['charging'] })), []);
  assert.deepEqual(keys(locals({ rights: { translations: 'view' }, multiLang: true })), ['translations']);
  assert.equal(adminHref(locals({ rights: { settings: 'edit' } })), '/admin');
  assert.equal(adminHref(locals({ rights: { live_data: 'edit' } })), null);
});

test('tiles come in groups, empty groups left out', () => {
  const groups = hub.groupsFor(locals({ rights: { settings: 'edit', energy: 'view' } }));
  assert.deepEqual(groups.map((g) => [g.key, g.tiles.map((x) => x.key)]), [['system', ['settings']], ['energy', ['energy']]]);
});

test('every tile gets a status line, and a backup that never ran asks for attention', async () => {
  const groups = await hub.hubFor(locals({ admin: true, multiLang: true }));
  const tiles = groups.flatMap((g) => g.tiles);
  for (const x of tiles) assert.ok(x.status && x.status !== 'status unknown', `${x.key}: ${x.status}`);
  assert.ok(tiles.find((x) => x.key === 'backup').warn, 'no backup yet is a warning');
  assert.match(tiles.find((x) => x.key === 'mcp').status, /MCP off/);
});

test('ago: minutes, hours, days', () => {
  const t = locals().t;
  const now = Date.parse('2026-11-24T12:00:00Z');
  assert.equal(hub.ago(t, '2026-11-24T11:59:50Z', now), 'just now');
  assert.equal(hub.ago(t, '2026-11-24T11:35:00Z', now), '25 min ago');
  assert.equal(hub.ago(t, '2026-11-24T09:00:00Z', now), '3 h ago');
  assert.equal(hub.ago(t, '2026-11-20T12:00:00Z', now), '4 days ago');
});
