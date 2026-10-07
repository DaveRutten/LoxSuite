// The battery line in the Smart charging chart (v0.47): the expected level from the start of the plan,
// up while charging, down while out, never above its limit or below empty.
const test = require('node:test');
const assert = require('node:assert/strict');
const { batteryCurve } = require('../src/planner');

const H = 3600000;
const t0 = Date.UTC(2026, 9, 8, 18);
const at = (pts, h) => pts.find((p) => p.at === t0 + h * H)?.pct;

test('flat until charging starts, up while charging, capped at its limit', () => {
  const pts = batteryCurve({
    startMs: t0, startKwh: 6, batteryKwh: 25, fullKwh: 25, untilMs: t0 + 20 * H,
    charges: [{ start: t0 + 3 * H, end: t0 + 6 * H, kwh: 15 }, { start: t0 + 7 * H, end: t0 + 8 * H, kwh: 7 }],
  });
  assert.equal(at(pts, 0), 24);
  assert.equal(at(pts, 3), 24, 'nothing before the charging');
  assert.equal(at(pts, 6), 84);
  assert.equal(at(pts, 8), 100, 'full at its limit, not 112%');
  const cap = pts.find((p) => p.pct === 100);
  assert.ok(cap.at > t0 + 7 * H && cap.at < t0 + 8 * H, 'the moment it is full is a point of its own');
  assert.equal(pts[pts.length - 1].at, t0 + 20 * H);
});

test('down during a drive, not below empty (a hybrid drives on fuel); a limit below 100%', () => {
  const pts = batteryCurve({
    startMs: t0, startKwh: 20, batteryKwh: 25, fullKwh: 20, untilMs: t0 + 12 * H,
    drives: [{ leave: t0 + 2 * H, back: t0 + 4 * H, kwh: 30 }],
    charges: [{ start: t0 + 5 * H, end: t0 + 6 * H, kwh: 11 }],
  });
  assert.equal(at(pts, 0), 80, 'starts at 20 of 25 kWh');
  assert.equal(at(pts, 2), 80);
  assert.equal(at(pts, 4), 0, 'empty, not below');
  assert.ok(pts.some((p) => p.pct === 0 && p.at > t0 + 2 * H && p.at < t0 + 4 * H), 'the moment it is empty');
  assert.equal(at(pts, 6), 44);
});

test('charging or a drive partly before the start counts only from the start; nothing without a battery', () => {
  const pts = batteryCurve({ startMs: t0 + H, startKwh: 10, batteryKwh: 50, untilMs: t0 + 3 * H, charges: [{ start: t0, end: t0 + 2 * H, kwh: 10 }] });
  assert.equal(at(pts, 1), 20);
  assert.equal(at(pts, 2), 30, 'half of the slot after the start: 5 kWh');
  assert.deepEqual(batteryCurve({ startMs: t0, startKwh: 10, batteryKwh: null, untilMs: t0 + H }), []);
  assert.deepEqual(batteryCurve({ startMs: t0, startKwh: NaN, batteryKwh: 50, untilMs: t0 + H }), []);
});
