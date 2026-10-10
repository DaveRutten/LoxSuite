// What the heat pump and solar panels tell the user (energyAlerts.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const ea = require('../src/energyAlerts');

const T = Date.parse('2026-10-10T08:00:00Z');

test('legionella overdue, tank too cold and a fault each give one alert with a stable key', () => {
  const st = { legionella: { overdue: true, due: T }, limits: { comfortMinC: 45 }, plan: [{ ms: T + 3600000, predC: 47 }, { ms: T + 7200000, predC: 43.2 }], values: { errorCode: 7 }, state: { mode: 'heating' } };
  const a = ea.heatpumpAlerts(st, {}, T);
  assert.deepEqual(a.map((x) => x.key.split('|')[0]), ['leg', 'tank', 'fault']);
  assert.match(a[1].message, /43\.2 °C/);
  assert.deepEqual(ea.heatpumpAlerts(st, {}, T).map((x) => x.key), a.map((x) => x.key), 'same minute, same keys: sent once');
});

test('defrosting only after 30 minutes, the solar limit after 3 hours', () => {
  const mem = {};
  const st = { state: { mode: 'defrost' }, limits: {} };
  assert.equal(ea.heatpumpAlerts(st, mem, T).length, 0);
  assert.equal(ea.heatpumpAlerts(st, mem, T + 29 * 60000).length, 0);
  assert.equal(ea.heatpumpAlerts(st, mem, T + 31 * 60000)[0].key, `defrost|${T}`);
  assert.equal(ea.heatpumpAlerts({ state: { mode: 'heating' }, limits: {} }, mem, T + 32 * 60000).length, 0);
  const sm = {};
  assert.equal(ea.solarAlerts({ limit: { pct: 40 } }, sm, T).length, 0);
  assert.equal(ea.solarAlerts({ limit: { pct: 40 } }, sm, T + 3.1 * 3600000).length, 1);
});

test('a failing heartbeat is told after 5 minutes', () => {
  assert.equal(ea.heartbeatAlert('heatpump', { error: 'timeout', failingSince: T, vi: 'X' }, T + 4 * 60000).length, 0);
  assert.equal(ea.heartbeatAlert('heatpump', { error: 'timeout', failingSince: T, vi: 'X' }, T + 6 * 60000).length, 1);
});
