// Outputs that something else in Loxone drives too, seen from what is read back (energyModules.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectConflicts } = require('../src/energyModules');

test('an output set back by the Loxone logic after LoxSuite sent it is a conflict; settling and agreement are not', () => {
  const now = Date.parse('2026-10-09T14:32:00Z');
  const last = { powerLimit1: { value: 1, ms: now - 5 * 60000 }, dhwSetpoint: { value: 50, ms: now - 5 * 60000 }, flowSetpoint: { value: 33, ms: now - 30000 } };
  const c = detectConflicts(last, { powerLimit1: 0, dhwSetpoint: 50.2, flowSetpoint: 35 }, now);
  assert.deepEqual(Object.keys(c), ['powerLimit1'], 'the setpoint agrees (dead band); the flow was only just sent');
  assert.deepEqual([c.powerLimit1.sent, c.powerLimit1.now], [1, 0]);
  assert.deepEqual(detectConflicts(last, { powerLimit1: 0 }, now + 7 * 3600000), {}, 'long ago: not counted any more');
});
