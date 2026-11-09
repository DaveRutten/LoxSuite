const test = require('node:test');
const assert = require('node:assert');
const hs = require('../src/homeSummary');

const H = 3600000;

test('the flow now: solar, house, car and grid from the live meters', () => {
  const f = hs.flowOf({ roles: { pv: { power_kw: 4.8 }, grid: { power_kw: -0.5 }, wallbox: { power_kw: 3.1 } }, house_kw: 1.2 }, { hpMode: 'dhw' });
  assert.deepEqual([f.pv, f.house, f.car, f.grid, f.battery, f.hpMode], [4.8, 1.2, 3.1, -0.5, null, 'dhw']);
  assert.equal(hs.flowOf({ roles: {} }), null, 'no meters: no flow');
});

test('one plain sentence about now', () => {
  assert.equal(hs.sentenceOf({ pv: 4.8, house: 1.2, car: 3.1, grid: -0.5 }, { carCharging: true })[0], 'The sun gives more than the house uses; the car charges along.');
  assert.deepEqual(hs.sentenceOf({ pv: 3, house: 1, car: 0, grid: -2 }), ['The sun gives more than the house uses: {kw} kW goes back to the grid.', { kw: 2 }]);
  assert.deepEqual(hs.sentenceOf({ pv: 0.5, house: 2, car: 0, grid: 1.5 }), ['The sun covers {pct} % of what the house uses now.', { pct: 25 }]);
  assert.deepEqual(hs.sentenceOf({ pv: 0, house: 0.8, car: 0, grid: 0.8 }), ['The house uses {kw} kW from the grid.', { kw: 0.8 }]);
});

test('the day bar: solar to spare, car charging spread over its hours, the heat pump job, and now', () => {
  const day = Date.parse('2026-11-09T00:00:00Z');
  const bar = hs.todayBar({
    dayStartMs: day, nowMs: day + 14.5 * H,
    surplus: new Map([[day + 12 * H, 2.5]]),
    carSlots: [{ start: new Date(day + 12.5 * H).toISOString(), end: new Date(day + 13.5 * H).toISOString(), kwh: 4 }],
    hpPlan: [{ ms: day + 13 * H, does: 'dhw' }, { ms: day + 3 * H, does: 'comfort' }],
  });
  assert.equal(bar.hours.length, 24);
  assert.equal(bar.hours[12].surplus, 2.5);
  assert.equal(bar.hours[12].car, 2);
  assert.equal(bar.hours[13].car, 2);
  assert.equal(bar.hours[13].hp, 'dhw');
  assert.equal(bar.hours[3].hp, null, 'only jobs worth showing');
  assert.equal(bar.hours[13].past, true);
  assert.equal(bar.hours[14].past, false);
  assert.ok(Math.abs(bar.nowPct - (14.5 / 24) * 100) < 0.01);
});

test('a greeting for the time of day', () => {
  assert.equal(hs.greetingOf(3), 'Good night');
  assert.equal(hs.greetingOf(9), 'Good morning');
  assert.equal(hs.greetingOf(14), 'Good afternoon');
  assert.equal(hs.greetingOf(20), 'Good evening');
});
