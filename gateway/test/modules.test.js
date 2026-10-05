const { test } = require('node:test');
const assert = require('node:assert/strict');
const modules = require('../src/modules');

const all = (v) => new Map(modules.MODULES.map((m) => [m.key, v]));

test('switching a module on also switches on what it needs', () => {
  const { next, changed } = modules.applySwitch(all(false), 'charging', true);
  assert.equal(next.get('charging'), true);
  assert.equal(next.get('energy'), true);
  assert.equal(next.get('vehicles'), true);
  assert.equal(next.get('ocpp'), false);
  assert.deepEqual(changed.map((c) => c.key).sort(), ['charging', 'energy', 'vehicles']);
});

test('switching a module off also switches off what depends on it', () => {
  const { next, changed } = modules.applySwitch(all(true), 'energy', false);
  assert.equal(next.get('energy'), false);
  assert.equal(next.get('charging'), false);
  assert.equal(next.get('energy_manager'), false);
  assert.equal(next.get('vehicles'), true);
  assert.equal(next.get('ocpp'), true);
  assert.deepEqual(changed.map((c) => c.key).sort(), ['charging', 'energy', 'energy_manager']);
  assert.equal(modules.applySwitch(all(true), 'mqtt', false).next.get('monitor'), false);
});

test('every module only needs modules that exist, and no module needs itself', () => {
  const keys = new Set(modules.MODULES.map((m) => m.key));
  for (const m of modules.MODULES) {
    for (const r of m.requires) assert.ok(keys.has(r), `${m.key} needs unknown ${r}`);
    assert.ok(!modules.requiredBy(m.key).has(m.key), `${m.key} needs itself`);
  }
});

test('paths map to their module; core paths to none', () => {
  assert.equal(modules.moduleForPath('/planner/log').key, 'charging');
  assert.equal(modules.moduleForPath('/energy-manager').key, 'energy_manager');
  assert.equal(modules.moduleForPath('/energy').key, 'energy');
  assert.equal(modules.moduleForPath('/energy/import.json').key, 'energy');
  assert.equal(modules.moduleForPath('/logs/mqtt').key, 'mqtt');
  assert.equal(modules.moduleForPath('/logs/system'), null);
  assert.equal(modules.moduleForPath('/miniservers'), null);
  assert.equal(modules.moduleForPath('/'), null);
});

test('the middleware answers "switched off" for a module that is off and passes everything else', () => {
  modules._reset({ ...Object.fromEntries(all(true)), energy_manager: false });
  const mw = modules.middleware();
  const run = (path, method = 'GET') => {
    const res = { locals: {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, render(v, d) { this.view = v; this.data = d; return this; } };
    let passed = false;
    mw({ path, method, get: () => '', user: { isAdmin: true } }, res, () => { passed = true; });
    return { res, passed };
  };
  assert.equal(run('/planner').passed, true);
  const off = run('/energy-manager');
  assert.equal(off.passed, false);
  assert.equal(off.res.statusCode, 404);
  assert.equal(off.res.view, 'module-off');
  assert.equal(run('/energy-manager/data.json').res.body.module, 'energy_manager');
  assert.equal(typeof run('/miniservers').res.locals.moduleOn, 'function');
  modules._reset();
});
