// The database restarting at the same moment as LoxSuite (Unraid updating containers at night: "the
// database system is shutting down"): a settings read that fails was remembered as "nothing stored", so
// the heat pump and Smart charging showed their defaults until the next restart — and a save then wrote
// those defaults over the real settings (reported after an update). v0.63.2: tried again, then an error;
// nothing remembered, so the next read gets the real settings.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const settings = require('../src/wallboxSettings');

before(async () => { await initTestDb(); settings.RETRY_MS.splice(0, settings.RETRY_MS.length, 1, 1); });
after(async () => { await db.close(); });

// the settings table "shutting down" while `down` is true
function outage() {
  const orig = db.prepare;
  const origUpsert = db.upsert;
  const state = { down: true, tries: 0 };
  db.upsert = function (table) {
    if (state.down && table === 'wallbox_settings') return Promise.reject(new Error('the database system is shutting down'));
    return origUpsert.apply(this, arguments);
  };
  db.prepare = function (sql) {
    if (state.down && /wallbox_settings/.test(sql)) {
      return { get: async () => { state.tries += 1; throw new Error('the database system is shutting down'); }, run: async () => { throw new Error('the database system is shutting down'); } };
    }
    return orig.apply(this, arguments);
  };
  state.restore = () => { db.prepare = orig; db.upsert = origUpsert; };
  return state;
}

test('a read that fails is tried again, then an error — not "nothing stored", and nothing remembered', async () => {
  await settings.set('energy_module_heatpump', { enabled: true, mode: 'live', steps: 3 });
  settings.clearCache();
  const o = outage();
  try {
    await assert.rejects(settings.get('energy_module_heatpump', { enabled: false, mode: 'off' }), (e) => e.code === 'SETTINGS_UNREADABLE' && /shutting down/.test(e.message));
    assert.equal(o.tries, 3, 'the first try and two more');
    // a save based on it can't happen: patch reads first and stops
    await assert.rejects(settings.patch('energy_module_heatpump', { steps: 1 }, { enabled: false }));
    o.down = false;
    assert.deepEqual(await settings.get('energy_module_heatpump', { enabled: false, mode: 'off', heartbeat: '' }), { enabled: true, mode: 'live', steps: 3, heartbeat: '' }, 'once it answers: the real settings');
  } finally { o.restore(); }
});

test('back after a short hiccup: the retry reads it', async () => {
  await settings.set('planner', { mode: 'plan', max_kw: 11 });
  settings.clearCache();
  const o = outage();
  setTimeout(() => { o.down = false; }, 0);
  try {
    assert.deepEqual(await settings.get('planner', { mode: 'off' }), { mode: 'plan', max_kw: 11 });
  } finally { o.restore(); }
});

test('a save that fails leaves the remembered value as it was', async () => {
  await settings.set('day_types', { away_from: '2026-10-20' });
  const o = outage();
  try {
    await assert.rejects(settings.set('day_types', { away_from: null }));
  } finally { o.restore(); }
  assert.deepEqual(await settings.get('day_types', {}), { away_from: '2026-10-20' });
});
