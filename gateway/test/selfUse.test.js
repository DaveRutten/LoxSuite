// Own energy (selfUse.js): self use, self-sufficiency, car vs house, and the suggestions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compute } = require('../src/selfUse');

const H = 3600000;
const T0 = Date.UTC(2026, 5, 1); // 1 June 2026, local hour = UTC hour in these tests
const iso = (ms) => new Date(ms).toISOString();
const opts = { localHourOf: (ms) => new Date(ms).getUTCHours(), dayOf: (ms) => iso(ms).slice(0, 10), nowMs: Date.UTC(2026, 6, 1) };

// one day: night import 0.3 kWh/h, solar 11–15 h 3 kWh with 2 kWh exported, the car charging at 12 from solar
function day(d, { car = false } = {}) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const ms = T0 + d * 24 * H + h * H;
    const sun = h >= 11 && h < 15;
    const wallbox = car && h === 12 ? 2 : 0;
    out.push({ hour: iso(ms), pv: sun ? 3 : 0, exp: sun ? (wallbox ? 0 : 2) : 0, imp: sun ? 0 : 0.3, wallbox });
  }
  return out;
}

test('self use and self-sufficiency from the hourly meters', () => {
  const r = compute({ ...opts, hours: day(0, { car: true }), days: 1, hasCar: true });
  // solar 12, exported 3 × 2 = 6 → used yourself 6 of 12
  assert.equal(r.totals.pvKwh, 12);
  assert.equal(r.totals.exportKwh, 6);
  assert.equal(r.totals.selfRate, 0.5);
  // used: 20 h × 0.3 import + 6 own solar = 12 → 6 of 12 from the panels
  assert.equal(r.totals.useKwh, 12);
  assert.equal(r.totals.autarky, 0.5);
  // the car charged 2 kWh in a solar hour without import: all own solar
  assert.equal(r.totals.carSolarRate, 1);
  assert.equal(r.days.length, 1);
});

test('suggestions: car, a washing machine outside the sun hours, a home battery, the base load', () => {
  const hours = [];
  for (let d = 0; d < 10; d++) hours.push(...day(d));
  // the washing machine runs at 19:00, 1 kWh a day — never on solar
  const hourly = {};
  for (let d = 0; d < 10; d++) hourly[iso(T0 + d * 24 * H + 19 * H)] = 1;
  const r = compute({ ...opts, hours, days: 10, hasCar: true, hasBattery: false, planner: { mode: 'plan' }, loads: [{ id: 3, name: 'Washing machine', kind: 'appliance', hourly }] });
  const keys = r.suggestions.map((s) => s.key);
  assert.ok(keys.includes('car'), 'solar went out while the car did not charge');
  assert.ok(keys.includes('load.3'), 'the washing machine can move to the sun hours');
  assert.ok(keys.includes('battery'), 'exported by day, imported again in the evening');
  assert.ok(keys.includes('baseload'), '300 W at night');
  const wm = r.suggestions.find((s) => s.key === 'load.3');
  assert.equal(wm.p.w, '11:00–15:00');
  assert.equal(wm.p.p, 0);
  const car = r.suggestions.find((s) => s.key === 'car');
  assert.match(car.t, /Min \+ Solar/, 'not on solar yet: point at the mode');
  assert.deepEqual(r.window, { from: 11, to: 15 });
});

test('with a home battery there is no battery suggestion; nothing exported, nothing to suggest about it', () => {
  const hours = [];
  for (let d = 0; d < 10; d++) hours.push(...day(d));
  assert.ok(!compute({ ...opts, hours, days: 10, hasBattery: true }).suggestions.some((s) => s.key === 'battery'));
  const none = hours.map((h) => ({ ...h, pv: 0, exp: 0, imp: 0.1 }));
  const r = compute({ ...opts, hours: none, days: 10, hasCar: true });
  assert.equal(r.totals.selfRate, null);
  assert.ok(!r.suggestions.some((s) => ['car', 'battery'].includes(s.key)));
});
