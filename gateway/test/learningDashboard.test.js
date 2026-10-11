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
