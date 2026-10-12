// The learning dashboard (learningDashboard.js): accuracy, and what the daily timeline reports as changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const ld = require('../src/learningDashboard');

test('accuracy is 1 − the relative error, only with enough comparisons', () => {
  assert.equal(ld.accuracyOf({ n: 10, relErr: 0.12 }), 0.88);
  assert.equal(ld.accuracyOf({ n: 2, relErr: 0.12 }), null);
  assert.equal(ld.accuracyOf({ n: 10, relErr: 1.7 }), 0, 'never below 0');
});

test('the timeline: new, changed and gone — small changes are no news', () => {
  const before = { a: { topic: 'loads', label: 'Dryer', value: '1.2 kWh/d' }, b: { topic: 'heatpump', label: 'SCOP (measured)', value: '3.1' }, c: { topic: 'car', label: 'Mon', value: '07:40' }, d: { topic: 'loads', label: 'Fridge', value: '0.9 kWh/d' } };
  const now = { a: { topic: 'loads', label: 'Dryer', value: '1.25 kWh/d' }, b: { topic: 'heatpump', label: 'SCOP (measured)', value: '3.8' }, c: { topic: 'car', label: 'Mon', value: '07:30' }, e: { topic: 'heatpump', label: 'Usual tap-water draws', value: '07:00 · 19:00' } };
  const ch = ld.changes(before, now);
  assert.deepEqual(ch.map((x) => `${x.key}:${x.kind}`).sort(), ['b:changed', 'c:changed', 'd:gone', 'e:new']);
});

test('a day forecast is judged per day: a consumer that runs an hour later is still right', () => {
  const flog = require('../src/forecastLog');
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const rows = [];
  for (let d = 1; d <= 3; d++) {
    for (let h = 0; h < 24; h++) {
      const target = `2026-10-0${d}T${String(h).padStart(2, '0')}:00:00.000Z`;
      // predicted 2 kWh at 13:00, it ran at 14:00 instead
      rows.push({ target, predicted: h === 13 ? 2 : 0, actual: h === 14 ? 2 : 0 });
    }
  }
  assert.equal(ld.accuracyOf(flog.summarize(rows)), 0, 'per hour this looks completely wrong');
  const days = flog.summarizeDays(rows, dayOf);
  assert.equal(days.n, 3);
  assert.equal(ld.accuracyOf(days), 1, 'per day it was spot on');
  // a day with too few hours compared does not count
  assert.equal(flog.summarizeDays(rows.slice(0, 30), dayOf).n, 1);
});
