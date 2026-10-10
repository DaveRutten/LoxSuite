// The heat pump's suggestions (heatPumpAdvice.js): at most three, the most important first.
const test = require('node:test');
const assert = require('node:assert/strict');
const ha = require('../src/heatPumpAdvice');

test('comfort first, then energy and efficiency; at most three', () => {
  const T = Date.parse('2026-10-10T06:30:00Z');
  const s = ha.suggestions({
    roomEnabled: true, comfortAt: T, reachAt: T + 45 * 60000,
    limits: { comfortMinC: 45, targetC: 58, bufferMaxC: 58, hpMaxC: 55 },
    overshoot: { overshootC: 1 }, curRow: { runs: 5, runMin: 18 },
  });
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.kind), ['comfort', 'energy', 'efficiency']);
  assert.equal(s[0].params.m, 45);
  assert.equal(s[1].params.hp, 55);
});

test('nothing to say when all is well', () => {
  assert.deepEqual(ha.suggestions({ limits: { comfortMinC: 45, targetC: 50, bufferMaxC: 55, hpMaxC: 55 }, legionella: { enabled: true } }), []);
});
