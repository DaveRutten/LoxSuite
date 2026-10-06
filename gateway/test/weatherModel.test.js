// Weather: consumption against heating degrees, how much more a cold day needs, and how fast a room
// cools down (so a heat pump is not held off longer than the room keeps its warmth).
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/temperature');

test('fitLinear: a straight line comes back exactly', () => {
  const f = T.fitLinear([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.equal(f.a, 1); assert.equal(f.b, 2); assert.equal(f.r2, 1);
});

test('heat model: kWh follows heating degrees; a cold day gets a higher factor, a mild one lower', () => {
  // 10 days: 2 kWh base + 0.8 kWh per degree below 18 °C
  const days = [2, 4, 6, 8, 10, 12, 5, 7, 3, 9].map((c, i) => ({ day: `d${i}`, meanC: c, kwh: 2 + 0.8 * (18 - c) }));
  const m = T.heatModel(days);
  assert.equal(m.usable, true);
  assert.equal(m.b, 0.8);
  assert.ok(T.dayFactor(m, 0) > 1.3);
  assert.ok(T.dayFactor(m, 14) < 0.7);
  assert.equal(T.dayFactor({ usable: false }, 0), 1, 'no model: no change');
});

test('heat model: no link (noise) is not used', () => {
  const days = [2, 14, 6, 12, 4, 10, 8, 3, 11, 7].map((c, i) => ({ day: `d${i}`, meanC: c, kwh: [5, 6, 4, 7, 5, 6, 4, 7, 5, 6][i] }));
  assert.equal(T.heatModel(days).usable, false);
});

test('cooling: k from the hours it was off, and how long the room may be held off', () => {
  const rows = [];
  let temp = 21;
  const t0 = Date.parse('2026-10-06T00:00:00Z');
  for (let i = 0; i < 12; i++) {
    rows.push({ hour: new Date(t0 + i * 3600000).toISOString(), temp, onMin: 0, outC: 5 });
    temp -= 0.02 * (temp - 5); // 2% of the difference per hour
  }
  const c = T.coolingModel(rows);
  assert.ok(Math.abs(c.k - 0.02) < 0.002, `k ${c.k}`);
  // at 21 °C inside and 5 °C outside: 0.32 °C/h -> half a degree in ~1.6 h
  assert.equal(T.holdHours(c, 21, 5, 0.5), 1.56);
  // hours with the heat pump on don't count
  assert.equal(T.coolingModel(rows.map((r) => ({ ...r, onMin: 30 }))).k, null);
});

test('heating degrees', () => {
  assert.equal(T.heatingDegrees(10), 8);
  assert.equal(T.heatingDegrees(22), 0);
});
